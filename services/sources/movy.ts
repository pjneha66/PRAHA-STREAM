// Ported from VyseTV `lib/data/sources/sources.dart` (GPL-3.0-or-later).
//
// Movy (vidy.st) is VyseTV's own film/TV source, separate from the ported
// scrapers: 17 servers named after cities, each answering with an encrypted
// payload that is XOR-decoded with a seed the API hands out for the title. It
// has no equivalent in PRAHA, so this is a straight port of the Dart.
//
// One thing is deliberately different. The Dart's `_dashFiles` downloads a DASH
// manifest and writes a trimmed `.mpd` per quality to the device's temp folder,
// because mpv opens every stream in a manifest before it plays anything. PRAHA
// plays DASH through dash.js, which reads the one manifest itself, so the
// trimmed files would be dead weight. The Dart already falls back to the full
// manifest when the trimming fails, and that fallback is what this port uses.
//
// Attribution for the cipher: VyseTV's Dart is the only public description of
// the scheme, and it is carried over operation for operation — the 32-bit
// rotations and masks are load-bearing, not style.

import { Capacitor } from '@capacitor/core';
import { nativeFetchText } from '../androidBridge';
import type { FilmScrapeOptions, FoundStream } from '../filmSources';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: 'https://www.vidy.st/',
  Origin: 'https://www.vidy.st',
  Accept: 'application/json, text/plain, */*',
};

const M32 = 0xffffffff;
const SLOTS = 61;
const MS = 2654435769;
const ACC_XOR = 2779096485;
const MAGIC = [109, 118, 109, 49]; // mvm1

const u32 = (value: number): number => value >>> 0;

function rotl(value: number, amount: number): number {
  const n = amount & 31;
  return u32((value << n) | (value >>> (32 - n)));
}

function mix(input: number): number {
  let l = u32(input ^ (input >>> 16));
  l = u32(Math.imul(l, 2246822507));
  l = u32(l ^ (l >>> 13));
  l = u32(Math.imul(l, 3266489909));
  return u32(l ^ (l >>> 16));
}

function fnv(seed: string): number {
  let out = 2166136261;
  // Dart walks `codeUnits`; index iteration keeps surrogate pairs split the
  // same way instead of handing over whole code points.
  for (let index = 0; index < seed.length; index += 1) {
    out = u32(Math.imul(out ^ seed.charCodeAt(index), 16777619));
  }
  return mix(out);
}

/** The Dart's `_Cipher`: a small state machine seeded from the string and TMDB id. */
class Cipher {
  private readonly slots = new Array<number>(SLOTS).fill(0);
  private readonly present = new Array<boolean>(SLOTS).fill(false);
  private acc = 0;

  constructor(seed: string, tmdbId: number) {
    let index = mix(u32(fnv(seed) ^ mix(u32(tmdbId ^ MS))));
    for (let round = 0; round < 8; round += 1) {
      const slot = index % SLOTS;
      index = rotl(u32(index + MS), 7 + (round & 7));
      this.slots[slot] = u32(index ^ mix(index));
      this.present[slot] = true;
      index = mix(u32(index + slot));
    }
    this.acc = mix(u32(index ^ ACC_XOR));
  }

  next(offset: number): number {
    const slot = this.acc % SLOTS;
    const negate = this.present[slot] ? M32 : 0;
    const x = u32(this.slots[slot] ^ u32(Math.imul(MS, offset + 1)));
    let g = u32((this.acc ^ x) | (this.acc & x & negate));
    g = u32(rotl(u32(g + this.acc), slot & 31) ^ rotl(this.acc, u32(Math.imul(slot, 7)) & 31));
    this.acc = mix(u32(g + MS));
    this.slots[slot] = this.acc;
    this.present[slot] = true;
    return this.acc;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The Dart's `_decrypt`: base64url → XOR stream → 4-byte magic → UTF-8. */
export function decryptMovyPayload(enc: string, seed: string, tmdbId: number): string {
  let base64 = enc.split('-').join('+').split('_').join('/');
  if (base64.length % 4 !== 0) base64 += '='.repeat(4 - (base64.length % 4));

  const raw = decodeBase64(base64);
  const state = new Cipher(seed, tmdbId);
  let cursor = 0;
  let offset = 0;
  while (cursor < raw.length) {
    const word = state.next(offset);
    offset += 1;
    for (let byte = 0; byte < 4 && cursor < raw.length; byte += 1) {
      raw[cursor] ^= (word >>> (8 * byte)) & 0xff;
      cursor += 1;
    }
  }

  for (let index = 0; index < 4; index += 1) {
    if (raw[index] !== MAGIC[index]) throw new Error('movy: magic mismatch');
  }
  return new TextDecoder().decode(raw.subarray(4));
}

interface Shard {
  shard: string;
  name: string;
  key: string;
  audio: string | null;
  extra: Record<string, string>;
  altTitle: boolean;
  germanTitle: boolean;
}

/**
 * Movy's servers, in the order they are tried. `key` is what a watch party's
 * devices call a server between them; it predates the real names and is kept so
 * a room with an older VyseTV still agrees.
 */
export const MOVY_SERVERS: Shard[] = [
  { shard: 'miami', name: 'Miami', key: 'Aurora', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'boise', name: 'Boise', key: 'Borealis', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'nashville', name: 'Nashville', key: 'Comet', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'chicago', name: 'Chicago', key: 'Drift', audio: null, extra: {}, altTitle: true, germanTitle: false },
  { shard: 'vegas', name: 'Vegas', key: 'Ember', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'reno', name: 'Reno', key: 'Flux', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'oakland', name: 'Oakland', key: 'Glacier', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'seattle', name: 'Seattle', key: 'Halo', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'phoenix', name: 'Phoenix', key: 'Ion', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'atlanta', name: 'Atlanta', key: 'Juniper', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'portland', name: 'Portland', key: 'Kestrel', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'austin', name: 'Austin', key: 'Lumen', audio: null, extra: {}, altTitle: false, germanTitle: false },
  { shard: 'munich', name: 'Munich', key: 'Meridian', audio: 'German', extra: { language: 'german' }, altTitle: false, germanTitle: false },
  { shard: 'berlin', name: 'Berlin', key: 'Nova', audio: 'German', extra: {}, altTitle: false, germanTitle: true },
  { shard: 'paris', name: 'Paris', key: 'Orbit', audio: 'French', extra: {}, altTitle: false, germanTitle: false },
  { shard: 'delhi', name: 'Delhi', key: 'Prism', audio: 'Hindi', extra: {}, altTitle: false, germanTitle: false },
  { shard: 'cancun', name: 'Cancun', key: 'Quasar', audio: 'Spanish', extra: {}, altTitle: false, germanTitle: false },
];

async function get(url: string, timeoutMs: number): Promise<string> {
  const res = await nativeFetchText(url, { headers: HEADERS, timeoutMs });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.data;
}

/** The Dart's `_quality`: read the label out of what the API said, or the URL. */
export function movyQuality(raw: string, url: string): string {
  if (raw.includes('4K') || raw.includes('2160') || url.includes('2160p')) return '4K';
  for (const quality of ['1080', '720', '480', '360']) {
    if (raw.includes(quality)) return `${quality}p`;
  }
  // The API doesn't say ("Auto", "Vidmoly"); the player reads it from the stream.
  return '';
}

const rank = (quality: string): number =>
  quality === '4K' ? 5 : quality === '1080p' ? 4 : quality === '720p' ? 3 : quality === '480p' ? 2 : quality === '360p' ? 1 : 0;

/** One Movy lookup for one title. Details and the seed are shared by every server. */
export class MovySession {
  private metaPromise: Promise<{ title: string; year: string; imdbId: string; totalSeasons: string; titleGerman: string }> | null = null;
  private seedPromise: Promise<string | null> | null = null;
  private seedAt = 0;

  constructor(
    private readonly tmdbId: number,
    private readonly isTv: boolean,
    private readonly season?: number,
    private readonly episode?: number,
  ) {}

  private get type(): string {
    return this.isTv ? 'tv' : 'movie';
  }

  private meta() {
    if (!this.metaPromise) {
      this.metaPromise = (async () => {
        try {
          const append = this.isTv ? 'external_ids,translations' : 'credits,external_ids,translations';
          const body = await get(
            `https://db.wecollege.net/3/${this.type}/${this.tmdbId}?append_to_response=${append}&language=en`,
            4500,
          );
          const data = JSON.parse(body) as Record<string, unknown>;
          const title = String((this.isTv ? data.name : data.title) ?? '');

          const translations = ((data.translations as Record<string, unknown> | undefined)?.translations ?? []) as unknown[];
          const german = translations
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .find((entry) => entry.iso_639_1 === 'de');
          const germanData = (german?.data ?? {}) as Record<string, unknown>;
          const germanTitle = String(germanData.title ?? germanData.name ?? '');

          const external = (data.external_ids ?? {}) as Record<string, unknown>;
          return {
            title,
            year: String((this.isTv ? data.first_air_date : data.release_date) ?? '').split('-')[0],
            imdbId: String(external.imdb_id ?? data.imdb_id ?? ''),
            totalSeasons: this.isTv ? String(data.number_of_seasons ?? 1) : '1',
            titleGerman: germanTitle || title,
          };
        } catch {
          return { title: '', year: '', imdbId: '', totalSeasons: '1', titleGerman: '' };
        }
      })();
    }
    return this.metaPromise;
  }

  /** The seed lives ~30 s; renew it before then so a server picked minutes later still works. */
  private seed(): Promise<string | null> {
    if (!this.seedPromise || Date.now() - this.seedAt > 22000) {
      this.seedAt = Date.now();
      this.seedPromise = get(`https://api.wecollege.net/seed?mediaId=${this.tmdbId}`, 6000)
        .then((body) => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          return parsed.seed === undefined || parsed.seed === null ? null : String(parsed.seed);
        })
        .catch(() => null);
    }
    return this.seedPromise;
  }

  /** Starts the details and seed lookups together, so the first server is asked sooner. */
  warmUp(): void {
    void this.meta();
    void this.seed();
  }

  /** The stream from one server, or null when it has nothing. */
  async fetch(server: Shard): Promise<FoundStream | null> {
    const [meta, seed] = await Promise.all([this.meta(), this.seed()]);
    if (!seed) return null;

    const params = new URLSearchParams();
    params.set('title', meta.title);
    params.set('mediaType', this.type);
    params.set('year', meta.year);
    params.set('tmdbId', String(this.tmdbId));
    params.set('enc', '2');
    params.set('seed', seed);
    if (meta.imdbId) params.set('imdbId', meta.imdbId);
    if (this.isTv) {
      params.set('seasonId', String(this.season ?? 1));
      params.set('episodeId', String(this.episode ?? 1));
      params.set('totalSeasons', meta.totalSeasons);
    }
    if (server.altTitle && meta.title) params.set('altTitle', meta.title);
    if (server.germanTitle && meta.titleGerman) params.set('altTitle', meta.titleGerman);
    for (const [key, value] of Object.entries(server.extra)) params.set(key, value);

    let data: Record<string, unknown>;
    try {
      const enc = (await get(`https://api.wecollege.net/${server.shard}/sources?${params.toString()}`, 6500)).trim();
      if (!enc) return null;
      data = JSON.parse(decryptMovyPayload(enc, seed, this.tmdbId)) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Its qualities either sit in a master playlist (`playlist`) or come as separate
    // `sources` entries. VyseTV puts the alternates in a Quality menu; PRAHA's list
    // has one row per server, so the best one is the row and the rest are dropped.
    const seen = new Set<string>();
    const qualities: Array<{ label: string; url: string }> = [];
    for (const entry of Array.isArray(data.sources) ? data.sources : []) {
      if (!entry || typeof entry !== 'object') continue;
      const source = entry as Record<string, unknown>;
      const url = source.url ?? source.file;
      if (typeof url !== 'string' || !url || seen.has(url)) continue;
      seen.add(url);
      qualities.push({ label: movyQuality(String(source.quality ?? source.label ?? ''), url), url });
    }
    if (!qualities.length) return null;
    qualities.sort((a, b) => rank(b.label) - rank(a.label));

    const master = data.playlist;
    const hasMaster = typeof master === 'string' && master.startsWith('http');
    const url = hasMaster ? (master as string) : qualities[0].url;
    // DASH: the local relay only reads HLS, so it needs every header.
    const dash = new URL(url).pathname.endsWith('.mpd');

    return {
      url,
      server: server.name,
      quality: qualities[0].label,
      type: dash ? 'dash' : url.includes('/mp4/') || (url.includes('.mp4') && !url.includes('.m3u8')) ? 'mp4' : 'hls',
      headers: dash
        ? { Origin: 'https://www.vidy.st', Referer: 'https://www.vidy.st/', 'User-Agent': UA }
        : { Origin: 'https://www.vidy.st' },
      audio: server.audio ?? undefined,
    };
  }
}

/**
 * Every Movy server's stream for one title. The Dart asks a server only when
 * the user picks it. PRAHA publishes each response separately and leaves room
 * in the Android HTTP pool for other providers and the player.
 */
export async function findMovyStreams(query: {
  tmdbId: number;
  series: boolean;
  season?: number;
  episode?: number;
}, options: FilmScrapeOptions = {}): Promise<FoundStream[]> {
  const { tmdbId, series, season, episode } = query;
  if (!Number.isFinite(tmdbId) || tmdbId <= 0 || options.signal?.aborted) return [];

  const session = new MovySession(tmdbId, series, season, episode);
  session.warmUp();

  const preferred = MOVY_SERVERS.find((server) => server.name === options.preferredServer);
  const servers = preferred ? [preferred, ...MOVY_SERVERS.filter((server) => server !== preferred)] : MOVY_SERVERS;
  const work = servers.values();
  const answers = new Map<Shard, FoundStream>();
  const worker = async () => {
    for (const server of work) {
      if (options.signal?.aborted) return;
      const stream = await session.fetch(server).catch(() => null);
      if (stream && !options.signal?.aborted) {
        answers.set(server, stream);
        options.onStream?.(stream);
      }
    }
  };
  const lanes = Capacitor.getPlatform() === 'android' ? 3 : servers.length;
  await Promise.all(Array.from({ length: lanes }, worker));
  return MOVY_SERVERS.flatMap((server) => answers.get(server) ?? []);
}
