// M3U / M3U8 parser and playlist store.
//
// Ported from VyseTV `lib/services/iptv/m3u_parser.dart` and
// `lib/services/iptv/m3u_store.dart` (GPL-3.0-or-later). The parser is the
// single source of truth for EXTINF / EXTGRP handling across import, worker
// and browser. Network access goes through the nativeFetchText wrapper.

import type { M3uChannel, M3uPlaylist } from './models';
import { fetchText } from './http';

const URL_PREFIXES = ['http://', 'https://', 'rtmp://', 'rtmps://', 'rtsp://', 'udp://', 'rtp://', 'mms://', 'mmsh://'];

function looksLikeUrl(s: string): boolean {
  const lower = s.toLowerCase();
  return URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Parse `#EXTINF` attributes the way the Dart parser does (quoted or bare). */
export function parseM3uAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let s = input.trim();
  if (s.startsWith(':')) s = s.slice(1).trim();
  s = s.replace(/^-?\d+(\.\d+)?/, '').trim();
  const re = /([a-zA-Z0-9_\-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return attrs;
}

/**
 * Parse raw playlist text into channels. Empty / whitespace input returns an
 * empty list (the worker treats this as "nothing to add").
 */
export function parseM3u(content: string): M3uChannel[] {
  if (!content || !content.trim()) return [];
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: M3uChannel[] = [];
  let pendingName: string | null = null;
  let pendingLogo = '';
  let pendingGroup = '';
  let pendingTvgId = '';
  let pendingTvgName = '';
  const reset = () => {
    pendingName = null;
    pendingLogo = '';
    pendingGroup = '';
    pendingTvgId = '';
    pendingTvgName = '';
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const attributePart = comma > 0 ? line.slice('#EXTINF'.length, comma) : line.slice('#EXTINF'.length);
      const namePart = comma > 0 ? line.slice(comma + 1).trim() : '';
      const attrs = parseM3uAttributes(attributePart);
      pendingTvgId = attrs['tvg-id'] || '';
      pendingTvgName = attrs['tvg-name'] || '';
      pendingLogo = attrs['tvg-logo'] || '';
      // An `#EXTGRP` line may precede the EXTINF it labels; keep it as the
      // fallback when the EXTINF itself has no group-title attribute.
      pendingGroup = attrs['group-title'] || pendingGroup;
      pendingName = namePart || pendingTvgName || 'Unknown';
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      pendingGroup = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!looksLikeUrl(line)) continue;
    out.push({
      name: pendingName ?? line,
      url: line,
      logo: pendingLogo || undefined,
      group: pendingGroup || undefined,
      tvgId: pendingTvgId || undefined,
      tvgName: pendingTvgName || undefined,
    });
    reset();
  }
  return out;
}

/** Static facade kept for the worker and existing callers. */
export class M3uParser {
  static parse(content: string): M3uChannel[] {
    return parseM3u(content);
  }
}

// ── Playlist store ─────────────────────────────────────────────────────────────

const PLAYLISTS_KEY = 'pt_iptv_m3u_playlists_v1';

export function loadPlaylists(): M3uPlaylist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => {
      const o = item as Record<string, any>;
      return {
        id: String(o.id ?? ''),
        name: String(o.name ?? 'Playlist'),
        sourceUrl: String(o.sourceUrl ?? ''),
        addedAt: Number(o.addedAt ?? 0),
        channels: Array.isArray(o.channels) ? o.channels : [],
        updatedAt: Number(o.updatedAt ?? 0),
      };
    });
  } catch {
    return [];
  }
}

export function savePlaylists(list: readonly M3uPlaylist[]): void {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify([...list]));
  } catch {
    // Storage unavailable: keep changes in memory for this session.
  }
}

export function newPlaylistId(): string {
  return `${Date.now().toString(16)}_${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20';

/** Fetch a playlist through nativeFetchText (VLC user-agent, as in Dart). */
export async function fetchPlaylist(url: string, timeoutMs = 25000): Promise<string> {
  const res = await fetchText(url, {
    headers: { 'User-Agent': VLC_UA, Accept: 'application/vnd.apple.mpegurl, audio/mpegurl, text/plain, */*' },
    timeoutMs,
  });
  if (!res.ok || (res.status >= 200 && res.status < 300) === false || !res.data.trim()) {
    throw new Error(`HTTP ${res.status} or empty body while fetching playlist`);
  }
  return res.data;
}

export async function fetchAndParsePlaylist(url: string): Promise<M3uChannel[]> {
  return parseM3u(await fetchPlaylist(url));
}
