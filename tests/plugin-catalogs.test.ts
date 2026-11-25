// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import {
  addonCatalog,
  browsePlugins,
  engineRepo,
  plainName,
  pluginAddon,
  pluginAddons,
  pluginAbout,
  pluginOwnOf,
  prefix,
  repoKey,
  setInstalledPluginRepositories,
  setPluginBrowse,
  storedRepository,
  unwrap,
  wrap,
} from '../services/pluginCatalogs';
import type { PluginRepo } from '../services/jsPlugins';
import type { PluginRepository } from '../types';

/**
 * A plugin repository answers as a Stremio addon would, which is what lets its
 * titles appear on Home, in Discover and in search. Two things make that work
 * and both are tested here: the `pl:` id scheme (so a title can be told back to
 * the plugin that listed it) and the addon shape itself.
 */

const URL_A = 'https://raw.example/owner/repo/repo.json';
const URL_B = 'https://raw.example/other/repo.json';

function plugin(id: string, over: Partial<PluginRepo['plugins'][number]> = {}) {
  return {
    id,
    name: id,
    url: `https://raw.example/owner/repo/${id}.js`,
    version: '',
    note: '',
    types: ['movie', 'tv'],
    scraper: false,
    vega: false,
    catalogs: [],
    details: false,
    comic: false,
    ...over,
  };
}

function repo(over: Partial<PluginRepo> = {}): PluginRepo {
  return { url: URL_A, name: 'Repo', kind: 'repo', plugins: [plugin('alpha')], ...over };
}

/** A plugin that lists one title, as a stored repository carries it. */
function withCatalogs(id: string) {
  return {
    ...plugin(id),
    enabled: true,
    catalogs: [{ id: 'c', name: 'C', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false }],
  };
}

function stored(over: Partial<PluginRepository> = {}): PluginRepository {
  return {
    url: URL_A,
    name: 'Repo',
    kind: 'repo',
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    plugins: [{ ...plugin('alpha'), enabled: true }],
    ...over,
  };
}

describe('repoKey — the id a repository is known by', () => {
  it('is stable, and differs between links', () => {
    expect(repoKey(URL_A)).toBe(repoKey(URL_A));
    expect(repoKey(URL_A)).not.toBe(repoKey(URL_B));
    expect(repoKey(URL_A)).toMatch(/^[0-9a-z]+$/);
  });

  it('hashes bytes, not code units, so another device computes the same key', () => {
    // A non-ASCII link: this is the case where the two would differ.
    const url = 'https://raw.example/émoji/🎬/repo.json';
    expect(repoKey(url)).toBe(repoKey(url));
    expect(repoKey(url)).toMatch(/^[0-9a-z]+$/);
  });
});

describe('wrap / unwrap — a title\'s id and back', () => {
  it('round-trips a plugin and the title\'s own id', () => {
    const id = wrap(URL_A, 'alpha', 'tmdb-550');
    expect(id.startsWith(prefix(URL_A))).toBe(true);
    expect(unwrap(URL_A, id)).toEqual({ plugin: 'alpha', own: 'tmdb-550' });
  });

  it('keeps a colon inside the title\'s own id', () => {
    const id = wrap(URL_A, 'alpha', 'show:1:2');
    expect(unwrap(URL_A, id)).toEqual({ plugin: 'alpha', own: 'show:1:2' });
  });

  it('does not claim an id from a different repository', () => {
    expect(unwrap(URL_B, wrap(URL_A, 'alpha', 'x'))).toBeNull();
  });

  it('answers null for anything that is not one of its ids', () => {
    const head = prefix(URL_A);
    expect(unwrap(URL_A, 'tt0944947')).toBeNull();
    expect(unwrap(URL_A, head)).toBeNull();
    expect(unwrap(URL_A, `${head}alpha`)).toBeNull();
    expect(unwrap(URL_A, `${head}alpha:`)).toBeNull();
    expect(unwrap(URL_A, `${head}:x`)).toBeNull();
    expect(unwrap(undefined, `${head}alpha:x`)).toBeNull();
    expect(unwrap(URL_A, null)).toBeNull();
  });
});

describe('plainName', () => {
  it('strips the punctuation a sorting trick puts in front', () => {
    expect(plainName('!HDFilmCehennemi')).toBe('HDFilmCehennemi');
    expect(plainName('  ### Site  ')).toBe('Site');
    expect(plainName('Normal')).toBe('Normal');
    // A script that starts with a letter or digit is untouched.
    expect(plainName('1movies')).toBe('1movies');
  });
});

describe('pluginAbout — the addon\'s description', () => {
  it('names a few plugins and counts the rest', () => {
    const list = [plugin('a'), plugin('b'), plugin('c'), plugin('d')];
    list.forEach((entry, index) => { entry.name = `P${index}`; });
    expect(pluginAbout(list)).toBe('4 plugins: P0, P1, P2 and 1 more');
  });

  it('reads as one plugin when there is one', () => {
    expect(pluginAbout([plugin('only')])).toBe('1 plugin: only');
  });

  it('names them all when there are only a few', () => {
    const list = [plugin('a'), plugin('b')];
    expect(pluginAbout(list)).toContain('2 plugins: a, b');
    expect(pluginAbout(list)).not.toMatch(/more/);
  });
});

describe('addonCatalog — one plugin\'s list as an addon catalog', () => {
  it('carries the plugin\'s name and its own id', () => {
    const catalog = addonCatalog(
      plugin('alpha', { name: '!Alpha' }),
      { id: 'popular', name: 'Popular', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false },
    );
    expect(catalog).toEqual({ type: 'movie', id: 'alpha/popular', name: 'Alpha · Popular' });
  });

  it('keeps a search and a genre as `extra`, where the app already reads them', () => {
    const catalog = addonCatalog(
      plugin('alpha'),
      { id: 'search', name: 'Search', type: 'series', search: true, searchOnly: true, genreRequired: false, genres: ['Action', 'Drama'] },
    );
    expect(catalog.extra).toEqual([
      { name: 'search', isRequired: true },
      { name: 'genre', isRequired: false, options: ['Action', 'Drama'] },
    ]);
  });

  it('adds no empty `extra`', () => {
    const catalog = addonCatalog(
      plugin('alpha'),
      { id: 'x', name: 'X', type: 'movie', search: false, searchOnly: false, genreRequired: false, genres: [] },
    );
    expect('extra' in catalog).toBe(false);
  });
});

describe('pluginAddon — a repository as an installed addon', () => {
  it('lists a scraper list\'s catalogs by default', () => {
    const addon = pluginAddon(repo({
      plugins: [
        plugin('with', { name: 'With', catalogs: [{ id: 'c', name: 'C', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false }] }),
        plugin('without'),
      ],
    }));
    expect(addon.manifest.catalogs).toHaveLength(1);
    expect(addon.manifest.catalogs[0].id).toBe('with/c');
    expect(addon.plugins).toBe(true);
    expect(addon.manifest.id).toBe(`plugins.${repoKey(URL_A)}`);
  });

  it('leaves a Vega provider\'s catalogs off by default', () => {
    const addon = pluginAddon(repo({
      kind: 'vega',
      plugins: [plugin('vega-x', {
        vega: true,
        catalogs: [{ id: 'c', name: 'C', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false }],
      })],
    }));
    expect(addon.manifest.catalogs).toEqual([]);
    // Details stay on: a title opened from history still has a page.
    expect(addon.manifest.resources.some((resource) => resource.name === 'meta')).toBe(true);
  });

  it('never asks a plugin repository for streams itself', () => {
    const addon = pluginAddon(repo());
    expect(addon.manifest.resources.some((resource) => resource.name === 'stream')).toBe(false);
  });

  it('gives the meta resource the repository\'s id prefix, which is what finds it', () => {
    const addon = pluginAddon(repo({
      plugins: [plugin('with', { catalogs: [{ id: 'c', name: 'C', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false }] })],
    }));
    const meta = addon.manifest.resources.find((resource) => resource.name === 'meta');
    expect(meta?.idPrefixes).toEqual([prefix(URL_A)]);
  });

  it('leaves the meta resource out when nothing can answer details', () => {
    const addon = pluginAddon(repo({ plugins: [plugin('plain')] }));
    expect(addon.manifest.resources.some((resource) => resource.name === 'meta')).toBe(false);
    expect(addon.manifest.catalogs).toEqual([]);
  });

  it('never browses a comic plugin\'s lists', () => {
    const addon = pluginAddon(repo({
      plugins: [plugin('manga', {
        comic: true,
        catalogs: [{ id: 'c', name: 'C', type: 'comic', genres: [], search: false, searchOnly: false, genreRequired: false }],
      })],
    }));
    expect(addon.manifest.catalogs).toEqual([]);
  });
});

describe('pluginAddons — the repositories as addons', () => {
  it('leaves out a repository that is only a source list', () => {
    expect(pluginAddons([stored({ plugins: [{ ...plugin('plain'), enabled: true }] })])).toEqual([]);
  });

  it('leaves out a repository that is switched off', () => {
    const withCatalog = {
      ...plugin('with', { catalogs: [{ id: 'c', name: 'C', type: 'movie', genres: [], search: false, searchOnly: false, genreRequired: false }] }),
      enabled: true,
    };
    expect(pluginAddons([stored({ enabled: false, plugins: [withCatalog] })])).toEqual([]);
  });

  it('leaves a plugin the user switched off out of the lists', () => {
    const on = withCatalogs('on');
    const off = { ...withCatalogs('off'), enabled: false };
    const [addon] = pluginAddons([stored({ plugins: [on, off] })]);
    expect(addon.manifest.catalogs.map((catalog) => catalog.id)).toEqual(['on/c']);
  });
});

describe('browsePlugins / setPluginBrowse — the user\'s pick', () => {
  it('defaults to the plugins that list titles', () => {
    expect(browsePlugins(stored({ plugins: [withCatalogs('a'), withCatalogs('b')] }))).toEqual(['a', 'b']);
    expect(browsePlugins(stored({ plugins: [withCatalogs('a'), { ...plugin('plain'), enabled: true }] }))).toEqual(['a']);
  });

  it('defaults to none for a Vega repository', () => {
    const vega = { ...withCatalogs('v'), vega: true };
    expect(browsePlugins(stored({ kind: 'vega', plugins: [vega] }))).toEqual([]);
  });

  it('keeps an explicit empty pick as empty, rather than falling back to the default', () => {
    const picked = stored({ plugins: [withCatalogs('a')], browse: [] });
    expect(browsePlugins(picked)).toEqual([]);
  });

  it('turns one on and off, keeping the rest', () => {
    const base = stored({ plugins: [withCatalogs('a'), withCatalogs('b')], browse: ['a'] });
    expect(setPluginBrowse(base, 'b', true).browse).toEqual(['a', 'b']);
    expect(setPluginBrowse(base, 'a', false).browse).toEqual([]);
    // Turning the same one on twice does not duplicate it.
    expect(setPluginBrowse(base, 'a', true).browse).toEqual(['a']);
  });
});

describe('the installed repositories, kept in step', () => {
  beforeEach(() => {
    setInstalledPluginRepositories([]);
  });

  it('finds a stored repository by its link', () => {
    setInstalledPluginRepositories([stored()]);
    expect(storedRepository(URL_A)?.name).toBe('Repo');
    expect(storedRepository(URL_B)).toBeUndefined();
  });

  it('gives the engine only the enabled plugins, without the stored flag', () => {
    setInstalledPluginRepositories([stored({
      plugins: [
        { ...plugin('on'), enabled: true },
        { ...plugin('off'), enabled: false },
      ],
    })]);
    const engine = engineRepo(URL_A);
    expect(engine?.plugins.map((entry) => entry.id)).toEqual(['on']);
    expect('enabled' in (engine!.plugins[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('answers null for a repository that is off or absent', () => {
    setInstalledPluginRepositories([stored({ enabled: false })]);
    expect(engineRepo(URL_A)).toBeNull();
    expect(engineRepo(URL_B)).toBeNull();
  });
});

describe('pluginOwnOf — which plugin listed a title', () => {
  it('reads the repository, the plugin and the title\'s own id off an item', () => {
    const item = { id: wrap(URL_A, 'alpha', 'own-1'), addonUrl: URL_A } as never;
    expect(pluginOwnOf(item)).toEqual({ repoUrl: URL_A, plugin: 'alpha', own: 'own-1' });
  });

  it('prefers an episode\'s own id when one is given', () => {
    const item = { id: wrap(URL_A, 'alpha', 'own-1'), addonUrl: URL_A } as never;
    expect(pluginOwnOf(item, wrap(URL_A, 'alpha', 'own-1:1:2'))).toEqual({
      repoUrl: URL_A, plugin: 'alpha', own: 'own-1:1:2',
    });
  });

  it('answers null for a title that did not come from a plugin repository', () => {
    expect(pluginOwnOf({ id: 'tt1', addonUrl: URL_B } as never)).toBeNull();
    expect(pluginOwnOf({ id: 'tt1' } as never)).toBeNull();
  });
});
