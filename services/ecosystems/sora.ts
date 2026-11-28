// Sora modules — video, manga and novel sources written as one module of
// global functions (`searchResults`, `extractDetails`, `extractEpisodes`,
// `extractStreamUrl`; manga: `extractChapters`/`getChapters`,
// `extractImages`/`getChapterImages`; novels: `extractText`), written against
// `fetchv2` rather than cheerio.
//
// A port of Hikari's `sora/SoraRuntime.kt`, `SoraPluginManager.kt`,
// `SoraProvider.kt` and `SoraMangaProvider.kt` (GPL-3.0-or-later,
// Copyright (C) 2026 Codegeasse). The prelude keeps the two bindings modules
// actually see — `fetchv2` (which rejects on a non-2xx and knows the
// impersonate UAs) and `getSetting` — while the QuickJS-only parts of
// upstream's boot (timer pump, native crypto bridges) are dropped: a browser
// worker has timers, CryptoJS and WebCrypto already.
//
// Catalogs have no browse endpoint in this ecosystem (AnymeX parity), so the
// six fixed rows are seeded searches, exactly as upstream seeds them. The
// module's JSON-string answers are parsed here, and the same caps, entity
// decoding, error-list guard and newest-first episode order are kept.

import { readEcosystemPrefs, runEcosystemCall, writeEcosystemPref } from '../pluginRuntime';
import { fetchEcosystemScript } from './scripts';
import { installEcosystemExtensions, type EcosystemExtension } from './store';
import type { MediaItem, StreamResult, StreamSubtitle } from '../../types';

// ── repositories ──

/** One entry of a modules.json index: it points at a module's manifest. */
export interface SoraRepoEntry {
  manifestUrl: string;
  name: string;
  description: string;
  iconUrl?: string;
  nsfw: boolean;
}

/** A bare Sora manifest — the module.json one module ships. */
export interface SoraManifest {
  scriptUrl: string;
  sourceName: string;
  type: string;
  language?: string;
  version?: string;
  iconUrl?: string;
  nsfw?: boolean;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Hikari's moduleKind: the manifest's `type` word decides video/manga/novel. */
export function soraModuleKind(type: string): 'video' | 'manga' | 'novel' | null {
  const t = String(type || '').toLowerCase();
  if (/(manga|manhwa|manhua|comic)/.test(t)) return 'manga';
  if (/(novel|book)/.test(t)) return 'novel';
  if (/(anime|movie|show|film|serie|drama|tv|video|cartoon)/.test(t)) return 'video';
  return t.trim() ? null : null;
}

/** Hikari's ExtensionNsfw.repoEntryNsfw, reduced to the shapes these repos use. */
function entryNsfw(record: Record<string, unknown>): boolean {
  if (typeof record.contentWarning === 'string' && record.contentWarning.toLowerCase() === 'content_warning_nsfw') return true;
  const numeric = Number(record.contentWarning);
  if (!Number.isNaN(numeric) && numeric > 0) return true;
  if (record.nsfw === true) return true;
  if (record.nsfw === '1') return true;
  return false;
}

/**
 * A Sora repository: `{modules: [{manifestUrl, …}]}`, or one bare manifest
 * ({scriptUrl, sourceName, …}) standing for a single module.
 */
export function parseSoraRepo(text: string, repoUrl: string): SoraRepoEntry[] {
  const parsed = parseMaybeJson(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('That link is not a Sora repository (its modules.json).');
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.modules)) {
    const out: SoraRepoEntry[] = [];
    const seen = new Set<string>();
    for (const entry of record.modules) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const manifestUrl = typeof item.manifestUrl === 'string' && /^https?:\/\//i.test(item.manifestUrl)
        ? item.manifestUrl.trim()
        : '';
      if (!manifestUrl || seen.has(manifestUrl)) continue;
      seen.add(manifestUrl);
      const name = typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : manifestUrl.split('/').pop()?.replace(/\.json$/i, '') || 'module';
      const category = typeof item.category === 'string' ? item.category.trim() : '';
      const note = typeof item.note === 'string' ? item.note.trim() : '';
      out.push({
        manifestUrl,
        name,
        description: category && note ? `${category} · ${note}` : category || note || 'Sora module',
        iconUrl: typeof item.iconUrl === 'string' && /^https?:\/\//i.test(item.iconUrl) ? item.iconUrl : undefined,
        nsfw: entryNsfw(item),
      });
      if (out.length >= 200) break;
    }
    if (!out.length) throw new Error('That file lists no Sora modules.');
    return out;
  }
  // A bare manifest is one module.
  const manifest = parseSoraManifest(text);
  return [{
    manifestUrl: repoUrl,
    name: manifest.sourceName,
    description: [manifest.language, manifest.type, manifest.version ? `v${manifest.version}` : ''].filter(Boolean).join(' · ') || 'Sora module',
    iconUrl: manifest.iconUrl,
    nsfw: manifest.nsfw === true,
  }];
}

/** A bare Sora module manifest, with the fields the installer needs. */
export function parseSoraManifest(text: string): SoraManifest {
  const parsed = parseMaybeJson(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Module manifest is not JSON');
  const record = parsed as Record<string, unknown>;
  const scriptUrl = typeof record.scriptUrl === 'string' ? record.scriptUrl.trim() : '';
  const sourceName = typeof record.sourceName === 'string' ? record.sourceName.trim() : '';
  if (!scriptUrl) throw new Error('Module manifest has no scriptUrl');
  if (!sourceName) throw new Error('Module manifest has no sourceName');
  return {
    scriptUrl,
    sourceName,
    type: typeof record.type === 'string' ? record.type : '',
    language: typeof record.language === 'string' ? record.language : undefined,
    version: record.version == null ? undefined : String(record.version),
    iconUrl: typeof record.iconUrl === 'string' ? record.iconUrl : undefined,
    nsfw: entryNsfw(record),
  };
}

/** Hikari's id derivation: `sora|<base>`, `sora-manga|<base>`, `sora-novel|<base>`. */
export function soraExtensionKey(manifest: SoraManifest): string {
  const base = (manifest.sourceName || manifest.scriptUrl.split('/').pop()?.replace(/\.[a-z]+$/i, '') || 'module')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 80);
  const kind = soraModuleKind(manifest.type);
  const prefix = kind === 'novel' ? 'sora-novel' : kind === 'manga' ? 'sora-manga' : 'sora';
  return `${prefix}|${base}`;
}

/** Installs one validated Sora module. `kind` comes from a prior validation. */
export function installSoraModule(manifest: SoraManifest, scriptUrl: string, sourceUrl: string, persist = true): EcosystemExtension {
  const kind = soraModuleKind(manifest.type) ?? 'video';
  const extension: EcosystemExtension = {
    key: soraExtensionKey(manifest),
    ecosystem: 'sora',
    id: soraExtensionKey(manifest),
    name: manifest.sourceName,
    url: scriptUrl,
    version: manifest.version ?? '',
    lang: manifest.language ?? 'en',
    kind: kind === 'novel' ? 'novel' : kind === 'manga' ? 'manga' : 'series',
    logo: manifest.iconUrl,
    baseUrl: undefined,
    sourceUrl,
    nsfw: manifest.nsfw === true,
    enabled: true,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  };
  return persist ? installEcosystemExtensions([extension])[0] : extension;
}

// ── the boot prelude ──

/** Hikari's impersonate UAs, verbatim. */
const UA_PRESETS: Record<string, string> = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
};

function soraPrelude(settingsJson: string): string {
  return `
var __soraSettings = ${JSON.stringify(settingsJson)};
globalThis.getSetting = function (k, d) {
  try {
    var o = JSON.parse(globalThis.__soraSettings || '{}');
    var v = o[k];
    return (v === undefined || v === null) ? d : v;
  } catch (e) { return d; }
};
(function () {
  var __h = (typeof http === 'function') ? http : null;
  var __UA = ${JSON.stringify(UA_PRESETS)};
  function bridgeFetch(target, method, headers, body) {
    // MangaDex's public API expects an app identity on native HTTP clients.
    if (target.startsWith('https://api.mangadex.org/') &&
        !Object.keys(headers).some(function (key) { return key.toLowerCase() === 'user-agent'; })) {
      headers = Object.assign({ 'User-Agent': 'PRAHA-STREAM' }, headers);
    }
    return new Promise(function (resolve, reject) {
      if (!__h) { reject(new Error('no http bridge')); return; }
      __h(target, { method: method, headers: headers, body: body || undefined, timeout: 20000 })
        .then(function (res) {
          resolve({ ok: res.status >= 200 && res.status < 300, status: res.status || 0,
            statusText: res.error || '', url: res.url || target,
            headers: res.headers || {}, body: res.text || '',
            text: function () { return Promise.resolve(res.text || ''); },
            json: function () { return Promise.resolve().then(function () { return JSON.parse(res.text || ''); }); } });
        }, function (err) {
          reject(new Error(String((err && err.message) || err || 'fetch failed')));
        });
    });
  }
  globalThis.fetchv2 = function (url, headers, method, body, opts) {
    opts = opts || {};
    var h = {};
    if (headers && typeof headers === 'object') {
      if (Array.isArray(headers)) { for (var i = 0; i < headers.length; i++) h[headers[i][0]] = headers[i][1]; }
      else h = headers;
    }
    var m = String(method || 'GET').toUpperCase();
    if (opts.impersonate && __UA[opts.impersonate] && !h['User-Agent'] && !h['user-agent']) {
      h['User-Agent'] = __UA[opts.impersonate];
    }
    var payload = (m !== 'GET' && m !== 'HEAD' && body != null)
      ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
    return bridgeFetch(String(url), m, h, payload).then(function (res) {
      if (!res.ok) {
        var e = new Error('Request failed with status code ' + res.status);
        e.response = { status: res.status };
        throw e;
      }
      return res;
    });
  };
  // The nuvio-style fetch modules sometimes use: never throws on status.
  globalThis.fetch = function (url, init) {
    init = init || {};
    var h = {};
    if (init.headers) {
      try { new Headers(init.headers).forEach(function (v, k) { h[k] = v; }); }
      catch (e) { h = init.headers; }
    }
    var body = init.body == null ? undefined : (typeof init.body === 'string' ? init.body : String(init.body));
    return bridgeFetch(String(url), String(init.method || 'GET').toUpperCase(), h, body)
      .then(function (res) { return { ok: res.ok, status: res.status, url: res.url, headers: res.headers,
        text: function () { return Promise.resolve(res.body); },
        json: function () { return Promise.resolve().then(function () { try { return JSON.parse(res.body); } catch (e) { return null; } }); } };
      });
  };
})();
`.trim();
}

/**
 * The module's stored settings as the `__soraSettings` JSON string the prelude
 * injects. Values are kept as raw JSON text (a switch is `"true"`, a list is
 * `"[…]"`), so `getSetting` sees the same types Hikari's kv.json holds.
 */
function storedSoraSettings(extension: EcosystemExtension): string {
  const bucket = readEcosystemPrefs(extension.key);
  const parsed: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bucket)) {
    try {
      parsed[key] = JSON.parse(raw);
    } catch {
      parsed[key] = raw;
    }
  }
  return JSON.stringify(parsed);
}

/**
 * The dispatcher the composed script exposes — Hikari's `__soraCall` shape.
 * Sora modules declare their entry points as plain top-level functions inside
 * the script's own scope, so the registry captures them lexically and every
 * host call goes through `__soraDispatch(fnName, argsJson)`.
 */
const SORA_DISPATCH = `
;globalThis.__soraDispatch = function (fnName, argsJson) {
  var registry = {
    searchResults: typeof searchResults === 'function' ? searchResults : undefined,
    extractDetails: typeof extractDetails === 'function' ? extractDetails : undefined,
    extractEpisodes: typeof extractEpisodes === 'function' ? extractEpisodes : undefined,
    extractStreamUrl: typeof extractStreamUrl === 'function' ? extractStreamUrl : undefined,
    extractChapters: typeof extractChapters === 'function' ? extractChapters : undefined,
    getChapters: typeof getChapters === 'function' ? getChapters : undefined,
    extractImages: typeof extractImages === 'function' ? extractImages : undefined,
    getChapterImages: typeof getChapterImages === 'function' ? getChapterImages : undefined,
    extractText: typeof extractText === 'function' ? extractText : undefined,
    __probe: function () {
      return JSON.stringify({
        search: typeof searchResults, details: typeof extractDetails,
        episodes: typeof extractEpisodes, streams: typeof extractStreamUrl,
        chaptersFlat: typeof extractChapters, chaptersAlt: typeof getChapters,
        imagesFlat: typeof extractImages, imagesAlt: typeof getChapterImages,
        text: typeof extractText });
    }
  };
  var f = registry[fnName];
  if (typeof f !== 'function') return Promise.resolve({ ok: false, error: 'module does not export ' + fnName });
  var args = [];
  try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
  return Promise.resolve().then(function () { return f.apply(null, args); }).then(
    function (r) { return { ok: true, data: r === undefined ? null : r }; },
    function (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 400) }; }
  );
};
`;

/** The composed script a Sora module runs as: prelude + source + dispatcher. */
async function composeSora(extension: EcosystemExtension): Promise<string> {
  const source = await fetchEcosystemScript(extension.url);
  return `${soraPrelude(storedSoraSettings(extension))}\n${source}\n${SORA_DISPATCH.trim()}`;
}

/** The `{"ok", data|error}` envelope one module call answers. */
export async function callSora(
  extension: EcosystemExtension,
  fnName: string,
  args: unknown[],
  options: { stream?: boolean; catalog?: boolean } = {},
): Promise<{ ok: boolean; data?: unknown; error?: string; log: string[] }> {
  // Hikari's budgets: 75 s most calls, 18 s a stream answer.
  const budget = options.stream ? 18000 : 75000;
  try {
    const code = await composeSora(extension);
    return await runEcosystemCall(extension, code, '__soraDispatch', [fnName, JSON.stringify(args)], {
      timeoutMs: budget,
      envelope: true,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), log: [] };
  }
}

/** Hikari's runFirstOk: try the module's two names, take the first that answers. */
async function callSoraFirstOk(
  extension: EcosystemExtension,
  names: string[],
  args: unknown[],
): Promise<{ ok: boolean; data?: unknown; error?: string; log: string[] }> {
  let last: { ok: boolean; data?: unknown; error?: string; log: string[] } = { ok: false, error: 'no entry point', log: [] };
  for (const name of names) {
    const answer = await callSora(extension, name, args);
    last = answer;
    if (answer.ok) return answer;
  }
  return last;
}

/** Hikari's install-time validation: one complete entry-point set must exist. */
export async function validateSora(extension: EcosystemExtension, kind: 'video' | 'manga' | 'novel'): Promise<{ ok: boolean; error?: string }> {
  try {
    const code = await composeSora(extension);
    const answer = await runEcosystemCall(extension, code, '__soraDispatch', ['__probe', '[]'], {
      timeoutMs: 25000,
      envelope: true,
    });
    if (!answer.ok) return { ok: false, error: answer.error };
    let report: Record<string, unknown> = {};
    try {
      report = typeof answer.data === 'string' ? JSON.parse(answer.data) : ((answer.data as Record<string, unknown>) || {});
    } catch {
      return { ok: false, error: 'the module probe was unreadable' };
    }
    const asFunction = (value: unknown): boolean => value === 'function';
    const required = kind === 'video'
      ? [report.search, report.details, report.episodes, report.streams]
      : kind === 'manga'
        ? [report.search, report.details,
           asFunction(report.chaptersFlat) || asFunction(report.chaptersAlt),
           asFunction(report.imagesFlat) || asFunction(report.imagesAlt)]
        : [report.search, report.details,
           asFunction(report.chaptersFlat) || asFunction(report.chaptersAlt),
           asFunction(report.text)];
    const missing = required.filter((value) => value !== 'function' && value !== true);
    if (missing.length) return { ok: false, error: 'it does not export the Sora entry points' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── data mapping (SoraProvider / SoraMangaProvider) ──

const MAX_ITEMS = 120;
const MAX_EPISODES = 2000;
const MAX_STREAMS = 60;

const asString = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** SoraProvider's one-pass entity decoder. */
function decodeEntities(input: string): string {
  let text = String(input || '');
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
  text = text.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
  return text;
}

/** A module answer that may arrive as a JSON string, an object, or an array. */
function dataOf(answer: { ok: boolean; data?: unknown }): unknown {
  if (!answer.ok) return null;
  const data = answer.data ?? null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return data;
      }
    }
    return data;
  }
  return data;
}

const isErrorWord = (value: string): boolean => ['error', 'not found', 'notfound', 'failed', '404'].includes(value.trim().toLowerCase());

/** SoraProvider's isErrorList guard: one bogus entry is a failure, not a title. */
function isErrorList(list: unknown[]): boolean {
  if (list.length !== 1 || !list[0] || typeof list[0] !== 'object') return false;
  const record = list[0] as Record<string, unknown>;
  for (const key of ['title', 'id', 'href', 'name']) {
    const value = asString(record[key]);
    if (value && isErrorWord(value)) return true;
  }
  return false;
}

/** A search/catalog item: `href` is its id, `title|name` its name. */
function toMediaItem(extension: EcosystemExtension, raw: Record<string, unknown>): MediaItem | null {
  const own = asString(raw.href).trim();
  const title = decodeEntities(asString(raw.title).trim() || asString(raw.name).trim());
  if (!own || !title) return null;
  const poster = asString(raw.image).trim() || asString(raw.imageURL).trim() || asString(raw.poster).trim();
  return {
    id: `${extension.key}:${own}`,
    type: 'series',
    title,
    overview: '',
    poster,
    genres: [],
    source: 'sora',
    providerId: extension.key,
    providerMediaId: own,
    addonType: 'anime',
  };
}

function toSoraItems(extension: EcosystemExtension, data: unknown): MediaItem[] {
  if (!Array.isArray(data) || isErrorList(data)) return [];
  const out: MediaItem[] = [];
  for (const entry of data.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = toMediaItem(extension, entry as Record<string, unknown>);
    if (item) out.push(item);
  }
  return out;
}

/**
 * The six fixed catalog rows and their search seeds — AnymeX parity, since Sora
 * modules expose no browse endpoint. Page N asks the N-th seed; past the last
 * seed the row ends instead of repeating.
 */
export const SORA_CATALOGS: Array<{ id: string; name: string; seeds: string[] }> = [
  { id: 'browse', name: 'Browse', seeds: ['One Piece', 'a', 'the', '1', '2024', '2025'] },
  { id: 'popular', name: 'Popular', seeds: ['One Piece', 'popular', 'top', 'trending', 'best'] },
  { id: 'movies', name: 'Movies', seeds: ['movie', 'film', 'cinema'] },
  { id: 'series', name: 'Series', seeds: ['series', 'show', 'drama', 'episode'] },
  { id: 'action', name: 'Action', seeds: ['action', 'adventure', 'war'] },
  { id: 'romance', name: 'Romance', seeds: ['romance', 'love', 'romantic'] },
];

/** One catalog page: this page's seed, then neighbours, until one yields items. */
export async function soraCatalogPage(extension: EcosystemExtension, catalogId: string, page: number): Promise<MediaItem[]> {
  const catalog = SORA_CATALOGS.find((entry) => entry.id === catalogId) ?? SORA_CATALOGS[0];
  const index = Math.max(1, page) - 1;
  if (index >= catalog.seeds.length) return [];
  const seeds = catalog.seeds.slice(index).concat(catalog.seeds.slice(0, index));
  for (const seed of seeds) {
    const answer = await callSora(extension, 'searchResults', [seed, 1, []], { catalog: true });
    const items = toSoraItems(extension, dataOf(answer));
    if (items.length) return items;
  }
  return [];
}

export async function soraSearch(extension: EcosystemExtension, query: string, page = 1): Promise<MediaItem[]> {
  if (!query.trim()) return [];
  const args = [query.trim(), Math.max(1, page), []];
  const answer = await callSora(extension, 'searchResults', args, { catalog: true });
  const items = toSoraItems(extension, dataOf(answer));
  if (items.length || page !== 1 || (extension.kind !== 'manga' && extension.kind !== 'novel')) return items;
  const firstPage = await callSora(extension, 'searchResults', [query.trim(), 0, []], { catalog: true });
  return toSoraItems(extension, dataOf(firstPage));
}

export async function soraDetail(extension: EcosystemExtension, ownId: string, known?: MediaItem): Promise<MediaItem | null> {
  if (!ownId) return null;
  const answer = await callSora(extension, 'extractDetails', [ownId], { catalog: true });
  const data = dataOf(answer);
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return known ?? null;
  const record = first as Record<string, unknown>;
  const aliases = asString(record.aliases).trim();
  const title = aliases ? decodeEntities(aliases.split(',')[0].trim()) : known?.title ?? '';
  return {
    ...(known ?? { id: `${extension.key}:${ownId}`, type: 'series' as const, title, overview: '', poster: '', genres: [] as string[], source: 'sora' as const, providerId: extension.key, providerMediaId: ownId }),
    title: title || known?.title || '',
    overview: decodeEntities(asString(record.description).trim()) || known?.overview || '',
  };
}

export interface SoraEpisode {
  id: string;
  number: number;
  season: number;
  name: string;
}

/**
 * `extractEpisodes`' answer, in every shape modules write it: a flat array, an
 * object hiding the list under `episodes|list|results|data|chapters`, or the
 * grouped `{lang: [[number, [episode…]]]}` form the kanzen/shirox modules use.
 */
export function soraEpisodeList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return isErrorList(data) ? [] : data.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  for (const key of ['episodes', 'list', 'results', 'data', 'chapters']) {
    if (Array.isArray(record[key])) return record[key] as Array<Record<string, unknown>>;
  }
  // The grouped form: every `[number, [episodes]]` pair flattens, its pair
  // number injected when the episode lacks one.
  const flat: Array<Record<string, unknown>> = [];
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length < 2 || !Array.isArray(pair[1])) continue;
      const number = Number(pair[0]);
      for (const episode of pair[1]) {
        if (!episode || typeof episode !== 'object') continue;
        const item = { ...(episode as Record<string, unknown>) };
        if (item.number == null && !Number.isNaN(number)) item.number = number;
        flat.push(item);
      }
    }
  }
  return flat;
}

export async function soraEpisodes(extension: EcosystemExtension, ownId: string): Promise<SoraEpisode[]> {
  if (!ownId) return [];
  const answer = await callSora(extension, 'extractEpisodes', [ownId], { catalog: true });
  const list = soraEpisodeList(dataOf(answer));
  const out: SoraEpisode[] = [];
  list.slice(0, MAX_EPISODES).forEach((record, index) => {
    const id = asString(record.href).trim() || asString(record.url).trim() || asString(record.link).trim() || asString(record.id).trim();
    if (!id) return;
    const numberCandidates = [record.number, record.episode, record.ep, record.chapter];
    let number = 0;
    for (const candidate of numberCandidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) {
        number = Math.floor(value);
        break;
      }
    }
    if (!number) {
      const text = parseFloat(asString(record.number) || asString(record.chapter));
      if (Number.isFinite(text) && text > 0) number = Math.floor(text);
    }
    out.push({
      id,
      number: number || index + 1,
      season: Math.max(1, Math.floor(Number(record.season) || 1)),
      name: decodeEntities(asString(record.title).trim() || asString(record.name).trim()),
    });
  });
  // Upstream: an ascending list is oldest-first, and the app shows newest-first.
  if (out.length > 1 && out[0].number < out[out.length - 1].number) out.reverse();
  return out;
}

const ASCII_PRINTABLE = (value: string): string =>
  [...value].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126).join('');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function readSoraStream(raw: Record<string, unknown>, extensionName: string): StreamResult | null {
  const url = asString(raw.streamUrl).trim() || asString(raw.url).trim() || asString(raw.file).trim() || asString(raw.link).trim();
  if (!url) return null;
  const name = decodeEntities(asString(raw.title).trim() || asString(raw.name).trim()) || extensionName;
  const quality = asString(raw.quality).trim() || asString(raw.resolution).trim();
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (value == null) continue;
      headers[key] = ASCII_PRINTABLE(String(value));
    }
  }
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = UA;
  try {
    const origin = new URL(url).origin;
    if (!headers['Referer'] && !headers['referer'] && /^https?:\/\//i.test(url)) headers['Referer'] = `${origin}/`;
  } catch { /* a non-URL stream keeps no Referer */ }
  const subtitles: StreamSubtitle[] = [];
  if (Array.isArray(raw.subtitles)) {
    for (const sub of raw.subtitles) {
      if (!sub || typeof sub !== 'object') continue;
      const record = sub as Record<string, unknown>;
      const su = asString(record.url).trim() || asString(record.file).trim();
      if (!su) continue;
      const label = asString(record.label).trim() || asString(record.lang).trim() || 'Sub';
      subtitles.push({
        id: su,
        language: label,
        url: su,
        name: label,
      });
    }
  }
  const isTorrent = /^magnet:|^torrent:/i.test(url);
  const details = [quality, asString(raw.size).trim(), asString(raw.language).trim() || asString(raw.lang).trim(), asString(raw.type).trim()]
    .filter(Boolean).join(' • ');
  return {
    id: '',
    url,
    title: quality && !name.includes(quality) ? `${name} ${quality}` : name,
    sourceName: `${extensionName} · Sora`,
    sourceType: 'ecosystem',
    quality: quality || undefined,
    provider: extensionName,
    headers,
    subtitles: subtitles.length ? subtitles : undefined,
    format: url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : undefined,
    infoHash: isTorrent ? url : undefined,
  };
}

/**
 * One module's playable links. `extractStreamUrl`'s answer may be a bare URL
 * string, a `{streams: […]}` object, or any of the loose array keys upstream
 * accepts; a top-level `subtitles` URL attaches to every stream missing one.
 */
export async function soraStreams(extension: EcosystemExtension, ownId: string): Promise<StreamResult[]> {
  if (!ownId) return [];
  const answer = await callSora(extension, 'extractStreamUrl', [ownId], { stream: true });
  if (!answer.ok) return [];
  let data = answer.data ?? null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (/^(https?:\/\/|magnet:)/i.test(trimmed)) {
      const stream = readSoraStream({ url: trimmed }, extension.name);
      return stream ? [{ ...stream, id: `sora:${extension.key}:0` }] : [];
    }
    try {
      data = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  let list: unknown[] = [];
  let globalSubs = '';
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.subtitles === 'string' && /^https?:\/\//i.test(record.subtitles)) globalSubs = record.subtitles;
    for (const key of ['streams', 'results', 'sources', 'data', 'list']) {
      if (Array.isArray(record[key])) {
        list = record[key] as unknown[];
        break;
      }
    }
    if (!list.length && (record.streamUrl || record.url)) list = [record];
  }
  const results: StreamResult[] = [];
  const seen = new Set<string>();
  for (const entry of list.slice(0, MAX_STREAMS)) {
    let raw: Record<string, unknown> | null = null;
    if (typeof entry === 'string' && /^(https?:\/\/|magnet:)/i.test(entry)) raw = { url: entry };
    else if (entry && typeof entry === 'object') raw = entry as Record<string, unknown>;
    if (!raw) continue;
    const stream = readSoraStream(raw, extension.name);
    if (!stream || seen.has(stream.url)) continue;
    seen.add(stream.url);
    if (globalSubs && !stream.subtitles?.length) {
      stream.subtitles = [{ id: globalSubs, language: 'Sub', url: globalSubs, name: 'Sub' }];
    }
    results.push({ ...stream, id: `sora:${extension.key}:${results.length}` });
  }
  return results;
}

// ── module settings ──

/** One settings field, normalised the way Hikari's normalizeSettings leaves it. */
export interface SoraSettingField {
  key: string;
  type: 'edit_text' | 'switch' | 'list' | 'multi_select';
  title: string;
  summary: string;
  entries: string[];
  entryValues: string[];
  /** The stored value, typed: boolean for a switch, string[] for multi_select. */
  value?: string | boolean | string[];
}

/**
 * The module's settings schema, read the way SoraRuntime.moduleSettings reads
 * it: a `getSettings()` array wins, then the raw `settings` map — whose keys
 * become entries with an inferred type. Stored values merge in per key.
 */
export async function soraSettingsSchema(extension: EcosystemExtension): Promise<SoraSettingField[]> {
  try {
    const code = await composeSora(extension);
    const answer = await runEcosystemCall(
      extension,
      `${code}\n;globalThis.__soraSettingsProbe = function () {\n  if (typeof getSettings === 'function') { try { return JSON.stringify(getSettings() || []); } catch (e) {} }\n  if (typeof settings === 'object' && settings) return JSON.stringify(settings);\n  return '[]';\n};`,
      '__soraSettingsProbe',
      [],
      { timeoutMs: 25000 },
    );
    if (!answer.ok) return [];
    const stored = readEcosystemPrefs(extension.key);
    const raw = typeof answer.data === 'string' ? JSON.parse(answer.data) : answer.data;
    const storedValue = (key: string, fallback: unknown): unknown => {
      const rawStored = stored[key];
      if (rawStored === undefined) return fallback;
      try {
        return JSON.parse(rawStored);
      } catch {
        return rawStored;
      }
    };
    if (Array.isArray(raw)) {
      const fields: SoraSettingField[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const key = asString(record.key).trim();
        if (!key) continue;
        const type = asString(record.type).trim() === 'list' ? 'list'
          : asString(record.type).trim() === 'multi_select' ? 'multi_select'
            : asString(record.type).trim() === 'switch' || asString(record.type).trim() === 'checkBox' ? 'switch'
              : 'edit_text';
        const entries = Array.isArray(record.entries) ? record.entries.map(asString) : [];
        const entryValues = Array.isArray(record.entryValues) ? record.entryValues.map(asString) : [];
        const value = storedValue(key, type === 'switch' ? record.value === true || record.value === 'true' : type === 'multi_select' ? (Array.isArray(record.values) ? record.values.map(asString) : []) : asString(record.value));
        fields.push({
          key,
          type,
          title: asString(record.title).trim() || key,
          summary: asString(record.summary).trim(),
          entries,
          entryValues,
          ...(type === 'switch' ? { value: value === true || value === 'true' } : type === 'multi_select' ? { value: Array.isArray(value) ? value.map(String) : [] } : { value: asString(value) }),
        });
      }
      return fields;
    }
    if (raw && typeof raw === 'object') {
      return Object.entries(raw as Record<string, unknown>).map(([key, fallback]) => {
        const value = storedValue(key, fallback);
        if (typeof fallback === 'boolean') return { key, type: 'switch' as const, title: key, summary: '', entries: [], entryValues: [], value: value === true || value === 'true' };
        if (Array.isArray(fallback)) return { key, type: 'multi_select' as const, title: key, summary: '', entries: fallback.map(asString), entryValues: fallback.map(asString), value: Array.isArray(value) ? value.map(String) : [] };
        return { key, type: 'edit_text' as const, title: key, summary: '', entries: [], entryValues: [], value: asString(value) };
      });
    }
    return [];
  } catch {
    return [];
  }
}

/** Saves one setting the way Hikari's dialog does: raw JSON text per key. */
export function saveSoraSetting(extension: EcosystemExtension, field: SoraSettingField, value: string | boolean | string[]): void {
  const raw = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  writeEcosystemPref(extension.key, field.key, raw);
}

// ── manga / novel ──

export interface SoraChapter {
  id: string;
  number: number;
  name: string;
}

/** `extractChapters`/`getChapters`, flat or grouped `{lang: [[num, [chapter…]]]}`. */
export async function soraChapters(extension: EcosystemExtension, ownId: string): Promise<SoraChapter[]> {
  if (!ownId) return [];
  const answer = await callSoraFirstOk(extension, ['extractChapters', 'getChapters'], [ownId], );
  const data = dataOf(answer);
  const out: SoraChapter[] = [];
  const readFlat = (list: unknown[]) => {
    list.forEach((entry, index) => {
      let raw: Record<string, unknown> | null = null;
      if (typeof entry === 'string') raw = { href: entry, title: `Chapter ${index + 1}` };
      else if (entry && typeof entry === 'object') raw = entry as Record<string, unknown>;
      if (!raw) return;
      const id = asString(raw.id).trim() || asString(raw.href).trim();
      if (!id) return;
      const chapterNumber = Number(raw.chapter);
      const number = Number.isFinite(chapterNumber) && chapterNumber > 0
        ? Math.floor(chapterNumber)
        : index + 1;
      out.push({ id, number, name: asString(raw.title).trim() || `Chapter ${number}` });
    });
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    // The kanzen grouped form: read the "en" key's [number, [chapters]] pairs.
    const grouped = record.en;
    if (Array.isArray(grouped)) {
      for (const pair of grouped) {
        if (!Array.isArray(pair) || pair.length < 2 || !Array.isArray(pair[1])) continue;
        const number = Number(pair[0]);
        for (const chapter of pair[1]) {
          if (!chapter || typeof chapter !== 'object') continue;
          const item = chapter as Record<string, unknown>;
          const id = asString(item.id).trim() || asString(item.href).trim();
          if (!id) continue;
          const chapterNumber = Number(item.chapter);
          out.push({
            id,
            number: Number.isFinite(chapterNumber) && chapterNumber > 0 ? Math.floor(chapterNumber)
              : Number.isFinite(number) && number > 0 ? Math.floor(number) : out.length + 1,
            name: asString(item.title).trim() || `Chapter ${out.length + 1}`,
          });
        }
      }
      if (out.length) return out;
    }
  }
  if (Array.isArray(data)) readFlat(data);
  else if (data && typeof data === 'object') {
    for (const key of ['chapters', 'list', 'results', 'data']) {
      const nested = (data as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        readFlat(nested);
        break;
      }
    }
  }
  return out;
}

/** `extractImages`/`getChapterImages`: page URLs, bare strings or `{url|image}`. */
export async function soraPages(extension: EcosystemExtension, chapterId: string): Promise<string[]> {
  if (!chapterId) return [];
  const answer = await callSoraFirstOk(extension, ['extractImages', 'getChapterImages'], [chapterId]);
  const data = dataOf(answer);
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const entry of data) {
    if (typeof entry === 'string' && /^https?:\/\//i.test(entry)) out.push(entry);
    else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const url = asString(record.url).trim() || asString(record.image).trim();
      if (url) out.push(url);
    }
  }
  return out;
}

/** Novel text: `extractText` answers raw HTML (or `{body}`). */
export async function soraNovelText(extension: EcosystemExtension, chapterId: string): Promise<string> {
  if (!chapterId) return '';
  const answer = await callSora(extension, 'extractText', [chapterId], { catalog: true });
  const data = dataOf(answer);
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    return asString(record.body);
  }
  return '';
}
