// @vitest-environment jsdom
//
// The dedicated Live TV player — VyseTV's `LiveTvPlayerPage`
// (GPL-3.0-or-later). The engine is mocked: what is under test is the chrome,
// the zapping, the idle hide and the Back layering, not mpv itself
// (`tests/livetv-ui.test.tsx` covers the browse side, `livetv.test.ts` the data
// plumbing).

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The engine surface `LiveTvPlayer` reads, mutated per test. */
const engine = {
  videoRef: { current: null as HTMLVideoElement | null },
  ready: true,
  waiting: false,
  playing: true,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  volume: 80,
  muted: false,
  rate: 1,
  levels: [] as unknown[],
  currentLevel: -1,
  audioTracks: [] as unknown[],
  currentAudio: '',
  textTracks: [] as unknown[],
  currentText: '',
  stats: null,
  loop: { a: null, b: null },
  canCast: false,
  nativeActive: false,
  engineLabel: 'html5',
  play: vi.fn(),
  pause: vi.fn(),
  toggle: vi.fn(),
  seekTo: vi.fn(),
  seekBy: vi.fn(),
  seekToPercent: vi.fn(),
  stepFrame: vi.fn(),
  setVolume: vi.fn(),
  toggleMute: vi.fn(),
  setSpeed: vi.fn(),
  setLevel: vi.fn(),
  selectAudio: vi.fn(),
  cycleAudio: vi.fn(),
  selectText: vi.fn(),
  cycleText: vi.fn(),
  toggleFullscreen: vi.fn(),
  togglePip: vi.fn(),
  promptCast: vi.fn(),
  saveFrame: vi.fn(),
  toggleLoop: vi.fn(),
  retry: vi.fn(),
  recoveryAttempts: 0,
  recoveryStatus: null,
};

/**
 * The hook reports a fatal through the `onFatalError` it was handed, so the
 * mock keeps the latest one: a test can fail the channel the way the engine
 * does, instead of reaching into the component's state.
 */
const fatal = { report: null as ((message: string) => void) | null };

vi.mock('../components/player/useMpvEngine', () => ({
  useMpvEngine: (options: { onFatalError?: (message: string) => void }) => {
    fatal.report = options.onFatalError ?? null;
    return engine;
  },
}));

/**
 * The platform flags `LiveTvPlayer` reads. Mutable so one test can stand in for
 * the Android app, where VyseTV's full-screen toggle is a deliberate no-op.
 */
const env = { androidApp: false };

vi.mock('../services/androidBridge', async () => {
  const actual = await vi.importActual<typeof import('../services/androidBridge')>('../services/androidBridge');
  return {
    ...actual,
    isAndroidApp: () => env.androidApp,
    isAndroidTv: () => false,
    setImmersiveFullscreen: vi.fn(async () => undefined),
  };
});

import LiveTvPlayer from '../components/player/LiveTvPlayer';
import { buildIptvPlayback, buildIptvPlaybackAt, playbackItemsOf } from '../services/liveTv/playback';
import type { LivePlaybackItem } from '../services/liveTv/playback';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';

const CHANNELS: LivePlaybackItem[] = [
  { name: 'Sky Sports F1', url: 'https://host.example/f1.m3u8', group: 'Motorsport', favoriteKey: 'm3u:f1' },
  { name: 'ESPN', url: 'https://host.example/espn.m3u8', group: 'US Sports', favoriteKey: 'm3u:espn' },
  { name: 'CNN', url: 'https://host.example/cnn.m3u8', group: 'News', favoriteKey: 'm3u:cnn' },
];

function openAt(index: number, items: LivePlaybackItem[] = CHANNELS) {
  const playback = buildIptvPlaybackAt(items, index);
  const onClose = vi.fn();
  const tree = render(
    <LiveTvPlayer
      playback={playback}
      settings={DEFAULT_PLAYER_SETTINGS}
      onSettingsChange={vi.fn()}
      autoplay
      onClose={onClose}
    />,
  );
  return { ...tree, playback, onClose };
}

/** The root's class list decides whether the controls are up. */
function chromeOn(container: HTMLElement) {
  return Boolean(container.querySelector('.ltvp-root.chrome-on'));
}

describe('Live TV player', () => {
  beforeEach(() => {
    localStorage.clear();
    engine.playing = true;
    engine.waiting = false;
    engine.nativeActive = false;
    engine.duration = 0;
    env.androidApp = false;
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the channel it was opened on, with its group and the LIVE badge', () => {
    const { container } = openAt(1);
    expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('ESPN');
    expect(container.querySelector('.ltvp-titles span')?.textContent).toBe('US Sports');
    expect(container.querySelector('.ltvp-live')?.textContent).toContain('LIVE');
  });

  it('hides the controls after four idle seconds, and only while playing', () => {
    vi.useFakeTimers();
    const { container } = openAt(0);
    expect(chromeOn(container)).toBe(true);
    // The hide is a setState on a timer, so it has to run inside `act`.
    // `waitFor` cannot be used here: it waits on real time, not the fake clock.
    act(() => { vi.advanceTimersByTime(4_100); });
    expect(chromeOn(container)).toBe(false);

    // A paused channel keeps its controls (VyseTV: `_playing`).
    cleanup();
    engine.playing = false;
    const paused = openAt(0);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(chromeOn(paused.container)).toBe(true);
  });

  it('zaps through the list it was handed and wraps around', async () => {
    const { container } = openAt(2);
    expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('CNN');

    fireEvent.click(screen.getByRole('button', { name: 'Next channel (↓)' }));
    await waitFor(() =>
      expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('Sky Sports F1'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous channel (↑)' }));
    await waitFor(() =>
      expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('CNN'),
    );
  });

  it('changes channel on ↑/↓ only while the controls are hidden', () => {
    vi.useFakeTimers();
    const { container } = openAt(0);
    act(() => { vi.advanceTimersByTime(4_100); });
    expect(chromeOn(container)).toBe(false);

    act(() => { fireEvent.keyDown(window, { key: 'ArrowDown' }); });
    expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('ESPN');
    // Zapping brings the controls back.
    expect(chromeOn(container)).toBe(true);
  });

  it('layers Back: the channel list, then the controls, then the player', async () => {
    vi.useFakeTimers();
    const { container, onClose } = openAt(0);

    fireEvent.click(screen.getByRole('button', { name: 'Channels (C)' }));
    expect(container.querySelector('.ltvp-panel.is-open')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.ltvp-panel.is-open')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' }); // hide the controls
    expect(chromeOn(container)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' }); // now leave
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(0);
  });

  it('places the channel that is on in the panel with an is-current row', async () => {
    const { container } = openAt(1);
    fireEvent.click(screen.getByRole('button', { name: 'Channels (C)' }));
    const current = container.querySelector('.ltvp-panel li button.is-current');
    expect(current?.textContent).toBe('ESPN');

    // Picking another row from the panel switches to it.
    const rows = [...container.querySelectorAll('.ltvp-panel li button')] as HTMLButtonElement[];
    rows[2].click();
    await waitFor(() =>
      expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('CNN'),
    );
  });

  it('shows the guide strip once the channel guide answers', async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const withGuide: LivePlaybackItem[] = [{
      name: 'F1',
      url: 'https://host.example/f1.m3u8',
      group: 'Motorsport',
      epg: async () => [
        { title: 'Practice 1', start: hour, stop: hour + 3_600_000 },
        { title: 'Qualifying', start: hour + 3_600_000, stop: hour + 7_200_000 },
      ],
    }];

    const { container } = openAt(0, withGuide);
    await waitFor(() =>
      expect(container.querySelector('.ltvp-guide-title')?.textContent).toBe('Practice 1'),
    );
    expect(container.querySelector('.ltvp-guide-next')?.textContent).toContain('Qualifying');
    expect(container.querySelector('.ltvp-guide-bar span')).not.toBeNull();
  });

  it('toggles the star and writes it to the favourites store', async () => {
    const { container } = openAt(0);
    const star = screen.getByRole('button', { name: 'Add to favorites' });
    expect(star.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(star);
    await waitFor(() => {
      const on = screen.getByRole('button', { name: 'Remove from favorites' });
      expect(on.getAttribute('aria-pressed')).toBe('true');
    });
    expect(container.querySelector('.ltvp-glass.is-on')).not.toBeNull();
    expect(localStorage.getItem('live_tv_favorite_list') ?? '').toContain('Sky Sports F1');
  });

  it('offers Retry and the next channel when playback fails', async () => {
    const { container } = openAt(0);

    // The engine reports a fatal through the callback it was given.
    await waitFor(() => expect(fatal.report).toBeTypeOf('function'));
    act(() => fatal.report!('This HLS stream could not be loaded.'));

    const card = await waitFor(() => {
      const found = container.querySelector('.ltvp-error');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain('This HLS stream could not be loaded.');
    expect(card.textContent).toContain('Retry');
    expect(card.textContent).toContain('Next channel');

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(engine.retry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container.querySelector('.ltvp-error')).toBeNull());

    // Next channel clears the failure and moves on.
    act(() => fatal.report!('offline'));
    await waitFor(() => expect(container.querySelector('.ltvp-error')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Next channel' }));
    await waitFor(() =>
      expect(container.querySelector('.ltvp-titles strong')?.textContent).toBe('ESPN'),
    );
    expect(container.querySelector('.ltvp-error')).toBeNull();
  });

  it('treats a second tap within 300 ms as a double tap and goes full screen', () => {
    vi.useFakeTimers();
    // jsdom has no Fullscreen API: give the root the two methods the player uses
    // and let the browser's own `fullscreenElement` stay null.
    const request = vi.fn(() => Promise.resolve());
    const exit = vi.fn(() => Promise.resolve());
    const rootProto = HTMLElement.prototype as unknown as Record<string, unknown>;
    rootProto.requestFullscreen = request;
    document.exitFullscreen = exit as unknown as () => Promise<void>;

    try {
      const { container } = openAt(0);
      const root = container.querySelector('.ltvp-root') as HTMLElement;

      // One tap hides the controls, as before.
      fireEvent.click(root);
      expect(chromeOn(container)).toBe(false);

      // A second tap 200 ms later is the double tap: full screen, not a re-show.
      act(() => { vi.advanceTimersByTime(200); });
      fireEvent.click(root);
      expect(request).toHaveBeenCalledTimes(1);
      expect(chromeOn(container)).toBe(false);

      // A third tap is a new first tap again (the helper clears the clock).
      act(() => { vi.advanceTimersByTime(200); });
      fireEvent.click(root);
      expect(request).toHaveBeenCalledTimes(1);
      expect(chromeOn(container)).toBe(true);
    } finally {
      delete rootProto.requestFullscreen;
      delete (document as unknown as Record<string, unknown>).exitFullscreen;
    }
  });

  it('honours a controller: A raises the controls, B is Back', () => {
    vi.useFakeTimers();
    // The pad's state is what the poll loop reads, so the test flips it between
    // frames and lets one animation frame run.
    const pad = {
      buttons: [{ pressed: false }, { pressed: false }],
    } as unknown as Gamepad;
    (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => [pad];
    // The player polls with rAF; queue the callbacks so the test drives each frame.
    const realRaf = window.requestAnimationFrame;
    const realCancel = window.cancelAnimationFrame;
    const frameQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frameQueue.push(cb);
      return frameQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();

    /** Run the single queued frame. */
    const frame = () => act(() => { frameQueue.shift()?.(0); });

    try {
      const { container, onClose } = openAt(0);

      // A, with the controls down: they come up.
      act(() => { vi.advanceTimersByTime(4_100); });
      expect(chromeOn(container)).toBe(false);
      (pad.buttons[0] as { pressed: boolean }).pressed = true;
      frame();
      expect(chromeOn(container)).toBe(true);

      // Held, it does not repeat: the next frame sees no new edge.
      frame();
      expect(chromeOn(container)).toBe(true);

      // B is Back, which hides the controls before it leaves the player.
      (pad.buttons[0] as { pressed: boolean }).pressed = false;
      frame();
      (pad.buttons[1] as { pressed: boolean }).pressed = true;
      frame();
      expect(chromeOn(container)).toBe(false);
      expect(onClose).not.toHaveBeenCalled();

      (pad.buttons[1] as { pressed: boolean }).pressed = false;
      frame();
      (pad.buttons[1] as { pressed: boolean }).pressed = true;
      frame();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).getGamepads;
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancel;
      vi.useRealTimers();
    }
  });

  it('leaves a double tap alone in the Android app, where the window is the screen', () => {
    vi.useFakeTimers();
    env.androidApp = true;
    const request = vi.fn(() => Promise.resolve());
    const rootProto = HTMLElement.prototype as unknown as Record<string, unknown>;
    rootProto.requestFullscreen = request;

    try {
      const { container } = openAt(0);
      const root = container.querySelector('.ltvp-root') as HTMLElement;
      fireEvent.click(root); // one tap: hide
      act(() => { vi.advanceTimersByTime(200); });
      fireEvent.click(root); // second tap: VyseTV does nothing at all
      expect(request).not.toHaveBeenCalled();
      // And it did not bring the controls back either — that is the Dart branch.
      expect(chromeOn(container)).toBe(false);
    } finally {
      delete rootProto.requestFullscreen;
    }
  });

  it('keeps the volume slider off a phone and the full-screen button off Android', () => {
    const realWidth = window.innerWidth;

    try {
      // Desktop: both are there.
      Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
      const desktop = openAt(0);
      expect(screen.queryByRole('slider', { name: 'Volume' })).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Full screen (F)' })).not.toBeNull();

      // A phone hides the slider (VyseTV: `!phone && playersHaveVolume`), keeping Mute.
      cleanup();
      Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
      openAt(0);
      expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Mute (M)' })).not.toBeNull();

      // In the Android app there is no window to make full screen, so no button.
      cleanup();
      env.androidApp = true;
      openAt(0);
      expect(screen.queryByRole('button', { name: 'Full screen (F)' })).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: realWidth, configurable: true });
    }
  });

  it('builds only a window of a long channel list in the panel', () => {
    // VyseTV's channel list is a `ListView.builder`: a 5,000-channel playlist
    // must not become 5,000 buttons. jsdom lays nothing out, so the 480 px
    // fallback height decides how many rows the window holds.
    const many: LivePlaybackItem[] = Array.from({ length: 5_000 }, (_, i) => ({
      name: `Channel ${i}`,
      url: `https://host.example/${i}.m3u8`,
      group: 'Sports',
    }));
    const { container } = openAt(0, many);
    fireEvent.click(screen.getByRole('button', { name: 'Channels (C)' }));

    const rows = container.querySelectorAll('.ltvp-panel-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    // The spacer still reports the whole list's height, so the scrollbar is true.
    const spacer = container.querySelector('.ltvp-panel-spacer') as HTMLElement;
    expect(spacer.style.height).toBe(`${5_000 * 52}px`);
    // The first window starts at the top, so the channel that is on is in it.
    expect(rows[0].getAttribute('data-row')).toBe('0');
  });

  it('opens the panel on the channel that is on, not at the top of a long list', () => {
    const many: LivePlaybackItem[] = Array.from({ length: 5_000 }, (_, i) => ({
      name: `Channel ${i}`,
      url: `https://host.example/${i}.m3u8`,
      group: 'Sports',
    }));
    // Opened on channel 3,000 (VyseTV jumps the list to it: `autofocus: current`).
    const { container } = openAt(3_000, many);
    fireEvent.click(screen.getByRole('button', { name: 'Channels (C)' }));

    // That row is in the built window, and it is the one marked current.
    const current = container.querySelector('.ltvp-panel-row.is-current');
    expect(current?.textContent).toBe('Channel 3000');
    expect(current?.getAttribute('data-row')).toBe('3000');
  });

  it('asks the guide again on Retry, the way VyseTV’s _open does', async () => {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    let calls = 0;
    const withGuide: LivePlaybackItem[] = [{
      name: 'F1',
      url: 'https://host.example/f1.m3u8',
      group: 'Motorsport',
      // The first ask fails (the stream was down too), the second answers.
      epg: async () => {
        calls += 1;
        if (calls === 1) throw new Error('guide offline');
        return [{ title: 'Race', start: hour, stop: hour + 3_600_000 }];
      },
    }];

    const { container } = openAt(0, withGuide);
    await waitFor(() => expect(calls).toBe(1));
    expect(container.querySelector('.ltvp-guide-title')).toBeNull();

    await waitFor(() => expect(fatal.report).toBeTypeOf('function'));
    act(() => fatal.report!('offline'));
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));

    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() =>
      expect(container.querySelector('.ltvp-guide-title')?.textContent).toBe('Race'),
    );
  });

  it('renders a single-channel playback without a channel panel or zapping', () => {
    const { container } = openAt(0, [CHANNELS[0]]);
    expect(screen.queryByRole('button', { name: 'Channels (C)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next channel (↓)' })).toBeNull();
    expect(container.querySelector('.ltvp-live')).not.toBeNull();
  });

  it('goes transparent while a native engine owns the picture', () => {
    engine.nativeActive = true;
    const { container } = openAt(0);
    expect(container.querySelector('.ltvp-root.is-native')).not.toBeNull();
    expect(document.documentElement.classList.contains('player-vlc-active')).toBe(true);
    expect(document.body.classList.contains('player-vlc-active')).toBe(true);
  });

  it('shows a seek bar instead of the guide for a non-live item', () => {
    engine.duration = 600;
    const voy: LivePlaybackItem[] = [{ name: 'A film', url: 'https://host.example/film.mp4', live: false }];
    const { container } = openAt(0, voy);
    expect(container.querySelector('.ltvp-live')).toBeNull();
    expect(container.querySelector('.ltvp-guide-title')).toBeNull();
    expect(screen.getByRole('button', { name: 'Seek forward' })).toBeTruthy();
  });
});

describe('playback plumbing', () => {
  it('maps a LiveItem list into player entries, keeping guide and star', () => {
    const epg = async () => [{ title: 'Now', start: 0, stop: 1 }];
    const items = playbackItemsOf([
      { title: 'One', url: 'https://a/1.m3u8', subtitle: 'Portal  ·  One', live: true, epg, favoriteKey: 'k1' },
      { title: 'Two', url: 'https://a/2.m3u8', live: false },
    ]);
    expect(items[0]).toMatchObject({
      name: 'One',
      url: 'https://a/1.m3u8',
      group: 'Portal  ·  One',
      live: true,
      favoriteKey: 'k1',
    });
    expect(items[0].epg).toBe(epg);
    expect(items[1].live).toBe(false);
    expect(items[1].epg).toBeUndefined();
  });

  it('keeps the caller’s version of the playing channel in the list', () => {
    const epg = async () => [];
    // The row the page handed over did not carry the guide; the tapped item does.
    const playback = buildIptvPlayback(
      { name: 'ESPN', url: 'https://a/espn.m3u8', live: true, epg, favoriteKey: 'espn' },
      { items: CHANNELS, index: 1 },
    );
    expect(playback.index).toBe(1);
    expect(playback.items[1].name).toBe('ESPN');
    expect(playback.items[1].epg).toBe(epg);
    expect(playback.items[1].favoriteKey).toBe('espn');
    // The others are untouched.
    expect(playback.items[0].url).toBe(CHANNELS[0].url);
    // The caller's array was not mutated.
    expect(CHANNELS[1].epg).toBeUndefined();
  });

  it('clamps an out-of-range index and falls back to a one-channel list', () => {
    expect(buildIptvPlaybackAt(CHANNELS, 99).index).toBe(CHANNELS.length - 1);
    expect(buildIptvPlaybackAt(CHANNELS, -5).index).toBe(0);
    const single = buildIptvPlayback(CHANNELS[0]);
    expect(single.items).toHaveLength(1);
    expect(single.index).toBe(0);
  });
});
