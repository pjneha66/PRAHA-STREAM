// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  composeScraperScript,
  createScraperAdapter,
  scraperRequire,
  SCRAPER_MODULES,
} from '../services/scraperAdapter';

/**
 * The adapter is the seam between the two plugin contracts: a scraper from a
 * scraper list answers `getStreams(tmdbId, mediaType, season, episode)`, while
 * the engine asks `getStreams(query)`. Everything here drives the adapter the
 * way the sandbox does — `load` with a runner that does what the scraper's file
 * body does — so a change in either contract shows up as a failure.
 *
 * Nothing here evaluates source text: the adapter only ever calls functions, and
 * these tests define them directly, which is the same thing the sandbox ends up
 * with.
 */

type Runner = (module: any, exports: any, require: unknown) => void;

/** Loads a scraper whose file body is `body`, in a scope of its own. */
function load(body: Runner, scope: Record<string, any> = {}) {
  const adapter = createScraperAdapter(scope);
  adapter.load('test-scraper', body);
  return { scope, adapter };
}

/** A scraper that records what it was asked and answers with `answer`. */
function recording(answer: unknown = []) {
  const calls: unknown[][] = [];
  const body: Runner = (module) => {
    module.exports.getStreams = (...args: unknown[]) => {
      calls.push(args);
      return answer;
    };
  };
  return { calls, body };
}

describe('createScraperAdapter — asking a scraper', () => {
  it('passes a film\'s id and kind, and a show\'s season and episode', async () => {
    const { calls, body } = recording();
    const { adapter } = load(body);
    await adapter.getStreams({ tmdbId: 550, isTv: false });
    await adapter.getStreams({ tmdbId: 1399, isTv: true, season: 2, episode: 5 });
    expect(calls[0]).toEqual(['550', 'movie', undefined, undefined]);
    expect(calls[1]).toEqual(['1399', 'tv', 2, 5]);
  });

  it('answers nothing for a title with no id', async () => {
    const { calls, body } = recording();
    const { adapter } = load(body);
    expect(await adapter.getStreams({ tmdbId: null, isTv: false })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('asks one of its own titles by its own id', async () => {
    const { calls, body } = recording();
    const { adapter } = load(body);
    await adapter.getStreams({ tmdbId: 999, ownId: 'the-site-id', isTv: false });
    expect(calls[0]).toEqual(['the-site-id', 'movie', undefined, undefined]);
  });
});

describe('createScraperAdapter — translating the answer', () => {
  const answer = [
    { name: 'Fast', title: '1080p', url: 'https://cdn.example/a.m3u8', quality: '1080p', type: 'hls', headers: { Referer: 'https://site.example/' } },
    { name: 'Slow', url: 'https://cdn.example/b.mp4', size: '1.4 GB' },
    { name: 'NoUrl' },
    { url: 42 },
  ];

  it('turns the scraper\'s fields into the plugin contract\'s', async () => {
    const { adapter } = load(recording(answer).body);
    const streams = await adapter.getStreams({ tmdbId: 550, isTv: false }) as Record<string, unknown>[];
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({
      url: 'https://cdn.example/a.m3u8',
      type: 'hls',
      quality: '1080p',
      server: 'Fast',
      label: '1080p',
      headers: { Referer: 'https://site.example/' },
    });
    // `size` becomes part of the label, as VyseTV's adapter does.
    expect(streams[1]).toMatchObject({ server: 'Slow', label: '1.4 GB' });
  });

  it('reads headers from behaviorHints when the entry has none', async () => {
    const { adapter } = load(recording([{
      url: 'https://cdn.example/x.mp4',
      behaviorHints: { proxyHeaders: { request: { 'User-Agent': 'X' } } },
    }]).body);
    const streams = await adapter.getStreams({ tmdbId: 1, isTv: false }) as Record<string, unknown>[];
    expect(streams[0].headers).toEqual({ 'User-Agent': 'X' });
  });

  it('answers nothing rather than throwing for a non-list answer', async () => {
    const { adapter } = load(recording('nope').body);
    expect(await adapter.getStreams({ tmdbId: 1, isTv: false })).toEqual([]);
  });
});

describe('createScraperAdapter — the ways a scraper exports itself', () => {
  it('takes the function as the export itself', async () => {
    const { adapter } = load((module) => {
      module.exports = async (id: string, type: string) => [{ url: 'https://cdn.example/one.mp4', name: id + type }];
    });
    const streams = await adapter.getStreams({ tmdbId: 7, isTv: true }) as Record<string, unknown>[];
    expect(streams[0].server).toBe('7tv');
  });

  it('takes a global getStreams an older scraper leaves behind', async () => {
    // `scope` is the sandbox's global object: a top-level `var getStreams = …`
    // in an old scraper's file lands there, which is how it is found.
    const scope: Record<string, any> = {};
    const { adapter } = load((_module, _exports, _require) => {
      scope.getStreams = async (id: string) => [{ url: 'https://cdn.example/global.mp4', name: `G${id}` }];
    }, scope);
    const streams = await adapter.getStreams({ tmdbId: 3, isTv: false }) as Record<string, unknown>[];
    expect(streams[0].server).toBe('G3');
  });

  it('does not mistake a function that was already there for the scraper\'s own', async () => {
    const scope: Record<string, any> = { getStreams: () => 'the old one' };
    const { adapter } = load((module) => { module.exports = {}; }, scope);
    await expect(adapter.getStreams({ tmdbId: 1, isTv: false })).rejects.toThrow(/no getStreams/);
    // The scope's own function is left alone.
    expect(scope.getStreams()).toBe('the old one');
  });

  it('says so when the scraper exports nothing useful', async () => {
    const { adapter } = load((module) => { module.exports.somethingElse = 1; });
    await expect(adapter.getStreams({ tmdbId: 1, isTv: false })).rejects.toThrow(/no getStreams/);
  });
});

describe('createScraperAdapter — catalogs and details', () => {
  it('offers a search both ways scrapers are written', async () => {
    const seen: Record<string, unknown>[] = [];
    const { adapter } = load((module) => {
      module.exports.getCatalog = (q: Record<string, unknown>) => {
        seen.push(q);
        return { metas: [] };
      };
    });
    await adapter.getCatalog({ catalogId: 'popular', type: 'movie', search: 'dune', skip: 40, page: 3 });
    expect(seen[0]).toMatchObject({
      catalogId: 'popular',
      id: 'popular',
      type: 'movie',
      search: 'dune',
      query: 'dune',
      skip: 40,
      page: 3,
      extra: { search: 'dune', skip: 40 },
    });
  });

  it('says so when the scraper has no catalog or no details', async () => {
    const { adapter } = load((module) => { module.exports.getStreams = async () => []; });
    await expect(adapter.getCatalog({})).rejects.toThrow(/no getCatalog/);
    await expect(adapter.getMeta({})).rejects.toThrow(/no getMeta/);
  });

  it('passes a details request through untouched', async () => {
    const { adapter } = load((module) => {
      module.exports.getMeta = async (q: { id: string }) => ({ meta: { id: q.id, name: `From ${q.id}` } });
    });
    expect(await adapter.getMeta({ id: 'abc' })).toEqual({ meta: { id: 'abc', name: 'From abc' } });
  });
});

describe('createScraperAdapter — the sandbox globals', () => {
  it('gives a React Native scraper the globals it may test for', () => {
    const { scope } = load((module) => { module.exports.getStreams = async () => []; });
    expect(scope.global).toBe(scope);
    expect(scope.window).toBe(scope);
    expect(scope.self).toBe(scope);
  });

  it('gives the scraper its id', () => {
    const { scope } = load((module) => { module.exports.getStreams = async () => []; });
    expect(scope.SCRAPER_ID).toBe('test-scraper');
  });
});

describe('scraperRequire — the libraries, and nothing else', () => {
  it('resolves the modules a scraper expects', () => {
    expect(scraperRequire('cheerio')).toBe(SCRAPER_MODULES.cheerio);
    expect(scraperRequire('axios')).toBe(SCRAPER_MODULES.axios);
    expect(scraperRequire('cheerio-without-node-native')).toBe(SCRAPER_MODULES.cheerio);
  });

  it('refuses every other module, including node\'s own', () => {
    for (const name of ['fs', 'child_process', 'http', 'node:fs', '@capacitor/core', 'lodash']) {
      expect(() => scraperRequire(name), name).toThrow(/Cannot find module/);
    }
  });
});

describe('composeScraperScript', () => {
  it('wraps the scraper so its getStreams stays its own, and exposes both entries', () => {
    const script = composeScraperScript('my-id', '1.2.3', 'module.exports.getStreams = async () => [];');
    expect(script).toContain('// @scraper my-id');
    expect(script).toContain('// @scraper-version 1.2.3');
    expect(script).toContain('__scrapers.load("my-id", function (module, exports, require) {');
    expect(script).toContain('var getStreams = __scrapers.getStreams;');
    expect(script).toContain('globalThis.__scraperCatalog');
    expect(script).toContain('globalThis.__scraperMeta');
  });

  it('escapes an id that would otherwise break out of the string', () => {
    const script = composeScraperScript('a"b', '1', '');
    expect(script).toContain('__scrapers.load("a\\"b"');
  });
});
