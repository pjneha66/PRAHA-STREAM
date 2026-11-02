import React, { useEffect, useState } from 'react';
import { findStremioStreams, supportsResource } from '../services/stremioService';
import { findNuvioStreams } from '../services/nuvioService';
import { tmdbService } from '../services/tmdbService';
import type {
  InstalledAddon, MediaItem, NuvioRepository,
  SourceError, StreamResult, TmdbEpisodeInfo, TmdbSeasonSummary, ProviderHealth,
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
  preferredSource: string;
  onPreferredSourceChange: (key: string) => void;
  onClose: () => void;
  onOpenExtensions: () => void;
  onPlay: (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string, alternatives?: StreamResult[]) => void;
}> = ({
  media,
  initialSeason = 1,
  initialEpisode = 1,
  addons,
  repositories,
  nuvioSettings,
  tmdbApiKey,
  preferredLanguage,
  preferredSource,
  onPreferredSourceChange,
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
  const [health, setHealth] = useState<ProviderHealth[]>([]);
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
    const enabledAddons = addons.filter((addon) => addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'stream'));
    const scrapers = repositories.filter((repo) => repo.enabled).flatMap((repo) =>
      repo.scrapers.filter((scraper) => scraper.enabled).map((scraper) => ({ repo, scraper })));
    setHealth([
      ...enabledAddons.map((addon) => ({ id: `stremio:${addon.manifestUrl}`, name: addon.manifest.name, status: 'searching' as const })),
      ...scrapers.map(({ repo, scraper }) => ({ id: `nuvio:${scraper.id}`, name: `${repo.name} · ${scraper.name}`, status: 'searching' as const })),
    ]);
    const updateHealth = (id: string, patch: Partial<ProviderHealth>) => {
      if (!cancelled) setHealth((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
    };
    const runProvider = async (id: string, job: () => Promise<{ streams: StreamResult[]; errors: SourceError[] }>, publish: (result: { streams: StreamResult[]; errors: SourceError[] }) => void) => {
      try {
        const result = await job();
        publish(result);
        updateHealth(id, result.errors.length
          ? { status: 'error', message: result.errors.map((error) => error.message).join('; ') }
          : { status: result.streams.length ? 'ready' : 'empty', count: result.streams.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider failed.';
        updateHealth(id, { status: 'error', message });
      }
    };
    const load = async () => {
      try {
        const idJob = tmdbService.resolveIds(media).catch(() => ({
          tmdbId: media.tmdbId ? String(media.tmdbId) : media.id.startsWith('tmdb:') ? media.id.slice(5) : undefined,
          imdbId: media.imdbId || (media.id.startsWith('tt') ? media.id : undefined),
        }));
        const s = media.type === 'series' ? season : undefined;
        const ep = media.type === 'series' ? episode : undefined;

        // Run providers independently so a slow scraper never blocks results
        // from providers that have already responded.
        const publish = (result: { streams: StreamResult[]; errors: SourceError[] }) => {
          if (cancelled) return;
          setStreams((current) => {
            const seen = new Set<string>();
            return [...current, ...result.streams].filter((stream) => {
              const key = stream.url || (stream.ytId ? `youtube:${stream.ytId}` : stream.id);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          });
          setErrors((current) => [...current, ...result.errors]);
        };
        const knownImdb = media.imdbId || (media.id.startsWith('tt') ? media.id : undefined);
        const knownTmdb = media.tmdbId ? String(media.tmdbId) : media.id.startsWith('tmdb:') ? media.id.slice(5) : undefined;
        const stremioJob = (async () => {
          const imdbId = knownImdb || (await idJob).imdbId;
          const resolved = { ...media, imdbId: imdbId || media.imdbId };
          await Promise.all(enabledAddons.map((addon) => {
            const id = `stremio:${addon.manifestUrl}`;
            if (!supportsResource(addon, 'stream', media.type, resolved.imdbId || media.id)) {
              updateHealth(id, { status: 'unsupported', message: 'This provider does not support this title type or ID.' });
              return Promise.resolve();
            }
            return runProvider(id, () => findStremioStreams([addon], resolved, s, ep), publish);
          }));
        })();
        const nuvioJob = (async () => {
          const tmdbId = knownTmdb || (await idJob).tmdbId;
          const jobs = scrapers.map(({ repo, scraper }) => {
            const id = `nuvio:${scraper.id}`;
            const wantedType = media.type === 'series' ? 'tv' : 'movie';
            const supported = scraper.supportedTypes.some((type) => (['series', 'show', 'other'].includes(type.toLowerCase()) ? 'tv' : type.toLowerCase()) === wantedType);
            if (!supported) {
              updateHealth(id, { status: 'unsupported', message: 'This scraper does not support this title type.' });
              return Promise.resolve();
            }
            if (!tmdbId) {
              updateHealth(id, { status: 'error', message: 'A TMDB ID could not be resolved for this title.' });
              return Promise.resolve();
            }
            return runProvider(id, () => findNuvioStreams([{ ...repo, scrapers: [scraper] }], tmdbId, media.type, s, ep, nuvioSettings), publish);
          });
          await Promise.all(jobs);
        })();
        const jobs = [stremioJob, nuvioJob];
        await Promise.all(jobs);
      } catch (error) {
        if (!cancelled) setErrors([{ sourceName: 'Source search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
      } finally { if (!cancelled) setLoading(false); }
    };
    const timer = window.setTimeout(load, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [media, season, episode, requestKey, addons, repositories, nuvioSettings]);

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
          health={health}
          preferredSource={preferredSource}
          onPreferredSourceChange={onPreferredSourceChange}
          season={season}
          episode={episode}
          seasons={seasons}
          episodes={episodes}
          onSeasonChange={(nextSeason) => { setSeason(nextSeason); setEpisode(1); }}
          onEpisodeChange={setEpisode}
          onRefresh={() => setRequestKey((key) => key + 1)}
          providerCount={providerCount}
          preferredLanguage={preferredLanguage}
          onPlay={(stream, alternatives) => onPlay(
            stream,
            media.type === 'series' ? season : undefined,
            media.type === 'series' ? episode : undefined,
            media.type === 'series' ? currentEpTitle : undefined,
            alternatives,
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
