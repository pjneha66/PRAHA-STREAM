// Live TV guide helpers — pure EPG maths used by channel rows and the player.
//
// Ported from VyseTV's `lib/data/live_tv/live_guide.dart` (GPL-3.0-or-later).
// Kept free of React / native dependencies so it can be tested directly.

/** EPG timestamps arrive as epoch seconds, epoch millis, or an ISO-ish string. */
export type EpgTime = number | string | Date;

export interface EpgProgram {
  title: string;
  description?: string;
  start: EpgTime;
  stop: EpgTime;
  /** Extra portal fields (channel id, base64 raw text …) survive normalisation. */
  [key: string]: unknown;
}

export interface NormalisedEpgProgram extends EpgProgram {
  startMs: number;
  stopMs: number;
}

export interface NowNext {
  now: NormalisedEpgProgram | null;
  next: NormalisedEpgProgram | null;
}

/** Convert any of the timestamp shapes Xtream / M3U / ESPN use into epoch millis. */
export function toEpochMs(value: EpgTime): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Xtream's `start_timestamp` / `end_timestamp` are seconds. Anything above
    // 1e11 is already millis (dates after year 5138 in seconds are irrelevant).
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^-?\d+$/.test(text)) return toEpochMs(Number(text));
  // "2026-11-21 20:00:00" is common in Xtream JSON; Date.parse handles the T
  // form more reliably across engines.
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sort a guide by start time and drop rows with an unusable window. Returns
 * new objects; callers' arrays (and the existing NSFW gating) are untouched.
 */
export function normaliseGuide(guide: readonly EpgProgram[]): NormalisedEpgProgram[] {
  const out: NormalisedEpgProgram[] = [];
  for (const entry of guide || []) {
    if (!entry || typeof entry !== 'object') continue;
    const startMs = toEpochMs(entry.start);
    const stopMs = toEpochMs(entry.stop);
    if (startMs === null || stopMs === null || stopMs <= startMs) continue;
    out.push({ ...entry, startMs, stopMs });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.stopMs - b.stopMs);
}

/**
 * The programme on now and the one after it, from a guide sorted by start.
 * A row ending exactly at `at` is already over; one starting exactly at `at`
 * is on now (VyseTV's `NowNext.of`).
 */
export function nowNext(guide: readonly EpgProgram[], at: number | Date = Date.now()): NowNext {
  const t = at instanceof Date ? at.getTime() : at;
  let now: NormalisedEpgProgram | null = null;
  let next: NormalisedEpgProgram | null = null;
  for (const entry of normaliseGuide(guide)) {
    if (entry.startMs <= t && entry.stopMs > t) {
      if (!now) now = entry;
    } else if (entry.startMs > t) {
      next = entry;
      break;
    }
  }
  return { now, next };
}

/** How far through the current programme the clock is, clamped to 0…1. */
export function epgProgress(current: NormalisedEpgProgram | null, at: number | Date = Date.now()): number {
  if (!current) return 0;
  const t = at instanceof Date ? at.getTime() : at;
  const span = current.stopMs - current.startMs;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (t - current.startMs) / span));
}

/** "17:05", the way the Live TV player writes guide times. */
export function guideTime(at: number | string | Date): string {
  const ms = toEpochMs(at);
  if (ms === null) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Compact "17:05 – 18:00" label for a now/next row. */
export function guideWindow(entry: EpgProgram): string {
  return `${guideTime(entry.start)} – ${guideTime(entry.stop)}`;
}

/** True when a row has a programme on now at the supplied instant. */
export function isProgramLive(entry: EpgProgram, at: number | Date = Date.now()): boolean {
  const t = at instanceof Date ? at.getTime() : at;
  const start = toEpochMs(entry.start);
  const stop = toEpochMs(entry.stop);
  return start !== null && stop !== null && start <= t && stop > t;
}

/** Drop rows that ended before `at`; a refresh that fails can keep older data safely. */
export function upcomingGuide(guide: readonly EpgProgram[], at: number | Date = Date.now()): NormalisedEpgProgram[] {
  const t = at instanceof Date ? at.getTime() : at;
  return normaliseGuide(guide).filter((entry) => entry.stopMs > t);
}
