import { FILM_SOURCES, type FilmQuery, type FilmSource, type FoundStream } from './filmSources';
import { torrServerController } from './p2p/torrServerController';
import type { MediaItem, StreamResult } from '../types';

/**
 * The single source-priority chain for PRAHA.
 *
 *   1. VyseTV's 39 scrapers + Movy  ← FIRST, before anything we had before
 *   2. Debrid (RD / AD / Premiumize / Debrid-Link / TorBox)
 *   3. TorrServer (bundled on Android)
 *   4. Nuvio + Stremio addons
 *   5. EmbedModal iframe            ← LAST RESORT, never auto-selected
 *   6. "No source found" + retry
 *
 * `rankStreams` is the authoritative ordering used by the source list. The
 * existing providers keep their own async fetches; this module only assigns a
 * stage, converts scraper results into `StreamResult`, and sorts the final
 * list. Nothing here opens an iframe — that stays an explicit user action in
 * the UI.
 */

export const SOURCE_STAGES = [
  'scraper',
  'debrid',
  'torrserver',
  'nuvio',
  'stremio',
  'playtorrio',
  'iptv',
  'embed',
] as const;

export type SourceStage = (typeof SOURCE_STAGES)[number];

const STAGE_PRIORITY: Record<SourceStage, number> = {
  scraper: 0,
  debrid: 1,
  torrserver: 2,
  nuvio: 3,
  stremio: 4,
  playtorrio: 5,
  iptv: 6,
  embed: 7,
};

function stageOf(stream: StreamResult): SourceStage {
  return (SOURCE_STAGES as readonly string[]).includes(stream.sourceType)
    ? (stream.sourceType as SourceStage)
    : 'playtorrio';
}

/** Stable sort: priority first, then the provider's original order. */
export function rankStreams(streams: StreamResult[]): StreamResult[] {
  return streams
    .map((stream, index) => ({ stream, index }))
    .sort((a, b) => STAGE_PRIORITY[stageOf(a.stream)] - STAGE_PRIORITY[stageOf(b.stream)] || a.index - b.index)
    .map((entry) => entry.stream);
}

function foundToStream(found: FoundStream, sourceName: string): StreamResult {
  // A torrent result (Knaben) has no URL: the info hash is what plays, and
  // PlayerModal turns it into a magnet for TorrServer or WebTorrent.
  const isTorrent = found.type === 'torrent' || Boolean(found.infoHash && !found.url);
  return {
    id: `vysetv:${sourceName}:${found.url || found.infoHash}`,
    url: found.url,
    title: found.description || found.quality || found.server || sourceName,
    sourceName: `${sourceName} · ${found.server}`,
    sourceType: 'scraper',
    quality: found.quality,
    provider: sourceName,
    format: isTorrent ? undefined : found.type === 'hls' ? 'hls' : found.type === 'dash' ? 'dash' : undefined,
    headers: found.headers,
    referer: found.headers?.Referer || found.headers?.referer,
    // Only a torrent carries a hash. Putting the title's IMDb id here (as this
    // used to) made every direct stream read as a torrent to `streamTransport`.
    infoHash: isTorrent ? found.infoHash : undefined,
    seeders: found.seeders,
    size: found.size,
    language: found.audio,
  };
}

export interface ScrapeResult {
  streams: StreamResult[];
  failures: Array<{ source: string; message: string }>;
}

/**
 * Stage 1: ask every enabled VyseTV scraper in parallel, but keep results in
 * FILM_SOURCES order so the best-known sources appear at the top.
 *
 * `onPartial` fires as each lane lands, so the UI can show the 39 fast scrapers
 * instead of staring at a spinner until Knaben's 25 s budget runs out. The
 * promise still resolves with the complete, FILM_SOURCES-ordered list.
 */
export async function scrapeFilmSources(
  query: FilmQuery,
  options: {
    enabledIds?: string[];
    timeoutMs?: number;
    /** Called with everything finished so far, in FILM_SOURCES order. */
    onPartial?: (result: ScrapeResult) => void;
  } = {},
): Promise<ScrapeResult> {
  const enabled = options.enabledIds
    ? FILM_SOURCES.filter((source) => options.enabledIds!.includes(source.id))
    : FILM_SOURCES.filter((source) => {
        if (source.filmsOnly && query.season !== undefined) return false;
        if (source.showsOnly && query.season === undefined) return false;
        return true;
      });
  const timeoutMs = options.timeoutMs ?? 8000;

  /** One source's answer, with its own budget when it asked for one. */
  const ask = (source: FilmSource) =>
    Promise.race([
      source.scraper(query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), Math.max(timeoutMs, source.timeoutMs ?? 0))),
    ]);

  // A phone cannot hold 39 concurrent HTML parses, so the ordinary scrapers run
  // in small waves. The long-budget sources (Movy's 17 servers, Knaben's two
  // searches) run in their own lane at the same time, or their 20 s would be
  // spent waiting behind the waves rather than alongside them.
  const longLane = enabled.filter((source) => (source.timeoutMs ?? 0) > timeoutMs);
  const wavable = enabled.filter((source) => !longLane.includes(source));
  const answers = new Map<string, Awaited<ReturnType<FilmSource['scraper']>> | Error>();

  // Emit in FILM_SOURCES order, whatever order the lanes finished in, so a
  // partial result reads the same as the final one.
  const collect = (): ScrapeResult => {
    const streams: StreamResult[] = [];
    const failures: ScrapeResult['failures'] = [];
    for (const source of enabled) {
      const answer = answers.get(source.id);
      if (answer instanceof Error) failures.push({ source: source.name, message: answer.message });
      else if (Array.isArray(answer)) for (const found of answer) streams.push(foundToStream(found, source.name));
    }
    return { streams, failures };
  };
  const publish = () => { options.onPartial?.(collect()); };

  const longJob = (async () => {
    const settled = await Promise.allSettled(longLane.map(ask));
    settled.forEach((result, index) => {
      const source = longLane[index];
      answers.set(source.id, result.status === 'fulfilled' ? result.value : new Error(String(result.reason?.message || result.reason)));
    });
    if (longLane.length) publish();
  })();

  const CONCURRENCY = 8;
  for (let offset = 0; offset < wavable.length; offset += CONCURRENCY) {
    const wave = wavable.slice(offset, offset + CONCURRENCY);
    const settled = await Promise.allSettled(wave.map(ask));
    settled.forEach((result, index) => {
      const source = wave[index];
      answers.set(source.id, result.status === 'fulfilled' ? result.value : new Error(String(result.reason?.message || result.reason)));
    });
    // Each wave is visible immediately; the last one is the full list.
    publish();
  }
  await longJob;

  return collect();
}

/** Stage 3: resolve a magnet through the bundled TorrServer into a playable URL. */
export async function resolveViaTorrServer(
  magnetOrHash: string,
  options: { title?: string; fileIdx?: number } = {},
): Promise<StreamResult | null> {
  if (!(await torrServerController.ensureStarted())) return null;
  const client = torrServerController.client();
  if (!client) return null;
  try {
    const link = await torrServerController.augmentMagnet(magnetOrHash, { title: options.title });
    const info = await client.addTorrent({
      link,
      title: options.title || 'PRAHA Torrent Stream',
      saveToDb: true,
    });
    const hash = String(info.hash || '').toLowerCase();
    return {
      id: `torrserver:${hash || link}`,
      url: client.streamUrl(hash || link, options.fileIdx ?? 1),
      title: options.title || info.title || 'TorrServer stream',
      sourceName: 'TorrServer (bundled)',
      sourceType: 'torrserver',
      provider: 'TorrServer',
      infoHash: hash || undefined,
      fileIdx: options.fileIdx,
    };
  } catch {
    return null;
  }
}

/** Build the FilmQuery the scrapers expect from a PRAHA MediaItem. */
export function filmQueryFromMedia(media: MediaItem, season?: number, episode?: number): FilmQuery {
  const tmdbId = media.tmdbId ? String(media.tmdbId)
    : media.id.startsWith('tmdb:') ? media.id.slice(5) : media.id;
  return {
    id: tmdbId,
    title: media.title,
    year: media.year ? String(media.year) : undefined,
    imdbId: media.imdbId || (media.id.startsWith('tt') ? media.id : undefined),
    season,
    episode,
  };
}
