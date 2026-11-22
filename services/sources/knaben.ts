// Ported from VyseTV `lib/data/sources/knaben.dart` (GPL-3.0-or-later), which is
// itself a port of PlayTorrio's `lib/services/scraper/sites/knaben.dart`.
//
// Knaben is VyseTV's one built-in source: a search engine over the public torrent
// sites. It is not an iframe site and not a scraped player — it returns torrents,
// and a torrent becomes a stream through PRAHA's own TorrServer / WebTorrent path.
//
// Two things carry over exactly: the two-step search (the JSON API first, the
// search page as fallback) and `filter`, which decides whether a release is the
// requested title at all. Everything else here is plumbing to PRAHA's types.

import * as cheerio from 'cheerio';
import { nativeFetchText } from '../androidBridge';
import { parseTorrentTitle, type ParsedTorrentTitle } from './parseTorrentTitle';
import type { FoundStream } from '../filmSources';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const API = 'https://api.knaben.org/v1';
const SEARCH_TIMEOUT_MS = 20000;

/** Knaben's category groups: TV, Movies, Anime. */
const VIDEO_CATEGORIES = [2000000, 3000000, 6000000];

/** One torrent Knaben found. */
export interface KnabenHit {
  name: string;
  /** 40 lower-case hex characters. */
  infoHash: string;
  bytes?: number;
  seeders: number;
  trackers: string[];
  /** A whole season (or more) in one torrent: the episode's file is found by name when it plays. */
  pack: boolean;
}

async function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const res = await nativeFetchText(url, {
    method: options.method ?? 'GET',
    headers: { 'User-Agent': UA, ...(options.headers ?? {}) },
    body: options.body,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  return res;
}

/**
 * The info hash in a magnet link (or a bare hash), as 40 lower-case hex
 * characters. Magnets sometimes carry it in base32 (32 characters); those are
 * converted. Null when there is none.
 */
export function infoHashOf(magnetOrHash: string): string | null {
  const trimmed = (magnetOrHash || '').trim();
  const found = trimmed.match(/urn:btih:([a-zA-Z0-9]+)/);
  const raw = found ? found[1] : trimmed;

  if (/^[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();

  if (/^[a-zA-Z2-7]{32}$/.test(raw)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let hex = '';
    for (const char of raw.toUpperCase()) {
      value = (value << 5) | alphabet.indexOf(char);
      bits += 5;
      while (bits >= 4) {
        hex += ((value >> (bits - 4)) & 0xf).toString(16);
        bits -= 4;
      }
      value &= (1 << bits) - 1;
    }
    return hex.length === 40 ? hex : null;
  }
  return null;
}

/** The trackers a magnet link names (`&tr=…`). */
export function trackersOf(magnet: string): string[] {
  const out: string[] = [];
  for (const found of magnet.matchAll(/[?&]tr=([^&]+)/g)) {
    let tracker: string;
    try {
      tracker = decodeURIComponent(found[1]);
    } catch {
      continue;
    }
    if (tracker.includes('://') && !out.includes(tracker)) out.push(tracker);
  }
  return out;
}

/** `"885.68 MB"` → bytes. */
export function bytesOf(text: string): number | null {
  const found = text.match(/(\d+(?:[.,]\d+)?)\s*(TB|TiB|GB|GiB|MB|MiB|KB|KiB)\b/i);
  if (!found) return null;
  const amount = Number.parseFloat(found[1].split(',').join('.')) || 0;
  const unit = found[2].toUpperCase();
  const multiplier = unit.startsWith('T') ? 1e12 : unit.startsWith('G') ? 1e9 : unit.startsWith('M') ? 1e6 : 1e3;
  return Math.round(amount * multiplier);
}

/** The API's answer (`{"hits": [{title, hash, magnetUrl, bytes, seeders, categoryId}, …]}`). */
export function parseApi(body: string): KnabenHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const hits = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { hits?: unknown }).hits
    : undefined;
  const list = Array.isArray(hits) ? hits : [];

  const out: KnabenHit[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const hit = entry as Record<string, unknown>;
    const name = String(hit.title ?? '').trim();
    const magnet = String(hit.magnetUrl ?? '');
    const hash = infoHashOf(String(hit.hash ?? '')) ?? infoHashOf(magnet);
    if (!name || !hash) continue; // some entries only have a .torrent file

    const categories = Array.isArray(hit.categoryId)
      ? hit.categoryId.filter((value): value is number => typeof value === 'number')
      : [];
    if (categories.length && !categories.some((category) => VIDEO_CATEGORIES.includes(category - (category % 1000000)))) {
      continue;
    }

    out.push({
      name,
      infoHash: hash,
      bytes: typeof hit.bytes === 'number' ? hit.bytes : undefined,
      seeders: typeof hit.seeders === 'number' ? hit.seeders : 0,
      trackers: trackersOf(magnet),
      pack: false,
    });
  }
  return out;
}

const VIDEO_WORDS = ['movie', 'tv', 'anime', 'video'];

/**
 * The search page, the way PlayTorrio reads it: one table row per torrent, with
 * the name, the magnet link, the size (third cell) and the seeders (fifth).
 */
export function parseHtml(body: string): KnabenHit[] {
  const $ = cheerio.load(body);
  const out: KnabenHit[] = [];

  $('table tbody tr').each((_index, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;

    const name = $(row).find('.text-wrap.w-100 > a').text().trim();
    const magnet = $(row).find('a[href^="magnet:"]').attr('href') ?? '';
    const hash = infoHashOf(magnet);
    if (!name || !hash) return;

    const category = $(cells[0]).text().toLowerCase();
    // Music, books, software… are not video.
    if (!VIDEO_WORDS.some((word) => category.includes(word)) && /[a-z]/.test(category)) return;

    out.push({
      name,
      infoHash: hash,
      bytes: bytesOf($(cells[2]).text()) ?? undefined,
      seeders: Number.parseInt($(cells[4]).text().trim().split(',').join(''), 10) || 0,
      trackers: trackersOf(magnet),
      pack: false,
    });
  });
  return out;
}

const plain = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * PlayTorrio's rule: the torrent's name has to parse to exactly this title; for a
 * show, a season in the name has to be this season, and an episode in the name
 * this episode (none: a season pack, kept). Added here: a film's year in the name
 * has to be the film's, give or take one, and an episode range (E01-E04) counts
 * when the episode is inside it. Best seeded first.
 */
export function filterHits(
  hits: KnabenHit[],
  options: { title: string; series: boolean; year?: number; season?: number; episode?: number },
): KnabenHit[] {
  const { title, series, year, season, episode } = options;
  const want = plain(title);
  const out: KnabenHit[] = [];

  for (const hit of hits) {
    let parsed: ParsedTorrentTitle;
    try {
      parsed = parseTorrentTitle(hit.name);
    } catch {
      continue;
    }
    if (plain(String(parsed.title ?? '')) !== want) continue;

    const parsedYear = typeof parsed.year === 'number' ? parsed.year : null;
    if (!series) {
      if (year !== undefined && parsedYear !== null && Math.abs(parsedYear - year) > 1) continue;
      out.push(hit);
      continue;
    }

    const parsedSeason = typeof parsed.season === 'number' ? parsed.season : null;
    const parsedEpisode = typeof parsed.episode === 'number' ? parsed.episode : null;
    const range = Array.isArray(parsed.episodeRange) ? parsed.episodeRange : null;

    if (season !== undefined && parsedSeason !== null && parsedSeason !== season) continue;
    const inRange = episode !== undefined && range !== null && episode >= range[0] && episode <= range[1];
    if (episode !== undefined && parsedEpisode !== null && parsedEpisode !== episode && !inRange) continue;

    out.push({ ...hit, pack: parsedEpisode === null || range !== null });
  }

  out.sort((a, b) => b.seeders - a.seeders);
  return out;
}

/** One search: the API, or the search page when the API fails. */
async function query(search: string): Promise<KnabenHit[]> {
  try {
    const res = await request(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: search,
        search_field: 'title',
        order_by: 'seeders',
        order_direction: 'desc',
        size: 60,
        categories: VIDEO_CATEGORIES,
        hide_unsafe: true,
        hide_xxx: true,
      }),
    });
    if (res.status === 200) return parseApi(res.data);
  } catch {
    // the page below
  }

  const res = await request(`https://knaben.org/search/${encodeURIComponent(search)}/0/1/seeders`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseHtml(res.data);
}

const two = (value: number): string => String(value).padStart(2, '0');

/**
 * Torrents for a film (`series` false; `year` narrows it) or one episode of a
 * show, most seeded first. Throws when Knaben can't be reached at all.
 *
 * An episode is searched for twice, once as "s01e03" and once as "s01", so both
 * single episodes and season packs come back: a show's season page is mostly
 * other episodes.
 */
export async function searchKnaben(options: {
  title: string;
  series: boolean;
  year?: number;
  season?: number;
  episode?: number;
}): Promise<KnabenHit[]> {
  const { title, series, year, season, episode } = options;
  const clean = title.trim();
  if (!clean) return [];

  const searches: string[] = [];
  if (!series) searches.push(year !== undefined ? `${clean} ${year}` : clean);
  if (series && season !== undefined) searches.push(`${clean} s${two(season)}`);
  if (series && season !== undefined && episode !== undefined) searches.push(`${clean} s${two(season)}e${two(episode)}`);
  if (series && season === undefined) searches.push(clean);

  const lists = await Promise.all(searches.map((search) => query(search)));
  const seen = new Set<string>();
  const all: KnabenHit[] = [];
  for (const list of lists) {
    for (const hit of list) {
      if (seen.has(hit.infoHash)) continue;
      seen.add(hit.infoHash);
      all.push(hit);
    }
  }
  return filterHits(all, { title: clean, series, year, season, episode });
}

/** A release's size as Knaben's own stream line shows it. */
function sizeLabel(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Knaben's hits as PRAHA streams. `url` is empty and `infoHash` is what plays,
 * exactly like a Torrentio result: `PlayerModal` turns it into a magnet and
 * hands it to TorrServer or WebTorrent.
 */
export async function findKnabenStreams(query: {
  title: string;
  series: boolean;
  year?: number;
  season?: number;
  episode?: number;
}): Promise<FoundStream[]> {
  const hits = await searchKnaben(query);
  const out: FoundStream[] = [];

  for (const hit of hits) {
    const size = sizeLabel(hit.bytes);
    const description = [hit.name, [`👤 ${hit.seeders}`, size ? `💾 ${size}` : null, hit.pack ? 'Season pack' : null].filter(Boolean).join(' · ')].join('\n');
    out.push({
      // Empty URL: the info hash is the stream. `debridService.buildMagnetUri`
      // turns it into a magnet, and `streamTransport` reads it as a torrent.
      url: '',
      server: 'Knaben',
      quality: hit.pack ? 'Season pack' : '',
      type: 'torrent',
      headers: {},
      infoHash: hit.infoHash,
      trackers: hit.trackers,
      seeders: hit.seeders,
      size: size ?? undefined,
      description,
    });
  }
  return out;
}
