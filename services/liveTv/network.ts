// Xtream client, portal verifier, stream health checker and catalog scraper.
//
// Ported from VyseTV `lib/services/iptv/iptv_network.dart`
// (GPL-3.0-or-later). Every byte on the wire goes through `nativeFetchText`
// via `services/liveTv/http.ts`; no direct fetch/axios calls live here.

import type {
  EpgEntry,
  IptvCategory,
  IptvEpisode,
  IptvPortal,
  IptvSection,
  IptvStream,
  VerifiedPortal,
} from './models';
import { getJson, getText, probeUrl, fetchText } from './http';
import { decryptPasteSh } from './pasteDecryptor';
import { pasteRawUrl, portalKey } from './portal';

const UA = 'VLC/3.0.20 LibVLC/3.0.20';

function enc(value: string): string {
  return encodeURIComponent(String(value ?? ''));
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function decodeBase64(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
    return binary.trim();
  } catch {
    return text;
  }
}

function parseEpoch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (seconds > 1_000_000_000) {
      const ms = seconds * 1000;
      const date = new Date(ms);
      return Number.isFinite(date.getTime()) ? ms : null;
    }
  }
  const parsed = Date.parse(text.includes(' ') && !text.includes('T') ? text.replace(' ', 'T') : text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Xtream-Codes player_api client. Login + categories + streams + episodes + EPG. */
export class IptvClient {
  private static async httpGet(url: string, timeoutMs = 10000): Promise<string | null> {
    return getText(url, timeoutMs, { 'User-Agent': UA, Accept: 'application/json,*/*' });
  }

  static async login(portal: IptvPortal, timeoutMs = 6000): Promise<Record<string, any> | null> {
    const url = `${portal.url}/player_api.php?username=${enc(portal.username)}&password=${enc(portal.password)}`;
    const text = await IptvClient.httpGet(url, timeoutMs);
    if (!text) return null;
    try {
      const root = record(JSON.parse(text));
      if (!root) return null;
      const info = record(root.user_info) || root;
      const auth = info.auth === null || info.auth === undefined ? '' : String(info.auth);
      const status = String(info.status ?? '').toLowerCase();
      const ok = auth === '1' || status === 'active' || Object.prototype.hasOwnProperty.call(root, 'user_info');
      return ok ? info : null;
    } catch {
      return null;
    }
  }

  static formatExpiry(raw: number | string | null | undefined): string {
    if (raw === null || raw === undefined || raw === '') return 'Unlimited';
    const timestamp = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(timestamp)) return 'Unlimited';
    try {
      const date = new Date(timestamp * 1000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    } catch {
      return String(raw);
    }
  }

  static async verifyOrNull(portal: IptvPortal, timeoutMs = 6000): Promise<VerifiedPortal | null> {
    const info = await IptvClient.login(portal, timeoutMs);
    if (!info) return null;
    const name = String(info.username ?? '').trim() || portal.username;
    return {
      portal,
      name,
      expiry: IptvClient.formatExpiry(info.exp_date),
      maxConnections: String(info.max_connections ?? '1'),
      activeConnections: String(info.active_cons ?? '0'),
    };
  }

  private static action(kind: IptvSection, suffix: 'categories' | 'streams'): string {
    const prefix = kind === 'live' ? 'get_live' : kind === 'vod' ? 'get_vod' : 'get_series';
    return suffix === 'categories' ? `${prefix}_categories` : kind === 'series' ? 'get_series' : `${prefix}_streams`;
  }

  static async categories(portal: IptvPortal, kind: IptvSection): Promise<IptvCategory[]> {
    const url = `${portal.url}/player_api.php?username=${enc(portal.username)}&password=${enc(portal.password)}&action=${IptvClient.action(kind, 'categories')}`;
    const text = await IptvClient.httpGet(url, 8000);
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((row) => {
        const item = record(row) || {};
        return { id: String(item.category_id ?? ''), name: String(item.category_name ?? '') };
      });
    } catch {
      return [];
    }
  }

  static async streams(portal: IptvPortal, kind: IptvSection, categoryId = ''): Promise<IptvStream[]> {
    const base = `${portal.url}/player_api.php?username=${enc(portal.username)}&password=${enc(portal.password)}&action=${IptvClient.action(kind, 'streams')}`;
    const url = categoryId ? `${base}&category_id=${enc(categoryId)}` : base;
    const text = await IptvClient.httpGet(url, 15000);
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((row): IptvStream => {
        const item = record(row) || {};
        const ext = kind === 'live' ? 'ts' : kind === 'vod' ? String(item.container_extension ?? 'mp4') || 'mp4' : '';
        const id = kind === 'series'
          ? String(item.series_id ?? item.id ?? '')
          : String(item.stream_id ?? item.id ?? '');
        return {
          streamId: id,
          name: String(item.name ?? item.title ?? ''),
          icon: String(item.stream_icon ?? item.cover ?? ''),
          categoryId: String(item.category_id ?? ''),
          containerExt: ext,
          kind,
          epgChannelId: String(item.epg_channel_id ?? ''),
        };
      });
    } catch {
      return [];
    }
  }

  static async seriesEpisodes(portal: IptvPortal, seriesId: string): Promise<IptvEpisode[]> {
    const url = `${portal.url}/player_api.php?username=${enc(portal.username)}&password=${enc(portal.password)}&action=get_series_info&series_id=${enc(seriesId)}`;
    const root = await getJson<Record<string, any>>(url, 15000, { 'User-Agent': UA });
    const episodes = record(root?.episodes);
    if (!episodes) return [];
    const out: IptvEpisode[] = [];
    for (const [seasonKey, value] of Object.entries(episodes)) {
      if (!Array.isArray(value)) continue;
      const season = Number(seasonKey) || 0;
      for (const row of value) {
        const item = record(row);
        if (!item) continue;
        const info = record(item.info) || {};
        out.push({
          id: String(item.id ?? ''),
          title: String(item.title ?? ''),
          containerExt: String(item.container_extension ?? 'mp4') || 'mp4',
          season,
          episode: Number(item.episode_num) || 0,
          plot: String(info.plot ?? ''),
          image: String(info.movie_image ?? ''),
        });
      }
    }
    return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  static streamUrl(portal: IptvPortal, stream: IptvStream | { streamId: string; containerExt?: string; kind?: IptvSection }): string {
    const user = enc(portal.username);
    const pass = enc(portal.password);
    const id = enc(stream.streamId);
    if (stream.kind === 'vod') return `${portal.url}/movie/${user}/${pass}/${id}.${stream.containerExt || 'mp4'}`;
    if (stream.kind === 'series') return '';
    return `${portal.url}/live/${user}/${pass}/${id}.${stream.containerExt || 'ts'}`;
  }

  static episodeUrl(portal: IptvPortal, episode: IptvEpisode): string {
    return `${portal.url}/series/${enc(portal.username)}/${enc(portal.password)}/${enc(episode.id)}.${episode.containerExt || 'mp4'}`;
  }

  /** Next `limit` EPG entries for a live stream (Xtream `get_short_epg`). */
  static async shortEpg(portal: IptvPortal, streamId: string, limit = 2, timeoutMs = 6000): Promise<EpgEntry[]> {
    if (!streamId) return [];
    const url = `${portal.url}/player_api.php?username=${enc(portal.username)}&password=${enc(portal.password)}&action=get_short_epg&stream_id=${enc(streamId)}&limit=${limit}`;
    const text = await IptvClient.httpGet(url, timeoutMs);
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      const root = record(parsed);
      const rows: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(root?.epg_listings)
          ? root.epg_listings
          : [];
      const out: EpgEntry[] = [];
      for (const row of rows) {
        const item = record(row);
        if (!item) continue;
        const start = parseEpoch(item.start_timestamp ?? item.start);
        const stop = parseEpoch(item.stop_timestamp ?? item.end);
        if (start === null || stop === null) continue;
        out.push({ title: decodeBase64(item.title), description: decodeBase64(item.description), start, stop });
      }
      return out.sort((a, b) => Number(a.start) - Number(b.start));
    } catch {
      return [];
    }
  }
}

// ── Verifier — bounded concurrency, abort once `target` portals authenticated ──

export interface VerifyProgress {
  checked: number;
  total: number;
  alive: number;
}

export class IptvVerifier {
  static async verifyUntil(options: {
    portals: readonly IptvPortal[];
    target?: number;
    onProgress?: (progress: VerifyProgress) => void;
    onAlive?: (verified: VerifiedPortal) => void | Promise<void>;
    onAttempted?: (portal: IptvPortal) => void;
    isCancelled?: () => boolean;
  }): Promise<VerifiedPortal[]> {
    const { portals, target = 5, onProgress, onAlive, onAttempted, isCancelled } = options;
    if (!portals.length) return [];
    let nextIndex = 0;
    let checked = 0;
    const alive: VerifiedPortal[] = [];
    let stopped = false;
    const stop = () => { stopped = true; };

    const worker = async (): Promise<void> => {
      while (!stopped) {
        if (isCancelled?.()) { stop(); break; }
        if (alive.length >= target) { stop(); break; }
        const index = nextIndex++;
        if (index >= portals.length) break;
        const portal = portals[index];
        onAttempted?.(portal);
        let verified: VerifiedPortal | null = null;
        try {
          verified = await IptvClient.verifyOrNull(portal);
        } catch {
          verified = null;
        }
        if (stopped) break;
        checked++;
        if (verified && alive.length < target) {
          alive.push(verified);
          await onAlive?.(verified);
        }
        onProgress?.({ checked, total: portals.length, alive: alive.length });
        if (alive.length >= target) { stop(); break; }
      }
    };

    const workers = Array.from({ length: Math.min(4, portals.length) }, () => worker());
    await Promise.all(workers);
    return alive;
  }
}

// ── Alive checker — partial-content stream sniffing ─────────────────────────

export interface AliveProgress {
  checked: number;
  total: number;
  alive: number;
}

export class IptvAliveChecker {
  private static readonly MIN_BYTES = 16 * 1024;
  private static readonly MAX_BYTES = 64 * 1024;
  private static readonly TIMEOUT = 8000;
  private static readonly CONCURRENCY = 24;
  private static readonly DEAD_TYPES = ['text/html', 'application/json', 'text/xml', 'text/plain'];

  static async launchCheck(options: {
    streams: readonly (readonly [string, string])[];
    onResult?: (id: string, alive: boolean) => void | Promise<void>;
    onProgress?: (progress: AliveProgress) => void | Promise<void>;
    onDone?: () => void | Promise<void>;
    isCancelled?: () => boolean;
  }): Promise<void> {
    const { streams, onResult, onProgress, onDone, isCancelled } = options;
    let checked = 0;
    let alive = 0;
    const pending = [...streams];
    const total = pending.length;

    const worker = async (): Promise<void> => {
      while (pending.length) {
        if (isCancelled?.()) return;
        const job = pending.shift()!;
        const ok = await IptvAliveChecker.isAlive(job[1]);
        if (isCancelled?.()) return;
        checked++;
        if (ok) alive++;
        await onResult?.(job[0], ok);
        await onProgress?.({ checked, total, alive });
      }
    };
    await Promise.all(Array.from({ length: Math.min(IptvAliveChecker.CONCURRENCY, Math.max(1, total)) }, () => worker()));
    if (!isCancelled?.()) await onDone?.();
  }

  /** Probe a stream with a bounded range request and up to two retries. */
  private static async isAlive(url: string, attempt = 0): Promise<boolean> {
    try {
      const res = await fetchText(url, {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Connection: 'keep-alive',
          Range: `bytes=0-${IptvAliveChecker.MAX_BYTES - 1}`,
        },
        timeoutMs: IptvAliveChecker.TIMEOUT,
      });
      if (!(res.ok && res.status >= 200 && res.status < 400)) return false;
      const contentType = String(res.headers?.['content-type'] ?? '').toLowerCase();
      if (IptvAliveChecker.DEAD_TYPES.some((bad) => contentType.includes(bad))) return false;
      const head = res.data.slice(0, 4096);
      if (head.includes('#EXTM3U') || /\b(ftyp|moov|mdat)\b/.test(head)) return true;
      if (/\.m3u8/i.test(url) && !head.includes('#EXTM3U')) return false;
      // nativeFetchText only exposes text: a non-empty text body with no error
      // page is the closest available signal that the stream started answering.
      if (head.length >= 32) return true;
      return (await probeUrl(url, IptvAliveChecker.TIMEOUT)).ok;
    } catch {
      if (attempt < 2) return IptvAliveChecker.isAlive(url, attempt + 1);
      return false;
    }
  }
}

// ── Catalog Xtream-Codes scraper ─────────────────────────────────────────────

export interface CatalogSourceDef {
  id: 'cloudVault' | 'reddit';
  label: string;
  description: string;
}

export const CatalogSource: Record<'cloudVault' | 'reddit', CatalogSourceDef> = {
  cloudVault: {
    id: 'cloudVault',
    label: 'Cloud Vault',
    description: 'High-speed cloud database with 9,000+ live IPTV servers',
  },
  reddit: {
    id: 'reddit',
    label: 'Reddit',
    description: 'Live scrapers from Reddit IPTV subreddits',
  },
};

export interface ScrapePage {
  portals: IptvPortal[];
  nextAfter: string | null;
  hasMore: boolean;
}

const SMALL_CAPS: Record<number, string> = {
  0x1D00: 'A', 0x0299: 'B', 0x1D04: 'C', 0x1D05: 'D', 0x1D07: 'E',
  0x0262: 'G', 0x029C: 'H', 0x026A: 'I', 0x1D0A: 'J', 0x1D0B: 'K',
  0x029F: 'L', 0x1D0D: 'M', 0x0274: 'N', 0x1D0F: 'O', 0x1D18: 'P',
  0x0280: 'R', 0x1D1B: 'T', 0x1D1C: 'U', 0x1D20: 'V', 0x1D21: 'W',
  0x028F: 'Y', 0x1D22: 'Z',
};

function normalizeUnicode(input: string): string {
  let out = '';
  for (const char of Array.from(input)) {
    const code = char.codePointAt(0)!;
    const upper =
      (code >= 0x1D400 && code <= 0x1D419) ||
      (code >= 0x1D434 && code <= 0x1D44D) ||
      (code >= 0x1D468 && code <= 0x1D481) ||
      (code >= 0x1D5A0 && code <= 0x1D5B9) ||
      (code >= 0x1D5D4 && code <= 0x1D5ED) ||
      (code >= 0x1D608 && code <= 0x1D621) ||
      (code >= 0x1D670 && code <= 0x1D689);
    const lower =
      (code >= 0x1D41A && code <= 0x1D433) ||
      (code >= 0x1D44E && code <= 0x1D467) ||
      (code >= 0x1D482 && code <= 0x1D49B) ||
      (code >= 0x1D5BA && code <= 0x1D5D3) ||
      (code >= 0x1D5EE && code <= 0x1D607) ||
      (code >= 0x1D622 && code <= 0x1D63B) ||
      (code >= 0x1D68A && code <= 0x1D6A3);
    const digit =
      (code >= 0x1D7CE && code <= 0x1D7D7) ||
      (code >= 0x1D7E2 && code <= 0x1D7EB) ||
      (code >= 0x1D7EC && code <= 0x1D7F5) ||
      (code >= 0x1D7F6 && code <= 0x1D7FF);
    if (upper) out += String.fromCharCode(0x41 + ((code - 0x1D400) % 26));
    else if (lower) out += String.fromCharCode(0x61 + ((code - 0x1D41A) % 26));
    else if (digit) out += String.fromCharCode(0x30 + ((code - 0x1D7CE) % 10));
    else if (SMALL_CAPS[code]) out += SMALL_CAPS[code];
    else if (code >= 0xFF01 && code <= 0xFF5E) out += String.fromCharCode(code - 0xFEE0);
    else out += char;
  }
  return out;
}

function cleanPortalUrl(raw: string): string {
  let clean = String(raw || '').replace(/\s+/g, '');
  const query = clean.indexOf('?');
  if (query >= 0) clean = clean.slice(0, query);
  if (clean.includes('@')) clean = `http://${clean.slice(clean.lastIndexOf('@') + 1)}`;
  clean = clean.replace(/\/(?:get|live|movie|series|portal|c|index|playlist|player_api|xmltv|index\.php|portal\.php)\.php$/i, '');
  clean = clean.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
  return clean;
}

function cleanCred(raw: string): string {
  let text = String(raw || '').trim();
  while (/^[=:➤•]/.test(text)) text = text.slice(1).trim();
  let result = text.split(/[\s\n&?|<>]/)[0]?.trim() || '';
  result = result.replace(/[,;]+$/, '');
  return result;
}

const JUNK_TOKENS = ['type=m3u', 'output=ts', 'password=', 'username=', 'password', 'username'];
const PASTE_DOMAINS = ['paste.sh', 'paste.ee', 'pastee.dev', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co'];

function isJunkCode(text: string): boolean {
  const markers = ['Array.isArray', 'prototype.', 'function(', 'var ', 'const ', 'let ', 'return!', 'void ', '.message}', 'window.', 'document.'];
  let hits = 0;
  for (const marker of markers) {
    if (text.includes(marker)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#32;/g, ' ');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { out.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  out.push(cell.trim());
  return out;
}

const URL_USER_FIRST = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user|usr|login|account)=([^&\s"'<]+)\s*&(?:[^\s"'<]*?&)?(?:password|pass|pwd)=([^&\s"'<]+)/gi;
const URL_PASS_FIRST = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:password|pass|pwd)=([^&\s"'<]+)\s*&(?:[^\s"'<]*?&)?(?:username|user|usr|login|account)=([^&\s"'<]+)/gi;
const LABELED = /(?:Portal(?:-URL)?|Host(?:\s*URL)?|Panel|Server|Real-URL|URL|M3U(?:-Link)?|Link|Servidor|H[ôo]te|Сервер|🌐|🌍|🔗|📡)\s*[:=➤\-•*|]?\s*(https?:\/\/[^\s<"'\n]+)[\s\S]{1,600}?(?:Username|User|Usr|Usu[áa]rio|Usuario|Utilisateur|Login|Account|Compte|Логин|👤|🗣️)\s*[:=➤\-•*|]?\s*([^\s|<"'\n]+)[\s\S]{1,300}?(?:Password|Pass|Pwd|Senha|Contrase[ñn]a|Clave|Mot\s*de\s*passe|Пароль|🔑|🔒|🔐)\s*[:=➤\-•*|]?\s*([^\s|<"'\n]+)(?:[\s\S]{1,200}?(?:Port|Porta|Puerto|Порт)\s*[:=➤\-•*|]?\s*(\d+))?/gi;
const STREAM_URI = /(https?:\/\/[^\s/]+(?::\d+)?)\/(?:live|movie|series)\/([^/\s]+)\/([^/\s]+)\/\d+/gi;
const LINE_COMBO = /(?:^|\n)\s*(https?:\/\/[a-zA-Z0-9.\-_]+(?::\d+)?(?:\/[^\s:|,\t\n]*)?)\s*[:|,\t ]\s*([a-zA-Z0-9_\-.@]+)\s*[:|,\t ]\s*([a-zA-Z0-9_\-.@!#$%^&*+=]+)/gm;
const B64_LINK = /aHR0c[a-zA-Z0-9+/=]{10,}/g;
const RAW_PASTE = /https?:\/\/(?:paste\.sh|pastebin\.com|justpaste\.it|controlc\.com|pastes\.dev|text\.is|rentry\.co)\/[a-zA-Z0-9#_=-]+/gi;

export class IptvScraper {
  private static readonly CLOUD_PRIMARY = 'https://pub-38f23eb5f3304328b9774fadfa233a38.r2.dev/xtreamity-plus-db.csv.gz';
  private static readonly CLOUD_BACKUP = 'https://s3.us-west-004.backblazeb2.com/Xtream-STBemu/xtreamity-plus-db.csv.gz';
  private static readonly SUBS = ['IPTV_ZONENEW', 'FreeIPTV', 'iptvguru', 'IPTVfree'];
  private static readonly OAUTH_UA = 'PlayTorrio/1.3.6 (by /u/PlayTorrioApp)';
  private static readonly CLIENT_IDS = ['ohXpoqrZYub1kg', 'NOe2iKrPPzwscA', 'JrPdG8Z6dkWNxA'];
  private static readonly SCRAPE_UA = 'Mozilla/5.0 (Linux; Android 11; PlayTorrio) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
  private static cachedCloudPortals: IptvPortal[] | null = null;
  private static loadingCloudPortals = false;
  private static oauthToken: string | null = null;
  private static oauthExpiry = 0;
  private static oauthClientIndex = 0;

  /** Public wrapper around the Dart scraper's `_extractPortals`. */
  static extractPortals(rawText: string, source = 'Manual'): IptvPortal[] {
    const acc = new Map<string, IptvPortal>();
    IptvScraper.addExtracted(acc, rawText, source);
    return [...acc.values()];
  }

  private static addExtracted(acc: Map<string, IptvPortal>, rawText: string, source: string): void {
    if (!rawText || rawText.length < 10 || isJunkCode(rawText)) return;
    const normalized = normalizeUnicode(
      rawText
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    );
    const collect = (regex: RegExp, urlGroup: number, userGroup: number, passGroup: number, portGroup?: number) => {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(normalized)) !== null) {
        IptvScraper.finalize(acc, match[urlGroup], match[userGroup], match[passGroup], source, portGroup ? match[portGroup] : undefined);
      }
    };
    collect(URL_USER_FIRST, 1, 2, 3);
    collect(URL_PASS_FIRST, 1, 3, 2);
    collect(LABELED, 1, 2, 3, 4);
    collect(STREAM_URI, 1, 2, 3);
    collect(LINE_COMBO, 1, 2, 3);
  }

  private static finalize(
    acc: Map<string, IptvPortal>,
    rawUrl: string,
    rawUser: string,
    rawPass: string,
    source: string,
    rawPort?: string,
  ): void {
    let url = cleanPortalUrl(rawUrl);
    const username = cleanCred(rawUser);
    const password = cleanCred(rawPass);
    if (rawPort && !/:\d+$/.test(url)) {
      const port = Number(rawPort.trim());
      if (Number.isInteger(port) && port > 0 && port <= 65535) url = `${url}:${port}`;
    }
    if (url.length < 10 || username.length < 3 || password.length < 3) return;
    if (/http/i.test(username) || /http/i.test(password)) return;
    const lowerUser = username.toLowerCase();
    const lowerPass = password.toLowerCase();
    if (/\.(php|ts|m3u|m3u8|mp4)$/.test(lowerPass)) return;
    if (/\.php$/.test(lowerUser) || lowerUser === 'play') return;
    if (JUNK_TOKENS.some((token) => lowerUser === token || lowerPass === token || lowerUser.includes(token) || lowerPass.includes(token))) return;
    const portal: IptvPortal = { url, username, password, source };
    const key = portalKey(portal);
    if (!acc.has(key)) acc.set(key, portal);
  }

  private static async loadCloudVault(): Promise<IptvPortal[]> {
    if (IptvScraper.cachedCloudPortals?.length) return IptvScraper.cachedCloudPortals;
    if (IptvScraper.loadingCloudPortals) {
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (IptvScraper.cachedCloudPortals?.length) return IptvScraper.cachedCloudPortals;
      }
    }
    IptvScraper.loadingCloudPortals = true;
    try {
      let bytes: Uint8Array | null = null;
      for (const url of [IptvScraper.CLOUD_PRIMARY, IptvScraper.CLOUD_BACKUP]) {
        try {
          const res = await fetchText(url, { headers: { 'User-Agent': IptvScraper.SCRAPE_UA }, timeoutMs: 15000 });
          if (res.ok && res.data) { bytes = new TextEncoder().encode(res.data); break; }
        } catch { /* try backup */ }
      }
      if (!bytes) return [];
      let text: string;
      if ((globalThis as any).DecompressionStream && typeof Response !== 'undefined') {
        const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new (globalThis as any).DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      const out: IptvPortal[] = [];
      const seen = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = parseCsvLine(line);
        if (parts.length < 3) continue;
        const [host, user, pass] = parts.map((part) => part.trim());
        if (!/^https?:\/\//i.test(host) || !user || !pass) continue;
        const key = `${user}|${pass}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: host.replace(/\/+$/, ''), username: user, password: pass, source: 'Cloud Vault' });
      }
      // Deterministic shuffle: keeps pagination stable between calls.
      out.sort((a, b) => (a.url + a.username).localeCompare(b.url + b.username));
      IptvScraper.cachedCloudPortals = out;
      return out;
    } catch {
      return [];
    } finally {
      IptvScraper.loadingCloudPortals = false;
    }
  }

  static async scrapeCatalogPage(options: {
    maxResults?: number;
    after?: string | null;
    source?: CatalogSourceDef;
  } = {}): Promise<ScrapePage> {
    const { maxResults = 50, after = null, source = CatalogSource.cloudVault } = options;
    if (source.id === 'cloudVault') {
      const all = await IptvScraper.loadCloudVault();
      const offset = after && after.startsWith('cloud:') ? Number(after.slice(6)) || 0 : 0;
      if (offset >= all.length || !all.length) return { portals: [], nextAfter: null, hasMore: false };
      const portals = all.slice(offset, offset + maxResults);
      const nextOffset = offset + portals.length;
      const nextAfter = nextOffset < all.length ? `cloud:${nextOffset}` : null;
      return { portals, nextAfter, hasMore: nextAfter !== null };
    }
    return IptvScraper.scrapeReddit(maxResults, after);
  }

  private static async scrapeReddit(maxResults: number, after: string | null): Promise<ScrapePage> {
    const out = new Map<string, IptvPortal>();
    let subIndex = 0;
    let redditAfter: string | null = null;
    if (after && after.startsWith('reddit:')) {
      const parts = after.slice(7).split(':');
      if (parts.length >= 2) {
        subIndex = Number(parts[0]) || 0;
        redditAfter = parts.slice(1).join(':') || null;
      }
    } else if (after) {
      redditAfter = after;
    }
    if (subIndex >= IptvScraper.SUBS.length) subIndex = 0;
    const sub = IptvScraper.SUBS[subIndex];

    const json = await IptvScraper.fetchCatalogOAuth(sub, redditAfter);
    if (json) {
      try {
        const data = record(record(JSON.parse(json))?.data);
        const posts: unknown[] = Array.isArray(data?.children) ? data.children : [];
        const nextRaw = String(data?.after ?? '');
        const nextAfter = nextRaw && nextRaw !== 'null'
          ? `reddit:${subIndex}:${nextRaw}`
          : subIndex + 1 < IptvScraper.SUBS.length ? `reddit:${subIndex + 1}:` : null;
        IptvScraper.processPosts(posts, out, maxResults);
        await IptvScraper.processDeepLinks(posts, out, maxResults);
        return { portals: [...out.values()], nextAfter, hasMore: nextAfter !== null };
      } catch { /* fall through to RSS */ }
    }

    const rss = await IptvScraper.fetchCatalogRss(sub, redditAfter);
    if (!rss) {
      const nextAfter = subIndex + 1 < IptvScraper.SUBS.length ? `reddit:${subIndex + 1}:` : null;
      return { portals: [], nextAfter, hasMore: nextAfter !== null };
    }
    const entries = [...rss.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    const ids = [...rss.matchAll(/<id>(t3_[^<]+)<\/id>/g)].map((match) => match[1]);
    const lastId = ids[ids.length - 1] || null;
    const nextAfter = lastId && entries.length >= 20
      ? `reddit:${subIndex}:${lastId}`
      : subIndex + 1 < IptvScraper.SUBS.length ? `reddit:${subIndex + 1}:` : null;
    entries.forEach((entry, index) => {
      if (out.size >= maxResults) return;
      const title = decodeXmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(entry[1])?.[1] || '');
      const content = decodeXmlEntities(/<content[^>]*>([\s\S]*?)<\/content>/i.exec(entry[1])?.[1] || '');
      const body = `${title} ${content.replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`.trim();
      IptvScraper.processPostBody(body, maxResults, out);
      void index;
    });
    return { portals: [...out.values()], nextAfter, hasMore: nextAfter !== null };
  }

  private static addPortal(out: Map<string, IptvPortal>, portal: IptvPortal, max: number): void {
    if (out.size >= max) return;
    const key = portalKey(portal);
    if (!out.has(key)) out.set(key, portal);
  }

  private static processPosts(posts: readonly unknown[], out: Map<string, IptvPortal>, max: number): void {
    for (const post of posts) {
      const data = record(record(post)?.data);
      if (!data) continue;
      const body = `${String(data.title ?? '')} ${String(data.selftext ?? '')}`.trim();
      IptvScraper.processPostBody(body, max, out);
    }
  }

  private static processPostBody(body: string, max: number, out: Map<string, IptvPortal>): void {
    for (const portal of IptvScraper.extractPortals(body, 'Catalog')) IptvScraper.addPortal(out, portal, max);
  }

  private static async processDeepLinks(posts: readonly unknown[], out: Map<string, IptvPortal>, max: number): Promise<void> {
    for (const post of posts) {
      if (out.size >= max) break;
      const data = record(record(post)?.data);
      if (!data) continue;
      const body = `${String(data.title ?? '')} ${String(data.selftext ?? '')}`.trim();
      const links = new Set<string>();
      B64_LINK.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = B64_LINK.exec(body)) !== null) {
        try {
          const decoded = new TextDecoder().decode(Uint8Array.from(atob(match[0]), (char) => char.charCodeAt(0)));
          if (/^https?:/i.test(decoded) && PASTE_DOMAINS.some((domain) => decoded.includes(domain))) links.add(decoded);
          else if (!/^https?:/i.test(decoded) && decoded.includes(':')) {
            for (const portal of IptvScraper.extractPortals(decoded, 'Catalog (decoded)')) IptvScraper.addPortal(out, portal, max);
          }
        } catch { /* skip bad base64 */ }
      }
      RAW_PASTE.lastIndex = 0;
      while ((match = RAW_PASTE.exec(body)) !== null) links.add(match[0]);
      for (const link of [...links].slice(0, 4)) {
        if (out.size >= max) break;
        const text = await IptvScraper.fetchPaste(link);
        if (!text) continue;
        for (const portal of IptvScraper.extractPortals(text, 'Catalog (deep)')) IptvScraper.addPortal(out, portal, max);
      }
    }
  }

  private static async fetchPaste(url: string): Promise<string | null> {
    if (url.includes('paste.sh/') && url.includes('#')) return (await decryptPasteSh(url)) || null;
    const raw = pasteRawUrl(url);
    if (raw) return getText(raw, 15000);
    return getText(url, 15000);
  }

  private static async getOAuthToken(): Promise<string | null> {
    if (IptvScraper.oauthToken && Date.now() < IptvScraper.oauthExpiry) return IptvScraper.oauthToken;
    for (let offset = 0; offset < IptvScraper.CLIENT_IDS.length; offset++) {
      const index = (IptvScraper.oauthClientIndex + offset) % IptvScraper.CLIENT_IDS.length;
      const token = btoa(`${IptvScraper.CLIENT_IDS[index]}:`);
      try {
        const body = new URLSearchParams({
          grant_type: 'https://oauth.reddit.com/grants/installed_client',
          device_id: 'DO_NOT_TRACK_THIS_DEVICE',
        }).toString();
        const res = await fetchText('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          headers: {
            'User-Agent': IptvScraper.OAUTH_UA,
            Authorization: `Basic ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          timeoutMs: 8000,
        });
        if (res.ok) {
          const data = record(JSON.parse(res.data));
          const access = String(data?.access_token ?? '');
          if (access) {
            IptvScraper.oauthToken = access;
            IptvScraper.oauthExpiry = Date.now() + (Number(data?.expires_in) || 3600) * 1000 - 60000;
            IptvScraper.oauthClientIndex = index;
            return access;
          }
        }
      } catch { /* next client id */ }
    }
    IptvScraper.oauthClientIndex = (IptvScraper.oauthClientIndex + 1) % IptvScraper.CLIENT_IDS.length;
    IptvScraper.oauthToken = null;
    IptvScraper.oauthExpiry = 0;
    return null;
  }

  private static async fetchCatalogOAuth(sub: string, after: string | null): Promise<string | null> {
    const token = await IptvScraper.getOAuthToken();
    if (!token) return null;
    const base = `https://oauth.reddit.com/r/${sub}/new?limit=100&sort=new&raw_json=1`;
    const url = after ? `${base}&after=${encodeURIComponent(after)}` : base;
    try {
      const res = await fetchText(url, { headers: { 'User-Agent': IptvScraper.OAUTH_UA, Authorization: `Bearer ${token}` }, timeoutMs: 12000 });
      if (res.ok && /^[\[{]/.test(res.data.trim())) return res.data;
      if (res.status === 401 || res.status === 403) {
        IptvScraper.oauthToken = null;
        IptvScraper.oauthExpiry = 0;
      }
    } catch { /* none */ }
    return null;
  }

  private static async fetchCatalogRss(sub: string, after: string | null): Promise<string | null> {
    const base = `https://www.reddit.com/r/${sub}/new/.rss?limit=25`;
    const url = after ? `${base}&after=${encodeURIComponent(after)}` : base;
    try {
      const res = await fetchText(url, {
        headers: { 'User-Agent': IptvScraper.OAUTH_UA, Accept: 'application/atom+xml, application/xml, */*' },
        timeoutMs: 15000,
      });
      return res.ok && res.data.includes('<entry>') ? res.data : null;
    } catch {
      return null;
    }
  }
}
