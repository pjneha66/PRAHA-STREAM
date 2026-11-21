// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => {
  const responses = new Map<string, { ok: boolean; status: number; data: string }>();
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const nativeFetchText = async (url: string, options: Record<string, unknown> = {}) => {
    calls.push({ url, options });
    return responses.get(url) || { ok: true, status: 200, data: '' };
  };
  const plugin = {
    start: vi.fn(async () => ({ port: 9123, pid: 4242, binaryPath: '/data/app/libtorrserver.so', dataDir: '/data/data/torrserver_data' })),
    stop: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ running: true, port: 9123, pid: 4242, logs: ['engine ready'] })),
    getNativeLibraryDir: vi.fn(async () => ({ path: '/data/app' })),
    getLogs: vi.fn(async () => ({ logs: [] })),
  };
  return { responses, calls, nativeFetchText, plugin };
});

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: (url: string, options: Record<string, unknown>) => mock.nativeFetchText(url, options),
  isAndroidApp: () => true,
}));

vi.mock('../services/p2p/torrServerBridge', () => ({
  PrahaTorrServer: mock.plugin,
  torrServerNativeAvailable: () => true,
}));

import {
  tunedTorrServerSettings,
  applyTunedSettings,
  TORRSERVER_DEFAULTS,
  FALLBACK_TRACKERS,
} from '../services/p2p/torrServerSettings';
import { TorrServerClient } from '../services/p2p/torrServerClient';
import { torrServerController } from '../services/p2p/torrServerController';

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
}

beforeEach(async () => {
  await torrServerController.stop();
  mock.calls.length = 0;
  mock.responses.clear();
  mock.plugin.start.mockClear();
  mock.plugin.stop.mockClear();
  setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36');
});

describe('tuned TorrServer settings', () => {
  it('uses the measured phone profile — small cache, 150 peers, IPv6 off', () => {
    const tuned = tunedTorrServerSettings();
    expect(tuned.CacheSize).toBe(256 * 1024 * 1024);
    expect(tuned.ConnectionsLimit).toBe(150);
    expect(tuned.EnableIPv6).toBe(false);
    expect(tuned.ReaderReadAHead).toBe(95);
    expect(tuned.PreloadCache).toBe(2);
    expect(tuned.TorrentDisconnectTimeout).toBe(120);
    expect(tuned.UseDisk).toBe(false);
    expect(tuned.RemoveCacheOnDrop).toBe(true);
    expect(tuned.EnableLPD).toBe(true);
    expect(tuned.DisableUPNP).toBe(false);
    expect(tuned.DisableDHT).toBe(false);
    expect(tuned.DisablePEX).toBe(false);
    expect(tuned.DisableUpload).toBe(false);
    expect(tuned.EnableDLNA).toBe(false);
    expect(tuned.EnableBonjour).toBe(false);
  });

  it('uses the desktop profile on a TV / non-phone device', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36');
    const tuned = tunedTorrServerSettings();
    expect(tuned.CacheSize).toBe(1024 * 1024 * 1024);
    expect(tuned.ConnectionsLimit).toBe(300);
  });

  it('keeps user credentials and Torznab config when applying the profile', () => {
    const server = { ...TORRSERVER_DEFAULTS, TMDBSettings: { APIKey: 'secret' }, PeersListenPort: 6881 };
    const applied = applyTunedSettings(server);
    expect(applied.TMDBSettings).toEqual({ APIKey: 'secret' });
    expect(applied.PeersListenPort).toBe(6881);
    expect(applied.EnableIPv6).toBe(false);
    expect(applied.CacheSize).toBe(256 * 1024 * 1024);
  });
});

describe('TorrServer REST client', () => {
  const client = new TorrServerClient('http://127.0.0.1:9123/');

  it('echoes the server version and adds a torrent with the right action', async () => {
    mock.responses.set('http://127.0.0.1:9123/echo', { ok: true, status: 200, data: 'TorrServer 1.2\n' });
    mock.responses.set('http://127.0.0.1:9123/torrents', {
      ok: true, status: 200, data: JSON.stringify({ hash: 'abc', title: 'Movie' }),
    });
    expect(await client.echo()).toBe('TorrServer 1.2');
    expect(await client.addTorrent({ link: 'magnet:?xt=urn:btih:abc', title: 'Movie' })).toMatchObject({ hash: 'abc' });
    const addCall = mock.calls.find((call) => call.options.method === 'POST');
    expect(JSON.parse(addCall!.options.body as string)).toMatchObject({
      action: 'add', link: 'magnet:?xt=urn:btih:abc', title: 'Movie', save_to_db: false,
    });
  });

  it('parses the list/get/set settings endpoints', async () => {
    mock.responses.set('http://127.0.0.1:9123/torrents', {
      ok: true, status: 200, data: JSON.stringify([{ hash: 'a' }, { hash: 'b' }]),
    });
    mock.responses.set('http://127.0.0.1:9123/settings', {
      ok: true, status: 200, data: JSON.stringify({ CacheSize: 1024, EnableIPv6: true }),
    });
    expect((await client.listTorrents()).map((t) => t.hash)).toEqual(['a', 'b']);
    expect((await client.getSettings()).EnableIPv6).toBe(true);
    await client.setSettings({ EnableIPv6: false });
    const setCall = mock.calls.filter((call) => call.url.endsWith('/settings')).pop();
    expect(JSON.parse(setCall!.options.body as string)).toEqual({
      action: 'set', sets: { EnableIPv6: false },
    });
  });

  it('builds a 1-based stream URL with the play flag', () => {
    const url = new URL(client.streamUrl('abc', 0));
    expect(url.pathname).toBe('/stream');
    expect(url.searchParams.get('link')).toBe('abc');
    expect(url.searchParams.get('index')).toBe('1');
    expect(url.searchParams.has('play')).toBe(true);
  });
});

describe('bundled TorrServer controller', () => {
  it('starts the native engine, waits for echo and applies tuned settings', async () => {
    mock.responses.set('http://127.0.0.1:9123/echo', { ok: true, status: 200, data: 'ok' });
    mock.responses.set('http://127.0.0.1:9123/settings', {
      ok: true, status: 200, data: JSON.stringify({ CacheSize: 1, EnableIPv6: true, TMDBSettings: { APIKey: 'k' } }),
    });
    mock.responses.set('http://127.0.0.1:9123/shutdown', { ok: true, status: 200, data: '' });

    expect(await torrServerController.ensureStarted()).toBe(true);
    expect(mock.plugin.start).toHaveBeenCalledTimes(1);
    expect(torrServerController.host).toBe('http://127.0.0.1:9123');
    expect(torrServerController.client()).not.toBeNull();

    const setCall = mock.calls.find((call) => {
      if (!call.url.endsWith('/settings')) return false;
      const body = JSON.parse(call.options.body as string);
      return body.action === 'set';
    });
    const sets = JSON.parse(setCall!.options.body as string).sets;
    expect(sets.EnableIPv6).toBe(false);
    expect(sets.CacheSize).toBe(256 * 1024 * 1024);
    expect(sets.TMDBSettings).toEqual({ APIKey: 'k' });
  });

  it('appends the public tracker list to a magnet link', async () => {
    mock.responses.set('http://127.0.0.1:9123/echo', { ok: true, status: 200, data: 'ok' });
    mock.responses.set('http://127.0.0.1:9123/settings', { ok: true, status: 200, data: '{}' });
    mock.responses.set('https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt', {
      ok: true,
      status: 200,
      data: [
        'udp://tracker.one:1337/announce',
        'udp://tracker.two:1337/announce',
        'udp://tracker.three:1337/announce',
        'udp://tracker.four:1337/announce',
        'udp://tracker.five:1337/announce',
      ].join('\n'),
    });
    await torrServerController.ensureStarted();
    const magnet = await torrServerController.augmentMagnet('magnet:?xt=urn:btih:abc', {
      title: 'A Movie', extraTrackers: ['udp://from-addon:6969/announce'],
    });
    expect(magnet).toContain('urn:btih:abc');
    expect(magnet).toContain('dn=A%20Movie');
    expect(magnet).toContain('tr=udp%3A%2F%2Ffrom-addon');
    expect(magnet).toContain('tr=udp%3A%2F%2Ftracker.one');
    expect(magnet).toContain('tr=udp%3A%2F%2Ftracker.two');
    expect(FALLBACK_TRACKERS.length).toBeGreaterThan(5);
  });

  it('stops the native engine and clears the host', async () => {
    mock.responses.set('http://127.0.0.1:9123/echo', { ok: true, status: 200, data: 'ok' });
    mock.responses.set('http://127.0.0.1:9123/settings', { ok: true, status: 200, data: '{}' });
    await torrServerController.ensureStarted();
    await torrServerController.stop();
    expect(mock.plugin.stop).toHaveBeenCalled();
    expect(torrServerController.running).toBe(false);
    expect(torrServerController.client()).toBeNull();
  });
});
