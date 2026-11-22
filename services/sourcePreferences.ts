import type { StreamResult } from '../types';

/** Stable provider identity; never persist stream URLs or credentials as a preference. */
export function sourceKey(stream: Pick<StreamResult, 'sourceType' | 'sourceName'>): string {
  return JSON.stringify([stream.sourceType, stream.sourceName]);
}

export interface SourceFilters {
  quality: string;
  provider: string;
  language: string;
  codec: string;
  subtitles: string;
}

export function streamQuality(stream: StreamResult): string {
  const text = `${stream.quality || ''} ${stream.title}`.toLowerCase();
  if (/2160|4k|uhd/.test(text)) return '4K';
  if (/1080|fhd/.test(text)) return '1080p';
  if (/720/.test(text)) return '720p';
  if (/480/.test(text)) return '480p';
  return 'Unknown';
}

export function streamCodec(stream: StreamResult): string {
  const text = `${stream.title} ${stream.quality || ''}`.toUpperCase();
  if (/HEVC|H\.?265|X265/.test(text)) return 'HEVC';
  if (/AV1/.test(text)) return 'AV1';
  if (/AVC|H\.?264|X264/.test(text)) return 'H.264';
  return 'Unknown';
}

export type StreamTransport = 'hls' | 'dash' | 'direct' | 'mpegts' | 'torrent' | 'embed' | 'unknown';

export function streamTransport(stream: StreamResult): StreamTransport {
  const url = (stream.url || '').toLowerCase();
  if (stream.infoHash || url.startsWith('magnet:') || /\.torrent(\?|$)/.test(url)) return 'torrent';
  if (stream.ytId || stream.externalUrl) return 'embed';
  if (/\.m3u8(\?|$)/.test(url) || /[?&]format=m3u8\b/.test(url)) return 'hls';
  if (/\.mpd(\?|$)/.test(url)) return 'dash';
  if (/\.ts(\?|$)/.test(url) || /mpeg-?ts/.test(url)) return 'mpegts';
  if (/^https?:\/\//.test(url)) return 'direct';
  return 'unknown';
}

/** Alias kept for callers that prefer "type"/"kind"/"classify" naming. */
export const streamType = streamTransport;
export const streamKind = streamTransport;
export const classifyStream = streamTransport;

export function isDirectStream(stream: StreamResult): boolean {
  return streamTransport(stream) === 'direct';
}

export function isHlsStream(stream: StreamResult): boolean {
  return streamTransport(stream) === 'hls';
}

export function streamTransportPriority(stream: StreamResult): number {
  const transport = streamTransport(stream);
  // Direct and HLS are the most reliable in-app; torrent/embed/mpegts need more work.
  switch (transport) {
    case 'hls': return 60;
    case 'direct': return 55;
    case 'dash': return 45;
    case 'mpegts': return 20;
    case 'torrent': return 15;
    case 'embed': return 10;
    default: return 5;
  }
}

export function streamPriority(stream: StreamResult): number {
  // Movy is VyseTV's own source and sits first in its source list, so it takes
  // the top rank that 4KHDHub used to hold. 4KHDHub itself no longer gets a
  // special rank: it is graded on quality alone, like every other scraper.
  const isMovy = /movy/i.test(stream.sourceName) || /movy/i.test(stream.provider || '');
  const quality = streamQuality(stream);
  let base = 10;
  if (isMovy && quality === '4K') base = 100;
  else if (isMovy) base = 90;
  else if (quality === '4K') base = 80;
  else if (quality === '1080p') base = 60;
  else if (quality === '720p') base = 40;
  // Keep the historical numeric contract for streamPriority; transport preference is
  // applied as a tie-breaker in filterAndSortStreams instead.
  return base;
}

export function filterAndSortStreams(streams: StreamResult[], filters: SourceFilters, preferredSource: string, preferredLanguage: string): StreamResult[] {
  return streams.filter((stream) =>
    (filters.quality === 'all' || streamQuality(stream) === filters.quality) &&
    (filters.provider === 'all' || sourceKey(stream) === filters.provider) &&
    (filters.language === 'all' || (stream.language || '').toLowerCase() === filters.language) &&
    (filters.codec === 'all' || streamCodec(stream) === filters.codec) &&
    (filters.subtitles === 'all' || (filters.subtitles === 'available' ? Boolean(stream.subtitles?.length) : !stream.subtitles?.length)),
  ).sort((a, b) => {
    const preferred = Number(sourceKey(b) === preferredSource) - Number(sourceKey(a) === preferredSource);
    if (preferred !== 0) return preferred;
    const priority = streamPriority(b) - streamPriority(a);
    if (priority !== 0) return priority;
    const transport = streamTransportPriority(b) - streamTransportPriority(a);
    if (transport !== 0) return transport;
    const language = Number(Boolean(b.language && b.language.toLowerCase().startsWith(preferredLanguage.toLowerCase()))) - Number(Boolean(a.language && a.language.toLowerCase().startsWith(preferredLanguage.toLowerCase())));
    return language || (b.seeders || 0) - (a.seeders || 0);
  });
}
