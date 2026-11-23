// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fallback behaviour of the native playback controller.
 *
 * The mpv and Media3 plugins are supplied by Capacitor at runtime, so this test
 * substitutes only the thin bridge for mpv. It then drives `startNativePlayback`
 * the way `useMpvEngine` does on Android and asserts the three promises the
 * player contract makes: an engine that cannot load hands off to the *next*
 * engine in the chain with a notice, a spent chain reports failure instead of a
 * dead click, and end-of-file is not mistaken for an error.
 */
const fake = vi.hoisted(() => {
  const listeners: Record<string, (event: any) => void> = {};
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const state = { loadRejects: false };
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === 'initialize') return Promise.resolve({ initialized: true });
    if (method === 'load' && state.loadRejects) return Promise.reject(new Error('cannot open stream'));
    if (method === 'getTracks') return Promise.resolve({ tracks: [] });
    if (method === 'getProperty') return Promise.resolve({ value: null });
    if (method === 'attachSurface') return Promise.resolve({ attached: true });
    return Promise.resolve(undefined);
  };
  const plugin: Record<string, unknown> = {};
  for (const method of [
    'initialize', 'destroy', 'attachSurface', 'setSurfaceRect', 'detachSurface',
    'load', 'play', 'pause', 'stop', 'seek', 'setVolume', 'setRate', 'setMute',
    'getTracks', 'selectTrack', 'addSubtitle', 'setSubtitleDelay', 'setAudioDelay',
    'setProperty', 'getProperty',
  ]) {
    plugin[method] = record(method);
  }
  plugin.addListener = (event: string, callback: (event: unknown) => void) => {
    listeners[event] = callback;
    return Promise.resolve({ remove: () => {} });
  };
  return { listeners, calls, state, plugin };
});

vi.mock('../services/mpvBridge', () => ({
  PrahaMpv: fake.plugin,
  mpvAvailable: () => true,
  MPV_OBSERVED_PROPERTIES: ['time-pos', 'duration', 'pause'],
}));

vi.mock('../services/media3Bridge', () => ({
  PrahaMedia3: {},
  media3Available: () => true,
}));

import { startNativePlayback, stopNativePlayback } from '../services/nativePlayback';
import { mpvEngine } from '../services/mpvEngine';

function emitted(event: string, payload: unknown): void {
  const listener = fake.listeners[event];
  if (!listener) throw new Error(`no listener registered for ${event}`);
  listener(payload);
}

const chain = ['mpv', 'media3', 'web'] as const;

function handlers() {
  return {
    onState: vi.fn(),
    onTracks: vi.fn(),
    onEnd: vi.fn(),
    onFallback: vi.fn(),
  };
}

async function settle(): Promise<void> {
  // The controller starts asynchronously; two macrotask turns let the attach,
  // load and their rejections run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  stopNativePlayback();
  await mpvEngine.destroy();
  fake.calls.length = 0;
  fake.state.loadRejects = false;
});

describe('startNativePlayback fallback', () => {
  it('starts on mpv when it is first in the chain', async () => {
    const surface = document.createElement('video');
    const h = handlers();
    const session = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/video.mp4',
      autoplay: true, volume: 100, rate: 1, handlers: h,
    });

    await settle();
    expect(fake.calls.some((call) => call.method === 'load' && (call.args[0] as { url: string }).url === 'https://example.com/video.mp4')).toBe(true);
    expect(h.onFallback).not.toHaveBeenCalled();
    session.stop();
  });

  it('hands off to Media3 with a notice when mpv cannot open the stream', async () => {
    fake.state.loadRejects = true;
    const surface = document.createElement('video');
    const h = handlers();
    const session = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/video.mkv',
      autoplay: true, volume: 100, rate: 1, handlers: h,
    });

    await settle();
    expect(h.onFallback).toHaveBeenCalledTimes(1);
    expect(h.onFallback).toHaveBeenCalledWith(
      'mpv could not play this stream — switched to Media3 (ExoPlayer).',
      'media3',
    );
    session.stop();
  });

  it('reports failure once the chain is spent, so the click is not silently lost', async () => {
    fake.state.loadRejects = true;
    const surface = document.createElement('video');
    const h = handlers();
    // A chain whose last entry is the engine that failed: on a build that cannot
    // run the web player this is what the controller sees, and the failure must
    // surface rather than being swallowed into a dead click.
    const session = startNativePlayback({
      engine: 'mpv', chain: ['mpv'], surface, url: 'https://example.com/video.mkv',
      autoplay: true, volume: 100, rate: 1, handlers: h,
    });

    await settle();
    expect(h.onFallback).toHaveBeenCalledTimes(1);
    const [message, next] = h.onFallback.mock.calls[0];
    expect(next).toBeNull();
    expect(String(message)).toContain('cannot open stream');
    session.stop();
  });

  it('treats end-of-file as a normal end, not a failure', async () => {
    const surface = document.createElement('video');
    const h = handlers();
    const session = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/video.mp4',
      autoplay: true, volume: 100, rate: 1, handlers: h,
    });

    await settle();
    emitted('mpvEvent', { event: 'EndFile', reason: 'Eof' });
    expect(h.onEnd).toHaveBeenCalledTimes(1);
    expect(h.onFallback).not.toHaveBeenCalled();
    session.stop();
  });

  it('falls back when mpv ends the file with an error reason', async () => {
    const surface = document.createElement('video');
    const h = handlers();
    const session = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/video.mp4',
      autoplay: true, volume: 100, rate: 1, handlers: h,
    });

    await settle();
    emitted('mpvEvent', { event: 'EndFile', reason: 'Error', error: 'Failed to open' });
    expect(h.onFallback).toHaveBeenCalledTimes(1);
    expect(h.onFallback.mock.calls[0][1]).toBe('media3');
    session.stop();
  });

  it('stops the previous session when a second one starts, and stop() is idempotent', async () => {
    const surface = document.createElement('video');
    const first = handlers();
    const second = handlers();

    const a = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/a.mp4',
      autoplay: true, volume: 100, rate: 1, handlers: first,
    });
    await settle();
    const b = startNativePlayback({
      engine: 'mpv', chain, surface, url: 'https://example.com/b.mp4',
      autoplay: true, volume: 100, rate: 1, handlers: second,
    });
    await settle();

    expect(fake.calls.filter((call) => call.method === 'destroy').length).toBeGreaterThanOrEqual(1);
    // A late event from the replaced session must not reach its handlers.
    first.onState.mockClear();
    emitted('propertyChange', { name: 'time-pos', value: 5 });
    expect(first.onState).not.toHaveBeenCalled();

    a.stop();
    a.stop();
    stopNativePlayback();
    b.stop();
  });
});
