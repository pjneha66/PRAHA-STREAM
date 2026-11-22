// YouTube audio extractor: title+artist → videoId → full-length audio-only URL.
//
// Ported from VyseTV `lib/services/music/youtube_audio_extractor.dart`
// (GPL-3.0-or-later). This is the piece that makes VyseTV's music play *full
// songs* rather than 30-second previews, and it is deliberately more involved
// than a "give me the best format" helper:
//
//  1. **Search by title + artist**, not by track id. Catalog ids from Deezer
//     are meaningless to YouTube, so the song is located by scoring search
//     results against the requested title, artist and duration.
//  2. **Three player clients** (visionOS, Android, iOS) are swept, because a
//     single client routinely answers LOGIN_REQUIRED for a video another still
//     streams. Every audio format from every client becomes a candidate.
//  3. **Candidates are ranked** by bitrate, then by whether the URL carries an
//     `n` throttle parameter, then by container, then by client priority.
//  4. **The first reachable candidate wins**, with `mn` CDN host rotation so a
//     dead `sn-` edge does not fail the whole track.
//
// Signature/cipher handling is unchanged from the Dart: a plain `url` is used
// as-is, and a `signatureCipher` is used only when it already carries a
// computed `sig` to re-attach under `sp`. A format exposing only `s` needs the
// player's JS decipher routine, which neither the Dart nor this port runs, so
// such a format is dropped rather than shipped half-signed.
//
// ## InnerTube key
// The Dart hardcodes YouTube's public web client key as a fallback. That is a
// credential literal in source, so this port does not carry one: the key is
// scraped from the watch page at runtime (the normal path, cached for 3 h) and
// may be supplied through `VITE_YOUTUBE_INNERTUBE_KEY` when scraping is blocked.

import { nativeFetchText } from '../androidBridge';
import { evictOldest } from '../cacheCaps';
import { DESKTOP_USER_AGENT } from './youtubeStreamHttp';

const CONFIG_TTL_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_VIDEO_CANDIDATES = 2;
const VIDEO_IDS_TTL_MS = 12 * 60 * 60 * 1000;
const STREAM_TTL_MS = 4 * 60 * 60 * 1000;
/** Port of `extract`'s per-candidate timeout. */
const CANDIDATE_TIMEOUT_MS = 4000;

/** Android-TV-flavoured desktop UA: YouTube serves a plain player to it. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

interface YtClient {
  key: string;
  /** Numeric id for `X-YouTube-Client-Name`. */
  id: string;
  version: string;
  userAgent: string;
  context: Record<string, unknown>;
  priority: number;
}

/** Search runs as plain WEB on www.youtube.com, with the songs filter. */
const SEARCH_CLIENT: YtClient = {
  key: 'web_search',
  id: '1',
  version: '2.20250217.03.00',
  userAgent: DEFAULT_USER_AGENT,
  context: {
    clientName: 'WEB',
    clientVersion: '2.20250217.03.00',
    hl: 'en',
    gl: 'US',
    platform: 'DESKTOP',
  },
  priority: 99,
};

/** Player clients, in the Dart's order (lowest priority number first). */
const PLAYER_CLIENTS: readonly YtClient[] = [
  {
    key: 'visionos',
    id: '101',
    version: '1.02',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    context: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US',
    },
    priority: 0,
  },
  {
    key: 'android',
    id: '3',
    version: '20.10.35',
    userAgent: 'com.google.android.youtube/20.10.35 (Linux; U; Android 14; en_US) gzip',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.35',
      osName: 'Android',
      osVersion: '14',
      platform: 'MOBILE',
      androidSdkVersion: 34,
      hl: 'en',
      gl: 'US',
    },
    priority: 1,
  },
  {
    key: 'ios',
    id: '5',
    version: '20.10.1',
    userAgent: 'com.google.ios.youtube/20.10.1 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)',
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.1',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '17.4.0.21E219',
      platform: 'MOBILE',
      hl: 'en',
      gl: 'US',
    },
    priority: 2,
  },
];

/** A resolved stream plus the User-Agent the CDN URL was signed for. */
export interface ExtractedAudio {
  url: string;
  userAgent: string;
}

export interface ExtractedTrack extends ExtractedAudio {
  videoId: string;
}

/* ------------------------------------------------------------------ *
 * Small JSON helpers
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

/** Port of `_dig`: walks maps and numeric list indices. */
function dig(root: unknown, keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(key, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return current;
}

/* ------------------------------------------------------------------ *
 * Config (API key + visitor data)
 * ------------------------------------------------------------------ */

interface CachedConfig {
  apiKey: string;
  visitorData: string | null;
  fetchedAt: number;
  forced: boolean;
}

let configCache: CachedConfig | null = null;
let configInFlight: Promise<CachedConfig | null> | null = null;

function configExpired(config: CachedConfig): boolean {
  return Date.now() - config.fetchedAt >= CONFIG_TTL_MS;
}

/** Optional deployment-supplied key; never committed to source. */
function envInnertubeKey(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = env?.VITE_YOUTUBE_INNERTUBE_KEY;
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Reads `"KEY":"value"` out of the watch page. Port of `_extractQuoted`. */
function extractQuoted(body: string, key: string): string | null {
  const index = body.indexOf(`"${key}":"`);
  if (index === -1) return null;
  const start = index + key.length + 4;
  const end = body.indexOf('"', start);
  if (end === -1) return null;
  return body.slice(start, end);
}

async function fetchConfig(forced: boolean): Promise<CachedConfig | null> {
  let apiKey: string | null = null;
  let visitorData: string | null = null;

  try {
    const response = await nativeFetchText('https://www.youtube.com/watch?v=dQw4w9WgXcQ&hl=en', {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 200 && response.data) {
      apiKey = extractQuoted(response.data, 'INNERTUBE_API_KEY');
      visitorData = extractQuoted(response.data, 'VISITOR_DATA');
    }
  } catch {
    /* fall through to the env override */
  }

  const resolvedKey = apiKey || envInnertubeKey();
  if (!resolvedKey) return null;

  const config: CachedConfig = { apiKey: resolvedKey, visitorData, fetchedAt: Date.now(), forced };
  configCache = config;
  return config;
}

function ensureConfig(forceRefresh = false): Promise<CachedConfig | null> {
  const existing = configCache;
  if (!forceRefresh && existing && !configExpired(existing)) return Promise.resolve(existing);
  if (configInFlight) return configInFlight;

  const task = fetchConfig(forceRefresh).finally(() => {
    configInFlight = null;
  });
  configInFlight = task;
  return task;
}

/* ------------------------------------------------------------------ *
 * InnerTube transport
 * ------------------------------------------------------------------ */

function commonHeaders(config: CachedConfig, client: YtClient): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
    'User-Agent': client.userAgent,
    'X-YouTube-Client-Name': client.id,
    'X-YouTube-Client-Version': client.version,
  };
  if (config.visitorData) headers['X-Goog-Visitor-Id'] = config.visitorData;
  return headers;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await nativeFetchText(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (response.status !== 200) throw new Error(`YouTube responded with ${response.status}.`);
  if (!response.data) return {};
  const parsed = JSON.parse(response.data) as unknown;
  return asRecord(parsed) ?? {};
}

function fetchPlayer(config: CachedConfig, videoId: string, client: YtClient): Promise<Record<string, unknown>> {
  const url = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}`;
  return postJson(url, commonHeaders(config, client), {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: { client: client.context },
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  });
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

interface VideoCandidate {
  id: string;
  title: string;
  duration: number | null;
  isLive: boolean;
}

function firstRunText(node: unknown): string | null {
  const record = asRecord(node);
  if (!record) return null;
  const runs = asArray(record.runs);
  const first = asRecord(runs[0]);
  return first ? (asString(first.text) ?? null) : null;
}

function extractLengthText(renderer: Record<string, unknown>): string | null {
  const length = asRecord(renderer.lengthText);
  if (!length) return null;
  return asString(length.simpleText) ?? firstRunText(length);
}

function extractTitleText(renderer: Record<string, unknown>): string | null {
  const title = asRecord(renderer.title);
  if (!title) return null;
  return asString(title.simpleText) ?? firstRunText(title);
}

/** "3:45" / "1:02:10" → seconds. Port of `_parseDuration`. */
function parseDuration(text: string | null): number | null {
  if (!text) return null;
  const parts = text.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** Port of `_flattenSearchResults`: classic `videoRenderer` rows. */
function flattenSearchResults(data: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const contents = dig(data, [
    'contents',
    'twoColumnSearchResultsRenderer',
    'primaryContents',
    'sectionListRenderer',
    'contents',
  ]);
  if (!Array.isArray(contents)) return out;

  for (const section of contents) {
    const items = dig(section, ['itemSectionRenderer', 'contents']);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const record = asRecord(item);
      if (!record) continue;
      const renderer = asRecord(record.videoRenderer) ?? asRecord(record.compactVideoRenderer);
      if (renderer) out.push(renderer);
    }
  }
  return out;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
}

const VARIANT_PENALTIES: Record<string, number> = {
  '8d': 700,
  slowed_reverb: 600,
  nightcore: 600,
  lofi: 500,
  instrumental: 500,
  remix: 400,
  cover: 400,
  live: 300,
  acoustic: 300,
  extended: 200,
};

/** Port of `_detectVariants`: which "versions" a title mentions. */
function detectVariants(text: string): Set<string> {
  const tags = new Set<string>();
  if (/\b(8d|16d|spatial\s?audio?|binaural|360|surround)\b/.test(text)) tags.add('8d');
  if (/\b(slowed|reverb)\b/.test(text)) tags.add('slowed_reverb');
  if (/\b(nightcore|sped\s?up)\b/.test(text)) tags.add('nightcore');
  if (/\blo\s?fi\b/.test(text)) tags.add('lofi');
  if (/\b(instrumental|karaoke|no\svo[ck]als?|backing\s?track)\b/.test(text)) tags.add('instrumental');
  if (/\b(remix|mashup|bootleg|flip|vip\smix|reedit)\b/.test(text)) tags.add('remix');
  if (/\b(live\b|in\sconcert|live\sat|live\sfrom)\b/.test(text)) tags.add('live');
  if (/\b(acoustic|unplugged)\b/.test(text)) tags.add('acoustic');
  if (/\bcover\b/.test(text)) tags.add('cover');
  if (/\b(extended\s(mix|version)|full\sversion)\b/.test(text)) tags.add('extended');
  return tags;
}

/**
 * Port of `_searchInnerTubeCandidates`: scores up to ten search results and
 * returns at most {@link MAX_VIDEO_CANDIDATES} ids, best first.
 */
async function searchInnerTubeCandidates(
  config: CachedConfig,
  query: string,
  options: { title: string; artist: string; targetDuration?: number | null; titleVersion?: string | null },
): Promise<string[]> {
  const url = `https://www.youtube.com/youtubei/v1/search?key=${encodeURIComponent(config.apiKey)}`;
  const data = await postJson(url, commonHeaders(config, SEARCH_CLIENT), {
    query,
    params: 'EgWKAQIIAWoKEAMQBBAJEAoQBQ==',
    context: { client: SEARCH_CLIENT.context },
  });

  const results = flattenSearchResults(data);
  const candidates: VideoCandidate[] = [];

  for (const renderer of results.slice(0, 10)) {
    const videoId = asString(renderer.videoId);
    if (!videoId || videoId.length !== 11) continue;

    let isLive = false;
    const badges = renderer.badges;
    if (Array.isArray(badges) && badges.length) {
      // The Dart stringifies the whole badge object, so any "live" inside it
      // (e.g. BADGE_STYLE_TYPE_LIVE_NOW) marks the row. JSON.stringify keeps
      // that behaviour; reading the badge as a string would yield
      // "[object Object]" and never match.
      if (JSON.stringify(badges[0]).toLowerCase().includes('live')) isLive = true;
    }

    candidates.push({
      id: videoId,
      title: extractTitleText(renderer) ?? '',
      duration: parseDuration(extractLengthText(renderer)),
      isLive,
    });
  }

  if (!candidates.length) return [];

  const normSongTitle = normalise(options.title);
  const normArtist = normalise(options.artist);
  const normVersion = normalise(options.titleVersion ?? '');
  const targetVariants = detectVariants(`${normSongTitle} ${normVersion}`);

  const scored: Array<{ id: string; score: number }> = [];

  for (const candidate of candidates) {
    if (candidate.isLive) continue;
    if (candidate.duration !== null && candidate.duration < 30) continue;

    const normCandTitle = normalise(candidate.title);
    let score = 0;

    if (normSongTitle && normCandTitle.includes(normSongTitle)) {
      score += 100;
    } else {
      const songWords = normSongTitle.split(/\s+/).filter((word) => word.length > 2);
      if (songWords.length) {
        let matching = 0;
        for (const word of songWords) if (normCandTitle.includes(word)) matching += 1;
        score += (matching / songWords.length) * 60;
      }
    }

    if (normVersion && normCandTitle.includes(normVersion)) score += 40;
    if (normArtist && normCandTitle.includes(normArtist)) score += 30;

    const candVariants = detectVariants(normCandTitle);
    const allVariants = new Set<string>([...targetVariants, ...candVariants]);
    for (const tag of allVariants) {
      if (targetVariants.has(tag) === candVariants.has(tag)) {
        score += 15;
      } else {
        score -= VARIANT_PENALTIES[tag] ?? 350;
      }
    }

    const target = options.targetDuration;
    if (target != null && target > 0 && candidate.duration !== null) {
      const diff = Math.abs(candidate.duration - target);
      if (diff <= 4) score += 80;
      else if (diff <= 10) score += 25;
      else if (diff <= 20) score += 5;
      else if (diff <= 40) score -= diff * 2;
      else score -= diff * 5;
    }

    scored.push({ id: candidate.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  // Ranked ids first, then every remaining candidate as a fallback pool.
  const ranked = [...scored.map((entry) => entry.id), ...candidates.map((entry) => entry.id)];
  return Array.from(new Set(ranked)).slice(0, MAX_VIDEO_CANDIDATES);
}

/* ------------------------------------------------------------------ *
 * Video id cache
 * ------------------------------------------------------------------ */

interface CachedVideoIds {
  videoIds: string[];
  cachedAt: number;
}

const videoIdCache = new Map<string, CachedVideoIds>();

function readCachedVideoIds(key: string): string[] | null {
  const cached = videoIdCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt >= VIDEO_IDS_TTL_MS) {
    videoIdCache.delete(key);
    return null;
  }
  return cached.videoIds;
}

function writeCachedVideoIds(key: string, videoIds: string[]): void {
  videoIdCache.delete(key);
  videoIdCache.set(key, { videoIds, cachedAt: Date.now() });
  evictOldest(videoIdCache, 200);
}

/**
 * Locates candidate video ids for a song. Port of `searchVideoIds`, including
 * the query-suffix heuristic and the forced-config retry.
 */
export async function searchVideoIds(
  title: string,
  artist: string,
  options: { targetDuration?: number | null; titleVersion?: string | null } = {},
): Promise<string[]> {
  const queryTitle = options.titleVersion ? `${title} ${options.titleVersion}` : title;

  const queryLower = queryTitle.toLowerCase();
  const versionLower = (options.titleVersion ?? '').toLowerCase();
  let suffix: string;
  if (queryLower.includes('live') || versionLower.includes('live')) suffix = 'live';
  else if (queryLower.includes('remix') || versionLower.includes('remix')) suffix = 'remix';
  else if (queryLower.includes('acoustic')) suffix = 'acoustic';
  else suffix = 'official audio';

  const searchQuery = `${queryTitle} ${artist} ${suffix}`.trim();
  const cacheKey = options.targetDuration
    ? `${searchQuery}|${Math.round(options.targetDuration)}`
    : searchQuery;

  const cached = readCachedVideoIds(cacheKey);
  if (cached) return cached;

  // The scorer needs the title and artist themselves, not just the query.
  const scoreOptions = { ...options, title, artist };

  const config = await ensureConfig();
  if (!config) return [];

  try {
    const ids = await searchInnerTubeCandidates(config, searchQuery, scoreOptions);
    if (ids.length) writeCachedVideoIds(cacheKey, ids);
    return ids;
  } catch {
    if (config.forced) return [];
    // A stale API key is the usual cause; retry once with a freshly scraped one.
    configCache = null;
    try {
      const fresh = await ensureConfig(true);
      if (!fresh) return [];
      const ids = await searchInnerTubeCandidates(fresh, searchQuery, scoreOptions);
      if (ids.length) writeCachedVideoIds(cacheKey, ids);
      return ids;
    } catch {
      return [];
    }
  }
}

/** First candidate id, or `null`. Port of `searchVideoId`. */
export async function searchVideoId(
  title: string,
  artist: string,
  options: { targetDuration?: number | null; titleVersion?: string | null } = {},
): Promise<string | null> {
  const ids = await searchVideoIds(title, artist, options);
  return ids.length ? ids[0] : null;
}

/* ------------------------------------------------------------------ *
 * Format selection
 * ------------------------------------------------------------------ */

interface AudioCandidate {
  clientKey: string;
  clientPriority: number;
  userAgent: string;
  url: string;
  score: number;
  hasN: boolean;
  itag: string;
  ext: string;
}

function hasNParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has('n');
  } catch {
    return false;
  }
}

function containerPreference(ext: string): number {
  const value = ext.toLowerCase();
  if (value === 'm4a' || value === 'mp4') return 0;
  if (value === 'webm') return 1;
  return 2;
}

/**
 * Port of `_usableUrl`: a plain `url`, or a `signatureCipher` whose `sig` only
 * needs re-attaching. Formats needing JS deciphering yield `null`.
 */
function usableUrl(format: Record<string, unknown>): string | null {
  const plain = asString(format.url);
  if (plain) return plain;

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
  if (!signature) return null;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(signatureParam)}=${encodeURIComponent(signature)}`;
}

function expiresAtFromUrl(url: string): number | null {
  try {
    const seconds = Number(new URL(url).searchParams.get('expire'));
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

/** Range-GETs one byte. Port of `_isUrlReachable`. */
async function isUrlReachable(url: string, userAgent: string): Promise<boolean> {
  try {
    const response = await nativeFetchText(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: 1500,
    });
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

/**
 * Port of `_resolveReachableUrl`: rotates the `mn` server list into alternate
 * `sn-` hosts and races them, because a signed URL is often only dead on the
 * one edge it was minted for.
 */
async function resolveReachableUrl(url: string, userAgent: string): Promise<string | null> {
  if (!url.includes('googlevideo.com')) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const mnParam = parsed.searchParams.get('mn');
  if (!mnParam) return (await isUrlReachable(url, userAgent)) ? url : null;

  const servers = mnParam.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (servers.length < 2) return (await isUrlReachable(url, userAgent)) ? url : null;

  const candidates: string[] = [url];
  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i];
    const currentHost = parsed.hostname;
    const altHost = currentHost
      .replace(/^rr\d+---/, `rr${i + 1}---`)
      .replace(/sn-[a-z0-9]+-[a-z0-9]+/, server);
    if (altHost !== currentHost) candidates.push(url.replace(currentHost, altHost));
  }

  if (candidates.length === 1) {
    return (await isUrlReachable(candidates[0], userAgent)) ? candidates[0] : null;
  }

  // Race every candidate; the first reachable one wins.
  const winner = await new Promise<string | null>((resolve) => {
    let settled = false;
    for (const candidate of candidates) {
      void isUrlReachable(candidate, userAgent).then((reachable) => {
        if (reachable && !settled) {
          settled = true;
          resolve(candidate);
        }
      });
    }
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 2000);
  });
  if (winner) return winner;

  // The race timed out: fall back to asking about the original directly.
  return (await isUrlReachable(candidates[0], userAgent)) ? candidates[0] : null;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

async function extractAudioInternal(
  videoId: string,
  options: { forceRefreshConfig: boolean },
): Promise<ExtractedAudio | null> {
  const config = await ensureConfig(options.forceRefreshConfig);
  if (!config) return null;

  const candidates: AudioCandidate[] = [];
  let loginRequired = 0;

  for (const client of PLAYER_CLIENTS) {
    let player: Record<string, unknown>;
    try {
      player = await fetchPlayer(config, videoId, client);
    } catch {
      continue;
    }

    const playability = asRecord(player.playabilityStatus);
    const status = asString(playability?.status);

    if (status === 'LOGIN_REQUIRED') {
      loginRequired += 1;
      continue;
    }
    if (status && status !== 'OK') continue;

    const streaming = asRecord(player.streamingData);
    if (!streaming) continue;

    // Audio-only adaptive formats: the good ones.
    for (const entry of asArray(streaming.adaptiveFormats)) {
      const format = asRecord(entry);
      if (!format) continue;
      const url = usableUrl(format);
      if (!url) continue;

      const mimeType = (asString(format.mimeType) ?? '').toLowerCase();
      if (!mimeType.includes('audio/')) continue;

      const bitrate = asNumber(format.bitrate) ?? asNumber(format.averageBitrate) ?? 0;
      const sampleRate = Number.parseFloat(asString(format.audioSampleRate) ?? '') || 0;

      candidates.push({
        clientKey: client.key,
        clientPriority: client.priority,
        userAgent: client.userAgent,
        url,
        score: bitrate * 1_000_000 + sampleRate,
        hasN: hasNParam(url),
        itag: asString(format.itag) ?? '',
        ext: mimeType.includes('webm') ? 'webm' : 'm4a',
      });
    }

    // Muxed formats: a last resort, but still playable audio.
    for (const entry of asArray(streaming.formats)) {
      const format = asRecord(entry);
      if (!format) continue;
      const url = usableUrl(format);
      if (!url) continue;

      const bitrate = asNumber(format.bitrate) ?? asNumber(format.averageBitrate) ?? 0;
      candidates.push({
        clientKey: client.key,
        clientPriority: client.priority,
        userAgent: client.userAgent,
        url,
        score: bitrate,
        hasN: hasNParam(url),
        itag: asString(format.itag) ?? '',
        ext: 'mp4',
      });
    }
  }

  // Every client hit the bot wall: the config is stale, drop it.
  if (loginRequired === PLAYER_CLIENTS.length) {
    configCache = null;
    return null;
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.hasN !== b.hasN) return a.hasN ? 1 : -1;
    const container = containerPreference(a.ext) - containerPreference(b.ext);
    if (container !== 0) return container;
    return a.clientPriority - b.clientPriority;
  });

  for (const best of candidates) {
    const reachable = await resolveReachableUrl(best.url, best.userAgent);
    if (reachable) return { url: reachable, userAgent: best.userAgent };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Stream cache
 * ------------------------------------------------------------------ */

interface CachedStream extends ExtractedAudio {
  expiresAt: number | null;
  cachedAt: number;
}

const streamCache = new Map<string, CachedStream>();

function streamExpired(cached: CachedStream): boolean {
  if (cached.expiresAt !== null) {
    // Re-resolve a minute before the CDN's own expiry.
    return Date.now() > cached.expiresAt - 60_000;
  }
  return Date.now() - cached.cachedAt >= STREAM_TTL_MS;
}

function writeCachedStream(videoId: string, stream: ExtractedAudio): void {
  streamCache.delete(videoId);
  streamCache.set(videoId, {
    url: stream.url,
    userAgent: stream.userAgent,
    expiresAt: expiresAtFromUrl(stream.url),
    cachedAt: Date.now(),
  });
  evictOldest(streamCache, 200);
}

/** Drops every cached id, stream and config. Used by Retry and by tests. */
export function resetYoutubeExtractorCache(): void {
  videoIdCache.clear();
  streamCache.clear();
  configCache = null;
  configInFlight = null;
}

/**
 * Resolves a video id to a playable audio URL. Port of `getAudioUrl`: cached
 * first, then one attempt, then one retry with a fresh config.
 */
export async function getAudioUrl(videoId: string): Promise<ExtractedAudio | null> {
  const cached = streamCache.get(videoId);
  if (cached && !streamExpired(cached)) {
    return { url: cached.url, userAgent: cached.userAgent };
  }

  let result = await extractAudioInternal(videoId, { forceRefreshConfig: false });
  if (!result) result = await extractAudioInternal(videoId, { forceRefreshConfig: true });

  if (result) writeCachedStream(videoId, result);
  return result;
}

/** Resolves to `null` instead of rejecting when the timeout wins. */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);

    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Port of `extract`: locate the song, then resolve its first candidate. */
export async function extractAudio(
  title: string,
  artist: string,
  options: { targetDuration?: number | null; titleVersion?: string | null } = {},
): Promise<ExtractedTrack | null> {
  const ids = await searchVideoIds(title, artist, options);
  for (const id of ids.slice(0, 1)) {
    // The Dart gives each candidate four seconds, then gives up on it. Without
    // this, one slow player response eats the resolver's whole 12 s budget.
    const audio = await withTimeout(getAudioUrl(id), CANDIDATE_TIMEOUT_MS);
    if (audio) return { videoId: id, url: audio.url, userAgent: audio.userAgent };
  }
  return null;
}

export const YOUTUBE_EXTRACTOR_USER_AGENT = DESKTOP_USER_AGENT;
