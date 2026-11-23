import type { PlayerEngineId } from '../types';
import { mpvEngine } from './mpvEngine';
import { media3Engine } from './media3Engine';

/**
 * One shape for mpv and Media3.
 *
 * Both engines expose the same transport/attach/listener API by design, but
 * they disagree on the small things: mpv reports `timePos` in seconds and
 * Media3 `positionMs`, mpv takes `startSeconds` and Media3 `startMs`, and only
 * Media3 has an explicit error event (mpv reports failures through EndFile).
 * This adapter hides those differences so the player hook can drive either
 * engine through a single variable.
 */

export type NativeEngineId = Extract<PlayerEngineId, 'mpv' | 'media3'>;

export interface NormalizedTrack {
  /** The engine's own track id, passed back to selectAudio/selectSubtitle. */
  id: number;
  type: string;
  label: string;
  language: string;
  codec: string;
  selected: boolean;
  external: boolean;
}

export interface NativeSnapshot {
  currentTime: number;
  duration: number;
  paused: boolean;
  buffering: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  eofReached: boolean;
}

export interface NativeLoadOptions {
  headers?: Record<string, string>;
  startSeconds?: number;
  autoplay?: boolean;
  isLive?: boolean;
}

export interface NativeEngineHandle {
  id: NativeEngineId;
  label: string;
  isAvailable(): boolean;
  attach(element: HTMLElement): Promise<() => void>;
  load(url: string, options?: NativeLoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePlay(): Promise<void>;
  stop(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  seekBy(deltaSeconds: number): Promise<void>;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setRate(rate: number): Promise<void>;
  refreshTracks(): Promise<NormalizedTrack[]>;
  selectAudio(id: number): Promise<void>;
  selectSubtitle(id: number): Promise<void>;
  disableSubtitles(): Promise<void>;
  addSubtitle(url: string, select?: boolean): Promise<void>;
  setSubtitleDelay(seconds: number): Promise<void>;
  onState(listener: (state: NativeSnapshot) => void): () => void;
  onTracks(listener: (tracks: NormalizedTrack[]) => void): () => void;
  /** `reason` is mpv's EndFileReason or `'EndFile'` for Media3. */
  onEnd(listener: (reason: string, error: string) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  destroy(): Promise<void>;
}

/** mpv reports failure through EndFile rather than a dedicated error event. */
function mpvReasonIsError(reason: string): boolean {
  return reason !== 'Eof' && reason !== 'Stop' && reason !== 'Quit' && reason !== '';
}

function mpvHandle(): NativeEngineHandle {
  return {
    id: 'mpv',
    label: 'mpv',
    isAvailable: () => mpvEngine.isAvailable(),
    attach: (element) => mpvEngine.attachTo(element),
    load: (url, options = {}) => mpvEngine.load(url, {
      headers: options.headers,
      startSeconds: options.startSeconds,
    }),
    play: () => mpvEngine.play(),
    pause: () => mpvEngine.pause(),
    togglePlay: () => mpvEngine.togglePlay(),
    stop: () => mpvEngine.stop(),
    seekTo: (seconds) => mpvEngine.seekTo(seconds),
    seekBy: (delta) => mpvEngine.seekBy(delta),
    setVolume: (percent) => mpvEngine.setVolume(percent),
    setMuted: (muted) => mpvEngine.setMuted(muted),
    setRate: (rate) => mpvEngine.setRate(rate),
    refreshTracks: async () => (await mpvEngine.refreshTracks()).map(toNormalizedTrack),
    selectAudio: (id) => mpvEngine.selectAudioTrack(id),
    selectSubtitle: (id) => mpvEngine.selectSubtitleTrack(id),
    disableSubtitles: () => mpvEngine.disableSubtitles(),
    addSubtitle: (url, select = true) => mpvEngine.addSubtitle(url, select),
    setSubtitleDelay: (seconds) => mpvEngine.setSubtitleDelay(seconds),
    onState: (listener) => mpvEngine.onState((state) => listener({
      currentTime: state.timePos,
      duration: state.duration,
      paused: state.paused,
      buffering: state.buffering,
      volume: state.volume,
      muted: state.muted,
      speed: state.speed,
      eofReached: state.eofReached,
    })),
    onTracks: (listener) => mpvEngine.onTracks((tracks) => listener(tracks.map(toNormalizedTrack))),
    onEnd: (listener) => mpvEngine.onEnd((reason, error) => listener(reason, error)),
    // mpv's own error event is a console warning; a real failure ends the file.
    onError: (listener) => mpvEngine.onEnd((reason, error) => {
      if (mpvReasonIsError(reason) || error) listener(error || `mpv stopped: ${reason}`);
    }),
    destroy: () => mpvEngine.destroy(),
  };
}

function media3Handle(): NativeEngineHandle {
  return {
    id: 'media3',
    label: 'Media3 (ExoPlayer)',
    isAvailable: () => media3Engine.isAvailable(),
    attach: (element) => media3Engine.attachTo(element),
    load: (url, options = {}) => media3Engine.load(url, {
      headers: options.headers,
      startMs: options.startSeconds !== undefined ? options.startSeconds * 1000 : undefined,
      autoPlay: options.autoplay,
      isLive: options.isLive,
    }),
    play: () => media3Engine.play(),
    pause: () => media3Engine.pause(),
    togglePlay: () => media3Engine.togglePlay(),
    stop: () => media3Engine.stop(),
    seekTo: (seconds) => media3Engine.seekTo(seconds),
    seekBy: (delta) => media3Engine.seekBy(delta),
    setVolume: (percent) => media3Engine.setVolume(percent),
    setMuted: (muted) => media3Engine.setMuted(muted),
    setRate: (rate) => media3Engine.setRate(rate),
    refreshTracks: async () => (await media3Engine.refreshTracks()).map(toNormalizedTrack),
    selectAudio: (id) => media3Engine.selectAudioTrack(id),
    selectSubtitle: (id) => media3Engine.selectSubtitleTrack(id),
    disableSubtitles: () => media3Engine.disableSubtitles(),
    addSubtitle: (url) => media3Engine.addSubtitle(url),
    // Media3 has no per-track delay API; tracked so the UI can call it blindly.
    setSubtitleDelay: () => Promise.resolve(),
    onState: (listener) => media3Engine.onState((state) => listener({
      currentTime: state.positionMs / 1000,
      duration: state.durationMs / 1000,
      paused: !state.playing,
      buffering: state.buffering,
      volume: 100,
      muted: false,
      speed: 1,
      eofReached: state.ended,
    })),
    onTracks: (listener) => media3Engine.onTracks((tracks) => listener(tracks.map(toNormalizedTrack))),
    onEnd: (listener) => media3Engine.onEnd(() => listener('Eof', '')),
    onError: (listener) => media3Engine.onError(listener),
    destroy: () => media3Engine.destroy(),
  };
}

function toNormalizedTrack(track: {
  id: number; type: string; title: string; lang: string; codec: string;
  selected: boolean; external: boolean;
}): NormalizedTrack {
  return {
    id: track.id,
    type: track.type,
    label: track.title || `${track.type} ${track.id}`,
    language: track.lang || '',
    codec: track.codec || '',
    selected: track.selected,
    external: track.external,
  };
}

export function createNativeEngine(id: NativeEngineId): NativeEngineHandle {
  return id === 'mpv' ? mpvHandle() : media3Handle();
}
