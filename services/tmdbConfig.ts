const LEGACY_SETTINGS_KEY = 'praha.v2.settings';
const ACTIVE_PROFILE_KEY = 'praha.v3.active-profile';
const environmentKey = (import.meta.env.VITE_TMDB_API_KEY || '').trim();

const readPersonalKey = (key: string): string => {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return '';
    const settings = JSON.parse(stored) as { tmdbApiKey?: unknown };
    return typeof settings.tmdbApiKey === 'string' ? settings.tmdbApiKey.trim() : '';
  } catch {
    return '';
  }
};

/**
 * The key belongs to the active local profile. Fall back to the pre-profile
 * (v2) settings so an upgrade keeps working, then to an optional deployment
 * environment key. PRAHA ships without a built-in key.
 */
export function getTmdbApiKey(): string {
  if (typeof window === 'undefined') return environmentKey;
  try {
    const activeRaw = window.localStorage.getItem(ACTIVE_PROFILE_KEY);
    const activeId = activeRaw ? String(JSON.parse(activeRaw)) : '';
    if (activeId) {
      const profileKey = readPersonalKey(`praha.v3.profile.${activeId}.settings`);
      if (profileKey) return profileKey;
    }
    const legacyKey = readPersonalKey(LEGACY_SETTINGS_KEY);
    return legacyKey || environmentKey;
  } catch {
    return environmentKey;
  }
}
