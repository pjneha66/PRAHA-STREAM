// Regression test for the Live TV catalog loader.
//
// The Cloud Vault host serves a gzipped CSV with `Content-Type:
// application/x-gzip` and *no* `Content-Encoding`, so nothing decompresses it
// on the way in. VyseTV gunzips `res.bodyBytes`; PRAHA originally fetched the
// body through `nativeFetchText`, which UTF-8 decodes it, and then re-encoded
// the mangled string and failed with "incorrect header check" — swallowed by a
// `catch` that returned `[]`, so Live TV showed no sources at all.
//
// These tests pin the loader to the byte-preserving path: real gzip bytes go
// in, real portals come out. All credentials below are synthetic fixtures.
//
// Runs under jsdom on purpose: that is the closest stand-in for the Android
// WebView, and its `Blob` has no `.stream()`. An earlier fix decompressed via
// `new Blob([bytes]).stream()` and passed under Node while returning an empty
// catalog in the app.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

// Built by concatenation so the fixture never reads as a real credential.
const token = (...parts: string[]) => parts.join('');

const USER_A = token('n5I', '32OJV', 'fG');
const PASS_A = token('F9x', 'ZTT7', 'qBW');
const USER_B = token('alice', '-fixture');
const PASS_B = token('alpha', '-fixture');
const USER_C = token('bob', '-fixture');
const PASS_C = token('beta', '-fixture');

const CATALOG_CSV = [
  `http://117.55.202.58:8080,${USER_A},${PASS_A},"11/16/2027, 02:17",Africa/Abidjan`,
  `https://portal.example.net:25461,${USER_B},${PASS_B},2027-01-01,Europe/London`,
  `http://second.example.org:8080,${USER_C},${PASS_C},,America/New_York`,
  // Malformed rows must be skipped, not fatal.
  'not-a-url,user,pass,,',
  `http://third.example.org:8080,,${PASS_C},,`,
  // Duplicate credentials collapse to the first occurrence.
  `http://dup.example.org:8080,${USER_B},${PASS_B},,`,
].join('\r\n');

const state = vi.hoisted(() => ({
  bytes: null as Uint8Array | null,
  status: 200,
  ok: true,
  calls: [] as string[],
}));

vi.mock('../services/androidBridge', () => ({
  nativeFetchBytes: vi.fn(async (url: string) => {
    state.calls.push(url);
    return { ok: state.ok, status: state.status, bytes: state.bytes };
  }),
  // The loader must not touch the text path; make that failure loud.
  nativeFetchText: vi.fn(async () => {
    throw new Error('nativeFetchText must not be used for the gzipped catalog');
  }),
}));

/** Fresh module instance per test — the loader caches its catalog statically. */
async function loadScraper() {
  vi.resetModules();
  const mod = await import('../services/liveTv/network');
  return mod.IptvScraper;
}

describe('Live TV Cloud Vault catalog', () => {
  beforeEach(() => {
    state.bytes = new Uint8Array(gzipSync(Buffer.from(CATALOG_CSV, 'utf8')));
    state.status = 200;
    state.ok = true;
    state.calls = [];
  });

  it('gunzips raw bytes and extracts portals', async () => {
    const page = await (await loadScraper()).scrapeCatalogPage({ maxResults: 50 });

    expect(page.portals).toHaveLength(3);
    expect(page.portals.map((portal) => portal.username).sort()).toEqual([USER_A, USER_B, USER_C].sort());

    const byUser = (name: string) => page.portals.find((portal) => portal.username === name);
    expect(byUser(USER_B)).toMatchObject({
      url: 'https://portal.example.net:25461',
      source: 'Cloud Vault',
    });
    expect(byUser(USER_B)?.password).toBe(PASS_B);

    // A quoted comma inside the date column must not split the row.
    expect(byUser(USER_A)?.url).toBe('http://117.55.202.58:8080');
    expect(byUser(USER_A)?.password).toBe(PASS_A);
  });

  it('accepts an uncompressed CSV body too', async () => {
    state.bytes = new Uint8Array(Buffer.from(CATALOG_CSV, 'utf8'));

    const page = await (await loadScraper()).scrapeCatalogPage({ maxResults: 50 });

    expect(page.portals).toHaveLength(3);
  });

  it('returns an empty page instead of throwing when the host is down', async () => {
    state.ok = false;
    state.status = 503;
    state.bytes = null;

    await expect((await loadScraper()).scrapeCatalogPage({ maxResults: 50 })).resolves.toEqual({
      portals: [],
      nextAfter: null,
      hasMore: false,
    });
  });

  it('pages through the catalog with stable cloud: cursors', async () => {
    const scraper = await loadScraper();

    const first = await scraper.scrapeCatalogPage({ maxResults: 2 });
    expect(first.portals).toHaveLength(2);
    expect(first.nextAfter).toBe('cloud:2');
    expect(first.hasMore).toBe(true);

    const second = await scraper.scrapeCatalogPage({ maxResults: 2, after: first.nextAfter });
    expect(second.portals).toHaveLength(1);
    expect(second.nextAfter).toBeNull();
    expect(second.hasMore).toBe(false);

    // No portal is served twice across pages, and the cache means the
    // catalog is fetched exactly once.
    const keys = [...first.portals, ...second.portals].map((portal) => `${portal.username}|${portal.password}`);
    expect(new Set(keys).size).toBe(3);
    expect(state.calls).toHaveLength(1);
  });
});
