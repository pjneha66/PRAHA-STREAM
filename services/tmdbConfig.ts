const SETTINGS_STORAGE_KEY = 'praha.v2.settings';
const environmentKey = (import.meta.env.VITE_TMDB_API_KEY || '').trim();

/**
 * The user's personal key always wins. Self-hosted deployments can optionally
 * provide VITE_TMDB_API_KEY, but PRAHA ships without a built-in key.
 */
export function getTmdbApiKey(): string {
  if (typeof window === 'undefined') return environmentKey;
  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) return environmentKey;
    const settings = JSON.parse(stored) as { tmdbApiKey?: unknown };
    const personalKey = typeof settings.tmdbApiKey === 'string' ? settings.tmdbApiKey.trim() : '';
    return personalKey || environmentKey;
  } catch {
    return environmentKey;
  }
}
