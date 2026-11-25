// Runs a Vega provider as a plugin — a port of VyseTV's
// `assets/plugins/vega_runtime.js` (GPL-3.0-or-later), lines 195-632.
//
// A Vega repository's manifest lists providers; each is built into
// `dist/<value>/{posts,meta,episodes,catalog,stream}.js`. VyseTV stitches those
// modules into one script and runs it on this runtime, which answers the same
// `getStreams(query)` a hand-written plugin does by *browsing the site*: search
// for the title, read its page, pick the movie link or the season/episode, then
// resolve each link into a video file.
//
// What upstream gets from its bundle (axios, cheerio, the URL/AbortController
// polyfills) this port gets from the worker's own imports — cheerio and axios
// are real packages PRAHA already ships, and the browser has the rest natively.
// The two places upstream patches are patched here too, and they are the reason
// this port is safe to run at all:
//
//   * axios' adapter is replaced, so every provider request leaves through
//     `fetchVia` — the plugin's guarded `http()`, never axios' own transport.
//   * `fetch` inside the provider is replaced by the same call.
//
// Without those, a Vega provider would reach the network around the host check
// in `pluginNetwork.ts`.

import type { AxiosInstance } from 'axios';

/** The bridge the host gives a provider: the plugin's guarded `http()`. */
export interface VegaHttp {
  (url: string, opts?: Record<string, unknown>): Promise<VegaResponse>;
}

export interface VegaResponse {
  status: number;
  url?: string;
  headers?: Record<string, string>;
  text?: string;
  error?: string;
}

/** What a provider module may rely on. */
export interface VegaContext {
  axios: unknown;
  cheerio: unknown;
  Crypto: Record<string, never>;
  commonHeaders: Record<string, string>;
  getBaseUrl: (key: string) => Promise<string>;
  kvStore: Record<string, (key?: string, value?: unknown) => Promise<unknown>>;
  openWebView: () => Promise<never>;
  getCookies: () => Promise<Record<string, never>>;
}

type ModuleFn = (
  exports: Record<string, unknown>,
  module: { exports: Record<string, unknown> },
  require: (name: string) => unknown,
  __awaiter: unknown,
  providerGlobal: Record<string, unknown>,
) => void;

/** One provider module's exports, as loosely as providers write them. */
export type VegaModule = Record<string, any>;

const BUDGET_MS = 17000;

const MODULE_NAMES = ['posts', 'meta', 'stream', 'episodes', 'catalog'] as const;

export interface VegaSource {
  base: string;
  value: string;
}

/**
 * Builds the runtime for one provider.
 *
 * `axiosModule`/`cheerioModule` are the real libraries the worker imported;
 * `http` is the guarded bridge. The returned `getStreams` is what the host asks.
 */
export function createVegaRuntime(
  http: VegaHttp,
  axiosModule: { default?: unknown; create?: (config?: unknown) => AxiosInstance } & Record<string, any>,
  cheerioModule: unknown,
) {
  const started = Date.now();
  const rawHttp = http;
  const V: {
    base: string;
    value: string;
    mods: Partial<Record<(typeof MODULE_NAMES)[number], ModuleFn>>;
    loaded: Record<string, { exports: VegaModule }>;
    urls: Record<string, { url?: string; name?: string }> | null;
    kv: Record<string, unknown>;
    glob: Record<string, unknown>;
  } = { base: '', value: '', mods: {}, loaded: {}, urls: null, kv: {}, glob: {} };

  /** Time left in the 17 s budget. */
  const left = () => BUDGET_MS - (Date.now() - started);

  // ── the network, with the budget and one retry for a reset connection ──
  async function net(url: string, opts: Record<string, any> = {}): Promise<VegaResponse> {
    const next = { ...opts };
    const remaining = left();
    if (remaining < 400) return { status: 0, error: 'out of time', text: '', headers: {}, url };
    next.timeout = Math.min(Number(next.timeout || 12000), remaining);
    let r = await rawHttp(url, next);
    const method = String(next.method || 'GET').toUpperCase();
    if (r.status === 0 && method === 'GET' && /reset|refused|closed/i.test(String(r.error || '')) && left() > 3000) {
      r = await rawHttp(url, { ...next, timeout: Math.min(Number(next.timeout), left()) });
    }
    return r;
  }

  // ── axios: the real one, its transport replaced by net() ──
  const lib = (axiosModule.default || axiosModule) as Record<string, any>;
  const AxiosError = lib.AxiosError;
  const AxiosHeaders = lib.AxiosHeaders;

  function withParams(url: string, params: any): string {
    if (!params) return url;
    const q =
      typeof params.toString === 'function' && params.constructor !== Object
        ? params.toString()
        : Object.keys(params)
            .filter((k) => params[k] != null)
            .map((k) => {
              const v = params[k];
              return (Array.isArray(v) ? v : [v])
                .map((x: unknown) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`)
                .join('&');
            })
            .join('&');
    return q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url;
  }

  async function adapter(config: Record<string, any>): Promise<Record<string, any>> {
    let url = config.url || '';
    if (config.baseURL && !/^https?:/i.test(url)) {
      url = `${String(config.baseURL).replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    }
    url = withParams(url, config.params);
    const headers: Record<string, string> =
      config.headers && config.headers.toJSON ? config.headers.toJSON() : { ...(config.headers || {}) };
    for (const k of Object.keys(headers)) {
      if (headers[k] == null || (headers[k] as unknown) === false) delete headers[k];
      else headers[k] = String(headers[k]);
    }
    let body = config.data;
    if (body != null && typeof body !== 'string') {
      body =
        typeof body.toString === 'function' && body.constructor !== Object && !Array.isArray(body)
          ? body.toString()
          : JSON.stringify(body);
    }
    const r = await net(url, {
      method: String(config.method || 'get').toUpperCase(),
      headers,
      body: body == null ? undefined : body,
      timeout: config.timeout || 0,
    });
    const request = { url, responseURL: r.url || url, res: { responseUrl: r.url || url } };
    if (!r.status) {
      const timedOut = Boolean(r.error && /time/i.test(r.error));
      throw new AxiosError(
        timedOut ? `timeout of ${config.timeout || 0}ms exceeded` : `Network Error: ${r.error || ''}`,
        timedOut ? 'ECONNABORTED' : 'ERR_NETWORK',
        config,
        request,
      );
    }
    let data: unknown = r.text;
    if (config.responseType !== 'text') {
      try {
        data = r.text ? JSON.parse(r.text) : '';
      } catch {
        data = r.text;
      }
    }
    const res = {
      data,
      status: r.status,
      statusText: '',
      headers: new AxiosHeaders(r.headers || {}),
      config,
      request,
    };
    const ok = config.validateStatus ? config.validateStatus(r.status) : r.status >= 200 && r.status < 300;
    if (!ok) {
      throw new AxiosError(
        `Request failed with status code ${r.status}`,
        r.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
        config,
        request,
        res,
      );
    }
    return res;
  }
  if (lib.defaults) lib.defaults.adapter = adapter;

  // ── fetch (a provider may call it directly) ──
  async function vfetch(input: any, init: any = {}) {
    const url = typeof input === 'string' ? input : String((input && input.url) || input);
    const h: Record<string, string> = {};
    const addH = (src: any) => {
      if (!src) return;
      if (typeof src.forEach === 'function' && !Array.isArray(src)) {
        src.forEach((v: string, k: string) => {
          h[k] = v;
        });
      } else if (Array.isArray(src)) {
        for (const e of src) h[e[0]] = e[1];
      } else {
        for (const k of Object.keys(src)) h[k] = src[k];
      }
    };
    addH(input && input.headers);
    addH(init.headers);
    let body = init.body;
    if (body != null && typeof body !== 'string') {
      body =
        typeof body.toString === 'function' && body.constructor !== Object ? body.toString() : JSON.stringify(body);
    }
    const r = await net(url, {
      method: init.method || (input && input.method) || 'GET',
      headers: h,
      body: body == null ? undefined : body,
    });
    if (!r.status) throw new TypeError(`Network request failed: ${r.error || ''}`);
    const lower = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: '',
      url: r.url || url,
      headers: {
        get: (k: string) => (lower[String(k).toLowerCase()] == null ? null : lower[String(k).toLowerCase()]),
        has: (k: string) => String(k).toLowerCase() in lower,
        forEach: (f: (v: string, k: string) => void) => Object.keys(lower).forEach((k) => f(lower[k], k)),
      },
      text: () => Promise.resolve(r.text),
      json: () => Promise.resolve().then(() => JSON.parse(String(r.text))),
      clone: () => vfetch(input, init),
    };
  }

  // ── the provider's context ──
  const commonHeaders = {
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  /** The repository's urls.json says where each site lives now: read once, 4 s at most. */
  async function getBaseUrl(key: string): Promise<string> {
    if (V.urls == null) {
      V.urls = {};
      if (V.base) {
        const r = await net(`${V.base}/urls.json`, { timeout: 4000 });
        try {
          V.urls = JSON.parse(String(r.text)) || {};
        } catch {
          // the repository may not have one
        }
      }
    }
    const urls = V.urls;
    let entry = urls[key] || urls[String(key).toLowerCase()];
    if (!entry) {
      const found = Object.keys(urls).filter((x) => x.toLowerCase() === String(key).toLowerCase())[0];
      entry = found ? urls[found] : undefined;
    }
    return entry && entry.url ? String(entry.url).replace(/\/+$/, '') : '';
  }

  const kvStore = {
    get: async (k?: string) => (k == null ? undefined : V.kv[k]),
    set: async (k?: string, v?: unknown) => {
      if (k != null) V.kv[k] = v;
    },
    delete: async (k?: string) => {
      const had = k != null && k in V.kv;
      if (k != null) delete V.kv[k];
      return had;
    },
    keys: async () => Object.keys(V.kv),
    clear: async () => {
      V.kv = {};
    },
  };

  const ctx: VegaContext = {
    axios: lib,
    cheerio: cheerioModule,
    Crypto: {},
    commonHeaders,
    getBaseUrl,
    kvStore,
    // A provider that needs a browser challenge cannot work headlessly; saying so
    // is what upstream does, and it is not something to fake.
    openWebView: async () => {
      throw new Error('this provider needs a browser challenge, which PRAHA cannot run');
    },
    getCookies: async () => ({}),
  };

  function awaiter(thisArg: unknown, args: unknown, P: any, generator: any) {
    const Promise_ = P || Promise;
    return new Promise_((resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const it = generator.apply(thisArg, args || []);
      const step = (r: any) => {
        if (r.done) resolve(r.value);
        else Promise.resolve(r.value).then(ok, bad);
      };
      const ok = (v?: unknown) => {
        try {
          step(it.next(v));
        } catch (e) {
          reject(e);
        }
      };
      const bad = (v: unknown) => {
        try {
          step(it.throw(v));
        } catch (e) {
          reject(e);
        }
      };
      ok();
    });
  }

  function load(name: string): VegaModule | null {
    if (V.loaded[name]) return V.loaded[name].exports;
    const fn = V.mods[name as (typeof MODULE_NAMES)[number]];
    if (!fn) return null;
    const m: { exports: VegaModule } = { exports: {} };
    V.loaded[name] = m;
    fn(m.exports, m, () => ({}), awaiter, V.glob);
    return m.exports;
  }

  // ── reading a listing's title ──

  /** A listing's title as the matcher should read it. */
  function vegaTitle(p: any): string {
    return String((p && p.title) || '')
      .replace(/^\s*(?:download|watch|stream)\s+/i, '')
      .replace(/\s+(?:full\s+)?(?:movie|series|web\s*series)\b.*$/i, (m: string) =>
        /\(\d{4}\)|\b(19|20)\d{2}\b/.test(m) ? m : '',
      );
  }

  function vegaQ(s: unknown): number {
    const v = String(s || '');
    const m = v.match(/(\d{3,4})\s*p\b/i) || v.match(/\b(2160|1080|720|480|360)\b/);
    return m ? Number(m[1]) : /\b4k\b/i.test(v) ? 2160 : 0;
  }
  const vegaRank = (n: number) => (n === 1080 ? 0 : n === 720 ? 1 : n === 2160 ? 2 : n === 480 ? 3 : n ? 4 : 5);
  function vegaNum(re: RegExp, s: unknown): number | null {
    const m = String(s || '').match(re);
    return m ? Number(m[1]) : null;
  }

  /** The links that play the film: every direct link of the page, 1080p/720p first. */
  function vegaMovieLinks(info: any) {
    const out: Array<{ link: string; quality: number; title?: string }> = [];
    for (const e of info.linkList || []) {
      for (const d of e.directLinks || []) {
        if (d && d.link) out.push({ link: d.link, quality: vegaQ(e.quality) || vegaQ(e.title) || vegaQ(d.title), title: d.title || e.title });
      }
    }
    out.sort((a, b) => vegaRank(a.quality) - vegaRank(b.quality));
    return out.slice(0, 4);
  }

  /** The links of one episode: the season's entries (one per quality, at most 3), then the episode in each. */
  async function vegaEpisodeLinks(info: any, q: any, mod: VegaModule | null, ctxIn: VegaContext) {
    const list = info.linkList || [];
    const seasonOf = (e: any) => vegaNum(/\b(?:season|s)\s*0*(\d{1,2})\b/i, e.title);
    let entries = list.filter((e: any) => seasonOf(e) === q.season);
    if (!entries.length && list.length === 1 && seasonOf(list[0]) == null) entries = list;
    if (!entries.length && q.season === 1 && list.every((e: any) => seasonOf(e) == null)) entries = list;
    entries.sort(
      (a: any, b: any) => vegaRank(vegaQ(a.quality) || vegaQ(a.title)) - vegaRank(vegaQ(b.quality) || vegaQ(b.title)),
    );
    const out: Array<{ link: string; quality: number; title?: string }> = [];
    for (let i = 0; i < Math.min(entries.length, 3); i++) {
      const e = entries[i];
      let eps = e.directLinks || [];
      if (!eps.length && e.episodesLink && mod && mod.getEpisodes) {
        try {
          eps = (await mod.getEpisodes({ url: e.episodesLink, providerContext: ctxIn, signal: new AbortController().signal })) || [];
        } catch (err) {
          console.log(`episodes: ${(err as Error)?.message}`);
          eps = [];
        }
      }
      const n = q.episode;
      const hit =
        eps.filter((x: any) => {
          const t = String(x.title || '');
          let num = vegaNum(/\b(?:episode|ep|e)\s*0*(\d{1,4})\b/i, t);
          if (num == null) num = vegaNum(/^\s*0*(\d{1,4})\s*$/, t);
          if (num == null) num = vegaNum(/^\s*0*(\d{1,4})\b/, t);
          return num === n;
        })[0] ||
        (eps.length >= n && !eps.some((x: any) => /\d/.test(x.title || '')) ? eps[n - 1] : null);
      if (hit && hit.link) {
        out.push({ link: hit.link, quality: vegaQ(e.quality) || vegaQ(e.title) || vegaQ(hit.title), title: hit.title });
      }
    }
    return out;
  }

  function vegaType(t: unknown, link: string): string {
    const v = String(t || '').toLowerCase();
    if (/m3u8|hls/.test(v) || /\.m3u8(\?|$)/i.test(link)) return 'hls';
    if (/mpd|dash/.test(v) || /\.mpd(\?|$)/i.test(link)) return 'dash';
    return 'mp4';
  }

  const vegaErr = (e: unknown) => String((e as Error)?.message || e).slice(0, 160);

  /** Each link of the page turned into video files, in parallel: DRM ones dropped, 12 at most. */
  async function vegaResolve(links: Array<{ link: string; quality: number }>, tv: boolean) {
    const streamMod = load('stream');
    if (!streamMod) return [];
    const signal = new AbortController().signal;
    const got = await Promise.all(
      links.map(async (l) => {
        try {
          const s = (await streamMod.getStream({
            link: l.link,
            type: tv ? 'series' : 'movie',
            signal,
            providerContext: ctx,
            isDownload: false,
          })) || [];
          return { l, s };
        } catch (e) {
          console.log(`stream ${l.link}: ${vegaErr(e)}`);
          return { l, s: [] };
        }
      }),
    );
    const out: Array<Record<string, unknown>> = [];
    const have: Record<string, boolean> = {};
    for (const g of got) {
      for (const s of g.s) {
        if (!s || !s.link || s.drm || !/^https?:/i.test(s.link) || have[s.link]) continue;
        // a comic's pages are pictures, not a video
        if (String(s.type || '').toLowerCase() === 'image' || /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(s.link)) continue;
        have[s.link] = true;
        const ql = s.quality
          ? /^\d+$/.test(String(s.quality))
            ? `${s.quality}p`
            : String(s.quality)
          : g.l.quality
            ? `${g.l.quality}p`
            : '';
        out.push({
          url: s.link,
          type: vegaType(s.type, s.link),
          quality: ql,
          server: s.server || V.value,
          label: s.tag || undefined,
          headers: s.headers || undefined,
        });
      }
    }
    return out.slice(0, 12);
  }

  // ── reading a provider's own titles ──

  /** "Download Oppenheimer (2023) Dual Audio {Hindi-English} 480p [450MB]" -> "Oppenheimer". */
  function vegaName(t: unknown): string {
    let s = String(t || '').replace(/^\s*(?:download|watch|stream)\s+/i, '');
    const y = s.match(/^(.*?)[\s([{-]*\b(19\d\d|20\d\d)\b/);
    if (y && y[1].trim().length > 1) s = y[1];
    s = s.split(
      /\s*(?:[[{|]|\((?=\s*(?:season|s\d|\d))|\b(?:season\s*\d|s\d{1,2}\b|480p|720p|1080p|2160p|4k|hdrip|web-?dl|webrip|bluray|dual audio)\b)/i,
    )[0];
    return s.replace(/[\s:,(\-$|+–—]+$/, '').trim();
  }
  function vegaYear(t: unknown): string | undefined {
    const m = String(t || '').match(/\b(19\d\d|20\d\d)\b/);
    return m ? m[1] : undefined;
  }
  /** A listing is a show when its title or link says so; else what its catalog lists. */
  function vegaKind(t: unknown, link: unknown, fallback?: unknown): string {
    const re =
      /(?:^|[\s\-_/(])(?:seasons?[\s\-_]*\d|s\d{1,2}(?:\s*e\d{1,3})?|episodes?[\s\-_]*\d|ep\s?\d+|web[\s-]?series|tv[\s-]?series|series)(?=$|[\s\-_/)\d])/i;
    return re.test(String(t || '')) || re.test(String(link || '')) ? 'series' : String(fallback || 'movie');
  }

  async function vegaCatalog(q: any) {
    const posts = load('posts');
    const signal = new AbortController().signal;
    if (!posts) return { metas: [] };
    const page = q.page || 1;
    let items: any[] = [];
    let filter = String(q.filter || '');
    if (q.genre) {
      const cat = load('catalog') || {};
      const g = (cat.genres || []).filter((x: any) => x && x.title === q.genre)[0];
      if (g) filter = String(g.filter || '');
    }
    if (q.search) {
      if (!posts.getSearchPosts) return { metas: [] };
      items = await posts.getSearchPosts({
        searchQuery: String(q.search),
        page,
        providerValue: V.value,
        signal,
        providerContext: ctx,
      });
    } else {
      if (!posts.getPosts) return { metas: [] };
      items = await posts.getPosts({ filter, page, providerValue: V.value, signal, providerContext: ctx });
    }
    const seen: Record<string, boolean> = {};
    return {
      metas: (Array.isArray(items) ? items : [])
        .filter((p: any) => {
          if (!p || !p.link || !p.title || seen[p.link]) return false;
          seen[p.link] = true;
          return true;
        })
        .map((p: any) => ({
          id: String(p.link),
          type: q.comic ? 'comic' : vegaKind(p.title, p.link, q.type),
          // (a comic's title is its own: no film formats to cut)
          name: q.comic ? String(p.title).trim() : vegaName(p.title) || String(p.title).trim(),
          poster: p.image || undefined,
          releaseInfo: q.comic ? undefined : vegaYear(p.title),
        })),
    };
  }

  const vegaSeasonOf = (e: any) => vegaNum(/\b(?:season|s)\s*0*(\d{1,2})\b/i, e && e.title);
  function vegaEpisodeOf(t: unknown): number | null {
    let n = vegaNum(/\b(?:episode|ep|e)\s*0*(\d{1,4})\b/i, t);
    if (n == null) n = vegaNum(/^\s*0*(\d{1,4})\s*$/, t);
    if (n == null) n = vegaNum(/^\s*0*(\d{1,4})\b/, t);
    return n;
  }

  async function vegaMeta(q: any) {
    const metaMod = load('meta');
    const epMod = load('episodes') || {};
    const signal = new AbortController().signal;
    if (!metaMod || !metaMod.getMeta) return { meta: null };
    const info = await metaMod.getMeta({ link: q.link, provider: V.value, providerContext: ctx, signal });
    if (!info) return { meta: null };
    const list = info.linkList || [];
    const numbered = list.some((e: any) => vegaSeasonOf(e) != null);
    const series =
      String(info.type || '').toLowerCase() === 'series' || numbered || list.some((e: any) => e && e.episodesLink);
    const videos: Array<Record<string, unknown>> = [];
    if (series) {
      // each season once (its best quality): its episodes, numbered as the site names them
      const bySeason: Record<number, any[]> = {};
      for (const e of list) {
        let s = vegaSeasonOf(e);
        if (s == null) {
          if (numbered) continue;
          s = 1;
        }
        (bySeason[s] = bySeason[s] || []).push(e);
      }
      const seasons = Object.keys(bySeason)
        .map(Number)
        .sort((a, b) => a - b)
        .slice(0, 40);
      const lists = await Promise.all(
        seasons.map(async (s) => {
          const entries = bySeason[s]
            .slice()
            .sort((a, b) => vegaRank(vegaQ(a.quality) || vegaQ(a.title)) - vegaRank(vegaQ(b.quality) || vegaQ(b.title)));
          for (let i = 0; i < Math.min(entries.length, 2) && left() > 1500; i++) {
            const e = entries[i];
            let eps = e.directLinks || [];
            if (!eps.length && e.episodesLink && epMod.getEpisodes) {
              try {
                eps = (await epMod.getEpisodes({ url: e.episodesLink, providerContext: ctx, signal })) || [];
              } catch (err) {
                console.log(`episodes: ${vegaErr(err)}`);
                eps = [];
              }
            }
            if (eps.length) return { s, eps };
          }
          return { s, eps: [] as any[] };
        }),
      );
      for (const x of lists) {
        const used: Record<number, boolean> = {};
        x.eps.forEach((ep: any, i: number) => {
          let n = vegaEpisodeOf(ep && ep.title);
          if (n == null || used[n]) n = i + 1;
          if (used[n]) return;
          used[n] = true;
          videos.push({
            id: `${q.link}|${x.s}|${n}`,
            season: x.s,
            episode: n,
            title: String((ep && ep.title) || `Episode ${n}`).trim(),
          });
        });
      }
    }
    return {
      meta: {
        id: q.link,
        type: series ? 'series' : 'movie',
        name: vegaName(info.title) || String(info.title || '').trim(),
        description: info.synopsis || undefined,
        poster: info.image || undefined,
        background: info.image || undefined,
        imdb_id: /^tt\d+$/.test(String(info.imdbId || '')) ? info.imdbId : undefined,
        genres: Array.isArray(info.tags) ? info.tags : undefined,
        cast: Array.isArray(info.cast) ? info.cast : undefined,
        imdbRating: info.rating || undefined,
        releaseInfo: vegaYear(info.title),
        videos,
      },
    };
  }

  /** One of the provider's own titles (`ownId`: its page's link, and for an episode `|season|episode`). */
  async function vegaOwnStreams(q: any) {
    const metaMod = load('meta');
    const epMod = load('episodes') || {};
    if (!metaMod || !metaMod.getMeta) return [];
    const m = String(q.ownId).match(/^(.*)\|(\d+)\|(\d+)$/);
    const link = m ? m[1] : String(q.ownId);
    const tv = Boolean(m);
    let info: any;
    try {
      info = await metaMod.getMeta({ link, provider: V.value, providerContext: ctx, signal: new AbortController().signal });
    } catch (e) {
      console.log(`page ${link}: ${vegaErr(e)}`);
      return [];
    }
    if (!info) return [];
    const links = tv
      ? await vegaEpisodeLinks(info, { season: Number(m![2]), episode: Number(m![3]) }, epMod, ctx)
      : vegaMovieLinks(info);
    if (!links.length) {
      console.log(`no ${tv ? `episode S${m![2]}E${m![3]}` : 'movie link'} on ${link}`);
      return [];
    }
    return vegaResolve(links, tv);
  }

  /**
   * The plugin contract's entry point.
   *
   * `searchQueries`/`rankMatches` come from the helpers the host loaded into
   * the same scope, exactly as upstream expects.
   */
  async function getStreams(q: any): Promise<unknown[]> {
    const posts = load('posts');
    const metaMod = load('meta');
    const streamMod = load('stream');
    const epMod = load('episodes') || {};
    if (!metaMod || !metaMod.getMeta || !streamMod || !streamMod.getStream) {
      console.log('this provider lacks meta/stream');
      return [];
    }
    if (q.ownId) return vegaOwnStreams(q);
    if (!posts || !posts.getSearchPosts) {
      console.log('this provider has no search');
      return [];
    }
    const signal = new AbortController().signal;
    const helpers = globalThis as unknown as {
      searchQueries: (q: unknown) => string[];
      rankMatches: (items: unknown[], q: unknown, get: (p: any) => string) => any[];
    };

    // 1. find the title on the site
    let cands: any[] = [];
    const queries = helpers.searchQueries(q);
    const seen: Record<string, boolean> = {};
    for (let i = 0; i < queries.length && !cands.length && left() > 2500; i++) {
      let items: any[] = [];
      try {
        items = await posts.getSearchPosts({
          searchQuery: queries[i],
          page: 1,
          providerValue: V.value,
          signal,
          providerContext: ctx,
        });
      } catch (e) {
        console.log(`search "${queries[i]}": ${vegaErr(e)}`);
      }
      cands = helpers
        .rankMatches(Array.isArray(items) ? items : [], q, vegaTitle)
        .filter((p: any) => {
          if (!p.link || seen[p.link]) return false;
          seen[p.link] = true;
          return true;
        });
    }
    if (!cands.length) {
      console.log('not found on the site');
      return [];
    }

    // 2. open the best listings until one gives streams
    for (let c = 0; c < Math.min(cands.length, 3) && left() > 2500; c++) {
      let info: any;
      try {
        info = await metaMod.getMeta({ link: cands[c].link, providerContext: ctx, signal });
      } catch (e) {
        console.log(`page ${cands[c].link}: ${vegaErr(e)}`);
        continue;
      }
      if (!info) continue;
      if (q.imdbId && info.imdbId && /^tt\d+$/.test(info.imdbId) && info.imdbId !== q.imdbId) {
        console.log(`skipped: another IMDb id (${info.imdbId})`);
        continue;
      }
      const links = q.isTv ? await vegaEpisodeLinks(info, q, epMod, ctx) : vegaMovieLinks(info);
      if (!links.length) {
        console.log(
          `no ${q.isTv ? `episode S${q.season}E${q.episode}` : 'movie link'} on ${cands[c].link}`,
        );
        continue;
      }

      // 3. turn each link into video files (in parallel)
      const out = await vegaResolve(links, Boolean(q.isTv));
      if (out.length) return out;
    }
    return [];
  }

  return {
    /** Where the provider's modules live, and its own name in the repository. */
    source: (base: string, value: string) => {
      V.base = String(base || '').replace(/\/+$/, '');
      V.value = value;
    },
    /** Registers one of the provider's built modules. */
    module: (name: string, fn: ModuleFn) => {
      V.mods[name as (typeof MODULE_NAMES)[number]] = fn;
    },
    load,
    ctx,
    V,
    left,
    vfetch,
    getStreams,
    /**
     * One page of one of the provider's lists, as a Stremio addon answers it
     * (`{metas}`) — VyseTV's `__vegaCatalog`, for the browse pages.
     */
    catalog: vegaCatalog,
    /**
     * A title's details from the provider — VyseTV's `__vegaMeta`
     * (`{meta}`), for the details page.
     */
    meta: vegaMeta,
    /**
     * Reads the provider's own catalogs. Its catalog module is plain data, so
     * upstream runs it alone, without the runtime and without the network.
     */
    describe: () => {
      const m: { exports: Record<string, any> } = { exports: {} };
      const fn = V.mods.catalog;
      if (fn) {
        try {
          fn(m.exports, m, () => ({}), awaiter, V.glob);
        } catch (e) {
          console.log(`catalog: ${(e as Error)?.message || e}`);
        }
      }
      const list = (v: unknown) =>
        Array.isArray(v)
          ? v
              .filter((x: any) => x && typeof x.title === 'string')
              .map((x: any) => ({ title: x.title, filter: x.filter == null ? '' : String(x.filter) }))
          : [];
      return {
        catalogs: list(m.exports.catalog),
        genres: list(m.exports.genres),
        search: Boolean(V.mods.posts),
        meta: Boolean(V.mods.meta),
      };
    },
  };
}
