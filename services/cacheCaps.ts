/**
 * Cache caps (audit M-open): module-level Map caches grow for the lifetime of
 * the session. Any writer that pushes a cache past `maxEntries` evicts the
 * oldest entries (Map preserves insertion order, so first key = oldest).
 */
export function evictOldest<K, V>(store: Map<K, V>, maxEntries: number): void {
  while (store.size > maxEntries) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}
