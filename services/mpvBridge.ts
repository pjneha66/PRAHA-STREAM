import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * libmpv bridge.
 *
 * The engine is native (`com.praha.stream.mpv.PrahaMpvPlugin`, registered by
 * hand in MainActivity) and ships compiled inside the mpv-android AAR. This file
 * is only the typed surface: it deliberately avoids `@capacitor-community/*`
 * so nothing else has to be installed.
 *
 * Nothing here is available on the web build. Every call is guarded by
 * `mpvAvailable()` and the caller is expected to fall back to hls.js/dash.js.
 */

export interface MpvRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MpvTrack {
  id: number;
  type: 'audio' | 'video' | 'sub' | string;
  title: string;
  lang: string;
  codec: string;
  selected: boolean;
  external: boolean;
}

export interface MpvEndFileEvent {
  event: string;
  /** mpv's EndFileReason name: `Eof`, `Error`, `Stop`, `Quit`, … */
  reason?: string;
  error?: string;
}

export interface MpvPropertyEvent {
  name: string;
  value: string | number | boolean | null;
}

interface PrahaMpvPlugin {
  initialize(): Promise<{ initialized: boolean }>;
  destroy(): Promise<void>;

  attachSurface(options: MpvRect): Promise<{ attached: boolean }>;
  setSurfaceRect(options: MpvRect): Promise<void>;
  detachSurface(): Promise<void>;

  load(options: {
    url: string;
    headers?: Record<string, string>;
    startSeconds?: number;
  }): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(options: { timeMs: number; absolute?: boolean }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setMute(options: { muted: boolean }): Promise<void>;

  getTracks(): Promise<{ tracks: MpvTrack[] }>;
  selectTrack(options: { type: 'audio' | 'sub' | 'video'; id: number }): Promise<void>;
  addSubtitle(options: { url: string; select?: boolean }): Promise<void>;
  setSubtitleDelay(options: { seconds: number }): Promise<void>;
  setAudioDelay(options: { seconds: number }): Promise<void>;

  setProperty(options: { name: string; value: string }): Promise<void>;
  getProperty(options: { name: string }): Promise<{ value: string | null }>;

  addListener(
    eventName: 'propertyChange',
    listener: (event: MpvPropertyEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mpvEvent',
    listener: (event: MpvEndFileEvent & Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'mpvError',
    listener: (event: { message: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const PrahaMpv = registerPlugin<PrahaMpvPlugin>('PrahaMpv');

/**
 * True when the native plugin is present. Mirrors the check used for the rest of
 * the bridge: the web build has no `Capacitor.Plugins` entry for it.
 */
export function mpvAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins;
  return Boolean(plugins?.PrahaMpv);
}

/**
 * Properties the player UI polls. mpv pushes changes for observed properties, so
 * the list is what we subscribe to on open rather than what we query every tick.
 */
export const MPV_OBSERVED_PROPERTIES = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'speed',
  'eof-reached',
  'core-idle',
  'paused-for-cache',
  'cache-buffering-state',
  'video-format',
  'video-codec',
  'audio-codec',
  'hwdec-current',
  'estimated-vf-fps',
  'demuxer-cache-time',
  'track-list/count',
  'aid',
  'sid',
  'vid',
] as const;
