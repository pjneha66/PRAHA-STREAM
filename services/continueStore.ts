/**
 * "Continue" shelf persistence — the last-opened item per reading/listening
 * domain, so Books, Comics and Audiobooks can each offer a one-tap resume.
 * Small, capped, and self-healing: corrupt storage just means an empty shelf.
 */

export type ContinueDomain = 'book' | 'comic' | 'audiobook';

export interface ContinueEntry {
  domain: ContinueDomain;
  /** Stable item id within the domain (identifier, slug, …). */
  id: string;
  title: string;
  cover?: string;
  /** Human progress hint, e.g. "Chapter 128" or the author. */
  detail?: string;
  /** View-specific bits needed to reopen the item (source, paths, urls). */
  payload?: Record<string, unknown>;
  ts: number;
}

const KEY = 'praha.continue.v1';
const MAX_ENTRIES = 12;

export function recordContinue(entry: Omit<ContinueEntry, 'ts'>): void {
  try {
    const list = readContinue().filter((item) => !(item.domain === entry.domain && item.id === entry.id));
    list.unshift({ ...entry, ts: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // Quota or storage unavailable — the shelf is best-effort.
  }
}

export function readContinue(domain?: ContinueDomain): ContinueEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as ContinueEntry[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
      .filter((item) => !domain || item.domain === domain);
  } catch {
    return [];
  }
}

export function removeContinue(domain: ContinueDomain, id: string): void {
  try {
    const list = readContinue().filter((item) => !(item.domain === domain && item.id === id));
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Ignore
  }
}
