// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';
import type { MediaItem, StreamResult } from '../types';

/**
 * Closing the player must stop the in-app P2P engine, but closing it must not
 * happen on StrictMode's throwaway unmount — the magnet would be left resolved
 * to a blob URL that no longer exists. The teardown is therefore deferred by a
 * tick and cancelled on remount. This test drives the real mount/unmount pair
 * and asserts both halves: no destroy while mounted, exactly one after the
 * final unmount.
 */
const destroyed = vi.hoisted(() => ({ count: 0 }));

vi.mock('../services/torrentStreamingService', () => ({
  TorrentStreamingEngine: {
    destroyWebTorrent: () => { destroyed.count += 1; },
    checkEngineAvailable: async () => false,
    streamTorrent: async () => ({ streamUrl: 'http://127.0.0.1/a', infoHash: 'x' }),
    subscribeStats: () => () => undefined,
    resolveViaWebTorrent: async () => null,
    getHost: () => '',
  },
}));

vi.mock('../services/debridService', () => ({
  buildMagnetUri: (stream: StreamResult) => stream.url,
  isMagnetOrTorrent: (stream: StreamResult) => stream.url.startsWith('magnet:'),
  resolveDebridStream: async (stream: StreamResult) => stream,
}));

vi.mock('../services/stremioService', () => ({
  findStremioSubtitles: async () => [],
}));
vi.mock('../components/player/useMpvEngine', () => ({
  useMpvEngine: () => ({
    videoRef: { current: null }, ready: false, waiting: false, playing: false,
    currentTime: 0, duration: 0, buffered: 0, volume: 100, muted: false, rate: 1,
    levels: [], currentLevel: -1, audioTracks: [], currentAudio: '', textTracks: [],
    currentText: '', stats: null, loop: { a: null, b: null }, canCast: false,
    toggle: vi.fn(), seekBy: vi.fn(), selectAudio: vi.fn(), selectText: vi.fn(),
  }),
}));
vi.mock('../services/introService', () => ({ fetchIntroSegments: async () => [] }));
vi.mock('../services/nativePlayback', () => ({ stopNativePlayback: () => undefined }));
vi.mock('../services/androidBridge', () => ({
  extractStreamHeaders: () => ({}),
  hasNativeHeaderProxy: () => false,
  isAndroidApp: () => false,
  openExternalPlayer: () => undefined,
  resolvePlayableStreamUrl: (stream: StreamResult) => stream.url,
  setImmersiveFullscreen: async () => undefined,
}));

import PlayerModal from '../components/PlayerModal';

const media: MediaItem = {
  id: 'tt1', tmdbId: 1, type: 'movie', title: 'Test Film', overview: '', poster: '',
  genres: [], source: 'tmdb',
};

const magnet: StreamResult = {
  id: 's1', title: 'Torrent', url: 'magnet:?xt=urn:btih:deadbeef', sourceName: 'T', sourceType: 'torrserver',
};

function renderModal() {
  return render(
    <StrictMode>
      <PlayerModal
        media={media}
        stream={magnet}
        addons={[]}
        debrid={{ provider: 'none', apiKey: '', downloadDir: '' } as never}
        preferNativeProxy={false}
        autoplay={false}
        playerSettings={DEFAULT_PLAYER_SETTINGS}
        onPlayerSettingsChange={() => undefined}
        onProgress={() => undefined}
        onClose={() => undefined}
      />
    </StrictMode>,
  );
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  destroyed.count = 0;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('PlayerModal WebTorrent teardown', () => {
  it('does not destroy the torrent on StrictMode re-mount, but does on the real close', async () => {
    const view = renderModal();

    // StrictMode has already unmounted and remounted by now; the scheduled
    // teardown from the first cleanup must have been cancelled.
    await tick();
    expect(destroyed.count).toBe(0);

    view.unmount();
    // The teardown is deferred by a tick, so it lands just after unmount.
    await tick();
    expect(destroyed.count).toBe(1);
  });
});
