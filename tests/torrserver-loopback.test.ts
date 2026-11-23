import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Save & test" on the bundled TorrServer.
 *
 * The bundled engine is addressed through the same loopback URL the user types
 * into Settings, and `checkEngineAvailable` used to treat any explicit host as
 * "an external server, do not start the bundled one". The screenshot that
 * prompted this test showed exactly that: the badge read "Stopped", the URL was
 * the default http://127.0.0.1:8090, and the probe reported the engine as
 * unreachable because nothing had started it.
 *
 * The fix keys off the host instead of the caller: a loopback URL means the
 * bundled engine, so it is started before the probe.
 */
const state = vi.hoisted(() => ({
  supported: true,
  running: false,
  startCalls: 0,
  startSucceeds: true,
  echoCalls: 0,
  echoFails: false,
  fetched: [] as string[],
}));

vi.mock('../services/androidBridge', () => ({
  isAndroidApp: () => true,
  nativeFetchText: async (url: string) => {
    state.fetched.push(url);
    throw new Error('offline');
  },
}));

vi.mock('../services/p2p/torrServerController', () => ({
  torrServerController: {
    isSupported: () => state.supported,
    get running() { return state.running; },
    get host() { return state.running ? 'http://127.0.0.1:8090' : ''; },
    async ensureStarted() {
      state.startCalls += 1;
      if (!state.startSucceeds) return false;
      state.running = true;
      return true;
    },
  },
}));

vi.mock('../services/p2p/torrServerClient', () => ({
  TorrServerClient: class {
    async echo() {
      state.echoCalls += 1;
      if (state.echoFails || !state.running) throw new Error('connection refused');
      return { version: 'matrix' };
    }
  },
}));

vi.mock('../services/torrentTitle', () => ({
  parseTorrentTitle: () => ({}),
  torrentFileMatches: () => true,
}));

vi.mock('webtorrent', () => ({ default: class {} }));

import { isLoopbackHost, TorrentStreamingEngine } from '../services/torrentStreamingService';

beforeEach(() => {
  state.supported = true;
  state.running = false;
  state.startCalls = 0;
  state.startSucceeds = true;
  state.echoCalls = 0;
  state.echoFails = false;
  state.fetched = [];
});

describe('isLoopbackHost', () => {
  it('recognises the bundled engine URLs', () => {
    expect(isLoopbackHost('http://127.0.0.1:8090')).toBe(true);
    expect(isLoopbackHost('http://localhost:8090')).toBe(true);
    expect(isLoopbackHost('http://[::1]:8090')).toBe(true);
    expect(isLoopbackHost('https://127.1.2.3')).toBe(true);
  });

  it('does not mistake a real server for the bundled engine', () => {
    expect(isLoopbackHost('http://192.168.1.20:8090')).toBe(false);
    expect(isLoopbackHost('https://torr.example.com')).toBe(false);
    // A hostname that merely starts with "127." is not an address.
    expect(isLoopbackHost('http://127.example.com')).toBe(false);
    expect(isLoopbackHost('not a url')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('checkEngineAvailable against a loopback host', () => {
  it('starts the bundled engine before probing it', async () => {
    const ok = await TorrentStreamingEngine.checkEngineAvailable('http://127.0.0.1:8090');

    expect(state.startCalls).toBe(1);
    expect(ok).toBe(true);
    // The bundled path must not fall through to the raw HTTP probe.
    expect(state.fetched).toEqual([]);
  });

  it('reports failure when the bundled engine will not start', async () => {
    state.startSucceeds = false;

    const ok = await TorrentStreamingEngine.checkEngineAvailable('http://127.0.0.1:8090');

    expect(ok).toBe(false);
    // It still tried, rather than silently skipping the start.
    expect(state.startCalls).toBe(1);
  });

  it('reports failure when the engine starts but does not answer', async () => {
    state.echoFails = true;

    const ok = await TorrentStreamingEngine.checkEngineAvailable('http://127.0.0.1:8090');

    expect(ok).toBe(false);
    expect(state.echoCalls).toBeGreaterThan(0);
  });

  it('leaves an external host to the plain HTTP probe', async () => {
    const ok = await TorrentStreamingEngine.checkEngineAvailable('http://192.168.1.20:8090');

    expect(state.startCalls).toBe(0);
    expect(state.fetched.length).toBeGreaterThan(0);
    expect(ok).toBe(false);
  });

  it('still starts the engine when no host is supplied at all', async () => {
    const ok = await TorrentStreamingEngine.checkEngineAvailable();

    expect(state.startCalls).toBe(1);
    expect(ok).toBe(true);
  });

  it('falls through to the probe on a build without the native engine', async () => {
    state.supported = false;

    const ok = await TorrentStreamingEngine.checkEngineAvailable('http://127.0.0.1:8090');

    // Nothing to start on web/PWA, so the saved self-hosted server is probed.
    expect(state.startCalls).toBe(0);
    expect(state.fetched.length).toBeGreaterThan(0);
    expect(ok).toBe(false);
  });
});
