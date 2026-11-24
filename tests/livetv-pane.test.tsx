// @vitest-environment jsdom
//
// The portal browser's watch pane — VyseTV's `portal_browser_player.dart`
// (GPL-3.0-or-later) and the three-pane rule from
// `lib/screens/live_tv/portal_browser_page.dart`.
//
// The engine is mocked: what is under test is the pane, the pane ↔ full-screen
// switch, zapping, the details and the layout rule — not mpv. The sibling
// suite `tests/livetv-player.test.tsx` covers the standalone player.

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the engine, faked ──────────────────────────────────────────────────── */

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

/** Every engine mount, so a test can count reconnects. */
const mounts: string[] = [];
/** The mock keeps the latest fatal reporter so a test can fail the stream. */
const fatal = { report: null as ((message: string) => void) | null };

vi.mock('../components/player/useMpvEngine', () => ({
  useMpvEngine: (options: { url: string; onFatalError?: (message: string) => void }) => {
    fatal.report = options.onFatalError ?? null;
    React.useEffect(() => { mounts.push(options.url); }, [options.url]);
    return engine;
  },
}));

/* ── platform ───────────────────────────────────────────────────────────── */

const platform = { androidApp: false, androidTv: false };

vi.mock('../services/androidBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/androidBridge')>();
  return {
    ...actual,
    isAndroidApp: () => platform.androidApp,
    isAndroidTv: () => platform.androidTv,
    setImmersiveFullscreen: vi.fn(async () => undefined),
  };
});

/* ── the portal, served from the network layer ──────────────────────────── */

const CHANNELS = [
  { stream_id: 1, name: 'Sky Sports F1', stream_icon: 'https://img/f1.png', category_id: '10' },
  { stream_id: 2, name: 'ESPN', stream_icon: '', category_id: '10' },
  { stream_id: 3, name: 'CNN International', stream_icon: 'https://img/cnn.png', category_id: '20' },
];

/** A two-programme guide for channel 1, the way Xtream sends it: base64 text. */
function epgFor(streamId: string) {
  if (streamId !== '1') return JSON.stringify({ epg_listings: [] });
  const now = Math.floor(Date.now() / 1000);
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  return JSON.stringify({
    epg_listings: [
      { start_timestamp: String(now - 600), stop_timestamp: String(now + 1800), title: b64('British GP Practice'), description: b64('Live from Silverstone.') },
      { start_timestamp: String(now + 1800), stop_timestamp: String(now + 5400), title: b64('Qualifying'), description: b64('') },
    ],
  });
}

vi.mock('../services/liveTv/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/liveTv/http')>();
  return {
    ...actual,
    getText: vi.fn(async (url: string) => {
      if (url.includes('get_short_epg')) {
        const id = url.match(/stream_id=([^&]*)/)?.[1] ?? '';
        return epgFor(decodeURIComponent(id));
      }
      if (url.includes('get_live_categories')) {
        return JSON.stringify([
          { category_id: '10', category_name: 'Sports' },
          { category_id: '20', category_name: 'News' },
        ]);
      }
      if (url.includes('get_live_streams')) return JSON.stringify(CHANNELS);
      return null;
    }),
  };
});

import { PortalBrowserPage } from '../components/liveTv/pages';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';

const portal = {
  portal: { url: 'http://iptv.example:8080', username: 'user', password: 'pass' },
  name: 'Test Portal',
  expiry: '2027-01-01',
  maxConnections: '2',
  activeConnections: '0',
} as never;

/** jsdom has no layout: give the pane row (and the player in it) a real box.
 *  `top` is where the row sits, so the pane height is `height - top` — the same
 *  measure `PortalBrowserPage` takes. */
function sizePanes(width: number, height: number, top = 100) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ltv-browser-panes')) {
      return { x: 0, y: 0, top, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    }
    if (this.classList.contains('blp-root')) {
      // The picture pane: the third column of the rule above, ~1/3 of the row.
      const paneWidth = Math.max(0, width - Math.min(300, width * 0.24) - Math.min(440, width * 0.3) - 28);
      return { x: 0, y: 0, top, left: 0, right: paneWidth, bottom: height, width: paneWidth, height, toJSON: () => ({}) } as DOMRect;
    }
    return original.call(this);
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      // `useWidthAtLeast` reads the player's own width for the 470 px `roomy` test.
      if (this.classList?.contains('blp-root')) {
        return Math.max(0, width - Math.min(300, width * 0.24) - Math.min(440, width * 0.3) - 28);
      }
      return this.classList?.contains('ltv-browser-panes') ? width : 0;
    },
  });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

function renderPage(overrides: Partial<React.ComponentProps<typeof PortalBrowserPage>> = {}) {
  return render(
    <PortalBrowserPage
      portal={portal}
      section="live"
      onSection={vi.fn()}
      onPlay={vi.fn()}
      onOpenSeries={vi.fn()}
      onBack={vi.fn()}
      playerSettings={DEFAULT_PLAYER_SETTINGS}
      onPlayerSettingsChange={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  mounts.length = 0;
  fatal.report = null;
  platform.androidApp = false;
  platform.androidTv = false;
  sizePanes(1400, 900);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('portal browser watch pane', () => {
  it('shows the pane only when the rule says there is room, and asks for a channel', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    // VyseTV's `_PaneNote` before anything is playing.
    expect(container.querySelector('.ltv-browser-panes.has-watch')).not.toBeNull();
    expect(container.textContent).toContain('Pick a channel');
    expect(container.textContent).toContain('It plays here.');
    expect(container.querySelector('.blp-root')).toBeNull();
  });

  it('plays a live channel in the pane instead of leaving the page', async () => {
    const onPlay = vi.fn();
    const { container } = renderPage({ onPlay });
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    const play = container.querySelector('.ltv-row-play') as HTMLButtonElement;
    play.click();

    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());
    expect(onPlay).not.toHaveBeenCalled();
    // The pane is playing the row that was tapped, and says so in the list.
    expect(container.querySelector('.ltv-row.is-watching')).not.toBeNull();
    expect(mounts).toEqual(['http://iptv.example:8080/live/user/pass/1.ts']);
  });

  it('never reconnects the stream when the pane goes full screen and back', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());
    expect(mounts).toHaveLength(1);

    // The pane's expand button, and F: both are VyseTV's `onExpand`.
    const fullScreen = container.querySelector('[aria-label="Full screen (F)"]') as HTMLButtonElement;
    expect(fullScreen).not.toBeNull();
    fullScreen.click();
    await waitFor(() => expect(container.querySelector('.blp-root.is-full')).not.toBeNull());

    fireEvent.keyDown(window, { key: 'f' });
    await waitFor(() => expect(container.querySelector('.blp-root.is-full')).toBeNull());
    expect(container.querySelector('.ltv-browser-panes.has-watch')).not.toBeNull();

    // Same element, same engine, one open: the stream held through both moves.
    expect(mounts).toEqual(['http://iptv.example:8080/live/user/pass/1.ts']);
  });

  it('steps through the visible list with ↓ ↑ and wraps at both ends', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('ESPN'));
    const plays = [...container.querySelectorAll('.ltv-row-play')] as HTMLButtonElement[];
    plays[0].click();
    await waitFor(() => expect(mounts).toHaveLength(1));
    expect(mounts[0]).toBe('http://iptv.example:8080/live/user/pass/1.ts');

    // The first category is selected, so the list on screen is its two channels:
    // stepping runs over `visible`, not the portal's whole catalogue.
    fireEvent.keyDown(window, { key: 'ChannelDown' });
    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(mounts[1]).toBe('http://iptv.example:8080/live/user/pass/2.ts');

    // Past the last row, ↓ comes back to the first.
    fireEvent.keyDown(window, { key: 'ChannelDown' });
    await waitFor(() => expect(mounts).toHaveLength(3));
    expect(mounts[2]).toBe('http://iptv.example:8080/live/user/pass/1.ts');

    // Before the first row, ↑ goes to the last.
    fireEvent.keyDown(window, { key: 'ChannelUp' });
    await waitFor(() => expect(mounts).toHaveLength(4));
    expect(mounts[3]).toBe('http://iptv.example:8080/live/user/pass/2.ts');
  });

  it('offers Retry and Next channel when the stream fails', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());

    act(() => { fatal.report?.('source offline'); });
    await waitFor(() => expect(container.textContent).toContain("This stream isn't playing"));
    expect(container.textContent).toContain('The source may be offline or busy.');
    expect(container.textContent).toContain('Retry');
    expect(container.textContent).toContain('Next channel');

    const next = [...container.querySelectorAll('.blp-error-actions button')]
      .find((button) => (button.textContent || '').includes('Next channel')) as HTMLButtonElement;
    next.click();
    await waitFor(() => expect(mounts).toHaveLength(2));
    expect(mounts[1]).toBe('http://iptv.example:8080/live/user/pass/2.ts');
    // A new channel starts clean: the last one's failure is not carried over.
    expect(container.textContent).not.toContain("This stream isn't playing");
  });

  it('hides the pane controls when the mouse leaves, and shows them on the picture', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());

    const root = container.querySelector('.blp-root') as HTMLElement;
    expect(root.classList.contains('chrome-on')).toBe(true);

    fireEvent.mouseLeave(root);
    await waitFor(() => expect(root.classList.contains('chrome-off')).toBe(true));

    fireEvent.click(root);
    await waitFor(() => expect(root.classList.contains('chrome-on')).toBe(true));
  });

  it('shows the channel details under the picture, with its guide', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();

    await waitFor(() => expect(container.querySelector('.ltv-watch-info')).not.toBeNull());
    const info = container.querySelector('.ltv-watch-info') as HTMLElement;
    expect(info.textContent).toContain('Sky Sports F1');
    // `category · portal`, as VyseTV writes it.
    expect(info.textContent).toContain('Sports');
    expect(info.textContent).toContain('Test Portal');

    // The guide arrives after the picture, so this is the state before it lands.
    await waitFor(() => expect(info.textContent).toContain('British GP Practice'));
    expect(info.textContent).toContain('ON NOW');
    expect(info.textContent).toContain('Live from Silverstone.');
    expect(info.textContent).toContain('UP NEXT');
    expect(info.textContent).toContain('Qualifying');
    expect(info.textContent).not.toContain('Loading the guide');
  });

  it('says "no guide" once the guide has come back empty', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('ESPN'));
    const plays = [...container.querySelectorAll('.ltv-row-play')] as HTMLButtonElement[];
    plays[1].click();

    await waitFor(() => expect(container.querySelector('.ltv-watch-info')).not.toBeNull());
    const info = container.querySelector('.ltv-watch-info') as HTMLElement;
    await waitFor(() => expect(info.textContent).toContain('No guide for this channel'));
  });

  it('has no pane on a narrow screen, so a channel opens the full player', async () => {
    sizePanes(600, 900);
    const onPlay = vi.fn();
    const { container } = renderPage({ onPlay });
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    expect(container.querySelector('.ltv-browser-panes.has-watch')).toBeNull();
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();

    // VyseTV's stepped layouts clear `_watching` and hand the channel over.
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(onPlay.mock.calls[0][0].live).toBe(true);
    expect(container.querySelector('.blp-root')).toBeNull();
  });

  it('has no pane on a short screen even when it is wide', async () => {
    sizePanes(1400, 400);
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    // VyseTV: `three` also needs `size.height >= 420`.
    expect(container.querySelector('.ltv-browser-panes.has-watch')).toBeNull();
  });

  it('forgets the channel when the section changes to films', async () => {
    const { container, rerender } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());

    rerender(
      <PortalBrowserPage
        portal={portal}
        section="vod"
        onSection={vi.fn()}
        onPlay={vi.fn()}
        onOpenSeries={vi.fn()}
        onBack={vi.fn()}
        playerSettings={DEFAULT_PLAYER_SETTINGS}
        onPlayerSettingsChange={vi.fn()}
      />,
    );

    // VyseTV's `_open`: `if (s != IptvSection.live) _watching = null`.
    await waitFor(() => expect(container.querySelector('.blp-root')).toBeNull());
  });

  it('keeps four controls in the bottom bar and never the top bar while in the pane', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    (container.querySelector('.ltv-row-play') as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('.blp-root')).not.toBeNull());

    // VyseTV draws `_topBar` only in full screen.
    expect(container.querySelector('.blp-top')).toBeNull();
    expect(container.querySelector('[aria-label="Back to the list (Esc)"]')).toBeNull();

    const labels = [...container.querySelectorAll('.blp-btn')]
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toContain('Pause (Space)');
    expect(labels).toContain('Previous channel (↑)');
    expect(labels).toContain('Next channel (↓)');
    expect(labels).toContain('Full screen (F)');
  });
});

describe('the categories pane', () => {
  it('narrows its own list by its own search, apart from the channel search', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));
    const catNames = () => [...container.querySelectorAll('.ltv-cat-item span')]
      .map((span) => (span.textContent || '').trim());
    expect(catNames()).toContain('Sports');
    expect(catNames()).toContain('News');

    // VyseTV keeps `_catText` separate: typing here must not filter channels.
    const field = container.querySelector('input[aria-label="Search categories"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    fireEvent.change(field, { target: { value: 'spo' } });

    await waitFor(() => expect(catNames()).not.toContain('News'));
    // `_cats()` runs the needle over "Favorites" and "All channels" too, so
    // neither survives a word it does not contain; only the real match does.
    expect(catNames()).toEqual(['Sports']);
    // The channel list is untouched — both channels are still there.
    expect(container.textContent).toContain('ESPN');
  });

  it('keeps "All channels" and "Favorites" when the needle matches them', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    const field = container.querySelector('input[aria-label="Search categories"]') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'all' } });

    await waitFor(() => expect(
      [...container.querySelectorAll('.ltv-cat-item')].length,
    ).toBe(1));
    const catNames = [...container.querySelectorAll('.ltv-cat-item span')]
      .map((span) => (span.textContent || '').trim());
    expect(catNames).toEqual(['All channels']);
  });

  it('says so when no category matches', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    const field = container.querySelector('input[aria-label="Search categories"]') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'zzzz' } });

    await waitFor(() => expect(container.textContent).toContain('No category matches'));
    // Only the categories pane emptied; the list still shows both channels.
    expect(container.querySelectorAll('.ltv-cat-item').length).toBe(0);
    expect(container.textContent).toContain('ESPN');
  });

  it('sorts the categories A→Z and back, without touching the channel order', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    const names = () => [...container.querySelectorAll('.ltv-cat-item span')]
      .map((span) => (span.textContent || '').trim());
    // Portal order, as the portal sends it. "All channels" is lower-case in
    // VyseTV's `_noun`, so it is not "All Channels".
    expect(names()).toEqual(['Favorites', 'All channels', 'Sports', 'News']);

    const az = container.querySelector('[aria-label="Sort A to Z"]') as HTMLButtonElement;
    expect(az).not.toBeNull();
    az.click();
    await waitFor(() => expect(names()).toEqual(['Favorites', 'All channels', 'News', 'Sports']));

    // The toggle goes back to portal order rather than a third state.
    const off = container.querySelector('[aria-label="Back to portal order"]') as HTMLButtonElement;
    off.click();
    await waitFor(() => expect(names()).toEqual(['Favorites', 'All channels', 'Sports', 'News']));
  });

  it('starts the channel list over when another category is picked', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    const listField = [...container.querySelectorAll('input[aria-label="Search this portal"]')]
      .find((input) => !container.querySelector('.blp-root')?.contains(input)) as HTMLInputElement;
    fireEvent.change(listField, { target: { value: 'sky' } });
    await waitFor(() => expect(container.textContent).not.toContain('ESPN'));

    // `_pickCategory` runs `_resetList`: the search is dropped with the category.
    const news = [...container.querySelectorAll('.ltv-cat-item')]
      .find((item) => (item.textContent || '').includes('News')) as HTMLButtonElement;
    news.click();
    await waitFor(() => expect(container.textContent).toContain('CNN International'));
    expect(listField.value).toBe('');
  });
});

describe('the compact layout on a short screen', () => {
  it('drops the subtitle and folds both searches into icons', async () => {
    // VyseTV's `short`: `size.height < 520` — a phone on its side. 500 px of
    // room left below the bar, so the pane still fits (`three` needs 420).
    sizePanes(1400, 600, 100);
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Sky Sports F1'));

    // Still wide enough for the pane: `three` needs 420 px of height, not 520.
    expect(container.querySelector('.ltv-browser-panes.has-watch')).not.toBeNull();
    // `_topBar(compact: short)` keeps the name and drops the meta line.
    expect(container.querySelector('.ltv-subpage.is-compact')).not.toBeNull();
    expect(container.textContent).not.toContain('Expires 2027-01-01');

    // Neither search is drawn until its icon is pressed.
    expect(container.querySelector('input[aria-label="Search categories"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Search this portal"]')).toBeNull();

    const catIcon = container.querySelector('[aria-label="Search categories"]') as HTMLButtonElement;
    catIcon.click();
    await waitFor(() => expect(container.querySelector('input[aria-label="Search categories"]')).not.toBeNull());

    // Closing it with its own X puts the icon back.
    const close = container.querySelector('[aria-label="Close category search"]') as HTMLButtonElement;
    close.click();
    await waitFor(() => expect(container.querySelector('input[aria-label="Search categories"]')).toBeNull());
  });
});
