/** Bounded recovery: no retries while paused, seeking, hidden or after exhaustion. */
export const STALL_TIMEOUT_MS = 15_000;
export const MAX_STALL_RETRIES = 2;
export const STABLE_PLAYBACK_SECONDS = 20;

export function stallAction(stalledMs: number, attempts: number, eligible: boolean): 'wait' | 'retry' | 'fail' {
  if (!eligible || stalledMs < STALL_TIMEOUT_MS) return 'wait';
  return attempts < MAX_STALL_RETRIES ? 'retry' : 'fail';
}

/**
 * LibVLC's Buffering event carries a 0–100 fill percentage in `detail.buffer`,
 * NOT a `buffering` boolean. It fires repeatedly throughout healthy playback.
 * The loading spinner must only appear for the initial fill — showing it while
 * `playing` is true leaves the spinner stuck on top of moving video.
 */
export function vlcBufferingToWaiting(buffer: unknown, playing: boolean): boolean {
  const value = Number(buffer);
  if (!Number.isFinite(value)) return false;
  return !playing && value < 95;
}

/**
 * Container/codec support varies across Android versions and WebView builds.
 * Add a concrete hint when the URL or engine format names a known trouble spot
 * instead of leaving the user with a generic "unsupported" message.
 */
export function formatSupportHint(url: string, format?: string): string {
  const value = `${url || ''} ${format || ''}`.toLowerCase();
  if (/\.mkv\b|\bmkv\b|\bhevc\b|\bh\.?265\b/.test(value)) {
    return 'MKV/HEVC needs a device with HEVC hardware decoding; VLC or mpv usually plays it better.';
  }
  if (/\be-?ac3\b|\bac3\b|\bdts\b|\btruehd\b/.test(value)) {
    return 'It uses AC-3/E-AC-3/DTS audio, which some WebViews cannot decode — try an external player.';
  }
  if (/\bflv\b/.test(value)) {
    return 'FLV support varies by device — try an external player if the picture stays black.';
  }
  if (/\.ts\b|\bmpeg-?ts\b/.test(value)) {
    return 'MPEG-TS can fail in WebView on some devices — try an external player.';
  }
  return '';
}

export function mediaErrorMessage(code?: number, url?: string, format?: string): string {
  let base: string;
  switch (code) {
    case 1: base = 'Playback was interrupted. Retry or choose another source.'; break;
    case 2: base = 'The video network request failed. Check your connection or try another source.'; break;
    case 3: base = 'The video could not be decoded. Try another format or an external player.'; break;
    case 4: base = 'This format or source is not supported by this player. Try another source or an external player.'; break;
    default: base = 'This source could not be played. Retry or choose another source.';
  }
  const hint = url || format ? formatSupportHint(url || '', format) : '';
  return hint ? `${base} ${hint}` : base;
}
