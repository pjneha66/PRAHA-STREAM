// Portal browser helpers: preview/Catalogue URL builders and per-portal favourites.
//
// Mirrors VyseTV's `xtreamUrl`, `LiveFavorites` and paste-site discovery
// (`lib/data/live_tv/live_favorites.dart`, `lib/services/iptv/iptv_network.dart`),
// GPL-3.0-or-later. PasteSh AES-CBC decryption itself is already implemented in
// `services/iptvService.ts` (`PasteShDecryptor`) and is deliberately not copied.

export type PortalSection = 'live' | 'vod' | 'series';

export interface PortalRef {
  url: string;
  username: string;
  password: string;
  source?: string;
}

export interface PortalStreamRef {
  streamId: string;
  name: string;
  icon?: string;
  categoryId?: string;
  containerExt?: string;
  kind?: PortalSection;
  epgChannelId?: string;
}

export interface FavoriteChannelEntry {
  key: string;
  title: string;
  url: string;
  logo?: string;
  /** Portal or playlist name shown under the starred channel. */
  from?: string;
}

const FAVORITE_KEYS = 'praha.livetv.favoriteKeys.v1';
const FAVORITE_LIST = 'praha.livetv.favoriteChannels.v1';

/** Lower-cased identity used by both our store and VyseTV. */
export function portalKey(portal: PortalRef): string {
  return `${normalizePortalUrl(portal.url)}|${portal.username}|${portal.password}`.toLowerCase();
}

/** Credentials alone identify a subscription across changed portal URLs. */
export function portalCredentialKey(portal: PortalRef): string {
  return `${portal.username}|${portal.password}`.toLowerCase();
}

/** Trim trailing slashes and add a scheme when the pasted portal omitted one. */
export function normalizePortalUrl(url: string): string {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function extOf(stream: PortalStreamRef, section: PortalSection): string {
  const ext = (stream.containerExt || '').trim();
  if (ext) return ext;
  return section === 'live' ? 'ts' : 'mp4';
}

/**
 * Xtream stream URL for the browser's inline preview/player. Credentials are
 * percent-encoded (VyseTV writes them raw), which keeps `@`, `/` and `:` in a
 * password from breaking the path.
 */
export function buildPreviewUrl(
  portal: PortalRef,
  stream: PortalStreamRef,
  section: PortalSection = 'live',
): string {
  const base = normalizePortalUrl(portal.url);
  if (!base || !stream?.streamId) return '';
  const folder = section === 'live' ? 'live' : section === 'vod' ? 'movie' : 'series';
  const user = encodeURIComponent(portal.username);
  const pass = encodeURIComponent(portal.password);
  return `${base}/${folder}/${user}/${pass}/${encodeURIComponent(stream.streamId)}.${extOf(stream, section)}`;
}

/** Short-EPG endpoint behind a live preview card. */
export function buildEpgPreviewUrl(portal: PortalRef, streamId: string, limit = 2): string {
  const base = normalizePortalUrl(portal.url);
  if (!base || !streamId) return '';
  const query = new URLSearchParams({
    username: portal.username,
    password: portal.password,
    action: 'get_short_epg',
    stream_id: streamId,
    limit: String(Math.max(1, Math.floor(limit))),
  });
  return `${base}/player_api.php?${query.toString()}`;
}

/** Category endpoint used to populate the browser's left pane. */
export function buildCategoryUrl(portal: PortalRef, section: PortalSection = 'live'): string {
  const base = normalizePortalUrl(portal.url);
  if (!base) return '';
  const action = section === 'live' ? 'get_live_categories' : section === 'vod' ? 'get_vod_categories' : 'get_series_categories';
  const query = new URLSearchParams({ username: portal.username, password: portal.password, action });
  return `${base}/player_api.php?${query.toString()}`;
}

/** Parse a `player_api.php` stream list into the small shape the browser needs. */
export function parsePortalStreams(raw: unknown, section: PortalSection = 'live'): PortalStreamRef[] {
  if (!Array.isArray(raw)) return [];
  const out: PortalStreamRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const streamId = String(row.stream_id ?? row.id ?? '').trim();
    if (!streamId) continue;
    out.push({
      streamId,
      name: String(row.name ?? row.title ?? 'Live Channel'),
      icon: row.stream_icon ? String(row.stream_icon) : row.cover ? String(row.cover) : undefined,
      categoryId: row.category_id ? String(row.category_id) : undefined,
      containerExt: row.container_extension ? String(row.container_extension) : undefined,
      kind: section,
      epgChannelId: row.epg_channel_id ? String(row.epg_channel_id) : undefined,
    });
  }
  return out;
}

// ── Per-portal favourites ─────────────────────────────────────────────────────

/** Same channel on two portals is two favourites. */
export function favoriteKey(portal: PortalRef, stream: PortalStreamRef): string {
  return `${portalKey(portal)}|${stream.streamId}`;
}

export function m3uFavoriteKey(url: string): string {
  return `m3u|${url}`;
}

export function isPortalFavorite(keys: readonly string[], portal: PortalRef, stream: PortalStreamRef): boolean {
  const key = favoriteKey(portal, stream);
  return keys.includes(key);
}

/** Toggle a key immutably, so React can compare the returned set by identity. */
export function toggleFavoriteKey(keys: readonly string[], key: string): string[] {
  if (!key) return [...keys];
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

/**
 * Favourites starred before a portal was opened have only a key. Once its
 * stream list arrives, fill in name/logo/URL and join the saved list.
 */
export function adoptFavoriteEntries(
  entries: readonly FavoriteChannelEntry[],
  portal: PortalRef,
  streams: readonly PortalStreamRef[],
  /** Starred keys; keys without a saved entry get their details filled in. */
  keys: readonly string[] = entries.map((entry) => entry.key),
): FavoriteChannelEntry[] {
  const prefix = `${portalKey(portal)}|`;
  const have = new Set(entries.map((entry) => entry.key));
  const adopted: FavoriteChannelEntry[] = [];
  for (const stream of streams) {
    const key = favoriteKey(portal, stream);
    if (!keys.includes(key) || !key.startsWith(prefix) || have.has(key)) continue;
    adopted.push({
      key,
      title: stream.name,
      url: buildPreviewUrl(portal, stream, stream.kind || 'live'),
      logo: stream.icon,
      from: portal.source || portal.username,
    });
  }
  return adopted.length ? [...entries, ...adopted] : [...entries];
}

/** Add/replace one saved favourite in the newest-first list. */
export function toggleFavoriteEntry(
  entries: readonly FavoriteChannelEntry[],
  entry: FavoriteChannelEntry,
): FavoriteChannelEntry[] {
  const without = entries.filter((item) => item.key !== entry.key);
  return entries.some((item) => item.key === entry.key) ? without : [entry, ...without];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota: favourites stay in memory for this session.
  }
}

export function loadFavoriteState(): { keys: string[]; entries: FavoriteChannelEntry[] } {
  const keys = readJson<string[]>(FAVORITE_KEYS, []).filter((key) => typeof key === 'string');
  const rawEntries = readJson<FavoriteChannelEntry[]>(FAVORITE_LIST, []);
  const entries = Array.isArray(rawEntries)
    ? rawEntries.filter((entry) => entry && typeof entry.key === 'string' && typeof entry.url === 'string' && entry.url)
    : [];
  // Keep keys starred before the saved list existed.
  const have = new Set(entries.map((entry) => entry.key));
  return { keys: [...new Set([...keys, ...have])], entries };
}

export function saveFavoriteState(keys: readonly string[], entries: readonly FavoriteChannelEntry[]): void {
  writeJson(FAVORITE_KEYS, [...keys]);
  writeJson(FAVORITE_LIST, [...entries]);
}

// ── Paste-site discovery helpers ──────────────────────────────────────────────

const PASTE_HOSTS = ['paste.sh', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co'];

export function isPasteSiteUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return PASTE_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  } catch {
    return false;
  }
}

/** True for a paste.sh link carrying its AES key in the URL fragment. */
export function isPasteShEncryptedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)paste\.sh$/i.test(parsed.hostname) && parsed.hash.length > 1;
  } catch {
    return false;
  }
}

/** Raw-text URL for the paste hosts that expose one; `null` means use the URL as-is. */
export function pasteRawUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const id = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (!id) return null;
    if (host === 'pastebin.com' && !parsed.pathname.includes('/raw/')) return `https://pastebin.com/raw/${id}`;
    if (host === 'pastes.dev') return `https://api.pastes.dev/${id}`;
    if (host === 'rentry.co' && !parsed.pathname.includes('/raw')) return `https://rentry.co/${id}/raw`;
    return null;
  } catch {
    return null;
  }
}
