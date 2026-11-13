/**
 * Persisted search history (port of Nuvio's SearchHistoryRepository):
 * recent universal-search terms per profile-independent store, capped.
 */

const KEY = 'praha.search.history.v1';
const MAX_ENTRIES = 12;

export function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function noteSearchTerm(term: string): void {
  const clean = term.trim();
  if (!clean) return;
  try {
    const list = readSearchHistory().filter((entry) => entry.toLowerCase() !== clean.toLowerCase());
    list.unshift(clean);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable — history is best-effort.
  }
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore
  }
}
