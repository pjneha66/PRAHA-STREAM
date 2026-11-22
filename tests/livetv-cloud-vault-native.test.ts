// Regression test for the Live TV catalog loader on the Android native path.
//
// On the device the web path is not used: `nativeFetchBytes` calls
// CapacitorHttp with `responseType: 'arraybuffer'`, and the Android plugin
// answers with base64 of the *raw* response stream (see
// `HttpRequestHandler.readData` -> `readStreamAsBase64`). That base64 must
// decode back to the exact gzip bytes before gunzip, or the catalog is lost.
//
// The sibling `livetv-cloud-vault.test.ts` covers the browser path; this file
// pins the native one.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

const token = (...parts: string[]) => parts.join('');

const USER_A = token('n5I', '32OJV', 'fG');
const PASS_A = token('F9x', 'ZTT7', 'qBW');
const USER_B = token('alice', '-fixture');
const PASS_B = token('alpha', '-fixture');

const CATALOG_CSV = [
  `http://117.55.202.58:8080,${USER_A},${PASS_A},"11/16/2027, 02:17",Africa/Abidjan`,
  `https://portal.example.net:25461,${USER_B},${PASS_B},2027-01-01,Europe/London`,
].join('\r\n');

const state = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  data: '' as string,
  status: 200,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  CapacitorHttp: {
    request: vi.fn(async (options: Record<string, unknown>) => {
      state.requests.push(options);
      return { data: state.data, status: state.status, headers: {}, url: String(options.url) };
    }),
  },
}));

async function loadScraper() {
  vi.resetModules();
  const mod = await import('../services/liveTv/network');
  return mod.IptvScraper;
}

describe('Live TV Cloud Vault catalog (Android native path)', () => {
  beforeEach(() => {
    state.requests = [];
    state.status = 200;
    // Exactly what Capacitor's native plugin returns for `arraybuffer`.
    state.data = gzipSync(Buffer.from(CATALOG_CSV, 'utf8')).toString('base64');
  });

  it('requests arraybuffer and decodes base64 back to the original gzip bytes', async () => {
    const page = await (await loadScraper()).scrapeCatalogPage({ maxResults: 50 });

    const request = state.requests[0];
    expect(request.responseType).toBe('arraybuffer');
    expect(request.method).toBe('GET');

    expect(page.portals).toHaveLength(2);
    const byUser = (name: string) => page.portals.find((portal) => portal.username === name);
    expect(byUser(USER_A)?.url).toBe('http://117.55.202.58:8080');
    expect(byUser(USER_A)?.password).toBe(PASS_A);
    expect(byUser(USER_B)?.url).toBe('https://portal.example.net:25461');
  });

  it('survives base64 with the line wrapping Android Base64.DEFAULT produces', async () => {
    // Android wraps base64 at 76 columns with CRLF; a strict decoder would fail.
    const raw = gzipSync(Buffer.from(CATALOG_CSV, 'utf8')).toString('base64');
    state.data = raw.replace(/(.{76})/g, '$1\r\n');

    const page = await (await loadScraper()).scrapeCatalogPage({ maxResults: 50 });

    expect(page.portals).toHaveLength(2);
  });

  it('returns an empty page on a non-2xx native response', async () => {
    state.status = 403;
    state.data = '';

    const page = await (await loadScraper()).scrapeCatalogPage({ maxResults: 50 });

    expect(page.portals).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });
});
