// Synced and plain lyrics, from lrclib.net.
//
// Ported from VyseTV `lib/services/music/lyrics_service.dart` (GPL-3.0-or-later).
// The Dart is a three-attempt cascade, and each attempt matters:
//
//   1. `/api/get` with the exact title, artist, album and duration — the
//      duration is what disambiguates a studio cut from a live version.
//   2. `/api/get` again with the title/artist *cleaned* (brackets, "- Live",
//      "feat." stripped) and no album or duration, for when the catalog's
//      title carries the noise lrclib does not index.
//   3. `/api/search?q=` over "artist title", taking the first hit.
//
// Results are cached per track id — including misses, so a track that has no
// lyrics is not re-fetched on every render.
//
// The Dart also returns `plainLyrics` for tracks lrclib only knows as
// unsynced text; that is kept here as a separate field rather than being
// flattened into the synced list.

import { nativeFetchText } from '../androidBridge';
import { evictOldest } from '../cacheCaps';

export interface SyncedLyricLine {
  /** Offset from the start of the track, in seconds. */
  time: number;
  text: string;
}

export interface LyricsData {
  trackId: string;
  isSynced: boolean;
  /** Unsynced text, or the synced source when no plain text was supplied. */
  plainLyrics: string;
  syncedLines: SyncedLyricLine[];
}

export const EMPTY_LYRICS: LyricsData = {
  trackId: '',
  isSynced: false,
  plainLyrics: '',
  syncedLines: [],
};

/** VyseTV's own UA; lrclib asks callers to identify themselves. */
const LYRICS_USER_AGENT = 'VyseTV/1.0.0';
const LYRICS_TIMEOUT_MS = 6000;
const CACHE_LIMIT = 60;

const lyricsCache = new Map<string, LyricsData>();

/**
 * Matches one LRC timestamp prefix and the text after it.
 *
 * Port of `LyricsService.parseLrc`'s expression: `^\[(\d{2}):(\d{2})\.?(\d{2,3})?\](.*)$`.
 * It is anchored, so a line carrying several timestamps yields only the first
 * one — that is the Dart's behaviour and it is preserved here.
 */
const LRC_LINE = /^\[(\d{2}):(\d{2})\.?(\d{2,3})?\](.*)$/;

/** Parses LRC text into timed lines, sorted ascending. */
export function parseLrc(lrcContent: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];

  for (const rawLine of lrcContent.split('\n')) {
    const found = rawLine.trim().match(LRC_LINE);
    if (!found) continue;

    const minutes = Number(found[1]);
    const seconds = Number(found[2]);
    // A 2-digit fraction is centiseconds, a 3-digit one is milliseconds.
    const rawFraction = found[3] ?? '00';
    const millis = rawFraction.length === 2 ? Number(rawFraction) * 10 : Number(rawFraction);

    lines.push({
      time: minutes * 60 + seconds + millis / 1000,
      text: (found[4] ?? '').trim(),
    });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/** Index of the line active at `time`, or -1 before the first one. */
export function activeLyricIndex(lines: SyncedLyricLine[], time: number): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (time >= lines[index].time) return index;
  }
  return -1;
}

/** Removes every `(...)` group, keeping the rest verbatim. */
function stripParens(input: string): string {
  let out = '';
  let depth = 0;
  for (const char of input) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      if (depth > 0) depth -= 1;
      else out += char;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

/** Removes every `[...]` group, keeping the rest verbatim. */
function stripBrackets(input: string): string {
  let out = '';
  let depth = 0;
  for (const char of input) {
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      if (depth > 0) depth -= 1;
      else out += char;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

/** Drops everything from the first `marker` onwards. */
function cutFrom(input: string, marker: string): string {
  const index = input.toLowerCase().indexOf(marker.toLowerCase());
  return index === -1 ? input : input.slice(0, index);
}

/**
 * Strips the decoration lrclib's index does not carry. Port of `_clean`, in
 * the same order: bracketed groups, then `- …`, `feat.…`, `ft.…` tails.
 */
function clean(input: string): string {
  let value = stripBrackets(stripParens(input));
  value = cutFrom(value, '- ');
  value = cutFrom(value, 'feat.');
  value = cutFrom(value, 'ft.');
  return value.trim();
}

function toLyricsData(trackId: string, payload: unknown): LyricsData | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const synced = typeof record.syncedLyrics === 'string' ? record.syncedLyrics : null;
  const plain = typeof record.plainLyrics === 'string' ? record.plainLyrics : null;

  if (synced && synced.trim()) {
    return {
      trackId,
      isSynced: true,
      plainLyrics: plain ?? synced,
      syncedLines: parseLrc(synced),
    };
  }
  if (plain && plain.trim()) {
    return { trackId, isSynced: false, plainLyrics: plain, syncedLines: [] };
  }
  return null;
}

/** Port of `_fetchLrcLib`: one `/api/get` attempt. */
async function fetchLrcLib(
  trackId: string,
  title: string,
  artist: string,
  album: string | null,
  duration: number | null,
): Promise<LyricsData | null> {
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album && album !== 'Single') params.set('album_name', album);
  if (duration && duration > 0) params.set('duration', String(duration));

  try {
    const response = await nativeFetchText(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: { 'User-Agent': LYRICS_USER_AGENT },
      timeoutMs: LYRICS_TIMEOUT_MS,
    });
    if (response.status !== 200 || !response.data) return null;
    return toLyricsData(trackId, JSON.parse(response.data));
  } catch {
    return null;
  }
}

/** Port of `_searchLrcLib`: the last-resort free-text search. */
async function searchLrcLib(trackId: string, query: string): Promise<LyricsData | null> {
  try {
    const response = await nativeFetchText(
      `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': LYRICS_USER_AGENT }, timeoutMs: LYRICS_TIMEOUT_MS },
    );
    if (response.status !== 200 || !response.data) return null;
    const list = JSON.parse(response.data);
    if (!Array.isArray(list) || !list.length) return null;
    return toLyricsData(trackId, list[0]);
  } catch {
    return null;
  }
}

export interface LyricsTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

/**
 * Lyrics for a track. Port of `LyricsService.getLyrics`: never throws, and
 * returns {@link EMPTY_LYRICS} when all three attempts miss.
 */
export async function fetchLyrics(track: LyricsTrack): Promise<LyricsData> {
  const cached = lyricsCache.get(track.id);
  if (cached) return cached;

  const cleanTitle = clean(track.title);
  const cleanArtist = clean(track.artist);

  let result = await fetchLrcLib(
    track.id,
    track.title,
    track.artist,
    track.album && track.album.length ? track.album : null,
    track.duration && track.duration > 0 ? track.duration : null,
  );

  result ??= await fetchLrcLib(track.id, cleanTitle, cleanArtist, null, null);
  result ??= await searchLrcLib(track.id, `${cleanArtist} ${cleanTitle}`);

  const value = result ?? EMPTY_LYRICS;
  lyricsCache.set(track.id, value);
  evictOldest(lyricsCache, CACHE_LIMIT);
  return value;
}

export function resetLyricsCache(): void {
  lyricsCache.clear();
}
