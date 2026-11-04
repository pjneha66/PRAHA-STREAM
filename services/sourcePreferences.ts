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

export function streamPriority(stream: StreamResult): number {
  const is4khd = /4khd/i.test(stream.sourceName) || /4khd/i.test(stream.provider || '');
  const quality = streamQuality(stream);
  if (is4khd && quality === '4K') return 100;
  if (is4khd) return 90;
  if (quality === '4K') return 80;
  if (quality === '1080p') return 60;
  if (quality === '720p') return 40;
  return 10;
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
    const language = Number(Boolean(b.language && b.language.toLowerCase().startsWith(preferredLanguage.toLowerCase()))) - Number(Boolean(a.language && a.language.toLowerCase().startsWith(preferredLanguage.toLowerCase())));
    return language || (b.seeders || 0) - (a.seeders || 0);
  });
}
