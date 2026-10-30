import type { UserProfile } from '../types';
import { CINEMETA_ADDON, DEFAULT_SETTINGS } from '../data/defaults';

/**
 * Profiles are a local-first feature: the profile list lives at a global key,
 * while every profile owns its own addons, sources, library, history, and
 * preferences under `praha.v3.profile.<id>.*`. Nothing leaves the browser.
 */

export const PROFILES_KEY = 'praha.v3.profiles';
export const ACTIVE_PROFILE_KEY = 'praha.v3.active-profile';

const LEGACY_KEYS: Record<string, string> = {
  addons: 'praha.v2.addons',
  'nuvio-repositories': 'praha.v2.nuvio-repositories',
  watchlist: 'praha.v2.watchlist',
  history: 'praha.v2.history',
  settings: 'praha.v2.settings',
};

/** CloudStream was removed from PRAHA; drop its leftover repository data. */
const LEGACY_CLOUDSTREAM_KEY = 'praha.v2.cloudstream-repositories';

export const profileDataKey = (profileId: string, name: string) =>
  `praha.v3.profile.${profileId}.${name}`;

function readValue<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeValue(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Unable to persist ${key}`, error);
  }
}

export function createProfileId() {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const isProfile = (value: unknown): value is UserProfile => {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<UserProfile>;
  return typeof profile.id === 'string' && profile.id.length > 0 && typeof profile.name === 'string';
};

export function profileInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

/** Copy the pre-profile (v2) library into the first profile so nothing is lost. */
function migrateLegacyProfileData(profileId: string) {
  Object.entries(LEGACY_KEYS).forEach(([name, legacyKey]) => {
    const target = profileDataKey(profileId, name);
    if (window.localStorage.getItem(target) !== null) return;
    const raw = window.localStorage.getItem(legacyKey);
    if (raw === null) return;
    try {
      window.localStorage.setItem(target, JSON.stringify(JSON.parse(raw)));
    } catch {
      /* ignore malformed legacy data */
    }
  });
  try {
    window.localStorage.removeItem(LEGACY_CLOUDSTREAM_KEY);
  } catch {
    /* ignore */
  }
}

export interface ProfileState {
  profiles: UserProfile[];
  activeId: string;
}

export function saveProfiles(profiles: UserProfile[]) {
  writeValue(PROFILES_KEY, profiles);
}

export function saveActiveProfileId(activeId: string) {
  writeValue(ACTIVE_PROFILE_KEY, activeId);
}

export function loadProfiles(): ProfileState {
  const stored = readValue<unknown>(PROFILES_KEY, null);
  let profiles = Array.isArray(stored) ? stored.filter(isProfile) : [];

  if (!profiles.length) {
    const now = Date.now();
    const profile: UserProfile = { id: createProfileId(), name: 'Guest', createdAt: now, updatedAt: now };
    migrateLegacyProfileData(profile.id);
    seedProfileData(profile.id);
    saveProfiles([profile]);
    saveActiveProfileId(profile.id);
    return { profiles: [profile], activeId: profile.id };
  }

  profiles = profiles.map((profile) => ({
    ...profile,
    createdAt: profile.createdAt || Date.now(),
    updatedAt: profile.updatedAt || profile.createdAt || Date.now(),
  }));

  const storedActive = readValue<string>(ACTIVE_PROFILE_KEY, '');
  const activeId = profiles.some((profile) => profile.id === storedActive) ? storedActive : profiles[0].id;
  saveActiveProfileId(activeId);
  return { profiles, activeId };
}

/**
 * Gives a profile a complete starting set of keys: the default Cinemeta addon,
 * an empty library and history, and (when creating profile #2+) the
 * preferences of the profile the user is currently in.
 */
export function seedProfileData(profileId: string, fromProfileId: string | null = null) {
  const ensure = (name: string, value: unknown) => {
    const key = profileDataKey(profileId, name);
    if (window.localStorage.getItem(key) === null) writeValue(key, value);
  };
  ensure('addons', [CINEMETA_ADDON]);
  ensure('watchlist', []);
  ensure('history', []);
  const inherited = fromProfileId
    ? readValue<Record<string, unknown> | null>(profileDataKey(fromProfileId, 'settings'), null)
    : null;
  ensure('settings', inherited || DEFAULT_SETTINGS);
}

export function clearProfileData(profileId: string) {
  const prefix = profileDataKey(profileId, '');
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
}

export function profileStats(profileId: string) {
  const addons = readValue<unknown[]>(profileDataKey(profileId, 'addons'), []);
  const watchlist = readValue<unknown[]>(profileDataKey(profileId, 'watchlist'), []);
  const history = readValue<unknown[]>(profileDataKey(profileId, 'history'), []);
  return {
    addons: Array.isArray(addons) ? addons.length : 0,
    saved: Array.isArray(watchlist) ? watchlist.length : 0,
    watched: Array.isArray(history) ? history.length : 0,
  };
}

const AVATAR_SIZE = 320;

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('That image could not be read.'));
  reader.readAsDataURL(file);
});

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('That file is not a readable image.'));
  image.src = src;
});

/**
 * Reads an uploaded display picture, centre-crops it to a square, and returns
 * a small JPEG data URL so several profiles fit comfortably in localStorage.
 */
export async function fileToProfileAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file (JPG, PNG, WebP, or GIF).');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('That image is larger than 12 MB. Pick a smaller one.');
  }
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const sourceX = ((image.naturalWidth || image.width) - side) / 2;
  const sourceY = ((image.naturalHeight || image.height) - side) / 2;
  context.fillStyle = '#131519';
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(image, sourceX, sourceY, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL('image/jpeg', 0.86);
}
