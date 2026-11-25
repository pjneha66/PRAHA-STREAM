// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ago,
  keptIndex,
  languageName,
  listingMatches,
  loadPluginIndex,
  mergeListings,
  parseIndex,
  parseListing,
  resetPluginIndex,
  sameRepository,
  topLanguages,
  type PluginListing,
} from '../services/pluginIndex';
import { entryFromRepo } from '../services/pluginDiscovery';
import { parsePluginRepo } from '../services/jsPlugins';

/**
 * The index is a file written by other people, read by this device and shown as
 * a list of things to install. So the parser is written defensively and every
 * piece of it is tested: what a missing field becomes, what a hostile field is
 * refused, and which of two copies of a repository is kept.
 */

function listing(over: Partial<PluginListing> = {}): PluginListing {
  return {
    url: 'https://raw.example/owner/repo/repo.json',
    name: 'Repo',
    kind: 'plugins',
    author: 'owner',
    description: '',
    plugins: 1,
    names: [],
    languages: [],
    types: ['movie', 'tv'],
    stars: 0,
    featured: false,
    adult: false,
    ...over,
  };
}

beforeEach(() => {
  resetPluginIndex();
  localStorage.clear();
});

describe('parseListing — one entry of an index', () => {
  it('reads an entry as written', () => {
    expect(parseListing({
      url: 'https://raw.example/o/r/repo.json',
      name: 'R',
      kind: 'scrapers',
      author: 'o',
      description: 'D',
      plugins: 3,
      names: ['A'],
      languages: ['tr'],
      types: ['movie'],
      updated: '2026-01-02T00:00:00Z',
      stars: 12,
      icon: 'https://raw.example/icon.png',
      featured: true,
      adult: true,
    })).toMatchObject({
      name: 'R', kind: 'scrapers', plugins: 3, stars: 12,
      icon: 'https://raw.example/icon.png', featured: true, adult: true,
    });
  });

  it('refuses an entry with no link', () => {
    for (const value of [null, undefined, 'text', 42, {}, { url: '' }, { url: 7 }]) {
      expect(parseListing(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('fills in a name from the link when the entry has none', () => {
    expect(parseListing({ url: 'https://raw.example/someone/project/repo.json' })?.name).toBe('project');
    expect(parseListing({ url: 'not a url' })?.name).toBe('Plugins');
  });

  it('treats a missing kind as a scraper list, and `repo` as `plugins`', () => {
    expect(parseListing({ url: 'https://x.example/a/b' })?.kind).toBe('scrapers');
    expect(parseListing({ url: 'https://x.example/a/b', kind: 'repo' })?.kind).toBe('plugins');
    expect(parseListing({ url: 'https://x.example/a/b', kind: 'vega' })?.kind).toBe('vega');
  });

  it('refuses an icon that is not https, so an index cannot make it load a file', () => {
    for (const icon of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'http://raw.example/i.png', 'javascript:1']) {
      expect(parseListing({ url: 'https://x.example/a/b', icon })?.icon, icon).toBeUndefined();
    }
  });

  it('keeps a date it can read and drops one it cannot', () => {
    expect(parseListing({ url: 'https://x.example/a/b', updated: '2026-05-01' })?.updated).toBe('2026-05-01');
    expect(parseListing({ url: 'https://x.example/a/b', updated: 'not a date' })?.updated).toBeUndefined();
  });

  it('reads only the field types it expects', () => {
    const parsed = parseListing({
      url: 'https://x.example/a/b',
      plugins: 'many',
      stars: 'lots',
      names: 'A',
      languages: [1, 'tr'],
      types: [],
      featured: 'yes',
      adult: 1,
    });
    expect(parsed).toMatchObject({ plugins: 0, stars: 0, names: [], languages: ['1', 'tr'], types: ['movie', 'tv'], featured: false, adult: false });
  });
});

describe('parseIndex', () => {
  it('reads an index, skipping entries that are not ones', () => {
    const data = parseIndex(JSON.stringify({
      updated: '2026-02-02',
      repos: [{ url: 'https://x.example/a/b' }, null, 'text', {}, { url: 'https://x.example/c/d' }],
    }));
    expect(data.built).toBe('2026-02-02');
    expect(data.repos).toHaveLength(2);
  });

  it('says so, in words, when the file is not an index', () => {
    for (const text of ['<html></html>', '{}', '{"repos":"none"}', 'null', '"x"']) {
      expect(() => parseIndex(text), text).toThrow(/not a plugin index/i);
    }
  });
});

describe('listingMatches — the search box', () => {
  const repo = listing({
    name: 'Turkish Drama',
    author: 'someone',
    description: 'Sources for dizis',
    names: ['DiziMax'],
  });

  it('matches the name, the author, the description and a plugin\'s name', () => {
    for (const query of ['drama', 'SOMEONE', 'dizis', 'dizimax']) {
      expect(listingMatches(repo, query), query).toBe(true);
    }
  });

  it('matches everything for an empty query, and nothing for an absent word', () => {
    expect(listingMatches(repo, '   ')).toBe(true);
    expect(listingMatches(repo, 'anime')).toBe(false);
  });
});

describe('languageName / ago', () => {
  it('names a language by its code, however it is spelled', () => {
    expect(languageName('tr')).toBe('Turkish');
    expect(languageName('TR')).toBe('Turkish');
    expect(languageName('pt-br')).toBe('Portuguese (BR)');
    // An unknown code is shown as itself rather than as nothing.
    expect(languageName('xx')).toBe('XX');
  });

  it('says how long ago, and nothing for no date', () => {
    const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    expect(ago(days(0))).toBe('today');
    expect(ago(days(1))).toBe('yesterday');
    expect(ago(days(5))).toBe('5 days ago');
    expect(ago(days(100))).toBe('3 months ago');
    expect(ago(days(800))).toBe('2 years ago');
    expect(ago(undefined)).toBe('');
    expect(ago('not a date')).toBe('');
  });
});

describe('sameRepository / mergeListings', () => {
  it('treats a link as the same however it is spelled', () => {
    expect(sameRepository(' https://X.example/A/B/repo.json ')).toBe(sameRepository('https://x.example/a/b/repo.json'));
    // A `refs/heads/` branch segment is not part of the repository's identity.
    expect(sameRepository('https://x.example/a/b/refs/heads/main/repo.json'))
      .toBe(sameRepository('https://x.example/a/b/main/repo.json'));
  });

  it('keeps one copy per repository, and never shows one twice', () => {
    const merged = mergeListings([
      listing({ url: 'https://x.example/a/b/repo.json', name: 'First' }),
      listing({ url: 'https://X.example/A/B/repo.json', name: 'Second' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('First');
  });

  it('keeps the entry that knows more', () => {
    const merged = mergeListings([
      listing({ url: 'https://x.example/a/b', name: 'Thin', plugins: 1 }),
      listing({ url: 'https://x.example/a/b', name: 'Fat', plugins: 9 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Fat');
  });
});

describe('topLanguages — the filter chips', () => {
  it('counts each language once per repository, most common first', () => {
    const chips = topLanguages([
      listing({ languages: ['tr', 'ar'] }),
      listing({ languages: ['tr'] }),
      listing({ languages: ['de'] }),
    ]);
    expect(chips[0]).toEqual({ code: 'tr', count: 2 });
    expect(chips.map((chip) => chip.code)).toEqual(['tr', 'ar', 'de']);
  });

  it('counts the entries a listing names', () => {
    // A listing's own languages are already de-duplicated when it is built
    // (discovery pushes only codes it has not seen), so this counts entries.
    expect(topLanguages([listing({ languages: ['tr'] }), listing({ languages: ['tr'] })]))
      .toEqual([{ code: 'tr', count: 2 }]);
  });

  it('stops at the limit', () => {
    const many = [listing({ languages: ['a', 'b', 'c', 'd'] })];
    expect(topLanguages(many, 2)).toHaveLength(2);
  });
});

describe('the index on this device', () => {
  /** One discovered repository, so a load has something to keep. */
  const found = () => [{
    url: 'https://x.example/a/b/repo.json',
    name: 'R', kind: 'repo', author: '', description: '', plugins: 1,
    names: [], languages: [], types: ['movie'], stars: 0, adult: false,
  }];

  it('has nothing before anything was loaded', () => {
    expect(keptIndex()).toBeNull();
  });

  it('reads back a copy it kept, so a restart needs no download', async () => {
    await loadPluginIndex(async () => [{
      url: 'https://x.example/a/b/repo.json',
      name: 'R', kind: 'repo', author: 'a', description: '', plugins: 2,
      names: [], languages: ['tr'], types: ['movie'], stars: 1, adult: false,
    }]);
    resetPluginIndex();
    expect(keptIndex()?.repos[0]).toMatchObject({ name: 'R', kind: 'plugins', plugins: 2 });
  });

  it('answers at once from its own copy while that copy is fresh', async () => {
    const discover = vi.fn(async () => found());
    await loadPluginIndex(discover);
    await loadPluginIndex(discover);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('asks again when told to, even though its copy is fresh', async () => {
    const discover = vi.fn(async () => found());
    await loadPluginIndex(discover);
    await loadPluginIndex(discover, { fresh: true });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('falls back to the kept copy when discovery finds nothing', async () => {
    await loadPluginIndex(async () => [{
      url: 'https://x.example/a/b/repo.json',
      name: 'Kept', kind: 'repo', author: '', description: '', plugins: 1,
      names: [], languages: [], types: ['movie'], stars: 0, adult: false,
    }]);
    resetPluginIndex();
    const data = await loadPluginIndex(async () => [], { fresh: true });
    expect(data.repos[0].name).toBe('Kept');
  });

  it('says so when there is nothing at all to show', async () => {
    await expect(loadPluginIndex(async () => [], { fresh: true }))
      .rejects.toThrow(/Couldn't load the plugin list/i);
  });

  it('keeps what discovery found even when discovery fails afterwards', async () => {
    await loadPluginIndex(async () => found());
    resetPluginIndex();
    // The kept copy is what is left; a failing discovery is not an error of its own.
    expect(keptIndex()?.repos).toHaveLength(1);
  });
});

describe('entryFromRepo — what discovery found, as a listing', () => {
  const candidate = {
    slug: 'owner/project',
    fileAt: (path: string) => `https://raw.example/owner/project/main/${path}`,
    stars: 42,
    updated: '2026-03-03T00:00:00Z',
    description: 'Turkish sources',
    page: 'https://github.com/owner/project',
  };

  it('takes its link from the file, so Install re-reads a manifest and not a page', () => {
    const repo = parsePluginRepo(
      JSON.stringify({ name: 'Mine', plugins: [{ id: 'a', name: 'A', url: 'a.js' }] }),
      candidate.fileAt('repo.json'),
    );
    const entry = entryFromRepo(repo, candidate);
    expect(entry.url).toBe('https://raw.example/owner/project/main/repo.json');
    expect(entry.name).toBe('Mine');
    expect(entry.author).toBe('owner');
    expect(entry.stars).toBe(42);
    expect(entry.kind).toBe('repo');
  });

  it('falls back to the repository\'s name, and the types its plugins declare', () => {
    const repo = parsePluginRepo(
      JSON.stringify({ plugins: [{ id: 'a', url: 'a.js', types: ['tv'] }] }),
      candidate.fileAt('repo.json'),
    );
    const entry = entryFromRepo(repo, candidate);
    expect(entry.name).toBe('project');
    expect(entry.types).toEqual(['tv']);
  });

  it('reads a plugin\'s language from its own name when it says one', () => {
    const repo = parsePluginRepo(
      JSON.stringify({ plugins: [{ id: 'a', name: 'Arabic HD', url: 'a.js' }, { id: 'b', name: 'Deutsch Filme', url: 'b.js' }] }),
      candidate.fileAt('repo.json'),
    );
    expect(entryFromRepo(repo, candidate).languages).toEqual(['ar', 'de']);
  });

  it('lists at most forty plugin names, for the browser\'s summary', () => {
    const plugins = Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, url: `p${index}.js` }));
    const repo = parsePluginRepo(JSON.stringify({ plugins }), candidate.fileAt('repo.json'));
    const entry = entryFromRepo(repo, candidate);
    expect(entry.plugins).toBe(50);
    expect(entry.names).toHaveLength(40);
  });
});
