// Scraper plugins: repositories of third-party JavaScript that find streams.
// A port of VyseTV's `lib/data/sources/plugins/js_plugins.dart` (GPL-3.0-or-later),
// reduced to what the browser/Android build can run.
//
// A repository is one of three shapes, all of them "paste this link where addon
// links go":
//
//   repo.json        { name, plugins: [{ id, name, url, version, types }] }
//   scraper list     { name, scrapers: [{ id, filename, supportedTypes, enabled }] }
//   Vega manifest    [ { value, name, … } ]   (each provider's dist/<value>/*.js)
//
// Each plugin is one JavaScript file run in a worker with `http()` and the
// title/HTML helpers and nothing else. This module parses the repositories; the
// worker in `pluginWorker.ts` runs the scripts.
//
// The engine is VyseTV's; the *index* of public repositories is not: VyseTV serves
// it from its author's own server (`$accountServer/plugins/index.json`, with
// `server_config.dart` gitignored), so there is no public list to copy. PRAHA
// takes the index URL from settings and otherwise builds its list from
// repositories the user adds — see `pluginIndex.ts`.

import type { StreamResult } from '../types';
import { assertPublicHttpUrl } from './pluginNetwork';

/** One plugin as its repository lists it. */
export interface PluginEntry {
  /** Unique and stable inside its repository. */
  id: string;
  name: string;
  /** Absolute URL of the script. */
  url: string;
  /** Any string; a change means "download it again". */
  version: string;
  note: string;
  /** `movie`, `tv`, or both. */
  types: string[];
  /** The file is a scraper-list CommonJS script (runs on the adapter). */
  scraper: boolean;
  /** The file is a Vega provider (runs on the Vega runtime). */
  vega: boolean;
  /** The lists of titles it offers to browse, in its own words. */
  catalogs: PluginCatalog[];
  /** It answers a title's own details (else they come from TMDB, or the catalog's copy). */
  details: boolean;
  /**
   * It lists comics, not films and shows: its catalogs belong to the manga
   * section, and it is never asked for a video's streams (VyseTV's `comic`).
   */
  comic: boolean;
}

/** One list of titles a plugin offers (VyseTV's `PluginCatalog`). */
export interface PluginCatalog {
  id: string;
  name: string;
  /** What it lists, in the plugin's own word: `movie`, `tv`, or its own. */
  type: string;
  /** A Vega provider's: what its posts are asked for. */
  filter?: string;
  genres: string[];
  search: boolean;
  searchOnly: boolean;
  genreRequired: boolean;
}

export interface PluginRepo {
  /** The link the user pasted, normalised. */
  url: string;
  name: string;
  plugins: PluginEntry[];
  /** Which of the three shapes it was, for the UI's label. */
  kind: 'repo' | 'scrapers' | 'vega';
}

/** VyseTV's `_maxPlugins`. */
const MAX_PLUGINS = 100;

/** VyseTV's `_maxScript`. */
export const MAX_SCRIPT_BYTES = 512 * 1024;

const PLUGIN_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** The kinds a plugin may declare, in VyseTV's words. */
function readTypes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const types = raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry === 'movie' || entry === 'tv' || entry === 'series');
  const normalised = types.map((entry) => (entry === 'series' ? 'tv' : entry));
  return normalised.length ? [...new Set(normalised)] : ['movie', 'tv'];
}

/** Resolves a repository-relative script path, refusing anything not http(s). */
function resolveScriptUrl(base: string, path: string): string | null {
  try {
    const url = new URL(path, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A plugin's catalogs as it lists them: a plain repo gives ids and names, a
 * scraper list writes them Stremio's way (`extra`: search, genre with its
 * options), a Vega provider's are read from its catalog module at install.
 *
 * VyseTV's `_scraperCatalogs`, capped at 40.
 */
function readCatalogs(value: unknown): PluginCatalog[] {
  if (!Array.isArray(value)) return [];
  const out: PluginCatalog[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    const extra = Array.isArray(record.extra)
      ? record.extra.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];
    const has = (name: string) => extra.some((item) => item.name === name);
    const required = (name: string) => extra.some((item) => item.name === name && item.isRequired === true);
    const genre = extra.find((item) => item.name === 'genre');
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    // A Vega provider keeps its own filter name here; upstream reads `filter`.
    const filter = typeof record.filter === 'string' ? record.filter : undefined;
    out.push({
      id,
      name: name || id,
      type: typeof record.type === 'string' && record.type.trim() ? record.type.trim() : 'movie',
      filter,
      genres: genre && Array.isArray(genre.options) ? genre.options.map((option) => String(option)) : [],
      search: has('search') || record.search === true,
      searchOnly: required('search') || record.searchOnly === true,
      genreRequired: required('genre') || record.genreRequired === true,
    });
    if (out.length >= 40) break;
  }
  return out;
}

/** Whether a plugin declares that it lists comics rather than films and shows. */
function readComic(record: Record<string, unknown>): boolean {
  const keys = ['supportedTypes', 'types'];
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const kind of value) {
      const word = String(kind).toLowerCase();
      if (word === 'manga' || word === 'comic') return true;
    }
  }
  return false;
}

/**
 * A Vega provider's own lists, from its catalog module read at install
 * (`__vyseDescribe`): 30 lists, then a genre picker, then a search.
 *
 * VyseTV's `_describeVega`, including the guess at what each list holds — a
 * provider's catalog module names its lists, not their kinds, so "Movies" and
 * "Series" are recognised by their titles and anything else is a film list.
 */
export function readDescribedCatalogs(value: unknown, comic: boolean): PluginCatalog[] {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const list = (raw: unknown): Array<{ title: string; filter: string }> =>
    Array.isArray(raw)
      ? raw
          .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && typeof x.title === 'string')
          .map((x) => ({ title: String(x.title).trim(), filter: x.filter == null ? '' : String(x.filter) }))
          .filter((x) => x.title)
      : [];
  const catalogs = list(record.catalogs);
  const genres = list(record.genres);
  const kind = (title: string): string => {
    const t = title.toLowerCase();
    if (/\b(movies?|films?)\b/.test(t)) return 'movie';
    if (/\b(series|shows?|tv|seasons?|dramas?|anime|web)\b/.test(t)) return 'series';
    return 'movie';
  };
  // A comic provider's lists are comics, whatever they are called.
  const type = comic ? 'comic' : null;
  const out: PluginCatalog[] = catalogs.slice(0, 30).map((c, index) => ({
    id: `c${index}`,
    name: c.title,
    type: type ?? kind(c.title),
    filter: c.filter,
    genres: [],
    search: false,
    searchOnly: false,
    genreRequired: false,
  }));
  if (genres.length) {
    out.push({
      id: 'genre',
      name: 'Genres',
      type: type ?? 'movie',
      genres: genres.slice(0, 60).map((g) => g.title),
      search: false,
      searchOnly: false,
      genreRequired: true,
    });
  }
  if (record.search === true) {
    out.push({
      id: 'search',
      name: 'Search',
      type: type ?? 'movie',
      genres: [],
      search: true,
      searchOnly: true,
      genreRequired: false,
    });
  }
  return out;
}

function baseId(url: string): string {
  const last = url.split('/').filter(Boolean).pop() || 'plugin';
  return last.replace(/\.js$/i, '');
}

/**
 * A `repo.json`, a scraper list, or a Vega manifest.
 *
 * Throws with a message fit to show when the text is not one of the three — the
 * user pasted the wrong link, and "unexpected token <" would not help them.
 */
export function parsePluginRepo(text: string, repoUrl: string): PluginRepo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That link is not a JSON file. Paste the repository link (its repo.json, or a scraper list or Vega manifest).');
  }

  if (Array.isArray(parsed)) return parseVegaManifest(parsed, repoUrl);

  const object = parsed as Record<string, unknown> | null;
  if (!object || typeof object !== 'object') {
    throw new Error('That link is not a plugin repository.');
  }
  if (!Array.isArray(object.plugins) && Array.isArray(object.scrapers)) {
    return parseScraperList(object, repoUrl);
  }
  if (!Array.isArray(object.plugins)) {
    throw new Error('Not a plugin repository: it has no "plugins" list.');
  }

  const plugins: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const entry of object.plugins as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    const url = resolveScriptUrl(repoUrl, record.url);
    if (!url) continue;
    const declared = typeof record.id === 'string' ? record.id.trim() : '';
    const id = declared || baseId(url);
    if (!PLUGIN_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    plugins.push({
      id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
      url,
      version: record.version == null ? '' : String(record.version),
      note: record.note == null ? '' : String(record.note),
      types: readTypes(record.types),
      scraper: false,
      vega: false,
      catalogs: readCatalogs(record.catalogs),
      details: false,
      comic: readComic(record),
    });
    if (plugins.length >= MAX_PLUGINS) break;
  }

  return {
    url: repoUrl,
    name: typeof object.name === 'string' ? object.name.trim() : '',
    plugins,
    kind: 'repo',
  };
}

/**
 * A scraper list: `{ name, scrapers: [{ id, name, filename, supportedTypes, enabled }] }`.
 *
 * Each enabled scraper becomes a plugin. `filename` is relative to the manifest.
 */
function parseScraperList(object: Record<string, unknown>, repoUrl: string): PluginRepo {
  const plugins: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const entry of object.scrapers as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    // VyseTV treats anything but an explicit `false` as enabled.
    if (record.enabled === false) continue;
    const filename = typeof record.filename === 'string' ? record.filename : typeof record.url === 'string' ? record.url : '';
    if (!filename) continue;
    const url = resolveScriptUrl(repoUrl, filename);
    if (!url) continue;
    const declared = typeof record.id === 'string' ? record.id.trim() : '';
    const id = declared || baseId(url);
    if (!PLUGIN_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    // A scraper declares the resources it serves; `meta` means it gives a
    // title's own details rather than only its streams.
    const resources = Array.isArray(record.resources)
      ? record.resources.map((item) => (item && typeof item === 'object'
        ? String((item as Record<string, unknown>).name)
        : String(item)))
      : [];
    plugins.push({
      id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
      url,
      version: record.version == null ? '' : String(record.version),
      note: record.note == null ? '' : String(record.note),
      types: readTypes(record.supportedTypes ?? record.types),
      scraper: true,
      vega: false,
      catalogs: readCatalogs(record.catalogs),
      details: resources.includes('meta'),
      comic: readComic(record),
    });
    if (plugins.length >= MAX_PLUGINS) break;
  }

  return {
    url: repoUrl,
    name: typeof object.name === 'string' ? object.name.trim() : '',
    plugins,
    kind: 'scrapers',
  };
}

/**
 * Providers a Vega manifest lists but the stream engine never asks.
 *
 * Upstream's `_vegaSkip`: these four are either not stream providers at all
 * (`youtube` searches videos) or serve a job the app already does itself. A
 * `torrentio`-style provider, for instance, answers with torrents PRAHA resolves
 * on its own path, so running it here would list the same links twice.
 */
const VEGA_SKIP = new Set(['torrentio', 'youtube', 'durbinLive', 'liveTgTv']);

/**
 * A Vega manifest: an array of providers. Each enabled provider's built modules
 * live under `dist/<value>/` — `posts`, `meta`, `stream` and optionally
 * `episodes`/`catalog` — and `composeVega` stitches them from there.
 *
 * `url` is that *folder*, not a file: upstream stores `…/dist/<value>` and
 * `composeVegaPlugin` derives the provider's `value` from the last path
 * segment. Storing `stream.js` here would make the provider run as "stream.js".
 */
function parseVegaManifest(list: unknown[], repoUrl: string): PluginRepo {
  // The repository's folder: the manifest's link without its query and file name.
  const clean = repoUrl.split(/[?#]/)[0];
  const base = clean.slice(0, clean.lastIndexOf('/'));
  const plugins: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    // Upstream reads `disabled` for Vega, not `enabled`; both are honoured so a
    // manifest written either way behaves as its author meant.
    if (record.disabled === true || record.enabled === false) continue;
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!value || !/^[A-Za-z0-9_.-]{1,60}$/.test(value) || VEGA_SKIP.has(value)) continue;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    // Upstream's `vega-$value`: the prefix keeps a Vega provider from colliding
    // with a same-named entry in a plain repo, and the log lines read as
    // "vega-netmirror" rather than an ambiguous bare name.
    const id = `vega-${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    plugins.push({
      id,
      name: displayName(record) || value,
      url: `${base}/dist/${value}`,
      version: record.version == null ? '' : String(record.version),
      // Upstream keeps the provider's `type` here, which the UI shows as its
      // category. A provider that declared none keeps an empty note.
      note: type,
      types: readTypes(record.supportedTypes ?? record.types ?? ['movie', 'tv']),
      scraper: false,
      vega: true,
      // A Vega provider's lists are its catalog module's, read at install
      // (`describeVega`); the manifest only says whether it has a catalog one.
      catalogs: [],
      details: false,
      comic: type === 'comic' || type === 'manga',
    });
    if (plugins.length >= MAX_PLUGINS) break;
  }

  return { url: repoUrl, name: 'Vega providers', plugins, kind: 'vega' };
}

/**
 * A Vega manifest's human label: `display_name` is what its author shows, while
 * `name` is often the folder name the id was already built from.
 */
function displayName(record: Record<string, unknown>): string {
  for (const key of ['display_name', 'displayName', 'name'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** What a plugin is asked for: the same shape VyseTV's README documents. */
export interface PluginQuery {
  tmdbId: number | null;
  imdbId: string | null;
  type: 'movie' | 'tv';
  isTv: boolean;
  title: string;
  originalTitle?: string;
  year?: number | null;
  titles?: string[];
  isAnime?: boolean;
  season?: number | null;
  episode?: number | null;
  /**
   * One of the plugin's own titles (from its catalogs), by the id it gave it.
   * Set only when the title came from that plugin, which is then asked alone.
   */
  ownId?: string;
}

/** One link a plugin returned. */
export interface PluginStream {
  url: string;
  type?: string;
  quality: string;
  server: string;
  label?: string;
  audio?: string;
  headers: Record<string, string>;
}

/**
 * A plugin's answer as streams: `[{url, type?, quality?, server?, label?, audio?, headers?}]`.
 *
 * Anything that is not an http(s) link is dropped — VyseTV does the same, and it
 * is the one place a hostile plugin's output is filtered before it reaches the
 * player.
 */
export function parsePluginStreams(value: unknown): PluginStream[] {
  if (!Array.isArray(value)) return [];
  const out: PluginStream[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    if (!/^https?:\/\//i.test(record.url)) continue;
    const headers: Record<string, string> = {};
    if (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)) {
      for (const [key, headerValue] of Object.entries(record.headers as Record<string, unknown>)) {
        if (headerValue == null) continue;
        headers[key] = String(headerValue);
      }
    }
    out.push({
      url: record.url,
      type: typeof record.type === 'string' ? record.type : undefined,
      quality: record.quality == null ? 'Auto' : String(record.quality),
      server: record.server == null ? 'Server' : String(record.server),
      label: typeof record.label === 'string' ? record.label : undefined,
      audio: typeof record.audio === 'string' && record.audio.trim() ? record.audio.trim() : undefined,
      headers,
    });
  }
  return out;
}

/** A plugin's link as the app's stream list shows it. */
export function pluginStreamToResult(stream: PluginStream, plugin: PluginEntry, index: number): StreamResult {
  const label = [stream.quality, stream.server, stream.audio].filter(Boolean).join(' · ');
  // Scrapers rank first in `sourceOrchestrator`'s chain, which is where
  // VyseTV's own plugins sit too.
  return {
    id: `plugin:${plugin.id}:${index}`,
    url: stream.url,
    title: label || stream.label || plugin.name,
    sourceName: `${plugin.name} · ${stream.server}`,
    sourceType: 'scraper',
    quality: stream.quality,
    provider: plugin.name,
    headers: stream.headers,
    referer: stream.headers.Referer || stream.headers.referer || undefined,
    format: stream.type === 'hls' ? 'hls' : stream.type === 'dash' ? 'dash' : undefined,
    language: stream.audio,
  };
}

/**
 * Fetches and parses a repository.
 *
 * The link is checked before it is fetched: a repository is a third-party link a
 * user pasted, and it has no business pointing at this device's own network.
 */
export async function loadPluginRepo(
  rawUrl: string,
  fetchText: (url: string) => Promise<string>,
): Promise<PluginRepo> {
  const url = assertPublicHttpUrl(rawUrl.trim()).toString();
  const text = await fetchText(url);
  if (text.length > MAX_SCRIPT_BYTES * 4) {
    throw new Error('That repository file is too large to be a plugin list.');
  }
  return parsePluginRepo(text, url);
}
