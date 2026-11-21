// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The native Media3 plugin is supplied by Capacitor at runtime. These tests
 * replace only that thin bridge so the engine's state machine and argument
 * conversion can be exercised without an emulator.
 */
const fake = vi.hoisted(() => {
  const listeners: Record<string, (event: any) => void> = {};
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === 'getStats') {
      return Promise.resolve({
        positionMs: 0,
        durationMs: 0,
        bufferedMs: 0,
        bitrate: 1234,
        droppedFrames: 2,
        isLive: false,
        paused: false,
      });
    }
    if (method === 'getTracks') {
      return Promise.resolve({
        tracks: [
          { id: 1, type: 'audio', title: 'AAC', lang: 'en', codec: 'aac', selected: true, external: false },
        ],
      });
    }
    if (method === 'initialize') return Promise.resolve({ initialized: true });
    return Promise.resolve(undefined);
  };
  const plugin: Record<string, unknown> = {};
  for (const method of [
    'initialize', 'destroy', 'attachSurface', 'setSurfaceRect', 'detachSurface',
    'load', 'play', 'pause', 'stop', 'seek', 'setVolume', 'setRate', 'setMute',
    'getTracks', 'selectTrack', 'addSubtitle', 'getStats',
  ]) {
    plugin[method] = record(method);
  }
  plugin.addListener = (event: string, callback: (event: unknown) => void) => {
    listeners[event] = callback;
    return Promise.resolve({ remove: () => {} });
  };
  return { listeners, calls, plugin };
});

vi.mock('../services/media3Bridge', () => ({
  PrahaMedia3: fake.plugin,
  media3Available: () => true,
}));

import { media3Engine, EMPTY_MEDIA3_STATE } from '../services/media3Engine';

function emitted(event: string, payload: unknown): void {
  const listener = fake.listeners[event];
  if (!listener) throw new Error(`no listener registered for ${event}`);
  listener(payload);
}

describe('media3Engine', () => {
  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await media3Engine.destroy();
    await media3Engine.initialize();
    fake.calls.length = 0;
  });

  it('starts from the empty state and reports availability', () => {
    expect(media3Engine.isAvailable()).toBe(true);
    expect(media3Engine.getState()).toEqual(EMPTY_MEDIA3_STATE);
  });

  it('mirrors native progress, playing, cues and video-size events into one snapshot', () => {
    emitted('progress', { positionMs: 5_000, durationMs: 60_000, bufferedMs: 12_000 });
    emitted('playing', { playing: true });
    emitted('cues', { text: 'Hello' });
    emitted('videoSize', { width: 1920, height: 1080, pixelRatio: 1 });

    const state = media3Engine.getState();
    expect(state.positionMs).toBe(5_000);
    expect(state.durationMs).toBe(60_000);
    expect(state.bufferedMs).toBe(12_000);
    expect(state.playing).toBe(true);
    expect(state.subtitleText).toBe('Hello');
    expect(state.width).toBe(1920);
    expect(state.height).toBe(1080);
  });

  it('marks buffering/ended from playbackState and fires the end callbacks', () => {
    const onEnd = vi.fn();
    const off = media3Engine.onEnd(onEnd);
    emitted('playbackState', { state: 'buffering' });
    expect(media3Engine.getState().buffering).toBe(true);
    emitted('playbackState', { state: 'ready' });
    expect(media3Engine.getState().buffering).toBe(false);
    emitted('ended', { ended: true });
    const state = media3Engine.getState();
    expect(state.ended).toBe(true);
    expect(state.playing).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    off();
  });

  it('converts seconds to milliseconds for seeks and rounds volume to an integer', async () => {
    await media3Engine.seekTo(12.5);
    await media3Engine.seekBy(-5);
    await media3Engine.setVolume(55.6);
    await media3Engine.setMuted(true);
    await media3Engine.setRate(1.5);

    expect(fake.calls).toContainEqual({ method: 'seek', args: [{ timeMs: 12500, absolute: true }] });
    expect(fake.calls).toContainEqual({ method: 'seek', args: [{ timeMs: -5000, absolute: false }] });
    expect(fake.calls).toContainEqual({ method: 'setVolume', args: [{ volume: 56 }] });
    expect(fake.calls).toContainEqual({ method: 'setMute', args: [{ muted: true }] });
    expect(fake.calls).toContainEqual({ method: 'setRate', args: [{ rate: 1.5 }] });
  });

  it('uses track id -1 to disable subtitles and forwards track selection', async () => {
    await media3Engine.selectAudioTrack(7);
    await media3Engine.selectSubtitleTrack(3);
    await media3Engine.disableSubtitles();
    expect(fake.calls).toContainEqual({ method: 'selectTrack', args: [{ type: 'audio', id: 7 }] });
    expect(fake.calls).toContainEqual({ method: 'selectTrack', args: [{ type: 'sub', id: 3 }] });
    expect(fake.calls).toContainEqual({ method: 'selectTrack', args: [{ type: 'sub', id: -1 }] });
  });

  it('loads a stream with headers and pulls informational stats', async () => {
    await media3Engine.load('https://example.com/master.m3u8', {
      headers: { Referer: 'https://example.com/' },
      startMs: 1500,
      autoPlay: false,
      isLive: true,
      mimeType: 'hls',
    });
    expect(fake.calls).toContainEqual({
      method: 'load',
      args: [{
        url: 'https://example.com/master.m3u8',
        headers: { Referer: 'https://example.com/' },
        startMs: 1500,
        autoPlay: false,
        isLive: true,
        mimeType: 'hls',
      }],
    });
    expect(fake.calls.some((call) => call.method === 'getStats')).toBe(true);
    expect(media3Engine.getState().bitrate).toBe(1234);
    expect(media3Engine.getState().isLive).toBe(true);
  });

  it('attaches a DPR-scaled surface rect and detaches on cleanup', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 100, height: 50,
      right: 110, bottom: 70, x: 10, y: 20,
      toJSON() { return {}; },
    }) as DOMRect;

    const detach = await media3Engine.attachTo(element);
    expect(fake.calls).toContainEqual({
      method: 'attachSurface',
      args: [{ x: 20, y: 40, width: 200, height: 100 }],
    });
    detach();
    expect(fake.calls.some((call) => call.method === 'detachSurface')).toBe(true);
  });
});
