import type { IntroSegment } from '../types';
import { nativeFetchText } from './androidBridge';

const introCache = new Map<string, IntroSegment[]>();

/**
 * Queries IntroDB (`api.introdb.app`) for community-verified episode intro
 * timestamps so the built-in player can offer a one-tap "Skip Intro" button.
 */
export async function fetchIntroSegments(
  imdbId?: string,
  season?: number,
  episode?: number,
): Promise<IntroSegment[]> {
  if (!imdbId || !imdbId.startsWith('tt') || !season || !episode) return [];
  const cacheKey = `${imdbId}:${season}:${episode}`;
  if (introCache.has(cacheKey)) return introCache.get(cacheKey)!;

  try {
    const url = `https://api.introdb.app/intro?imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${episode}`;
    const res = await nativeFetchText(url, { timeoutMs: 6000 });
    if (!res.ok) {
      introCache.set(cacheKey, []);
      return [];
    }
    const data = JSON.parse(res.data) as {
      start_sec?: number;
      end_sec?: number;
      start_ms?: number;
      end_ms?: number;
    };
    const start = typeof data.start_sec === 'number'
      ? data.start_sec
      : typeof data.start_ms === 'number'
        ? data.start_ms / 1000
        : null;
    const end = typeof data.end_sec === 'number'
      ? data.end_sec
      : typeof data.end_ms === 'number'
        ? data.end_ms / 1000
        : null;

    if (start !== null && end !== null && end > start + 5) {
      const segments: IntroSegment[] = [{ start, end, label: 'Skip Intro' }];
      introCache.set(cacheKey, segments);
      return segments;
    }
  } catch {
    // Non-fatal: simply hide Skip Intro when unavailable.
  }

  introCache.set(cacheKey, []);
  return [];
}
