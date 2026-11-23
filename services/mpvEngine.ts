import {
  MPV_OBSERVED_PROPERTIES,
  PrahaMpv,
  mpvAvailable,
  type MpvRect,
  type MpvTrack,
} from './mpvBridge';

/**
 * Drives the native mpv engine from the web UI.
 *
 * Two things make this more than a thin wrapper:
 *
 * 1. **Surface geometry.** Video is drawn by a SurfaceView *behind* the WebView,
 *    so the page has to keep telling the plugin where the player element is
 *    whenever it moves, resizes, or the page scrolls. A ResizeObserver plus a
 *    scroll listener covers every case without the UI having to think about it.
 *
 * 2. **State mirroring.** The controls are React, so the engine's own state has
 *    to arrive as a plain snapshot. Observed properties are folded into one
 *    object and pushed on change; the UI subscribes to that instead of polling.
 */

export interface MpvState {
  timePos: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  eofReached: boolean;
  buffering: boolean;
  buffered: number;
  videoCodec: string;
  audioCodec: string;
  hwdec: string;
  fps: number;
}

export const EMPTY_MPV_STATE: MpvState = {
  timePos: 0,
  duration: 0,
  paused: true,
  volume: 100,
  muted: false,
  speed: 1,
  eofReached: false,
  buffering: false,
  buffered: 0,
  videoCodec: '',
  audioCodec: '',
  hwdec: '',
  fps: 0,
};

type StateListener = (state: MpvState) => void;
type TrackListener = (tracks: MpvTrack[]) => void;
type EndListener = (reason: string, error: string) => void;

/** Maps mpv's property names onto the snapshot fields the UI reads. */
const PROPERTY_MAP: Record<string, keyof MpvState | null> = {
  'time-pos': 'timePos',
  duration: 'duration',
  pause: 'paused',
  volume: 'volume',
  mute: 'muted',
  speed: 'speed',
  'eof-reached': 'eofReached',
  'paused-for-cache': 'buffering',
  'demuxer-cache-time': 'buffered',
  'video-codec': 'videoCodec',
  'audio-codec': 'audioCodec',
  'hwdec-current': 'hwdec',
  'estimated-vf-fps': 'fps',
  // Not part of the snapshot, but a change here means the track list moved.
  'track-list/count': null,
  aid: null,
  sid: null,
  vid: null,
  'video-format': null,
  'core-idle': null,
  'cache-buffering-state': null,
};

class MpvEngine {
  private state: MpvState = { ...EMPTY_MPV_STATE };
  private stateListeners = new Set<StateListener>();
  private trackListeners = new Set<TrackListener>();
  private endListeners = new Set<EndListener>();

  private ready = false;
  private surfaceElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollHandler: (() => void) | null = null;
  private frame: number | null = null;
  private lastRect: MpvRect | null = null;

  /** True when the native engine is present in this build. */
  isAvailable(): boolean {
    return mpvAvailable();
  }

  async initialize(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (this.ready) return true;

    await PrahaMpv.initialize();

    await PrahaMpv.addListener('propertyChange', (event) => {
      this.applyProperty(event.name, event.value);
    });
    await PrahaMpv.addListener('mpvEvent', (event) => {
      if (event.event === 'EndFile') {
        const reason = String(event.reason || '');
        const error = String(event.error || '');
        this.state.eofReached = reason === 'Eof';
        this.emitState();
        this.endListeners.forEach((listener) => listener(reason, error));
      }
      if (event.event === 'FileLoaded') {
        void this.refreshTracks();
      }
    });
    await PrahaMpv.addListener('mpvError', (event) => {
      console.warn('[mpv]', event.message);
    });

    for (const name of MPV_OBSERVED_PROPERTIES) {
      try {
        await PrahaMpv.setProperty({ name: `observe-${name}`, value: 'yes' });
      } catch {
        // mpv silently ignores unknown properties; a rejection here is not fatal.
      }
    }

    this.ready = true;
    return true;
  }

  private applyProperty(name: string, value: string | number | boolean | null): void {
    const field = PROPERTY_MAP[name];
    if (field === null) {
      if (name === 'track-list/count' || name === 'aid' || name === 'sid') {
        void this.refreshTracks();
      }
      return;
    }
    if (!field) return;

    this.state = { ...this.state, [field]: value } as MpvState;
    this.emitState();
  }

  private emitState(): void {
    const snapshot = this.state;
    this.stateListeners.forEach((listener) => listener(snapshot));
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onTracks(listener: TrackListener): () => void {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  }

  onEnd(listener: EndListener): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  getState(): MpvState {
    return this.state;
  }

  // ── Surface sync ───────────────────────────────────────────────────────

  /**
   * Binds the video surface to a DOM element and keeps it aligned. Returns a
   * teardown function; calling it detaches the surface and stops observing.
   */
  async attachTo(element: HTMLElement): Promise<() => void> {
    if (!this.isAvailable()) return () => {};
    await this.initialize();

    this.surfaceElement = element;
    await this.syncSurface();

    this.resizeObserver = new ResizeObserver(() => this.scheduleSync());
    this.resizeObserver.observe(element);

    // Scrolling and window resizes move the rect without resizing the element.
    this.scrollHandler = () => this.scheduleSync();
    window.addEventListener('scroll', this.scrollHandler, true);
    window.addEventListener('resize', this.scrollHandler);

    return () => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (this.scrollHandler) {
        window.removeEventListener('scroll', this.scrollHandler, true);
        window.removeEventListener('resize', this.scrollHandler);
        this.scrollHandler = null;
      }
      if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.surfaceElement = null;
      this.lastRect = null;
      void PrahaMpv.detachSurface().catch(() => {});
    };
  }

  /** Coalesces resize/scroll storms into one update per frame. */
  private scheduleSync(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      void this.syncSurface();
    });
  }

  private async syncSurface(): Promise<void> {
    const element = this.surfaceElement;
    if (!element) return;

    const box = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const rect: MpvRect = {
      x: Math.round(box.left * dpr),
      y: Math.round(box.top * dpr),
      width: Math.max(1, Math.round(box.width * dpr)),
      height: Math.max(1, Math.round(box.height * dpr)),
    };

    const previous = this.lastRect;
    if (
      previous &&
      previous.x === rect.x &&
      previous.y === rect.y &&
      previous.width === rect.width &&
      previous.height === rect.height
    ) {
      return;
    }
    this.lastRect = rect;

    try {
      if (!previous) {
        await PrahaMpv.attachSurface(rect);
      } else {
        await PrahaMpv.setSurfaceRect(rect);
      }
    } catch (error) {
      console.warn('[mpv] could not sync the video surface', error);
    }
  }

  // ── Transport ──────────────────────────────────────────────────────────

  async load(url: string, options: { headers?: Record<string, string>; startSeconds?: number } = {}): Promise<void> {
    await this.initialize();
    this.state = { ...EMPTY_MPV_STATE };
    this.emitState();
    await PrahaMpv.load({
      url,
      headers: options.headers,
      startSeconds: options.startSeconds,
    });
  }

  async play(): Promise<void> {
    await PrahaMpv.play();
  }

  async pause(): Promise<void> {
    await PrahaMpv.pause();
  }

  async togglePlay(): Promise<void> {
    if (this.state.paused) await this.play();
    else await this.pause();
  }

  async stop(): Promise<void> {
    await PrahaMpv.stop();
  }

  async seekTo(seconds: number): Promise<void> {
    await PrahaMpv.seek({ timeMs: Math.max(0, seconds) * 1000, absolute: true });
  }

  async seekBy(deltaSeconds: number): Promise<void> {
    await PrahaMpv.seek({ timeMs: deltaSeconds * 1000, absolute: false });
  }

  async setVolume(volume: number): Promise<void> {
    await PrahaMpv.setVolume({ volume: Math.round(Math.max(0, Math.min(130, volume))) });
  }

  async setMuted(muted: boolean): Promise<void> {
    await PrahaMpv.setMute({ muted });
  }

  async setRate(rate: number): Promise<void> {
    await PrahaMpv.setRate({ rate: Math.max(0.25, Math.min(4, rate)) });
  }

  /**
   * Zoom the picture to fill the surface. mpv letterboxes by default
   * (`panscan=0`); `1.0` crops the overflow instead, which is what the player's
   * "Crop (Cover)" fit means. mpv has no CSS-style stretch, so there is no
   * third mode here.
   */
  async setPanscan(value: number): Promise<void> {
    await PrahaMpv.setProperty({ name: 'panscan', value: String(Math.max(0, Math.min(1, value))) });
  }

  // ── Tracks ─────────────────────────────────────────────────────────────

  async refreshTracks(): Promise<MpvTrack[]> {
    if (!this.ready) return [];
    try {
      const { tracks } = await PrahaMpv.getTracks();
      this.trackListeners.forEach((listener) => listener(tracks));
      return tracks;
    } catch {
      return [];
    }
  }

  async selectAudioTrack(id: number): Promise<void> {
    await PrahaMpv.selectTrack({ type: 'audio', id });
  }

  async selectSubtitleTrack(id: number): Promise<void> {
    await PrahaMpv.selectTrack({ type: 'sub', id });
  }

  /** `id = -1` turns subtitles off in mpv. */
  async disableSubtitles(): Promise<void> {
    await PrahaMpv.selectTrack({ type: 'sub', id: -1 });
  }

  async addSubtitle(url: string, select = true): Promise<void> {
    await PrahaMpv.addSubtitle({ url, select });
  }

  async setSubtitleDelay(seconds: number): Promise<void> {
    await PrahaMpv.setSubtitleDelay({ seconds });
  }

  async setAudioDelay(seconds: number): Promise<void> {
    await PrahaMpv.setAudioDelay({ seconds });
  }

  async destroy(): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    try {
      await PrahaMpv.destroy();
    } catch {
      // Already gone.
    }
  }
}

/**
 * One engine per page. libmpv is a single global context, so a second instance
 * would fight the first over the video output.
 */
export const mpvEngine = new MpvEngine();

/** Exposed for tests: the observed-property list is part of the contract. */
export { MPV_OBSERVED_PROPERTIES };
