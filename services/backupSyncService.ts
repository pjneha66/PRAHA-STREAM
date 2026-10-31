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
  profileData: Record<string, { watchlist: MediaItem[]; history: WatchProgress[] }>;
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
  const candidate = parsed as Partial<PrahaBackupBundle>;
  if (candidate.app !== 'praha-stream' || !Array.isArray(candidate.addons)) {
    throw new Error('This file is not a valid PRAHA STREAM backup.');
  }

  const profiles = Array.isArray(candidate.profiles) && candidate.profiles.length
    ? candidate.profiles
    : [{ id: 'default', name: 'Main Profile', avatarColor: '#d6f77a', createdAt: Date.now() }];

  return {
    app: 'praha-stream',
    version: Number(candidate.version || 2),
    exportedAt: Number(candidate.exportedAt || Date.now()),
    settings: normalizeSettings(candidate.settings),
    addons: candidate.addons,
    repositories: Array.isArray(candidate.repositories) ? candidate.repositories : [],
    nuvioSettings: candidate.nuvioSettings && typeof candidate.nuvioSettings === 'object' ? candidate.nuvioSettings : {},
    profiles,
    activeProfileId: candidate.activeProfileId || profiles[0].id,
    profileData: candidate.profileData && typeof candidate.profileData === 'object' ? candidate.profileData : {},
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
