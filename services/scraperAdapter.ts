// The adapter that lets a "scraper list" plugin behave like a normal one — a
// port of the `__scrapers` adapter at the end of VyseTV's
// `assets/plugins/scraper_runtime.js` (GPL-3.0-or-later).
//
// A scraper from a scraper list is a CommonJS file: it sets
// `module.exports.getStreams` (or leaves a global) to
// `getStreams(tmdbId, mediaType, season, episode)` and answers
// `[{ name, title, url, quality, size, headers }]`. The plugin contract, by
// contrast, is a global `getStreams(query)` answering
// `[{ url, type, quality, server, label, audio, headers }]`.
//
// This module is the translation between the two, and nothing else. It runs
// inside the plugin worker, so it holds no capability of its own: the `require`
// it hands the scraper resolves only the libraries the worker already loaded.
//
// There is no `eval` here. The scraper's function bodies arrive as source text
// and the worker hands them to the sandbox; this file only calls them.

import * as cheerio from 'cheerio';
import axios from 'axios';

/** The subset of the plugin contract a scraper is compared against. */
export interface ScraperQuery {
  tmdbId: number | null;
  isTv: boolean;
  season?: number | null;
  episode?: number | null;
  /** One of the scraper's own titles, by its own id (a catalog item). */
  ownId?: string;
}

type AnyFunction = (...args: unknown[]) => unknown;

/** What the sandbox offers a scraper through `require`. */
export const SCRAPER_MODULES: Record<string, unknown> = {
  cheerio,
  'cheerio-without-node-native': cheerio,
  'react-native-cheerio': cheerio,
  axios,
};

/** The `require` a scraper sees: the libraries above, and nothing else. */
export function scraperRequire(name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(SCRAPER_MODULES, name)) return SCRAPER_MODULES[name];
  throw new Error(`Cannot find module '${name}'`);
}

export interface ScraperAdapter {
  /** Called by the composed plugin script: runs the scraper's own file. */
  load: (id: string, run: (module: unknown, exports: unknown, require: unknown) => void) => void;
  /** The plugin contract's entry point, in the scraper's words. */
  getStreams: (query: ScraperQuery) => Promise<unknown[]>;
  /** One page of one of the scraper's own catalogs, when it has them. */
  getCatalog: (query: Record<string, unknown>) => Promise<unknown>;
  /** A title's details, when the scraper gives them itself. */
  getMeta: (query: Record<string, unknown>) => Promise<unknown>;
}

const text = (value: unknown) => (value == null ? '' : String(value).trim());

/**
 * Builds the adapter for one scraper.
 *
 * `scope` is the sandbox's global object — the scraper's file is run with it as
 * `this`, and a global `getStreams` it leaves behind is how older scrapers
 * export themselves.
 */
export function createScraperAdapter(scope: Record<string, any>): ScraperAdapter {
  // A scraper written for React Native may test for these before it runs.
  scope.global = scope.global || scope;
  scope.window = scope.window || scope;
  scope.self = scope.self || scope;

  let streams: AnyFunction | null = null;
  let catalog: AnyFunction | null = null;
  let meta: AnyFunction | null = null;

  /** The scraper's own function by name: exported, or left as a global. */
  function own(exports: Record<string, any> | null, name: string, before: unknown): AnyFunction | null {
    if (exports && typeof exports[name] === 'function') return exports[name] as AnyFunction;
    return scope[name] !== before && typeof scope[name] === 'function' ? (scope[name] as AnyFunction) : null;
  }

  return {
    load(id, run) {
      scope.SCRAPER_ID = id;
      scope.SCRAPER_SETTINGS = {};
      const module = { exports: {} as Record<string, any> };
      // Snapshot the globals before the file runs, so a function it defines is
      // told apart from one that was already there.
      const before = { getStreams: scope.getStreams, getCatalog: scope.getCatalog, getMeta: scope.getMeta };
      run.call(scope, module, module.exports, scraperRequire);
      const exported = module.exports as Record<string, any> & AnyFunction;
      streams =
        (exported && typeof exported.getStreams === 'function' && (exported.getStreams as AnyFunction)) ||
        (typeof exported === 'function' ? exported : null) ||
        own(null, 'getStreams', before.getStreams);
      catalog = own(exported, 'getCatalog', before.getCatalog);
      meta = own(exported, 'getMeta', before.getMeta);
    },

    async getStreams(query) {
      if (!streams) throw new Error('the scraper has no getStreams');
      // A scraper knows only TMDB ids; one of its own titles goes in as given.
      const id = query.ownId != null ? String(query.ownId) : query.tmdbId == null ? null : String(query.tmdbId);
      if (id == null) return [];
      const tv = Boolean(query.isTv);
      const answer = await streams(id, tv ? 'tv' : 'movie', tv ? query.season : undefined, tv ? query.episode : undefined);
      return (Array.isArray(answer) ? answer : [])
        .filter((entry) => entry && typeof (entry as Record<string, unknown>).url === 'string')
        .map((entry: Record<string, any>) => {
          const hints = entry.behaviorHints || {};
          const proxy = hints.proxyHeaders && hints.proxyHeaders.request;
          const label = [text(entry.title), text(entry.size)].filter(Boolean).join(' · ');
          return {
            url: entry.url,
            type: typeof entry.type === 'string' ? entry.type : undefined,
            quality: text(entry.quality) || undefined,
            server: text(entry.name) || text(entry.provider) || undefined,
            label: label || undefined,
            headers: entry.headers || proxy || undefined,
          };
        });
    },

    async getCatalog(query) {
      if (!catalog) throw new Error('the scraper has no getCatalog');
      // Asked both ways scrapers are written: Stremio's `extra`, and the paged one.
      const extra: Record<string, unknown> = {};
      if (query.search) extra.search = query.search;
      if (query.skip) extra.skip = query.skip;
      if (query.genre) extra.genre = query.genre;
      return await catalog({
        catalogId: query.catalogId,
        id: query.catalogId,
        type: query.type,
        pageToken: query.pageToken || undefined,
        page: query.page || 1,
        skip: query.skip || 0,
        search: query.search || undefined,
        query: query.search || undefined,
        genre: query.genre || undefined,
        extra,
      });
    },

    async getMeta(query) {
      if (!meta) throw new Error('the scraper has no getMeta');
      return await meta(query);
    },
  };
}

/**
 * The script the sandbox runs for a scraper-list plugin.
 *
 * The scraper's code is placed in a function body of its own so its
 * `getStreams` stays its own, and the adapter is then exposed under that name —
 * exactly how VyseTV's `composeScraperPlugin` builds it.
 */
export function composeScraperScript(id: string, version: string, code: string): string {
  return [
    `// @scraper ${id}`,
    `// @scraper-version ${version}`,
    `__scrapers.load(${JSON.stringify(id)}, function (module, exports, require) {`,
    code,
    '});',
    'var getStreams = __scrapers.getStreams;',
    // Browsing and details are asked by their global names, exactly as VyseTV's
    // `scraper_runtime.js` exposes them, so the engine can call them without the
    // scraper having to export them itself.
    'globalThis.__scraperCatalog = function (q) { return __scrapers.getCatalog(q); };',
    'globalThis.__scraperMeta = function (q) { return __scrapers.getMeta(q); };',
  ].join('\n');
}
