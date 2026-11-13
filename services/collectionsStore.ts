/**
 * Watchlist collections (port of Nuvio's collection folders, minimal shape):
 * named groups of watchlist item ids, persisted, JSON-import/export friendly.
 */

export interface Collection {
  name: string;
  ids: string[];
}

const KEY = 'praha.collections.v1';
const MAX_COLLECTIONS = 30;

export function readCollections(): Collection[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Collection[]) : [];
    return Array.isArray(parsed)
      ? parsed
        .filter((entry) => entry && typeof entry.name === 'string' && Array.isArray(entry.ids))
        .slice(0, MAX_COLLECTIONS)
      : [];
  } catch {
    return [];
  }
}

export function saveCollections(collections: Collection[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(collections.slice(0, MAX_COLLECTIONS)));
  } catch {
    // best effort
  }
}
