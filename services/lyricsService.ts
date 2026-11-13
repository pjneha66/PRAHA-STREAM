import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';

/**
 * Synced lyrics (LRC parsing + lrclib.net fetch): returns timestamped lines
 * for the active track, or null when nothing is available offline-free.
 */

export interface LyricLine {
  time: number;
  text: string;
}

const lyricsCache = new Map<string, LyricLine[] | null>();

function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const matches = Array.from(raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g));
    if (!matches.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      lines.push({ time: minutes * 60 + seconds + fraction, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export async function fetchSyncedLyrics(track: { title: string; artist: string; duration?: number }): Promise<LyricLine[] | null> {
  const cacheKey = `${track.artist}:${track.title}`.toLowerCase();
  if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey)!;
  try {
    const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(track.title)}&artist_name=${encodeURIComponent(track.artist)}${track.duration ? `&duration=${Math.round(track.duration)}` : ''}`;
    const response = await nativeFetchText(url, { headers: { Accept: 'application/json' }, timeoutMs: 6000 });
    if (response.ok && response.data) {
      const results = JSON.parse(response.data) as Array<{ syncedLyrics?: string; instrumental?: boolean }>;
      const withLyrics = results.find((entry) => entry.syncedLyrics && !entry.instrumental);
      const parsed = withLyrics?.syncedLyrics ? parseLrc(withLyrics.syncedLyrics) : null;
      const value = parsed && parsed.length ? parsed : null;
      lyricsCache.set(cacheKey, value);
      evictOldest(lyricsCache, 60);
      return value;
    }
  } catch {
    // Lyrics are best-effort.
  }
  lyricsCache.set(cacheKey, null);
  return null;
}

/** Index of the line active at the given playback time (-1 before the first). */
export function activeLyricIndex(lines: LyricLine[], time: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= time + 0.2) index = i;
    else break;
  }
  return index;
}
