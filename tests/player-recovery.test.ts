import { describe, it, expect } from 'vitest';
import { vlcBufferingToWaiting, stallAction, formatSupportHint, mediaErrorMessage } from '../components/player/recovery';

describe('LibVLC buffering → loading spinner', () => {
  it('never shows the spinner while playback is already running', () => {
    // The native bridge emits `{ buffer: 0..100 }` repeatedly during normal
    // playback. Previously reading a non-existent `buffering` boolean defaulted
    // to true and pinned the spinner over moving video.
    for (const buffer of [0, 5, 40, 80, 100]) {
      expect(vlcBufferingToWaiting(buffer, true)).toBe(false);
    }
  });

  it('shows the spinner only for a low initial fill before playback starts', () => {
    expect(vlcBufferingToWaiting(0, false)).toBe(true);
    expect(vlcBufferingToWaiting(60, false)).toBe(true);
    expect(vlcBufferingToWaiting(95, false)).toBe(false);
    expect(vlcBufferingToWaiting(100, false)).toBe(false);
  });

  it('ignores missing or malformed buffer values', () => {
    expect(vlcBufferingToWaiting(undefined, true)).toBe(false);
    expect(vlcBufferingToWaiting(undefined, false)).toBe(false);
    expect(vlcBufferingToWaiting('nope', false)).toBe(false);
    expect(vlcBufferingToWaiting(NaN, false)).toBe(false);
  });
});

describe('format-aware error messages', () => {
  it('keeps the generic message when the format is unknown', () => {
    expect(mediaErrorMessage(4)).toBe('This format or source is not supported by this player. Try another source or an external player.');
    expect(formatSupportHint('https://example.com/video.mp4', 'direct')).toBe('');
  });

  it('names MKV/HEVC and AC-3/DTS trouble spots and points to external players', () => {
    expect(formatSupportHint('https://example.com/movie.mkv', 'direct')).toMatch(/HEVC/);
    expect(formatSupportHint('https://example.com/stream?codec=hevc', 'direct')).toMatch(/MKV\/HEVC/);
    expect(formatSupportHint('https://example.com/audio.eac3', 'direct')).toMatch(/AC-3/);
    expect(formatSupportHint('https://example.com/stream', 'mpegts')).toMatch(/MPEG-TS/);
  });

  it('appends the hint to decode failures', () => {
    const message = mediaErrorMessage(3, 'https://example.com/live.ts', 'mpegts');
    expect(message).toContain('could not be decoded');
    expect(message).toContain('MPEG-TS');
  });
});

describe('bounded stall recovery', () => {
  it('waits while paused/seeking or before the stall timeout', () => {
    expect(stallAction(0, 0, true)).toBe('wait');
    expect(stallAction(20_000, 0, false)).toBe('wait');
  });

  it('retries up to the budget, then fails', () => {
    expect(stallAction(20_000, 0, true)).toBe('retry');
    expect(stallAction(20_000, 1, true)).toBe('retry');
    expect(stallAction(20_000, 2, true)).toBe('fail');
  });
});
