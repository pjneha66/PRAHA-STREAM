// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

/**
 * A dead direct source used to stall the player forever.
 *
 * The web path for a plain file (mp4/mkv/…) was `video.src = url` plus
 * `play().catch(noop)`. With a dead URL the promise rejected into nothing, the
 * element stayed paused, no metadata ever arrived, so `ready` never became true
 * and the "Loading stream…" chip stayed up with no error panel and no retry.
 * `<video onError>` did not catch it (it was gated on a prop that flips later)
 * and the stall watchdog needs `!video.paused`.
 *
 * The hook now arms its own metadata watchdog on the direct path and reports a
 * fatal error, which is what surfaces the "Try again / Try another source /
 * Find sources" panel. These tests pin that behaviour.
 */

const hls = vi.hoisted(() => ({
  supported: false,
  android: false,
  configure: vi.fn(),
  bindP2p: vi.fn(),
}));

vi.mock('p2p-media-loader-hlsjs', () => ({
  HlsJsP2PEngine: class {
    getConfigForHlsJs() { return { fLoader: class P2pLoader {} }; }
    bindHls = hls.bindP2p;
    addEventListener() {}
    destroy() {}
  },
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => hls.supported;
    static DefaultConfig = { loader: class {} };
    static Events = {
      MANIFEST_PARSED: 'manifest', LEVEL_SWITCHED: 'lvl', LEVELS_UPDATED: 'lvlup',
      AUDIO_TRACKS_UPDATED: 'aud', AUDIO_TRACK_SWITCHED: 'audsw', ERROR: 'err',
    };
    constructor(config: unknown) { hls.configure(config); }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  },
}));

vi.mock('../services/androidBridge', () => ({
  isAndroidApp: () => hls.android,
  nativeFetchText: async () => ({ ok: false, status: 0, data: '' }),
  openExternalPlayer: () => undefined,
  resolvePlayableStreamUrl: (stream: { url: string }) => stream.url,
  setImmersiveFullscreen: async () => undefined,
  extractStreamHeaders: () => ({}),
  hasNativeHeaderProxy: () => false,
}));

vi.mock('../services/nativePlayback', () => ({
  startNativePlayback: () => ({ stop: () => undefined }),
  stopNativePlayback: () => undefined,
}));

import { useMpvEngine } from '../components/player/useMpvEngine';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';

/**
 * The hook attaches to a `<video>` handed to it by ref, so the harness has to
 * render one — an empty component gives it nothing to watch.
 */
function Harness({ url, onFatalError, onEngineFallback }: {
  url: string;
  onFatalError: (m: string) => void;
  onEngineFallback?: (m: string) => void;
}) {
  const engine = useMpvEngine({
    url,
    subtitles: [],
    autoplay: true,
    volume: 100,
    speed: 1,
    // Force the web path: the native engines do not exist in jsdom.
    forceWebEngine: true,
    onFatalError,
    onEngineFallback,
    onSettingsChange: () => undefined,
    onProgress: () => undefined,
    playerSettings: DEFAULT_PLAYER_SETTINGS,
  } as never);
  return <video ref={engine.videoRef} data-testid="target" />;
}

beforeEach(() => {
  hls.supported = false;
  hls.android = false;
  hls.configure.mockClear();
  hls.bindP2p.mockClear();
  vi.useFakeTimers();
  // jsdom has no media stack; a rejected play() is the same symptom a dead
  // source produces in a real WebView.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(() => Promise.reject(new Error('not supported'))),
  });
  // jsdom exposes `audioTracks` as an array-like rather than the EventTarget
  // the spec requires, which the hook rightly treats as a MediaStream track
  // list. Remove it so this behaves like a plain <video>.
  Object.defineProperty(HTMLMediaElement.prototype, 'audioTracks', {
    configurable: true,
    get: () => undefined,
  });
  // Same story for `textTracks`: real browsers give an EventTarget, jsdom gives
  // a list without listeners.
  Object.defineProperty(HTMLMediaElement.prototype, 'textTracks', {
    configurable: true,
    get() {
      const self = this as unknown as { __tracks?: EventTarget };
      if (!self.__tracks) self.__tracks = Object.assign(new EventTarget(), { length: 0 });
      return self.__tracks;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HLS fragment loading', () => {
  it('uses the Android-compatible HTTP loader in Android WebView', () => {
    hls.supported = true;
    hls.android = true;
    render(<Harness url="https://example.com/stream.m3u8" onFatalError={vi.fn()} />);

    expect(hls.configure).toHaveBeenCalledWith(expect.objectContaining({
      loader: expect.any(Function),
      capLevelOnFPSDrop: true,
    }));
    expect(hls.configure.mock.calls[0][0]).not.toHaveProperty('fLoader');
    expect(hls.bindP2p).not.toHaveBeenCalled();
  });

  it('keeps the P2P fragment loader in a normal web browser', () => {
    hls.supported = true;
    render(<Harness url="https://example.com/stream.m3u8" onFatalError={vi.fn()} />);

    expect(hls.configure).toHaveBeenCalledWith(expect.objectContaining({ fLoader: expect.any(Function) }));
    expect(hls.bindP2p).toHaveBeenCalledTimes(1);
  });
});

describe('the web player on a source that never loads', () => {
  it('keeps playback attached when the fallback notification callback changes', () => {
    const url = 'https://example.com/stream.mp4';
    const onFatalError = vi.fn();
    const { rerender } = render(<Harness url={url} onFatalError={onFatalError} onEngineFallback={vi.fn()} />);
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    expect(play).toHaveBeenCalledTimes(1);

    rerender(<Harness url={url} onFatalError={onFatalError} onEngineFallback={vi.fn()} />);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('reports a fatal error instead of loading forever', () => {
    const onFatalError = vi.fn();
    render(<Harness url="https://example.com/dead.mp4" onFatalError={onFatalError} />);

    // The watchdog needs time to expire; nothing should fire early.
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onFatalError).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(15_000); });
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(String(onFatalError.mock.calls[0][0])).toMatch(/did not start playing/i);
  });

  it('stays quiet when metadata does arrive in time', () => {
    const onFatalError = vi.fn();
    const { getByTestId } = render(
      <Harness url="https://example.com/good.mp4" onFatalError={onFatalError} />,
    );

    const video = getByTestId('target') as HTMLVideoElement;
    act(() => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
      video.dispatchEvent(new Event('loadedmetadata'));
    });

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(onFatalError).not.toHaveBeenCalled();
  });
});
