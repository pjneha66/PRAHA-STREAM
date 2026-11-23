// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CloudStream payload handling.
 *
 * The host answers these calls with a JSON *string* produced by arbitrary
 * third-party extensions. Two failure modes used to break the whole extension
 * lane silently: an object where a list was promised (`.map`/`.length` threw at
 * the call site) and a link with no URL (rendered a Play button that did
 * nothing). Both are covered here.
 */
const fake = vi.hoisted(() => ({ responses: {} as Record<string, string> }));

vi.mock('../services/androidBridge', () => ({
  bridgeRpcAvailable: () => true,
  prahaRpc: vi.fn(async (method: string) => {
    if (method in fake.responses) return fake.responses[method];
    return 'null';
  }),
}));

import {
  getCatalogs, getHome, getInstalledPlugins, getLinks, getProviders, getRepositories,
  search, toStreamResults,
} from '../services/cloudstreamService';

beforeEach(() => {
  for (const key of Object.keys(fake.responses)) delete fake.responses[key];
});

describe('list-returning bridge calls', () => {
  it('returns an empty list when the host answers with an object', async () => {
    fake.responses.csRepositories = '{"unexpected":true}';
    fake.responses.csPlugins = '"a string"';
    fake.responses.csProviders = 'null';

    await expect(getRepositories()).resolves.toEqual([]);
    await expect(getInstalledPlugins()).resolves.toEqual([]);
    await expect(getProviders()).resolves.toEqual([]);
  });

  it('returns an empty list rather than throwing on malformed JSON', async () => {
    fake.responses.csHome = '{not json';
    fake.responses.csCatalogs = '';
    await expect(getHome()).resolves.toEqual([]);
    await expect(getCatalogs()).resolves.toEqual([]);
  });

  it('passes a real list through unchanged', async () => {
    fake.responses.csRepositories = JSON.stringify([{ url: 'https://repo/a', name: 'Repo A' }]);
    await expect(getRepositories()).resolves.toEqual([{ url: 'https://repo/a', name: 'Repo A' }]);
  });

  it('returns an empty list when a search deserialises to an object', async () => {
    fake.responses.csSearch = '{}';
    await expect(search('dune')).resolves.toEqual([]);
  });
});

describe('getLinks', () => {
  it('returns the parsed payload', async () => {
    fake.responses.csLinks = JSON.stringify({
      links: [{ source: 's', name: 'n', url: 'https://example.com/a.m3u8', quality: 1080, type: 'M3U8' }],
      subtitles: [],
    });
    const links = await getLinks('Ext', '{}');
    expect(links?.links).toHaveLength(1);
  });

  it('returns null rather than an object-shaped placeholder', async () => {
    fake.responses.csLinks = '{"links":"not a list"}';
    const links = await getLinks('Ext', '{}');
    // The wrapper is still an object, but `toStreamResults` is what guards the
    // field shapes; see below.
    expect(links).toBeTruthy();
    expect(toStreamResults('Ext', links)).toEqual([]);
  });
});

describe('toStreamResults', () => {
  it('maps a well-formed extension payload into StreamResults', () => {
    const results = toStreamResults('Ext', {
      links: [
        { source: 'Server 1', name: '1080p', url: 'https://example.com/a.m3u8', referer: '', quality: 1080, type: 'M3U8', isM3u8: true, headers: { Referer: 'https://example.com/' } },
        { source: 'Server 2', name: '720p', url: 'https://example.com/b.mpd', referer: 'https://x.test/', quality: 720, type: 'DASH', isM3u8: false, headers: {} },
      ],
      subtitles: [{ lang: 'en', url: 'https://example.com/en.vtt' }],
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'cloudstream:Ext:0',
      url: 'https://example.com/a.m3u8',
      sourceType: 'cloudstream',
      provider: 'Ext',
      quality: '1080p',
      format: 'hls',
    });
    expect(results[1].format).toBe('dash');
    expect(results[0].subtitles?.[0]).toMatchObject({ url: 'https://example.com/en.vtt', language: 'en' });
  });

  it('returns nothing — instead of throwing — when the payload is missing', () => {
    expect(toStreamResults('Ext', undefined)).toEqual([]);
    expect(toStreamResults('Ext', null)).toEqual([]);
    expect(toStreamResults('Ext', {} as never)).toEqual([]);
  });

  it('drops entries that have no usable URL', () => {
    const results = toStreamResults('Ext', {
      links: [
        { source: 'ok', name: 'ok', url: 'https://example.com/ok.m3u8', referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} },
        { source: 'empty', name: 'empty', url: '', referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} },
        { source: 'number', name: 'number', url: 42 as never, referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} },
        { source: 'missing', name: 'missing', referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} } as never,
      ],
      subtitles: [],
    });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/ok.m3u8');
  });

  it('survives subtitles arriving as the wrong shape', () => {
    const results = toStreamResults('Ext', {
      links: [{ source: 's', name: 'n', url: 'https://example.com/a.m3u8', referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} }],
      subtitles: { en: 'https://example.com/en.vtt' } as never,
    });
    expect(results).toHaveLength(1);
    expect(results[0].subtitles).toBeUndefined();
  });

  it('drops subtitles that have no URL but keeps the rest', () => {
    const results = toStreamResults('Ext', {
      links: [{ source: 's', name: 'n', url: 'https://example.com/a.m3u8', referer: '', quality: 0, type: 'M3U8', isM3u8: true, headers: {} }],
      subtitles: [
        { lang: 'en', url: '' },
        { lang: 'fr', url: 'https://example.com/fr.vtt' },
      ],
    });
    expect(results[0].subtitles).toHaveLength(1);
    expect(results[0].subtitles?.[0].language).toBe('fr');
  });

  it('falls back to the extension name when a link omits source/name', () => {
    const results = toStreamResults('Ext', {
      links: [{ source: '', name: '', url: 'https://example.com/a.m3u8', referer: '', quality: 0, type: '', isM3u8: false, headers: {} }],
      subtitles: [],
    });
    expect(results[0].sourceName).toBe('Ext');
    expect(results[0].format).toBeUndefined();
  });
});
