import type { DebridSettings, StreamResult } from '../types';
import { nativeFetchText } from './androidBridge';

export function extractInfoHash(stream: Pick<StreamResult, 'infoHash' | 'url'>): string | undefined {
  if (stream.infoHash && /^[a-f0-9]{32,40}$/i.test(stream.infoHash.trim())) {
    return stream.infoHash.trim().toLowerCase();
  }
  const match = (stream.url || '').match(/xt=urn:btih:([a-f0-9]{32,40}|[a-z2-7]{32})/i);
  return match ? match[1].toLowerCase() : undefined;
}

export function buildMagnetUri(stream: Pick<StreamResult, 'url' | 'infoHash' | 'title'>): string {
  if (stream.url && stream.url.startsWith('magnet:')) return stream.url;
  const hash = extractInfoHash(stream);
  if (!hash) return stream.url || '';
  const dn = stream.title ? `&dn=${encodeURIComponent(stream.title)}` : '';
  return `magnet:?xt=urn:btih:${hash}${dn}`;
}

export function isMagnetOrTorrent(stream: Pick<StreamResult, 'url' | 'infoHash'>): boolean {
  return Boolean(stream.url?.startsWith('magnet:') || (!stream.url && stream.infoHash) || extractInfoHash(stream));
}

const VIDEO_EXT_RE = /\.(mkv|mp4|webm|avi|m4v|mov|ts|m3u8)$/i;

async function resolveRealDebrid(magnet: string, apiKey: string, fileIdx?: number): Promise<string> {
  const auth = { Authorization: `Bearer ${apiKey.trim()}` };
  const addRes = await nativeFetchText('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `magnet=${encodeURIComponent(magnet)}`,
  });
  if (!addRes.ok) throw new Error(`Real-Debrid returned HTTP ${addRes.status}. Check your API token.`);
  const added = JSON.parse(addRes.data) as { id?: string };
  if (!added.id) throw new Error('Real-Debrid did not return a torrent ID.');

  const infoRes = await nativeFetchText(`https://api.real-debrid.com/rest/1.0/torrents/info/${added.id}`, { headers: auth });
  if (!infoRes.ok) throw new Error('Unable to inspect Real-Debrid torrent files.');
  const info = JSON.parse(infoRes.data) as {
    files?: Array<{ id: number; path: string; bytes: number }>;
    links?: string[];
  };

  const files = info.files || [];
  const videoFiles = files.filter((f) => VIDEO_EXT_RE.test(f.path));
  const chosenFile = typeof fileIdx === 'number' && files[fileIdx]
    ? files[fileIdx]
    : [...(videoFiles.length ? videoFiles : files)].sort((a, b) => b.bytes - a.bytes)[0];

  const selectIds = chosenFile ? String(chosenFile.id) : 'all';
  await nativeFetchText(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${added.id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `files=${encodeURIComponent(selectIds)}`,
  });

  const readyRes = await nativeFetchText(`https://api.real-debrid.com/rest/1.0/torrents/info/${added.id}`, { headers: auth });
  const readyInfo = JSON.parse(readyRes.data) as { status?: string; links?: string[] };
  if (!readyInfo.links?.length) {
    throw new Error(`Torrent is not cached on Real-Debrid yet (status: ${readyInfo.status || 'queued'}).`);
  }

  const unrestrictRes = await nativeFetchText('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `link=${encodeURIComponent(readyInfo.links[0])}`,
  });
  if (!unrestrictRes.ok) throw new Error('Real-Debrid could not unrestrict the cached link.');
  const unrestricted = JSON.parse(unrestrictRes.data) as { download?: string };
  if (!unrestricted.download) throw new Error('Real-Debrid returned no playable URL.');
  return unrestricted.download;
}

async function resolveAllDebrid(magnet: string, apiKey: string): Promise<string> {
  const agent = 'praha-stream';
  const uploadUrl = `https://api.alldebrid.com/v4/magnet/upload?agent=${agent}&apikey=${encodeURIComponent(apiKey.trim())}&magnets[]=${encodeURIComponent(magnet)}`;
  const uploadRes = await nativeFetchText(uploadUrl);
  if (!uploadRes.ok) throw new Error(`AllDebrid returned HTTP ${uploadRes.status}.`);
  const uploaded = JSON.parse(uploadRes.data) as { status?: string; data?: { magnets?: Array<{ id: number; ready?: boolean }> } };
  const mag = uploaded.data?.magnets?.[0];
  if (!mag?.id) throw new Error('AllDebrid rejected the magnet link.');

  const statusUrl = `https://api.alldebrid.com/v4/magnet/status?agent=${agent}&apikey=${encodeURIComponent(apiKey.trim())}&id=${mag.id}`;
  const statusRes = await nativeFetchText(statusUrl);
  const statusJson = JSON.parse(statusRes.data) as {
    data?: { magnets?: { links?: Array<{ link: string; filename: string; size: number }> } };
  };
  const links = statusJson.data?.magnets?.links || [];
  if (!links.length) throw new Error('This torrent is not cached on AllDebrid yet.');
  const best = [...links].sort((a, b) => b.size - a.size)[0];

  const unlockUrl = `https://api.alldebrid.com/v4/link/unlock?agent=${agent}&apikey=${encodeURIComponent(apiKey.trim())}&link=${encodeURIComponent(best.link)}`;
  const unlockRes = await nativeFetchText(unlockUrl);
  const unlocked = JSON.parse(unlockRes.data) as { data?: { link?: string } };
  if (!unlocked.data?.link) throw new Error('AllDebrid could not unlock the stream link.');
  return unlocked.data.link;
}

async function resolveTorBox(magnet: string, apiKey: string): Promise<string> {
  const auth = { Authorization: `Bearer ${apiKey.trim()}` };
  const createRes = await nativeFetchText('https://api.torbox.app/v1/api/torrents/createtorrent', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `magnet=${encodeURIComponent(magnet)}`,
  });
  if (!createRes.ok) throw new Error(`TorBox returned HTTP ${createRes.status}.`);
  const created = JSON.parse(createRes.data) as { data?: { torrent_id?: number } };
  const torrentId = created.data?.torrent_id;
  if (!torrentId) throw new Error('TorBox did not return a torrent ID.');

  const listRes = await nativeFetchText(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}&bypass_cache=true`, { headers: auth });
  const listed = JSON.parse(listRes.data) as {
    data?: { download_present?: boolean; files?: Array<{ id: number; name: string; size: number }> };
  };
  const files = listed.data?.files || [];
  if (!listed.data?.download_present || !files.length) {
    throw new Error('This torrent is not cached on TorBox yet.');
  }
  const bestFile = [...files].sort((a, b) => b.size - a.size)[0];
  const dlUrl = `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(apiKey.trim())}&torrent_id=${torrentId}&file_id=${bestFile.id}`;
  const dlRes = await nativeFetchText(dlUrl, { headers: auth });
  const dlJson = JSON.parse(dlRes.data) as { data?: string };
  if (!dlJson.data) throw new Error('TorBox could not generate a direct stream URL.');
  return dlJson.data;
}

export async function resolveDebridStream(stream: StreamResult, debrid: DebridSettings): Promise<StreamResult> {
  if (debrid.provider === 'none' || !debrid.apiKey.trim()) {
    throw new Error('Configure Real-Debrid, AllDebrid, or TorBox in Settings → Debrid first.');
  }
  const magnet = buildMagnetUri(stream);
  if (!magnet.startsWith('magnet:')) {
    throw new Error('This source does not include a valid magnet or infoHash.');
  }

  let directUrl: string;
  if (debrid.provider === 'realdebrid') {
    directUrl = await resolveRealDebrid(magnet, debrid.apiKey, stream.fileIdx);
  } else if (debrid.provider === 'alldebrid') {
    directUrl = await resolveAllDebrid(magnet, debrid.apiKey);
  } else {
    directUrl = await resolveTorBox(magnet, debrid.apiKey);
  }

  const label = debrid.provider === 'realdebrid' ? 'Real-Debrid' : debrid.provider === 'alldebrid' ? 'AllDebrid' : 'TorBox';
  return {
    ...stream,
    url: directUrl,
    provider: `${stream.provider || stream.sourceName} · ${label}`,
  };
}
