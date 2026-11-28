// Zangetsu extension providers — anime and movie sources written as one
// `provider.js` of global functions (`getHome`, `popular`, `search`,
// `getDetail`, `getEpisodes`, `getVideoSources`).
//
// A port of Hikari's `zangetsu/ZangetsuRuntime.kt`, `ZangetsuPluginManager.kt`
// and `ZangetsuProvider.kt` (GPL-3.0-or-later, Copyright (C) 2026 Codegeasse).
// The boot prelude below keeps the contract upstream's QuickJS engine boots
// with — `fetch` answering `{body, status, headers, url}` and rejecting on a
// non-2xx, `htmlText`, `absUrl`, `__SOURCE_ID`, `__settings` — except the timer
// pump and the base64 helpers: a browser worker has real timers and native
// atob/btoa, so those parts of the boot script are dropped, not reimplemented.
//
// Every network call leaves through the worker's guarded `http()`; the prelude
// installs `fetch` over it, so a provider has the same single door out a PRAHA
// plugin has. `api.themoviedb.org` requests get the TMDB-key placeholder the
// main thread rewrites, the way Hikari attaches its key.

import { runEcosystemCall } from '../pluginRuntime';
import { fetchEcosystemScript } from './scripts';
import { installEcosystemExtensions, type EcosystemExtension } from './store';
import { nativeFetchText } from '../androidBridge';
import type { MediaItem, StreamResult } from '../../types';

// ── repositories ──

/** One entry of a Zangetsu `index.json`, as the manager lists it. */
export interface ZangetsuRepoEntry {
  id: string;
  name: string;
  url: string;
  version: string;
  type: string;
  lang: string;
  logo?: string;
}

/** Hikari's `resolveUrl`: a repo-relative path against the manifest's folder. */
function resolveRepoUrl(manifestUrl: string, ref: string): string {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = manifestUrl.trim().replace(/[?#].*$/, '');
  const folder = base.slice(0, base.lastIndexOf('/') + 1);
  try {
    return new URL(raw, folder).toString();
  } catch {
    return '';
  }
}

/**
 * A Zangetsu repository manifest: an array of `{id, file, name?, version?,
 * type?, lang?, logo?}`. Entries without an id or file are skipped; the 2 MB
 * script cap is enforced at download, not listing.
 */
export function parseZangetsuRepo(text: string, manifestUrl: string): ZangetsuRepoEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That link is not a Zangetsu repository (its index.json).');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      // The official repo (Spyou/zangetsu-providers) lists its entries under
      // `sources`; other repos write `providers` or a bare array.
      ? (['sources', 'providers'] as const)
          .map((key) => (parsed as Record<string, unknown>)[key])
          .find((value): value is unknown[] => Array.isArray(value)) ?? []
      : [];
  const out: ZangetsuRepoEntry[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const file = resolveRepoUrl(manifestUrl, typeof record.file === 'string' ? record.file : '');
    if (!id || !file || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
      url: file,
      version: record.version == null ? '' : String(record.version),
      type: typeof record.type === 'string' ? record.type.trim().toLowerCase() : '',
      lang: typeof record.lang === 'string' && record.lang.trim() ? record.lang.trim() : 'en',
      logo: resolveRepoUrl(manifestUrl, typeof record.logo === 'string' ? record.logo : '') || undefined,
    });
    if (out.length >= 200) break;
  }
  if (!out.length) throw new Error('That file lists no Zangetsu providers.');
  return out;
}

/** Installs (or refreshes) the entries a repository listed. */
export function installZangetsuEntries(entries: ZangetsuRepoEntry[], sourceUrl: string, persist = true): EcosystemExtension[] {
  const extensions = entries.map((entry): EcosystemExtension => ({
    key: `zangetsu:${entry.id}`,
    ecosystem: 'zangetsu' as const,
    id: entry.id,
    name: entry.name,
    url: entry.url,
    version: entry.version,
    lang: entry.lang,
    kind: entry.type.includes('anime') ? ('anime' as const)
      : entry.type.includes('movie') ? ('movie' as const)
        : ('series' as const),
    logo: entry.logo,
    sourceUrl,
    enabled: true,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  }));
  return persist ? installEcosystemExtensions(extensions) : extensions;
}

// ── the boot prelude ──

const jsonQuote = (value: string): string => JSON.stringify(value);

/**
 * The globals a Zangetsu provider is written against, evaluated before its
 * source. A direct port of ZangetsuRuntime's bootJs minus the QuickJS-only
 * parts (timers exist here; atob/btoa are native).
 */
function zangetsuPrelude(extension: Pick<EcosystemExtension, 'id'>): string {
  return `
var __SOURCE_ID = ${jsonQuote(extension.id)};
var __settings = {};
(function () {
  var __h = (typeof http === 'function') ? http : null;
  function zFetch(url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!__h) { reject(new Error('no http bridge')); return; }
      var method = String(opts.method || 'GET').toUpperCase();
      var target = String(url == null ? '' : url);
      if (method === 'GET' && /api\\.themoviedb\\.org/i.test(target) && !/api_key=/i.test(target)) {
        target += (target.indexOf('?') >= 0 ? '&' : '?') + 'api_key=__PRAHA_TMDB__';
      }
      var headers = {};
      try { if (opts.headers && typeof opts.headers === 'object') headers = opts.headers; } catch (e) {}
      var body = '';
      try {
        if (typeof opts.body === 'string') body = opts.body;
        else if (opts.body != null) body = JSON.stringify(opts.body);
      } catch (e) {}
      __h(target, { method: method, headers: headers, body: body || undefined, timeout: 20000 })
        .then(function (res) {
          var ok = res.status >= 200 && res.status < 300;
          var payload = { body: res.text || '', status: res.status || 0, headers: res.headers || {}, url: res.url || target };
          if (ok) resolve(payload);
          else reject(new Error(res.error || ('HTTP ' + res.status)));
        }, function (err) {
          reject(new Error(String((err && err.message) || err || 'fetch failed')));
        });
    });
  }
  globalThis.fetch = zFetch;
  globalThis.htmlText = function (s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ');
    t = t.replace(/<style[\\s\\S]*?<\\/style>/gi, ' ');
    t = t.replace(/<[^>]*>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ');
    t = t.replace(/&amp;/gi, '&');
    t = t.replace(/&lt;/gi, '<');
    t = t.replace(/&gt;/gi, '>');
    t = t.replace(/&quot;/gi, '"');
    t = t.replace(/&#39;|&apos;/gi, "'");
    t = t.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
    t = t.replace(/&#(\\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); });
    t = t.replace(/\\s+/g, ' ');
    return t.replace(/^\\s+|\\s+$/g, '');
  };
  globalThis.absUrl = function (href, base) {
    var h = String(href == null ? '' : href).trim();
    if (!h) return '';
    if (/^https?:\\/\\//i.test(h)) return h;
    if (h.indexOf('//') === 0) return 'https:' + h;
    var b = String(base == null ? '' : base);
    var m = b.match(/^(https?:\\/\\/[^\\/]+)/i);
    var origin = m ? m[1] : '';
    if (h.charAt(0) === '/') return origin + h;
    return b.replace(/\\/[^\\/]*$/, '/') + h;
  };
})();
`.trim();
}

/**
 * The dispatcher the composed script exposes — Hikari's `__zCall` shape. The
 * provider's entry points are plain top-level function declarations inside the
 * script's own scope, never on globalThis, so the registry captures them
 * lexically and every host call goes through `__zcDispatch(fnName, argsJson)`.
 */
const ZANGETSU_DISPATCH = `
;globalThis.__zcDispatch = function (fnName, argsJson) {
  var registry = {
    getInfo: typeof getInfo === 'function' ? getInfo : undefined,
    getHome: typeof getHome === 'function' ? getHome : undefined,
    popular: typeof popular === 'function' ? popular : undefined,
    search: typeof search === 'function' ? search : undefined,
    getDetail: typeof getDetail === 'function' ? getDetail : undefined,
    getEpisodes: typeof getEpisodes === 'function' ? getEpisodes : undefined,
    getVideoSources: typeof getVideoSources === 'function' ? getVideoSources : undefined,
    __probe: function () {
      return JSON.stringify({ video: typeof getVideoSources, detail: typeof getDetail,
        episodes: typeof getEpisodes, search: typeof search, home: typeof getHome, info: typeof getInfo });
    }
  };
  var f = registry[fnName];
  if (typeof f !== 'function') return Promise.resolve({ ok: false, error: 'provider does not export ' + fnName });
  var args = [];
  try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
  return Promise.resolve().then(function () { return f.apply(null, args); }).then(
    function (r) { return { ok: true, data: r === undefined ? null : r }; },
    function (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  );
};
`;

/** The composed script a Zangetsu provider runs as: prelude + source + dispatcher. */
async function composeZangetsu(extension: EcosystemExtension): Promise<string> {
  const source = await fetchEcosystemScript(extension.url);
  return `${zangetsuPrelude(extension)}\n${source}\n${ZANGETSU_DISPATCH.trim()}`;
}

/** The `{"ok", data|error}` envelope one provider call answers. */
export async function callZangetsu(
  extension: EcosystemExtension,
  fnName: string,
  args: unknown[],
  options: { catalog?: boolean } = {},
): Promise<{ ok: boolean; data?: unknown; error?: string; log: string[] }> {
  // Hikari's budgets: 45 s a call, 50 s a catalogue answer.
  const budget = options.catalog ? 50000 : 45000;
  try {
    const code = await composeZangetsu(extension);
    return await runEcosystemCall(extension, code, '__zcDispatch', [fnName, JSON.stringify(args)], {
      timeoutMs: budget,
      envelope: true,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), log: [] };
  }
}

/** Hikari's install-time validation: getVideoSources plus one more surface. */
export async function validateZangetsu(extension: EcosystemExtension): Promise<{ ok: boolean; error?: string }> {
  try {
    const code = await composeZangetsu(extension);
    const answer = await runEcosystemCall(extension, code, '__zcDispatch', ['__probe', '[]'], {
      timeoutMs: 25000,
      envelope: true,
    });
    if (!answer.ok) return { ok: false, error: answer.error };
    let report: Record<string, unknown> = {};
    try {
      report = typeof answer.data === 'string' ? JSON.parse(answer.data) : ((answer.data as Record<string, unknown>) || {});
    } catch {
      return { ok: false, error: 'the provider probe was unreadable' };
    }
    if (report.video !== 'function') return { ok: false, error: 'it does not export getVideoSources()' };
    const surfaces = ['detail', 'episodes', 'search', 'home'].filter((key) => report[key] === 'function');
    if (!surfaces.length) return { ok: false, error: 'it exports none of getDetail/getEpisodes/search/getHome' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── data mapping (ZangetsuProvider) ──

/** ZangetsuProvider's MAX_ITEMS. */
const MAX_ITEMS = 500;

/** One provider's `{type, name}`, read once — `getInfo` is advisory. */
const infoCache = new Map<string, { type: string; name: string }>();

async function zangetsuInfo(extension: EcosystemExtension): Promise<{ type: string; name: string }> {
  const cached = infoCache.get(extension.key);
  if (cached) return cached;
  const answer = await callZangetsu(extension, 'getInfo', []);
  const data = (answer.ok && answer.data && typeof answer.data === 'object' ? answer.data : {}) as Record<string, unknown>;
  const info = {
    type: String(data.type ?? '').trim().toLowerCase(),
    name: String(data.name ?? '').trim(),
  };
  infoCache.set(extension.key, info);
  return info;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** `mediaTypeOf`: an anime provider's items are series; a blank word follows the provider. */
function mediaTypeOf(raw: string, fallbackAnime: boolean): 'movie' | 'series' {
  const t = raw.trim().toLowerCase();
  if (t === 'movie') return 'movie';
  if (t === 'tv' || t === 'series' || t === 'show') return 'series';
  if (t === 'anime' || (!t && fallbackAnime)) return 'series';
  return fallbackAnime ? 'series' : 'movie';
}

/** A catalog item as PRAHA's MediaItem; its own id travels in providerMediaId. */
function toMediaItem(
  extension: EcosystemExtension,
  raw: Record<string, unknown>,
  fallbackAnime: boolean,
): MediaItem | null {
  const url = asString(raw.url).trim();
  const title = asString(raw.title).trim();
  if (!url || !title) return null;
  const own = asString(raw.id).trim() || url;
  const rawType = asString(raw.type).trim().toLowerCase();
  const anime = rawType === 'anime' || (!rawType && fallbackAnime);
  const poster = asString(raw.cover).trim() || asString(raw.poster).trim() || asString(raw.image).trim();
  const year = Number(raw.year);
  const rating = Number(raw.rating);
  const genres = Array.isArray(raw.genres) ? raw.genres.map(asString).filter(Boolean) : [];
  return {
    id: `${extension.key}:${own}`,
    type: mediaTypeOf(rawType, fallbackAnime),
    title,
    overview: asString(raw.description).trim(),
    poster,
    year: year > 0 ? String(Math.floor(year)) : undefined,
    rating: rating > 0 ? rating : undefined,
    genres,
    source: 'zangetsu',
    providerId: extension.key,
    providerMediaId: own,
    addonType: anime ? 'anime' : rawType || 'movie',
  };
}

function toItems(extension: EcosystemExtension, data: unknown, fallbackAnime: boolean): MediaItem[] {
  if (!Array.isArray(data)) return [];
  const out: MediaItem[] = [];
  for (const entry of data.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = toMediaItem(extension, entry as Record<string, unknown>, fallbackAnime);
    if (item) out.push(item);
  }
  return out;
}

const dataOf = (answer: { ok: boolean; data?: unknown }): unknown => (answer.ok ? answer.data ?? null : null);

/** Hikari's homeRows: the provider's own rows, else one Popular row. */
export async function zangetsuHomeRows(
  extension: EcosystemExtension,
): Promise<Array<{ title: string; items: MediaItem[] }>> {
  const fallbackAnime = (await zangetsuInfo(extension)).type === 'anime';
  const answer = await callZangetsu(extension, 'getHome', [{}], { catalog: true });
  let data = dataOf(answer);
  if (Array.isArray(data) && data.length) {
    const rows: Array<{ title: string; items: MediaItem[] }> = [];
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const title = asString(record.title).trim();
      if (!title) continue;
      const items = toItems(extension, record.items, fallbackAnime);
      if (items.length) rows.push({ title, items });
    }
    if (rows.length) return rows;
  }
  const pop = await callZangetsu(extension, 'popular', [{}], { catalog: true });
  const items = toItems(extension, dataOf(pop), fallbackAnime);
  return items.length ? [{ title: 'Popular', items }] : [];
}

export async function zangetsuSearch(extension: EcosystemExtension, query: string, page = 1): Promise<MediaItem[]> {
  if (!query.trim()) return [];
  const fallbackAnime = (await zangetsuInfo(extension)).type === 'anime';
  const answer = await callZangetsu(extension, 'search', [query.trim(), Math.max(1, page), {}], { catalog: true });
  return toItems(extension, dataOf(answer), fallbackAnime);
}

export async function zangetsuDetail(extension: EcosystemExtension, ownId: string, known?: MediaItem): Promise<MediaItem | null> {
  if (!ownId) return null;
  const fallbackAnime = (await zangetsuInfo(extension)).type === 'anime';
  const answer = await callZangetsu(extension, 'getDetail', [ownId, {}]);
  const data = dataOf(answer);
  if (!data || typeof data !== 'object') return known ?? null;
  const raw = data as Record<string, unknown>;
  const item = toMediaItem(extension, { ...raw, url: asString(raw.url).trim() || ownId }, fallbackAnime);
  return item ?? known ?? null;
}

/** One episode: its id is the token `getVideoSources` is asked with. */
export interface ZangetsuEpisode {
  id: string;
  number: number;
  name: string;
  image?: string;
  overview?: string;
  released?: string;
}

export async function zangetsuEpisodes(extension: EcosystemExtension, ownId: string): Promise<ZangetsuEpisode[] | null> {
  if (!ownId) return null;
  const answer = await callZangetsu(extension, 'getEpisodes', [ownId, {}]);
  const data = dataOf(answer);
  if (!Array.isArray(data)) return null;
  const out: ZangetsuEpisode[] = [];
  data.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const url = asString(record.url).trim();
    if (!url) return;
    const number = Number(record.number);
    out.push({
      id: url,
      number: number > 0 ? Math.floor(number) : index + 1,
      name: asString(record.title).trim() || `Episode ${index + 1}`,
      image: asString(record.thumbnail).trim() || undefined,
      overview: asString(record.description).trim() || undefined,
      released: asString(record.date).trim() || undefined,
    });
  });
  return out.length ? out : null;
}

// ── streams ──

/**
 * The packed-episode schemes Hikari's ZangetsuProvider keeps: a movie provider
 * whose episode id is `<scheme><url-encoded JSON of hub links>` instead of a
 * page URL, unpacked by its own getVideoSources.
 */
const PACK_SCHEMES: Record<string, string> = {
  fourkhdhub: '4khd://',
  uhdmovies: 'uhd://',
  hdhub4u: 'hdh://',
  vegamovies: 'vega://',
};

const isPackedId = (id: string): boolean => id.includes('://') && !/^https?:\/\//i.test(id);

/** Hikari's isHubHref: the link-farm hosts a movie page's download buttons sit on. */
function isHubHref(href: string): boolean {
  const h = href.toLowerCase();
  if (!/^https?:\/\//.test(h)) return false;
  if (/youtube\.com|youtu\.be|facebook\.com|twitter\.com|instagram\.com|telegram\.me|t\.me\//.test(h)) return false;
  const path = h.split(/[?#]/)[0];
  if (/\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|mp4|mkv|m3u8|mpd)$/.test(path)) return false;
  return /hubcloud|hubdrive|hblinks|hubcdn|hubstream|hdstream|greenmotors|pixeldra|gadgets|thenaukriadda|[?&]sid=|[?&]id=|\/redirect|\/links|maxbutton|hrefli|vcloud|gdflix|driveseed|driveleech|filepress|[?&]go=|\/go\/|unblockedgames/.test(h);
}

/** The hub links on one detail page, fetched once per page per session. */
const harvestCache = new Map<string, string[]>();

async function pageHtml(pageUrl: string): Promise<string> {
  try {
    const answer = await nativeFetchText(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      timeoutMs: 15000,
    });
    return answer.data || '';
  } catch {
    return '';
  }
}

function pageOrigin(pageUrl: string): string {
  const match = pageUrl.trim().match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function absPageUrl(href: string, origin: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^javascript:/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `https:${h}`;
  if (!origin) return null;
  return h.startsWith('/') ? origin + h : `${origin}/${h}`;
}

async function harvestHubLinks(pageUrl: string): Promise<string[]> {
  const cached = harvestCache.get(pageUrl);
  if (cached) return cached;
  const html = await pageHtml(pageUrl);
  const out: string[] = [];
  const origin = pageOrigin(pageUrl);
  for (const match of html.matchAll(/<a[^>]+href\s*=\s*"([^"]+)"/gi)) {
    const href = absPageUrl(match[1].trim(), origin);
    if (!href || !isHubHref(href)) continue;
    if (!out.some((existing) => existing.toLowerCase() === href.toLowerCase())) out.push(href);
    if (out.length >= 12) break;
  }
  harvestCache.set(pageUrl, out);
  return out;
}

/** The direct media files the page itself carries, when the farm is dead. */
async function harvestDirectMedia(pageUrl: string): Promise<string[]> {
  const html = await pageHtml(pageUrl);
  if (!html) return [];
  const origin = pageOrigin(pageUrl);
  const out: string[] = [];
  for (const match of html.matchAll(/(?:href|src|data-src|content)\s*=\s*"([^"]+)"/gi)) {
    const href = absPageUrl(match[1].trim(), origin);
    if (!href) continue;
    const path = href.split(/[?#]/)[0].toLowerCase();
    if (!/^https?:\/\//.test(path)) continue;
    if (!/\.(mp4|mkv|m3u8|mpd)/.test(path)) continue;
    if (!out.some((existing) => existing.toLowerCase() === href.toLowerCase())) out.push(href);
    if (out.length >= 8) break;
  }
  return out;
}

/** One stream the provider listed, as it arrives from getVideoSources. */
interface ZangetsuRawStream {
  url: string;
  quality: string;
  container: string;
  label: string;
  headers: Record<string, string>;
  subtitles: Array<{ lang: string; url: string; name: string }>;
}

function readStream(raw: Record<string, unknown>): ZangetsuRawStream | null {
  const url = asString(raw.url).trim();
  if (!url) return null;
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (value != null) headers[key] = String(value);
    }
  }
  const subtitles: ZangetsuRawStream['subtitles'] = [];
  if (Array.isArray(raw.subtitles)) {
    for (const sub of raw.subtitles) {
      if (!sub || typeof sub !== 'object') continue;
      const record = sub as Record<string, unknown>;
      const su = asString(record.url).trim() || asString(record.file).trim();
      if (!su) continue;
      subtitles.push({
        lang: asString(record.lang).trim() || asString(record.label).trim() || 'sub',
        url: su,
        name: asString(record.label).trim(),
      });
    }
  }
  return {
    url,
    quality: asString(raw.quality).trim() || 'auto',
    container: asString(raw.container).trim().toLowerCase(),
    label: asString(raw.label).trim(),
    headers,
    subtitles,
  };
}

function toStreamResult(extension: EcosystemExtension, stream: ZangetsuRawStream, index: number): StreamResult {
  const label = [stream.quality, stream.container, stream.label].filter(Boolean).join(' • ');
  const isM3u8 = stream.container === 'hls' || stream.container === 'm3u8' || stream.url.includes('.m3u8');
  const isMpd = stream.container === 'mpd' || stream.url.includes('.mpd');
  return {
    id: `zangetsu:${extension.key}:${index}`,
    url: stream.url,
    title: label,
    sourceName: `${extension.name} · Zangetsu`,
    sourceType: 'ecosystem',
    quality: stream.quality,
    provider: extension.name,
    headers: stream.headers,
    format: isM3u8 ? 'hls' : isMpd ? 'dash' : undefined,
    subtitles: stream.subtitles.length
      ? stream.subtitles.map((sub, subIndex) => ({
          id: `zangetsu:${extension.key}:${index}:${subIndex}`,
          language: sub.lang,
          url: sub.url,
          name: sub.name || sub.lang,
        }))
      : undefined,
  };
}

/**
 * One provider's playable links for an episode (or a movie).
 *
 * The packed-movie path is Hikari's: a provider whose getVideoSources answers
 * nothing for a bare page link is re-asked with the page's hub links packed
 * behind its own scheme, and a page that carries media files directly is played
 * from those before giving up.
 */
export async function zangetsuStreams(extension: EcosystemExtension, ownId: string): Promise<StreamResult[]> {
  if (!ownId) return [];
  const callStreams = async (epUrl: string) => {
    const answer = await callZangetsu(extension, 'getVideoSources', [epUrl]);
    return Array.isArray(answer.data) ? (answer.data as unknown[]) : [];
  };

  let raws = (await callStreams(ownId))
    .map((entry) => (entry && typeof entry === 'object' ? readStream(entry as Record<string, unknown>) : null))
    .filter((entry): entry is ZangetsuRawStream => entry !== null);
  if (raws.length) return raws.map((stream, index) => toStreamResult(extension, stream, index));

  // The packed-movie rescue: only for a bare page link on a provider known to
  // pack, and only when the page is reachable.
  const scheme = PACK_SCHEMES[extension.id];
  if (scheme && /^https?:\/\//i.test(ownId)) {
    const hrefs = await harvestHubLinks(ownId);
    if (hrefs.length) {
      const repacked = scheme + encodeURIComponent(JSON.stringify(hrefs));
      raws = (await callStreams(repacked))
        .map((entry) => (entry && typeof entry === 'object' ? readStream(entry as Record<string, unknown>) : null))
        .filter((entry): entry is ZangetsuRawStream => entry !== null);
      if (raws.length) return raws.map((stream, index) => toStreamResult(extension, stream, index));
    }
    const direct = await harvestDirectMedia(ownId);
    if (direct.length) {
      return direct.map((url, index) => {
        const lower = url.split(/[?#]/)[0].toLowerCase();
        const result = toStreamResult(
          extension,
          {
            url,
            quality: 'auto',
            container: lower.includes('.m3u8') ? 'hls' : lower.includes('.mpd') ? 'mpd' : '',
            label: 'direct file',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Referer: ownId,
            },
            subtitles: [],
          },
          index,
        );
        result.title = `${extension.name} [direct]`;
        return result;
      });
    }
  }
  return [];
}

/** Test seam: forget the per-provider and per-page caches. */
export function resetZangetsuCaches(): void {
  harvestCache.clear();
  infoCache.clear();
}

// `isPackedId` stays exported for the tests, mirroring upstream's marker check.
export { isPackedId };
