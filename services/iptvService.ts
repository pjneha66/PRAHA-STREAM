import CryptoJS from 'crypto-js';
import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';
import type { MediaItem, StreamResult } from '../types';

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  const headers = (init?.headers as Record<string, string>) || {};
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : undefined;
  try {
    const res = await nativeFetchText(url, {
      method,
      headers,
      body,
      timeoutMs,
    });
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.data || '',
      json: async () => {
        try {
          return JSON.parse(res.data || '{}');
        } catch {
          return {};
        }
      },
    };
  } catch {
    return {
      ok: false,
      status: 0,
      text: async () => '',
      json: async () => ({}),
    };
  }
}

// ── Models & Interfaces ────────────────────────────────────────────────────────

export interface IptvPortal {
  url: string;
  username: string;
  password: string;
  source?: string;
}

export interface VerifiedPortal {
  portal: IptvPortal;
  name: string;
  expiry: string;
  maxConnections: string;
  activeConnections: string;
}

export interface IptvCategory {
  id: string;
  name: string;
}

export interface IptvStream {
  streamId: string;
  name: string;
  icon: string;
  categoryId: string;
  containerExt: string;
  kind: 'live' | 'vod' | 'series';
  epgChannelId?: string;
}

export interface EpgEntry {
  title: string;
  description: string;
  start: string;
  stop: string;
}

export interface HardcodedChannel {
  id: string;
  name: string;
  shortName: string;
  category: 'Combat' | 'Motorsport' | 'Soccer' | 'US Sports' | 'Cricket' | 'News' | 'Movies' | 'Kids & Docs' | 'Music';
  keywords: string[];
  exclude?: string[];
  gradient: [string, string];
  logo?: string;
  defaultStreamUrl?: string;
}

export interface ChannelHit {
  channel: HardcodedChannel;
  portal: VerifiedPortal;
  stream: IptvStream;
  streamUrl: string;
}

export interface M3uChannel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  tvgName?: string;
}

export interface M3uPlaylist {
  id: string;
  name: string;
  sourceUrl: string;
  channels: M3uChannel[];
  updatedAt: number;
}

export interface LiveMatchEvent {
  id: string;
  title: string;
  league: string;
  category: string;
  startsAt?: number;
  endsAt?: number;
  timeLabel: string;
  isLive: boolean;
  homeTeam?: { name: string; badge?: string };
  awayTeam?: { name: string; badge?: string };
  viewers?: number;
  streamUrl: string;
  poster?: string;
  /** Nuvio Sports match — resolve the stream on demand via resolveNuvioStream. */
  nuvio?: boolean;
}

// ── PasteShDecryptor (AES-256-CBC, PBKDF2-HMAC-SHA512) ────────────────────────

export class PasteShDecryptor {
  private static readonly UA = 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36';

  static async decrypt(urlWithHash: string): Promise<string> {
    try {
      const hashIdx = urlWithHash.indexOf('#');
      if (hashIdx <= 0) return '';
      const baseUrl = urlWithHash.substring(0, hashIdx);
      const clientKey = urlWithHash.substring(hashIdx + 1);
      const slashIdx = baseUrl.lastIndexOf('/');
      const id = slashIdx >= 0 ? baseUrl.substring(slashIdx + 1) : '';

      const resp = await fetchWithTimeout(`${baseUrl}.txt`, { headers: { 'User-Agent': this.UA } }, 6000);
      if (!resp.ok) return '';
      const raw = await resp.text();
      const lines = raw.split('\n');
      if (lines.length < 2) return '';
      const serverKey = lines[0].trim();
      const b64 = lines.slice(1).join('').trim();
      if (!b64) return '';

      const cipherWords = CryptoJS.enc.Base64.parse(b64);
      const cipherHex = CryptoJS.enc.Hex.stringify(cipherWords);
      // Salted__ is 8 bytes (16 hex chars), salt is 8 bytes (16 hex chars)
      if (cipherHex.length < 34) return '';
      const saltHex = cipherHex.substring(16, 32);
      const ctHex = cipherHex.substring(32);

      const password = `${id}${serverKey}${clientKey}https://paste.sh`;
      const salt = CryptoJS.enc.Hex.parse(saltHex);
      const keyIv = CryptoJS.PBKDF2(password, salt, {
        keySize: 48 / 4,
        iterations: 1,
        hasher: CryptoJS.algo.SHA512,
      });

      const keyIvHex = CryptoJS.enc.Hex.stringify(keyIv);
      const key = CryptoJS.enc.Hex.parse(keyIvHex.substring(0, 64)); // 32 bytes
      const iv = CryptoJS.enc.Hex.parse(keyIvHex.substring(64, 96));  // 16 bytes
      const ct = CryptoJS.enc.Hex.parse(ctHex);

      const decrypted = CryptoJS.AES.decrypt({ ciphertext: ct } as any, key, {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });

      return decrypted.toString(CryptoJS.enc.Utf8) || '';
    } catch {
      return '';
    }
  }
}

// ── Xtream-Codes Client (IptvClient) ──────────────────────────────────────────

export class IptvClient {
  private static readonly UA = 'VLC/3.0.20 LibVLC/3.0.20';

  private static enc(s: string): string {
    return encodeURIComponent(s);
  }

  private static async httpGet(url: string, timeoutMs = 8000): Promise<string | null> {
    // Xtream portals (player_api.php) do not send CORS headers, so a plain
    // browser fetch is blocked inside the app WebView — portal scraping and
    // login verification silently failed on device. Route through the native
    // CORS-bypass client first, with plain fetch as the web fallback.
    try {
      const res = await nativeFetchText(url, {
        headers: { 'User-Agent': this.UA, Accept: 'application/json, text/plain, */*' },
        timeoutMs,
      });
      if (res.status >= 200 && res.status < 300 && res.data) return res.data;
      if (res.ok && res.data) return res.data;
    } catch {
      // Fall through to the plain browser fetch below.
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': this.UA,
          Accept: 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  static async login(portal: IptvPortal, timeoutMs = 6000): Promise<Record<string, any> | null> {
    const attempt = await this.loginWithTransport(portal, timeoutMs);
    return attempt?.info ?? null;
  }

  /**
   * Audit M-open (IPTV HTTPS migration): metadata endpoints almost always
   * support TLS even when stream URLs do not. Probe the https variant of an
   * http portal first and report which transport answered, so the UI can pin
   * the upgraded URL. Plain http is kept as the fallback so portals that never
   * implemented TLS keep working — availability beats purity here.
   */
  static async loginWithTransport(
    portal: IptvPortal,
    timeoutMs = 6000,
  ): Promise<{ info: Record<string, any>; base: string } | null> {
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const variants = cleanUrl.startsWith('http://')
      ? [`https://${cleanUrl.slice('http://'.length)}`, cleanUrl]
      : [cleanUrl];
    for (const base of variants) {
      const url = `${base}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}`;
      const text = await this.httpGet(url, timeoutMs);
      if (!text) continue;
      try {
        const root = JSON.parse(text);
        const info = root.user_info || root;
        const auth = String(info.auth ?? '');
        const status = String(info.status ?? '').toLowerCase();
        const ok = auth === '1' || status === 'active' || !!root.user_info;
        if (ok) return { info, base };
      } catch {
        // Not a valid Xtream response — try the next transport.
      }
    }
    return null;
  }

  static async verifyOrNull(portal: IptvPortal, timeoutMs = 6000): Promise<VerifiedPortal | null> {
    const attempt = await this.loginWithTransport(portal, timeoutMs);
    if (!attempt) return null;
    const info = attempt.info;
    // Pin the working (possibly https-upgraded) transport for every later call.
    const verifiedPortal: IptvPortal = attempt.base !== portal.url ? { ...portal, url: attempt.base } : portal;
    return {
      portal: verifiedPortal,
      name: info.username ? String(info.username) : portal.username,
      expiry: this.formatExpiry(info.exp_date),
      maxConnections: String(info.max_connections ?? '1'),
      activeConnections: String(info.active_cons ?? '0'),
    };
  }

  static formatExpiry(raw?: any): string {
    if (!raw) return 'Unknown';
    const ts = parseInt(String(raw), 10);
    if (isNaN(ts)) return String(raw);
    try {
      const d = new Date(ts * 1000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
    } catch {
      return String(raw);
    }
  }

  static async categories(portal: IptvPortal, kind: 'live' | 'vod' | 'series' = 'live'): Promise<IptvCategory[]> {
    const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories';
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const url = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=${action}`;
    const text = await this.httpGet(url, 8000);
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr.map((item: any) => ({
        id: String(item.category_id ?? ''),
        name: String(item.category_name ?? 'Unknown Category'),
      }));
    } catch {
      return [];
    }
  }

  static async streams(portal: IptvPortal, categoryId = '', kind: 'live' | 'vod' | 'series' = 'live'): Promise<IptvStream[]> {
    const action = kind === 'live' ? 'get_live_streams' : kind === 'vod' ? 'get_vod_streams' : 'get_series';
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const base = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=${action}`;
    const url = categoryId ? `${base}&category_id=${this.enc(categoryId)}` : base;
    const text = await this.httpGet(url, 12000);
    if (!text) return [];
    try {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) return [];
      return arr.map((o: any) => {
        const ext = kind === 'live' ? 'ts' : (o.container_extension || 'mp4');
        const id = kind === 'series' ? String(o.series_id || o.id || '') : String(o.stream_id || o.id || '');
        return {
          streamId: id,
          name: String(o.name || o.title || 'Live Channel'),
          icon: String(o.stream_icon || o.cover || ''),
          categoryId: String(o.category_id || ''),
          containerExt: ext,
          kind,
          epgChannelId: o.epg_channel_id ? String(o.epg_channel_id) : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  static streamUrl(portal: IptvPortal, stream: IptvStream): string {
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const user = this.enc(portal.username);
    const pass = this.enc(portal.password);
    const ext = stream.containerExt || (stream.kind === 'live' ? 'ts' : 'mp4');
    const folder = stream.kind === 'live' ? 'live' : 'movie';
    return `${cleanUrl}/${folder}/${user}/${pass}/${stream.streamId}.${ext}`;
  }

  static async shortEpg(portal: IptvPortal, streamId: string, limit = 2): Promise<EpgEntry[]> {
    if (!streamId) return [];
    const cleanUrl = portal.url.replace(/\/+$/, '');
    const url = `${cleanUrl}/player_api.php?username=${this.enc(portal.username)}&password=${this.enc(portal.password)}&action=get_short_epg&stream_id=${this.enc(streamId)}&limit=${limit}`;
    const text = await this.httpGet(url, 6000);
    if (!text) return [];
    try {
      const root = JSON.parse(text);
      const arr = Array.isArray(root) ? root : (root.epg_listings || []);
      const decode64 = (s: any) => {
        if (!s) return '';
        try {
          return atob(String(s));
        } catch {
          return String(s);
        }
      };
      return arr.map((e: any) => ({
        title: decode64(e.title),
        description: decode64(e.description),
        start: String(e.start || e.start_timestamp || ''),
        stop: String(e.end || e.stop_timestamp || ''),
      }));
    } catch {
      return [];
    }
  }
}

// ── Alive Checker (sniffs stream playback headers) ───────────────────────────

export class IptvAliveChecker {
  static async isAlive(streamUrl: string, timeoutMs = 5000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Range: 'bytes=0-1024',
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        },
        signal: controller.signal,
      });
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (resp.status >= 200 && resp.status < 300) {
        if (ct.includes('html') || ct.includes('json')) return false;
        return true;
      }
      return resp.status === 206;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Xtream-Codes Scraper (Reddit + Pastes + Curated Fallbacks) ────────────────

export class IptvScraper {
  // Reddit aggressively blocks non-browser clients, so the fetcher races the
  // direct endpoint and several text proxies per subreddit.
  private static readonly REDDIT_SUBS = ['IPTV_ZONENEW', 'IPTVReseller', 'iptvdoors'];
  private static readonly PROXIES = [
    'https://corsproxy.io/?{URL}',
    'https://api.allorigins.win/raw?url={URL}',
    'https://api.codetabs.com/v1/proxy?quest={URL}',
  ];

  private static readonly URL_PARAM_REGEX = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user)=([^&\s"'<]+)\s*&(?:password|pass)=([^&\s"'<]+)/gi;
  private static readonly LABEL_REGEX = /(?:Portal|Host(?:\s*URL)?|H[ᴏo]s[ᴛt]|Panel|Real|URL|🔗|🌍|🌐)[\s:.-]*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|Usu[áa]rio|Usuario|User|Us[ᴇe]r|Us[ᴜu][ᴀa]r[ɪi][ᴏo]|👤)[\s:.-]+([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Senha|Contrase[ñn]a|Pass|P[ᴀa]ss|S[ᴇe]nh[ᴀa]|🔑)[\s:.-]+([^\s|<"'\n]+)/gi;
  private static readonly URL_PARAM_PASS_FIRST = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:password|pass|pwd)=([^&\s"'<]+)\s*&(?:[^\s"'<]*?&)?(?:username|user|usr|login|account)=([^&\s"'<]+)/gi;
  private static readonly LABEL_WITH_PORT = /(?:Portal(?:-URL)?|Host(?:\s*URL)?|Panel|Server|Real-URL|URL|Link|Servidor|H[ôo]te|Сервер)\s*[:=➤\-•*|]?\s*(https?:\/\/[^\s<"'\n]+)[\s\S]{1,600}?(?:Username|User|Usr|Login|Account|Логин|👤)\s*[:=➤\-•*|]?\s*([^\s|<"'\n]+)[\s\S]{1,300}?(?:Password|Pass|Pwd|Senha|Clave|Пароль|🔑)\s*[:=➤\-•*|]?\s*([^\s|<"'\n]+)(?:[\s\S]{1,200}?(?:Port|Porta|Puerto|Порт)\s*[:=➤\-•*|]?\s*(\d+))?/gi;
  private static readonly STREAM_URI_REGEX = /(https?:\/\/[^\s/]+(?::\d+)?)\/(?:live|movie|series)\/([^/\s]+)\/([^/\s]+)\/\d+/gi;
  private static readonly COMBO_REGEX = /(https?:\/\/[a-zA-Z0-9.\-_]+(?::\d+)?(?:\/[^\s:|,\t\n]*)?)\s*[:|,\t ]\s*([a-zA-Z0-9_\-.@]+)\s*[:|,\t ]\s*([a-zA-Z0-9_\-.@!#$%^&*+=]+)/;
  private static readonly PASTE_HOSTS = ['paste.sh', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co'];

  static extractPortals(text: string, source = 'Scraper'): IptvPortal[] {
    const out: Map<string, IptvPortal> = new Map();
    if (!text || text.length < 15) return [];
    // Junk-code guard (port of PlayTorrio): JS bodies are not portal lists.
    if (IptvScraper.isJunkCode(text)) return [];

    const normalized = text
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');

    const add = (rawUrl: string, rawUser: string, rawPass: string, rawPort?: string) => {
      let url = rawUrl.trim();
      const qIdx = url.indexOf('?');
      if (qIdx >= 0) url = url.substring(0, qIdx);
      url = url.replace(/\/(?:get|live|portal|c|index|playlist|player_api)\.php$/i, '').replace(/\/+$/, '');
      if (!url.startsWith('http')) url = `https://${url}`;
      if (rawPort && !/:\d+$/.test(url)) {
        const port = Number.parseInt(rawPort, 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) url = `${url}:${port}`;
      }

      const user = rawUser.replace(/^[=:]+/, '').trim();
      const pass = rawPass.replace(/^[=:]+/, '').trim();
      if (!url || user.length < 3 || pass.length < 3) return;
      // Credential sanity guard: no URLs, no bare scheme words leaking in
      // from adjacent labels (e.g. "User: http://x Pass: normal123").
      if (user.includes('://') || pass.includes('://')) return;
      if (/^https?$/i.test(user) || /^https?$/i.test(pass)) return;
      if (/^https?:/.test(user) || /^https?:/.test(pass)) return;

      const key = `${url}|${user}|${pass}`.toLowerCase();
      if (!out.has(key)) {
        out.set(key, { url, username: user, password: pass, source });
      }
    };

    const run = (pattern: RegExp) => {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(normalized)) !== null) {
        add(m[1], m[2], m[3], m[4]);
      }
    };

    // 1. URL query params — user-first and pass-first orders.
    run(new RegExp(IptvScraper.URL_PARAM_REGEX.source, 'gi'));
    run(new RegExp(IptvScraper.URL_PARAM_PASS_FIRST.source, 'gi'));
    // 2. Multi-line labeled blocks (multilingual, optional port).
    run(new RegExp(IptvScraper.LABEL_REGEX.source, 'gi'));
    run(new RegExp(IptvScraper.LABEL_WITH_PORT.source, 'gi'));
    // 3. Stream URI path: http://host:port/live/user/pass/123.ts
    run(new RegExp(IptvScraper.STREAM_URI_REGEX.source, 'gi'));
    // 4. Line combo: host:port:user:pass | host|user|pass | host user pass
    run(new RegExp(IptvScraper.COMBO_REGEX.source, 'gim'));

    return Array.from(out.values());
  }

  private static isJunkCode(text: string): boolean {
    const markers = ['Array.isArray', 'prototype.', 'function(', 'var ', 'const ', 'let ', 'window.', 'document.'];
    let hits = 0;
    for (const marker of markers) {
      if (text.includes(marker)) hits += 1;
      if (hits >= 2) return true;
    }
    return false;
  }

  /**
   * PasteSh decryptor (port of PlayTorrio's PasteShDecryptor): paste.sh
   * stores `Salted__` + 8-byte salt + AES-256-CBC ciphertext as base64, keyed
   * by `id + serverKey + clientKey + origin` via PBKDF2-HMAC-SHA512 (1 iter),
   * with an EVP_BytesToKey(MD5) fallback for legacy pastes. `urlWithHash`
   * must include the #clientkey fragment.
   */
  static async decryptPasteSh(urlWithHash: string): Promise<string> {
    const hashIdx = urlWithHash.indexOf('#');
    if (hashIdx <= 0) return '';
    const baseUrl = urlWithHash.substring(0, hashIdx);
    const clientKey = urlWithHash.substring(hashIdx + 1);
    const id = baseUrl.substring(baseUrl.lastIndexOf('/') + 1);
    try {
      const raw = await IptvScraper.fetchPasteRaw(baseUrl);
      if (!raw) return '';
      const lines = raw.split('\n');
      if (!lines.length) return '';
      const serverKey = lines[0].trim();
      const b64 = lines.slice(1).join('').trim();
      if (!b64) return '';
      const cipherWords = CryptoJS.enc.Base64.parse(b64);
      const binary = cipherWords.toString(CryptoJS.enc.Latin1);
      if (binary.length < 17 || binary.slice(0, 8) !== 'Salted__') return '';
      const salt = CryptoJS.enc.Latin1.parse(binary.slice(8, 16));
      const ciphertext = CryptoJS.enc.Latin1.parse(binary.slice(16));
      const password = `${id}${serverKey}${clientKey}https://paste.sh`;
      const params = { ciphertext, padding: CryptoJS.pad.Pkcs7 } as CryptoJS.lib.CipherParams;

      // 1) PBKDF2-HMAC-SHA512, 1 iteration, 48 bytes (32 key + 16 IV).
      try {
        const derived = CryptoJS.PBKDF2(password, salt, {
          keySize: 48 / 4,
          iterations: 1,
          hasher: CryptoJS.algo.SHA512,
        });
        const decrypted = CryptoJS.AES.decrypt(params, CryptoJS.lib.WordArray.create(derived.words.slice(0, 8)), {
          iv: CryptoJS.lib.WordArray.create(derived.words.slice(8, 12)),
        });
        const out = decrypted.toString(CryptoJS.enc.Utf8);
        if (out) return out;
      } catch {
        // fall through to the EVP path
      }

      // 2) EVP_BytesToKey(MD5) fallback (legacy pastes): D_i = MD5(D_{i-1} || pass || salt).
      try {
        const words: number[] = [];
        let prev = CryptoJS.lib.WordArray.create([]);
        while (words.length < 12) {
          prev = CryptoJS.MD5(prev.clone().concat(CryptoJS.enc.Utf8.parse(password)).concat(salt));
          for (const w of prev.words) words.push(w);
        }
        const decrypted = CryptoJS.AES.decrypt(params, CryptoJS.lib.WordArray.create(words.slice(0, 8)), {
          iv: CryptoJS.lib.WordArray.create(words.slice(8, 12)),
        });
        return decrypted.toString(CryptoJS.enc.Utf8);
      } catch {
        return '';
      }
    } catch {
      return '';
    }
  }

  /** Raw-text fetchers for the paste sites PlayTorrio supports. */
  private static async fetchPasteRaw(url: string): Promise<string | null> {
    try {
      if (url.includes('pastebin.com/') && !url.includes('/raw/')) {
        const id = url.split('/').pop() || '';
        const resp = await fetchWithTimeout(`https://pastebin.com/raw/${id}`, undefined, 6000);
        return resp.ok ? await resp.text() : null;
      }
      if (url.includes('pastes.dev/')) {
        const id = url.split('/').pop() || '';
        const resp = await fetchWithTimeout(`https://api.pastes.dev/${id}`, undefined, 6000);
        return resp.ok ? await resp.text() : null;
      }
      if (url.includes('rentry.co/') && !url.includes('/raw')) {
        const resp = await fetchWithTimeout(`${url.replace(/\/$/, '')}/raw`, undefined, 6000);
        return resp.ok ? await resp.text() : null;
      }
      const resp = await fetchWithTimeout(url, undefined, 6000);
      return resp.ok ? await resp.text() : null;
    } catch {
      return null;
    }
  }

  /** Chase paste-site deep links inside a post body (port of PlayTorrio, bounded). */
  static async chaseDeepLinks(body: string, out: IptvPortal[], maxResults: number, source: string): Promise<void> {
    const deepLinks = new Set<string>();
    for (const match of body.matchAll(/[A-Za-z0-9+/=]{24,}/g)) {
      try {
        const decoded = atob(match[0]);
        if (decoded.startsWith('http') && IptvScraper.PASTE_HOSTS.some((host) => decoded.includes(host))) {
          deepLinks.add(decoded);
        } else if (!decoded.startsWith('http') && decoded.includes(':')) {
          out.push(...IptvScraper.extractPortals(decoded, `${source} (decoded)`));
        }
      } catch {
        // not base64
      }
    }
    for (const match of body.matchAll(/https?:\/\/(?:paste\.sh|pastebin\.com|justpaste\.it|controlc\.com|pastes\.dev|text\.is|rentry\.co)\/[a-zA-Z0-9#_=-]+/g)) {
      deepLinks.add(match[0]);
    }
    for (const link of Array.from(deepLinks).slice(0, 4)) {
      if (out.length >= maxResults) return;
      let text: string | null = null;
      if (link.includes('paste.sh') && link.includes('#')) {
        text = await IptvScraper.decryptPasteSh(link);
      } else {
        text = await IptvScraper.fetchPasteRaw(link);
      }
      if (!text) continue;
      out.push(...IptvScraper.extractPortals(text, `${source} (deep)`));
    }
  }

  static async scrapeRedditPortals(limit = 25): Promise<IptvPortal[]> {
    let jsonText: string | null = null;

    for (const sub of this.REDDIT_SUBS) {
      const targetUrl = `https://www.reddit.com/r/${sub}/new.json?limit=${limit}&sort=new`;

      // Inside the APK the native client bypasses CORS entirely — reddit's
      // JSON endpoints need no proxy at all when reddit allows the client.
      try {
        const direct = await nativeFetchText(targetUrl, { timeoutMs: 6000 });
        if (direct.ok && direct.data.trim().startsWith('{')) {
          jsonText = direct.data;
          break;
        }
      } catch {
        // Fall through to CORS proxies.
      }

      if (jsonText) break;
      for (const tmpl of this.PROXIES) {
        try {
          const proxyUrl = tmpl.replace('{URL}', encodeURIComponent(targetUrl));
          const resp = await fetchWithTimeout(proxyUrl, { headers: { Accept: 'application/json' } }, 5000);
          if (resp.ok) {
            const body = await resp.text();
            if (body.trim().startsWith('{')) {
              jsonText = body;
              break;
            }
          }
        } catch {
          continue;
        }
      }
      if (jsonText) break;
    }

    if (!jsonText) return [];
    try {
      const data = JSON.parse(jsonText)?.data?.children || [];
      const portals: IptvPortal[] = [];
      for (const child of data) {
        if (portals.length >= limit) break;
        const post = child.data;
        const text = `${post.title || ''} ${post.selftext || ''}`;
        portals.push(...this.extractPortals(text, 'Reddit'));
        // Chase paste-site deep links (port of PlayTorrio) — many portal
        // lists live behind paste.sh/pastebin links inside the posts.
        await this.chaseDeepLinks(text, portals, limit + 20, 'Reddit');
      }
      return portals.slice(0, limit);
    } catch {
      return [];
    }
  }

  static getFallbackPortals(): IptvPortal[] {
    // HTTPS-preferred curated portals; loginWithTransport still falls back to
    // plain http per portal when TLS is not available.
    return [
      { url: 'https://watch.topiptv.xyz:80', username: 'stream', password: 'password', source: 'Curated' },
      { url: 'https://cdn.megastreams.io:8080', username: 'free', password: 'tv', source: 'Curated' },
      { url: 'https://live.stream4k.xyz:80', username: 'demo', password: 'demo', source: 'Curated' },
    ];
  }
}

// ── Hardcoded Curated Channels (50+ channels matching PlayTorrio) ─────────────

export class HardcodedChannels {
  private static readonly GRAD_FIGHT: [string, string] = ['#F97316', '#7C2D12'];
  private static readonly GRAD_WRESTLING: [string, string] = ['#B91C1C', '#1F2937'];
  private static readonly GRAD_MOTOR: [string, string] = ['#DC2626', '#111827'];
  private static readonly GRAD_SOCCER: [string, string] = ['#7C3AED', '#22D3EE'];
  private static readonly GRAD_UK_SPORT: [string, string] = ['#1D4ED8', '#22C55E'];
  private static readonly GRAD_US_SPORT: [string, string] = ['#EF4444', '#F59E0B'];
  private static readonly GRAD_NEWS: [string, string] = ['#0EA5E9', '#1E293B'];
  private static readonly GRAD_MOVIE: [string, string] = ['#EC4899', '#8B5CF6'];
  private static readonly GRAD_KIDS: [string, string] = ['#FBBF24', '#F472B6'];
  private static readonly GRAD_MUSIC: [string, string] = ['#06B6D4', '#A855F7'];

  static readonly all: HardcodedChannel[] = [
    // ── Combat Sports ──
    {
      id: 'ufc',
      name: 'UFC',
      shortName: 'UFC',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['ufc', 'ufc fight pass', 'ufc ppv', 'ufc on espn', 'ufc fight night', 'ufc 3', 'ufc apex'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/0/0d/UFC_logo.svg',
    },
    {
      id: 'wwe',
      name: 'WWE Network',
      shortName: 'WWE',
      category: 'Combat',
      gradient: this.GRAD_WRESTLING,
      keywords: ['wwe', 'wwe network', 'wwe ppv', 'wwe raw', 'wwe smackdown', 'wwe nxt', 'wrestlemania', 'summerslam'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/0/03/WWE_Logo.svg',
    },
    {
      id: 'aew',
      name: 'AEW Wrestling',
      shortName: 'AEW',
      category: 'Combat',
      gradient: this.GRAD_WRESTLING,
      keywords: ['aew', 'all elite wrestling', 'aew dynamite', 'aew rampage', 'aew collision', 'aew revolution'],
    },
    {
      id: 'boxing',
      name: 'Boxing TV',
      shortName: 'BOX',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['boxing', 'ppv box', 'fight night', 'top rank', 'matchroom', 'boxnation', 'fight network', 'dazn boxing'],
      exclude: ['box office', 'xbox', 'boxset', 'music box'],
    },
    {
      id: 'one_championship',
      name: 'ONE Championship',
      shortName: 'ONE',
      category: 'Combat',
      gradient: this.GRAD_FIGHT,
      keywords: ['one championship', 'one fc', 'one mma'],
    },

    // ── Motorsport ──
    {
      id: 'f1',
      name: 'Formula 1',
      shortName: 'F1',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['f1 tv', 'formula 1', 'formula one', 'sky f1', 'skysports f1', 'sky sport f1', 'sky sports f1', 'grand prix', 'f1 race', 'ssf1', 'ss f1'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/3/33/F1.svg',
    },
    {
      id: 'motogp',
      name: 'MotoGP',
      shortName: 'GP',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['motogp', 'moto gp', 'moto-gp', 'moto2', 'moto3'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/5/52/Moto_Gp_logo.svg',
    },
    {
      id: 'nascar',
      name: 'NASCAR',
      shortName: 'NSC',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['nascar', 'nascar cup', 'daytona 500', 'nascar xfinity'],
    },
    {
      id: 'indycar',
      name: 'IndyCar',
      shortName: 'INDY',
      category: 'Motorsport',
      gradient: this.GRAD_MOTOR,
      keywords: ['indycar', 'indy car', 'indy 500', 'indianapolis 500'],
    },

    // ── Soccer / Football ──
    {
      id: 'bein_sports',
      name: 'beIN Sports',
      shortName: 'BEIN',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['bein sport', 'bein sports', 'beinsports', 'bein 1', 'bein 2', 'bein 3', 'bein max'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/a/af/BeIN_Sports_logo.svg',
    },
    {
      id: 'sky_sports',
      name: 'Sky Sports Main Event',
      shortName: 'SKY',
      category: 'Soccer',
      gradient: this.GRAD_UK_SPORT,
      keywords: ['sky sport', 'sky sports', 'skysports', 'sky sports main event', 'sky sports premier league', 'sky sports football'],
      exclude: ['sky sports news'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/3/30/Sky_Sports_logo_2020.svg',
    },
    {
      id: 'tnt_sports',
      name: 'TNT Sports',
      shortName: 'TNT',
      category: 'Soccer',
      gradient: this.GRAD_UK_SPORT,
      keywords: ['tnt sport', 'tnt sports', 'bt sport', 'btsport', 'tnt sports 1', 'tnt sports 2', 'tnt sports 3'],
    },
    {
      id: 'champions_league',
      name: 'UEFA Champions League',
      shortName: 'UCL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['champions league', 'uefa champions', 'ucl ', 'uefa europa', 'europa league', 'conference league'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/b/bf/UEFA_Champions_League_logo_2.svg',
    },
    {
      id: 'premier_league',
      name: 'Premier League',
      shortName: 'EPL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['premier league', 'epl ', 'barclays premier', 'sky sports pl', 'peacock premier league'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/f/f2/Premier_League_Logo.svg',
    },
    {
      id: 'la_liga',
      name: 'La Liga TV',
      shortName: 'LL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['laliga', 'la liga', 'movistar laliga', 'laliga tv', 'laliga ea sports'],
    },
    {
      id: 'serie_a',
      name: 'Serie A Calcio',
      shortName: 'SA',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['serie a', 'dazn italia', 'sky calcio', 'calcio', 'serie a tim'],
    },
    {
      id: 'bundesliga',
      name: 'Bundesliga',
      shortName: 'BL',
      category: 'Soccer',
      gradient: this.GRAD_SOCCER,
      keywords: ['bundesliga', 'sky bundesliga', 'dazn bundes', 'german football'],
    },
    {
      id: 'dazn',
      name: 'DAZN Live',
      shortName: 'DAZN',
      category: 'Soccer',
      gradient: this.GRAD_FIGHT,
      keywords: ['dazn', 'dazn 1', 'dazn 2'],
    },

    // ── US Sports ──
    {
      id: 'espn',
      name: 'ESPN',
      shortName: 'ESPN',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['espn', 'espn2', 'espn 2', 'espnews', 'espn+', 'espn plus', 'espnu'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ESPN_wordmark.svg',
    },
    {
      id: 'fox_sports',
      name: 'Fox Sports 1 (FS1)',
      shortName: 'FOX',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['fox sport', 'fox sports', 'fs1', 'fs2', 'fox soccer'],
    },
    {
      id: 'nbc_sports',
      name: 'NBC Sports',
      shortName: 'NBC',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nbc sport', 'nbc sports', 'nbcsn', 'peacock sport'],
    },
    {
      id: 'cbs_sports',
      name: 'CBS Sports Network',
      shortName: 'CBS',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['cbs sport', 'cbs sports', 'cbs sports network', 'cbs sports hq'],
    },
    {
      id: 'nba',
      name: 'NBA TV',
      shortName: 'NBA',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nba ', 'nba tv', 'nba league pass', 'nba hd'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/0/03/National_Basketball_Association_logo.svg',
    },
    {
      id: 'nfl',
      name: 'NFL Network',
      shortName: 'NFL',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nfl ', 'nfl network', 'nfl hd', 'nfl sunday ticket', 'nfl game pass'],
      logo: 'https://upload.wikimedia.org/wikipedia/en/a/a2/National_Football_League_logo.svg',
    },
    {
      id: 'nfl_redzone',
      name: 'NFL RedZone',
      shortName: 'RZ',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['redzone', 'red zone', 'nfl redzone'],
    },
    {
      id: 'mlb',
      name: 'MLB Network',
      shortName: 'MLB',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['mlb ', 'mlb network', 'mlb tv', 'mlb extra innings'],
    },
    {
      id: 'nhl',
      name: 'NHL Network',
      shortName: 'NHL',
      category: 'US Sports',
      gradient: this.GRAD_US_SPORT,
      keywords: ['nhl ', 'nhl network', 'nhl tv', 'hockey night'],
    },
    {
      id: 'tennis_channel',
      name: 'Tennis Channel',
      shortName: 'TEN',
      category: 'US Sports',
      gradient: this.GRAD_SOCCER,
      keywords: ['tennis channel', 'tennis tv', 'atp tennis', 'wta tennis', 'wimbledon', 'us open tennis'],
    },
    {
      id: 'golf_channel',
      name: 'Golf Channel',
      shortName: 'GLF',
      category: 'US Sports',
      gradient: this.GRAD_SOCCER,
      keywords: ['golf channel', 'golf tv', 'sky golf', 'pga tour', 'masters golf'],
    },

    // ── Cricket ──
    {
      id: 'cricket',
      name: 'Cricket Live',
      shortName: 'CRK',
      category: 'Cricket',
      gradient: this.GRAD_SOCCER,
      keywords: ['cricket', 'willow cricket', 'willow tv', 'star sports cricket', 'sky sports cricket', 'sony ten cricket', 'ipl '],
    },

    // ── News ──
    {
      id: 'cnn',
      name: 'CNN International',
      shortName: 'CNN',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['cnn', 'cnn international', 'cnn hd'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/CNN.svg',
    },
    {
      id: 'bbc_news',
      name: 'BBC News',
      shortName: 'BBC',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['bbc news', 'bbc world', 'bbc world news'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/e/eb/BBC_News_2022.svg',
    },
    {
      id: 'sky_news',
      name: 'Sky News',
      shortName: 'SKN',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['sky news', 'sky news arabia'],
    },
    {
      id: 'al_jazeera',
      name: 'Al Jazeera English',
      shortName: 'AJ',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['al jazeera', 'aljazeera', 'al jazeera english'],
    },
    {
      id: 'bloomberg',
      name: 'Bloomberg Television',
      shortName: 'BLM',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['bloomberg', 'bloomberg tv'],
    },
    {
      id: 'cnbc',
      name: 'CNBC',
      shortName: 'CNBC',
      category: 'News',
      gradient: this.GRAD_NEWS,
      keywords: ['cnbc', 'cnbc international'],
    },

    // ── Movies & Premium ──
    {
      id: 'hbo',
      name: 'HBO Max',
      shortName: 'HBO',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['hbo', 'hbo max', 'hbo signature', 'hbo family', 'hbo 2'],
      logo: 'https://upload.wikimedia.org/wikipedia/commons/d/de/HBO_logo.svg',
    },
    {
      id: 'showtime',
      name: 'Showtime',
      shortName: 'SHO',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['showtime', 'showtime 2', 'paramount+ with showtime'],
    },
    {
      id: 'starz',
      name: 'Starz',
      shortName: 'STZ',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['starz', 'starz encore'],
    },
    {
      id: 'cinemax',
      name: 'Cinemax',
      shortName: 'CMX',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: ['cinemax', 'max prime', 'actionmax'],
    },
    {
      id: 'amc',
      name: 'AMC',
      shortName: 'AMC',
      category: 'Movies',
      gradient: this.GRAD_MOVIE,
      keywords: [' amc ', 'amc hd', 'amc usa', 'amc network', 'amc+'],
    },

    // ── Kids & Docs ──
    {
      id: 'discovery',
      name: 'Discovery Channel',
      shortName: 'DISC',
      category: 'Kids & Docs',
      gradient: this.GRAD_SOCCER,
      keywords: ['discovery channel', 'discovery hd', 'investigation discovery'],
    },
    {
      id: 'natgeo',
      name: 'National Geographic',
      shortName: 'GEO',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['national geographic', 'nat geo', 'natgeo wild'],
    },
    {
      id: 'disney',
      name: 'Disney Channel',
      shortName: 'DIS',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['disney channel', 'disney xd', 'disney junior'],
    },
    {
      id: 'cartoon_network',
      name: 'Cartoon Network',
      shortName: 'CN',
      category: 'Kids & Docs',
      gradient: this.GRAD_KIDS,
      keywords: ['cartoon network', 'cartoon network hd', 'boomerang'],
    },

    // ── Music ──
    {
      id: 'mtv',
      name: 'MTV Live',
      shortName: 'MTV',
      category: 'Music',
      gradient: this.GRAD_MUSIC,
      keywords: ['mtv live', 'mtv hits', 'mtv 80s', 'mtv 90s', 'club mtv', 'vh1'],
    },
  ];

  static byId(id: string): HardcodedChannel | undefined {
    return this.all.find((c) => c.id === id);
  }

  static matches(streamName: string, keywords: string[], exclude: string[] = []): boolean {
    const s = streamName.toLowerCase();
    for (const ex of exclude) {
      if (s.includes(ex.toLowerCase())) return false;
    }
    for (const kw of keywords) {
      if (s.includes(kw.toLowerCase())) return true;
    }
    return false;
  }
}

// ── M3U / M3U8 Playlist Parser ────────────────────────────────────────────────

export class M3uParser {
  static parse(content: string): M3uChannel[] {
    if (!content || !content.trim()) return [];
    const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');

    const channels: M3uChannel[] = [];
    let pendingName = '';
    let pendingLogo = '';
    let pendingGroup = '';
    let pendingTvgId = '';
    let pendingTvgName = '';

    const reset = () => {
      pendingName = '';
      pendingLogo = '';
      pendingGroup = '';
      pendingTvgId = '';
      pendingTvgName = '';
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('#EXTM3U')) continue;

      if (line.startsWith('#EXTINF:')) {
        const commaIdx = line.indexOf(',');
        const attrPart = commaIdx > 0 ? line.substring(8, commaIdx) : line.substring(8);
        const namePart = commaIdx > 0 ? line.substring(commaIdx + 1).trim() : '';

        pendingLogo = this.extractAttr(attrPart, 'tvg-logo');
        pendingGroup = this.extractAttr(attrPart, 'group-title');
        pendingTvgId = this.extractAttr(attrPart, 'tvg-id');
        pendingTvgName = this.extractAttr(attrPart, 'tvg-name');
        pendingName = namePart || pendingTvgName || 'Channel';
        continue;
      }

      if (line.startsWith('#EXTGRP:')) {
        pendingGroup = line.substring(8).trim();
        continue;
      }

      if (line.startsWith('#')) continue;

      // URL line
      if (line.startsWith('http://') || line.startsWith('https://') || line.includes('.m3u8') || line.includes('.ts')) {
        channels.push({
          name: pendingName || line,
          url: line,
          logo: pendingLogo || undefined,
          group: pendingGroup || undefined,
          tvgId: pendingTvgId || undefined,
          tvgName: pendingTvgName || undefined,
        });
        reset();
      }
    }

    return channels;
  }

  private static extractAttr(attrs: string, name: string): string {
    const regex = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
    const match = regex.exec(attrs);
    return match ? (match[1] || match[2] || match[3] || '').trim() : '';
  }

  static readonly defaultPlaylists: Record<string, string> = {
    Sports: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
    News: 'https://iptv-org.github.io/iptv/categories/news.m3u',
    Movies: 'https://iptv-org.github.io/iptv/categories/movies.m3u',
    English: 'https://iptv-org.github.io/iptv/languages/eng.m3u',
    Spanish: 'https://iptv-org.github.io/iptv/languages/spa.m3u',
    Music: 'https://iptv-org.github.io/iptv/categories/music.m3u',
  };

  static readonly fallbackChannels: M3uChannel[] = [
    { name: 'Red Bull TV', url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8', group: 'Sports', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f5/Red_Bull_TV_logo.svg/1200px-Red_Bull_TV_logo.svg.png' },
    { name: 'Sky News UK', url: 'https://skynews-live.akamaized.net/hls/live/2028678/skynews/live.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Sky_News_2020.svg/1200px-Sky_News_2020.svg.png' },
    { name: 'Bloomberg TV', url: 'https://bloomberg.com/media-manifest/streams/us.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Bloomberg_Television_logo.svg/1200px-Bloomberg_Television_logo.svg.png' },
    { name: 'France 24 English', url: 'https://static.france24.com/live/F24_EN_LO_HLS/live_tv.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/France_24_logo.svg/1200px-France_24_logo.svg.png' },
    { name: 'DW News English', url: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/Deutsche_Welle_symbol_2012.svg/1200px-Deutsche_Welle_symbol_2012.svg.png' },
    { name: 'Al Jazeera English', url: 'https://live-hls-web-aje.getaj.net/AJE/01.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Aljazeera_eng.svg/1200px-Aljazeera_eng.svg.png' },
    { name: 'Euronews English', url: 'https://euronews-euronews-world-1-gb.samsung.wurl.com/manifest/playlist.m3u8', group: 'News', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Euronews_2016_logo.svg/1200px-Euronews_2016_logo.svg.png' },
    { name: 'NASA TV HD', url: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8', group: 'Kids & Docs', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/NASA_logo.svg/1200px-NASA_logo.svg.png' },
    { name: 'Motorvision TV', url: 'https://motorvision-samsungau.amagi.tv/playlist.m3u8', group: 'Motorsport', logo: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=300&q=80' },
    { name: 'Fight Network TV', url: 'https://anthem-fightnetwork-1-us.plex.wurl.tv/playlist.m3u8', group: 'Combat', logo: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=300&q=80' },
    { name: 'Boxing Channel Live', url: 'https://stream.ecable.tv/boxing/index.m3u8', group: 'Combat', logo: 'https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&w=300&q=80' },
    { name: 'World Poker Tour', url: 'https://wpt-samsungus.amagi.tv/playlist.m3u8', group: 'US Sports', logo: 'https://images.unsplash.com/photo-1511193311914-0346f16efe90?auto=format&fit=crop&w=300&q=80' },
  ];
}

// ── Live Sports Matches Scraper (Nuvio Sports addon, Dami-TV & PPV.to) ────────

/** Nuvio Live Sports Stremio addon origin — real live matches with per-match streams. */
const NUVIO_SPORTS_ORIGIN = 'https://nuviosports.xyz/eyJ0aW1lem9uZSI6IkFzaWEvQ2FsY3V0dGEifQ';
const NUVIO_CATALOG_PATH = NUVIO_SPORTS_ORIGIN + '/catalog/tv/nuvio_sports_live.json';

export class LiveMatchesScraper {
  /** Real live matches from the Nuvio Live Sports catalog (posters included). */
  static async fetchNuvioSportsMatches(): Promise<LiveMatchEvent[]> {
    try {
      const resp = await fetchWithTimeout(NUVIO_CATALOG_PATH, undefined, 9000);
      if (!resp.ok) return [];
      const body = await resp.json();
      const metas = Array.isArray(body?.metas) ? body.metas : [];
      const results: LiveMatchEvent[] = [];
      for (const meta of metas) {
        const rawId = String(meta.id || '');
        const name = String(meta.name || '');
        if (!rawId || /subscription expired|donation/i.test(name)) continue;
        const desc = String(meta.description || '');
        // description looks like "🏆 League: X\n📅 Category: Y\n⏰ Status: 🔴 LIVE NOW"
        const league = /League:\s*(.+)/.exec(desc)?.[1]?.trim() || 'Live Sports';
        const category = /Category:\s*(.+)/.exec(desc)?.[1]?.trim() || 'Sports';
        results.push({
          id: 'nuvio-' + rawId,
          title: name.replace(/^🔴?\s*LIVE:?\s*/i, '').trim() || 'Live event',
          league,
          category,
          timeLabel: /LIVE/i.test(desc) ? 'LIVE NOW' : 'Live',
          isLive: true,
          // Streams resolve per-match on demand via /stream/tv/{id}.json
          streamUrl: '',
          poster: typeof meta.poster === 'string' ? meta.poster : undefined,
          nuvio: true,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  /** Resolves the best playable stream URL for a Nuvio match (http/https only). */
  static async resolveNuvioStream(matchId: string): Promise<string | null> {
    const prefix = 'nuvio-';
    const raw = matchId.startsWith(prefix) ? matchId.slice(prefix.length) : matchId;
    if (!raw) return null;
    try {
      const streamPath = NUVIO_SPORTS_ORIGIN + '/stream/tv/' + encodeURIComponent(raw) + '.json';
      const resp = await fetchWithTimeout(streamPath, undefined, 9000);
      if (!resp.ok) return null;
      const body = await resp.json();
      const streams = Array.isArray(body?.streams) ? body.streams : [];
      for (const stream of streams) {
        const url = typeof stream?.url === 'string' ? stream.url : '';
        if (/^https?:\/\//i.test(url)) return url;
        // Donation/link-only entries carry externalUrl instead of a stream — skipped.
      }
      return null;
    } catch {
      return null;
    }
  }

  static async fetchDamiTvMatches(): Promise<LiveMatchEvent[]> {
    try {
      const resp = await fetchWithTimeout('https://dami-tv.pro/papi/api/streams', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, 7000);
      if (!resp.ok) return [];
      const body = await resp.json();
      if (!body?.streams) return [];

      const results: LiveMatchEvent[] = [];
      const categories = body.streams || [];
      const now = Math.floor(Date.now() / 1000);

      for (const cat of categories) {
        const streamList = cat.streams || [];
        for (const s of streamList) {
          const startsAt = Number(s.starts_at) || 0;
          const endsAt = Number(s.ends_at) || 0;
          const isLive = (startsAt && endsAt) ? (now >= startsAt && now <= endsAt) : true;
          const timeLabel = isLive ? 'LIVE NOW' : startsAt > now ? new Date(startsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Scheduled';

          let poster = s.poster || '';
          if (poster.startsWith('/')) poster = `https://dami-tv.pro${poster}`;

          let homeBadge = s.teams?.home?.badge || '';
          if (homeBadge.startsWith('/')) homeBadge = `https://dami-tv.pro${homeBadge}`;
          let awayBadge = s.teams?.away?.badge || '';
          if (awayBadge.startsWith('/')) awayBadge = `https://dami-tv.pro${awayBadge}`;

          const streamUrl = s.iframe || s.url || '';
          if (!streamUrl && !s.id) continue;

          results.push({
            id: `dami-${s.id}`,
            title: s.name || `${s.teams?.home?.name || 'Home'} vs ${s.teams?.away?.name || 'Away'}`,
            league: s.league || cat.category_name || 'Live Sports',
            category: s.category_name || 'Sports',
            startsAt,
            endsAt,
            timeLabel,
            isLive,
            homeTeam: { name: s.teams?.home?.name || 'Home', badge: homeBadge },
            awayTeam: { name: s.teams?.away?.name || 'Away', badge: awayBadge },
            viewers: Number(s.viewers) || 0,
            streamUrl,
            poster,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  static async fetchPpvMatches(): Promise<LiveMatchEvent[]> {
    try {
      const resp = await fetchWithTimeout('https://old.ppv.to/api/streams', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, 7000);
      if (!resp.ok) return [];
      const body = await resp.json();
      const categories = body?.streams || [];
      const results: LiveMatchEvent[] = [];
      const now = Math.floor(Date.now() / 1000);

      for (const cat of categories) {
        const streamList = cat.streams || [];
        for (const s of streamList) {
          const startsAt = Number(s.starts_at) || 0;
          const endsAt = Number(s.ends_at) || 0;
          const alwaysLive = Number(s.always_live) === 1;
          const isLive = alwaysLive || ((startsAt && endsAt) ? (now >= startsAt && now <= endsAt) : true);
          const timeLabel = isLive ? 'LIVE NOW' : startsAt > now ? new Date(startsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Scheduled';

          results.push({
            id: `ppv-${s.id}`,
            title: s.name || 'PPV Live Event',
            league: s.tag || cat.category_name || 'PPV',
            category: s.category_name || 'Combat & Sports',
            startsAt,
            endsAt,
            timeLabel,
            isLive,
            streamUrl: s.iframe || s.uri_name ? `https://old.ppv.to/live/${s.uri_name}` : '',
            poster: s.poster || undefined,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  static getFallbackMatches(): LiveMatchEvent[] {
    return [];
  }
}

// ── Local Storage Store ───────────────────────────────────────────────────────

export class IptvStore {
  private static readonly PORTALS_KEY = 'praha.iptv.portals';
  private static readonly FAVORITES_KEY = 'praha.iptv.favorites';
  private static readonly PLAYLISTS_KEY = 'praha.iptv.playlists';

  static loadPortals(): VerifiedPortal[] {
    try {
      const raw = localStorage.getItem(this.PORTALS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static savePortals(portals: VerifiedPortal[]): void {
    try {
      localStorage.setItem(this.PORTALS_KEY, JSON.stringify(portals));
    } catch {
      // quota or storage unavailable
    }
  }

  static loadFavorites(): string[] {
    try {
      const raw = localStorage.getItem(this.FAVORITES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static saveFavorites(favs: string[]): void {
    try {
      localStorage.setItem(this.FAVORITES_KEY, JSON.stringify(favs));
    } catch {
      // quota
    }
  }

  static loadPlaylists(): M3uPlaylist[] {
    try {
      const raw = localStorage.getItem(this.PLAYLISTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  static savePlaylists(playlists: M3uPlaylist[]): void {
    try {
      localStorage.setItem(this.PLAYLISTS_KEY, JSON.stringify(playlists));
    } catch {
      // quota
    }
  }
}


// ── Public IPTV Sources (user-selectable catalog) ─────────────────────────────
// The first two entries are the featured/main sources; every source below is
// loadable through the Sources tab. Xtream portal scraping is untouched and
// remains a separate mechanism.

export interface IptvSourceEntry {
  id: string;
  name: string;
  description: string;
  kind: 'playlist' | 'epg' | 'selfhosted' | 'web';
  main?: boolean;
  /** Direct playlist URL for kind 'playlist'. */
  url?: string;
  /** XMLTV guide URL for kind 'epg' (reference; copyable in the UI). */
  epgUrl?: string;
  /** Suggested EPG guide that pairs with this playlist. */
  suggestedEpg?: string;
  homepage?: string;
}

export class IptvSources {
  private static readonly PLAYLIST_CACHE = new Map<string, M3uChannel[]>();
  private static readonly COUNTRIES_CACHE = new Map<string, Array<{ code: string; name: string }>>();

  /** Categories exposed for iptv-org. The adult category is deliberately absent. */
  static readonly IPTV_ORG_CATEGORIES = [
    'animation', 'auto', 'business', 'classic', 'comedy', 'cooking', 'culture',
    'documentary', 'education', 'entertainment', 'family', 'general', 'kids',
    'legislative', 'lifestyle', 'movies', 'music', 'news', 'outdoor', 'relax',
    'religious', 'science', 'series', 'shop', 'sports', 'travel', 'weather',
  ];

  static readonly CATALOG: IptvSourceEntry[] = [
    {
      id: 'iptv-org',
      name: 'iptv-org',
      description: 'The largest public IPTV collection — thousands of channels by country, language and category. Pick a country or category below.',
      kind: 'playlist',
      main: true,
      homepage: 'https://iptv-org.github.io/',
      suggestedEpg: 'iptv-epg:{cc}',
    },
    {
      id: 'stepdaddy',
      name: 'StepDaddyLiveHD',
      description: 'Self-hosted IPTV proxy for DLHD — 1,000+ TV channels plus live sports events. Enter the URL of your own StepDaddyLiveHD server (Docker or local) and PRAHA loads its playlist.m3u8.',
      kind: 'selfhosted',
      main: true,
      homepage: 'https://github.com/gookie-dev/StepDaddyLiveHD',
    },
    {
      id: 'doms9-base',
      name: 'doms9 IPTV — Base',
      description: 'Health-checked TV channels & sporting events, auto-updated daily (~160 working streams).',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/doms9/iptv/default/M3U8/base.m3u8',
      homepage: 'https://github.com/doms9/iptv',
    },
    {
      id: 'aria',
      name: 'Aria (stable)',
      description: 'Curated worldwide channels from official sources only; unstable streams excluded. Updated very often.',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/aria-tv/aria/main/aria.m3u',
      homepage: 'https://github.com/aria-tv/aria',
    },
    {
      id: 'aria-plus',
      name: 'Aria+ (extended)',
      description: 'Everything in Aria plus less-stable Xtream/Stalker portal streams.',
      kind: 'playlist',
      url: 'https://raw.githubusercontent.com/aria-tv/aria/main/aria%2B.m3u',
      homepage: 'https://github.com/aria-tv/aria',
    },
    {
      id: 'ibert-fmml-index',
      name: 'ibert — fanmingming index',
      description: 'Auto-updated mirror of fanmingming/live (~94 channels, EPG-friendly tvg-ids).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/fmml_index.m3u',
      suggestedEpg: 'https://m3u.ibert.me/epg/fmml.xml',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-all',
      name: 'ibert — epg.pw All',
      description: 'epg.pw aggregate playlist (~747 channels) with matching EPG ids.',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/all.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-yg',
      name: 'ibert — YanG-1989 Gather',
      description: 'Community-maintained Asian & international mix (~123 channels).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/y_g.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'ibert-ycl',
      name: 'ibert — YueChan Live',
      description: 'YueChan/Live mirror (~96 channels).',
      kind: 'playlist',
      url: 'https://m3u.ibert.me/ycl_iptv.m3u',
      homepage: 'https://m3u.ibert.me/',
    },
    {
      id: 'iptvcat',
      name: 'IPTVCat',
      description: 'Community playlist aggregator — browse iptvcat.net in your browser and paste any download URL into the M3U Playlists tab.',
      kind: 'web',
      homepage: 'https://iptvcat.net/home_7',
    },
  ];

  /** XMLTV guides the user can copy into players or future EPG wiring. */
  static readonly EPG_GUIDES: IptvSourceEntry[] = [
    { id: 'epg-in', name: 'EPG — India', description: '276 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-in.xml.gz' },
    { id: 'epg-us', name: 'EPG — United States', description: '12,430 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-us.xml.gz' },
    { id: 'epg-gb', name: 'EPG — United Kingdom', description: '882 channels · updated hourly', kind: 'epg', epgUrl: 'https://iptv-epg.org/files/epg-gb.xml.gz' },
    { id: 'epg-au', name: 'EPG — Australia (mjh.nz)', description: 'Free-to-air AU guide (XMLTV)', kind: 'epg', epgUrl: 'https://i.mjh.nz/au/epg.xml' },
    { id: 'epg-nz', name: 'EPG — New Zealand (mjh.nz)', description: 'Free-to-air NZ guide (XMLTV)', kind: 'epg', epgUrl: 'https://i.mjh.nz/nz/epg.xml' },
    { id: 'epg-pluto', name: 'EPG — Pluto TV (mjh.nz)', description: 'Pluto TV full guide (XMLTV, gzip)', kind: 'epg', epgUrl: 'https://i.mjh.nz/PlutoTV/all.xml.gz' },
    { id: 'epg-samsung', name: 'EPG — Samsung TV Plus (mjh.nz)', description: 'Samsung TV Plus guide (XMLTV, gzip)', kind: 'epg', epgUrl: 'https://i.mjh.nz/SamsungTVPlus/all.xml.gz' },
    { id: 'epg-fmml', name: 'EPG — fanmingming/live', description: 'Chinese + international guide (XMLTV)', kind: 'epg', epgUrl: 'https://m3u.ibert.me/epg/fmml.xml' },
  ];

  static readonly IPTV_ORG_COUNTRIES_FALLBACK: Array<{ code: string; name: string }> = [
    { code: 'in', name: 'India' }, { code: 'us', name: 'United States' }, { code: 'gb', name: 'United Kingdom' },
    { code: 'ca', name: 'Canada' }, { code: 'au', name: 'Australia' }, { code: 'de', name: 'Germany' },
    { code: 'fr', name: 'France' }, { code: 'it', name: 'Italy' }, { code: 'es', name: 'Spain' },
    { code: 'br', name: 'Brazil' }, { code: 'mx', name: 'Mexico' }, { code: 'jp', name: 'Japan' },
    { code: 'kr', name: 'South Korea' }, { code: 'ae', name: 'United Arab Emirates' }, { code: 'pk', name: 'Pakistan' },
    { code: 'id', name: 'Indonesia' }, { code: 'my', name: 'Malaysia' }, { code: 'sg', name: 'Singapore' },
    { code: 'tr', name: 'Turkey' }, { code: 'ru', name: 'Russia' }, { code: 'za', name: 'South Africa' },
    { code: 'ar', name: 'Argentina' }, { code: 'nl', name: 'Netherlands' }, { code: 'pt', name: 'Portugal' },
    { code: 'th', name: 'Thailand' }, { code: 'ph', name: 'Philippines' },
  ];

  /**
   * Country list for the iptv-org picker, from the official iptv-org API with
   * a curated offline fallback so the picker always renders.
   */
  static async listIptvOrgCountries(): Promise<Array<{ code: string; name: string }>> {
    const cached = this.COUNTRIES_CACHE.get('all');
    if (cached) return cached;
    try {
      const res = await nativeFetchText('https://iptv-org.github.io/api/countries.json', { timeoutMs: 10000 });
      if (res.ok && res.data.trim().startsWith('[')) {
        const parsed = JSON.parse(res.data) as Array<{ code?: string; name?: string }>;
        const list = parsed
          .filter((c) => c.code && c.name)
          .map((c) => ({ code: String(c.code).toLowerCase(), name: String(c.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (list.length) {
          this.COUNTRIES_CACHE.set('all', list);
          evictOldest(this.COUNTRIES_CACHE, 2);
          return list;
        }
      }
    } catch {
      // Fall back to the offline list.
    }
    return this.IPTV_ORG_COUNTRIES_FALLBACK;
  }

  static iptvOrgCountryUrl(code: string): string {
    return `https://iptv-org.github.io/iptv/countries/${encodeURIComponent(code.toLowerCase())}.m3u`;
  }

  static iptvOrgCategoryUrl(category: string): string {
    return `https://iptv-org.github.io/iptv/categories/${encodeURIComponent(category.toLowerCase())}.m3u`;
  }

  static iptvOrgIndexUrl(): string {
    return 'https://iptv-org.github.io/iptv/index.m3u';
  }

  /** Normalizes a self-hosted StepDaddyLiveHD server URL into its playlist URL. */
  static stepDaddyPlaylistUrl(serverBase: string): string {
    const base = serverBase.trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/playlist\.m3u8?$/i.test(base)) return base;
    return `${base}/playlist.m3u8`;
  }

  /** Community sources are family-facing: strip obvious adult channels. */
  private static isAdultChannel(channel: M3uChannel): boolean {
    const haystack = `${channel.group || ''} ${channel.name}`.toLowerCase();
    return /(xxx|porn|adult|\b18\+\b|erotic|sex)/.test(haystack);
  }

  /**
   * Loads and parses a public playlist through the native CORS-bypass client.
   * Results are cached per URL (bounded) so re-selecting a source is instant.
   */
  static async loadPlaylist(url: string, timeoutMs = 20000): Promise<M3uChannel[]> {
    const cached = this.PLAYLIST_CACHE.get(url);
    if (cached) return cached;
    const res = await nativeFetchText(url, { timeoutMs });
    if (!res.ok && !res.data) throw new Error(`HTTP ${res.status || 'error'} while loading the playlist.`);
    const text = res.data || '';
    if (text.trimStart().startsWith('<')) {
      throw new Error('That playlist URL returned an HTML page instead of an M3U playlist.');
    }
    const channels = M3uParser.parse(text).filter((ch) => !this.isAdultChannel(ch) && Boolean(ch.url));
    if (!channels.length) throw new Error('The playlist loaded but contained no playable channels.');
    this.PLAYLIST_CACHE.set(url, channels);
    evictOldest(this.PLAYLIST_CACHE, 12);
    return channels;
  }
}

export class IptvSourceStore {
  private static readonly SOURCE_KEY = 'praha.iptv.sources';

  static loadStepDaddyUrl(): string {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { stepDaddyUrl?: string; iptvOrgCountry?: string }) : {};
      return parsed.stepDaddyUrl || '';
    } catch {
      return '';
    }
  }

  static saveStepDaddyUrl(url: string): void {
    this.patch({ stepDaddyUrl: url });
  }

  static loadIptvOrgCountry(): string {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { iptvOrgCountry?: string }) : {};
      return parsed.iptvOrgCountry || 'in';
    } catch {
      return 'in';
    }
  }

  static saveIptvOrgCountry(code: string): void {
    this.patch({ iptvOrgCountry: code });
  }

  /** Last successfully loaded public source — restored on launch so the Channels Hub survives restarts. */
  static loadLastSource(): { name: string; url: string } | null {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { lastSource?: { name?: string; url?: string } }) : {};
      const src = parsed.lastSource;
      return src && src.name && src.url ? { name: src.name, url: src.url } : null;
    } catch {
      return null;
    }
  }

  static saveLastSource(name: string, url: string): void {
    this.patch({ lastSource: { name, url } });
  }

  private static patch(data: Record<string, unknown>): void {
    try {
      const raw = localStorage.getItem(this.SOURCE_KEY);
      const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(this.SOURCE_KEY, JSON.stringify({ ...current, ...data }));
    } catch {
      // quota or storage unavailable
    }
  }
}

/**
 * IPTV zap state: the channel list of the last loaded source plus the
 * currently playing channel URL, persisted so the in-player zap bar can
 * switch channels without leaving playback.
 */
export interface IptvZapChannel {
  name: string;
  url: string;
  group?: string;
  logo?: string;
}

const ZAP_KEY = 'praha.iptv.zap.v1';
const ZAP_MAX_CHANNELS = 400;

export class IptvZapStore {
  static set(channels: IptvZapChannel[], currentUrl: string): void {
    try {
      const seen = new Set<string>();
      const list: IptvZapChannel[] = [];
      const push = (ch: IptvZapChannel) => {
        if (!ch?.url || seen.has(ch.url)) return;
        seen.add(ch.url);
        list.push(ch);
      };
      // The playing channel first, then the rest of the list.
      const current = channels.find((ch) => ch.url === currentUrl);
      if (current) push(current);
      channels.forEach(push);
      localStorage.setItem(ZAP_KEY, JSON.stringify({ channels: list.slice(0, ZAP_MAX_CHANNELS), currentUrl }));
    } catch {
      // Quota or storage unavailable — zapping is best-effort.
    }
  }

  static setCurrent(url: string): void {
    try {
      const raw = localStorage.getItem(ZAP_KEY);
      const parsed = raw ? (JSON.parse(raw) as { channels?: IptvZapChannel[]; currentUrl?: string }) : {};
      localStorage.setItem(ZAP_KEY, JSON.stringify({ channels: parsed.channels || [], currentUrl: url }));
    } catch {
      // Ignore
    }
  }

  static get(): { channels: IptvZapChannel[]; currentUrl: string } | null {
    try {
      const raw = localStorage.getItem(ZAP_KEY);
      const parsed = raw ? (JSON.parse(raw) as { channels?: IptvZapChannel[]; currentUrl?: string }) : {};
      if (!parsed.channels?.length) return null;
      return { channels: parsed.channels, currentUrl: parsed.currentUrl || '' };
    } catch {
      return null;
    }
  }

  /** Next/previous channel relative to the current one (wraps around). */
  static neighbor(direction: 1 | -1): IptvZapChannel | null {
    const zap = this.get();
    if (!zap) return null;
    const idx = zap.channels.findIndex((ch) => ch.url === zap.currentUrl);
    const nextIdx = idx < 0
      ? 0
      : (idx + direction + zap.channels.length) % zap.channels.length;
    const channel = zap.channels[nextIdx];
    if (!channel) return null;
    this.setCurrent(channel.url);
    return channel;
  }
}

/** Shared media/stream builder for IPTV playback (hub tap + zap bar). */
export function buildIptvPlayback(ch: IptvZapChannel): { media: MediaItem; stream: StreamResult } {
  const media: MediaItem = {
    id: `livetv-${Date.now()}`,
    title: ch.name,
    type: 'movie',
    source: 'iptv',
    poster: ch.logo || 'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=600&q=80',
    overview: `Live TV Stream · Broadcast via ${ch.group || 'Live TV'}`,
    genres: ['Live TV', ch.group || 'Live TV'],
  };
  const stream: StreamResult = {
    id: `livetv-stream-${Date.now()}`,
    title: ch.name,
    url: ch.url,
    sourceName: ch.group || 'Live TV',
    sourceType: 'iptv',
    quality: '1080p',
    format: ch.url.includes('.m3u8') ? 'hls' : 'direct',
  };
  return { media, stream };
}
