// Ported from VyseTV `lib/data/sources/debrid/utils/parse_torrent_title.dart`
// (GPL-3.0-or-later), which is itself a port of PlayTorrio's `parse_torrent_title`.
//
// This is NOT `services/torrentTitle.ts`. That one only guesses a release's
// resolution, season and episode well enough to pick a file inside a torrent;
// Knaben's title filter needs this parser's full field set — a cleaned `title`,
// `year`, `season`, `episode` and `episodeRange` — because it decides whether a
// release is the requested title at all, not just which file to play.

export interface ParsedTorrentTitle {
  title: string;
  year?: number | null;
  resolution?: string | null;
  season?: number | null;
  episode?: number | null;
  /** `[start, end]` for `S01E01-E04` style releases. */
  episodeRange?: [number, number];
  [key: string]: unknown;
}

interface HandlerHit {
  at: number;
}

type Handler = (title: string, result: Record<string, unknown>) => HandlerHit | null;

interface HandlerOptions {
  value?: unknown;
  type?: 'lowercase' | 'uppercase' | 'boolean' | 'integer' | 'float';
  skipIfAlreadyFound?: boolean;
}

const has = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

/** Dart's `int.tryParse`: null when the whole string is not an integer. */
function tryInt(input: string): number | null {
  return /^[+-]?\d+$/.test(input.trim()) ? Number.parseInt(input.trim(), 10) : null;
}

/** Dart's `double.tryParse`: null when the whole string is not a number. */
function tryFloat(input: string): number | null {
  const trimmed = input.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One entry of the Dart's handler table. */
function handlerFor(name: string, pattern: RegExp, options: HandlerOptions = {}): Handler {
  const { value, type, skipIfAlreadyFound = false } = options;
  return (title, result) => {
    if (skipIfAlreadyFound && has(result, name)) return null;
    const match = title.match(pattern);
    if (!match) return null;

    const rawMatch = match[0];
    // The Dart takes group 1, or the last group when group 1 is absent.
    const cleanMatch = match.length > 1 ? (match[1] ?? match[match.length - 1]) : null;

    let finalValue: unknown = value;
    if (finalValue === undefined) {
      const input = cleanMatch ?? rawMatch;
      if (type === 'lowercase') finalValue = input.toLowerCase();
      else if (type === 'uppercase') finalValue = input.toUpperCase();
      else if (type === 'boolean') finalValue = true;
      else if (type === 'integer') finalValue = tryInt(input);
      else if (type === 'float') finalValue = tryFloat(input);
      else finalValue = input;
    }

    if (!skipIfAlreadyFound && has(result, name) && result[name] !== finalValue) {
      const listKey = `${name}list`;
      const list = Array.isArray(result[listKey]) ? (result[listKey] as unknown[]) : [result[name]];
      if (!list.includes(finalValue)) list.push(finalValue);
      result[listKey] = list;
    }
    if (!has(result, name)) result[name] = finalValue;

    return { at: match.index ?? 0 };
  };
}

/** `addDefaults` from the Dart, in the same order (the order decides `endOfTitle`). */
function defaultHandlers(): Handler[] {
  const handlers: Handler[] = [];

  // Year
  handlers.push(handlerFor('year', /[^a-zA-Z0-9](?!^)[([\]]?((?:19[0-9]|20[012])[0-9])[)\]]?/, { type: 'integer' }));

  // Resolution
  handlers.push(handlerFor('resolution', /([0-9]{3,4}[pi])/i, { type: 'lowercase' }));
  handlers.push(handlerFor('resolution', /\b(4k)/i, { type: 'lowercase' }));
  handlers.push(handlerFor('resolution', /FHD|\b1080\b/i, { value: '1080p' }));
  handlers.push(handlerFor('resolution', /UHD/i, { value: '4k' }));

  // Editions
  handlers.push(handlerFor('extended', /EXTENDED(?:[\s.]CUT)?/i, { type: 'boolean' }));
  handlers.push(handlerFor('theatrical', /Theatrical(?:[. ]Cut)?/, { type: 'boolean' }));
  handlers.push(handlerFor('uncut', /.+\bUNCUT\b/i, { type: 'boolean' }));
  handlers.push(handlerFor('openmatte', /OPEN[. ]MATTE/i, { type: 'boolean' }));
  handlers.push(handlerFor('downscaled', /\bDS4K\b/i, { value: '4k' }));
  handlers.push(handlerFor('hybrid', /\bhybrid(\b|\d)/i, { type: 'boolean' }));
  handlers.push(handlerFor('convert', /CONVERT/, { type: 'boolean' }));
  handlers.push(handlerFor('hardcoded', /HC|HARDCODED/, { type: 'boolean' }));
  handlers.push(handlerFor('remux', /REMUX/i, { type: 'boolean' }));
  handlers.push(handlerFor('proper', /\b(?:REAL.)?PROPER\b/i, { type: 'boolean' }));
  handlers.push(handlerFor('repack', /REPACK|RERIP/i, { type: 'boolean' }));
  handlers.push(handlerFor('internal', /\b[iI]NTERNAL\b/, { type: 'boolean' }));
  handlers.push(handlerFor('retail', /\bRetail\b/i, { type: 'boolean' }));
  handlers.push(handlerFor('remastered', /\bRemaster(?:ed)?\b/i, { type: 'boolean' }));
  handlers.push(handlerFor('unrated', /\bunrated|uncensored\b/i, { type: 'boolean' }));
  handlers.push(
    handlerFor(
      'extras',
      /(?<=\b[12]\d{3}\b).*(\b|\.)\b(Extras?|Bonus|Extended[ ._-]Clip|Special Feature[s]?)\b/i,
      { type: 'boolean' },
    ),
  );
  handlers.push(handlerFor('criterion', /\bCriterion\b/, { type: 'boolean' }));

  // Region
  handlers.push(handlerFor('region', /(?:\b|[Dd](?:vd|VD))(R[0-9])/));

  // Container
  handlers.push(handlerFor('container', /\b(MKV|AVI|MP4)\b/i, { type: 'lowercase' }));

  // Source
  handlers.push(handlerFor('source', /\b(?:HD-?)?CAM\b/, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\b(?:HD-?)?T(?:ELE)?S(?:YNC)?\b/i, { value: 'telesync' }));
  handlers.push(handlerFor('source', /\bHD-?Rip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bBRRip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bBDRip|BluRayRip\b/i, { value: 'bdrip' }));
  handlers.push(handlerFor('source', /\bDVDRip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bDVD(?:R[0-9])?\b/i, { value: 'dvd' }));
  handlers.push(handlerFor('source', /\bDVDscr\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\b(?:HD-?)?TVRip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bTC\b/, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bPPVRip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bR5\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bVHSSCR\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /((?:\bBlu-?Ray)|((?:\b|\d)BR))\b/i, { value: 'bluray' }));
  handlers.push(handlerFor('source', /\bWEB(?:-?DL)?\b(?!-?RIP)/i, { value: 'web-dl' }));
  handlers.push(handlerFor('source', /\bWEB-?Rip\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\b(?:DL|WEB|BD|BR)MUX\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\b(DivX|XviD)\b/, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /HDTV/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bIMAX[. -]Enhanced\b/i, { value: 'imax-enhanced' }));
  handlers.push(handlerFor('source', /\bIMAX\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bHDDVD\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bNTSC\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('source', /\bPAL\b/i, { type: 'lowercase' }));

  // Service
  handlers.push(handlerFor('service', /\bAMZN|Amazon\b/i, { value: 'AMZN' }));
  for (const tag of ['AUBC', 'ATVP', 'BNGE', 'DLWP', 'DSCP', 'DSNP', 'FDNG', 'HULU', 'PCOK', 'ROKU', 'SKST', 'STAN']) {
    handlers.push(handlerFor('service', new RegExp(`\\b${tag}\\b`, 'i'), { type: 'uppercase' }));
  }
  handlers.push(handlerFor('service', /\bH?MAX\b/, { value: 'HMAX' }));
  handlers.push(handlerFor('service', /\b(?<!DTS-HD[\s\-.])MA\b/i, { type: 'uppercase' }));
  handlers.push(handlerFor('service', /\b(NFLX|NF|Netflix)\b/i, { value: 'NFLX' }));
  handlers.push(handlerFor('service', /\biT(?:unes)\b/, { value: 'iT' }));

  // Codec
  handlers.push(handlerFor('codec', /h[-. ]?265|hevc/i, { value: 'h265' }));
  handlers.push(handlerFor('codec', /h[-. ]?264|avc/i, { value: 'h264' }));
  handlers.push(handlerFor('codec', /dvix|mpeg2|divx|xvid|x[-. ]?26[45]/i, { type: 'lowercase' }));
  handlers.push((_title, result) => {
    if (typeof result.codec === 'string') result.codec = result.codec.replace(/[ .-]/g, '');
    return null;
  });

  // Colour
  handlers.push(handlerFor('color', /\bHDR(?:10)?\b/i, { value: 'HDR' }));
  handlers.push(handlerFor('color', /\bSDR\b/i, { type: 'uppercase' }));
  handlers.push(handlerFor('color', /\b(?:DV|DoVi|Dolby\sVision)\b/i, { value: 'DV' }));

  // Audio
  handlers.push(handlerFor('audio', /\bATMOS\b|DA\d/i, { value: 'atmos' }));
  handlers.push(handlerFor('audio', /MD|MP3|mp3|FLAC|TrueHD/, { type: 'lowercase' }));
  handlers.push(handlerFor('audio', /\bDD-EX(\b|\d)/i, { value: 'dd-ex' }));
  handlers.push(handlerFor('audio', /\bDD(?:\+|P)|EAC-?3/i, { value: 'ddp' }));
  handlers.push(handlerFor('audio', /\b(DD(?!-EX)(?:\b|\d)|AC-?3)/i, { value: 'dd' }));
  handlers.push(handlerFor('audio', /AAC(?:[. ]?2[. ]0)?/, { value: 'aac' }));
  handlers.push(handlerFor('audio', /DTS-ES/, { type: 'lowercase' }));
  handlers.push(handlerFor('audio', /DTS-HD[\s-.]?(MA|Master Audio)/, { value: 'dts-hd-ma' }));
  handlers.push(handlerFor('audio', /DTS(?:[- ]?HD)/, { value: 'dts-hd', skipIfAlreadyFound: true }));
  handlers.push(handlerFor('audio', /DTS/, { value: 'dts', skipIfAlreadyFound: true }));

  // Channels
  handlers.push(handlerFor('channels', /\d+[.\s](?:1|0)\b/i));
  handlers.push(handlerFor('channels', /2(?:ch)/, { value: 2.0 }));
  handlers.push(handlerFor('channels', /6(?:ch)/, { value: 5.1 }));
  handlers.push(handlerFor('channels', /8(?:ch)/, { value: 7.1 }));
  handlers.push((_title, result) => {
    if (typeof result.channels === 'string') {
      result.channels = tryFloat(result.channels.split(' ').join('.')) ?? result.channels;
    }
    return null;
  });

  // Bit depth, sample rate
  handlers.push(handlerFor('bitdepth', /\b(8|10|12|16|24)[-\s.]?bits?\b/i, { type: 'integer' }));
  handlers.push(handlerFor('samplerate', /\b((?:\d+)(?:\.\d+)?)[-\s.]?kHz?\b/i, { type: 'float' }));

  // Group, encoder
  handlers.push(
    handlerFor('group', /-[ ([]*(?:\w+[ \][)]+)?(\w+(?:\.\w+)?(?<!\.mkv|\.mp4))[)\]]?(?:\.(?:mkv|mp4))?$/i),
  );
  handlers.push(
    handlerFor('encoder', /-[ ([]*(?:(\w+)[ \][)]+)\w+(?:\.\w+)?(?<!\.mkv|\.mp4)[)\]]?(?:\.(?:mkv|mp4))?$/i),
  );

  // Season
  handlers.push(handlerFor('season', /([0-9]{1,2})[xX×✕✖]all/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /S([0-9]{1,2}) ?E[0-9]{1,2}/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /([0-9]{1,2})[xX×✕✖][0-9]{1,2}/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /(?:Saison|Season)[. _-]?([0-9]{1,2})/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /\bS([0-9]{1,2})(?![0-9])/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /\[([0-9]{1,2})[._ -]([0-9]{1,2})\]/i, { type: 'integer' }));
  handlers.push(handlerFor('season', /\b0*([0-9]{1,2})\s*-\s*0*[0-9]{1,2}\b/, { type: 'integer' }));

  // Episode
  handlers.push(handlerFor('episode', /S[0-9]{1,2} ?E([0-9]{1,5})/i, { type: 'integer' }));
  handlers.push(handlerFor('episode', /[0-9]{1,2}[xX×✕✖]([0-9]{1,5})/i, { type: 'integer' }));
  handlers.push(handlerFor('episode', /[ée]p(?:isode)?[. _-]?([0-9]{1,5})/i, { type: 'integer' }));
  handlers.push(handlerFor('episode', /\bE([0-9]{1,5})\b/i, { type: 'integer' }));
  handlers.push(handlerFor('episode', /\[[0-9]{1,2}[._ -]([0-9]{1,2})\]/i, { type: 'integer' }));
  handlers.push(handlerFor('episode', /\b0*[0-9]{1,2}\s*-\s*0*([0-9]{1,2})\b/, { type: 'integer' }));
  handlers.push(handlerFor('episode', /^0*([0-9]{1,4})[ ._-]+[a-zA-Z]/, { type: 'integer' }));
  handlers.push(handlerFor('episode', /(?:^|[\\/])0*([0-9]{1,4})\.[a-zA-Z0-9]+$/, { type: 'integer' }));

  // Language
  handlers.push(handlerFor('language', /\bMULTi(?:Lang|-audio|-VF2)?\b/i, { value: 'multi' }));
  handlers.push(handlerFor('language', /Dual(?:[- ]Audio)?|[ .]DL[ .]/i, { value: 'dual' }));
  for (const tag of ['RUS', 'UKR', 'JPN', 'NL', 'NORDiC', 'ViETNAM', 'FLEMISH', 'GERMAN', 'DUBBED', 'NORDIC']) {
    handlers.push(handlerFor('language', new RegExp(`\\b${tag}\\b`, 'i'), { type: 'lowercase' }));
  }
  handlers.push(handlerFor('language', /\bENG(?:LISH)?\b/i, { value: 'eng' }));
  handlers.push(handlerFor('language', /\bRoSubbed\b/i, { value: 'romanian' }));
  handlers.push(handlerFor('language', /\b(ITA(?:LIAN)?|iTA(?:LiAN)?)\b/, { value: 'ita' }));
  handlers.push(handlerFor('language', /\bFR(?:ENCH)?\b/, { type: 'lowercase' }));
  handlers.push(handlerFor('language', /\bTruefrench|VF(?:[FI])\b/i, { type: 'lowercase' }));
  handlers.push(handlerFor('language', /\bVOST(?:(?:F(?:R)?)|A)?|SUBFRENCH\b/i, { type: 'lowercase' }));

  return handlers;
}

/** `_addTorrServerHandlers`: Russian episode and season numbering. */
function torrServerHandlers(): Handler[] {
  return [
    handlerFor('episode', /(\d{1,4})[- |. ]серия|серия[- |. ](\d{1,4})/i, { type: 'integer' }),
    handlerFor('season', /sezon[- |. ](\d{1,3})|(\d{1,3})[- |. ]sezon/i, { type: 'integer' }),
    handlerFor('season', /сезон[- |. ](\d{1,3})|(\d{1,3})[- |. ]сезон/i, { type: 'integer' }),
  ];
}

const HANDLERS: Handler[] = [...defaultHandlers(), ...torrServerHandlers()];

/** The Dart's multi-episode range patterns, in order. */
const RANGE_PATTERNS: RegExp[] = [
  /S[0-9]{1,2}[ ._x-]*E([0-9]{1,4})[ ._x\-+~]+(?:E|e)?([0-9]{1,4})/i,
  /[0-9]{1,2}[xX]([0-9]{1,4})[ ._x\-+~]+(?:[0-9]{1,2}[xX])?([0-9]{1,4})/i,
  /\bE([0-9]{1,4})[ ._x\-+~]+(?:E|e)?([0-9]{1,4})\b/i,
  /\b0*([0-9]{1,4})\s*-\s*0*([0-9]{1,4})\b/,
];

/** The Dart's `normalizeTorrentTitle`. */
export function normalizeTorrentTitle(title: string): string {
  let out = '';
  for (const char of title) {
    out += char === '×' || char === '✕' || char === '✖' || char === 'Х' || char === 'х' ? 'x' : char;
  }
  return out;
}

/** The Dart's `_cleanTitle`. */
function cleanTitle(rawTitle: string): string {
  let cleaned = rawTitle;
  // `^\.+|\.+$`: leading and trailing dots.
  let start = 0;
  while (start < cleaned.length && cleaned[start] === '.') start += 1;
  let end = cleaned.length;
  while (end > start && cleaned[end - 1] === '.') end -= 1;
  cleaned = cleaned.slice(start, end);

  if (!cleaned.includes(' ') && cleaned.includes('.')) cleaned = cleaned.split('.').join(' ');
  cleaned = cleaned.split('_').join(' ');

  // `([(_]|- )$`: one trailing "(", "_" or "- ".
  if (cleaned.endsWith('- ')) cleaned = cleaned.slice(0, -2);
  else if (cleaned.endsWith('(') || cleaned.endsWith('_')) cleaned = cleaned.slice(0, -1);

  return cleaned.trim();
}

/** The Dart's `parse`. */
export function parseTorrentTitle(rawTitle: string): ParsedTorrentTitle {
  const title = normalizeTorrentTitle(rawTitle);
  const result: Record<string, unknown> = {};
  let endOfTitle = title.length;

  for (const handler of HANDLERS) {
    const hit = handler(title, result);
    if (hit && hit.at < endOfTitle) endOfTitle = hit.at;
  }

  for (const pattern of RANGE_PATTERNS) {
    const found = title.match(pattern);
    if (!found) continue;
    const start = tryInt(found[1] ?? '');
    const stop = tryInt(found[2] ?? '');
    if (start !== null && stop !== null && stop > start && stop - start <= 25) {
      result.episodeRange = [start, stop];
      break;
    }
  }

  result.title = cleanTitle(title.slice(0, endOfTitle));
  return result as ParsedTorrentTitle;
}

/**
 * The Dart's `parsePath`: a file path whose name only carries an episode number
 * takes its season from a parent folder ("Show/Season 05/01 - Episode.mkv").
 */
export function parseTorrentPath(fullPath: string): ParsedTorrentTitle {
  const segments = fullPath.split('\\').join('/').split('/').filter((segment) => segment.trim().length > 0);
  if (segments.length === 0) return parseTorrentTitle(fullPath);

  const fileResult = parseTorrentTitle(segments[segments.length - 1]);
  if (fileResult.season !== undefined && fileResult.season !== null) return fileResult;

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const folderResult = parseTorrentTitle(segments[index]);
    if (folderResult.season !== undefined && folderResult.season !== null) {
      fileResult.season = folderResult.season;
      break;
    }
  }
  return fileResult;
}
