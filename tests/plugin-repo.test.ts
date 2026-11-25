// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  loadPluginRepo,
  parsePluginRepo,
  parsePluginStreams,
  pluginStreamToResult,
  readDescribedCatalogs,
} from '../services/jsPlugins';

/**
 * A repository is whatever a user pasted, so the parser is the boundary: three
 * shapes are accepted, and everything else is refused with a sentence a person
 * can act on. The stream filter is the other boundary — a plugin's output goes
 * to the player, and a `javascript:` or `file:` link must not.
 */

const REPO = 'https://raw.example/owner/project/repo.json';
const LIST = 'https://raw.example/owner/list/manifest.json';
const VEGA = 'https://raw.example/owner/vega/manifest.json';

describe('parsePluginRepo — a repo.json', () => {
  it('reads its plugins, resolving each script against the file', () => {
    const repo = parsePluginRepo(JSON.stringify({
      name: 'My Repo',
      plugins: [
        { id: 'alpha', name: 'Alpha', url: 'alpha.js', version: '1.2', types: ['movie'] },
        { name: 'Beta', url: 'https://cdn.example/beta.js' },
      ],
    }), REPO);
    expect(repo.kind).toBe('repo');
    expect(repo.name).toBe('My Repo');
    expect(repo.plugins).toHaveLength(2);
    expect(repo.plugins[0]).toMatchObject({
      id: 'alpha', name: 'Alpha', url: 'https://raw.example/owner/project/alpha.js', version: '1.2', types: ['movie'],
    });
    // No declared id: the file's own name, without the extension.
    expect(repo.plugins[1].id).toBe('beta');
    expect(repo.plugins[1].url).toBe('https://cdn.example/beta.js');
    // Neither declared types: both kinds.
    expect(repo.plugins[1].types).toEqual(['movie', 'tv']);
  });

  it('drops a plugin with no usable script rather than failing the file', () => {
    const repo = parsePluginRepo(JSON.stringify({
      plugins: [
        { id: 'ok', url: 'ok.js' },
        { id: 'nourl' },
        { id: 'ftp', url: 'ftp://example.com/x.js' },
        { id: 'bad id!', url: 'x.js' },
        null,
        'text',
      ],
    }), REPO);
    expect(repo.plugins.map((plugin) => plugin.id)).toEqual(['ok']);
  });

  it('keeps one plugin per id', () => {
    const repo = parsePluginRepo(JSON.stringify({
      plugins: [
        { id: 'same', url: 'a.js' },
        { id: 'same', url: 'b.js' },
      ],
    }), REPO);
    expect(repo.plugins).toHaveLength(1);
    expect(repo.plugins[0].url).toBe('https://raw.example/owner/project/a.js');
  });

  it('reads a comic plugin as one, so it is never asked for streams', () => {
    const repo = parsePluginRepo(JSON.stringify({
      plugins: [{ id: 'manga', url: 'manga.js', supportedTypes: ['manga'] }],
    }), REPO);
    expect(repo.plugins[0].comic).toBe(true);
  });

  it('reads its catalogs, including Stremio-style extras', () => {
    const repo = parsePluginRepo(JSON.stringify({
      plugins: [{
        id: 'p',
        url: 'p.js',
        catalogs: [
          { id: 'popular', name: 'Popular', type: 'movie' },
          {
            id: 'search',
            name: 'Search',
            type: 'series',
            extra: [{ name: 'search', isRequired: true }, { name: 'genre', options: ['Action', 'Drama'] }],
          },
        ],
      }],
    }), REPO);
    expect(repo.plugins[0].catalogs).toHaveLength(2);
    expect(repo.plugins[0].catalogs[1]).toMatchObject({
      id: 'search', type: 'series', search: true, searchOnly: true,
      genres: ['Action', 'Drama'], genreRequired: false,
    });
  });
});

describe('parsePluginRepo — a scraper list', () => {
  it('reads its scrapers as plugins, with their declared resources', () => {
    const repo = parsePluginRepo(JSON.stringify({
      name: 'Scrapers',
      scrapers: [
        { id: 'one', name: 'One', filename: 'one.js', supportedTypes: ['movie', 'tv'], resources: [{ name: 'stream' }, { name: 'meta' }] },
        { id: 'off', filename: 'off.js', enabled: false },
        { id: 'two', name: 'Two', filename: 'two.js' },
      ],
    }), LIST);
    expect(repo.kind).toBe('scrapers');
    expect(repo.plugins.map((plugin) => plugin.id)).toEqual(['one', 'two']);
    expect(repo.plugins[0]).toMatchObject({
      scraper: true, vega: false, details: true, url: 'https://raw.example/owner/list/one.js',
    });
    // Only an explicit `false` turns a scraper off.
    expect(repo.plugins[1].details).toBe(false);
    expect(repo.plugins[1].types).toEqual(['movie', 'tv']);
  });
});

describe('parsePluginRepo — a Vega manifest', () => {
  it('reads each provider as a folder under dist/', () => {
    const repo = parsePluginRepo(JSON.stringify([
      { value: 'netmirror', display_name: 'NetMirror', type: 'movie', supportedTypes: ['movie'] },
      { value: 'torrentio' },
      { value: 'youtube' },
      { value: 'off', disabled: true },
      { value: 'bad value!' },
      { value: 'show', name: 'Shows', type: 'series' },
    ]), VEGA);
    expect(repo.kind).toBe('vega');
    expect(repo.plugins.map((plugin) => plugin.id)).toEqual(['vega-netmirror', 'vega-show']);
    // The folder, not a file — the runtime derives the provider's `value` from it.
    expect(repo.plugins[0].url).toBe('https://raw.example/owner/vega/dist/netmirror');
    expect(repo.plugins[0].name).toBe('NetMirror');
    expect(repo.plugins[1].name).toBe('Shows');
    expect(repo.plugins[1].comic).toBe(false);
  });

  it('marks a comic provider as one', () => {
    const repo = parsePluginRepo(JSON.stringify([{ value: 'comics', type: 'comic' }]), VEGA);
    expect(repo.plugins[0].comic).toBe(true);
  });
});

describe('parsePluginRepo — what is refused', () => {
  it('says the link is not JSON, in words a user can act on', () => {
    expect(() => parsePluginRepo('<!doctype html><html></html>', REPO))
      .toThrow(/not a JSON file/i);
  });

  it('says a JSON file with no plugin list is not a repository', () => {
    expect(() => parsePluginRepo('{"hello":"world"}', REPO)).toThrow(/no "plugins" list/i);
    expect(() => parsePluginRepo('"a string"', REPO)).toThrow(/not a plugin repository/i);
    expect(() => parsePluginRepo('null', REPO)).toThrow(/not a plugin repository/i);
  });
});

describe('loadPluginRepo', () => {
  it('refuses a private address before fetching it', async () => {
    let asked = false;
    await expect(loadPluginRepo('http://192.168.1.1/repo.json', async () => {
      asked = true;
      return '{}';
    })).rejects.toThrow(/your own network/i);
    expect(asked).toBe(false);
  });

  it('refuses a repository file too large to be a list', async () => {
    const huge = 'x'.repeat(512 * 1024 * 4 + 1);
    await expect(loadPluginRepo(REPO, async () => huge)).rejects.toThrow(/too large/i);
  });

  it('parses what the fetch returned', async () => {
    const repo = await loadPluginRepo(REPO, async () => JSON.stringify({ name: 'R', plugins: [{ id: 'p', url: 'p.js' }] }));
    expect(repo.plugins[0].id).toBe('p');
  });
});

describe('parsePluginStreams — a plugin\'s answer', () => {
  it('keeps the links a player can open', () => {
    const streams = parsePluginStreams([
      { url: 'https://cdn.example/a.m3u8', type: 'hls', quality: '1080p', server: 'A' },
      { url: 'http://cdn.example/b.mp4', headers: { Referer: 'https://site.example/' } },
    ]);
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({ type: 'hls', quality: '1080p', server: 'A' });
    expect(streams[1].headers).toEqual({ Referer: 'https://site.example/' });
  });

  it('drops anything that is not an http(s) link', () => {
    const streams = parsePluginStreams([
      { url: 'javascript:alert(1)' },
      { url: 'file:///etc/passwd' },
      { url: 'data:text/html,<script>x</script>' },
      { url: 'magnet:?xt=urn:btih:abc' },
      { url: 42 },
      { noUrl: true },
      null,
      'text',
      { url: 'https://ok.example/x.mp4' },
    ]);
    expect(streams.map((stream) => stream.url)).toEqual(['https://ok.example/x.mp4']);
  });

  it('fills in the labels the source list needs', () => {
    const streams = parsePluginStreams([{ url: 'https://ok.example/x.mp4' }]);
    expect(streams[0]).toMatchObject({ quality: 'Auto', server: 'Server', headers: {} });
  });

  it('answers nothing at all for a non-list', () => {
    for (const value of [null, undefined, 'text', 42, { url: 'https://x.example/' }]) {
      expect(parsePluginStreams(value)).toEqual([]);
    }
  });

  it('keeps only string header values', () => {
    const streams = parsePluginStreams([{ url: 'https://ok.example/x', headers: { A: 'one', B: 2, C: null } }]);
    expect(streams[0].headers).toEqual({ A: 'one', B: '2' });
  });
});

describe('pluginStreamToResult', () => {
  const plugin = { id: 'alpha', name: 'Alpha' } as never;

  it('names the source and the quality, and reads the referer', () => {
    const result = pluginStreamToResult({
      url: 'https://ok.example/x.m3u8',
      type: 'hls',
      quality: '720p',
      server: 'Fast',
      audio: 'Hindi',
      headers: { Referer: 'https://site.example/' },
    }, plugin, 3);
    expect(result).toMatchObject({
      id: 'plugin:alpha:3',
      sourceType: 'scraper',
      sourceName: 'Alpha · Fast',
      quality: '720p',
      format: 'hls',
      language: 'Hindi',
      referer: 'https://site.example/',
    });
    expect(result.title).toBe('720p · Fast · Hindi');
  });

  it('carries no format for a plain file', () => {
    const result = pluginStreamToResult({ url: 'https://ok.example/x.mp4', quality: 'Auto', server: 'S', headers: {} }, plugin, 0);
    expect(result.format).toBeUndefined();
    expect(result.referer).toBeUndefined();
  });
});

describe('readDescribedCatalogs — a Vega provider\'s own lists', () => {
  it('reads its lists, a genre picker and a search, guessing each kind from its title', () => {
    const catalogs = readDescribedCatalogs({
      catalogs: [
        { title: 'Latest Movies', filter: 'latest' },
        { title: 'Popular Series', filter: 'series' },
        { title: 'Anime', filter: 'anime' },
      ],
      genres: [{ title: 'Action', filter: 'action' }],
      search: true,
    }, false);
    expect(catalogs.map((catalog) => catalog.name)).toEqual(['Latest Movies', 'Popular Series', 'Anime', 'Genres', 'Search']);
    expect(catalogs.map((catalog) => catalog.type)).toEqual(['movie', 'series', 'series', 'movie', 'movie']);
    expect(catalogs[1].filter).toBe('series');
    expect(catalogs[3]).toMatchObject({ genreRequired: true });
    expect(catalogs[4]).toMatchObject({ search: true, searchOnly: true });
  });

  it('makes every list a comic\'s when the provider is one', () => {
    const catalogs = readDescribedCatalogs({ catalogs: [{ title: 'Latest Movies' }] }, true);
    expect(catalogs[0].type).toBe('comic');
  });

  it('answers nothing for a provider that described nothing', () => {
    expect(readDescribedCatalogs(null, false)).toEqual([]);
    expect(readDescribedCatalogs({}, false)).toEqual([]);
  });
});
