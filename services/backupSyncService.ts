import { normalizeSettings } from '../data/defaults';
import type {
  AppSettings, InstalledAddon, MediaItem, NuvioRepository,
  PrahaBackupBundle, SyncSettings, UserProfile, WatchProgress,
} from '../types';
import { nativeFetchText } from './androidBridge';

export function createBackupBundle(params: {
  settings: AppSettings;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  nuvioSettings: Record<string, Record<string, unknown>>;
  profiles: UserProfile[];
  activeProfileId: string;
  profileData: PrahaBackupBundle['profileData'];
}): PrahaBackupBundle {
  return {
    app: 'praha-stream',
    version: 2,
    exportedAt: Date.now(),
    settings: params.settings,
    addons: params.addons,
    repositories: params.repositories,
    nuvioSettings: params.nuvioSettings,
    profiles: params.profiles,
    activeProfileId: params.activeProfileId,
    profileData: params.profileData,
  };
}

const MAX_BACKUP_ADDONS = 500;
const MAX_BACKUP_PROFILES = 50;
const MAX_BACKUP_REPOSITORIES = 200;
const MAX_SCRAPER_CODE_LENGTH = 200_000;
/** Keys that can rewrite an object's prototype when spread or merged. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structured clone of untrusted JSON that drops prototype-pollution keys and
 * caps recursion. A backup file is attacker-supplied when a user imports one
 * they were handed, so nothing below may trust its shape.
 */
function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 2000).map((item) => sanitizeJson(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = sanitizeJson(item, depth + 1);
  }
  return clean;
}

function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function validateAndParseBackup(rawJson: string): PrahaBackupBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Backup file is empty or malformed.');
  }
  const candidate = sanitizeJson(parsed) as Partial<PrahaBackupBundle>;
  if (!isPlainObject(candidate) || candidate.app !== 'praha-stream' || !Array.isArray(candidate.addons)) {
    throw new Error('This file is not a valid PRAHA STREAM backup.');
  }
  if (candidate.addons.length > MAX_BACKUP_ADDONS) {
    throw new Error(`Backup contains more than ${MAX_BACKUP_ADDONS} addons.`);
  }

  // Addons carry a manifest URL that is fetched and rendered, so every entry
  // must be a structurally valid addon with an http(s), credential-free URL.
  const addons: InstalledAddon[] = [];
  for (const entry of candidate.addons) {
    if (!isPlainObject(entry)) throw new Error('Backup contains a malformed addon entry.');
    const manifestUrl = safeHttpUrl(entry.manifestUrl);
    if (!manifestUrl) throw new Error('Backup contains an addon with an invalid manifest URL.');
    if (!isPlainObject(entry.manifest)) throw new Error('Backup contains an addon without a manifest.');
    addons.push({
      manifestUrl,
      manifest: entry.manifest as unknown as InstalledAddon['manifest'],
      enabled: entry.enabled !== false,
      installedAt: Number(entry.installedAt) || Date.now(),
      updatedAt: Number(entry.updatedAt) || Date.now(),
    });
  }

  const rawProfiles = Array.isArray(candidate.profiles) ? candidate.profiles.slice(0, MAX_BACKUP_PROFILES) : [];
  const profiles: UserProfile[] = [];
  for (const entry of rawProfiles) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    profiles.push({
      ...(entry as unknown as UserProfile),
      id,
      name,
      avatarColor: typeof entry.avatarColor === 'string' ? entry.avatarColor : '#d6f77a',
      createdAt: Number(entry.createdAt) || Date.now(),
    });
  }
  if (!profiles.length) {
    profiles.push({ id: 'default', name: 'Main Profile', avatarColor: '#d6f77a', createdAt: Date.now() });
  }

  const repositories = (Array.isArray(candidate.repositories) ? candidate.repositories : [])
    .slice(0, MAX_BACKUP_REPOSITORIES)
    .filter((entry): entry is NuvioRepository => {
      if (!isPlainObject(entry)) return false;
      if (!safeHttpUrl(entry.manifestUrl)) return false;
      return Array.isArray(entry.scrapers);
    });

  const nuvioSettings = isPlainObject(candidate.nuvioSettings) ? candidate.nuvioSettings : {};
  for (const value of Object.values(nuvioSettings)) {
    if (!isPlainObject(value)) continue;
    const code = value.code;
    if (typeof code === 'string' && code.length > MAX_SCRAPER_CODE_LENGTH) {
      throw new Error('Backup contains an oversized scraper script.');
    }
  }

  return {
    app: 'praha-stream',
    version: Number(candidate.version || 2),
    exportedAt: Number(candidate.exportedAt || Date.now()),
    settings: normalizeSettings(candidate.settings),
    addons,
    repositories,
    nuvioSettings: nuvioSettings as PrahaBackupBundle['nuvioSettings'],
    profiles,
    activeProfileId: candidate.activeProfileId || profiles[0].id,
    profileData: isPlainObject(candidate.profileData)
      ? (candidate.profileData as PrahaBackupBundle['profileData'])
      : {},
  };
}

/**
 * Optional scrobble / history sync to Trakt.tv and Simkl when the user has
 * configured their personal tokens in Settings → Backup & Sync.
 */
export async function scrobbleWatchProgress(
  entry: WatchProgress,
  sync: SyncSettings,
): Promise<void> {
  if (entry.progress < 75) return;
  const ids: Record<string, string | number> = {};
  if (entry.media.tmdbId) ids.tmdb = entry.media.tmdbId;
  if (entry.media.imdbId) ids.imdb = entry.media.imdbId;
  if (!Object.keys(ids).length) return;

  // Trakt.tv history sync
  if (sync.traktToken?.trim() && sync.traktClientId?.trim()) {
    const payload = entry.media.type === 'movie'
      ? { movies: [{ ids, watched_at: new Date(entry.watchedAt).toISOString() }] }
      : {
          shows: [{
            ids,
            seasons: [{
              number: entry.season || 1,
              episodes: [{ number: entry.episode || 1, watched_at: new Date(entry.watchedAt).toISOString() }],
            }],
          }],
        };
    await nativeFetchText('https://api.trakt.tv/sync/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sync.traktToken.trim()}`,
        'trakt-api-version': '2',
        'trakt-api-key': sync.traktClientId.trim(),
      },
      body: JSON.stringify(payload),
      timeoutMs: 8000,
    }).catch(() => undefined);
  }

  // Simkl history sync
  if (sync.simklToken?.trim() && sync.simklClientId?.trim()) {
    const payload = entry.media.type === 'movie'
      ? { movies: [{ ids, watched_at: new Date(entry.watchedAt).toISOString() }] }
      : {
          shows: [{
            title: entry.media.title,
            ids,
            seasons: [{
              number: entry.season || 1,
              episodes: [{ number: entry.episode || 1 }],
            }],
          }],
        };
    await nativeFetchText('https://api.simkl.com/sync/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sync.simklToken.trim()}`,
        'simkl-api-key': sync.simklClientId.trim(),
      },
      body: JSON.stringify(payload),
      timeoutMs: 8000,
    }).catch(() => undefined);
  }
}
