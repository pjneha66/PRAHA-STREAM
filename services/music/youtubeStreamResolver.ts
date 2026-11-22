// The stream resolution chain: track → playable URL.
//
// Ported from VyseTV `lib/services/music/youtube_stream_resolver.dart`
// (GPL-3.0-or-later). This is the order that matters, and it is preserved
// exactly:
//
//   1. rate-limit gate      — refuse to hammer YouTube while cooling down
//   2. per-track stream cache — already resolved, return it
//   3. cached video id      — we found the song before, reuse the id
//   4. title+artist extract — the real work: search, then player sweep
//   5. Convertytmp3 mp3     — YouTube refused, the mirror converts it
//   6. Deezer 30 s preview  — last resort, better than silence
//
// Timeouts are the Dart's: 8 s for a cached id, 12 s for a fresh search.

import { evictOldest } from '../cacheCaps';
import { getStreamUrl as convertytmp3StreamUrl, CONVERTYTMP3_USER_AGENT } from './convertytmp3Client';
import type { MusicTrack } from './musicTrack';
import { extractAudio, getAudioUrl } from './youtubeAudioExtractor';
import { youtubeRateLimitGuard } from './youtubeRateLimitGuard';

const CACHED_ID_TIMEOUT_MS = 8000;
const FRESH_SEARCH_TIMEOUT_MS = 12000;
const CACHE_LIMIT = 200;

/** The Deezer preview CDN wants a browser UA, not a media-player one. */
const PREVIEW_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface ResolvedStream {
  url: string;
  userAgent?: string;
}

/** track id → the YouTube video id we matched it to. */
const videoIdByTrack = new Map<string, string>();
/** track id → the resolved stream, so replays skip the network. */
const streamByTrack = new Map<string, ResolvedStream>();

function rememberVideoId(trackId: string, videoId: string): void {
  videoIdByTrack.delete(trackId);
  videoIdByTrack.set(trackId, videoId);
  evictOldest(videoIdByTrack, CACHE_LIMIT);
}

function rememberStream(trackId: string, stream: ResolvedStream): void {
  streamByTrack.delete(trackId);
  streamByTrack.set(trackId, stream);
  evictOldest(streamByTrack, CACHE_LIMIT);
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

/** Drops both per-track caches. Used by Retry and by tests. */
export function resetStreamResolverCache(): void {
  videoIdByTrack.clear();
  streamByTrack.clear();
}

/**
 * Forgets the stream URL for one track, keeping its video id.
 *
 * The Dart has no equivalent, because its player re-resolves through the same
 * cache and therefore gets the same address back. That is only harmless there
 * because the extractor re-mints when the URL's own `expire` has passed. A
 * URL that 403s *before* its expiry (connection change, CDN edge gone) would
 * be retried forever, so a caller that knows the address is dead drops it here
 * and the next resolve starts from the cached video id.
 */
export function forgetStreamUrl(trackId: string): void {
  streamByTrack.delete(trackId);
}

/**
 * Resolves a track to a playable stream, or `null` when every tier failed.
 * Port of `YoutubeStreamResolver.resolveUrl`.
 */
export async function resolveUrl(track: MusicTrack): Promise<ResolvedStream | null> {
  // 1. Cooling down after a rate-limit: fail fast rather than add traffic.
  if (youtubeRateLimitGuard.isLimited) return null;

  // 2. Already resolved this session.
  const cachedStream = streamByTrack.get(track.id);
  if (cachedStream) return cachedStream;

  // 3. We know the video id from an earlier search.
  const cachedVideoId = videoIdByTrack.get(track.id);
  if (cachedVideoId) {
    const result = await withTimeout(getAudioUrl(cachedVideoId), CACHED_ID_TIMEOUT_MS);
    if (result) {
      const stream: ResolvedStream = { url: result.url, userAgent: result.userAgent };
      rememberStream(track.id, stream);
      return stream;
    }
    // The cached id no longer resolves (taken down, region-locked): forget it.
    videoIdByTrack.delete(track.id);
  }

  // 4. Search by title + artist. This is the only tier the guard spaces out.
  try {
    const extracted = await youtubeRateLimitGuard.runLowRequest(() =>
      withTimeout(
        extractAudio(track.title, track.artist, {
          targetDuration: track.durationSeconds > 0 ? track.durationSeconds : null,
        }),
        FRESH_SEARCH_TIMEOUT_MS,
      ),
    );

    if (extracted) {
      rememberVideoId(track.id, extracted.videoId);
      const stream: ResolvedStream = { url: extracted.url, userAgent: extracted.userAgent };
      rememberStream(track.id, stream);
      return stream;
    }
  } catch {
    /* guard cooldown or a transport failure — fall through to the mirror */
  }

  // 5. The mp3 mirror, using the id the extractor found (if it got that far).
  const videoId = videoIdByTrack.get(track.id);
  if (videoId) {
    const mirrorUrl = await withTimeout(convertytmp3StreamUrl(videoId), FRESH_SEARCH_TIMEOUT_MS);
    if (mirrorUrl) return { url: mirrorUrl, userAgent: CONVERTYTMP3_USER_AGENT };
  }

  // 6. Deezer's own 30-second preview.
  if (track.previewUrl) {
    return { url: track.previewUrl, userAgent: PREVIEW_USER_AGENT };
  }

  return null;
}

/** Why the guard is holding us back, if it is. Drives the player's message. */
export function streamResolverMessage(): string | null {
  return youtubeRateLimitGuard.isLimited ? youtubeRateLimitGuard.userMessage : null;
}
