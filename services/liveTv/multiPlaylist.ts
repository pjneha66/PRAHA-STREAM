// Multi-playlist / bulk source import with an explicit {added, skipped, failed}
// result. Ported from VyseTV `iptv_controller.importFromJsonString` and
// `M3uStore` (GPL-3.0-or-later), adapted to PRAHA's M3U model.
//
// The counting and parsing paths are pure and injectable; the default fetcher
// routes every request through `nativeFetchText` (never bare `fetch`).

export interface ImportedChannel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  tvgName?: string;
}

export interface ImportedPlaylist {
  id: string;
  name: string;
  sourceUrl: string;
  channels: ImportedChannel[];
  updatedAt: number;
}

export interface PlaylistInput {
  name?: string;
  /** Remote M3U address. Ignored when `text` is supplied. */
  sourceUrl?: string;
  /** Inline M3U body (paste-site import flows). */
  text?: string;
}

export interface MultiPlaylistResult {
  added: number;
  skipped: number;
  failed: number;
  playlists: ImportedPlaylist[];
  errors: string[];
}

export type PlaylistFetcher = (url: string) => Promise<string>;

export interface MultiPlaylistOptions {
  existing?: readonly ImportedPlaylist[];
  fetchText?: PlaylistFetcher;
  now?: number;
  idFactory?: (index: number) => string;
}

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

function attr(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i').exec(attributes);
  return match ? match[1].trim() : '';
}

/** Small, synchronous M3U parser (same EXTINF/EXTGRP rules as PRAHA's worker). */
export function parsePlaylistText(text: string): ImportedChannel[] {
  if (!text || !text.trim()) return [];
  const channels: ImportedChannel[] = [];
  let pending: Partial<ImportedChannel> = {};
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      const attributes = comma > 0 ? line.slice(8, comma) : line.slice(8);
      const name = comma > 0 ? line.slice(comma + 1).trim() : '';
      pending = {
        name: name || attr(attributes, 'tvg-name') || 'Channel',
        logo: attr(attributes, 'tvg-logo') || undefined,
        // Some feeds emit #EXTGRP before #EXTINF; keep that group when the
        // EXTINF line itself has no group-title attribute.
        group: attr(attributes, 'group-title') || pending.group || undefined,
        tvgId: attr(attributes, 'tvg-id') || undefined,
        tvgName: attr(attributes, 'tvg-name') || undefined,
      };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      pending.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^(https?:\/\/|[\w./-]+\.(m3u8|ts|mp4))/i.test(line)) continue;
    channels.push({ name: pending.name || line, url: line, ...pending });
    pending = {};
  }
  return channels;
}

function sourceKey(input: PlaylistInput): string {
  if (input.text) return `inline:${input.name || ''}`;
  return (input.sourceUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function defaultFetcher(url: string): Promise<string> {
  const { nativeFetchText } = await import('../androidBridge');
  const response = await nativeFetchText(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/vnd.apple.mpegurl, audio/mpegurl, text/plain, */*' },
    timeoutMs: 25000,
  });
  if (!response.ok || !response.data || !response.data.trim()) throw new Error(`HTTP ${response.status} or empty body`);
  return response.data;
}

/**
 * Add several playlists in one pass. A source is skipped when its URL is
 * already stored or repeated in the batch; it is failed when it cannot be
 * fetched or yields no channels. Returned `playlists` contains only additions.
 */
export async function importPlaylists(
  inputs: readonly PlaylistInput[],
  options: MultiPlaylistOptions = {},
): Promise<MultiPlaylistResult> {
  const result: MultiPlaylistResult = { added: 0, skipped: 0, failed: 0, playlists: [], errors: [] };
  const seen = new Set<string>();
  for (const playlist of options.existing || []) {
    if (playlist?.sourceUrl) seen.add(playlist.sourceUrl.trim().replace(/\/+$/, '').toLowerCase());
  }
  const now = options.now ?? Date.now();
  const fetchText = options.fetchText || defaultFetcher;

  for (let index = 0; index < (inputs || []).length; index += 1) {
    const input = inputs[index];
    if (!input) continue;
    const key = sourceKey(input);
    if (!key || seen.has(key)) {
      result.skipped += 1;
      continue;
    }
    seen.add(key);
    if (!input.text && !validUrl(input.sourceUrl || '')) {
      result.failed += 1;
      result.errors.push(`Invalid playlist URL: ${input.sourceUrl || ''}`);
      continue;
    }
    try {
      const body = input.text || (await fetchText(input.sourceUrl!));
      const channels = parsePlaylistText(body);
      if (!channels.length) {
        result.failed += 1;
        result.errors.push(`No channels in ${input.name || input.sourceUrl || 'inline playlist'}`);
        continue;
      }
      result.playlists.push({
        id: options.idFactory ? options.idFactory(index) : `${now.toString(16)}_${index}`,
        name: input.name?.trim() || 'Playlist',
        sourceUrl: input.sourceUrl || '',
        channels,
        updatedAt: now,
      });
      result.added += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${input.sourceUrl || input.name || 'playlist'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/** The compact shape the Live TV UI shows in its toast. */
export function summarizeImport(result: MultiPlaylistResult): { added: number; skipped: number; failed: number } {
  return { added: result.added, skipped: result.skipped, failed: result.failed };
}

// ── Bulk portal JSON import ───────────────────────────────────────────────────

export interface PortalImportEntry {
  url: string;
  username: string;
  password: string;
  source?: string;
}

export interface PortalImportResult {
  added: number;
  skipped: number;
  failed: number;
  portals: PortalImportEntry[];
  error?: string;
}

export function credentialKey(portal: Pick<PortalImportEntry, 'username' | 'password'>): string {
  return `${portal.username}|${portal.password}`.toLowerCase();
}

/** Accept either a flat JSON array or `{ "portals": [...] }`. */
export function parsePortalImportJson(contents: string): { candidates: PortalImportEntry[]; error?: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents);
  } catch (error) {
    return { candidates: [], error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const rows = Array.isArray(decoded)
    ? decoded
    : decoded && typeof decoded === 'object' && Array.isArray((decoded as Record<string, unknown>).portals)
      ? (decoded as Record<string, unknown>).portals as unknown[]
      : null;
  if (!rows) return { candidates: [], error: 'JSON missing "portals" array.' };
  const candidates: PortalImportEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const url = String(item.url ?? '').trim().replace(/\/+$/, '');
    const username = String(item.username ?? '').trim();
    const password = String(item.password ?? '').trim();
    if (!url || !username || !password) continue;
    candidates.push({ url, username, password, source: 'Manual' });
  }
  return { candidates };
}

export type PortalVerifier = (portal: PortalImportEntry) => Promise<boolean>;

/** Verify at most `concurrency` portals at a time, as VyseTV's importer does. */
export async function importPortalsFromJson(
  contents: string,
  options: {
    existing?: readonly PortalImportEntry[];
    verify?: PortalVerifier;
    concurrency?: number;
  } = {},
): Promise<PortalImportResult> {
  const parsed = parsePortalImportJson(contents);
  if (parsed.error || !parsed.candidates.length) {
    return {
      added: 0,
      skipped: 0,
      failed: 0,
      portals: [],
      error: parsed.error || 'No portal entries found.',
    };
  }
  const seen = new Set((options.existing || []).map(credentialKey));
  const queue: PortalImportEntry[] = [];
  for (const portal of parsed.candidates) {
    const key = credentialKey(portal);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(portal);
  }
  const skipped = parsed.candidates.length - queue.length;
  const result: PortalImportResult = { added: 0, skipped, failed: 0, portals: [] };

  const verify: PortalVerifier = options.verify || (async (portal) => {
    const { IptvClient } = await import('../iptvService');
    return Boolean(await IptvClient.verifyOrNull({
      url: portal.url,
      username: portal.username,
      password: portal.password,
      source: portal.source,
    }));
  });

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) return;
      try {
        if (await verify(queue[index])) {
          result.portals.push(queue[index]);
          result.added += 1;
        } else {
          result.failed += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency || 8, queue.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return result;
}
