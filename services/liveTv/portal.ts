// Portal browser helpers, favourites and paste-site discovery.
//
// Ported from VyseTV `lib/data/live_tv/live_favorites.dart`,
// `lib/data/live_tv/portal_names.dart` and the URL helpers in
// `lib/services/iptv/iptv_network.dart` (GPL-3.0-or-later). PasteSh AES
// decryption lives in `pasteDecryptor.ts`.

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
  from?: string;
}

const FAVORITE_KEYS = 'praha.livetv.favoriteKeys.v1';
const FAVORITE_LIST = 'praha.livetv.favoriteChannels.v1';

export function normalizePortalUrl(url: string): string {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Lower-cased identity used by both our store and VyseTV. */
export function portalKey(portal: PortalRef): string {
  return `${normalizePortalUrl(portal.url)}|${portal.username}|${portal.password}`.toLowerCase();
}

export function portalCredentialKey(portal: PortalRef): string {
  return `${portal.username}|${portal.password}`.toLowerCase();
}

function extOf(stream: PortalStreamRef, section: PortalSection): string {
  const ext = (stream.containerExt || '').trim();
  if (ext) return ext;
  return section === 'live' ? 'ts' : 'mp4';
}

/** Xtream stream URL for the browser's inline preview/player. */
export function buildPreviewUrl(portal: PortalRef, stream: PortalStreamRef, section: PortalSection = 'live'): string {
  const base = normalizePortalUrl(portal.url);
  if (!base || !stream?.streamId) return '';
  const folder = section === 'live' ? 'live' : section === 'vod' ? 'movie' : 'series';
  const user = encodeURIComponent(portal.username);
  const pass = encodeURIComponent(portal.password);
  return `${base}/${folder}/${user}/${pass}/${encodeURIComponent(stream.streamId)}.${extOf(stream, section)}`;
}

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

export function buildCategoryUrl(portal: PortalRef, section: PortalSection = 'live'): string {
  const base = normalizePortalUrl(portal.url);
  if (!base) return '';
  const action = section === 'live' ? 'get_live_categories' : section === 'vod' ? 'get_vod_categories' : 'get_series_categories';
  const query = new URLSearchParams({ username: portal.username, password: portal.password, action });
  return `${base}/player_api.php?${query.toString()}`;
}

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

// ── Per-portal favourites (LiveFavorites from Dart) ───────────────────────────

export function favoriteKey(portal: PortalRef, stream: PortalStreamRef): string {
  return `${portalKey(portal)}|${stream.streamId}`;
}

export function m3uFavoriteKey(url: string): string {
  return `m3u|${url}`;
}

export function isPortalFavorite(keys: readonly string[], portal: PortalRef, stream: PortalStreamRef): boolean {
  return keys.includes(favoriteKey(portal, stream));
}

export function toggleFavoriteKey(keys: readonly string[], key: string): string[] {
  if (!key) return [...keys];
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

export function adoptFavoriteEntries(
  entries: readonly FavoriteChannelEntry[],
  portal: PortalRef,
  streams: readonly PortalStreamRef[],
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

export function toggleFavoriteEntry(entries: readonly FavoriteChannelEntry[], entry: FavoriteChannelEntry): FavoriteChannelEntry[] {
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
  const have = new Set(entries.map((entry) => entry.key));
  return { keys: [...new Set([...keys, ...have])], entries };
}

export function saveFavoriteState(keys: readonly string[], entries: readonly FavoriteChannelEntry[]): void {
  writeJson(FAVORITE_KEYS, [...keys]);
  writeJson(FAVORITE_LIST, [...entries]);
}

// ── Paste-site discovery helpers ──────────────────────────────────────────────

const PASTE_HOSTS = ['paste.sh', 'paste.ee', 'pastee.dev', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co'];

export function isPasteSiteUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return PASTE_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  } catch {
    return false;
  }
}

export function isPasteShEncryptedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)paste\.sh$/i.test(parsed.hostname) && parsed.hash.length > 1;
  } catch {
    return false;
  }
}

export function pasteRawUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const id = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (!id) return null;
    if (host === 'pastebin.com' && !parsed.pathname.includes('/raw/')) return `https://pastebin.com/raw/${id}`;
    if (host === 'paste.ee' || host === 'pastee.dev') {
      // Paste.ee exposes `/r/{id}` as raw text; `/d/{id}` is also accepted but
      // adds a download disposition on some mirrors.
      return `https://${host}/r/${id}`;
    }
    if (host === 'pastes.dev') return `https://api.pastes.dev/${id}`;
    if (host === 'rentry.co' && !parsed.pathname.includes('/raw')) return `https://rentry.co/${id}/raw`;
    return null;
  } catch {
    return null;
  }
}
