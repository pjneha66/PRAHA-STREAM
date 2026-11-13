/**
 * Torrent title parser (port of PlayTorrio's PTT port): extracts quality,
 * resolution, season/episode from release names so torrent file picking can
 * match the requested episode instead of blindly grabbing the largest file.
 */

export interface ParsedTorrentTitle {
  title: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  resolution?: '2160p' | '1080p' | '720p' | '480p' | 'sd';
  quality?: string;
  year?: number;
  group?: string;
}

const RESOLUTIONS: Array<[RegExp, ParsedTorrentTitle['resolution']]> = [
  [/\b(2160p|4k)\b/i, '2160p'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b480p\b/i, '480p'],
];

const QUALITY_RE = /\b(repack|proper|remastered|extended|unedited|internal)\b/i;
const GROUP_RE = /\b([A-Z0-9]{2,})\b(?=\s*$)/;

export function parseTorrentTitle(input: string): ParsedTorrentTitle {
  const raw = (input || '').replace(/\./g, ' ').replace(/[(){}\[\]]/g, ' ').trim();
  const parsed: ParsedTorrentTitle = { title: raw };

  for (const [re, res] of RESOLUTIONS) {
    if (re.test(raw)) { parsed.resolution = res; break; }
  }
  const qualityMatch = raw.match(QUALITY_RE);
  if (qualityMatch) parsed.quality = qualityMatch[1].toLowerCase();
  const yearMatch = raw.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) parsed.year = Number(yearMatch[1]);

  // S01E02 / 1x02 / S01E01E02 (take first episode)
  const seMatch = raw.match(/\bS(\d{1,2})\s?E(\d{1,3})(?:\s?-\s?E?\d{1,3})?/i)
    || raw.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (seMatch) {
    parsed.season = Number(seMatch[1]);
    parsed.episode = Number(seMatch[2]);
  }

  // Title = everything before the season marker / year / resolution tag.
  const cutMarkers = [
    raw.match(/\bS\d{1,2}\s?E\d{1,3}/i)?.index,
    raw.match(/\b\d{1,2}x\d{1,3}\b/i)?.index,
    yearMatch?.index,
  ].filter((value): value is number => value !== undefined);
  const cutAt = cutMarkers.length ? Math.min(...cutMarkers) : raw.length;
  let title = raw.slice(0, cutAt).replace(/[-_.]+\s*$/, '').trim();
  if (!title) title = raw.trim();

  // Episode title: text after the S/E marker until a resolution/group tag.
  if (seMatch) {
    const afterSe = raw.slice((seMatch.index || 0) + seMatch[0].length);
    const epTitle = afterSe
      .replace(new RegExp(RESOLUTIONS.map(([re]) => re.source).join('|'), 'gi'), '')
      .replace(/\b(1080|720|2160)|\b(h264|x264|h\.265|x265|hevc|aac|ddp?|web-?dl|webrip|bluray|remux)\b/gi, '')
      .replace(GROUP_RE, '')
      .replace(/[-\s]+$/, '')
      .trim();
    if (epTitle) parsed.episodeTitle = epTitle;
  }

  parsed.title = title;
  return parsed;
}

/** True when a torrent file entry matches the parsed S/E (or when unparseable). */
export function torrentFileMatches(parsed: ParsedTorrentTitle | null, fileName: string): boolean {
  if (!parsed || parsed.season === undefined || parsed.episode === undefined) return true; // can't judge — keep
  const fileParsed = parseTorrentTitle(fileName);
  if (fileParsed.season === undefined || fileParsed.episode === undefined) return true;
  return fileParsed.season === parsed.season && fileParsed.episode === parsed.episode;
}
