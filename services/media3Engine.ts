import {
  PrahaMedia3,
  media3Available,
  type Media3Rect,
  type Media3Stats,
  type Media3Track,
} from './media3Bridge';

/** The state snapshot the player UI reads, in the same shape as mpv's engine. */
export interface Media3State {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  buffering: boolean;
  playing: boolean;
  ended: boolean;
  bitrate: number;
  droppedFrames: number;
  isLive: boolean;
  subtitleText: string;
  width: number;
  height: number;
}

export const EMPTY_MEDIA3_STATE: Media3State = {
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  buffering: false,
  playing: false,
  ended: false,
  bitrate: 0,
  droppedFrames: 0,
  isLive: false,
  subtitleText: '',
  width: 0,
  height: 0,
};

type StateListener = (state: Media3State) => void;
type TrackListener = (tracks: Media3Track[]) => void;
type ErrorListener = (message: string) => void;

/**
 * Mirrors native Media3 events into a React-friendly snapshot.
 *
 * Deliberately shaped like `mpvEngine` so the player component can switch
 * engines without rewriting its controls: both expose onState/onTracks/onEnd,
 * the same transport methods and the same attachTo lifecycle.
 */
class Media3Engine {
  private state: Media3State = { ...EMPTY_MEDIA3_STATE };
  private stateListeners = new Set<StateListener>();
  private trackListeners = new Set<TrackListener>();
  private errorListeners = new Set<ErrorListener>();
  private endListeners = new Set<() => void>();

  private ready = false;
  private element: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollHandler: (() => void) | null = null;
  private frame: number | null = null;
  private lastRect: Media3Rect | null = null;

  isAvailable(): boolean {
    return media3Available();
  }

  async initialize(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (this.ready) return true;

    await PrahaMedia3.initialize();

    await PrahaMedia3.addListener('progress', (event) => {
      this.patch({
        positionMs: event.positionMs,
        durationMs: event.durationMs,
        bufferedMs: event.bufferedMs,
      });
    });
    await PrahaMedia3.addListener('playbackState', (event) => {
      this.patch({
        buffering: event.state === 'buffering',
        ended: event.state === 'ended',
      });
    });
    await PrahaMedia3.addListener('playing', (event) => this.patch({ playing: event.playing }));
    await PrahaMedia3.addListener('ended', () => {
      this.patch({ ended: true, playing: false });
      this.endListeners.forEach((listener) => listener());
    });
    await PrahaMedia3.addListener('error', (event) => {
      this.errorListeners.forEach((listener) => listener(event.message));
    });
    await PrahaMedia3.addListener('tracksChanged', (event) => {
      this.trackListeners.forEach((listener) => listener(event.tracks || []));
    });
    await PrahaMedia3.addListener('cues', (event) => this.patch({ subtitleText: event.text }));
    await PrahaMedia3.addListener('videoSize', (event) => {
      this.patch({ width: event.width, height: event.height });
    });

    this.ready = true;
    return true;
  }

  private patch(patch: Partial<Media3State>): void {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((listener) => listener(this.state));
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

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onEnd(listener: () => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  getState(): Media3State {
    return this.state;
  }

  // ── Surface ─────────────────────────────────────────────────────────────

  async attachTo(element: HTMLElement): Promise<() => void> {
    if (!this.isAvailable()) return () => {};
    await this.initialize();

    this.element = element;
    await this.syncSurface();

    this.resizeObserver = new ResizeObserver(() => this.scheduleSync());
    this.resizeObserver.observe(element);
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
      this.element = null;
      this.lastRect = null;
      void PrahaMedia3.detachSurface().catch(() => {});
    };
  }

  private scheduleSync(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      void this.syncSurface();
    });
  }

  private async syncSurface(): Promise<void> {
    const element = this.element;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const rect: Media3Rect = {
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
      if (!previous) await PrahaMedia3.attachSurface(rect);
      else await PrahaMedia3.setSurfaceRect(rect);
    } catch (error) {
      console.warn('[media3] could not sync the video surface', error);
    }
  }

  // ── Transport ───────────────────────────────────────────────────────────

  async load(
    url: string,
    options: {
      headers?: Record<string, string>;
      startMs?: number;
      autoPlay?: boolean;
      isLive?: boolean;
      mimeType?: string;
    } = {},
  ): Promise<void> {
    await this.initialize();
    this.state = { ...EMPTY_MEDIA3_STATE, isLive: Boolean(options.isLive) };
    this.stateListeners.forEach((listener) => listener(this.state));
    await PrahaMedia3.load({
      url,
      headers: options.headers,
      startMs: options.startMs,
      autoPlay: options.autoPlay ?? true,
      isLive: options.isLive,
      mimeType: options.mimeType,
    });
    try {
      const stats = await PrahaMedia3.getStats();
      this.patch({
        bitrate: stats.bitrate,
        droppedFrames: stats.droppedFrames,
        // Stats can lag behind a freshly loaded source, so never let a stale
        // `false` clear a live flag the caller already knew to be true.
        isLive: stats.isLive || Boolean(options.isLive),
      });
    } catch {
      // Stats are informational; a failure here must not break playback.
    }
  }

  async play(): Promise<void> {
    await PrahaMedia3.play();
  }

  async pause(): Promise<void> {
    await PrahaMedia3.pause();
  }

  async togglePlay(): Promise<void> {
    if (this.state.playing) await this.pause();
    else await this.play();
  }

  async stop(): Promise<void> {
    await PrahaMedia3.stop();
  }

  async seekTo(seconds: number): Promise<void> {
    await PrahaMedia3.seek({ timeMs: Math.max(0, seconds) * 1000, absolute: true });
  }

  async seekBy(deltaSeconds: number): Promise<void> {
    await PrahaMedia3.seek({ timeMs: deltaSeconds * 1000, absolute: false });
  }

  async setVolume(volume: number): Promise<void> {
    await PrahaMedia3.setVolume({ volume: Math.round(volume) });
  }

  async setMuted(muted: boolean): Promise<void> {
    await PrahaMedia3.setMute({ muted });
  }

  async setRate(rate: number): Promise<void> {
    await PrahaMedia3.setRate({ rate });
  }

  // ── Tracks ──────────────────────────────────────────────────────────────

  async refreshTracks(): Promise<Media3Track[]> {
    if (!this.ready) return [];
    try {
      const { tracks } = await PrahaMedia3.getTracks();
      this.trackListeners.forEach((listener) => listener(tracks || []));
      return tracks || [];
    } catch {
      return [];
    }
  }

  async selectAudioTrack(id: number): Promise<void> {
    await PrahaMedia3.selectTrack({ type: 'audio', id });
  }

  async selectSubtitleTrack(id: number): Promise<void> {
    await PrahaMedia3.selectTrack({ type: 'sub', id });
  }

  async disableSubtitles(): Promise<void> {
    await PrahaMedia3.selectTrack({ type: 'sub', id: -1 });
  }

  async addSubtitle(url: string): Promise<void> {
    await PrahaMedia3.addSubtitle({ url });
  }

  async destroy(): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    try {
      await PrahaMedia3.destroy();
    } catch {
      // Already gone.
    }
  }
}

/** One engine per page — the native player owns a single audio focus session. */
export const media3Engine = new Media3Engine();
