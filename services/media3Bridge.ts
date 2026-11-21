import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Media3 / ExoPlayer bridge — the second native playback engine.
 *
 * mpv is the default on Android because it decodes everything and renders ASS
 * properly. Media3 is the fallback for hardware-decoded playback on weaker
 * devices and for TVs that want a media-tunnel session. It is registered by
 * hand in MainActivity (there is no npm package, so Capacitor cannot scan it).
 */

export interface Media3Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Media3Track {
  id: number;
  type: 'audio' | 'video' | 'sub' | string;
  title: string;
  lang: string;
  codec: string;
  selected: boolean;
  external: boolean;
}

export interface Media3Stats {
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  bitrate: number;
  droppedFrames: number;
  isLive: boolean;
  paused: boolean;
}

interface PrahaMedia3Plugin {
  initialize(): Promise<{ initialized: boolean }>;
  destroy(): Promise<void>;

  attachSurface(options: Media3Rect): Promise<{ attached: boolean }>;
  setSurfaceRect(options: Media3Rect): Promise<void>;
  detachSurface(): Promise<void>;

  load(options: {
    url: string;
    headers?: Record<string, string>;
    startMs?: number;
    autoPlay?: boolean;
    isLive?: boolean;
    /** hls | dash | mp4 | mkv | webm | ts — optional; inferred from the URL. */
    mimeType?: string;
  }): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(options: { timeMs: number; absolute?: boolean }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setMute(options: { muted: boolean }): Promise<void>;

  getTracks(): Promise<{ tracks: Media3Track[] }>;
  selectTrack(options: { type: 'audio' | 'sub' | 'video'; id: number }): Promise<void>;
  addSubtitle(options: { url: string }): Promise<void>;

  getStats(): Promise<Media3Stats>;

  addListener(
    eventName: 'playbackState',
    listener: (event: { state: 'idle' | 'buffering' | 'ready' | 'ended' | string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: 'playing', listener: (event: { playing: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'ended', listener: (event: { ended: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'error', listener: (event: { message: string; code: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'tracksChanged', listener: (event: { tracks: Media3Track[] }) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'videoSize',
    listener: (event: { width: number; height: number; pixelRatio: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: 'cues', listener: (event: { text: string }) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'progress',
    listener: (event: { positionMs: number; durationMs: number; bufferedMs: number }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'pausedForBackground',
    listener: (event: { paused: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

export const PrahaMedia3 = registerPlugin<PrahaMedia3Plugin>('PrahaMedia3');

/** True when the native Media3 plugin is present in this build. */
export function media3Available(): boolean {
  if (typeof window === 'undefined') return false;
  const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins;
  return Boolean(plugins?.PrahaMedia3);
}
