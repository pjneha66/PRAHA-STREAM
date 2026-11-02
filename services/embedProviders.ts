import type { MediaItem } from '../types';

export interface EmbedProvider { id: string; name: string; movie: string; series: string; }

// URL shapes based on each provider's published embed documentation, not live-verified streams.
export const EMBED_PRESETS: EmbedProvider[] = [
  { id: 'vidlink', name: 'VidLink', movie: 'https://vidlink.pro/movie/{tmdb}', series: 'https://vidlink.pro/tv/{tmdb}/{season}/{episode}' },
  { id: 'vidrock', name: 'VidRock', movie: 'https://vidrock.net/movie/{id}', series: 'https://vidrock.net/tv/{id}/{season}/{episode}' },
  { id: 'vixsrc', name: 'VixSrc', movie: 'https://vixsrc.to/movie/{id}', series: 'https://vixsrc.to/tv/{id}/{season}/{episode}' },
  { id: 'vidfast', name: 'VidFast', movie: 'https://vidfast.vc/movie/{id}', series: 'https://vidfast.vc/tv/{id}/{season}/{episode}' },
  { id: 'vidsrc-sh', name: 'VidSrc.sh', movie: 'https://vidsrc.sh/embed/movie/{id}', series: 'https://vidsrc.sh/embed/tv/{id}/{season}/{episode}' },
  { id: 'vidsrc-to', name: 'VidSrc.to', movie: 'https://vidsrc.to/embed/movie/{id}', series: 'https://vidsrc.to/embed/tv/{id}/{season}/{episode}' },
  { id: 'vidnest', name: 'VidNest', movie: 'https://vidnest.fun/movie/{tmdb}', series: 'https://vidnest.fun/tv/{tmdb}/{season}/{episode}' },
  { id: 'vidzee', name: 'VidZee', movie: 'https://player.vidzee.wtf/embed/movie/{tmdb}', series: 'https://player.vidzee.wtf/embed/tv/{tmdb}/{season}/{episode}' },
  { id: 'vidapi', name: 'VidAPI', movie: 'https://vaplayer.ru/embed/movie/{id}', series: 'https://vaplayer.ru/embed/tv/{id}/{season}/{episode}' },
  { id: 'primesrc', name: 'PrimeSrc', movie: 'https://primesrc.me/embed/movie?tmdb={tmdb}', series: 'https://primesrc.me/embed/tv?tmdb={tmdb}&season={season}&episode={episode}' },
  { id: 'cinemaos', name: 'CinemaOS', movie: 'https://cinemaos.tech/player/{tmdb}', series: 'https://cinemaos.tech/player/{tmdb}/{season}/{episode}' },
  { id: 'cinextream', name: 'Cinextream', movie: 'https://cinextream.cc/api/embed/movie/{tmdb}', series: 'https://cinextream.cc/api/embed/tv/{tmdb}/{season}/{episode}' },
  { id: 'superembed', name: 'SuperEmbed', movie: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1', series: 'https://multiembed.mov/?video_id={tmdb}&tmdb=1&s={season}&e={episode}' },
];

export function validateEmbedTemplate(template: string, type: 'movie' | 'series'): void {
  if (!template || template.length > 2048 || !/\{(?:id|tmdb|imdb)\}/.test(template)) throw new Error('Template must contain {id}, {tmdb}, or {imdb}.');
  if (type === 'series' && (!template.includes('{season}') || !template.includes('{episode}'))) throw new Error('Series template must include {season} and {episode}.');
  if (/\{(?!id\}|tmdb\}|imdb\}|season\}|episode\})/.test(template)) throw new Error('Unknown template placeholder.');
  const authority = template.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || /[{}@]/.test(authority)) throw new Error('Use an HTTPS URL with a fixed host and no credentials.');
  const url = new URL(template.replace(/\{(?:id|tmdb|imdb|season|episode)\}/g, '1'));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS templates without credentials are allowed.');
}

export function buildEmbedUrl(provider: EmbedProvider, media: MediaItem, season = 1, episode = 1): string {
  const template = media.type === 'series' ? provider.series : provider.movie;
  validateEmbedTemplate(template, media.type);
  const tmdb = media.tmdbId ? String(media.tmdbId) : media.id.startsWith('tmdb:') ? media.id.slice(5) : '';
  const imdb = media.imdbId || (media.id.startsWith('tt') ? media.id : '');
  if ((template.includes('{tmdb}') && !/^\d+$/.test(tmdb)) || (template.includes('{imdb}') && !/^tt\d+$/.test(imdb)) || (template.includes('{id}') && !/^\d+$/.test(tmdb) && !/^tt\d+$/.test(imdb))) throw new Error('The required TMDB or IMDb ID is unavailable for this title.');
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) throw new Error('Season and episode must be positive numbers.');
  const values: Record<string, string> = { id: /^\d+$/.test(tmdb) ? tmdb : imdb, tmdb, imdb, season: String(season), episode: String(episode) };
  const result = template.replace(/\{(id|tmdb|imdb|season|episode)\}/g, (_, key: string) => encodeURIComponent(values[key]));
  if (new URL(result).protocol !== 'https:') throw new Error('Only HTTPS providers are supported.');
  return result;
}

/** Apply only user-saved valid overrides; corrupt storage never replaces a preset. */
export function applyEmbedOverrides(presets: EmbedProvider[], overrides: unknown): EmbedProvider[] {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return presets;
  return presets.map((provider) => {
    const value = (overrides as Record<string, unknown>)[provider.id];
    if (!value || typeof value !== 'object') return provider;
    const candidate = value as Partial<EmbedProvider>;
    if (typeof candidate.movie !== 'string' || typeof candidate.series !== 'string') return provider;
    try {
      validateEmbedTemplate(candidate.movie, 'movie');
      validateEmbedTemplate(candidate.series, 'series');
      return { ...provider, movie: candidate.movie, series: candidate.series };
    } catch { return provider; }
  });
}
