import { nativeFetchText, safeRemoteUrl } from './androidBridge';
import type { MediaItem, StreamResult } from '../types';

/**
 * JSON-rule based scraper — port of Hikari's UniversalScraper.kt
 * (app/src/main/java/com/hikari/app/providers/UniversalScraper.kt, GPL-3.0).
 *
 * The `extra` config holds the full rules. Two modes:
 *
 * 1) HTML mode — plain selector rules:
 * {
 *   "name": "MySite", "baseUrl": "https://...", "homeUrl": "/",
 *   "catalogs": [{"id":"home","name":"Home","type":"movie"}],
 *   "search": { "url": "/search?q={query}", "item": ".item", "title": ".title",
 *               "href": "a@href", "poster": "img@src" },
 *   "detail": { "title": "h1", "poster": ".poster img@src", "overview": ".desc", "type": "series" },
 *   "episodes": { "url": "{href}", "item": ".episode", "number": "data-ep", "href": "a@href" },
 *   "streams": { "video": "video@src", "m3u8": "source[type*=m3u8]@src", "iframe": "iframe@src" }
 * }
 *
 * 2) JSON-API mode — add an "api" block (field names mirror the Kotlin port):
 * {
 *   "name": "JustAnime", "baseUrl": "https://justanime.to",
 *   "api": {
 *     "base": "https://core.justanime.to/api",
 *     "proxy": "https://neko.justanime.to/m3u8-proxy",
 *     "headers": { "User-Agent": "...", "Referer": "https://justanime.to/" },
 *     "catalogs": [ {"id":"trending","name":"Trending","type":"series"} ],
 *     "homePath": "/home", "searchPath": "/search", "searchResults": "results",
 *     "detailPath": "/anime/{id}", "detailData": "data",
 *     "episodesPath": "/anime/{id}/episodes", "episodesPageParam": "page",
 *     "episodesItems": "episodes", "episodesHasNext": "hasNextPage", "episodesMaxPages": 30,
 *     "episodeNumber": "number", "episodeName": "title",
 *     "streamsPath": "/watch/{id}/episode/{ep}/anineko/{lang}/hd1",
 *     "streamsLangs": "sub,dub", "streamsSources": "sources",
 *     "streamsUrl": "url", "streamsQuality": "quality", "streamsIsM3u8": "isM3U8",
 *     "streamsSubtitles": "subtitles", "streamsSubUrl": "url", "streamsSubLang": "lang",
 *     "streamsHeaders": "headers", "proxyStreams": true
 *   }
 * }
 */

export interface RuleCatalog { id: string; name: string; type: string }

export interface RuleScraperConfig {
  name: string;
  baseUrl?: string;
  homeUrl?: string;
  catalogUrl?: string;
  catalogs?: RuleCatalog[];
  search?: Record<string, string>;
  detail?: Record<string, string>;
  episodes?: Record<string, string | number>;
  streams?: Record<string, string>;
  api?: Record<string, unknown>;
}

export interface RuleMedia {
  id: string;
  title: string;
  type: 'movie' | 'series' | 'unknown';
  posterUrl?: string;
  year?: number;
  overview?: string;
  genres?: string[];
  backdropUrl?: string;
}

export interface RuleEpisode { id: string; number: number; season: number; name?: string }

export interface RuleScraperTitle {
  config: RuleScraperConfig;
  media: RuleMedia;
  episodes: RuleEpisode[];
}

export interface RuleStreamRow {
  name: string;
  url: string;
  headers?: Record<string, string>;
  subtitles?: { lang: string; url: string }[];
  isM3u8?: boolean;
  quality?: string;
}

const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_IFRAME_DEPTH = 2;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function typeOf(raw: string): 'movie' | 'series' | 'unknown' {
  const t = (raw || '').toLowerCase();
  if (t === 'movie') return 'movie';
  if (t === 'series') return 'series';
  return 'unknown';
}

/** Port of UniversalScraper.splitSel: `css@attr` splits at the LAST '@'. */
export function splitSel(raw: string): { css: string; attr?: string } {
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return { css: raw };
  return { css: raw.slice(0, at), attr: raw.slice(at + 1) };
}

function absUrl(base: string, u: string): string {
  if (!u) return '';
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return base.replace(/\/+$/, '') + (u.startsWith('/') ? '' : '/') + u;
}

/** jsoup's `abs:` — resolve a document attribute against the page URL. */
function resolveAttr(docBase: string, u: string): string {
  if (!u || u.startsWith('data:')) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  try {
    return new URL(u, docBase).href;
  } catch {
    return absUrl(docBase, u);
  }
}

function textOf(el: Element): string {
  return (el.textContent || '').trim();
}

/**
 * Port of UniversalScraper.pick/pickAttr. jsoup resolves `abs:href` against the
 * document's base URI; DOMParser gives the raw attribute, so href/src values are
 * resolved against `docBase` here.
 */
function pickFrom(scope: Element | Document, rawSelector: string, fallbackAttr: string | undefined, docBase: string): string | null {
  if (!rawSelector) return null;
  const { css, attr } = splitSel(rawSelector);
  if (!css) return null;
  const el = 'querySelectorAll' in scope ? scope.querySelector(css) : null;
  if (!el) return null;
  const a = attr || fallbackAttr;
  if (!a) return textOf(el) || null;
  const key = a.toLowerCase();
  if (key === 'text') return textOf(el) || null;
  if (key === 'html') return (el.innerHTML || '').trim() || null;
  let value = el.getAttribute(a) || '';
  if (!value && (a === 'href' || a === 'src')) return null;
  if (key === 'href' || key === 'src' || key === 'data-src' || key === 'data-lazy-src' || key === 'data-original') {
    value = resolveAttr(docBase, value);
  }
  return value.trim() || null;
}

function pickAll(scope: Element | Document, rawSelector: string, fallbackAttr: string | undefined, docBase: string): string[] {
  if (!rawSelector) return [];
  const { css, attr } = splitSel(rawSelector);
  if (!css) return [];
  const out: string[] = [];
  for (const el of Array.from(scope.querySelectorAll(css))) {
    const a = attr || fallbackAttr;
    if (!a) { const t = textOf(el); if (t) out.push(t); continue; }
    const key = a.toLowerCase();
    let value: string;
    if (key === 'text') value = textOf(el);
    else if (key === 'html') value = (el.innerHTML || '').trim();
    else value = resolveAttr(docBase, el.getAttribute(a) || '');
    if (value.trim()) out.push(value.trim());
  }
  return out;
}

function parseHtml(html: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('parsererror')) return null;
    return doc;
  } catch {
    return null;
  }
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const answer = await nativeFetchText(url, {
    headers: { 'User-Agent': PAGE_UA, ...(headers || {}) },
    timeoutMs: 30000,
  });
  return answer.ok || answer.status === 0 ? answer.data || '' : '';
}

function opt(obj: Record<string, unknown> | undefined, key: string): string {
  const v = obj?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function optNum(obj: Record<string, unknown> | undefined, key: string): number {
  const v = obj?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return 0;
}

// ── HTML mode ─────────────────────────────────────────────────────────────────

function htmlCatalogs(conf: RuleScraperConfig): { id: string; name: string; type: 'movie' | 'series' | 'unknown' }[] {
  const base = (conf.baseUrl || '').trim();
  if (!base) return [];
  const out: { id: string; name: string; type: 'movie' | 'series' | 'unknown' }[] = [];
  for (const c of Array.isArray(conf.catalogs) ? conf.catalogs : []) {
    const t = typeOf(c.type);
    if (t !== 'unknown') out.push({ id: c.id, name: c.name || c.id, type: t });
  }
  if (!out.length && (conf.homeUrl || '').trim()) {
    out.push({ id: 'home', name: 'Home', type: 'unknown' });
  }
  return out;
}

function scrapeList(conf: RuleScraperConfig, url: string, page: number): Promise<RuleMedia[]> {
  return (async () => {
    const rules = conf.search || {};
    if (!url) return [];
    const html = await fetchText(url);
    const doc = html ? parseHtml(html) : null;
    if (!doc) return [];
    const itemSel = opt(rules, 'item');
    if (!itemSel) return [];
    const out: RuleMedia[] = [];
    for (const el of Array.from(doc.querySelectorAll(itemSel))) {
      const href = pickFrom(el, opt(rules, 'href') || 'a', 'href', url) || '';
      const title = pickFrom(el, opt(rules, 'title'), 'text', url) || textOf(el);
      if (!href || !title) continue;
      out.push({
        id: href,
        title,
        type: typeOf(opt(rules, 'type')) === 'movie' ? 'movie' : 'series',
        posterUrl: pickFrom(el, opt(rules, 'poster'), 'src', url) || undefined,
      });
    }
    return out;
  })();
}

async function htmlMeta(conf: RuleScraperConfig, item: RuleMedia): Promise<RuleMedia> {
  const d = conf.detail || {};
  if (item.id === item.title && !item.id.startsWith('http')) return item;
  const html = await fetchText(item.id);
  const doc = html ? parseHtml(html) : null;
  if (!doc) return item;
  const title = pickFrom(doc, opt(d, 'title'), 'text', item.id) || item.title;
  const poster = pickFrom(doc, opt(d, 'poster'), 'src', item.id) || item.posterUrl;
  const overview = pickFrom(doc, opt(d, 'overview'), 'text', item.id) || item.overview;
  return {
    ...item,
    title,
    type: typeOf(opt(d, 'type')) === 'unknown' ? item.type : typeOf(opt(d, 'type')),
    posterUrl: poster || undefined,
    overview: overview || undefined,
  };
}

async function htmlEpisodes(conf: RuleScraperConfig, item: RuleMedia): Promise<RuleEpisode[] | null> {
  const e = conf.episodes as Record<string, string> | undefined;
  if (!e) return null;
  const tpl = opt(e, 'url');
  if (!tpl) return null;
  const pageUrl = absUrl(conf.baseUrl || '', tpl.replace('{href}', item.id));
  const html = await fetchText(pageUrl);
  const doc = html ? parseHtml(html) : null;
  if (!doc) return null;
  const itemSel = opt(e, 'item');
  if (!itemSel) return null;
  const hrefSel = opt(e, 'href') || 'a';
  const numSel = opt(e, 'number');
  const nameSel = opt(e, 'name');
  const seasonSel = opt(e, 'season');
  const seasonDefault = optNum(e, 'seasonDefault');
  const out: RuleEpisode[] = [];
  for (const el of Array.from(doc.querySelectorAll(itemSel))) {
    const href = pickFrom(el, hrefSel, 'href', pageUrl) || '';
    if (!href) continue;
    const numText = numSel ? pickFrom(el, numSel, 'text', pageUrl) : null;
    const number = numText ? parseInt(numText.replace(/\D/g, ''), 10) || out.length + 1 : out.length + 1;
    const name = nameSel ? pickFrom(el, nameSel, 'text', pageUrl) || undefined : undefined;
    const season = seasonSel ? parseInt((pickFrom(el, seasonSel, 'text', pageUrl) || '').replace(/\D/g, ''), 10) || 0 : 0;
    out.push({
      id: href,
      number,
      season: season > 0 ? season : seasonDefault > 0 ? seasonDefault : 1,
      name,
    });
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.season - b.season || a.number - b.number)
    .filter((ep) => { const k = `${ep.season}:${ep.number}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function findImages(pageUrl: string, rawSelector: string): Promise<RuleStreamRow[]> {
  const html = await fetchText(pageUrl);
  const doc = html ? parseHtml(html) : null;
  if (!doc) return [];
  const { css, attr } = splitSel(rawSelector);
  if (!css) return [];
  const out: RuleStreamRow[] = [];
  for (const img of Array.from(doc.querySelectorAll(css))) {
    let u = resolveAttr(pageUrl, img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '');
    if (!u || u.startsWith('data:')) {
      const a = (attr || 'src').toLowerCase();
      if (a === 'text' || a === 'html') continue;
      u = resolveAttr(pageUrl, img.getAttribute(attr || 'src') || '');
    }
    if (!u || u.startsWith('data:')) continue;
    out.push({
      name: `📖 Page ${out.length + 1}`,
      url: u,
      headers: { Referer: pageUrl, 'User-Agent': PAGE_UA },
    });
  }
  const seen = new Set<string>();
  return out.filter((row) => { if (seen.has(row.url)) return false; seen.add(row.url); return true; });
}

async function findStreams(pageUrl: string, base: string, s: Record<string, string>, out: RuleStreamRow[], depth: number): Promise<void> {
  if (depth > MAX_IFRAME_DEPTH) return;
  const html = await fetchText(pageUrl);
  const doc = html ? parseHtml(html) : null;
  if (!doc) return;
  // The documented config may carry `css@attr` selectors here, but the stream
  // readers take the attributes directly, so only the css part selects.
  const videoCss = splitSel(opt(s, 'video') || 'video').css;
  const m3u8Css = splitSel(opt(s, 'm3u8') || 'source[type*=m3u8]').css;
  const iframeCss = splitSel(opt(s, 'iframe') || 'iframe').css;
  for (const v of Array.from(doc.querySelectorAll(videoCss))) {
    const src = v.getAttribute('data-src') || v.getAttribute('src') || '';
    if (src) out.push({ name: 'Direct', url: absUrl(base, src) });
  }
  for (const v of Array.from(doc.querySelectorAll(m3u8Css))) {
    const src = v.getAttribute('src') || '';
    if (src) out.push({ name: 'HLS', url: absUrl(base, src), isM3u8: true });
  }
  for (const f of Array.from(doc.querySelectorAll(iframeCss))) {
    const src = f.getAttribute('src') || '';
    if (!src) continue;
    await findStreams(absUrl(base, src), base, s, out, depth + 1);
  }
}

async function htmlStreams(conf: RuleScraperConfig, pageUrl: string): Promise<RuleStreamRow[]> {
  const s = conf.streams || {};
  const imagesSel = (opt(s, 'images') || '').trim();
  if (imagesSel) return findImages(pageUrl, imagesSel);
  const results: RuleStreamRow[] = [];
  await findStreams(pageUrl, conf.baseUrl || '', s, results, 0);
  const seen = new Set<string>();
  return results.filter((row) => { if (seen.has(row.url)) return false; seen.add(row.url); return true; });
}

// ── JSON-API mode ─────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function str(o: Json | null | undefined, key: string): string {
  const v = o?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(o: Json | null | undefined, key: string): number {
  const v = o?.[key];
  return typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : 0;
}

function arr(o: Json | null | undefined, key: string): unknown[] {
  const v = o?.[key];
  return Array.isArray(v) ? v : [];
}

function apiHeaders(api: Json): Record<string, string> {
  const h = asObject(api.headers);
  const out: Record<string, string> = {};
  if (h) for (const [k, v] of Object.entries(h)) if (typeof v === 'string') out[k] = v;
  return out;
}

function proxyWrap(api: Json, target: string, headerJson: string): string {
  const p = str(api, 'proxy').trim();
  if (!p) return target;
  return `${p}?url=${enc(target)}&headers=${enc(headerJson)}`;
}

function parseApi(text: string): Json | null {
  try {
    const j = JSON.parse(text) as Json;
    return 'error' in j ? null : j;
  } catch {
    return null;
  }
}

/** Kotlin keeps `homeJson` on the provider instance; the api object plays that role here. */
const homeCache = new WeakMap<Json, Json>();

async function apiGet(api: Json, path: string, params: Record<string, string> = {}): Promise<Json | null> {
  const apiBase = str(api, 'base').trim();
  if (!apiBase) return null;
  const query = Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const url = apiBase.replace(/\/+$/, '') + path + (query ? `?${query}` : '');
  const headers = apiHeaders(api);
  const direct = await nativeFetchText(url, { headers, timeoutMs: 30000 });
  const parsed = direct.data ? parseApi(direct.data) : null;
  if (parsed) return parsed;
  if (!str(api, 'proxy').trim()) return null;
  const headerJson = JSON.stringify(headers);
  for (let i = 0; i < 2; i++) {
    const answer = await nativeFetchText(proxyWrap(api, url, headerJson), { headers, timeoutMs: 30000 });
    const viaProxy = answer.data ? parseApi(answer.data) : null;
    if (viaProxy) return viaProxy;
  }
  return null;
}

async function apiHome(api: Json): Promise<Json | null> {
  const cached = homeCache.get(api);
  if (cached) return cached;
  const path = str(api, 'homePath') || '/home';
  const home = await apiGet(api, path) ?? null;
  if (home) homeCache.set(api, home);
  return home;
}

function titleOf(o: Json): string {
  const t = o.title;
  if (asObject(t)) {
    const eng = str(t as Json, 'english') || str(t as Json, 'romaji');
    if (eng.trim()) return eng.trim();
  } else if (typeof t === 'string' && t.trim()) return t.trim();
  return str(o, 'title').trim();
}

function posterOf(o: Json): string | undefined {
  const coverImage = str(asObject(o.coverImage) ?? {}, 'extraLarge');
  const cover = str(o, 'cover');
  const banner = str(o, 'bannerImage');
  const found = [coverImage, cover, banner].find((u) => u.startsWith('http://') || u.startsWith('https://'));
  return found || undefined;
}

function typeOfApi(o: Json): 'movie' | 'series' {
  const f = str(o, 'format') || str(o, 'type');
  return f.toUpperCase() === 'MOVIE' ? 'movie' : 'series';
}

function toApiMedia(conf: RuleScraperConfig, o: Json): RuleMedia | null {
  const id = str(o, 'id');
  const title = titleOf(o);
  if (!id || !title) return null;
  const year = num(o, 'year');
  return {
    id,
    title,
    type: typeOfApi(o),
    posterUrl: posterOf(o),
    year: year > 0 ? year : undefined,
  };
}

async function apiCatalogs(conf: RuleScraperConfig, api: Json): Promise<{ id: string; name: string; type: 'movie' | 'series' }[]> {
  const out: { id: string; name: string; type: 'movie' | 'series' }[] = [];
  for (const raw of arr(api, 'catalogs')) {
    const c = asObject(raw);
    if (!c) continue;
    const t = typeOf(str(c, 'type'));
    if (t === 'unknown') continue;
    out.push({ id: str(c, 'id'), name: str(c, 'name') || str(c, 'id'), type: t as 'movie' | 'series' });
  }
  void conf;
  return out;
}

async function apiCatalog(conf: RuleScraperConfig, api: Json, refId: string): Promise<RuleMedia[]> {
  const home = await apiHome(api);
  if (!home) return [];
  return arr(home, refId).flatMap((o) => {
    const media = toApiMedia(conf, asObject(o));
    return media ? [media] : [];
  });
}

async function apiSearch(conf: RuleScraperConfig, api: Json, query: string, page: number): Promise<RuleMedia[]> {
  const path = str(api, 'searchPath') || '/search';
  const qParam = str(api, 'searchQueryParam') || 'query';
  const pParam = str(api, 'searchPageParam') || 'page';
  const json = await apiGet(api, path, { [qParam]: query, [pParam]: String(page) });
  if (!json) return [];
  const resultsKey = str(api, 'searchResults') || 'results';
  return arr(json, resultsKey).flatMap((o) => {
    const media = toApiMedia(conf, asObject(o));
    return media ? [media] : [];
  });
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function apiMeta(conf: RuleScraperConfig, api: Json, item: RuleMedia): Promise<RuleMedia> {
  const path = (str(api, 'detailPath') || '/anime/{id}').replace('{id}', item.id);
  const json = await apiGet(api, path);
  if (!json) return item;
  const wrapper = str(api, 'detailData');
  const d = (wrapper ? asObject(json[wrapper]) : null) ?? json;
  const title = titleOf(d) || item.title;
  const overview = stripTags(str(d, 'description')) || item.overview;
  const genres = arr(d, 'genres').map((g) => (typeof g === 'string' ? g : '')).filter(Boolean);
  const year = num(d, 'seasonYear') || num(d, 'year') || item.year || 0;
  const type = (() => {
    const f = (str(d, 'format') || str(d, 'type')).toUpperCase();
    return f === 'MOVIE' ? 'movie' : f ? 'series' : item.type;
  })();
  return {
    ...item,
    title,
    type: type as RuleMedia['type'],
    posterUrl: posterOf(d) || item.posterUrl,
    year: year > 0 ? year : undefined,
    overview,
    genres: genres.length ? genres : item.genres,
    backdropUrl: (str(d, 'bannerImage').startsWith('http') ? str(d, 'bannerImage') : item.backdropUrl) || undefined,
  };
}

async function apiEpisodes(conf: RuleScraperConfig, api: Json, item: RuleMedia): Promise<RuleEpisode[]> {
  const path = (str(api, 'episodesPath') || '/anime/{id}/episodes').replace('{id}', item.id);
  const itemsKey = str(api, 'episodesItems') || 'episodes';
  const hasNextKey = str(api, 'episodesHasNext') || 'hasNextPage';
  const pageParam = str(api, 'episodesPageParam') || 'page';
  const maxPages = num(api, 'episodesMaxPages') || 30;
  const numField = str(api, 'episodeNumber') || 'number';
  const nameField = str(api, 'episodeName') || 'title';
  const seasonField = str(api, 'episodeSeason');
  const fixedSeason = num(api, 'season');
  const out: RuleEpisode[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const json = await apiGet(api, path, { [pageParam]: String(page) });
    if (!json) break;
    const rows = arr(json, itemsKey);
    if (!rows.length) break;
    for (const raw of rows) {
      const o = asObject(raw);
      if (!o) continue;
      const number = num(o, numField);
      if (number <= 0) continue;
      const seasonFromField = seasonField ? num(o, seasonField) : 0;
      const season = seasonFromField > 0 ? seasonFromField : fixedSeason > 0 ? fixedSeason : 1;
      out.push({ id: `${item.id}|${number}`, number, season, name: str(o, nameField).trim() || undefined });
    }
    if (!json[hasNextKey]) break;
  }
  const seen = new Set<string>();
  return out
    .filter((ep) => { const k = `${ep.season}:${ep.number}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

async function apiStreams(conf: RuleScraperConfig, api: Json, item: RuleMedia, episode: RuleEpisode | null): Promise<RuleStreamRow[]> {
  const basePath = (str(api, 'streamsPath') || '/watch/{id}/episode/{ep}/anineko/{lang}/hd1')
    .replace('{id}', item.id)
    .replace('{ep}', String(episode?.number ?? 1));
  const langs = (str(api, 'streamsLangs') || 'sub,dub').split(',').map((l) => l.trim()).filter(Boolean);
  const sourcesKey = str(api, 'streamsSources') || 'sources';
  const urlField = str(api, 'streamsUrl') || 'url';
  const qualityField = str(api, 'streamsQuality') || 'quality';
  const isM3u8Field = str(api, 'streamsIsM3u8') || 'isM3U8';
  const subsKey = str(api, 'streamsSubtitles') || 'subtitles';
  const subUrlField = str(api, 'streamsSubUrl') || 'url';
  const subLangField = str(api, 'streamsSubLang') || 'lang';
  const hdrsKey = str(api, 'streamsHeaders') || 'headers';
  const proxyStreams = api.proxyStreams !== false;
  const apiHdrs = apiHeaders(api);
  const base = (conf.baseUrl || '').replace(/\/+$/, '');
  const out: RuleStreamRow[] = [];
  for (const lang of langs) {
    const json = await apiGet(api, basePath.replace('{lang}', lang));
    if (!json) continue;
    const respHdrs = asObject(json[hdrsKey]);
    const streamHeaders: Record<string, string> = respHdrs
      ? Object.fromEntries(Object.entries({
          Referer: str(respHdrs, 'Referer'),
          Origin: str(respHdrs, 'Origin'),
          'User-Agent': apiHdrs['User-Agent'] || PAGE_UA,
        }).filter(([, v]) => v))
      : apiHdrs;
    const subs = arr(json, subsKey).flatMap((raw) => {
      const s = asObject(raw);
      if (!s) return [];
      const u = str(s, subUrlField);
      return u ? [{ lang: str(s, subLangField) || lang, url: u }] : [];
    });
    for (const raw of arr(json, sourcesKey)) {
      const s = asObject(raw);
      if (!s) continue;
      const rawUrl = str(s, urlField).trim();
      if (!rawUrl) continue;
      const u = absUrl(base, rawUrl);
      const quality = str(s, qualityField) || 'Auto';
      const isM3u8 = Boolean(s[isM3u8Field]) || u.toLowerCase().includes('.m3u8');
      const label = `${lang.charAt(0).toUpperCase()}${lang.slice(1)} ${quality}`;
      out.push({ name: label, url: u, headers: streamHeaders, subtitles: subs, isM3u8, quality });
      if (proxyStreams && str(api, 'proxy').trim()) {
        const proxyHdrs: Record<string, string> = {};
        if (apiHdrs['User-Agent']) proxyHdrs['User-Agent'] = apiHdrs['User-Agent'];
        proxyHdrs['Referer'] = `${base}/`;
        proxyHdrs['Origin'] = base;
        out.push({
          name: `${label} (proxy)`,
          url: proxyWrap(api, u, JSON.stringify(proxyHdrs)),
          headers: proxyHdrs,
          subtitles: subs,
          isM3u8,
          quality,
        });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((row) => { const k = `${row.url}|${row.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Public surface (mirrors the ContentProvider methods) ──────────────────────

export function ruleScraperCatalogs(conf: RuleScraperConfig): Promise<{ id: string; name: string; type: string }[]> {
  const api = asObject(conf.api);
  if (api) return apiCatalogs(conf, api);
  return Promise.resolve(htmlCatalogs(conf));
}

export function ruleScraperBrowse(conf: RuleScraperConfig, catalogId: string, page = 1): Promise<RuleMedia[]> {
  return (async () => {
    const api = asObject(conf.api);
    if (api) return apiCatalog(conf, api, catalogId);
    const rules = conf.search || {};
    const tpl = (conf.catalogUrl || opt(rules, 'url')).trim();
    if (!tpl) return [];
    const url = absUrl(conf.baseUrl || '', tpl.replace('{page}', String(page)));
    return scrapeList(conf, url, page);
  })();
}

export function ruleScraperSearch(conf: RuleScraperConfig, query: string, page = 1): Promise<RuleMedia[]> {
  const api = asObject(conf.api);
  if (api) return apiSearch(conf, api, query, page);
  const rules = conf.search || {};
  const tpl = opt(rules, 'url');
  if (!tpl) return Promise.resolve([]);
  const url = absUrl(conf.baseUrl || '', tpl.replace('{query}', enc(query)).replace('{page}', String(page)));
  return scrapeList(conf, url, page);
}

export function ruleScraperDetails(conf: RuleScraperConfig, item: RuleMedia): Promise<RuleMedia> {
  const api = asObject(conf.api);
  if (api) return apiMeta(conf, api, item);
  return htmlMeta(conf, item);
}

export function ruleScraperEpisodes(conf: RuleScraperConfig, item: RuleMedia): Promise<RuleEpisode[] | null> {
  if (item.type === 'movie') return Promise.resolve(null);
  const api = asObject(conf.api);
  if (api) return apiEpisodes(conf, api, item).then((rows) => rows.length ? rows : null);
  return htmlEpisodes(conf, item);
}

export async function ruleScraperStreams(conf: RuleScraperConfig, item: RuleMedia, episode: RuleEpisode | null): Promise<RuleStreamRow[]> {
  const api = asObject(conf.api);
  if (api) return apiStreams(conf, api, item, episode);
  const pageUrl = episode?.id || item.id;
  return htmlStreams(conf, pageUrl);
}

/** Map scraper rows onto PRAHA StreamResults, mirroring toHikiStreams. */
export function toRuleStreams(conf: RuleScraperConfig, rows: RuleStreamRow[]): StreamResult[] {
  return rows.flatMap((row, index) => {
    const url = safeRemoteUrl(row.url) || '';
    if (!url) return [];
    return [{
      id: `rule:${conf.name}:${index}`,
      title: row.name || conf.name,
      sourceName: conf.name,
      sourceType: 'rule-scraper' as const,
      url,
      format: row.isM3u8 ? 'hls' : undefined,
      headers: row.headers,
      quality: row.quality,
      subtitles: row.subtitles?.flatMap((subtitle) => {
        const subUrl = safeRemoteUrl(subtitle.url);
        return subUrl ? [{ url: subUrl, language: subtitle.lang }] : [];
      }),
    }];
  });
}

/** Build the MediaItem PRAHA's title flow opens, carrying the scraper payload. */
export async function openRuleTitle(conf: RuleScraperConfig, media: RuleMedia): Promise<MediaItem> {
  const detail = await ruleScraperDetails(conf, media);
  const episodes = await ruleScraperEpisodes(conf, detail);
  const counts = new Map<number, number>();
  for (const ep of episodes || []) counts.set(ep.season, (counts.get(ep.season) ?? 0) + 1);
  return {
    id: `rule:${conf.name}:${media.id}`,
    title: detail.title || media.title || conf.name,
    source: 'rule-scraper',
    type: (episodes?.length || detail.type === 'series' ? 'series' : 'movie') as 'series' | 'movie',
    poster: detail.posterUrl || media.posterUrl || '',
    backdrop: detail.backdropUrl,
    overview: detail.overview || '',
    year: detail.year ? String(detail.year) : undefined,
    genres: detail.genres ?? [],
    seasons: [...counts.entries()].sort(([a], [b]) => a - b).map(([seasonNumber, episodeCount]) => ({
      id: seasonNumber, seasonNumber, name: `Season ${seasonNumber}`, episodeCount,
    })),
    ruleScraper: { config: conf, media: detail, episodes: episodes || [] },
  };
}

/** Resolve streams for the carried payload (SourceModal's entry point). */
export async function ruleScraperStreamsFor(title: RuleScraperTitle, season?: number, episode?: number): Promise<StreamResult[]> {
  const selected = (season !== undefined && episode !== undefined
    ? title.episodes.find((ep) => ep.season === season && ep.number === episode)
    : undefined) ?? null;
  const rows = title.media.type === 'movie'
    ? await ruleScraperStreams(title.config, title.media, null)
    : selected || title.episodes.length
      ? await ruleScraperStreams(title.config, title.media, selected)
      : [];
  return toRuleStreams(title.config, rows);
}
