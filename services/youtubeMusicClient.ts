/**
 * YouTube Music stream layer (InnerTube, `WEB_REMIX`).
 *
 * `musicService` already owns catalog *metadata* (iTunes + Deezer, with Flow's
 * YouTube results merged in) and `flowService` owns generic YouTube browsing and
 * the mirror fallbacks. What neither of them does is turn a track into a
 * **full-length audio-only** URL, and neither is rate-limit aware. This module is
 * that missing piece, ported from VyseTV's `youtube_audio_extractor.dart`,
 * `youtube_rate_limit_guard.dart`, `youtube_stream_http.dart` and
 * `youtube_stream_resolver.dart`.
 *
 * ## Why `music.youtube.com` + `WEB_REMIX`
 * The music surface answers with a `musicResponsiveListItemRenderer` tree and a
 * player response that already carries decipherable audio formats, so one client
 * covers both search and playback. `ANDROID` is kept as a second, bounded
 * fallback because `WEB_REMIX` sometimes answers `LOGIN_REQUIRED` for a video
 * that the Android client still streams.
 *
 * ## Signature / cipher handling — what is ported and what is not
 * The Dart never ran a JavaScript player interpreter either. It handled exactly
 * two shapes, and so does this port:
 *
 * 1. `format.url` — a ready-to-use CDN URL. Used as-is. This is what `WEB_REMIX`
 *    and `ANDROID` return for virtually every audio format today.
 * 2. `format.signatureCipher` / `format.cipher` — a query-string blob whose `sig`
 *    (or `signature`) value is already computed; it only has to be re-attached
 *    to `url` under the `sp` parameter name. Fully ported.
 *
 * **Degraded case:** a format that exposes only `s` (a signature that still needs
 * the player's JS decipher routine) or that relies on an `n` throttle transform is
 * *dropped*, never returned half-signed. There is no JS interpreter here and no
 * new dependency is allowed, so shipping such a URL would just 403 in mpv.
 * Practical effect on playback: for tracks whose best format is `s`-only, this
 * function returns `null` (or a lower-ranked plain-URL format, since formats are
 * ranked and the first *usable* one wins) and the caller falls back to its next
 * tier — Flow/mirrors in `musicService`, then the 30s Deezer/iTunes preview. You
 * get a correct-but-shorter stream instead of a broken full-length one.
 *
 * ## Caching
 * Resolved URLs are CDN-signed and expire (~6 h, carried in the URL's `expire`
 * parameter). The cache below therefore **checks `expiresAt` on every read** and
 * re-resolves when it is stale, with a 60 s safety skew. Skipping that check is
 * the bug that makes most ports of this feature die after a few hours.
 */

import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';

/** Client context InnerTube expects; WEB_REMIX is the music client. */
export interface InnerTubeClientContext {
  clientName: string;
  clientVersion: string;
  hl: string;
  gl: string;
}

export interface InnerTubeContext {
  client: InnerTubeClientContext;
}

/** A resolved, playable, audio-only stream. */
export interface YouTubeAudioStream {
  url: string;
  mimeType: string;
  bitrate: number;
  /** Approximate duration in seconds. */
  duration: number;
  /** e.g. 'opus' | 'mp4a' */
  codec: string;
  expiresAt: number;
}

/** One row of a music catalog search. */
export interface MusicSearchResult {
  /** 11-character YouTube video id — feed this to {@link resolveAudioStream}. */
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  /** Duration in seconds, or 0 when the shelf did not include it. */
  duration: number;
  thumbnail: string;
}

/** Options for {@link searchMusic}. */
export interface MusicSearchOptions {
  /** Maximum rows to return. Defaults to 20, capped at 50. */
  limit?: number;
}

/** Options for {@link resolveAudioStream}. */
export interface ResolveAudioStreamOptions {
  /**
   * Range-GET the CDN URL before returning it (one extra request per candidate).
   * Off by default: every probe costs a full round trip on the phone and eats
   * the rate-limit budget. Turn it on for "this track will not play" retries.
   */
  verify?: boolean;
}

/* ------------------------------------------------------------------ *
 * InnerTube transport
 * ------------------------------------------------------------------ */

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENT_VERSION = '2.20250217.03.00';
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 4000;

/**
 * The music client context. `hl`/`gl` are pinned to `en`/`US` so result titles and
 * the songs-filter parameter below stay in the shape this parser understands.
 */
export const INNERTUBE_CONTEXT: InnerTubeContext = {
  client: { clientName: 'WEB_REMIX', clientVersion: INNERTUBE_CLIENT_VERSION, hl: 'en', gl: 'US' },
};

/** Client contexts carry device hints beyond the four base fields. */
interface ClientContext extends InnerTubeClientContext {
  osName?: string;
  osVersion?: string;
  platform?: string;
  androidSdkVersion?: number;
}

interface InnerTubeClient {
  /** Diagnostics label. */
  key: string;
  /** Numeric id YouTube's gateway wants in `X-YouTube-Client-Name`. */
  id: string;
  origin: string;
  userAgent: string;
  context: ClientContext;
}

/**
 * Bounded, ordered client list: the music surface first, one Android fallback.
 * NOT a free-for-all loop — each entry costs a request through the rate limiter.
 */
const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
  {
    key: 'web_remix',
    id: '67',
    origin: 'https://music.youtube.com',
    userAgent: DESKTOP_USER_AGENT,
    context: INNERTUBE_CONTEXT.client,
  },
  {
    key: 'android',
    id: '3',
    origin: 'https://www.youtube.com',
    userAgent: 'com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.35',
      hl: 'en',
      gl: 'US',
      osName: 'Android',
      osVersion: '14',
      platform: 'MOBILE',
      androidSdkVersion: 34,
    },
  },
];

/** YouTube Music's "songs only" search filter (same value the Dart pins). */
const SEARCH_SONGS_PARAMS = 'EgWKAQIIAWoKEAMQBBAJEAoQBQ==';

const MAX_WALK_DEPTH = 12;
const MAX_WALK_NODES = 20000;

/** Thrown when YouTube is throttling this network. Carries the guard's message. */
export class YouTubeRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeRateLimitError';
  }
}

/** Non-2xx InnerTube reply; kept apart so 429 can be told from a plain failure. */
class YouTubeRequestError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`YouTube Music responded with ${status}.`);
    this.name = 'YouTubeRequestError';
  }
}

/**
 * Text patterns that mean "back off", ported from `isRateLimitError` in the Dart
 * guard. YouTube's bot wall does not always arrive as a 429 — it shows up as a
 * `LOGIN_REQUIRED` playability status with this prose.
 */
function isRateLimitText(text: string): boolean {
  const value = text.toLowerCase();
  return (
    value.includes('429') ||
    value.includes('rate-limit') ||
    value.includes('ratelimit') ||
    value.includes('too many requests') ||
    value.includes("sign in to confirm you're not a bot") ||
    value.includes('unusual traffic') ||
    value.includes('bot detection')
  );
}

/** Normalises any failure into the typed rate-limit error, or `null`. */
function asRateLimitError(error: unknown): YouTubeRateLimitError | null {
  if (error instanceof YouTubeRateLimitError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof YouTubeRequestError && (error.status === 429 || isRateLimitText(error.body))) {
    return new YouTubeRateLimitError(rateLimitGuard.userMessage);
  }
  if (isRateLimitText(message)) return new YouTubeRateLimitError(rateLimitGuard.userMessage);
  return null;
}

function innerTubeUrl(client: InnerTubeClient, path: 'search' | 'player'): string {
  return `${client.origin}/youtubei/v1/${path}?key=${INNERTUBE_KEY}&prettyPrint=false`;
}

function innerTubeHeaders(client: InnerTubeClient): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: client.origin,
    Referer: `${client.origin}/`,
    'User-Agent': client.userAgent,
    'X-YouTube-Client-Name': client.id,
    'X-YouTube-Client-Version': client.context.clientVersion,
  };
}

/**
 * Single POST to an InnerTube endpoint. All traffic goes through
 * `nativeFetchText`, which is the only transport that carries these headers past
 * Android's WebView restrictions.
 */
async function innerTubePost(
  client: InnerTubeClient,
  path: 'search' | 'player',
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await nativeFetchText(innerTubeUrl(client, path), {
    method: 'POST',
    headers: innerTubeHeaders(client),
    body: JSON.stringify({ context: { client: client.context }, ...body }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) throw new YouTubeRequestError(response.status, response.data);
  if (!response.data) return null;
  try {
    return JSON.parse(response.data) as unknown;
  } catch {
    throw new Error('YouTube Music returned a response PRAHA could not read.');
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiting (port of youtube_rate_limit_guard.dart)
 * ------------------------------------------------------------------ */

/** Minimum spacing between two InnerTube requests, in milliseconds. */
export const MIN_REQUEST_INTERVAL_MS = 2000;

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Consecutive failures before the circuit opens and `acquire()` starts throwing. */
const CIRCUIT_FAILURE_THRESHOLD = 5;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/**
 * Serialises every YouTube Music request, spaces them by
 * {@link MIN_REQUEST_INTERVAL_MS}, backs off exponentially on 429/bot-wall, and
 * opens a circuit breaker after repeated failures so a throttled network is not
 * hammered by a queue of playback attempts.
 */
class YouTubeRateLimitGuard {
  private tail: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private circuitUntil = 0;
  private lastReason = '';

  /**
   * Resolves when it is this caller's turn to hit the network. Rejects with
   * {@link YouTubeRateLimitError} while the circuit is open.
   */
  acquire(): Promise<void> {
    // Chaining through `tail` is what makes concurrent callers strictly
    // sequential — the Dart's `_resolverTail` did the same.
    const slot = this.tail.then(
      () => this.gate(),
      () => this.gate(),
    );
    // `tail` must never reject, or one failure would poison every later slot.
    this.tail = slot.catch(() => undefined);
    return slot;
  }

  /** Records a success and closes the circuit. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.circuitUntil = 0;
    this.lastReason = '';
  }

  /** Records a 429/bot-wall failure and grows the backoff window. */
  recordFailure(reason: string): void {
    this.consecutiveFailures += 1;
    this.lastReason = reason;
    const wait = Math.min(BASE_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
    this.backoffUntil = Date.now() + wait;
    this.circuitUntil = this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD ? this.backoffUntil : 0;
  }

  /**
   * Clears cooldowns and the minimum-interval anchor. Used by tests and by a
   * deliberate user "Retry" so a stale penalty is not replayed.
   */
  reset(): void {
    this.lastRequestAt = 0;
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.circuitUntil = 0;
    this.lastReason = '';
  }

  /** True when the circuit is open and requests are refused outright. */
  isBlocked(): boolean {
    return Date.now() < this.circuitUntil;
  }

  /** Milliseconds until the next request may leave (0 when clear). */
  waitRemainingMs(): number {
    const now = Date.now();
    return Math.max(0, this.circuitUntil - now, this.backoffUntil - now);
  }

  /** Human explanation for the UI, mirroring the Dart guard's `userMessage`. */
  get userMessage(): string {
    const wait = this.waitRemainingMs();
    return `YouTube audio source is busy on this network. Retrying in ${wait > 0 ? formatWait(wait) : 'a short while'}.`;
  }

  /** Diagnostics for logs; deliberately read-only. */
  get lastFailureReason(): string {
    return this.lastReason;
  }

  private assertAvailable(now: number): void {
    if (now < this.circuitUntil) throw new YouTubeRateLimitError(this.userMessage);
  }

  private minIntervalRemaining(now: number): number {
    if (this.lastRequestAt === 0) return 0;
    return Math.max(0, this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - now);
  }

  private async gate(): Promise<void> {
    const now = Date.now();
    this.assertAvailable(now);
    // Backoff and spacing both apply; the longer of the two wins.
    const wait = Math.max(this.backoffUntil - now, this.minIntervalRemaining(now));
    if (wait > 0) await sleep(wait);
    this.assertAvailable(Date.now());
    this.lastRequestAt = Date.now();
  }
}

/**
 * Global gate for every request this module makes. `await rateLimitGuard.acquire()`
 * before each network call; report 429/bot-wall via `recordFailure`.
 */
export const rateLimitGuard = new YouTubeRateLimitGuard();

/* ------------------------------------------------------------------ *
 * JSON helpers — all inputs are `unknown`, nothing is cast to `any`.
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Format selection
 * ------------------------------------------------------------------ */

/**
 * Ranking copied from the spec: opus 251/250/249 first (best quality per byte,
 * decoded natively by mpv), then m4a 140/139 as the container-safe fallback.
 */
const PREFERRED_AUDIO_ITAGS: readonly number[] = [251, 250, 249, 140, 139];
const UNKNOWN_ITAG_RANK = 99;

type AudioCodec = 'opus' | 'mp4a';

interface AudioFormat {
  itag: number;
  url: string;
  mimeType: string;
  bitrate: number;
  codec: AudioCodec;
  approxDurationMs: number;
  /** `n`-throttled URLs can be slowed to a crawl by the CDN; used as a tiebreak. */
  throttled: boolean;
}

function itagRank(itag: number): number {
  const index = PREFERRED_AUDIO_ITAGS.indexOf(itag);
  return index === -1 ? UNKNOWN_ITAG_RANK : index;
}

function hasThrottleParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has('n');
  } catch {
    return false;
  }
}

/**
 * Ports `_usableUrl`: plain `url`, or a `signatureCipher` whose `sig` can simply
 * be re-attached. Formats that would need JS deciphering return `null` (see the
 * header note) so they are never selected as "best".
 */
function formatUrl(format: Record<string, unknown>): string | null {
  const direct = asString(format.url);
  if (direct) return /^https?:\/\//i.test(direct) ? direct : null;

  const cipher = asString(format.signatureCipher) ?? asString(format.cipher);
  if (!cipher) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(cipher);
  } catch {
    return null;
  }
  const url = params.get('url');
  if (!url) return null;

  const signature = params.get('sig') ?? params.get('signature');
  const signatureParam = params.get('sp') ?? 'sig';
  // `s` (no `sig`) means the signature still has to be computed in JavaScript.
  if (!signature) return null;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(signatureParam)}=${encodeURIComponent(signature)}`;
}

function compareFormats(a: AudioFormat, b: AudioFormat): number {
  const rank = itagRank(a.itag) - itagRank(b.itag);
  if (rank !== 0) return rank;
  if (a.throttled !== b.throttled) return a.throttled ? 1 : -1;
  return b.bitrate - a.bitrate;
}

/**
 * Picks the best **audio-only** adaptive format. `streamingData.formats` is
 * deliberately never read: those are muxed video+audio streams, and MPV plays
 * audio-only fine, so choosing one only wastes mobile bandwidth.
 */
function pickBestAudioFormat(formats: readonly unknown[]): AudioFormat | null {
  const candidates: AudioFormat[] = [];
  for (const entry of formats) {
    const format = asRecord(entry);
    if (!format) continue;

    const mimeType = (asString(format.mimeType) ?? '').toLowerCase();
    // Anything not audio/* is muxed (or a video track) — never pick it.
    if (!mimeType.startsWith('audio/')) continue;

    const codec: AudioCodec | null = mimeType.includes('opus')
      ? 'opus'
      : mimeType.includes('mp4a')
        ? 'mp4a'
        : null;
    // ac-3/ec-3 and friends are skipped: not reliably decodable on every device.
    if (!codec) continue;

    const url = formatUrl(format);
    if (!url) continue;

    candidates.push({
      itag: Math.trunc(asNumber(format.itag) ?? 0),
      url,
      mimeType,
      bitrate: Math.trunc(asNumber(format.bitrate) ?? asNumber(format.averageBitrate) ?? 0),
      codec,
      approxDurationMs: Math.trunc(asNumber(format.approxDurationMs) ?? 0),
      throttled: hasThrottleParam(url),
    });
  }
  if (!candidates.length) return null;
  candidates.sort(compareFormats);
  return candidates[0];
}

/** CDN URLs carry their own `expire` epoch; fall back to a conservative 6 h. */
const FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;

function expiryFromUrl(url: string): number {
  try {
    const raw = new URL(url).searchParams.get('expire');
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    /* unparseable URL: fall through to the conservative TTL */
  }
  return Date.now() + FALLBACK_TTL_MS;
}

/* ------------------------------------------------------------------ *
 * Player response
 * ------------------------------------------------------------------ */

interface PlayerOutcome {
  stream: YouTubeAudioStream | null;
  /** True when the answer was the bot wall / 429 wall rather than a missing format. */
  limited: boolean;
  reason: string;
}

function durationSeconds(root: Record<string, unknown>, format: AudioFormat): number {
  const details = asRecord(root.videoDetails);
  const fromDetails = Math.trunc(asNumber(details?.lengthSeconds) ?? 0);
  if (fromDetails > 0) return fromDetails;
  if (format.approxDurationMs > 0) return Math.round(format.approxDurationMs / 1000);
  return 0;
}

/** Reads one player response into a stream, or explains why there is none. */
function inspectPlayerResponse(payload: unknown): PlayerOutcome {
  const root = asRecord(payload);
  if (!root) return { stream: null, limited: false, reason: '' };

  const playability = asRecord(root.playabilityStatus);
  const status = asString(playability?.status) ?? '';
  const reason = asString(playability?.reason) ?? '';

  if (status && status !== 'OK') {
    // The bot wall arrives as LOGIN_REQUIRED with that prose — not as a 429.
    const text = `${status} ${reason}`.trim();
    return { stream: null, limited: isRateLimitText(text), reason: text };
  }

  const streaming = asRecord(root.streamingData);
  const format = pickBestAudioFormat(asArray(streaming?.adaptiveFormats));
  if (!format) return { stream: null, limited: false, reason };

  return {
    stream: {
      url: format.url,
      mimeType: format.mimeType,
      bitrate: format.bitrate,
      duration: durationSeconds(root, format),
      codec: format.codec,
      expiresAt: expiryFromUrl(format.url),
    },
    limited: false,
    reason,
  };
}

function playerRequestBody(videoId: string): Record<string, unknown> {
  return {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  };
}

/* ------------------------------------------------------------------ *
 * Search response
 * ------------------------------------------------------------------ */

function textOf(node: unknown): string[] {
  const record = asRecord(node);
  if (!record) return [];
  const simple = asString(record.simpleText);
  if (simple) return [simple];
  const runs = asArray(record.runs);
  const out: string[] = [];
  for (const run of runs) {
    const text = asString(asRecord(run)?.text);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** Unwraps `{ musicXColumnRenderer: { text: … } }` style columns into run texts. */
function columnTexts(node: unknown): string[] {
  const record = asRecord(node);
  if (!record) return [];
  if ('text' in record) return textOf(record.text);
  for (const value of Object.values(record)) {
    const nested = asRecord(value);
    if (nested && 'text' in nested) return textOf(nested.text);
  }
  return [];
}

function thumbnailUrls(node: unknown): string[] {
  const record = asRecord(node);
  if (!record) return [];
  const list = asArray(record.thumbnails);
  if (list.length) {
    const urls: string[] = [];
    for (const entry of list) {
      const url = asString(asRecord(entry)?.url);
      if (url) urls.push(url);
    }
    return urls;
  }
  const musicThumb = asRecord(record.musicThumbnailRenderer);
  if (musicThumb) return thumbnailUrls(musicThumb.thumbnail);
  return [];
}

function findWatchVideoId(node: unknown, depth = 0): string | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findWatchVideoId(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const watch = asRecord(record.watchEndpoint);
  const direct = asString(watch?.videoId);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    const found = findWatchVideoId(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const CLOCK_PATTERN = /^\d{1,2}(:\d{2}){1,2}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** "3:45" / "1:02:10" → seconds (0 when it is not a clock). */
function parseClock(text: string | undefined): number {
  if (!text || !CLOCK_PATTERN.test(text.trim())) return 0;
  const parts = text.trim().split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseListItem(renderer: Record<string, unknown>): MusicSearchResult | null {
  const playlistItem = asRecord(renderer.playlistItemData);
  const videoId = asString(playlistItem?.videoId) ?? findWatchVideoId(renderer);
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return null;

  const flexColumns = asArray(renderer.flexColumns);
  const title = columnTexts(flexColumns[0]).join('').trim();
  if (!title) return null;

  // The subtitle is one "Artist • Album • Year/3:45" line whose runs may or may
  // not be split, so join first and split on the bullet.
  const subtitle = columnTexts(flexColumns[1]).join('');
  const segments = subtitle
    .split('•')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !CLOCK_PATTERN.test(part));

  const fixedColumns = asArray(renderer.fixedColumns);
  let duration = 0;
  for (const column of fixedColumns) {
    duration = parseClock(columnTexts(column).join('').trim());
    if (duration > 0) break;
  }
  if (duration === 0) duration = parseClock(asString(asRecord(renderer.lengthText)?.simpleText));

  const thumbnails = thumbnailUrls(renderer.thumbnail);

  return {
    videoId,
    title,
    artist: segments[0] ?? '',
    album: segments[1],
    duration,
    thumbnail: thumbnails.length ? thumbnails[thumbnails.length - 1] : '',
  };
}

/**
 * Walks the search tree for `musicResponsiveListItemRenderer` nodes. A bounded
 * walk (depth + node budget) is used instead of hardcoded paths because the
 * music response nests results under differently named shelves — top-result
 * cards, "Songs", "Videos", "Up next" — and the layout changes over time.
 */
function parseMusicSearch(payload: unknown): MusicSearchResult[] {
  const results: MusicSearchResult[] = [];
  const seen = new Set<string>();
  let budget = MAX_WALK_NODES;

  const visit = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_WALK_DEPTH || !node || typeof node !== 'object') return;
    budget -= 1;

    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    const renderer = asRecord(record.musicResponsiveListItemRenderer);
    if (renderer) {
      const parsed = parseListItem(renderer);
      if (parsed && !seen.has(parsed.videoId)) {
        seen.add(parsed.videoId);
        results.push(parsed);
      }
      // Items never nest, so skipping the subtree keeps the budget for siblings.
      return;
    }

    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return results;
}

/* ------------------------------------------------------------------ *
 * Stream cache
 * ------------------------------------------------------------------ */

const MAX_CACHED_STREAMS = 200;
/** Re-resolve this long before the CDN's own expiry, to cover clock drift. */
const CACHE_EXPIRY_SKEW_MS = 60000;

const streamCache = new Map<string, YouTubeAudioStream>();
const inFlightResolves = new Map<string, Promise<YouTubeAudioStream | null>>();

function readCachedStream(videoId: string): YouTubeAudioStream | null {
  const cached = streamCache.get(videoId);
  if (!cached) return null;
  // THE important check: a cached signed URL dies with its `expire` epoch.
  if (cached.expiresAt - CACHE_EXPIRY_SKEW_MS <= Date.now()) {
    streamCache.delete(videoId);
    return null;
  }
  return cached;
}

function writeCachedStream(videoId: string, stream: YouTubeAudioStream): void {
  // Delete-then-set moves a refreshed entry to the end of the Map's insertion
  // order, so `evictOldest` keeps evicting genuinely old entries.
  streamCache.delete(videoId);
  streamCache.set(videoId, stream);
  evictOldest(streamCache, MAX_CACHED_STREAMS);
}

/**
 * Drops every cached stream and pending resolution. Exposed for the "Retry"
 * action and for tests; playback normally never needs it.
 */
export function resetYouTubeMusicCache(): void {
  streamCache.clear();
  inFlightResolves.clear();
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Searches the YouTube Music catalog (songs only).
 *
 * Failures other than throttling degrade to an empty array so a slow music
 * backend never blocks the Music tab; a {@link YouTubeRateLimitError} is thrown
 * instead, because the caller must back off rather than retry immediately.
 */
export async function searchMusic(query: string, options: MusicSearchOptions = {}): Promise<MusicSearchResult[]> {
  const term = query.trim();
  if (!term) return [];

  const requested = options.limit ?? 20;
  const limit = Math.min(Math.max(Math.trunc(requested) || 20, 1), 50);

  const client = INNERTUBE_CLIENTS[0];
  await rateLimitGuard.acquire();

  let payload: unknown;
  try {
    payload = await innerTubePost(client, 'search', {
      query: term,
      params: SEARCH_SONGS_PARAMS,
    });
  } catch (error) {
    const limitError = asRateLimitError(error);
    if (limitError) {
      rateLimitGuard.recordFailure(limitError.message);
      throw limitError;
    }
    return [];
  }

  rateLimitGuard.recordSuccess();
  return parseMusicSearch(payload).slice(0, limit);
}

/** Range-GETs the first bytes so a dead CDN host is not handed to the player. */
async function isStreamReachable(url: string): Promise<boolean> {
  await rateLimitGuard.acquire();
  try {
    const response = await nativeFetchText(url, {
      headers: {
        Range: 'bytes=0-1',
        'User-Agent': DESKTOP_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

async function resolveUncached(
  videoId: string,
  options: ResolveAudioStreamOptions,
): Promise<YouTubeAudioStream | null> {
  for (const client of INNERTUBE_CLIENTS) {
    await rateLimitGuard.acquire();

    let payload: unknown;
    try {
      payload = await innerTubePost(client, 'player', playerRequestBody(videoId));
    } catch (error) {
      const limitError = asRateLimitError(error);
      if (limitError) {
        rateLimitGuard.recordFailure(limitError.message);
        throw limitError;
      }
      // A non-throttling failure on this client is worth one fallback attempt.
      continue;
    }

    const outcome = inspectPlayerResponse(payload);
    if (outcome.limited) {
      // The bot wall is network/account wide: another client will hit it too.
      rateLimitGuard.recordFailure(outcome.reason);
      throw new YouTubeRateLimitError(rateLimitGuard.userMessage);
    }
    if (!outcome.stream) continue;

    if (options.verify && !(await isStreamReachable(outcome.stream.url))) continue;

    rateLimitGuard.recordSuccess();
    writeCachedStream(videoId, outcome.stream);
    return outcome.stream;
  }

  return null;
}

/**
 * Resolves the best full-length **audio-only** stream for a video id.
 *
 * Returns the cached stream while its signed URL is still valid, otherwise asks
 * InnerTube (`WEB_REMIX`, then one Android fallback) and caches the result for up
 * to 200 videos. Concurrent calls for the same id share one request.
 *
 * @returns `null` when no usable audio-only format exists (e.g. the response only
 *   carried muxed streams) — never a muxed URL.
 * @throws {YouTubeRateLimitError} when YouTube is throttling this network; the
 *   message is UI-ready and `rateLimitGuard` reports the remaining wait.
 */
export async function resolveAudioStream(
  videoId: string,
  options: ResolveAudioStreamOptions = {},
): Promise<YouTubeAudioStream | null> {
  const id = videoId.trim();
  if (!VIDEO_ID_PATTERN.test(id)) return null;

  const cached = readCachedStream(id);
  if (cached) return cached;

  // Collapse concurrent requests for the same track into one network call.
  const pending = inFlightResolves.get(id);
  if (pending) return pending;

  const task = resolveUncached(id, options).finally(() => {
    inFlightResolves.delete(id);
  });
  inFlightResolves.set(id, task);
  return task;
}
