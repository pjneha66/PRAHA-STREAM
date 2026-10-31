import React, { useEffect, useState } from 'react';
import { findStremioStreams } from '../services/stremioService';
import { findNuvioStreams } from '../services/nuvioService';
import { tmdbService } from '../services/tmdbService';
import type {
  InstalledAddon, MediaItem, NuvioRepository,
  SourceError, StreamResult, TmdbEpisodeInfo, TmdbSeasonSummary,
} from '../types';
import SourcePanel from './SourcePanel';

const SourceModal: React.FC<{
  media: MediaItem;
  initialSeason?: number;
  initialEpisode?: number;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  nuvioSettings: Record<string, Record<string, unknown>>;
  tmdbApiKey?: string;
  preferredLanguage: string;
  onClose: () => void;
  onOpenExtensions: () => void;
  onPlay: (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string) => void;
}> = ({
  media,
  initialSeason = 1,
  initialEpisode = 1,
  addons,
  repositories,
  nuvioSettings,
  tmdbApiKey,
  preferredLanguage,
  onClose,
  onOpenExtensions,
  onPlay,
}) => {
  const [season, setSeason] = useState(initialSeason);
  const [episode, setEpisode] = useState(initialEpisode);
  const [seasons, setSeasons] = useState<TmdbSeasonSummary[] | undefined>(media.seasons);
  const [episodes, setEpisodes] = useState<TmdbEpisodeInfo[]>([]);
  const [resolvedTmdbId, setResolvedTmdbId] = useState<number | undefined>(media.tmdbId);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestKey, setRequestKey] = useState(0);

  // Load real season metadata from TMDB for series
  useEffect(() => {
    if (media.type !== 'series') return;
    let active = true;
    (async () => {
      try {
        const enriched = media.seasons?.length ? media : await tmdbService.enrich(media);
        if (!active) return;
        if (enriched.tmdbId) setResolvedTmdbId(enriched.tmdbId);
        if (enriched.seasons?.length) setSeasons(enriched.seasons);
      } catch {
        // Keep fallback season numbers when TMDB key isn't set
      }
    })();
    return () => { active = false; };
  }, [media]);

  // Load real episode titles for the active season
  useEffect(() => {
    if (media.type !== 'series' || !resolvedTmdbId) {
      setEpisodes([]);
      return;
    }
    let active = true;
    tmdbService.getSeason(resolvedTmdbId, season)
      .then((list) => {
        if (!active) return;
        setEpisodes(list);
        if (list.length && !list.some((ep) => ep.episode === episode)) {
          setEpisode(list[0].episode);
        }
      })
      .catch(() => { if (active) setEpisodes([]); });
    return () => { active = false; };
  }, [media.type, resolvedTmdbId, season]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setStreams([]); setErrors([]);
    const load = async () => {
      try {
        const ids = await tmdbService.resolveIds(media).catch(() => ({
          tmdbId: media.tmdbId ? String(media.tmdbId) : undefined,
          imdbId: media.imdbId,
        }));
        const resolved = { ...media, imdbId: ids.imdbId || media.imdbId };
        const s = media.type === 'series' ? season : undefined;
        const ep = media.type === 'series' ? episode : undefined;

        const stremioJob = findStremioStreams(addons, resolved, s, ep);
        const nuvioJob = ids.tmdbId
          ? findNuvioStreams(repositories, ids.tmdbId, media.type, s, ep, nuvioSettings)
          : Promise.resolve({
              streams: [],
              errors: repositories.length ? [{ sourceName: 'Nuvio', message: 'A TMDB ID could not be resolved for this title.' }] : [],
            });

        const [stremio, nuvio] = await Promise.all([stremioJob, nuvioJob]);
        if (cancelled) return;
        const seen = new Set<string>();
        const unique = [...stremio.streams, ...nuvio.streams].filter((stream) => {
          const key = stream.url || (stream.ytId ? `youtube:${stream.ytId}` : stream.id);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setStreams(unique);
        setErrors([...stremio.errors, ...nuvio.errors]);
      } catch (error) {
        if (!cancelled) setErrors([{ sourceName: 'Source search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
      } finally { if (!cancelled) setLoading(false); }
    };
    const timer = window.setTimeout(load, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [media.id, season, episode, requestKey]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  const activeStreamAddons = addons.filter((addon) => addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'stream')).length;
  const activeScrapers = repositories.filter((repo) => repo.enabled).reduce((sum, repo) => sum + repo.scrapers.filter((scraper) => scraper.enabled).length, 0);
  const providerCount = activeStreamAddons + activeScrapers;

  const currentEpTitle = episodes.find((e) => e.episode === episode)?.title;

  return (
    <div className="modal-backdrop source-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="source-modal" role="dialog" aria-modal="true" aria-label={`Sources for ${media.title}`}>
        <SourcePanel
          media={media}
          streams={streams}
          loading={loading}
          errors={errors}
          season={season}
          episode={episode}
          seasons={seasons}
          episodes={episodes}
          onSeasonChange={(nextSeason) => { setSeason(nextSeason); setEpisode(1); }}
          onEpisodeChange={setEpisode}
          onRefresh={() => setRequestKey((key) => key + 1)}
          providerCount={providerCount}
          preferredLanguage={preferredLanguage}
          onPlay={(stream) => onPlay(
            stream,
            media.type === 'series' ? season : undefined,
            media.type === 'series' ? episode : undefined,
            media.type === 'series' ? currentEpTitle : undefined,
          )}
          onOpenExtensions={onOpenExtensions}
          showClose
          onClose={onClose}
        />
      </section>
    </div>
  );
};

export default SourceModal;
