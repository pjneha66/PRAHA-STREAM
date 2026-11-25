// Regression test for the Live TV stream health checker.
//
// VyseTV sniffs the first bytes of a stream for container signatures
// (`iptv_network.dart` `_isAlive` / `_hasVideoSignature`). PRAHA used to run
// that check on a UTF-8 *string* from `nativeFetchText`, so MPEG-TS sync bytes
// and Matroska magic were unreadable and real streams were judged dead. These
// tests pin the check to raw bytes.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  bytes: null as Uint8Array | null,
  status: 200,
  ok: true,
  headers: {} as Record<string, string>,
}));

vi.mock('../services/androidBridge', () => ({
  nativeFetchBytes: vi.fn(async () => ({
    ok: state.ok,
    status: state.status,
    bytes: state.bytes,
    headers: state.headers,
  })),
  nativeFetchText: vi.fn(async () => {
    throw new Error('the health check must read bytes, not text');
  }),
}));

async function loadChecker() {
  vi.resetModules();
  const mod = await import('../services/liveTv/network');
  return mod.IptvAliveChecker;
}

/** MPEG-TS: 0x47 sync byte every 188 bytes. */
function mpegTs(packets: number): Uint8Array {
  const buf = new Uint8Array(packets * 188);
  for (let i = 0; i < packets; i++) buf[i * 188] = 0x47;
  return buf;
}

function run(url: string, checker: Awaited<ReturnType<typeof loadChecker>>) {
  const results: Array<[string, boolean]> = [];
  return checker
    .launchCheck({ streams: [[url, url]], onResult: (id, alive) => { results.push([id, alive]); } })
    .then(() => results[0]?.[1]);
}

describe('Live TV stream health check', () => {
  beforeEach(() => {
    state.status = 206;
    state.ok = true;
    state.bytes = null;
    state.headers = {};
  });

  it('accepts an MPEG-TS stream from its sync bytes', async () => {
    state.bytes = mpegTs(40);
    state.headers = { 'content-type': 'video/mp2t' };

    expect(await run('http://stream.example.com/live/1.ts', await loadChecker())).toBe(true);
  });

  it('accepts a range response with a length for the returned bytes', async () => {
    state.bytes = mpegTs(40);
    state.headers = { 'content-type': 'video/mp2t', 'content-length': String(state.bytes.length) };
    expect(await run('http://stream.example.com/live/1.ts', await loadChecker())).toBe(true);
  });

  it('accepts a Matroska stream from its magic number', async () => {
    const buf = new Uint8Array(32 * 1024);
    buf.set([0x1a, 0x45, 0xdf, 0xa3], 0);

    state.bytes = buf;
    state.headers = { 'content-type': 'video/x-matroska' };

    expect(await run('http://stream.example.com/movie.mkv', await loadChecker())).toBe(true);
  });

  it('accepts an HLS playlist only when it carries #EXTM3U', async () => {
    const checker = await loadChecker();

    state.bytes = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n');
    state.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    expect(await run('http://cdn.example.com/live/index.m3u8', checker)).toBe(true);

    state.bytes = new TextEncoder().encode('<html>not a playlist</html>');
    state.headers = { 'content-type': 'application/vnd.apple.mpegurl' };
    expect(await run('http://cdn.example.com/live/index.m3u8', checker)).toBe(false);
  });

  it('rejects an HTML error page', async () => {
    state.bytes = new TextEncoder().encode('<html><body>404</body></html>');
    state.headers = { 'content-type': 'text/html; charset=utf-8' };

    expect(await run('http://dead.example.com/live/1.ts', await loadChecker())).toBe(false);
  });

  it('rejects a short stub body with a bounded content-length', async () => {
    state.bytes = new Uint8Array(64);
    state.headers = { 'content-type': 'video/mp2t', 'content-length': '64' };

    expect(await run('http://dead.example.com/live/2.ts', await loadChecker())).toBe(false);
  });

  it('rejects a non-2xx response', async () => {
    state.ok = false;
    state.status = 404;
    state.bytes = mpegTs(40);

    expect(await run('http://dead.example.com/live/3.ts', await loadChecker())).toBe(false);
  });
});
