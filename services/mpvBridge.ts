import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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

/** libmpv's `mpv_format`, as the AAR's `PropertyFormat` enum names them. */
export type MpvPropertyFormat = 'none' | 'string' | 'flag' | 'int64' | 'double';

interface PrahaMpvPlugin {
  initialize(options?: { hardwareDecoding?: boolean }): Promise<{ initialized: boolean }>;
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

  /**
   * Registers a property for change notifications. Without this libmpv sends
   * no `propertyChange` for it — a write is not an observation.
   */
  observe(options: { name: string; format?: MpvPropertyFormat }): Promise<void>;

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

/** True when Capacitor has a native implementation for the plugin. */
export function mpvAvailable(): boolean {
  return Capacitor.isPluginAvailable('PrahaMpv');
}

/**
 * Properties the player UI polls. mpv pushes changes for observed properties, so
 * the list is what we subscribe to on open rather than what we query every tick.
 *
 * The format matters: `mpv_observe_property` needs one, and declaring a flag as
 * a double (or the reverse) makes libmpv drop the notification. Numbers are
 * `double` because everything the UI does with them is arithmetic.
 */
export const MPV_OBSERVED_PROPERTIES: Record<string, MpvPropertyFormat> = {
  'time-pos': 'double',
  duration: 'double',
  pause: 'flag',
  volume: 'double',
  mute: 'flag',
  speed: 'double',
  'eof-reached': 'flag',
  'core-idle': 'flag',
  'paused-for-cache': 'flag',
  'cache-buffering-state': 'double',
  'video-format': 'string',
  'video-codec': 'string',
  'audio-codec': 'string',
  'hwdec-current': 'string',
  'estimated-vf-fps': 'double',
  'demuxer-cache-time': 'double',
  'track-list/count': 'int64',
  aid: 'int64',
  sid: 'int64',
  vid: 'int64',
};
