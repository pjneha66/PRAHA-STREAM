import CryptoJS from 'crypto-js';
import { nativeFetchText } from './androidBridge';
import { getTmdbApiKey } from './tmdbConfig';

/**
 * Film and TV scrapers ported from VyseTV's Flutter build (which in turn ported
 * the Vyla SDK's `src/sources/*.js`). Each one found a real stream, played it
 * through the relay and survived a seek before it was kept, so the request
 * logic, headers, decoding and extraction are carried over verbatim: the
 * ordering of requests and the shape of the answers matter more than style.
 *
 * Every request goes through `nativeFetchText`, never bare `fetch`: inside the
 * Android WebView plain `fetch` is CORS-blocked and the native path is the only
 * one that carries arbitrary headers (Referer, Origin, X-Stream-Ticket…).
 */

/** What to look up: a film, or one episode of a show, by TMDB id. */
export interface FilmQuery {
  /** TMDB id, as a string. */
  id: string;
  title: string;
  year?: string;
  imdbId?: string;
  /** Present for an episode; absent for a film. */
  season?: number;
  episode?: number;
}

/** One stream a scraper found. */
export interface FoundStream {
  url: string;
  /** Human label shown in the source list, e.g. "VidLink HLS". */
  server: string;
  quality: string;
  /** 'hls' | 'dash' | 'mp4' … */
  type: string;
  headers?: Record<string, string>;
}

/** One source in the Settings list, and how to ask it for a stream. */
export interface FilmSource {
  id: string;
  name: string;
  note: string;
  scraper: (q: FilmQuery) => Promise<FoundStream[]>;
  /** Only asked for films: it has nothing for episodes, or failed the checks with them. */
  filmsOnly?: boolean;
  /** Only asked for episodes, the same way round. */
  showsOnly?: boolean;
  /** Anime only: it has nothing for titles TMDB doesn't list as Japanese animation. */
  animeOnly?: boolean;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

/** A browser User-Agent, picked at random per call like the Dart build's `getUA()`. */
function getUA(): string {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)] ?? UA_LIST[0];
}

/** The one User-Agent most of these sites were checked against. */
const sdkUA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 15000;

/** A response with its body already read, mirroring Dart's `http.Response`. */
interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Thrown by {@link fetchText} for a non-2xx answer. */
class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** `fetch()`: any status, any method. Transport failures reject. */
async function fetchRaw(url: string, options: FetchOptions = {}): Promise<RawResponse> {
  const res = await nativeFetchText(url, {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return { status: res.status, body: res.data, headers: res.headers ?? {} };
}

/** `helpers.js fetchText`: throws on a non-2xx status. */
async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const res = await fetchRaw(url, options);
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url);
  return res.body;
}

/** `helpers.js fetchJson`: throws on a non-2xx status or unparseable body. */
async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  return JSON.parse(await fetchText(url, options)) as unknown;
}

/** Case-insensitive header lookup, for the few places that read `set-cookie`. */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A field of decoded JSON, or null when the shape isn't what was expected (JS's `a?.b?.c`). */
function dig(value: unknown, path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current) || key < 0 || key >= current.length) return null;
      current = current[key];
    } else {
      if (!isRecord(current)) return null;
      current = current[key];
    }
  }
  return current ?? null;
}

/** JS truthiness for decoded JSON values, as Dart's `truthy` saw it. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

/** `a || b || c` over JSON values. */
function firstTruthy(values: unknown[]): unknown {
  for (const value of values) {
    if (truthy(value)) return value;
  }
  return null;
}

/** The source's word for a link's language, tidied. Null when it says nothing useful. */
function audioOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === '' || lower === 'null' || lower === 'unknown' || lower === 'default') return null;
  if (lower === 'auto' || lower === 'shared' || lower === 'multi') return null;
  return text;
}

/**
 * Folds a scraper's own word for the container into the three the player knows,
 * exactly as Dart's `FoundStream.type` getter did: 'm3u8' and 'hls' are HLS,
 * 'mpd' and 'dash' are DASH, anything else non-empty is a plain file, and an
 * empty value is read off the URL.
 */
function foldType(type: string | undefined, url: string): string {
  const lower = (type ?? '').toLowerCase();
  if (lower === 'hls' || lower === 'm3u8') return 'hls';
  if (lower === 'dash' || lower === 'mpd') return 'dash';
  if (lower !== '') return 'mp4';
  if (url.includes('.m3u8')) return 'hls';
  if (url.includes('.mpd')) return 'dash';
  return 'mp4';
}

interface StreamInit {
  url: string;
  server?: string;
  quality?: string;
  type?: string;
  headers?: Record<string, string>;
  audio?: string | null;
}

/** Builds a {@link FoundStream} with the Dart defaults applied. */
function mkStream(init: StreamInit): FoundStream {
  return {
    url: init.url,
    server: init.server ?? 'Server',
    quality: init.quality ?? 'Auto',
    type: foldType(init.type, init.url),
    headers: init.headers ?? {},
  };
}

function b64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8B64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function waFromBytes(bytes: Uint8Array): CryptoJS.lib.WordArray {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return CryptoJS.lib.WordArray.create(copy.buffer as ArrayBuffer);
}

function waToBytes(wordArray: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wordArray.sigBytes);
  for (let i = 0; i < wordArray.sigBytes; i += 1) {
    out[i] = (wordArray.words[i >>> 2] ?? 0) >>> (24 - (i % 4) * 8) & 0xff;
  }
  return out;
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  return waToBytes(CryptoJS.SHA256(waFromBytes(data)));
}

function sha256Hex(text: string): string {
  return CryptoJS.SHA256(text).toString(CryptoJS.enc.Hex);
}

/** AES-CBC with PKCS7 padding, as pointycastle's `PaddedBlockCipher` did it. */
function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const params = CryptoJS.lib.CipherParams.create({ ciphertext: waFromBytes(data) });
  const plain = CryptoJS.AES.decrypt(params, waFromBytes(key), {
    iv: waFromBytes(iv),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return waToBytes(plain);
}

/**
 * AES-256-GCM, ciphertext followed by the 16-byte tag and a 12-byte IV in
 * front — pointycastle's `AEADParameters(KeyParameter(key), 128, iv, [])` is
 * the same layout WebCrypto takes, so this stays a faithful decrypt.
 */
async function aesGcmDecrypt(key: Uint8Array, payload: Uint8Array): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const iv = payload.subarray(0, 12);
    const data = payload.subarray(12);
    const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** JS `Math.imul` semantics for a 32-bit signed product (Dart's `_csImul`). */
function imul(a: number, b: number): number {
  return Math.imul(a, b) | 0;
}

const i32 = (x: number): number => x | 0;
const u32 = (x: number): number => x >>> 0;
const shl = (a: number, b: number): number => (a << (b & 31)) | 0;
const ushr = (a: number, b: number): number => (a >>> (b & 31)) >>> 0;

/** `Number.prototype.toString(16)` of an int32, then `padStart(8, '0')` (a negative keeps its '-'). */
function hex8(value: number): string {
  const raw = value < 0 ? `-${(-value).toString(16)}` : value.toString(16);
  return raw.padStart(8, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasEpisode(q: FilmQuery): boolean {
  return q.season !== null && q.season !== undefined && q.episode !== null && q.episode !== undefined;
}

function seasonOf(q: FilmQuery): number {
  return q.season ?? 1;
}

function episodeOf(q: FilmQuery): number {
  return q.episode ?? 1;
}

/** The TMDB id as a number when it is numeric, so JSON bodies keep their type. */
function tmdbIdOf(q: FilmQuery): number | string {
  return /^\d+$/.test(q.id) ? Number(q.id) : q.id;
}

// ── TMDB metadata (helpers.js getTmdbMetadata / resolveImdbId) ────────────────

interface TmdbMeta {
  title: string;
  originalTitle: string;
  titles: string[];
  year: number | null;
  releaseDate: string;
  imdbId: string | null;
  isAnime: boolean;
  runtime: number;
}

const EMPTY_META: TmdbMeta = {
  title: '',
  originalTitle: '',
  titles: [],
  year: null,
  releaseDate: '',
  imdbId: null,
  isAnime: false,
  runtime: 0,
};

const metaCache = new Map<string, Promise<TmdbMeta>>();

/** The SDK's metadata lookup, cached per id+kind; an empty result on any failure. */
function getTmdbMetadata(id: string, isTv: boolean): Promise<TmdbMeta> {
  const key = `${id}-${isTv}`;
  const cached = metaCache.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<TmdbMeta> => {
    const type = isTv ? 'tv' : 'movie';
    try {
      const res = await fetchRaw(
        `https://api.themoviedb.org/3/${type}/${id}?api_key=${getTmdbApiKey()}&append_to_response=external_ids,alternative_titles`,
        { timeoutMs: 6000 },
      );
      if (res.status !== 200) return EMPTY_META;
      const data: unknown = JSON.parse(res.body);
      const title = asString(firstTruthy([dig(data, ['name']), dig(data, ['title'])])) ?? '';
      const originalTitle = asString(firstTruthy([dig(data, ['original_name']), dig(data, ['original_title'])])) ?? '';
      const releaseDate = asString(firstTruthy([dig(data, ['first_air_date']), dig(data, ['release_date'])])) ?? '';
      const year = releaseDate.length >= 4 ? numOrNull(releaseDate.slice(0, 4)) : null;
      const imdbId = asString(firstTruthy([dig(data, ['imdb_id']), dig(data, ['external_ids', 'imdb_id'])]));
      const runtime = isTv
        ? (numOrNull(dig(data, ['episode_run_time', 0])) ?? 24)
        : (numOrNull(dig(data, ['runtime'])) ?? 90);

      const titles: string[] = [];
      if (title !== '') titles.push(title);
      if (originalTitle !== '' && !titles.includes(originalTitle)) titles.push(originalTitle);
      const alternatives = asList(
        firstTruthy([dig(data, ['alternative_titles', 'titles']), dig(data, ['alternative_titles', 'results'])]),
      );
      for (const alternative of alternatives) {
        const alt = firstTruthy([dig(alternative, ['title']), dig(alternative, ['name'])]);
        if (typeof alt === 'string' && !titles.includes(alt)) titles.push(alt);
      }

      const genres = asList(dig(data, ['genres']));
      const countries = asList(dig(data, ['origin_country']));
      const isAnime =
        genres.some((genre) => dig(genre, ['id']) === 16) &&
        (countries.includes('JP') || dig(data, ['original_language']) === 'ja');

      return { title, originalTitle, titles, year, releaseDate, imdbId, isAnime, runtime };
    } catch {
      return EMPTY_META;
    }
  })();
  metaCache.set(key, pending);
  return pending;
}

/** helpers.js resolveImdbId. */
async function resolveImdbId(id: string, isTv: boolean): Promise<string> {
  if (id.startsWith('tt')) return id;
  const meta = await getTmdbMetadata(id, isTv);
  return meta.imdbId ?? `tt${id}`;
}

const ACCENTS: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ù: 'u',
  ú: 'u', û: 'u', ü: 'u', ý: 'y', ÿ: 'y',
};

function stripAccents(text: string): string {
  let out = '';
  for (const char of text) out += ACCENTS[char] ?? char;
  return out;
}

/** helpers.js slugify. */
function slugify(text: string | null | undefined): string {
  if (!text) return '';
  return stripAccents(text.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── HLS playlist helpers ─────────────────────────────────────────────────────

/**
 * Whether an HLS master playlist keeps its sound in playlists of their own (one
 * per language). A quality's playlist from such a master is a silent picture.
 */
function hlsAudioIsSeparate(master: string): boolean {
  return /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(master);
}

interface HlsVariant {
  url: string;
  quality: string;
}

/**
 * The variants of an HLS master playlist `text` fetched from `master`
 * (anizone.js / vidly.js resolveHlsVariants). Null when it isn't a master.
 *
 * Not in the JS: when the sound is in playlists of its own, the master is
 * handed back whole, as one stream, under its best quality. The JS returns each
 * quality's playlist, which plays with no sound at all; whole, the player still
 * picks the quality from it and every language in it shows up as an audio track.
 */
function hlsVariantsOf(
  text: string,
  master: string,
  options: { bandwidth?: boolean; skip?: (url: string) => boolean } = {},
): HlsVariant[] | null {
  if (!text.includes('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) return null;
  const cut = master.split('?')[0]?.lastIndexOf('/') ?? -1;
  const baseUrl = master.slice(0, cut + 1);
  const lines = text.split('\n').map((line) => line.trim());
  const out: HlsVariant[] = [];
  let best = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    let quality = 'Auto';
    const resolution = /RESOLUTION=\d+x(\d+)/i.exec(line);
    if (resolution) {
      quality = `${resolution[1]}p`;
      const height = Number(resolution[1]);
      if (height > best) best = height;
    } else if (options.bandwidth) {
      const bandwidth = /BANDWIDTH=(\d+)/i.exec(line);
      if (bandwidth) {
        const value = Number(bandwidth[1]);
        if (value > 3000000) quality = '1080p';
        else if (value > 1800000) quality = '960p';
        else if (value > 1200000) quality = '720p';
        else if (value > 800000) quality = '640p';
        else quality = '480p';
      }
    }
    const next = i + 1 < lines.length ? (lines[i + 1] ?? '') : '';
    if (next !== '' && !next.startsWith('#')) {
      if (options.skip?.(next)) continue;
      out.push({ url: next.startsWith('http') ? next : `${baseUrl}${next}`, quality });
    }
  }

  if (out.length === 0) return null;
  if (hlsAudioIsSeparate(text)) return [{ url: master, quality: best > 0 ? `${best}p` : 'Auto' }];
  return out;
}

/** {@link hlsVariantsOf} over the network, null when the fetch or parse fails. */
async function fetchVariants(
  master: string,
  headers: Record<string, string>,
  timeoutMs: number,
  options: { bandwidth?: boolean; skip?: (url: string) => boolean } = {},
): Promise<HlsVariant[] | null> {
  try {
    return hlsVariantsOf(await fetchText(master, { headers, timeoutMs }), master, options);
  } catch {
    return null;
  }
}

/** Numeric weight of a quality label, for sorting best-first. */
function qualityNumber(quality: string): number {
  const match = /\d+/.exec(quality);
  return match ? Number(match[0]) : 0;
}

/** Quality labels as the sources write them: '1080' → '1080p', 'Auto' stays. */
function normQuality(value: unknown): string {
  if (!truthy(value)) return '1080p';
  const text = String(value).trim();
  return /^\d+$/.test(text) ? `${text}p` : text;
}

// ── The sources ──────────────────────────────────────────────────────────────

/**
 * Every ported source, in the order VyseTV ships them: the user's own order
 * first (CNO, VidUp, 111477, VidLink), then the rest of the SDK ports.
 */
export const FILM_SOURCES: FilmSource[] = [
  { id: 'cno', name: 'CNO', note: 'Films and shows, up to 4K', scraper: cno },
  { id: 'vidup', name: 'VidUp', note: 'Films and shows, up to 4K', scraper: vidup },
  {
    id: '111477',
    name: '111477',
    note: 'Films and shows, as very large files (often 4K remuxes)',
    scraper: s111477,
  },
  { id: 'vidlink', name: 'VidLink', note: 'Films and shows, as video files up to 1080p', scraper: vidlink },
  { id: 'vidbolt', name: 'VidBolt', note: 'Films and shows', scraper: vidbolt },
  { id: 'rivestream', name: 'RiveStream', note: 'Films and shows, with many mirrors', scraper: rivestream },
  { id: '3eyedraven', name: '3EyedRaven', note: 'Films and shows, 1080p', scraper: threeEyedRaven },
  { id: 'vidlux', name: 'VidLux', note: 'Films and shows', scraper: vidlux },
  { id: 'vidly', name: 'Vidly', note: 'Films and shows', scraper: vidly },
  { id: 'purstream', name: 'PurStream', note: 'Films and shows', scraper: purstream },
  { id: 'fsonline', name: 'FSOnline', note: 'Films and shows', scraper: fsonline },
  { id: 'castle', name: 'Castle', note: 'Films and shows, 1080p', scraper: castle },
  { id: 'netplayz', name: 'NetPlayz', note: 'Films and shows, 720p', scraper: netplayz },
  { id: 'meowtv', name: 'MeowTV', note: 'Films and shows', scraper: meowtv },
  { id: 'cinemaarmy', name: 'CinemaArmy', note: 'Films and shows, 1080p', scraper: cinemaarmy },
  { id: 'vidzee', name: 'VidZee', note: 'Films and shows', scraper: vidzee },
  { id: 'yastream', name: 'YaStream', note: 'Films and shows', scraper: yastream },
  { id: 'lookmovie', name: 'LookMovie', note: 'Films and shows, 480p', scraper: lookmovie },
  { id: 'vidcore', name: 'VidCore', note: 'Films and shows, up to 4K', scraper: vidcore },
  { id: 'cinebros', name: 'CineBros', note: 'Films and shows, up to 4K', scraper: cinebros },
  { id: 'thugtv', name: 'ThugTV', note: 'Films and shows, 720p', scraper: thugtv },
  { id: 'framextv', name: 'FrameXTV', note: 'Films and shows, English audio', scraper: framextv },
  { id: 'lmscript', name: 'LMScript', note: 'Films, up to 1080p', scraper: lmscript, filmsOnly: true },
  { id: 'vidqueen', name: 'VidQueen', note: 'Films, as video files', scraper: vidqueen, filmsOnly: true },
  { id: 'watchout', name: 'WatchOut', note: 'Shows, 720p', scraper: watchout, showsOnly: true },
  { id: 'vidspark', name: 'VidSpark', note: 'Shows, 1080p', scraper: vidspark, showsOnly: true },
  { id: 'willow', name: 'Willow', note: 'Films and shows, as video files', scraper: willow },
  {
    id: 'trendimovies',
    name: 'TrendiMovies',
    note: 'Films and shows, as 1080p video files',
    scraper: trendimovies,
  },
  { id: 'vidvault', name: 'VidVault', note: 'Films and shows, as 1080p video files', scraper: vidvault },
  {
    id: 'torrentio',
    name: 'Torrentio',
    note: 'Films and shows, as video files (streamed, not peer-to-peer)',
    scraper: torrentio,
  },
  { id: 'braflix', name: 'BraFlix', note: 'Films and shows, as video files', scraper: braflix },
  {
    id: 'moviebox',
    name: 'MovieBox',
    note: 'Films and shows, as video files (often 360p first)',
    scraper: moviebox,
  },
  { id: 'vixsrc', name: 'VixSrc', note: 'Films and shows, Italian audio first', scraper: vixsrc },
  {
    id: 'anizone',
    name: 'AniZone',
    note: 'Anime only: titles TMDB lists as Japanese animation',
    scraper: anizone,
    animeOnly: true,
  },
  { id: 'anv', name: 'ANV', note: 'Anime only: titles TMDB lists as Japanese animation', scraper: anv, animeOnly: true },
  {
    id: '123anime',
    name: '123Anime',
    note: 'Anime only: titles TMDB lists as Japanese animation',
    scraper: anime123,
    animeOnly: true,
  },
  { id: 'hexa', name: 'Hexa', note: 'Films and shows', scraper: hexa },
  { id: 'cinesrc', name: 'CineSrc', note: 'Films and shows', scraper: cinesrc },
  { id: 'mapple', name: 'Mapple', note: 'Films and shows, from 6 servers', scraper: mapple },
];

// ── vidlink.js: token from enc-dec.app, streams from vidlink.pro ──────────────

async function vidlink(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidlink.pro';
  const headers = { 'User-Agent': sdkUA, Origin: base, Referer: `${base}/` };
  try {
    const encData = await fetchJson(`https://enc-dec.app/api/enc-vidlink?text=${q.id}`, { timeoutMs: 6000 });
    if (!isRecord(encData) || encData.status !== 200 || typeof encData.result !== 'string') return [];
    const token = encData.result;
    const basePath = hasEpisode(q)
      ? `${base}/api/b/tv/${token}/${seasonOf(q)}/${episodeOf(q)}`
      : `${base}/api/b/movie/${token}`;

    const out: FoundStream[] = [];
    const seen = new Set<string>();

    // One request, where the SDK sends two at once: both answer the same (checked
    // on ten titles, 14 Nov 2026), and the site shuts an address out for a while
    // after about ten requests in a few seconds (Cloudflare's 1015). The second is
    // only asked when the first has nothing.
    for (const url of [basePath, `${basePath}?multiLang=0`]) {
      if (out.length > 0) break;
      let res: RawResponse;
      try {
        res = await fetchRaw(url, { headers, timeoutMs: 10000 });
      } catch {
        continue;
      }
      if (res.status === 429) break; // shut out: asking again only makes it last longer
      if (res.status < 200 || res.status >= 300) continue;
      let data: unknown;
      try {
        data = JSON.parse(res.body);
      } catch {
        data = null;
      }
      const stream = dig(data, ['stream']);
      if (!isRecord(stream)) continue;

      const playlist = stream.playlist;
      if (typeof playlist === 'string' && playlist !== '' && !seen.has(playlist)) {
        seen.add(playlist);
        const isDash = stream.type === 'dash' || stream.deliveryType === 'dash' || playlist.includes('.mpd');
        const firstResolution = dig(stream, ['playbackMetadata', 'resolutions', 0]);
        const quality = typeof firstResolution === 'number' ? `${firstResolution}p` : 'Auto';
        const hdrs: Record<string, string> = { ...headers };
        if (isRecord(stream.playlistHeaders)) {
          for (const [key, value] of Object.entries(stream.playlistHeaders)) hdrs[key] = String(value);
        }
        out.push(
          mkStream({
            url: playlist,
            server: `VidLink ${isDash ? 'DASH' : 'HLS'}`,
            quality,
            type: isDash ? 'dash' : 'hls',
            headers: hdrs,
          }),
        );
      }

      const qualities = stream.qualities;
      if (isRecord(qualities)) {
        const seenQualities = new Set<string>();
        for (const qKey of ['1080', '720', '480', '360', ...Object.keys(qualities)]) {
          if (seenQualities.has(qKey)) continue;
          seenQualities.add(qKey);
          const qData = qualities[qKey];
          if (!isRecord(qData)) continue;
          const url = qData.url;
          if (typeof url !== 'string' || url === '' || seen.has(url)) continue;
          seen.add(url);
          // the CDN rejects browser User-Agents (428) and Referer (429); use a plain UA only
          const hdrs: Record<string, string> = { 'User-Agent': 'libmpv' };
          if (isRecord(qData.headers)) {
            for (const [key, value] of Object.entries(qData.headers)) hdrs[key] = String(value);
          }
          out.push(
            mkStream({
              url,
              server: `VidLink ${qKey}p`,
              quality: `${qKey}p`,
              type: typeof qData.type === 'string' ? qData.type : 'mp4',
              headers: hdrs,
            }),
          );
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── vidbolt.js ───────────────────────────────────────────────────────────────

async function vidbolt(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidbolt.xyz';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': ua,
    Referer: `${base}/`,
    Origin: base,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const playback = { 'User-Agent': ua, Referer: `${base}/`, Origin: base };
  const target = hasEpisode(q)
    ? `${base}/api/resolve?type=tv&id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(q)}`
    : `${base}/api/resolve?type=movie&id=${q.id}`;
  const kind = (given: unknown, url: string): string => {
    const explicit = firstTruthy([given]);
    if (typeof explicit === 'string') return explicit;
    if (url.includes('.m3u8')) return 'hls';
    if (url.includes('.mpd')) return 'dash';
    return 'mp4';
  };

  try {
    const res = await fetchRaw(target, { headers, timeoutMs: 25000 });
    if (res.status >= 300) return [];
    let data: unknown;
    try {
      data = JSON.parse(res.body);
    } catch {
      data = null;
    }
    const stream = dig(data, ['stream']);
    if (!truthy(stream) || !isRecord(stream)) return [];
    const serverName = stream.server;
    const name =
      typeof serverName === 'string' && serverName !== ''
        ? serverName[0]?.toUpperCase() + serverName.slice(1)
        : 'Direct';

    const out: FoundStream[] = [];
    const seen = new Set<string>();

    if (Array.isArray(stream.sources)) {
      for (const item of stream.sources) {
        const url = dig(item, ['url']);
        if (typeof url !== 'string' || url === '' || seen.has(url)) continue;
        seen.add(url);
        let quality = truthy(dig(item, ['quality'])) ? String(dig(item, ['quality'])).trim() : 'Auto';
        if (/^\d+$/.test(quality)) quality = `${quality}p`;
        out.push(
          mkStream({
            url,
            server: `VidBolt - ${name}`,
            quality,
            type: kind(dig(item, ['kind']), url),
            headers: playback,
            audio: audioOf(dig(item, ['language'])),
          }),
        );
      }
    }

    const direct = stream.url;
    if (typeof direct === 'string' && direct !== '' && !seen.has(direct)) {
      seen.add(direct);
      out.push(
        mkStream({
          url: direct,
          server: `VidBolt - ${name}`,
          quality: String(firstTruthy([stream.quality]) ?? 'Auto'),
          type: kind(stream.kind, direct),
          headers: playback,
          audio: audioOf(stream.language),
        }),
      );
    }
    return out;
  } catch {
    return [];
  }
}

// ── rivestream.js ────────────────────────────────────────────────────────────

const RIVE_CHARS = [
  '4Z7lUo', 'gwIVSMD', 'PLmz2elE2v', 'Z4OFV0', 'SZ6RZq6Zc', 'zhJEFYxrz8', 'FOm7b0', 'axHS3q4KDq', 'o9zuXQ', '4Aebt',
  'wgjjWwKKx', 'rY4VIxqSN', 'kfjbnSo', '2DyrFA1M', 'YUixDM9B', 'JQvgEj0', 'mcuFx6JIek', 'eoTKe26gL', 'qaI9EVO1rB',
  '0xl33btZL', '1fszuAU', 'a7jnHzst6P', 'wQuJkX', 'cBNhTJlEOf', 'KNcFWhDvgT', 'XipDGjST', 'PCZJlbHoyt', '2AYnMZkqd',
  'HIpJh', 'KH0C3iztrG', 'W81hjts92', 'rJhAT', 'NON7LKoMQ', 'NMdY3nsKzI', 't4En5v', 'Qq5cOQ9H', 'Y9nwrp', 'VX5FYVfsf',
  'cE5SJG', 'x1vj1', 'HegbLe', 'zJ3nmt4OA', 'gt7rxW57dq', 'clIE9b', 'jyJ9g', 'B5jXjMCSx', 'cOzZBZTV', 'FTXGy',
  'Dfh1q1', 'ny9jqZ2POI', 'X2NnMn', 'MBtoyD', 'qz4Ilys7wB', '68lbOMye', '3YUJnmxp', '1fv5Imona', 'PlfvvXD7mA',
  'ZarKfHCaPR', 'owORnX', 'dQP1YU', 'dVdkx', 'qgiK0E', 'cx9wQ', '5F9bGa', '7UjkKrp', 'Yvhrj', 'wYXez5Dg3', 'pG4GMU',
  'MwMAu', 'rFRD5wlM',
];

function riveInner(s: string): string {
  let t = 0;
  for (let n = 0; n < s.length; n += 1) {
    const r = s.charCodeAt(n);
    t = u32(r + shl(t, 6) + shl(t, 16) - t);
    const i = u32(shl(t, n % 5) | ushr(t, 32 - (n % 5)));
    t = i32(t ^ u32(i ^ u32(shl(r, n % 7) | ushr(r, 8 - (n % 7)))));
    t = u32(t + i32(ushr(t, 11) ^ shl(t, 3)));
  }
  t = i32(t ^ ushr(t, 15));
  t = u32((65535 & t) * 49842 + shl((ushr(t, 16) * 49842) & 65535, 16));
  t = i32(t ^ ushr(t, 13));
  t = u32((65535 & t) * 40503 + shl((ushr(t, 16) * 40503) & 65535, 16));
  t = i32(t ^ ushr(t, 16));
  return hex8(t);
}

function riveOuter(s: string): string {
  let n = i32(3735928559 ^ s.length);
  for (let e = 0; e < s.length; e += 1) {
    const r = s.charCodeAt(e);
    const rXor = (i32(131 * e + 89) ^ shl(r, e % 5)) & 255;
    const r2 = r ^ rXor;
    n = i32(u32(shl(n, 7) | ushr(n, 25)) ^ r2);
    const idx = (65535 & n) * 60205;
    const o2 = shl(ushr(n, 16) * 60205, 16);
    n = u32(idx + o2);
    n = i32(n ^ ushr(n, 11));
  }
  n = i32(n ^ ushr(n, 15));
  n = u32((65535 & n) * 49842 + shl(ushr(n, 16) * 49842, 16));
  n = i32(n ^ ushr(n, 13));
  n = u32((65535 & n) * 40503 + shl(ushr(n, 16) * 40503, 16));
  n = i32(n ^ ushr(n, 16));
  n = u32((65535 & n) * 10196 + shl(ushr(n, 16) * 10196, 16));
  return hex8(i32(n ^ ushr(n, 15)));
}

/** rivestream.js generateRiveSecretKey. */
function riveSecretKey(input: string | null): string {
  if (input === null) return 'rive';
  try {
    const r = input;
    const parsed = Number(r);
    let t: string;
    let n: number;
    if (!Number.isFinite(parsed) || r.trim() === '') {
      let sum = 0;
      for (let i = 0; i < r.length; i += 1) sum += r.charCodeAt(i);
      t = RIVE_CHARS[sum % RIVE_CHARS.length] ?? 'rive';
      n = Math.floor((sum % r.length) / 2);
    } else {
      const i = Math.trunc(parsed);
      t = RIVE_CHARS[i % RIVE_CHARS.length] ?? 'rive';
      n = Math.floor((i % r.length) / 2);
    }
    return btoa(riveOuter(riveInner(r.slice(0, n) + t + r.slice(n))));
  } catch {
    return 'topSecret';
  }
}

async function rivestream(q: FilmQuery): Promise<FoundStream[]> {
  const defaults = [
    'apex', 'pulse', 'solstice', 'quasar', 'horizon', 'primevids', 'flowcast', 'asiacloud', 'citadel', 'hindicast', 'guru',
  ];
  const movie = !hasEpisode(q);
  const key = riveSecretKey(q.id);
  const referer = movie
    ? `https://www.rivestream.app/watch?type=movie&id=${q.id}`
    : `https://www.rivestream.app/watch?type=tv&id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(q)}`;

  let services: string[] = defaults;
  try {
    const res = await fetchJson(
      `https://www.rivestream.app/api/backendfetch?requestID=VideoProviderServices&secretKey=${encodeURIComponent(
        riveSecretKey(null),
      )}`,
      {
        headers: {
          'User-Agent': sdkUA,
          Referer: 'https://www.rivestream.app/',
          Accept: 'application/json, text/plain, */*',
        },
        timeoutMs: 6000,
      },
    );
    const data = dig(res, ['data']);
    services = Array.isArray(data) && data.length > 0 ? data.map((entry) => String(entry)) : defaults;
  } catch {
    services = defaults;
  }

  const one = async (service: string): Promise<FoundStream[]> => {
    try {
      const cb =
        service === 'primevids' || service === 'citadel'
          ? `&cb=${Math.floor(Date.now() / 3000000)}`
          : '';
      const params = movie
        ? `requestID=movieVideoProvider&id=${q.id}&service=${service}${cb}&secretKey=${encodeURIComponent(key)}`
        : `requestID=tvVideoProvider&id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(
            q,
          )}&service=${service}${cb}&secretKey=${encodeURIComponent(key)}`;
      const res = await fetchJson(`https://www.rivestream.app/api/backendfetch?${params}`, {
        headers: { 'User-Agent': sdkUA, Referer: referer, Accept: 'application/json, text/plain, */*' },
        timeoutMs: 10000,
      });
      const sources = dig(res, ['data', 'sources']);
      if (!Array.isArray(sources)) return [];
      const out: FoundStream[] = [];
      for (const item of sources) {
        const url = dig(item, ['url']);
        if (!truthy(url)) continue;
        const urlText = String(url);
        const format = String(dig(item, ['format']) ?? '').toLowerCase();
        const lower = urlText.toLowerCase();
        out.push(
          mkStream({
            url: urlText,
            server: `Rive (${String(firstTruthy([dig(item, ['source'])]) ?? service)})`,
            quality: String(firstTruthy([dig(item, ['quality'])]) ?? 'Auto'),
            type:
              format === 'hls' || format === 'm3u8' || lower.includes('.m3u8') || lower.includes('.txt')
                ? 'hls'
                : 'mp4',
            headers: { 'User-Agent': sdkUA, Referer: referer },
          }),
        );
      }
      return out;
    } catch {
      return [];
    }
  };

  const all = await Promise.all(services.map((service) => one(service)));
  return all.flat();
}

// ── 3eyedraven.js ────────────────────────────────────────────────────────────

async function threeEyedRaven(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://3eyedraven.watch';
  const apiBase = 'https://3eyedraven.watch/api';
  const absolute = (url: string): string => {
    if (url === '') return '';
    if (/^https?:\/\//.test(url)) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const meta = await getTmdbMetadata(q.id, hasEpisode(q));
  if (meta.title === '') return [];
  const identifier = `${slugify(meta.title)}-${q.id}`;
  const url = hasEpisode(q)
    ? `${apiBase}/stream/${identifier}?season=${seasonOf(q)}&episode=${episodeOf(q)}`
    : `${apiBase}/stream/${identifier}`;
  const headers = { 'User-Agent': getUA(), Accept: 'application/json', Referer: `${base}/`, Origin: base };
  try {
    const res = await fetchRaw(url, { headers, timeoutMs: 15000 });
    if (res.status >= 300) return [];
    const data: unknown = JSON.parse(res.body);
    const stream = dig(data, ['stream']);
    const streamUrl = dig(stream, ['url']);
    if (typeof streamUrl !== 'string' || streamUrl === '') return [];
    const full = absolute(streamUrl);
    if (!/^https?:\/\//.test(full)) return [];
    return [
      mkStream({
        url: full,
        headers,
        server: '3eyedraven',
        quality: '1080p',
        type: dig(stream, ['format']) === 'hls' ? 'hls' : 'mp4',
      }),
    ];
  } catch {
    return [];
  }
}

// ── vidlux.js (AES-256-GCM payloads, keyed by the SHA-256 of its passphrase) ──

async function vidlux(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidlux.xyz';
  const passphrase = 'vidlux-stream-encryption-2026-secure-key';
  const playback = { 'User-Agent': sdkUA, Referer: `${base}/`, Origin: base };
  const servers: Array<[string, string]> = [
    ['robot', 'Robot'], ['titan', 'Titan'], ['spider', 'Spider'], ['dragon', 'Dragon'], ['quasar', 'Quasar'],
    ['vidfast', 'Flux'], ['rocket', 'Aether'], ['star', 'Star'], ['bolt', 'Bolt'], ['quilox', 'Quilox'],
    ['vidrock', 'Nova'], ['dubai', 'Dubai'], ['magic', 'Magic'], ['vixsrc', 'Aura'], ['astra', 'Astra'],
  ];
  const keyBytes = waToBytes(CryptoJS.SHA256(passphrase));

  const decrypt = async (sealed: string): Promise<unknown> => {
    try {
      const plain = await aesGcmDecrypt(keyBytes, b64ToBytes(sealed));
      return plain === null ? null : (JSON.parse(plain) as unknown);
    } catch {
      return null;
    }
  };

  const tv = hasEpisode(q);
  const embedUrl = tv
    ? `${base}/embed/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
    : `${base}/embed/movie/${q.id}`;

  let token: string | null = null;
  try {
    const html = await fetchText(embedUrl, {
      headers: { 'User-Agent': sdkUA, Referer: `${base}/` },
      timeoutMs: 8000,
    });
    const direct = /(\d{13}\.[a-f0-9]{8}\.[a-f0-9]{64})/i.exec(html);
    const named = /requestToken["'\\\s:]+([a-zA-Z0-9._-]+)/i.exec(html);
    token = direct?.[1] ?? named?.[1] ?? null;
  } catch {
    token = null;
  }
  if (token === null) return [];

  const params = new URLSearchParams({ id: q.id, type: tv ? 'tv' : 'movie', _t: token });
  if (tv) {
    params.set('season', String(seasonOf(q)));
    params.set('episode', String(episodeOf(q)));
  }
  const query = params.toString();

  const out: FoundStream[] = [];
  const seen = new Set<string>();
  for (const [id, name] of servers) {
    try {
      const res = await fetchRaw(`${base}/api/extract/${id}?${query}`, {
        headers: {
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': sdkUA,
          Referer: embedUrl,
          Origin: base,
        },
        timeoutMs: 10000,
      });
      if (res.status >= 300) continue;
      let data: unknown;
      try {
        data = JSON.parse(res.body);
      } catch {
        continue;
      }
      if (truthy(dig(data, ['encrypted'])) && truthy(dig(data, ['data']))) {
        data = await decrypt(String(dig(data, ['data'])));
      }
      if (data === null) continue;
      const streamList = Array.isArray(dig(data, ['streams']))
        ? asList(dig(data, ['streams']))
        : asList(dig(data, ['sources']));
      for (const item of streamList) {
        let url = asString(firstTruthy([dig(item, ['file']), dig(item, ['url'])]));
        if (url === null) continue;
        if (url.startsWith('/')) url = `${base}${url}`;
        if (!url.startsWith('http') || seen.has(url)) continue;
        seen.add(url);
        let quality = String(firstTruthy([dig(item, ['quality'])]) ?? 'Auto');
        if (/^\d+$/.test(quality.trim())) quality = `${quality}p`;
        const explicit = asString(firstTruthy([dig(item, ['type'])]));
        out.push(
          mkStream({
            url,
            server: `VidLux - ${name}`,
            quality,
            type: explicit ?? (url.includes('.mpd') ? 'dash' : url.includes('.m3u8') ? 'hls' : 'mp4'),
            headers: playback,
          }),
        );
      }
      if (out.length > 0) break;
    } catch {
      // one server failing must not stop the others
    }
  }
  return out;
}

// ── vidly.js ─────────────────────────────────────────────────────────────────

/** vidly.js's v1 payload decryptor (a hand-rolled FNV/LCG stream cipher). */
function vidlyDecrypt(sealed: string): unknown {
  if (!sealed.startsWith('v1.')) return null;
  try {
    const secret = 'vY7#qL2!mZ9@wK4$';
    const bytes = b64ToBytes(sealed.slice(3));
    const salt = bytes.subarray(0, 12);
    const data = bytes.slice(12);
    const keys: number[] = [];
    for (let s = 0; s < 4; s += 1) {
      let n = u32(0x811c9dc5 ^ (0x9e3779b9 * s));
      for (let i = 0; i < secret.length; i += 1) n = u32((n ^ secret.charCodeAt(i)) * 0x1000193);
      for (const byte of salt) n = u32((n ^ byte) * 0x1000193);
      keys.push(n);
    }
    let sKey = keys[0] ?? 0;
    let nKey = keys[1] ?? 0;
    let lKey = keys[2] ?? 0;
    let aKey = keys[3] ?? 0;
    let r = 0;
    for (let i = 0; i < data.length; i += 1) {
      if ((3 & i) === 0) {
        lKey = u32(lKey);
        aKey = u32(aKey);
        sKey = u32(sKey);
        nKey = u32(nKey);
        let e = i32(sKey + nKey);
        sKey = i32(nKey ^ (nKey >> 9));
        nKey = i32(lKey + i32(lKey << 3));
        aKey = i32(aKey + 1);
        e = i32(e + aKey);
        lKey = i32(i32(i32(lKey << 21) | (lKey >> 11)) + e);
        r = u32(e);
      }
      data[i] = (data[i] ?? 0) ^ ((r >> ((3 & i) * 8)) & 255);
    }
    return JSON.parse(decodeUtf8(data));
  } catch {
    return null;
  }
}

async function vidly(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidly.pro';
  const headers = {
    'User-Agent': sdkUA,
    Referer: `${base}/`,
    Origin: base,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const playback = { 'User-Agent': sdkUA, Referer: `${base}/`, Origin: base };
  const invalid = (url: string | null | undefined): boolean =>
    url === null || url === undefined || url === '' || /tiles|thumbs?|sprite/i.test(url);
  const target = hasEpisode(q)
    ? `${base}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}?preview=1`
    : `${base}/movie/${q.id}?preview=1`;

  try {
    const html = await fetchText(target, { headers, timeoutMs: 10000 });
    const out: FoundStream[] = [];
    const seen = new Set<string>();

    const sealed = /v1\.[a-zA-Z0-9_-]{100,}/.exec(html)?.[0];
    if (sealed !== undefined) {
      const data = vidlyDecrypt(sealed);
      if (Array.isArray(dig(data, ['streams']))) {
        const label = String(firstTruthy([dig(data, ['provider', 'label'])]) ?? 'Vidly');
        for (const stream of asList(dig(data, ['streams']))) {
          const url = dig(stream, ['url']);
          if (typeof url !== 'string' || !url.startsWith('http') || invalid(url)) continue;
          if (url.includes('.m3u8')) {
            const variants = await fetchVariants(url, playback, 6000, { bandwidth: true, skip: invalid });
            if (variants !== null && variants.length > 0) {
              for (const variant of variants) {
                if (invalid(variant.url) || seen.has(variant.url)) continue;
                seen.add(variant.url);
                out.push(
                  mkStream({
                    url: variant.url,
                    server: `Vidly - ${label} (${variant.quality})`,
                    quality: variant.quality,
                    type: 'hls',
                    headers: playback,
                    audio: audioOf(dig(stream, ['language'])),
                  }),
                );
              }
              continue;
            }
          }
          if (seen.has(url)) continue;
          seen.add(url);
          let quality = truthy(dig(stream, ['quality'])) ? String(dig(stream, ['quality'])).trim() : 'Auto';
          if (/^\d+$/.test(quality)) quality = `${quality}p`;
          const language = dig(stream, ['language']);
          out.push(
            mkStream({
              url,
              server: `Vidly - ${label}${truthy(language) ? ` (${String(language)})` : ''}`,
              quality,
              type:
                asString(firstTruthy([dig(stream, ['type'])])) ??
                (url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : 'mp4'),
              headers: playback,
              audio: audioOf(language),
            }),
          );
        }
      }
    }

    if (out.length === 0) {
      const match = /https?:\/\/[^"'\\<>\s]+\/media\/([a-zA-Z0-9_-]+)\/thumbs/i.exec(html);
      if (match) {
        const origin = (match[0] ?? '').split('/media/')[0] ?? '';
        const master = `${origin}/media/${match[1]}/index.m3u8`;
        const variants = await fetchVariants(master, playback, 6000, { bandwidth: true, skip: invalid });
        if (variants !== null && variants.length > 0) {
          for (const variant of variants) {
            if (invalid(variant.url) || seen.has(variant.url)) continue;
            seen.add(variant.url);
            out.push(
              mkStream({
                url: variant.url,
                server: `Vidly - Direct (${variant.quality})`,
                quality: variant.quality,
                type: 'hls',
                headers: playback,
              }),
            );
          }
        } else if (!invalid(master) && !seen.has(master)) {
          seen.add(master);
          out.push(mkStream({ url: master, server: 'Vidly - Direct', type: 'hls', headers: playback }));
        }
      }
    }

    out.sort((a, b) => qualityNumber(b.quality) - qualityNumber(a.quality));
    return out;
  } catch {
    return [];
  }
}

// ── purstream.js ─────────────────────────────────────────────────────────────

async function purstream(q: FilmQuery): Promise<FoundStream[]> {
  const domain = 'https://purstream.ad';
  const apiBase = 'https://api.purstream.ad/api/v1';
  const headers = {
    'User-Agent': sdkUA,
    Accept: 'application/json, text/plain, */*',
    Referer: `${domain}/`,
    Origin: domain,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
  const tv = hasEpisode(q);
  const type = tv ? 'tv' : 'movie';

  try {
    const meta = await getTmdbMetadata(q.id, tv);
    if (meta.titles.length === 0) return [];
    const title = meta.titles[0] ?? '';
    const search = await fetchJson(`${apiBase}/search-bar/search/${encodeURIComponent(title)}`, {
      headers,
      timeoutMs: 10000,
    });
    const items = asList(dig(search, ['data', 'items', 'movies', 'items']));
    const lower = title.toLowerCase();
    const sameYear = (item: unknown): boolean =>
      meta.year === null || String(dig(item, ['release_date']) ?? '').startsWith(String(meta.year));
    const match =
      items.find(
        (item) => dig(item, ['type']) === type && String(dig(item, ['title']) ?? '').toLowerCase() === lower && sameYear(item),
      ) ?? items.find((item) => dig(item, ['type']) === type);
    if (!truthy(dig(match, ['id']))) return [];

    const url = tv
      ? `${apiBase}/stream/${String(dig(match, ['id']))}/episode?season=${seasonOf(q)}&episode=${episodeOf(q)}`
      : `${apiBase}/stream/${String(dig(match, ['id']))}`;
    const js = await fetchJson(url, { headers, timeoutMs: 10000 });
    const sources = asList(dig(js, ['data', 'items', 'sources']));
    if (dig(js, ['type']) !== 'success' || sources.length === 0) return [];
    const chosen = sources.find((source) => truthy(dig(source, ['stream_url'])));
    if (chosen === undefined) return [];
    const streamUrl = dig(chosen, ['stream_url']);
    if (typeof streamUrl !== 'string') return [];
    return [
      mkStream({
        url: streamUrl,
        headers: { 'User-Agent': sdkUA, Referer: `${domain}/` },
        server: 'purstream',
        quality: String(firstTruthy([dig(chosen, ['source_name'])]) ?? 'Auto'),
        type: asString(firstTruthy([dig(chosen, ['format'])])) ?? 'hls',
      }),
    ];
  } catch {
    return [];
  }
}

// ── fsonline.js ──────────────────────────────────────────────────────────────

async function fsonline(q: FilmQuery): Promise<FoundStream[]> {
  const origin = 'https://www3.fsonline.app';
  const ajax = `${origin}/wp-admin/admin-ajax.php`;
  const headers = { 'User-Agent': sdkUA, Origin: origin, Referer: `${origin}/` };
  const tv = hasEpisode(q);

  try {
    const meta = await getTmdbMetadata(q.id, tv);
    if (meta.titles.length === 0) return [];
    const query = `${meta.titles[0] ?? ''}${meta.year !== null ? ` ${meta.year}` : ''}`;
    const searchHtml = await fetchText(`${origin}/?s=${encodeURIComponent(query)}`, { headers });
    const folder = tv ? 'seriale' : 'film';
    const link = new RegExp(`href=["'](https?://www3\\.fsonline\\.app/${folder}/([^"'/]+)/)["']`, 'i').exec(searchHtml);
    if (link === null) return [];
    const slug = (link[2] ?? '').replace(/-\d{4}$/, '');
    const target = tv
      ? `${origin}/episoade/${slug}-sezonul-${seasonOf(q)}-episodul-${episodeOf(q)}/`
      : (link[1] ?? '');
    const pageHtml = await fetchText(target, { headers });
    const movieId = /movie-id=['"]([^'"]+)['"]/.exec(pageHtml)?.[1] ?? /movie-id=([^ >]+)/.exec(pageHtml)?.[1];
    if (movieId === undefined) return [];

    const ajaxHtml = await fetchText(ajax, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: target,
      },
      body: `action=lazy_player&movieID=${movieId}`,
    });

    const out: FoundStream[] = [];
    let idx = 0;
    for (;;) {
      idx = ajaxHtml.indexOf('data-vs="', idx);
      if (idx === -1) break;
      const embedStart = idx + 9;
      const embedEnd = ajaxHtml.indexOf('"', embedStart);
      const embedUrl = ajaxHtml.slice(embedStart, embedEnd);
      const spanStart = ajaxHtml.indexOf('<span>', embedEnd);
      const spanEnd = ajaxHtml.indexOf('</span>', spanStart);
      if (spanStart < 0 || spanEnd < 0) break;
      const label = ajaxHtml.slice(spanStart + 6, spanEnd).trim().toLowerCase();
      if (label.includes('filesun')) {
        try {
          const rHtml = await fetchText(embedUrl, {
            headers: { Referer: origin, 'User-Agent': sdkUA },
          });
          const match =
            /file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/.exec(rHtml) ??
            /["']?file["']?:\s*["'](https?:\/\/[^"']+)["']/.exec(rHtml);
          if (match?.[1] !== undefined) {
            out.push(
              mkStream({
                url: match[1].replace(/\\\//g, '/'),
                server: 'FSOnline - FileSuN',
                type: 'hls',
                headers: { Referer: embedUrl, Origin: 'https://player.fsonline.app', 'User-Agent': sdkUA },
              }),
            );
          }
        } catch {
          // a dead embed on this page must not stop the others
        }
      }
      idx = spanEnd;
    }
    return out;
  } catch {
    return [];
  }
}

// ── castle.js (the Castle app's API at api.hlowb.com; AES-128-CBC answers) ────

const CASTLE_QUALITY: Record<number, string> = { 1: '480p', 2: '720p', 3: '1080p' };

async function castle(q: FilmQuery): Promise<FoundStream[]> {
  const castleBase = 'https://api.hlowb.com';
  const pkg = 'com.external.castle';
  const channel = 'IndiaA';
  const client = '1';
  const lang = 'en-US';
  const suffix = 'T!BgJB';
  const apkSignKey = 'ED0955EB04E67A1D9F3305B95454FED485261475';
  const working = {
    'User-Agent': 'okhttp/4.9.3',
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Connection: 'Keep-Alive',
    Referer: castleBase,
  };
  const playback = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    Connection: 'keep-alive',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    DNT: '1',
  };
  const resolution = 2;

  const request = async (
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<string> => {
    const res = await fetchRaw(url, {
      method: options.method ?? 'GET',
      headers: { ...working, ...(options.headers ?? {}) },
      body: options.body,
    });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, url);
    return res.body;
  };

  const deriveKey = (b64: string): Uint8Array => {
    const material = [...b64ToBytes(b64), ...new TextEncoder().encode(suffix)];
    while (material.length < 16) material.push(0);
    return Uint8Array.from(material.slice(0, 16));
  };

  const decrypted = (text: string, securityKey: string): unknown => {
    let cipher = text.trim();
    if (cipher === '') throw new Error('Empty response');
    try {
      const parsed: unknown = JSON.parse(cipher);
      const data = dig(parsed, ['data']);
      if (isRecord(parsed) && typeof data === 'string') cipher = data.trim();
    } catch {
      // not a JSON envelope: the body is the ciphertext itself
    }
    const key = deriveKey(securityKey);
    const plain = decodeUtf8(aesCbcDecrypt(key, key, b64ToBytes(cipher)));
    // long ids come back as bare numbers, which JSON.parse would round; quote them
    return JSON.parse(plain.replace(/:(\s*)(-?\d{16,})(\s*[,}\]])/g, ':${1}"${2}"${3}'));
  };

  const dataBlock = (value: unknown): Record<string, unknown> => {
    if (!isRecord(value)) return {};
    const data = value.data;
    return isRecord(data) ? data : value;
  };

  const qualityValue = (quality: string | null): number => {
    if (quality === null || quality === '') return 0;
    const text = quality
      .toLowerCase()
      .replace(/^(sd|hd|fhd|uhd|4k)\s*/, '')
      .replace(/p$/, '')
      .trim();
    if (text === '4k' || text === '2160') return 2160;
    const match = /^-?\d+/.exec(text);
    const parsed = match ? Number(match[0]) : 0;
    return parsed > 0 ? parsed : 0;
  };

  const hasSeason = q.season !== undefined && q.season !== null && q.season !== 0;
  const hasNumber = q.episode !== undefined && q.episode !== null && q.episode !== 0;
  const tv = hasSeason && hasNumber;
  const season = q.season ?? 0;
  const episode = q.episode ?? 0;

  try {
    const tmdb: unknown = JSON.parse(
      await request(
        `https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${q.id}?api_key=${getTmdbApiKey()}&append_to_response=external_ids`,
      ),
    );
    const title = String(dig(tmdb, [tv ? 'name' : 'title']) ?? '');
    const date = String(dig(tmdb, [tv ? 'first_air_date' : 'release_date']) ?? '');
    const year = date !== '' ? numOrNull(date.split('-')[0]) : null;

    const keyRes: unknown = JSON.parse(
      await request(`${castleBase}/v0.1/system/getSecurityKey/1?channel=${channel}&clientType=${client}&lang=${lang}`),
    );
    if (dig(keyRes, ['code']) !== 200 || !truthy(dig(keyRes, ['data']))) return [];
    const securityKey = String(dig(keyRes, ['data']));

    const term = year !== null ? `${title} ${year}` : title;
    const searchParams = new URLSearchParams({
      channel,
      clientType: client,
      keyword: term,
      lang,
      mode: '1',
      packageName: pkg,
      page: '1',
      size: '30',
    });
    const search = decrypted(
      await request(`${castleBase}/film-api/v1.1.0/movie/searchByKeyword?${searchParams.toString()}`),
      securityKey,
    );
    const rows = asList(dig(dataBlock(search), ['rows']));
    if (rows.length === 0) return [];

    const want = title.toLowerCase();
    let movieId: string | null = null;
    for (const item of rows) {
      const candidate = String(firstTruthy([dig(item, ['title']), dig(item, ['name'])]) ?? '').toLowerCase();
      if (candidate !== '' && (candidate.includes(want) || want.includes(candidate))) {
        const id = firstTruthy([dig(item, ['id']), dig(item, ['redirectId']), dig(item, ['redirectIdStr'])]);
        if (id !== null) {
          movieId = String(id);
          break;
        }
      }
    }
    if (movieId === null) {
      const first = rows[0];
      const fallback = firstTruthy([dig(first, ['id']), dig(first, ['redirectId']), dig(first, ['redirectIdStr'])]);
      movieId = fallback === null ? '' : String(fallback);
    }
    if (movieId === '') return [];

    const details = async (id: string): Promise<unknown> =>
      decrypted(
        await request(
          `${castleBase}/film-api/v1.1/movie?channel=${channel}&clientType=${client}&lang=${lang}&movieId=${id}&packageName=${pkg}`,
        ),
        securityKey,
      );

    let det = await details(movieId);
    if (tv) {
      const seasons = asList(dig(dataBlock(det), ['seasons']));
      const match = seasons.find((entry) => dig(entry, ['number']) === season);
      const seasonMovieId = dig(match, ['movieId']);
      if (truthy(seasonMovieId) && String(seasonMovieId) !== movieId) {
        movieId = String(seasonMovieId);
        det = await details(movieId);
      }
    }

    const episodes = asList(dig(dataBlock(det), ['episodes']));
    let episodeId: string | null = null;
    if (tv) {
      const match = episodes.find((entry) => dig(entry, ['number']) === episode);
      if (truthy(dig(match, ['id']))) episodeId = String(dig(match, ['id']));
    } else if (episodes.length > 0) {
      episodeId = String(dig(episodes[0], ['id']));
    }
    if (episodeId === null) return [];

    const epObj = episodes.find((entry) => String(dig(entry, ['id'])) === episodeId);
    const tracks = asList(dig(epObj, ['tracks']));

    interface CastleLink {
      name: string;
      url: string;
      quality: string;
      audio: string | null;
    }

    const process = (videoData: unknown, langInfo: string, audio: string | null = null): CastleLink[] => {
      const data = dataBlock(videoData);
      const videoUrl = data.videoUrl;
      if (!truthy(videoUrl)) return [];
      const fallbackQuality = CASTLE_QUALITY[resolution] ?? `${resolution}p`;
      const videos = data.videos;
      if (Array.isArray(videos)) {
        return videos.map((video) => {
          const quality = String(
            firstTruthy([dig(video, ['resolutionDescription']), dig(video, ['resolution'])]) ?? fallbackQuality,
          ).replace(/^(SD|HD|FHD)\s+/i, '');
          return {
            name: `Castle ${langInfo} - ${quality}`,
            url: String(firstTruthy([dig(video, ['url'])]) ?? videoUrl),
            quality,
            audio,
          };
        });
      }
      return [
        { name: `Castle ${langInfo} - ${fallbackQuality}`, url: String(videoUrl), quality: fallbackQuality, audio },
      ];
    };

    let all: CastleLink[] = [];
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const langName = String(firstTruthy([dig(track, ['languageName']), dig(track, ['abbreviate'])]) ?? `Lang${i + 1}`);
      if (truthy(dig(track, ['existIndividualVideo'])) && truthy(dig(track, ['languageId']))) {
        try {
          const params = new URLSearchParams({
            apkSignKey,
            channel,
            clientType: client,
            episodeId,
            lang,
            languageId: String(dig(track, ['languageId'])),
            mode: '1',
            movieId,
            packageName: pkg,
            resolution: String(resolution),
          });
          const body = decrypted(
            await request(`${castleBase}/film-api/v1.9.1/movie/getVideo?${params.toString()}`),
            securityKey,
          );
          const languageName = dig(track, ['languageName']);
          all.push(...process(body, `[${langName}]`, truthy(languageName) ? audioOf(String(languageName)) : null));
        } catch {
          // one language's video failing must not stop the others
        }
      }
    }

    if (all.length === 0) {
      const body = JSON.stringify({
        mode: '1',
        appMarket: 'GuanWang',
        clientType: '1',
        woolUser: 'false',
        apkSignKey,
        androidVersion: '13',
        movieId,
        episodeId,
        isNewUser: 'true',
        resolution: String(resolution),
        packageName: pkg,
      });
      const raw = await request(
        `${castleBase}/film-api/v2.0.1/movie/getVideo2?clientType=${client}&packageName=${pkg}&channel=${channel}&lang=${lang}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      );
      all = process(decrypted(raw, securityKey), '[Shared]');
    }

    all.sort((a, b) => qualityValue(b.quality) - qualityValue(a.quality));
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const link of all) {
      if (link.url === '' || seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(
        mkStream({
          url: link.url,
          server: link.name,
          quality: link.quality,
          type: link.url.includes('.m3u8') ? 'hls' : link.url.includes('.mpd') ? 'dash' : 'mp4',
          headers: playback,
          audio: link.audio,
        }),
      );
    }
    return out;
  } catch {
    return [];
  }
}

// ── netplayz.js (the Castle app's film API at api.hwnou.com) ──────────────────

async function netplayz(q: FilmQuery): Promise<FoundStream[]> {
  const apiBase = 'https://api.hwnou.com';
  const key = new TextEncoder().encode('fJATm*kgfJT!BgJB');
  const okhttp = 'okhttp/3.2.0';
  const apkSignKey = 'ED0955EB04E67A1D9F3305B95454FED485261475';
  const streamHeaders = {
    'User-Agent': sdkUA,
    Referer: 'https://thugtv.online/',
    Origin: 'https://thugtv.online',
  };

  const hwnou = async (url: string, options: { method?: string; body?: string } = {}): Promise<unknown> => {
    try {
      const res = await fetchRaw(url, {
        method: options.method ?? 'GET',
        body: options.body,
        headers: {
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': okhttp,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
        },
      });
      if (res.status >= 300 || res.body === '') return null;
      const text = decodeUtf8(aesCbcDecrypt(key, key, b64ToBytes(res.body.trim()))).trim();
      // long ids stay strings, as in the JS
      const quoted = text.replace(/(?<=[:[,]\s*)(\d{16,})(?=\s*[,\]])/g, '"$1"');
      return JSON.parse(quoted);
    } catch {
      return null;
    }
  };

  const tv = hasEpisode(q);
  const epNum = tv ? episodeOf(q) : 1;
  const meta = await getTmdbMetadata(q.id, tv);
  const title = meta.title;
  if (title === '') return [];

  try {
    const keyword = encodeURIComponent(title.toLowerCase().replace(/ /g, '+'));
    const search = await hwnou(
      `${apiBase}/film-api/v2.1.2/movie/searchByKeyword?keyword=${keyword}&page=1&size=20&mode=1&secure=0&channel=IndiaA&appMarket=GuanWang&packageName=com.external.castle&clientType=1`,
    );
    const rows = asList(dig(search, ['data', 'rows']));
    // movieType 2 is a film; anything else is a series
    const candidates = rows.filter((row) => (dig(row, ['movieType']) === 2) === !tv);
    if (candidates.length === 0) return [];
    const match =
      candidates.find((row) => String(dig(row, ['title']) ?? '').toLowerCase() === title.toLowerCase()) ?? candidates[0];
    const movieId = dig(match, ['id']);
    if (movieId === null) return [];

    const details = await hwnou(
      `${apiBase}/film-api/v2.1.2/movie?movieId=${String(movieId)}&packageName=com.external.castle&clientType=1`,
    );
    const episodes = asList(dig(details, ['data', 'episodes']));
    if (episodes.length === 0) return [];
    const ep = tv
      ? (episodes.find((entry) => numOrNull(dig(entry, ['number'])) === epNum) ?? episodes[0])
      : episodes[0];
    const all = asList(dig(ep, ['videos']));
    const free = all
      .filter((video) => isRecord(video) && video.premiumProPermission === false)
      .sort((a, b) => (numOrNull(dig(b, ['resolution'])) ?? 0) - (numOrNull(dig(a, ['resolution'])) ?? 0));
    const video = free.length > 0 ? free[0] : all.length > 0 ? all[0] : null;
    if (!isRecord(video)) return [];

    const tracks = asList(dig(ep, ['tracks']));
    const preferred =
      tracks.find((track) => dig(track, ['languageId']) === 1003) ?? (tracks.length > 0 ? tracks[0] : null);
    const languageId = dig(preferred, ['languageId']);

    const body = JSON.stringify({
      appMarket: 'GuanWang',
      woolUser: 'false',
      isp: 'Android',
      useVipCdn: 'false',
      movieId,
      episodeId: dig(ep, ['id']),
      isNewUser: 'true',
      resolution: video.resolution,
      mode: '1',
      clientType: '1',
      apkSignKey,
      androidVersion: '11',
      networkType: 'NETWORK_WIFI',
      packageName: 'com.external.castle',
      languageId,
    });
    const stream = await hwnou(
      `${apiBase}/film-api/v2.0.7/movie/getVideo2?clientType=1&packageName=PKG&channel=CHANNEL&lang=en-US`,
      { method: 'POST', body },
    );
    const videoUrl = dig(stream, ['data', 'videoUrl']);
    if (typeof videoUrl !== 'string' || videoUrl === '') return [];
    const quality = String(
      firstTruthy([dig(video, ['resolutionDescription'])]) ??
        (truthy(dig(video, ['resolution'])) ? `${String(video.resolution)}p` : 'Auto'),
    );
    return [
      mkStream({
        url: videoUrl,
        server: `NetPlayz - ${quality}`,
        quality,
        type: videoUrl.includes('.m3u8') ? 'hls' : videoUrl.includes('.mpd') ? 'dash' : 'mp4',
        headers: streamHeaders,
      }),
    ];
  } catch {
    return [];
  }
}

// ── meowtv.js (a stream ticket, then each server's answer decrypted by enc-dec) ──

async function meowtv(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://api.meowtv.ru';
  const decApi = 'https://enc-dec.app/api';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': ua,
    Origin: 'https://meowtv.ru',
    Referer: 'https://meowtv.ru/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const servers: Array<[string, string, boolean]> = [
    ['acme', 'Acme', false],
    ['dcloud', 'Dcloud', false],
    ['tik', 'TCloud', false],
    ['ipcloud', 'IPcloud', false],
    ['turkce', 'Türkçe', true],
    ['hindi', 'Hindi', false],
    ['english', 'English', false],
  ];
  const tv = hasEpisode(q);

  let ticket: unknown = null;
  try {
    const res = await fetchRaw(`${base}/streams/ticket`, { method: 'POST', headers });
    ticket = res.status < 300 ? JSON.parse(res.body) : null;
  } catch {
    ticket = null;
  }
  const ticketValue = dig(ticket, ['ticket']);
  if (!truthy(ticketValue)) return [];
  const rh = { ...headers, 'X-Stream-Ticket': String(ticketValue) };

  interface MeowItem {
    url: string;
    quality: string;
    type: string;
  }

  const extract = (raw: unknown): MeowItem[] => {
    const out: MeowItem[] = [];
    const typeOf = (given: unknown, url: string): string => {
      const explicit = firstTruthy([given]);
      if (typeof explicit === 'string') return explicit;
      return url.includes('.m3u8') ? 'hls' : 'mp4';
    };
    if (typeof raw === 'string' && /^https?:\/\//.test(raw)) {
      out.push({ url: raw, quality: 'Auto', type: typeOf(null, raw) });
    } else if (typeof dig(raw, ['url']) === 'string') {
      const url = String(dig(raw, ['url']));
      out.push({ url, quality: String(firstTruthy([dig(raw, ['quality'])]) ?? 'Auto'), type: typeOf(dig(raw, ['type']), url) });
    } else if (Array.isArray(dig(raw, ['sources']))) {
      for (const source of asList(dig(raw, ['sources']))) {
        const url = dig(source, ['url']);
        if (typeof url === 'string' && url !== '') {
          out.push({
            url,
            quality: String(firstTruthy([dig(source, ['quality'])]) ?? 'Auto'),
            type: typeOf(dig(source, ['type']), url),
          });
        }
      }
    } else if (truthy(dig(raw, ['stream']))) {
      const stream = dig(raw, ['stream']);
      const url = typeof stream === 'string' ? stream : dig(stream, ['url']);
      if (typeof url === 'string' && url !== '') {
        out.push({ url, quality: String(firstTruthy([dig(stream, ['quality'])]) ?? 'Auto'), type: typeOf(null, url) });
      }
    }
    return out;
  };

  const responses = await Promise.all(
    servers
      .filter(([, , movieOnly]) => !tv || !movieOnly)
      .map(async ([id, label]): Promise<[string, unknown] | null> => {
        try {
          const url = tv
            ? `${base}/streams/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}?s=${id}`
            : `${base}/streams/movie/${q.id}?s=${id}`;
          const res = await fetchRaw(url, { headers: rh });
          if (res.status >= 300) return null;
          const data: unknown = JSON.parse(res.body);
          const dec = await fetchRaw(`${decApi}/dec-meowtv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
            body: JSON.stringify({ data }),
          });
          if (dec.status >= 300) return null;
          const decoded: unknown = JSON.parse(dec.body);
          return dig(decoded, ['status']) === 200 ? [label, dig(decoded, ['result'])] : null;
        } catch {
          return null;
        }
      }),
  );

  const out: FoundStream[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (response === null || !truthy(response[1])) continue;
    const [label, payload] = response;
    for (const item of extract(payload)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(
        mkStream({
          url: item.url,
          server: `MeowTV - ${label}`,
          quality: item.quality,
          type: item.type,
          headers: { Referer: 'https://meowtv.ru/', Origin: 'https://meowtv.ru', 'User-Agent': ua },
        }),
      );
    }
  }
  return out;
}

// ── cinemaarmy.js over plain HTTP ────────────────────────────────────────────

/**
 * The JS goes through node-tls-client to pass as Chrome's TLS handshake; that
 * isn't carried over (there is no TLS fingerprint control here, and it exists
 * only to slip past bot checks). Requests and the XOR-decoded URLs are as is.
 */
async function cinemaarmy(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://cinema.army';
  const apiBase = `${base}/api`;
  const hmacKey = 'a2cfc9eaa2a3690b5d4f6b5f958dbdeae52a097283d375bd253ee7c7062524f5';
  const xorKey = 'f16a6b92fcd6eed3e9476297f893f2505c32f79bc6efef9b6c95496aa5914548';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const servers: Array<[string, string]> = [
    ['cookiebakers', 'CookieBakers'],
    ['tcloud', 'TCloud'],
    ['ipcloud', 'IPCloud'],
    ['dcloud', 'DCloud'],
    ['tidb', 'TIDB'],
  ];
  const tv = hasEpisode(q);
  const minute = Math.floor(Date.now() / 1000 / 60);
  const token = CryptoJS.HmacSHA256(`${q.id}:${minute}`, hmacKey).toString(CryptoJS.enc.Hex);
  const headers = {
    'User-Agent': ua,
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Referer: tv
      ? `${base}/watch?id=${q.id}&type=tv&season=${seasonOf(q)}&episode=${episodeOf(q)}`
      : `${base}/watch?id=${q.id}&type=movie`,
    Origin: base,
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Priority: 'u=1, i',
    'X-Stream-Token': token,
  };

  const decryptUrl = (encoded: string): string => {
    if (encoded.startsWith('http://') || encoded.startsWith('https://')) return encoded;
    try {
      const bytes = b64ToBytes(encoded);
      let out = '';
      for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode((bytes[i] ?? 0) ^ xorKey.charCodeAt(i % xorKey.length));
      return out;
    } catch {
      return encoded;
    }
  };

  const results = await Promise.all(
    servers.map(async ([key, label]): Promise<FoundStream | null> => {
      try {
        const path = tv ? `/${key}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}` : `/${key}/movie/${q.id}`;
        const res = await fetchRaw(`${apiBase}${path}`, { method: 'POST', headers, body: '' });
        if (res.status !== 200) return null;
        const encoded = dig(JSON.parse(res.body), ['stream', 'url']);
        if (!truthy(encoded)) return null;
        const url = decryptUrl(String(encoded));
        if (!/^https?:\/\//.test(url)) return null;
        return mkStream({
          url,
          headers: { 'User-Agent': ua, Referer: `${base}/`, Origin: base },
          server: `CinemaArmy (${label})`,
          quality: '1080p',
          type: url.includes('.m3u8') ? 'hls' : 'mp4',
        });
      } catch {
        return null;
      }
    }),
  );
  return results.filter((item): item is FoundStream => item !== null);
}

// ── vidzee.js, without its encrypted fallback ───────────────────────────────

/**
 * The direct answer is ported as is. The encrypted fallback is not: it is
 * decrypted by a WebAssembly module the JS ships, and this runtime has no
 * WebAssembly payload to run. That fallback is the only thing lost here.
 */
async function vidzee(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://core.vidzee.wtf';
  const player = 'https://player.vidzee.wtf';
  const services = ['dcloud', 'ipcloud', 'tik', 'v6:Hindi', '3AHindi'];
  const headers = {
    'User-Agent': sdkUA,
    Accept: 'application/json, text/plain, */*',
    Referer: `${player}/`,
    Origin: player,
  };
  const movie = !hasEpisode(q);

  const results = await Promise.all(
    services.map(async (service): Promise<FoundStream | null> => {
      const url = movie
        ? `${base}/streams/movie/${q.id}?s=${service}`
        : `${base}/streams/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}?s=${service}`;
      let res: unknown;
      try {
        res = await fetchJson(url, { headers, timeoutMs: 6000 });
      } catch {
        return null;
      }
      const streamUrl = dig(res, ['url']);
      if (typeof streamUrl !== 'string' || streamUrl === '') return null;
      const extra = dig(res, ['headers']);
      const merged: Record<string, string> = {
        'User-Agent': sdkUA,
        Referer: `${player}/`,
        Origin: player,
      };
      if (isRecord(extra)) {
        for (const [key, value] of Object.entries(extra)) merged[key] = String(value);
      }
      return mkStream({
        url: streamUrl,
        server: `VidZee (${service})`,
        quality: String(firstTruthy([dig(res, ['language'])]) ?? 'Auto'),
        type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
        headers: merged,
        audio: audioOf(dig(res, ['language'])) ?? (service.includes('Hindi') ? 'Hindi' : null),
      });
    }),
  );
  return results.filter((item): item is FoundStream => item !== null);
}

// ── yastream.js ──────────────────────────────────────────────────────────────

/** Stremio-style `behaviorHints.proxyHeaders.request`, which these answers carry. */
function proxyHeaders(item: unknown): Record<string, string> {
  const headers = dig(item, ['behaviorHints', 'proxyHeaders', 'request']);
  if (!isRecord(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  return out;
}

async function yastream(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://yastream.tamthai.de';
  const path = hasEpisode(q)
    ? `/stream/series/tmdb:${q.id}:${seasonOf(q)}:${episodeOf(q)}.json`
    : `/stream/movie/tmdb:${q.id}.json`;
  let res: unknown;
  try {
    res = await fetchJson(`${base}${path}`);
  } catch {
    return [];
  }
  const streams = dig(res, ['streams']);
  if (!Array.isArray(streams) || streams.length === 0) return [];
  const out: FoundStream[] = [];
  for (const item of streams) {
    const url = dig(item, ['url']);
    if (!truthy(url) || typeof url !== 'string') continue;
    const name = dig(item, ['name']);
    out.push(
      mkStream({
        url,
        server: `YaStream - ${truthy(name) ? String(name).replace(/\n/g, ' ') : 'Server'}`,
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        headers: proxyHeaders(item),
      }),
    );
  }
  return out;
}

// ── lookmovie.js ─────────────────────────────────────────────────────────────

async function lookmovie(q: FilmQuery): Promise<FoundStream[]> {
  const domains = ['https://www.lookmovie2.to', 'https://lookmovie2.to', 'https://lookmovie.foundation'];
  const headersBase = { 'User-Agent': sdkUA, 'Accept-Language': 'en-US,en;q=0.9' };
  const storageRe = /window\[['"](?:movie|show)_storage['"]\]\s*=\s*\{([^}]+)\}/s;
  const seasonsRe = /seasons\s*:\s*(\[[\s\S]+?\])\s*[,}]/;
  const tv = hasEpisode(q);
  const typeStr = tv ? 'shows' : 'movies';
  const seasonText = String(q.season ?? '');
  const episodeText = String(q.episode ?? '');

  /**
   * The episode id, in the three places the site has kept it: the storage
   * object's season list, an `id_episode` near a matching season/episode pair,
   * or the player's `data-` attributes.
   */
  const episodeIdFast = (html: string): string | null => {
    const storage = storageRe.exec(html);
    if (storage) {
      const seasonsMatch = seasonsRe.exec(storage[1] ?? '');
      if (seasonsMatch) {
        try {
          const seasons = asList(JSON.parse(seasonsMatch[1] ?? '[]'));
          const season = seasons.find(
            (entry) => String(dig(entry, ['season']) ?? dig(entry, ['meta', 'season'])) === seasonText,
          );
          if (season !== undefined) {
            const episodes = dig(season, ['episodes']);
            let episode: unknown = null;
            if (Array.isArray(episodes)) {
              episode = episodes.find((entry) => String(dig(entry, ['episode'])) === episodeText) ?? null;
            } else if (isRecord(episodes)) {
              const byKey = episodes[episodeText];
              episode =
                byKey ??
                Object.values(episodes).find((entry) => String(dig(entry, ['episode'])) === episodeText) ??
                null;
            }
            if (episode !== null && episode !== undefined) {
              const id = firstTruthy([dig(episode, ['id_episode']), dig(episode, ['id'])]);
              if (id !== null) return String(id);
            }
          }
        } catch {
          // fall through to the regex scans below
        }
      }
    }

    const splitRe = /id_episode['"]?\s*[:=]\s*['"]?(\d+)['"]?/gi;
    const matches = [...html.matchAll(splitRe)];
    for (let i = 0; i < matches.length; i += 1) {
      const current = matches[i];
      const start = current.index ?? 0;
      const end = start + (current[0]?.length ?? 0);
      const previous = matches[i - 1];
      const previousEnd = previous === undefined ? 0 : (previous.index ?? 0) + (previous[0]?.length ?? 0);
      const before = html.slice(previousEnd, start);
      const next = matches[i + 1];
      const after = html.slice(end, next === undefined ? html.length : (next.index ?? html.length));
      const context =
        (before.length > 300 ? before.slice(before.length - 300) : before) +
        (after.length > 300 ? after.slice(0, 300) : after);
      const nearEpisode = new RegExp(`['"]?episode['"]?\\s*[:=]\\s*['"]?${episodeText}['"]?`, 'i').test(context);
      const nearSeason = new RegExp(`['"]?season['"]?\\s*[:=]\\s*['"]?${seasonText}['"]?`, 'i').test(context);
      if (nearEpisode && nearSeason) return current[1] ?? null;
    }

    const attributeMatch =
      new RegExp(`data-season=["']${seasonText}["'][^>]*?data-episode=["']${episodeText}["'][^>]*?data-id=["'](\\d+)["']`, 'i').exec(
        html,
      ) ??
      new RegExp(`data-episode=["']${episodeText}["'][^>]*?data-season=["']${seasonText}["'][^>]*?data-id=["'](\\d+)["']`, 'i').exec(
        html,
      );
    return attributeMatch?.[1] ?? null;
  };

  try {
    // The SDK only runs this with your own TMDB key; the app's key works the same
    const tmdb: unknown = await fetchJson(
      `https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${q.id}?api_key=${getTmdbApiKey()}`,
      { timeoutMs: 3000 },
    );
    const title = asString(firstTruthy([dig(tmdb, ['title']), dig(tmdb, ['name'])])) ?? '';
    const date = String(firstTruthy([dig(tmdb, ['first_air_date']), dig(tmdb, ['release_date'])]) ?? '');
    const year = date.length >= 4 ? date.slice(0, 4) : date;
    if (title === '') return [];

    let match: Record<string, unknown> | null = null;
    let base: string | null = null;
    for (const candidate of domains) {
      try {
        const headers = {
          ...headersBase,
          Accept: 'application/json',
          Referer: `${candidate}/`,
          'X-Requested-With': 'XMLHttpRequest',
        };
        const data = await fetchJson(
          `${candidate}/api/v1/${typeStr}/do-search/?q=${encodeURIComponent(title)}`,
          { headers, timeoutMs: 4000 },
        );
        const results = dig(data, ['result']);
        if (Array.isArray(results) && results.length > 0) {
          const found =
            results.find((entry) => String(dig(entry, ['year'])) === year) ??
            results.find((entry) => String(dig(entry, ['title']) ?? '').toLowerCase() === title.toLowerCase()) ??
            results[0];
          if (isRecord(found)) {
            match = found;
            base = candidate;
            break;
          }
        }
      } catch {
        // try the next mirror
      }
    }
    if (match === null || base === null || !truthy(match.slug)) return [];

    const headers = { ...headersBase, Accept: 'text/html', Referer: `${base}/` };
    const html = await fetchText(`${base}/${typeStr}/play/${String(match.slug)}`, { headers, timeoutMs: 8000 });
    const storage = storageRe.exec(html);
    if (storage === null) return [];
    const storageBody = storage[1] ?? '';
    const hash = /hash\s*:\s*['"]([^'"]+)['"]/.exec(storageBody);
    const expires = /expires\s*:\s*(\d+)/.exec(storageBody);
    if (hash === null || expires === null) return [];

    const streamId = tv
      ? episodeIdFast(html)
      : asString(firstTruthy([match.id_movie, match.id]));
    if (streamId === null) return [];

    const access = {
      ...headersBase,
      Accept: 'application/json',
      Referer: `${base}/`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const kind = tv ? 'episode' : 'movie';
    const data = await fetchJson(
      `${base}/api/v1/security/${kind}-access?id_${kind}=${streamId}&hash=${hash[1] ?? ''}&expires=${expires[1] ?? ''}`,
      { headers: access, timeoutMs: 8000 },
    );
    const streams =
      dig(data, ['streams']) ?? dig(data, ['result', 'streams']) ?? dig(data, ['data', 'streams']) ?? data;
    if (!isRecord(streams)) return [];

    const out: FoundStream[] = [];
    for (const [quality, url] of Object.entries(streams)) {
      if (typeof url === 'string' && url.includes('.m3u8')) {
        out.push(mkStream({ url, server: `LookMovie - ${quality}`, quality, type: 'hls', headers: access }));
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Ports of the remaining VyseTV scrapers ──────────────────────────────────
// All of the functions below come from scrapers.dart (and common.dart where
// noted). They keep that file's request order, headers and extraction logic;
// only the plumbing is TypeScript. Every request still goes through the local
// fetchText / fetchJson / fetchRaw helpers above.

/** Dart scrapers.dart:_qWeight — a quality's numeric weight, with 4k = 2160. */
function weightOfQuality(quality: string): number {
  const text = quality.toLowerCase();
  if (text.includes('4k') || text.includes('2160')) return 2160;
  const match = /\d+/.exec(text);
  return match ? Number(match[0]) : 0;
}

/** Resolve a scraper's relative link against its page, keeping absolute ones. */
function absoluteUrl(value: string, base: string): string {
  if (value === '') return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  try {
    return new URL(value, base).toString();
  } catch {
    return value.startsWith('/') ? `${base}${value}` : `${base}/${value}`;
  }
}

/** Final guard: no scraper may hand the player a relative or empty URL. */
function onlyAbsolute(streams: FoundStream[]): FoundStream[] {
  return streams.filter((stream) => /^https?:\/\//i.test(stream.url));
}

/** cinebros.js: pull every balanced {...} object out of a concatenated stream. */
function bracedObjects(text: string): unknown[] {
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)) as unknown);
        } catch {
          // one broken object must not stop the others
        }
        start = -1;
      }
    }
  }
  return items;
}

// Ported from scrapers.dart:cno (Vyla SDK cno.js).
async function cno(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://cno.to';
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: `${base}/`,
    Origin: base,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  };
  const play = { Referer: `${base}/`, Origin: base };

  const one = async (n: number): Promise<FoundStream | null> => {
    const url = hasEpisode(q)
      ? `${base}/api/s/${n}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
      : `${base}/api/s/${n}/movie/${q.id}?v=3`;
    try {
      const raw = await fetchText(url, { headers });
      if (raw === '' || raw.includes('"error":')) return null;
      if (raw.includes('#EXTM3U')) {
        const lines = raw.split('\n').map((line) => line.trim());
        let streamUrl: string | null = null;
        let quality = 'Auto';
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
          const match = /RESOLUTION=(\d+x\d+)/.exec(line);
          if (match) quality = match[1] ?? quality;
          const next = i + 1 < lines.length ? (lines[i + 1] ?? '') : '';
          if (next !== '' && !next.startsWith('#')) {
            streamUrl = next;
            break;
          }
        }
        streamUrl ??= lines.find((line) => line !== '' && !line.startsWith('#')) ?? null;
        if (streamUrl !== null) {
          const full = absoluteUrl(streamUrl, base);
          if (full !== '') {
            return mkStream({
              url: full,
              server: `Cno - Server ${n} (${quality})`,
              quality,
              type: 'hls',
              headers: play,
            });
          }
        }
      }
      try {
        const js: unknown = JSON.parse(raw);
        const u = isRecord(js) ? firstTruthy([js.url, js.file, js.stream]) : null;
        if (typeof u === 'string' && u.startsWith('http')) {
          const qy = String(firstTruthy([isRecord(js) ? js.quality : null]) ?? 'Auto');
          return mkStream({
            url: u,
            server: `Cno - Server ${n} (${qy})`,
            quality: qy,
            type: u.includes('.m3u8') ? 'hls' : 'mp4',
            headers: play,
          });
        }
      } catch {
        // not JSON — the HLS branch above already had its chance
      }
    } catch {
      // one dead server must not stop the other 49
    }
    return null;
  };

  const numbers = Array.from({ length: 50 }, (_, i) => i + 1);
  const results = await Promise.all(numbers.map(one));
  return onlyAbsolute(results.filter((result): result is FoundStream => result !== null));
}

// Ported from common.dart:scrapeVidcoreFamily (helpers.js scrapeVidcoreFamily;
// used by scrapers.dart:vidcore and scrapers.dart:vidup).
async function scrapeVidcoreFamily(
  q: FilmQuery,
  baseUrl: string,
  apiName: string,
  serverLabel: string,
): Promise<FoundStream[]> {
  const targetUrl = hasEpisode(q)
    ? `${baseUrl}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}/`
    : `${baseUrl}/movie/${q.id}`;
  const ua = getUA();
  const baseHeaders = {
    'User-Agent': ua,
    Referer: `${baseUrl}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  try {
    const page = await fetchRaw(targetUrl, { headers: { 'User-Agent': ua }, timeoutMs: 10000 });
    if (page.status >= 300) return [];
    // Dart's r'\\"(?:en|token)\\":\\"(.*?)\\"' — one literal backslash + quote.
    const match = /\\"(?:en|token)\\":\\"(.*?)\\"/.exec(page.body);
    if (match === null || (match[1] ?? '') === '') return [];
    const enToken = match[1] ?? '';

    const s1 = await fetchJson(
      `https://enc-dec.app/api/enc-${apiName}?text=${encodeURIComponent(enToken)}&stage=1`,
      { timeoutMs: 8000 },
    );
    if (dig(s1, ['status']) !== 200 || !truthy(dig(s1, ['result', 'stage1']))) return [];
    const token1 = String(dig(s1, ['result', 'token']));
    const stage1Url = String(dig(s1, ['result', 'stage1']));

    const post1 = await fetchRaw(stage1Url, {
      method: 'POST',
      headers: { ...baseHeaders, 'X-CSRF-Token': token1 },
      timeoutMs: 10000,
    });
    if (post1.status >= 300) return [];

    const s2 = await fetchJson(
      `https://enc-dec.app/api/enc-${apiName}?text=${encodeURIComponent(post1.body)}&stage=2`,
      { timeoutMs: 8000 },
    );
    if (dig(s2, ['status']) !== 200 || !truthy(dig(s2, ['result', 'servers']))) return [];
    const serversUrl = String(dig(s2, ['result', 'servers']));
    const streamBaseUrl = String(dig(s2, ['result', 'stream']));
    const currentHeaders = {
      ...baseHeaders,
      'X-CSRF-Token': String(dig(s2, ['result', 'token'])),
    };

    const serversRes = await fetchRaw(serversUrl, {
      method: 'POST',
      headers: currentHeaders,
      timeoutMs: 10000,
    });
    if (serversRes.status >= 300) return [];
    const dec = await fetchJson(`https://enc-dec.app/api/dec-${apiName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: serversRes.body }),
      timeoutMs: 8000,
    });
    if (dig(dec, ['status']) !== 200 || !Array.isArray(dig(dec, ['result']))) return [];

    const out: FoundStream[] = [];
    for (const server of asList(dig(dec, ['result']))) {
      if (!truthy(dig(server, ['data']))) continue;
      try {
        const enc = await fetchRaw(`${streamBaseUrl}/${String(dig(server, ['data']))}`, {
          method: 'POST',
          headers: currentHeaders,
          timeoutMs: 8000,
        });
        if (enc.status >= 300) continue;
        const d = await fetchJson(`https://enc-dec.app/api/dec-${apiName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: enc.body }),
          timeoutMs: 8000,
        });
        if (dig(d, ['status']) !== 200 || !truthy(dig(d, ['result']))) continue;
        const r = dig(d, ['result']);
        const url = typeof r === 'string' ? r : firstTruthy([dig(r, ['url']), dig(r, ['file'])]);
        if (typeof url === 'string' && url.startsWith('http')) {
          const name = firstTruthy([dig(server, ['name']), dig(server, ['title'])]);
          out.push(
            mkStream({
              url,
              server: `${serverLabel} - ${String(name ?? 'Server')}`,
              type: url.includes('.m3u8') ? 'hls' : 'mp4',
              headers: { 'User-Agent': ua, Referer: `${baseUrl}/` },
            }),
          );
        }
      } catch {
        // one bad server must not stop the others
      }
    }
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:vidcore (Vyla SDK vidcore.js).
async function vidcore(q: FilmQuery): Promise<FoundStream[]> {
  return scrapeVidcoreFamily(q, 'https://vidcore.io', 'vidcore', 'VidCore');
}

// Ported from scrapers.dart:vidup (Vyla SDK vidup.js).
async function vidup(q: FilmQuery): Promise<FoundStream[]> {
  return scrapeVidcoreFamily(q, 'https://vidup.to', 'vidup', 'VidUp');
}

// Ported from scrapers.dart:cinebros (Vyla SDK cinebros.js).
async function cinebros(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://cinebros.net';
  const headers = {
    'User-Agent': sdkUA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: base,
    Referer: `${base}/`,
  };
  const playback = { 'User-Agent': sdkUA, Referer: `${base}/`, Origin: base };
  const score = (stream: FoundStream): number => {
    let n = 0;
    const match = /\d+/.exec(stream.quality);
    if (match) n += Number(match[0]);
    if (stream.url.includes('/stream/')) n += 10000;
    if (stream.url.includes('blob=')) n -= 5000;
    return n;
  };

  const tv = hasEpisode(q);
  const meta = await getTmdbMetadata(q.id, tv);
  const runtime = meta.runtime !== 0 ? String(meta.runtime) : tv ? '24' : '90';
  const params = new URLSearchParams();
  params.append('tmdbId', q.id);
  params.append('type', tv ? 'tv' : 'movie');
  params.append('title', meta.title !== '' ? meta.title : q.id);
  if (tv) {
    params.append('seasonId', String(seasonOf(q)));
    params.append('episodeId', String(episodeOf(q)));
  }
  if (meta.year !== null) params.append('year', String(meta.year));
  params.append('runtime', runtime);
  const referer = tv
    ? `${base}/watch/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
    : `${base}/watch/movie/${q.id}`;
  try {
    const res = await fetchRaw(`${base}/api/streams?${params.toString()}`, {
      headers: { ...headers, Referer: referer },
      timeoutMs: 25000,
    });
    if (res.status >= 300) return [];
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const item of bracedObjects(res.body)) {
      const u = dig(item, ['url']);
      if (typeof u !== 'string' || !u.startsWith('http') || seen.has(u)) continue;
      seen.add(u);
      let quality = 'Auto';
      if (truthy(dig(item, ['quality']))) {
        const raw = String(dig(item, ['quality'])).trim();
        quality = /^\d+$/.test(raw) ? `${raw}p` : raw;
      }
      const label = truthy(dig(item, ['name']))
        ? `CineBros - ${String(dig(item, ['name']))}`
        : `CineBros (${quality})`;
      const type =
        asString(firstTruthy([dig(item, ['type'])])) ??
        (u.includes('.m3u8') || u.includes('/stream/') ? 'hls' : u.includes('.mpd') ? 'dash' : 'mp4');
      out.push(mkStream({ url: u, server: label, quality, type, headers: playback }));
    }
    out.sort((a, b) => score(b) - score(a));
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:thugtv (Vyla SDK thugtv.js).
async function thugtv(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://thugtv.online';
  const apiBase = 'https://api.thugtv.online/api';
  const path = hasEpisode(q)
    ? `/stream/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
    : `/stream/movie/${q.id}`;
  const headers = {
    Accept: 'application/json',
    Referer: `${base}/`,
    Origin: base,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  };
  const play = { Referer: `${base}/`, Origin: base };
  let initial: unknown = null;
  try {
    initial = await fetchJson(`${apiBase}${path}`, { headers });
  } catch {
    return [];
  }
  const sources = dig(initial, ['sources']);
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const out: FoundStream[] = [];
  for (const src of sources) {
    if (!isRecord(src) || dig(src, ['type']) === 'embed') continue;
    const u = dig(src, ['url']);
    if (typeof u === 'string' && u.startsWith('http')) {
      out.push(
        mkStream({
          url: u,
          server: `ThugTV - ${String(firstTruthy([dig(src, ['name']), dig(src, ['label'])]) ?? 'Direct')} (${String(firstTruthy([dig(src, ['quality'])]) ?? 'Auto')})`,
          quality: String(firstTruthy([dig(src, ['quality'])]) ?? 'Auto'),
          type: u.includes('.m3u8') ? 'hls' : 'mp4',
          headers: play,
        }),
      );
      continue;
    }
    const rp = dig(src, ['resolvePath']);
    if (typeof rp === 'string' && rp !== '') {
      const clean = rp.startsWith('/') ? rp : `/${rp}`;
      try {
        const resolved = await fetchJson(`${base}/api${clean}`, { headers });
        const direct = dig(resolved, ['source', 'url']);
        if (typeof direct === 'string' && direct.startsWith('http')) {
          const s = dig(resolved, ['source']);
          out.push(
            mkStream({
              url: direct,
              server: `ThugTV - ${String(firstTruthy([dig(s, ['name']), dig(s, ['label']), dig(src, ['name'])]) ?? 'Direct')}`,
              quality: String(firstTruthy([dig(s, ['quality']), dig(src, ['quality'])]) ?? 'Auto'),
              type: direct.includes('.m3u8') ? 'hls' : 'mp4',
              headers: play,
            }),
          );
        }
      } catch {
        // a dead resolve path must not stop the other sources
      }
    }
  }
  return onlyAbsolute(out);
}

// Ported from scrapers.dart:framextv (Vyla SDK framextv.js).
async function framextv(q: FilmQuery): Promise<FoundStream[]> {
  const framexBase = 'https://api.framextv.cc';
  const streamOsBase = 'https://api.streamos.top';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const framexHeaders = {
    'User-Agent': ua,
    Referer: 'https://framextv.cc/',
    Origin: 'https://framextv.cc',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const streamOsHeaders = {
    'User-Agent': ua,
    Referer: 'https://streamos.top/',
    Origin: 'https://streamos.top',
  };
  const servers = ['auto', 'miami', 'boise', 'vegas', 'reno', 'oakland', 'seattle', 'phoenix'];
  const tv = hasEpisode(q);
  const fq = tv
    ? `type=tv&id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(q)}&codecs=hevc`
    : `type=movie&id=${q.id}&codecs=hevc`;
  const sq = tv
    ? `id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(q)}&kind=tv`
    : `id=${q.id}&kind=movie`;
  const framexUrls = [
    `${framexBase}/api/stream?${fq}`,
    `${framexBase}/api/stream?${fq}&provider=sparky`,
    `${framexBase}/api/stream?${fq}&provider=titan`,
  ];
  const fr = await Promise.all(
    framexUrls.map(async (url): Promise<unknown> => {
      try {
        const res = await fetchRaw(url, { headers: framexHeaders, timeoutMs: 25000 });
        if (res.status >= 300) return null;
        return JSON.parse(res.body) as unknown;
      } catch {
        return null;
      }
    }),
  );
  const sr = await Promise.all(
    servers.map(async (server): Promise<FoundStream | null> => {
      const url = `${streamOsBase}/api/relay/hls?${sq}${server === 'auto' ? '' : `&server=${server}`}`;
      try {
        const res = await fetchRaw(url, { method: 'HEAD', headers: streamOsHeaders, timeoutMs: 25000 });
        if (res.status < 300) {
          return mkStream({
            url,
            server: `StreamOS - ${server.toUpperCase()}`,
            quality: '1080p',
            type: 'hls',
            headers: streamOsHeaders,
          });
        }
      } catch {
        // one relay being down must not stop the others
      }
      return null;
    }),
  );
  const out: FoundStream[] = [];
  const seen = new Set<string>();
  for (const data of fr) {
    if (!truthy(dig(data, ['success'])) || !Array.isArray(dig(data, ['sources']))) continue;
    for (const src of asList(dig(data, ['sources']))) {
      const u = dig(src, ['url']);
      if (typeof u !== 'string' || u === '' || seen.has(u)) continue;
      seen.add(u);
      out.push(
        mkStream({
          url: u,
          server: `FrameX - ${String(firstTruthy([dig(src, ['server']), dig(data, ['provider'])]) ?? 'Direct')}`,
          quality: String(firstTruthy([dig(src, ['quality'])]) ?? 'Auto'),
          type: asString(firstTruthy([dig(src, ['type'])])) ?? (u.includes('.m3u8') ? 'hls' : 'mp4'),
          headers: { 'User-Agent': ua, Referer: 'https://framextv.cc/', Origin: 'https://framextv.cc' },
        }),
      );
    }
  }
  for (const stream of sr) {
    if (stream !== null && seen.has(stream.url)) continue;
    if (stream !== null) {
      seen.add(stream.url);
      out.push(stream);
    }
  }
  return onlyAbsolute(out);
}

// Ported from scrapers.dart:lmscript (Vyla SDK lmscript.js, films only).
async function lmscript(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://lmscript.xyz';
  const referer = 'https://lookmovie2.to/';
  if (hasEpisode(q)) return [];
  try {
    const meta = await getTmdbMetadata(q.id, false);
    if (meta.titles.length === 0) return [];
    let movie: Record<string, unknown> | null = null;
    for (const title of meta.titles) {
      let data: unknown = null;
      try {
        data = await fetchJson(`${base}/v1/movies?filters[q]=${encodeURIComponent(title)}&expand=streams`);
      } catch {
        continue;
      }
      const items = dig(data, ['items']);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isRecord(item)) continue;
        const itemTitle = item.title;
        if (
          String(dig(item, ['tmdb_prefix'])) === q.id ||
          String(dig(item, ['tmdb_id'])) === q.id ||
          (typeof itemTitle === 'string' && itemTitle.toLowerCase() === title.toLowerCase())
        ) {
          movie = item;
          break;
        }
      }
      if (movie !== null) break;
    }
    if (movie === null) return [];
    const streams = isRecord(movie.streams) ? movie.streams : {};
    const order = ['1080p', '720p', '480p', '360p'];
    const keys = Object.keys(streams).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
    const out = keys.map((key) =>
      mkStream({
        url: String(streams[key]),
        quality: key,
        server: `LookMovie - ${key}`,
        type: String(streams[key]).includes('.m3u8') ? 'hls' : 'mp4',
        headers: { Referer: referer, 'User-Agent': sdkUA },
      }),
    );
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:vidqueen (Vyla SDK vidqueen.js).
async function vidqueen(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://api.vidqueen.st';
  const origin = 'https://vidqueen.st';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': ua,
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: origin,
    Referer: `${origin}/`,
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'sec-ch-ua': '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  const playback = { 'User-Agent': ua, Origin: origin, Referer: `${origin}/` };
  const servers: Array<[string, string]> = [
    ['Bloodstone', 'sources=s1&hevc=1'],
    ['Garnet', 'sources=s2&hevc=1&vh=1'],
    ['Ruby', 'sources=s3&hevc=1&vh=1'],
    ['Obsidian', 'sources=s4&sw=1'],
    ['Jet', 'sources=s5&hevc=1&vh=1'],
  ];
  const prefix = hasEpisode(q)
    ? `tv?id=${q.id}&season=${seasonOf(q)}&episode=${episodeOf(q)}&mode=json`
    : `movie?id=${q.id}&mode=json`;
  const responses = await Promise.all(
    servers.map(async (server): Promise<[string, unknown] | null> => {
      try {
        const res = await fetchRaw(`${base}/${prefix}&${server[1]}`, { headers, timeoutMs: 10000 });
        if (res.status >= 300) return null;
        const data: unknown = JSON.parse(res.body);
        return truthy(dig(data, ['source'])) ? [server[0], data] : null;
      } catch {
        return null;
      }
    }),
  );
  const out: FoundStream[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (response === null) continue;
    const [fallback, payload] = response;
    const src = dig(payload, ['source']);
    const label = String(firstTruthy([dig(src, ['label'])]) ?? fallback);
    const manifest = dig(src, ['manifest']);
    if (typeof manifest === 'string' && manifest !== '') {
      const lines = manifest.split('\n').map((line) => line.trim());
      for (let i = 0; i < lines.length; i += 1) {
        if (!(lines[i] ?? '').startsWith('#EXT-X-STREAM-INF')) continue;
        const u = i + 1 < lines.length ? (lines[i + 1] ?? '') : '';
        if (u.startsWith('http') && !seen.has(u)) {
          seen.add(u);
          const match = /RESOLUTION=\d+x(\d+)/i.exec(lines[i] ?? '');
          out.push(
            mkStream({
              url: u,
              server: `Vidqueen - ${label}`,
              quality: match ? `${match[1]}p` : '1080p',
              type: 'hls',
              headers: playback,
            }),
          );
        }
      }
    }
    const qs = dig(src, ['qualities']);
    const hasMp4 = Array.isArray(qs) && qs.some((x) => dig(x, ['type']) === 'mp4');
    if (hasMp4) {
      for (const x of asList(qs)) {
        const u = dig(x, ['url']);
        if (typeof u !== 'string' || u === '' || seen.has(u)) continue;
        seen.add(u);
        out.push(
          mkStream({
            url: u,
            server: `Vidqueen - ${label}`,
            quality: normQuality(dig(x, ['quality'])),
            type: 'mp4',
            headers: playback,
          }),
        );
      }
    }
    const u = dig(src, ['url']);
    if (truthy(u) && !hasMp4 && !truthy(manifest)) {
      const url = String(u);
      if (!seen.has(url)) {
        seen.add(url);
        let raw = '1080p';
        if (truthy(dig(src, ['h']))) raw = `${String(dig(src, ['h']))}p`;
        else if (truthy(dig(qs, [0, 'quality'])) && dig(qs, [0, 'quality']) !== 'Auto') {
          raw = String(dig(qs, [0, 'quality']));
        }
        out.push(
          mkStream({
            url,
            server: `Vidqueen - ${label}`,
            quality: normQuality(raw),
            type: url.includes('.m3u8') ? 'hls' : 'mp4',
            headers: playback,
          }),
        );
      }
    }
  }
  return onlyAbsolute(out);
}

// Ported from scrapers.dart:watchout (Vyla SDK watchout.js).
async function watchout(q: FilmQuery): Promise<FoundStream[]> {
  const api = 'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/';
  const headers = { Origin: 'https://vidout.pages.dev', Referer: 'https://vidout.pages.dev' };
  const isHls = (url: string): boolean =>
    url.includes('.m3u8') || url.includes('.txt') || url.includes('master') || !url.includes('.mp4');
  let streamUrl: string | null = null;
  if (!hasEpisode(q)) {
    let data = '';
    try {
      data = await fetchText(`${api}movie/${q.id}`);
    } catch {
      data = '';
    }
    if (!data.includes('://')) return [];
    streamUrl = data.trim();
  } else {
    let data: unknown = null;
    try {
      data = await fetchJson(`${api}tv/${q.id}/S${seasonOf(q)}.json`);
    } catch {
      data = null;
    }
    if (data === null) {
      try {
        data = await fetchJson(`${api}tv/${q.id}/s${seasonOf(q)}.json`);
      } catch {
        data = null;
      }
    }
    const value = dig(data, [String(episodeOf(q))]);
    streamUrl = truthy(value) ? String(value) : null;
  }
  if (streamUrl === null) return [];
  return onlyAbsolute([
    mkStream({
      url: streamUrl,
      server: 'Watchout - Direct',
      type: isHls(streamUrl) ? 'hls' : 'mp4',
      headers,
    }),
  ]);
}

// Ported from scrapers.dart:vidspark (Vyla SDK vidspark.js).
async function vidspark(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidspark.to';
  const playerKey = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
  const playback = { 'User-Agent': sdkUA, Referer: `${base}/`, Origin: base };
  const tv = hasEpisode(q);
  const target = tv
    ? `${base}/api/vidora/v1/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
    : `${base}/api/vidora/v1/movie/${q.id}`;
  const referer = tv ? `${base}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}` : `${base}/movie/${q.id}`;
  const headers = {
    'User-Agent': sdkUA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    Origin: base,
    'x-player-key': playerKey,
  };
  const variants = async (master: string): Promise<Array<{ url: string; quality: string }> | null> => {
    try {
      const text = await fetchText(master, { headers: playback, timeoutMs: 5000 });
      if (!text.includes('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) return null;
      const baseUrl = master.slice(0, master.lastIndexOf('/') + 1);
      const lines = text.split('\n').map((line) => line.trim());
      const out: Array<{ url: string; quality: string }> = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (!(lines[i] ?? '').startsWith('#EXT-X-STREAM-INF:')) continue;
        const match = /RESOLUTION=\d+x(\d+)/i.exec(lines[i] ?? '');
        const next = i + 1 < lines.length ? (lines[i + 1] ?? '') : '';
        if (next !== '' && !next.startsWith('#')) {
          out.push({
            url: next.startsWith('http') ? next : `${baseUrl}${next}`,
            quality: match ? `${match[1]}p` : 'Auto',
          });
        }
      }
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
  try {
    const data = await fetchJson(target, { headers, timeoutMs: 25000 });
    const sources = dig(data, ['sources']);
    if (!truthy(dig(data, ['result'])) || !Array.isArray(sources) || sources.length === 0) return [];
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const item of sources) {
      const u = dig(item, ['url']);
      if (typeof u !== 'string' || !u.startsWith('http')) continue;
      const src = dig(item, ['source']);
      const label =
        typeof src === 'string' && src !== '' ? `${src[0]?.toUpperCase()}${src.slice(1)}` : 'Direct';
      if (u.includes('.m3u8')) {
        for (const variant of (await variants(u)) ?? []) {
          if (seen.has(variant.url)) continue;
          seen.add(variant.url);
          out.push(
            mkStream({
              url: variant.url,
              server: `VidSpark - ${label} (${variant.quality})`,
              quality: variant.quality,
              type: 'hls',
              headers: playback,
            }),
          );
        }
      }
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(
        mkStream({
          url: u,
          server: `VidSpark - ${label}`,
          type: u.includes('.m3u8') ? 'hls' : u.includes('.mpd') ? 'dash' : 'mp4',
          headers: playback,
        }),
      );
    }
    out.sort((a, b) => weightOfQuality(b.quality) - weightOfQuality(a.quality));
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:willow (Vyla SDK willow.js).
async function willow(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://willowmovies.com';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': ua,
    Referer: `${base}/`,
    Origin: base,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const playback = { 'User-Agent': ua, Referer: `${base}/`, Origin: base };
  const kind = (type: unknown, url: string): string => {
    const explicit = asString(firstTruthy([type]));
    if (explicit !== null) return explicit;
    return url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : url.includes('.mkv') ? 'mkv' : 'mp4';
  };
  const extract = (data: unknown, fallback?: string): FoundStream[] => {
    const list: FoundStream[] = [];
    if (!isRecord(data)) return list;
    const name = String(
      firstTruthy([dig(data, ['source', 'name']), dig(data, ['source', 'id']), fallback ?? null]) ?? 'Default',
    );
    if (Array.isArray(dig(data, ['qualities']))) {
      for (const item of asList(dig(data, ['qualities']))) {
        const u = dig(item, ['url']);
        if (typeof u !== 'string' || u === '') continue;
        let quality = truthy(dig(item, ['quality'])) ? String(dig(item, ['quality'])).trim() : 'Auto';
        if (quality === '0p') quality = 'Auto';
        else if (/^\d+$/.test(quality)) quality = `${quality}p`;
        list.push(
          mkStream({
            url: u,
            server: `Willow - ${name}`,
            quality,
            type: kind(dig(item, ['type']), u),
            headers: playback,
          }),
        );
      }
    }
    const src = dig(data, ['src']);
    if (typeof src === 'string' && src !== '') {
      list.push(
        mkStream({
          url: src,
          server: `Willow - ${name}`,
          type: kind(dig(data, ['type']), src),
          headers: playback,
        }),
      );
    }
    return list;
  };

  const query = hasEpisode(q)
    ? `id=${q.id}&type=tv&s=${seasonOf(q)}&e=${episodeOf(q)}`
    : `id=${q.id}&type=movie`;
  try {
    const res = await fetchRaw(`${base}/api/stream?${query}`, { headers, timeoutMs: 10000 });
    if (res.status >= 300) return [];
    let initial: unknown = null;
    try {
      initial = JSON.parse(res.body) as unknown;
    } catch {
      initial = null;
    }
    if (initial === null) return [];
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const stream of extract(initial)) {
      if (seen.has(stream.url)) continue;
      seen.add(stream.url);
      out.push(stream);
    }
    const current = dig(initial, ['source', 'id']);
    const extra = asList(dig(initial, ['sources'])).filter(
      (source) => truthy(dig(source, ['id'])) && dig(source, ['id']) !== current,
    );
    if (extra.length > 0) {
      const results = await Promise.all(
        extra.map(async (source): Promise<FoundStream[]> => {
          try {
            const r = await fetchRaw(
              `${base}/api/stream?${query}&source=${encodeURIComponent(String(dig(source, ['id'])))}`,
              { headers, timeoutMs: 8000 },
            );
            if (r.status >= 300) return [];
            return extract(
              JSON.parse(r.body) as unknown,
              String(firstTruthy([dig(source, ['name']), dig(source, ['id'])]) ?? ''),
            );
          } catch {
            return [];
          }
        }),
      );
      for (const list of results) {
        for (const stream of list) {
          if (seen.has(stream.url)) continue;
          seen.add(stream.url);
          out.push(stream);
        }
      }
    }
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:trendimovies (Vyla SDK trendimovies.js).
async function trendimovies(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://trendimovies.com';
  const headers = {
    'User-Agent': sdkUA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${base}/`,
  };
  const playback = { 'User-Agent': sdkUA, Referer: `${base}/` };

  const unwrap = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value.length === 2 && (value[0] === 0 || value[0] === 1)) return unwrap(value[1]);
      return value.map(unwrap);
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = unwrap(item);
      return out;
    }
    return value;
  };
  const fileType = (url: string, item: unknown): string => {
    const ext = firstTruthy([
      dig(item, ['format']),
      dig(item, ['extension']),
      dig(item, ['ext']),
      dig(item, ['type']),
    ]);
    if (ext !== null) return String(ext).toLowerCase().replace(/^\./, '');
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.mpd')) return 'dash';
    if (lower.includes('.mp4')) return 'mp4';
    if (lower.includes('.avi')) return 'avi';
    return 'mkv';
  };
  const links = (raw: unknown): FoundStream[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: FoundStream[] = [];
    for (const item of raw) {
      const url = firstTruthy([dig(item, ['url']), dig(item, ['file_url']), dig(item, ['link'])]);
      if (typeof url !== 'string' || !url.startsWith('http') || seen.has(url)) continue;
      seen.add(url);
      let quality = String(firstTruthy([dig(item, ['quality']), dig(item, ['resolution'])]) ?? 'Auto');
      if (/^\d+$/.test(quality.trim())) quality = `${quality}p`;
      const size = firstTruthy([dig(item, ['file_size']), dig(item, ['size'])]);
      const lang = dig(item, ['language']);
      let label = `TrendiMovies - ${quality}`;
      if (truthy(lang)) label += ` (${String(lang)})`;
      if (truthy(size)) label += ` [${String(size)}]`;
      out.push(
        mkStream({
          url,
          server: label,
          quality,
          type: fileType(url, item),
          headers: playback,
          audio: audioOf(lang),
        }),
      );
    }
    return out;
  };
  const islands = (html: string): unknown[] => {
    const out: unknown[] = [];
    for (const match of html.matchAll(/<astro-island[^>]*props="([^"]+)"/g)) {
      try {
        const decoded = (match[1] ?? '')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        const value = unwrap(JSON.parse(decoded) as unknown);
        if (value !== null && value !== undefined) out.push(value);
      } catch {
        // one broken island must not stop the others
      }
    }
    return out;
  };

  let all: FoundStream[] = [];
  if (!hasEpisode(q)) {
    try {
      const html = await fetchText(`${base}/movie/${q.id}`, { headers, timeoutMs: 25000 });
      for (const island of islands(html)) {
        const raw = firstTruthy([
          dig(island, ['links']),
          dig(island, ['movie', 'downloads']),
          dig(island, ['downloads']),
          dig(island, ['movie', 'links']),
        ]);
        const found = links(raw);
        if (found.length > 0) {
          all = found;
          break;
        }
      }
    } catch {
      return [];
    }
  } else {
    let html: string | null = null;
    try {
      html = await fetchText(`${base}/tv/${q.id}`, { headers, timeoutMs: 25000 });
    } catch {
      html = null;
    }
    if (html === null) {
      try {
        html = await fetchText(`${base}/show/${q.id}`, { headers, timeoutMs: 25000 });
      } catch {
        html = null;
      }
    }
    if (html !== null) {
      let bySeason: unknown = null;
      let byEpisode: unknown = null;
      for (const island of islands(html)) {
        bySeason =
          firstTruthy([
            dig(island, ['episodesBySeason']),
            dig(island, ['show', 'episodes']),
            dig(island, ['episodes']),
          ]) ?? bySeason;
        byEpisode =
          firstTruthy([dig(island, ['downloadsByEpisode']), dig(island, ['downloads'])]) ?? byEpisode;
        if (bySeason !== null && byEpisode !== null) break;
      }
      const eps = dig(bySeason, [String(seasonOf(q))]);
      if (Array.isArray(eps) && byEpisode !== null) {
        const ep = eps.find((entry) => String(dig(entry, ['episode_number'])) === String(episodeOf(q)));
        if (isRecord(ep) && truthy(dig(ep, ['id']))) {
          all = links(dig(byEpisode, [String(dig(ep, ['id']))]));
        }
      }
    }
  }
  all.sort((a, b) => weightOfQuality(b.quality) - weightOfQuality(a.quality));
  return onlyAbsolute(all);
}

// Ported from scrapers.dart:vidvault (Vyla SDK vidvault.js).
async function vidvault(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vidvault.to';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${base}/`,
  };
  const playback = { 'User-Agent': ua, Referer: `${base}/` };
  const tv = hasEpisode(q);
  const type = tv ? 'tv' : 'movie';
  const path = (kind: string, quality: string): string =>
    tv
      ? `${base}/${kind}/${type}/${q.id}/${seasonOf(q)}/${episodeOf(q)}/${quality}`
      : `${base}/${kind}/${type}/${q.id}/${quality}`;
  const qn = (text: string): number => {
    const match = /^\d+/.exec(text);
    return match ? Number(match[0]) : 0;
  };
  const download = async (quality: string): Promise<string | null> => {
    try {
      const res = await fetchRaw(path('download-link', quality), {
        headers: { ...headers, Accept: 'application/json' },
        timeoutMs: 4000,
      });
      if (res.status >= 300) return null;
      const u = dig(JSON.parse(res.body) as unknown, ['url']);
      if (!truthy(u)) return null;
      let clean = String(u).split('?')[0]?.split('#')[0] ?? '';
      if (!clean.endsWith('.mkv') && !clean.endsWith('.mp4')) clean += '.mkv';
      return clean;
    } catch {
      return null;
    }
  };
  const poll = async (jobId: string): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < 12000) {
      try {
        const res = await fetchRaw(`${base}/job/${jobId}?t=${Date.now()}`, { headers, timeoutMs: 3000 });
        if (res.status < 300) {
          const status = dig(JSON.parse(res.body) as unknown, ['status']);
          if (status === 'done') return true;
          if (status === 'error') return false;
        }
      } catch {
        // keep polling
      }
      await sleep(600);
    }
    return false;
  };

  try {
    const res = await fetchRaw(
      tv ? `${base}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}` : `${base}/movie/${q.id}`,
      { headers, timeoutMs: 25000 },
    );
    if (res.status >= 300) return [];
    const html = res.body;
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const match of html.matchAll(/<div[^>]*class=["'][^"']*quality-item[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
      const block = match[1] ?? '';
      const um = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i.exec(block);
      if (um === null) continue;
      const u = (um[1] ?? '').trim();
      if (seen.has(u)) continue;
      seen.add(u);
      const quality = /Download\s*([0-9a-zA-Z]+)/i.exec(block)?.[1]?.trim() ?? 'Auto';
      const size = /<small>\(([^)]+)\)<\/small>/i.exec(block)?.[1]?.trim() ?? '';
      out.push(
        mkStream({
          url: u,
          server: `VidVault - ${quality.toUpperCase()}${size === '' ? '' : ` (${size})`}`,
          quality,
          type: 'mkv',
          headers: playback,
        }),
      );
    }
    if (out.length > 0) {
      out.sort((a, b) => qn(b.quality) - qn(a.quality));
      return onlyAbsolute(out);
    }
    const found = Array.from(
      html.matchAll(/id=["']item-([0-9a-zA-Z]+)["']/gi),
      (match) => match[1] ?? '',
    );
    const qualities = found.length > 0 ? found : ['1080p', '720p', '360p'];
    await Promise.all(
      qualities.map(async (quality) => {
        let u = await download(quality);
        if (u === null) {
          try {
            const res = await fetchRaw(path('start-conversion', quality), {
              method: 'POST',
              headers,
              timeoutMs: 6000,
            });
            if (res.status < 300) {
              const job = dig(JSON.parse(res.body) as unknown, ['jobId']);
              if (job === 'existing') u = await download(quality);
              else if (truthy(job) && (await poll(String(job)))) u = await download(quality);
            }
          } catch {
            // this quality simply isn't available
          }
        }
        if (u !== null && !seen.has(u)) {
          seen.add(u);
          out.push(
            mkStream({
              url: u,
              server: `VidVault - ${quality.toUpperCase()}`,
              quality,
              type: 'mkv',
              headers: playback,
            }),
          );
        }
      }),
    );
    out.sort((a, b) => qn(b.quality) - qn(a.quality));
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:torrentio (Vyla SDK torrentio.js).
async function torrentio(q: FilmQuery): Promise<FoundStream[]> {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
  const playback = {
    'User-Agent': ua,
    Referer: 'https://stream.vidplay.to/',
    Origin: 'https://stream.vidplay.to',
  };
  const path = hasEpisode(q)
    ? `/v1/sources/stream?type=tv&id=${q.id}&s=${seasonOf(q)}&e=${episodeOf(q)}`
    : `/v1/sources/stream?type=movie&id=${q.id}`;
  const headers = {
    Accept: 'text/event-stream',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://stream.vidplay.to',
    Referer: 'https://stream.vidplay.to/',
    'Sec-CH-UA': '"Not-A.Brand";v="99", "Microsoft Edge";v="157", "Chromium";v="157"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': ua,
    Connection: 'keep-alive',
  };
  const out: FoundStream[] = [];
  const seen = new Set<string>();
  try {
    const res = await fetchRaw(`https://s.torrentio.to${path}`, { headers, timeoutMs: 25000 });
    if (res.status !== 200) return [];
    let stop = false;
    for (const line of res.body.split(/\r?\n/)) {
      const text = line.trim();
      if (!text.startsWith('data: ') || stop) continue;
      try {
        const data: unknown = JSON.parse(text.slice(6));
        for (const src of asList(dig(data, ['sources']))) {
          const u = dig(src, ['url']);
          if (typeof u !== 'string' || u === '' || seen.has(u)) continue;
          seen.add(u);
          const prov =
            firstTruthy([dig(src, ['provider', 'name']), dig(data, ['provider', 'name'])]) ?? 'Server';
          const raw = truthy(dig(src, ['quality'])) ? String(dig(src, ['quality'])).trim() : 'Auto';
          out.push(
            mkStream({
              url: u,
              server: `Torrentio - ${String(prov)}`,
              quality: /^\d+$/.test(raw) ? `${raw}p` : raw,
              type: asString(firstTruthy([dig(src, ['type'])])) ?? (u.includes('.m3u8') ? 'hls' : 'mp4'),
              headers: playback,
            }),
          );
        }
      } catch {
        // one malformed event must not stop the stream
      }
      if (out.length > 0) stop = true; // the SDK reads only the first useful batch
    }
  } catch {
    return [];
  }
  return onlyAbsolute(out);
}

// Ported from scrapers.dart:braflix (Vyla SDK braflix.js).
async function braflix(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://braflix.dev';
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const headers = { Origin: base, Referer: `${base}/`, 'User-Agent': ua, Accept: 'application/json, text/plain, */*' };
  const playback = { Origin: base, Referer: `${base}/` };
  const path = hasEpisode(q)
    ? `/api/play/tv/${tmdbIdOf(q)}/${seasonOf(q)}/${episodeOf(q)}`
    : `/api/play/movie/${tmdbIdOf(q)}`;
  try {
    const res = await fetchRaw(`${base}${path}`, { headers, timeoutMs: 10000 });
    if (res.status >= 300) return [];
    let data: unknown = null;
    try {
      data = JSON.parse(res.body) as unknown;
    } catch {
      data = null;
    }
    const raw = dig(data, ['result', 'file', 'stream']);
    if (dig(data, ['status']) !== 'ready' || typeof raw !== 'string' || raw === '') return [];
    const full = raw.startsWith('http') ? raw : `${base}${raw}`;
    const qualityRaw = String(firstTruthy([dig(data, ['result', 'source', 'quality'])]) ?? '1080,720,480');
    const parts = qualityRaw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    let maxQ = 0;
    for (const part of parts) {
      const match = /^\d+/.exec(part);
      if (match && Number(match[0]) > maxQ) maxQ = Number(match[0]);
    }
    const summary = parts.length > 0 ? parts.map((part) => `${part}p`).join('/') : 'DASH';
    const type = full.includes('.mpd') ? 'dash' : full.includes('.m3u8') ? 'hls' : 'dash';
    return onlyAbsolute([
      mkStream({
        url: full,
        server: `Braflix - DASH (${summary})`,
        quality: maxQ > 0 ? `${maxQ}p` : 'Auto',
        type,
        headers: playback,
      }),
    ]);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:moviebox (Vyla SDK moviebox.js).
async function moviebox(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://net79.cc';
  const headers = { Accept: 'application/json', Referer: `${base}/`, Origin: base, 'User-Agent': sdkUA };
  const playback = { Referer: 'https://mzfi.me/' };
  const url = hasEpisode(q)
    ? `${base}/api/embed-tmdb/${q.id}?type=tv&se=${seasonOf(q)}&ep=${episodeOf(q)}`
    : `${base}/api/embed-tmdb/${q.id}?type=movie`;
  const size = (bytes: unknown): string => {
    const n = numOrNull(bytes);
    if (n === null || n === 0) return '';
    const gb = n / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(n / (1024 * 1024))} MB`;
  };
  try {
    const payload = await fetchJson(url, { headers, timeoutMs: 8000 });
    if (!truthy(dig(payload, ['ok'])) || truthy(dig(payload, ['noSource']))) return [];
    const streams = dig(payload, ['streams']);
    const list = Array.isArray(streams) && streams.length > 0
      ? streams
      : truthy(dig(payload, ['mp4']))
        ? [{ url: dig(payload, ['mp4']), resolution: firstTruthy([dig(payload, ['resolution'])]) ?? 720 }]
        : [];
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const u = dig(item, ['url']);
      if (typeof u !== 'string' || !u.startsWith('http') || seen.has(u)) continue;
      seen.add(u);
      const res = truthy(dig(item, ['resolution'])) ? `${String(dig(item, ['resolution']))}p` : '720p';
      const s = truthy(dig(item, ['size'])) ? size(dig(item, ['size'])) : '';
      out.push(
        mkStream({
          url: u,
          server: `MovieBox ${res}${s === '' ? '' : ` [${s}]`}`,
          quality: res,
          type: u.includes('.m3u8') ? 'hls' : 'mp4',
          headers: playback,
        }),
      );
    }
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:vixsrc (Vyla SDK vixsrc.js).
async function vixsrc(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://vixsrc.to';
  const headers = {
    'User-Agent': sdkUA,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${base}/`,
    Origin: base,
  };
  const extract = (re: RegExp, text: string): string | null => {
    const match = re.exec(text);
    if (match === null) return null;
    return (match[1] ?? '').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/\\/g, '');
  };
  try {
    const apiUrl = hasEpisode(q)
      ? `${base}/api/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
      : `${base}/api/movie/${q.id}`;
    let apiText = '';
    try {
      apiText = await fetchText(apiUrl, { headers });
    } catch {
      apiText = '';
    }
    let apiData: unknown = {};
    try {
      apiData = JSON.parse(apiText === '' ? '{}' : apiText) as unknown;
    } catch {
      apiData = {};
    }
    const src = dig(apiData, ['src']);
    if (typeof src !== 'string' || src === '') return [];
    const embedUrl = src.startsWith('http') ? src : `${base}${src}`;
    let html = '';
    try {
      html = await fetchText(embedUrl, { headers });
    } catch {
      html = '';
    }
    if (html === '') return [];
    const token = extract(/token["']\s*:\s*["']([^"']+)/, html);
    const expires = extract(/expires["']\s*:\s*["']([^"']+)/, html);
    let playlist = extract(/url["']\s*:\s*["']([^"']+)/, html);
    if (token === null || expires === null || playlist === null) return [];
    if (playlist.startsWith('/')) playlist = `${base}${playlist}`;
    const lang = extract(/lang(?:uage)?["']\s*:\s*["']([a-z]{2,5})/i, html) ?? 'en';
    const sep = playlist.includes('?') ? '&' : '?';
    const master = `${playlist}${sep}token=${token}&expires=${expires}&h=1&lang=${lang}`;
    let text = '';
    try {
      text = await fetchText(master, { headers: { ...headers, Referer: embedUrl } });
    } catch {
      text = '';
    }
    if (!text.includes('#EXTM3U')) return [];
    const tracks: Array<{ name: string; lang: string }> = [];
    const seen = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('#EXT-X-MEDIA') || !line.includes('TYPE=AUDIO')) continue;
      const name = /NAME=["']([^"']+)["']/.exec(line)?.[1] ?? 'Default';
      const rendition =
        /rendition=([a-zA-Z0-9_-]+)/.exec(line)?.[1] ?? /LANGUAGE=["']([^"']+)["']/.exec(line)?.[1] ?? name;
      if (seen.has(rendition.toLowerCase())) continue;
      seen.add(rendition.toLowerCase());
      tracks.push({ name, lang: rendition });
    }
    const play = { ...headers, Referer: `${base}/` };
    if (tracks.length === 0) {
      return onlyAbsolute([mkStream({ url: master, server: 'VixSrc', type: 'hls', headers: play })]);
    }
    return onlyAbsolute(
      tracks.map((track) =>
        mkStream({
          url: `${playlist}${sep}token=${token}&expires=${expires}&h=1&lang=${track.lang}`,
          server: `VixSrc (${track.name})`,
          type: 'hls',
          headers: play,
          audio: audioOf(track.name),
        }),
      ),
    );
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:s111477 (Vyla SDK 111477.js).
async function s111477(q: FilmQuery): Promise<FoundStream[]> {
  const origin = 'https://st.111477.xyz';
  const tv = hasEpisode(q);
  const ua = getUA();
  const imdb = await resolveImdbId(q.id, tv);
  const targets = [...(imdb.startsWith('tt') ? [imdb] : []), `tmdb:${q.id}`];
  // The JS appends ::tmdb=<key> when it has one; VyseTV doesn't pass its key on.
  const config = 'https://a.111477.xyz/::sort=file-desc::limit=3';
  const b64 = bytesToB64Url(new TextEncoder().encode(config));
  const addonBase = `${origin}/config/${b64}`;
  const headers = { 'User-Agent': ua, Accept: 'application/json, text/plain, */*' };
  const out: FoundStream[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const endpoint = tv
      ? `${addonBase}/stream/series/${target}:${seasonOf(q)}:${episodeOf(q)}.json`
      : `${addonBase}/stream/movie/${target}.json`;
    try {
      const res = await fetchRaw(endpoint, { headers, timeoutMs: 12000 });
      if (res.status >= 300) continue;
      let data: unknown = null;
      try {
        data = JSON.parse(res.body) as unknown;
      } catch {
        data = null;
      }
      const streams = dig(data, ['streams']);
      if (Array.isArray(streams) && streams.length > 0) {
        for (const item of streams) {
          if (!isRecord(item)) continue;
          const u = String(firstTruthy([item.url, '']) ?? '').trim();
          if (u === '' || !u.startsWith('http') || seen.has(u)) continue;
          seen.add(u);
          const title = item.title === null || item.title === undefined ? '' : String(item.title).trim();
          const name = item.name === null || item.name === undefined ? '111477' : String(item.name).trim();
          const label = title !== '' ? title : name;
          out.push(mkStream({ url: u, server: label, type: u.includes('.m3u8') ? 'hls' : 'mp4', headers }));
        }
        if (out.length > 0) break;
      }
    } catch {
      // try the next id
    }
  }
  return onlyAbsolute(out);
}

// Ported from scrapers.dart:anizone (Vyla SDK anizone.js, anime only).
async function anizone(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://anizone.to';
  const headers = { 'User-Agent': sdkUA, Referer: `${base}/`, Origin: base };
  const playback = { Referer: `${base}/`, Origin: base };
  const marker = '\x01U\x01';
  /** Undo the site's doubly escaped JSON.parse('...') arguments. */
  const decodeArg = (raw: string | null): unknown => {
    if (raw === null || raw === '') return null;
    let value = raw.replace(/\\\\u([0-9a-fA-F]{4})/g, `${marker}$1`);
    value = value.replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    value = value.replace(/\x01U\x01([0-9a-fA-F]{4})/g, '\\u$1');
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  };
  const clean = (text: string | null): string =>
    (text ?? '')
      .toLowerCase()
      .replace(/\s*[-–—:]\s*\d+(?:st|nd|rd|th)?\s*(?:&|\+)?\s*\d*(?:st|nd|rd|th)?\s*(?:stage|cour|part|season).*$/i, '')
      .replace(/\s*[-–—:]\s*part\s+[ivx\d]+.*$/i, '')
      .replace(/\s*[-–—:]\s*season\s+\d+.*$/i, '')
      .replace(/\s*\(\d{4}\)$/, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const tv = hasEpisode(q);
  const meta = await getTmdbMetadata(q.id, tv);
  if (!meta.isAnime) return [];
  const target = tv ? episodeOf(q) : 1;
  const titles = meta.titles.length > 0 ? meta.titles : [meta.title !== '' ? meta.title : q.id];
  try {
    const found: unknown[] = [];
    const slugs = new Set<string>();
    for (const title of titles.slice(0, 4)) {
      const html = await fetchText(`${base}/anime?search=${encodeURIComponent(title)}`, {
        headers,
        timeoutMs: 8000,
      });
      const items = decodeArg(
        /items\s*:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/i.exec(html)?.[1] ?? null,
      );
      if (Array.isArray(items)) {
        for (const item of items) {
          const slug = dig(item, ['slug']);
          if (slug === null) continue;
          const text = String(slug);
          if (slugs.has(text)) continue;
          slugs.add(text);
          found.push(item);
        }
      }
      if (found.length >= 3) break;
    }
    if (found.length === 0) return [];
    const targets = titles.map(clean).filter((title) => title !== '');
    let matched: unknown = null;
    for (const item of found) {
      const list = dig(item, ['title_list']);
      const itemTitles = [dig(item, ['main_title']), ...(isRecord(list) ? Object.values(list) : [])]
        .map((title) => clean(title === null || title === undefined ? null : String(title)))
        .filter((title) => title !== '');
      if (targets.some((candidate) => itemTitles.includes(candidate))) {
        matched = item;
        break;
      }
    }
    matched ??= found[0];
    const watchHtml = await fetchText(`${base}/anime/${String(dig(matched, ['slug']))}/${target}`, {
      headers,
      timeoutMs: 8000,
    });
    const player = decodeArg(
      /vidstackPlayer\s*\(\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)\s*\)/i.exec(watchHtml)?.[1] ?? null,
    );
    const src = dig(player, ['src']);
    const master = src === null ? null : String(src).replace(/\\+\//g, '/');
    if (master === null || !master.startsWith('http')) return [];
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    if (master.includes('.m3u8')) {
      for (const variant of (await fetchVariants(master, playback, 4000)) ?? []) {
        if (seen.has(variant.url)) continue;
        seen.add(variant.url);
        out.push(
          mkStream({
            url: variant.url,
            server: `AniZone (${variant.quality})`,
            quality: variant.quality,
            type: 'hls',
            headers: playback,
          }),
        );
      }
    }
    if (!seen.has(master)) {
      seen.add(master);
      out.push(
        mkStream({
          url: master,
          server: 'AniZone',
          type: master.includes('.m3u8') ? 'hls' : 'mp4',
          headers: playback,
        }),
      );
    }
    out.sort((a, b) => qualityNumber(b.quality) - qualityNumber(a.quality));
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:_anvCookie / anv (Vyla SDK anv.js, anime only).
let anvCookie: string | null = null;
let anvCookieUntil = 0;

async function anvCookieValue(): Promise<string> {
  const base = 'https://anv.to';
  if (anvCookie !== null && Date.now() < anvCookieUntil) return anvCookie;
  try {
    let target = `${base}/anime/aoki-denshou-welsh-shedar-626fd-episode-5`;
    try {
      const xml = await fetchText(`${base}/recents.xml`, { timeoutMs: 3500 });
      const match = /<link>(https:\/\/anv\.to\/anime\/[^<]+)<\/link>/.exec(xml);
      if (match) target = match[1] ?? target;
    } catch {
      // the fallback page is fine
    }
    const res = await fetchRaw(target, {
      headers: {
        'User-Agent': sdkUA,
        Referer: `${base}/`,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: 4000,
    });
    const raw = headerValue(res.headers, 'set-cookie');
    const match = raw === null ? null : /shiro_watch=([^;,]+)/.exec(raw);
    if (match) {
      anvCookie = `shiro_watch=${(match[1] ?? '').trim()}`;
      anvCookieUntil = Date.now() + 20 * 60 * 60 * 1000;
    }
    return anvCookie ?? '';
  } catch {
    return '';
  }
}

async function anv(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://anv.to';
  const tv = hasEpisode(q);
  const meta = await getTmdbMetadata(q.id, tv);
  if (!meta.isAnime) return [];
  const title = meta.title !== '' ? meta.title : meta.titles.length > 0 ? (meta.titles[0] ?? null) : null;
  if (title === null) return [];
  let anilistId: unknown = null;
  let malId: unknown = null;
  try {
    const res = await fetchRaw('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: 'query($search: String) { Media(search: $search, type: ANIME) { id idMal } }',
        variables: { search: title },
      }),
      timeoutMs: 5000,
    });
    if (res.status < 300) {
      const data: unknown = JSON.parse(res.body);
      anilistId = dig(data, ['data', 'Media', 'id']);
      malId = dig(data, ['data', 'Media', 'idMal']);
    }
  } catch {
    // no id, no streams
  }
  if (anilistId === null) return [];
  const episode = tv ? episodeOf(q) : 1;
  const cookie = await anvCookieValue();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Origin: base,
      Referer: `${base}/`,
      'User-Agent': sdkUA,
      Accept: '*/*',
    };
    if (cookie !== '') headers.Cookie = cookie;
    const res = await fetchRaw(`${base}/api/episode`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ anilistId, malId, episode }),
      timeoutMs: 5000,
    });
    if (res.status >= 300) return [];
    const data: unknown = JSON.parse(res.body);
    const variants = dig(data, ['variants']);
    if (dig(data, ['status']) !== 'ready' || !Array.isArray(variants) || variants.length === 0) return [];
    const playback: Record<string, string> = {
      Origin: base,
      Referer: `${base}/`,
      'User-Agent': sdkUA,
    };
    if (cookie !== '') playback.Cookie = cookie;
    const out: FoundStream[] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
      const vType = String(firstTruthy([dig(variant, ['id'])]) ?? 'sub').toLowerCase();
      const vLabel = String(firstTruthy([dig(variant, ['label'])]) ?? (vType === 'dub' ? 'Dub' : 'Sub'));
      for (const source of asList(dig(variant, ['sources']))) {
        const u = dig(source, ['url']);
        if (typeof u !== 'string' || u === '') continue;
        const full = u.startsWith('http') ? u : `${base}${u}`;
        if (seen.has(full)) continue;
        seen.add(full);
        out.push(
          mkStream({
            url: full,
            server: `ANV - ${String(firstTruthy([dig(source, ['label'])]) ?? 'Default').trim()} (${vLabel})`,
            type: full.includes('.m3u8') ? 'hls' : 'mp4',
            headers: playback,
          }),
        );
      }
    }
    return onlyAbsolute(out);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:anime123 (Vyla SDK 123anime.js, anime only).
async function anime123(q: FilmQuery): Promise<FoundStream[]> {
  const base = 'https://123animehub.cc';
  const cdnOrigin = 'https://play2.echovideo.ru';
  if (q.season === null || q.season === undefined) return [];
  const meta = await getTmdbMetadata(q.id, hasEpisode(q));
  if (!meta.isAnime) return [];

  const keywords: string[] = [];
  for (const title of meta.titles) {
    const normalized = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!keywords.includes(normalized)) keywords.push(normalized);
    const words = title.split(/[\s:]+/).filter((word) => word.length > 2);
    if (words.length >= 2) {
      const short = words.slice(0, 3).join(' ').toLowerCase();
      if (!keywords.includes(short)) keywords.push(short);
    }
  }
  const slugs: string[] = [];
  for (const keyword of keywords) {
    try {
      const data = await fetchJson(
        `${base}/ajax/film/search?keyword=${encodeURIComponent(keyword)}&_=${Date.now()}`,
        {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${base}/`,
            Accept: 'application/json',
            'User-Agent': sdkUA,
          },
          timeoutMs: 8000,
        },
      );
      const html = String(dig(data, ['html']) ?? '');
      let idx = 0;
      while ((idx = html.indexOf('href="/anime/', idx)) !== -1) {
        const start = idx + 13;
        const end = html.indexOf('"', start);
        if (end === -1) break;
        const slug = html.slice(start, end);
        if (!slugs.includes(slug)) slugs.push(slug);
        idx = end;
      }
    } catch {
      // try the next keyword
    }
    if (slugs.length > 0) break;
  }
  let target: string | null = null;
  for (const slug of slugs) {
    try {
      const epr = `${slug}/${seasonOf(q)}/${episodeOf(q)}`;
      const data = await fetchJson(
        `${base}/ajax/episode/info?epr=${encodeURIComponent(epr)}&ts=1&_=${Date.now()}`,
        {
          headers: {
            Referer: `${base}/anime/${slug}`,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'User-Agent': sdkUA,
          },
          timeoutMs: 10000,
        },
      );
      if (truthy(dig(data, ['target']))) {
        target = String(dig(data, ['target']));
        break;
      }
    } catch {
      // try the next slug
    }
  }
  if (target === null) return [];
  const embed = /\/embed-[^/]+\/([A-Za-z0-9+/=]+)$/.exec(target);
  if (embed === null) return [];
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return [];
  }
  try {
    const embedRes = await fetchRaw(target, { headers: { 'User-Agent': sdkUA }, timeoutMs: 10000 });
    if (embedRes.status >= 300) return [];
    const setCookie = headerValue(embedRes.headers, 'set-cookie');
    const headers: Record<string, string> = {
      Referer: target,
      Accept: '*/*',
      'User-Agent': sdkUA,
    };
    if (setCookie !== null) headers.Cookie = (setCookie.split(';')[0] ?? '').trim();
    const data = await fetchJson(`${origin}/hs/getSources?id=${embed[1] ?? ''}`, {
      headers,
      timeoutMs: 10000,
    });
    const srcs = dig(data, ['sources']);
    let url: unknown = null;
    if (typeof srcs === 'string' && srcs !== '') url = srcs;
    else if (Array.isArray(srcs) && srcs.length > 0) {
      url = firstTruthy([dig(srcs, [0, 'file']), dig(srcs, [0, 'src']), dig(srcs, [0, 'url'])]);
    }
    if (typeof url !== 'string') return [];
    return onlyAbsolute([
      mkStream({
        url,
        server: '123Anime',
        type: url.includes('.m3u8') ? 'hls' : 'mp4',
        headers: { Referer: `${cdnOrigin}/`, Origin: cdnOrigin },
      }),
    ]);
  } catch {
    return [];
  }
}

// ── hexa.js: challenge service + enc-dec.app decryption ─────────────────────

const HEXA_BASE = 'https://theemoviedb.hexa.su';
const HEXA_CAP_URL = 'https://cap.hexa.su/15d2cf0395';
const HEXA_DEC_API = 'https://enc-dec.app/api';
const HEXA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const HEXA_CHALLENGE_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Language':
    'en-US,en;q=0.9,ru;q=0.8,fr;q=0.7,bg;q=0.6,pl;q=0.5,id;q=0.4,zh-CN;q=0.3,zh;q=0.2,ja;q=0.1,es;q=0.1',
  Origin: 'https://hexa.su',
  Referer: 'https://hexa.su/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 OPR/129.0.0.0 (Edition std-2)',
};
const HEXA_PLAYBACK_HEADERS = {
  'User-Agent': HEXA_UA,
  Referer: 'https://hexa.su/',
  Origin: 'https://hexa.su',
};
let hexaCapToken: string | null = null;
let hexaTokenUses = 0;

async function fetchHexaCapToken(): Promise<string | null> {
  if (hexaCapToken !== null && hexaTokenUses < 18) {
    hexaTokenUses += 1;
    return hexaCapToken;
  }
  try {
    const challenge = await fetchJson(`${HEXA_CAP_URL}/challenge`, {
      method: 'POST',
      headers: HEXA_CHALLENGE_HEADERS,
      body: '{}',
      timeoutMs: 8000,
    });
    const encoded = await fetchJson(`${HEXA_DEC_API}/enc-hexa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HEXA_UA },
      body: JSON.stringify({ challenge_data: challenge }),
      timeoutMs: 8000,
    });
    if (dig(encoded, ['status']) !== 200 || !truthy(dig(encoded, ['result']))) return null;
    const redeemed = await fetchJson(`${HEXA_CAP_URL}/redeem`, {
      method: 'POST',
      headers: HEXA_CHALLENGE_HEADERS,
      body: JSON.stringify(dig(encoded, ['result'])),
      timeoutMs: 8000,
    });
    const token = dig(redeemed, ['token']);
    if (typeof token === 'string' && token !== '') {
      hexaCapToken = token;
      hexaTokenUses = 1;
      return token;
    }
  } catch {
    hexaCapToken = null;
  }
  return null;
}

function extractHexaStreams(result: unknown): FoundStream[] {
  if (result === null || result === undefined) return [];
  let data: unknown = result;
  if (typeof data === 'string' && (data.startsWith('{') || data.startsWith('['))) {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      // leave it as a string
    }
  }
  if (typeof data === 'string' && /^https?:\/\//.test(data)) {
    return [
      mkStream({
        url: data,
        server: 'Hexa - Direct',
        quality: 'Auto',
        type: data.includes('.m3u8') ? 'hls' : data.includes('.mpd') ? 'dash' : 'mp4',
        headers: HEXA_PLAYBACK_HEADERS,
      }),
    ];
  }
  const rawSources = Array.isArray(data)
    ? data
    : isRecord(data)
      ? Array.isArray(data.sources)
        ? data.sources
        : Array.isArray(data.streams)
          ? data.streams
          : []
      : [];
  const list: FoundStream[] = [];
  for (const item of rawSources) {
    const raw =
      isRecord(item) ? firstTruthy([item.url, item.file, item.src]) : typeof item === 'string' ? item : null;
    if (raw === null) continue;
    const streamUrl = String(raw);
    if (!streamUrl.startsWith('http')) continue;
    let quality = isRecord(item) ? String(firstTruthy([item.quality, item.label]) ?? 'Auto') : 'Auto';
    if (/^\d+$/.test(quality)) quality = `${quality}p`;
    const explicit = isRecord(item) ? item.type : null;
    list.push(
      mkStream({
        url: streamUrl,
        server: `Hexa - ${String(isRecord(item) ? firstTruthy([item.server, item.name]) ?? 'Direct' : 'Direct')}`,
        quality,
        type: explicit === null || explicit === undefined ? undefined : String(explicit),
        headers: HEXA_PLAYBACK_HEADERS,
      }),
    );
  }
  if (isRecord(data) && typeof data.url === 'string' && data.url.startsWith('http')) {
    const u = data.url;
    list.push(
      mkStream({
        url: u,
        server: `Hexa - ${String(firstTruthy([data.server]) ?? 'Direct')}`,
        quality: String(firstTruthy([data.quality]) ?? 'Auto'),
        type: String(firstTruthy([data.type]) ?? (u.includes('.m3u8') ? 'hls' : u.includes('.mpd') ? 'dash' : 'mp4')),
        headers: HEXA_PLAYBACK_HEADERS,
      }),
    );
  }
  return list;
}

// Ported from scrapers.dart:hexa (Vyla SDK hexa.js).
async function hexa(q: FilmQuery): Promise<FoundStream[]> {
  const path = hasEpisode(q)
    ? `/api/tmdb/tv/${q.id}/season/${seasonOf(q)}/episode/${episodeOf(q)}/images`
    : `/api/tmdb/movie/${q.id}/images`;
  const capToken = await fetchHexaCapToken();
  if (capToken === null) return [];
  const keyBytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(keyBytes);
  else for (let i = 0; i < keyBytes.length; i += 1) keyBytes[i] = Math.floor(Math.random() * 256);
  const key = bytesToHex(keyBytes);
  const headers = {
    'User-Agent': HEXA_UA,
    Referer: 'https://hexa.su/',
    Origin: 'https://hexa.su',
    Accept: 'text/plain',
    'X-Fingerprint-Lite': 'e9136c41504646444',
    'X-Cap-Token': capToken,
    'X-Api-Key': key,
  };
  try {
    const res = await fetchRaw(`${HEXA_BASE}${path}`, { headers, timeoutMs: 12000 });
    if (res.status >= 300) {
      hexaCapToken = null;
      return [];
    }
    const encryptedText = res.body.trim();
    if (encryptedText === '') return [];
    const decRes = await fetchJson(`${HEXA_DEC_API}/dec-hexa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HEXA_UA },
      body: JSON.stringify({ text: encryptedText, key }),
      timeoutMs: 10000,
    });
    if (dig(decRes, ['status']) !== 200 || !truthy(dig(decRes, ['result']))) return [];
    const streams = extractHexaStreams(dig(decRes, ['result']));
    const seen = new Set<string>();
    return onlyAbsolute(
      streams.filter((stream) => {
        if (seen.has(stream.url)) return false;
        seen.add(stream.url);
        return true;
      }),
    );
  } catch {
    return [];
  }
}

// ── cinesrc.js: two-stage proof of work, solved with the local SHA-256 ──────

const CS_API = 'https://enc-dec.app/api';
const CS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.37 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.37';
const CS_K = [
  0x46c6c721, 0x4230c311, 0x18223a1d, 0x56389ba7, 0xd4a87103, 0x07cb9e2f, 0x73085f9d, 0xd2396a1f,
  0x23ae5add, 0x4646c48f, 0x0f4e0903, 0x808f5f31, 0x953d4e07, 0x7e238fff, 0x634595df, 0xcb5e4301,
];
const CS_SCHEDULES = [
  [0, 7, 6, 3, 2, 1, 5, 4, 0, 2, 4, 6, 5, 1, 7, 3],
  [5, 2, 1, 3, 0, 4, 6, 7, 4, 1, 0, 7, 3, 6, 5, 2],
  [4, 0, 2, 1, 5, 7, 6, 3, 2, 6, 0, 7, 4, 3, 5, 1],
  [5, 4, 7, 0, 2, 3, 1, 6, 5, 1, 4, 0, 7, 2, 3, 6],
  [4, 7, 0, 2, 1, 6, 5, 3, 6, 1, 3, 2, 0, 7, 4, 5],
  [0, 7, 2, 6, 3, 4, 5, 1, 6, 5, 0, 2, 7, 1, 4, 3],
  [0, 4, 5, 3, 1, 7, 2, 6, 3, 7, 5, 6, 1, 0, 2, 4],
  [7, 6, 0, 4, 2, 5, 1, 3, 7, 5, 3, 4, 2, 6, 0, 1],
];
const CS_PERMS = [
  [3, 5, 1, 0, 2, 4],
  [2, 0, 4, 5, 3, 1],
  [1, 4, 5, 3, 0, 2],
  [2, 0, 1, 5, 4, 3],
  [4, 2, 1, 0, 3, 5],
  [5, 0, 2, 1, 3, 4],
  [4, 5, 1, 0, 3, 2],
  [4, 0, 3, 5, 1, 2],
];

const csImul = (a: number, b: number): number => u32(imul(u32(a), u32(b)));
const csRotl = (x: number, n: number): number => {
  const shift = n & 31;
  return u32(shl(x, shift) | ushr(x, 32 - shift));
};

/** Dart scrapers.dart:_solveStage1 (cinesrc.js stage 1 proof of work). */
function solveCsStage1(challenge: Record<string, unknown>, seed: string): string {
  const raw = challenge.w;
  if (typeof raw !== 'string') throw new Error('Missing challenge');
  const c = b64ToBytes(raw);
  if (c.length < 28) throw new Error('Short challenge');
  const view = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const mode = c[21] ?? 0;
  const diffVal = c[22] ?? 0;
  const varIdx = c[23] ?? 0;
  const rnd = c[24] ?? 0;
  const mB = c[25] ?? 0;
  const sI = c[26] ?? 0;
  const pI = c[27] ?? 0;
  const w = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)];
  if (mB < 0 || mB > 26) throw new Error('Bad challenge size');
  const size = 1 << mB;
  const s = new Uint32Array(size);
  let x = u32((w[varIdx & 3] ?? 0) ^ (CS_K[sI] ?? 0) ^ csImul(CS_K[8 + sI] ?? 0, varIdx + 1));
  let y = u32((w[(varIdx + 1) & 3] ?? 0) ^ (CS_K[15 - sI] ?? 0));
  for (let i = 0; i < size; i += 1) {
    x = u32((w[(i + sI) & 3] ?? 0) + x + csImul(CS_K[(i + varIdx) & 15] ?? 0, i + 1));
    x = u32(x ^ shl(x, 13));
    x = u32(x ^ ushr(x, 17));
    x = u32(x ^ shl(x, 5));
    y = csRotl(u32(csImul(CS_K[(i + 9) & 15] ?? 0, i + 3) ^ y ^ x), i + varIdx + sI);
    s[i] = u32(
      csImul(CS_K[(i + 5) & 15] ?? 0, i ^ varIdx) ^
        csRotl(w[(i + varIdx) & 3] ?? 0, i + sI) ^
        x ^
        y,
    );
  }
  const seedBytes = new Uint8Array(Math.floor(seed.length / 2));
  for (let i = 0; i < seedBytes.length; i += 1) seedBytes[i] = parseInt(seed.slice(i * 2, i * 2 + 2), 16);
  const msg = new Uint8Array(88);
  msg.set(c.subarray(0, 16), 24);
  const cfg = mB ^ 0x6b29;
  msg[48] = 4;
  msg[49] = mode;
  msg[50] = varIdx;
  msg[51] = sI;
  msg[52] = pI;
  msg[53] = rnd;
  msg[54] = cfg & 0xff;
  msg[55] = cfg >> 8;
  msg.set(seedBytes, 56);
  const mask = size - 1;
  const sch = CS_SCHEDULES[sI];
  const perm = CS_PERMS[pI];
  if (sch === undefined || perm === undefined) throw new Error('Bad challenge indexes');
  const msgView = new DataView(msg.buffer);

  for (let n = 0n; ; n += 1n) {
    const lo = Number(n & 0xffffffffn);
    const hi = Number(n >> 32n);
    let ma = u32((w[0] ?? 0) ^ (CS_K[varIdx] ?? 0) ^ lo);
    let mb = u32(csRotl(lo, varIdx + 7) ^ (w[2] ?? 0));
    let mc = u32((w[1] ?? 0) ^ (CS_K[8 + sI] ?? 0) ^ hi);
    let md = u32(csRotl(lo ^ hi, sI + 11) ^ (w[3] ?? 0));
    let me = u32((CS_K[sI + varIdx] ?? 0) ^ lo ^ hi);
    let mf = u32((CS_K[15 - varIdx] ?? 0) ^ (w[sI & 3] ?? 0));
    for (let r = 0; r < rnd; r += 1) {
      const i1 = u32(csRotl(mb, r + 1) ^ csImul(CS_K[r & 15] ?? 0, mf) ^ me ^ ma) & mask;
      const v1 = s[i1] ?? 0;
      const i2 = u32(csRotl(me, varIdx + r + 3) ^ csImul(CS_K[(r + 7) & 15] ?? 0, md) ^ mc ^ v1) & mask;
      const op = sch[r] ?? 0;
      if (op === 0) {
        ma = csRotl(u32(ma + md + v1), 5);
        mc = u32(csImul(mc ^ mf ^ ma, 1187432225) + mb);
      } else if (op === 1) {
        mb = csRotl(mc ^ me ^ mb ^ v1, 11);
        md = u32(csImul(mb ^ ma, 1110491921) + md);
      } else if (op === 2) {
        mc = csRotl(u32(mc + mb + v1), 17);
        ma = u32(csImul(md ^ mf ^ mc, 404896285) ^ ma);
      } else if (op === 3) {
        md = csRotl(ma ^ md ^ v1, 23);
        mb = u32(csImul(mc ^ me ^ md, 1446550439) + mb);
      } else if (op === 4) {
        ma = u32(csImul(ma ^ me ^ v1, 0xd4a87103) + csRotl(mb, 7));
        md = u32(csRotl(u32(mc + mf + ma), 13) ^ md);
      } else if (op === 5) {
        mc = u32(csImul(u32(mc + mf + v1), 130784815) ^ csRotl(md, 9));
        mb = u32(csRotl(ma ^ me ^ mc, 19) + mb);
      } else if (op === 6) {
        mb = u32(csImul(mb ^ mf ^ v1, 1929928605) + csRotl(ma, 3));
        mc = u32(csRotl(u32(md + me + mb), 15) ^ mc);
      } else {
        md = u32(csImul(u32(md + me + v1), 0xd2396a1f) ^ csRotl(mc, 21));
        ma = u32(csRotl(mb ^ mf ^ md, 27) + ma);
      }
      const v2 = s[i2] ?? 0;
      if (((mf ^ r ^ v1) & 1) === 0) {
        mf = csRotl(u32(v2 + mf + ma), r + 5);
        me = u32(csImul(CS_K[8 + op] ?? 0, v2 ^ me ^ mf) + md);
      } else {
        me = csRotl(v2 ^ me ^ mb, r + 9);
        mf = u32(csImul(CS_K[(op + 11) & 15] ?? 0, u32(v2 + mf + me)) ^ mc);
      }
    }
    const mArr = [ma, mc, mb, md, mf, me];
    const permuted = perm.map((index) => mArr[index] ?? 0);
    for (let i = 0; i < 6; i += 1) msgView.setUint32(i * 4, permuted[i] ?? 0, true);
    msgView.setUint32(40, lo, true);
    msgView.setUint32(44, hi, true);
    const hash = sha256Bytes(msg);
    const whole = Math.floor(diffVal / 8);
    const rest = diffVal % 8;
    let ok = whole <= hash.length;
    for (let i = 0; ok && i < whole; i += 1) if (hash[i] !== 0) ok = false;
    if (ok && (rest === 0 || ((hash[whole] ?? 0) >> (8 - rest)) === 0)) return `m4.${n.toString(16)}`;
  }
}

/** Dart scrapers.dart:_solveStage2 (cinesrc.js stage 2 proof of work). */
function solveCsStage2(data: Record<string, unknown>): string {
  const pack = data.pack;
  if (!Array.isArray(pack) || pack.length < 5) throw new Error('Missing pack');
  const reverse = (text: string): string => text.split('').reverse().join('');
  const target = reverse(String(pack[0]));
  const salt = reverse(String(pack[3]));
  const r = reverse(String(pack[4]));
  const b64dec = (text: string): string => decodeUtf8(b64ToBytes(text));
  const body = b64dec((r.split('.')[1] ?? ''));
  const payload = b64dec((body.split('.')[1] ?? ''));
  const difficulty = Number(dig(JSON.parse(payload) as unknown, ['d']));
  if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 32) throw new Error('Bad difficulty');
  const width = Math.floor((difficulty + 3) / 4);
  const limit = 2 ** difficulty;
  for (let counter = 0; counter < limit; counter += 1) {
    const key = counter.toString(16).padStart(width, '0');
    if (sha256Hex(`${salt}${key}`) === target) return key;
  }
  throw new Error('No solution');
}

// Ported from scrapers.dart:cinesrc (Vyla SDK cinesrc.js).
async function cinesrc(q: FilmQuery): Promise<FoundStream[]> {
  const tv = hasEpisode(q);
  const type = tv ? 'tv' : 'movie';
  const url = tv
    ? `https://cinesrc.st/embed/tv/${q.id}?s=${seasonOf(q)}&e=${episodeOf(q)}`
    : `https://cinesrc.st/embed/movie/${q.id}`;
  const headers = {
    Origin: 'https://cinesrc.st',
    Referer: 'https://cinesrc.st/',
    'Content-Type': 'text/plain;charset=UTF-8',
    'User-Agent': CS_UA,
  };
  const fields: unknown[] = [
    type,
    q.id,
    ...(tv ? [String(seasonOf(q)), String(episodeOf(q))] : []),
  ];
  const encoded = bytesToB64Url(new TextEncoder().encode(JSON.stringify(fields))).replace(/=+$/, '');
  try {
    const bootstrap = await fetchJson('https://cinesrc.st/api/c/bootstrap', {
      method: 'POST',
      headers: { ...headers, 'x-cs-q': encoded },
      body: '{}',
    });
    const cookies: Record<string, string> = {
      'x-cs-b': '20261014-a',
      'x-cs-q': encoded,
      'x-cs-r': String(dig(bootstrap, ['r'])),
      'x-cs-p': String(dig(bootstrap, ['p'])),
    };
    const challenge1 = await fetchJson('https://cinesrc.st/api/c/issue', {
      headers: { ...headers, ...cookies },
    });
    if (!isRecord(challenge1)) return [];
    const seedRes = await fetchJson(`${CS_API}/enc-cinesrc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: { url, user_agent: headers['User-Agent'], challenge_data: challenge1 },
        type: 'seed',
      }),
    });
    const seedData = dig(seedRes, ['result']);
    const solution1 = solveCsStage1(challenge1, String(dig(seedData, ['seed'])));
    const challenge2 = await fetchJson('https://cinesrc.st/api/c/stage2/issue', {
      headers: { ...headers, ...cookies },
    });
    if (!isRecord(challenge2)) return [];
    const solution2 = solveCsStage2(challenge2);
    const encryptRes = await fetchJson(`${CS_API}/enc-cinesrc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          url,
          user_agent: headers['User-Agent'],
          challenge_data: {
            stage1: { challenge: challenge1, solution: solution1 },
            stage2: { challenge: challenge2, solution: solution2 },
          },
          state: dig(seedData, ['state']),
        },
        type: 'encrypt',
      }),
    });
    const encData = dig(encryptRes, ['result']);
    const token = `${String(dig(encData, ['token']))}::c3::${cookies['x-cs-r'] ?? ''}`;
    const nextActions = dig(encData, ['headers']);
    const providersText = await fetchText(url, {
      method: 'POST',
      headers: { ...headers, ...cookies, 'Next-Action': String(dig(nextActions, ['getProviderList'])) },
      body: '[]',
    });
    let providers: unknown[] = [];
    for (const rawLine of providersText.split('\n')) {
      const colon = rawLine.indexOf(':');
      if (colon === -1) continue;
      const candidate = rawLine.slice(colon + 1).trim();
      if (!candidate.startsWith('[') || !candidate.endsWith(']')) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          providers = parsed;
          break;
        }
      } catch {
        // not the provider list
      }
    }
    if (providers.length === 0) return [];
    for (const providerObj of providers) {
      const provider = dig(providerObj, ['id']);
      const payload: unknown[] = [
        q.id,
        tv ? 'show' : type,
        tv ? String(seasonOf(q)) : '$undefined',
        tv ? String(episodeOf(q)) : '$undefined',
        token,
        provider,
      ];
      let streamRes: string;
      try {
        streamRes = await fetchText(url, {
          method: 'POST',
          headers: { ...headers, ...cookies, 'Next-Action': String(dig(nextActions, ['getStream'])) },
          body: JSON.stringify(payload),
        });
      } catch {
        continue;
      }
      if (
        streamRes.includes('"status":500') ||
        streamRes.includes('invalid_challenge') ||
        streamRes.length < 10
      ) {
        continue;
      }
      let decryptRes: unknown = null;
      try {
        decryptRes = await fetchJson(`${CS_API}/dec-cinesrc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: streamRes, state: dig(encData, ['state']) }),
        });
      } catch {
        continue;
      }
      if (dig(decryptRes, ['status']) !== 200 || !truthy(dig(decryptRes, ['result']))) continue;
      let resultData: unknown = dig(decryptRes, ['result']);
      if (typeof resultData === 'string') {
        try {
          resultData = JSON.parse(resultData) as unknown;
        } catch {
          // leave it as text
        }
      }
      let streamUrl: string | null = null;
      if (isRecord(resultData)) {
        if (Array.isArray(resultData.url)) streamUrl = asString(dig(resultData, ['url', 0, 'url']));
        else if (typeof resultData.url === 'string') streamUrl = resultData.url;
        else if (typeof resultData.file === 'string') streamUrl = resultData.file;
        else if (Array.isArray(resultData.sources)) streamUrl = asString(dig(resultData, ['sources', 0, 'url']));
      }
      if (streamUrl !== null) {
        const full = streamUrl.startsWith('/') ? `https://cinesrc.st${streamUrl}` : streamUrl;
        const rawHeaders = isRecord(resultData) ? resultData.headers : null;
        const rHeaders: Record<string, string> = {};
        if (isRecord(rawHeaders)) {
          for (const [key, value] of Object.entries(rawHeaders)) rHeaders[key] = String(value);
        } else {
          rHeaders.Referer = 'https://cinesrc.st/';
          rHeaders.Origin = 'https://cinesrc.st';
        }
        return onlyAbsolute([
          mkStream({
            url: full,
            server: `CineSrc - ${String(dig(providerObj, ['name']) ?? String(provider))}`,
            quality: 'Auto',
            type: full.includes('.m3u8') ? 'hls' : 'mp4',
            headers: rHeaders,
          }),
        ]);
      }
    }
    return [];
  } catch {
    return [];
  }
}

// ── mapple.js: SHA-256 proof of work and a cookie-jar session ───────────────

const MAPPLE_BASE = 'https://mapple.fun';
const MAPPLE_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MAPPLE_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MAPPLE_SERVERS: Array<{ name: string; source: string }> = [
  { name: 'Zeus', source: 'mapple' },
  { name: 'Poseidon', source: 's25' },
  { name: 'Aphrodite', source: 's6' },
  { name: 'Hephaestus', source: 's15' },
  { name: 'Prometheus', source: 's10' },
  { name: 'Atlas', source: 's1' },
];
const MAPPLE_PLAYBACK = {
  'User-Agent': MAPPLE_DESKTOP_UA,
  Origin: MAPPLE_BASE,
  Referer: `${MAPPLE_BASE}/`,
};

/** Dart scrapers.dart:_mpSolvePoW — leading-zero-bit SHA-256 over challenge+nonce. */
function solveMapplePow(challenge: string, difficulty: number): string | null {
  if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 256) return null;
  for (let nonce = 0; nonce < 20000000; nonce += 1) {
    const hash = sha256Hex(`${challenge}${nonce}`);
    let bits = difficulty;
    let i = 0;
    while (bits >= 8 && hash.slice(i * 2, i * 2 + 2) === '00') {
      bits -= 8;
      i += 1;
    }
    if (bits <= 0 || (bits < 8 && (parseInt(hash.slice(i * 2, i * 2 + 2), 16) >> (8 - bits)) === 0)) {
      return String(nonce);
    }
  }
  return null;
}

type MappleJar = Record<string, string>;

function mpUpdateCookies(jar: MappleJar, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'set-cookie') continue;
    for (const cookie of value.split(/,(?=[^ ])/)) {
      const pair = (cookie.split(';')[0] ?? '').split('=');
      if (pair.length >= 2) {
        const name = (pair[0] ?? '').trim();
        if (name !== '') jar[name] = pair.slice(1).join('=').trim();
      }
    }
  }
}

function mpSerialize(jar: MappleJar): string {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

interface MappleSession {
  requestToken: string;
  playbackToken: string;
  jar: MappleJar;
  referer: string;
}

async function mpCreateSession(
  tmdbId: number,
  mediaType: string,
  tvSlug: string,
  referer: string,
): Promise<MappleSession | null> {
  try {
    const jar: MappleJar = {};
    const home = await fetchRaw(`${MAPPLE_BASE}/`, {
      headers: { 'User-Agent': MAPPLE_MOBILE_UA, Accept: 'text/html' },
      timeoutMs: 25000,
    });
    mpUpdateCookies(jar, home.headers);
    const tokenRes = await fetchRaw(`${MAPPLE_BASE}/api/ui/session`, {
      method: 'POST',
      headers: {
        'User-Agent': MAPPLE_MOBILE_UA,
        Accept: '*/*',
        Origin: MAPPLE_BASE,
        Referer: referer,
        'Content-Type': 'application/json',
        Cookie: mpSerialize(jar),
      },
      body: '',
      timeoutMs: 25000,
    });
    mpUpdateCookies(jar, tokenRes.headers);
    let tokenData: unknown = null;
    try {
      tokenData = JSON.parse(tokenRes.body) as unknown;
    } catch {
      tokenData = null;
    }
    const requestToken = asString(dig(tokenData, ['token']));
    if (requestToken === null) return null;
    const payload: Record<string, unknown> = {
      mediaId: tmdbId,
      mediaType,
      tv_slug: tvSlug,
      requestToken,
    };
    const initPlayback = async (body: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      const res = await fetchRaw(`${MAPPLE_BASE}/api/playback-init`, {
        method: 'POST',
        headers: {
          'User-Agent': MAPPLE_MOBILE_UA,
          Accept: '*/*',
          Origin: MAPPLE_BASE,
          Referer: referer,
          'Content-Type': 'application/json',
          Cookie: mpSerialize(jar),
        },
        body: JSON.stringify(body),
        timeoutMs: 25000,
      });
      mpUpdateCookies(jar, res.headers);
      try {
        const parsed: unknown = JSON.parse(res.body);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };
    let result = await initPlayback(payload);
    const playbackToken = (value: Record<string, unknown> | null): string | null => {
      const token = value === null ? null : dig(value, ['token']);
      return token === null || token === undefined ? null : String(token);
    };
    if (result !== null && result.success === true && playbackToken(result) !== null) {
      return { requestToken, playbackToken: playbackToken(result) ?? '', jar, referer };
    }
    if (result !== null && result.requiresPow === true && isRecord(result.pow)) {
      const pow = result.pow;
      const challenge = String(dig(pow, ['challenge']));
      const difficulty = numOrNull(dig(pow, ['difficulty'])) ?? 18;
      const nonce = solveMapplePow(challenge, difficulty);
      if (nonce === null) return null;
      result = await initPlayback({
        ...payload,
        pow: { challengeId: dig(pow, ['challengeId']), nonce },
      });
      const token = playbackToken(result);
      if (token !== null) return { requestToken, playbackToken: token, jar, referer };
    }
    return null;
  } catch {
    return null;
  }
}

function mpResolvePlaylistUrl(entry: string, playlistUrl: string): string {
  if (/^https?:\/\//i.test(entry)) return entry;
  const cleanUrl = (playlistUrl.split('#')[0] ?? '').split('?')[0] ?? '';
  if (entry.startsWith('/')) {
    const origin = /^(https?:\/\/[^/]+)/i.exec(cleanUrl)?.[1] ?? '';
    return `${origin}${entry}`;
  }
  return `${cleanUrl.slice(0, cleanUrl.lastIndexOf('/') + 1)}${entry}`;
}

async function mpParseMasterPlaylist(
  playlistUrl: string,
  headers: Record<string, string>,
): Promise<Array<{ url: string; quality: string }> | null> {
  try {
    const res = await fetchRaw(playlistUrl, { headers, timeoutMs: 5000 });
    if (res.status >= 300) return null;
    const text = res.body;
    if (!text.includes('#EXT-X-STREAM-INF')) return null;
    const lines = text.split('\n');
    const variants: Array<{ url: string; quality: string }> = [];
    let currentQuality = '1080p';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
        const match = /RESOLUTION=\d+x(\d+)/i.exec(trimmed);
        if (match) currentQuality = `${match[1]}p`;
      } else if (trimmed !== '' && !trimmed.startsWith('#')) {
        variants.push({ url: mpResolvePlaylistUrl(trimmed, playlistUrl), quality: currentQuality });
        currentQuality = '1080p';
      }
    }
    return variants.length > 0 ? variants : null;
  } catch {
    return null;
  }
}

async function mpFetchServer(
  server: { name: string; source: string },
  tmdbId: number,
  mediaType: string,
  tvSlug: string,
  session: MappleSession,
): Promise<FoundStream[]> {
  const { jar, referer, requestToken, playbackToken } = session;
  try {
    const encryptRes = await fetchRaw(`${MAPPLE_BASE}/api/encrypt`, {
      method: 'POST',
      headers: {
        'User-Agent': MAPPLE_MOBILE_UA,
        Accept: '*/*',
        Origin: MAPPLE_BASE,
        Referer: referer,
        'Content-Type': 'application/json',
        Cookie: mpSerialize(jar),
      },
      body: JSON.stringify({
        data: { mediaId: tmdbId, mediaType, tv_slug: tvSlug, source: server.source },
        endpoint: 'stream-encrypted',
        requestToken,
      }),
      timeoutMs: 25000,
    });
    mpUpdateCookies(jar, encryptRes.headers);
    let encrypted: unknown = null;
    try {
      encrypted = JSON.parse(encryptRes.body) as unknown;
    } catch {
      encrypted = null;
    }
    const encryptedPath = dig(encrypted, ['url']);
    if (encryptedPath === null || encryptedPath === undefined) return [];
    const streamEndpoint = `${MAPPLE_BASE}${String(encryptedPath)}&requestToken=${encodeURIComponent(
      requestToken,
    )}&token=${encodeURIComponent(playbackToken)}`;
    const streamRes = await fetchRaw(streamEndpoint, {
      headers: {
        'User-Agent': MAPPLE_MOBILE_UA,
        Accept: '*/*',
        Origin: MAPPLE_BASE,
        Referer: referer,
        Cookie: mpSerialize(jar),
      },
      timeoutMs: 25000,
    });
    mpUpdateCookies(jar, streamRes.headers);
    let streamData: unknown = null;
    try {
      streamData = JSON.parse(streamRes.body) as unknown;
    } catch {
      streamData = null;
    }
    const streamUrl = asString(dig(streamData, ['data', 'stream_url']));
    if (streamUrl === null || streamUrl.includes('playback-unavailable')) return [];
    const variants = await mpParseMasterPlaylist(streamUrl, MAPPLE_PLAYBACK);
    if (variants !== null && variants.length > 0) {
      return onlyAbsolute(
        variants.map((variant) =>
          mkStream({
            url: mpResolvePlaylistUrl(variant.url, streamUrl),
            quality: variant.quality,
            server: `Mapple - ${server.name}`,
            type: 'hls',
            headers: MAPPLE_PLAYBACK,
          }),
        ),
      );
    }
    return onlyAbsolute([
      mkStream({
        url: streamUrl,
        quality: 'Auto',
        server: `Mapple - ${server.name}`,
        type: streamUrl.includes('.m3u8') ? 'hls' : 'mp4',
        headers: MAPPLE_PLAYBACK,
      }),
    ]);
  } catch {
    return [];
  }
}

// Ported from scrapers.dart:mapple (Vyla SDK mapple.js).
async function mapple(q: FilmQuery): Promise<FoundStream[]> {
  const tv = hasEpisode(q);
  const type = tv ? 'tv' : 'movie';
  const tvSlug = tv ? `${seasonOf(q)}-${episodeOf(q)}` : '';
  const referer = tv
    ? `${MAPPLE_BASE}/tv/${q.id}/${seasonOf(q)}/${episodeOf(q)}`
    : `${MAPPLE_BASE}/movie/${q.id}`;
  const tmdbId = (numOrNull(q.id) ?? Number(q.id)) || 0;
  const session = await mpCreateSession(tmdbId, type, tvSlug, referer);
  if (session === null) return [];
  const results = await Promise.all(
    MAPPLE_SERVERS.map((server) => mpFetchServer(server, tmdbId, type, tvSlug, session)),
  );
  const seen = new Set<string>();
  return onlyAbsolute(
    results.flat().filter((stream) => {
      if (seen.has(stream.url)) return false;
      seen.add(stream.url);
      return true;
    }),
  );
}
