import React, { useEffect, useState } from 'react';
import { MonitorPlay } from 'lucide-react';
import { findStremioStreams, supportsResource } from '../services/stremioService';
import { findNuvioStreams } from '../services/nuvioService';
import { findPlayTorrioStreams } from '../services/playtorrioScrapers';
import {
  cloudStreamAvailable, getLinks, prefetch, toStreamResults,
} from '../services/cloudstreamService';
import { filmQueryFromMedia, rankStreams, scrapeFilmSources } from '../services/sourceOrchestrator';
import { FILM_SOURCES } from '../services/filmSources';
import { tmdbService } from '../services/tmdbService';
import { animeService } from '../services/animeService';
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
  /** Last resort only — opens the iframe aggregator when every source failed. */
  onOpenEmbedded?: () => void;
  onOpenExtensions: () => void;
  onPlay: (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string, alternatives?: StreamResult[]) => void;
  /**
   * Kept mounted but inert while the video player is on top. The source list is
   * expensive to build (every provider is queried again), so unmounting it when
   * playback starts made closing the player feel like a reload.
   */
  suspended?: boolean;
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
  onOpenEmbedded,
  onOpenExtensions,
  onPlay,
  suspended = false,
}) => {
  const [season, setSeason] = useState(initialSeason);
  const [episode, setEpisode] = useState(initialEpisode);
  const [seasons, setSeasons] = useState<TmdbSeasonSummary[] | undefined>(
    media.seasons?.length
      ? media.seasons
      : media.anime?.episodeCount && media.type === 'series'
        ? [{ id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: media.anime.episodeCount }]
        : undefined,
  );
  const [episodes, setEpisodes] = useState<TmdbEpisodeInfo[]>([]);
  const [resolvedTmdbId, setResolvedTmdbId] = useState<number | undefined>(media.tmdbId);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestKey, setRequestKey] = useState(0);

  const animeSlug = media.anime?.slug || (media.source === 'anicore' ? media.id.slice('anicore:'.length) : '');

  /**
   * A title that came out of a CloudStream extension is not a TMDB title: the
   * extension handed us the exact episode payload to load links from. Asking
   * Stremio/Nuvio/VyseTV for the same name would mix unrelated rips into a list
   * the user opened from one extension, and could even surface a different film
   * with the same title. So the other providers stay off.
   *
   * Declared once, above the load effect that reads it: a second copy further
   * down the component could drift from this one.
   */
  const extensionOnly = Boolean(
    media.cloudstreamApiName && media.cloudstreamPlayables?.length && cloudStreamAvailable(),
  );

  // Load real season metadata from AniCore (anime) or TMDB for series
  useEffect(() => {
    if (media.type !== 'series') return;
    let active = true;
    (async () => {
      if (animeSlug) {
        try {
          const list = await animeService.getEpisodes(animeSlug);
          if (!active || !list.length) return;
          const counts = new Map<number, number>();
          list.forEach((entry) => counts.set(entry.season, (counts.get(entry.season) || 0) + 1));
          setSeasons([...counts.entries()].sort((a, b) => a[0] - b[0]).map(([seasonNumber, episodeCount]) => ({
            id: seasonNumber, seasonNumber, name: `Season ${seasonNumber}`, episodeCount,
          })));
        } catch {
          // Fall back to plain season numbers when AniCore is unreachable
        }
        return;
      }
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
  }, [media, animeSlug]);

  // Load real episode titles for the active season
  useEffect(() => {
    if (media.type !== 'series') {
      setEpisodes([]);
      return;
    }
    if (animeSlug) {
      let active = true;
      animeService.getEpisodes(animeSlug)
        .then((list) => {
          if (!active) return;
          const seasonEps = list.filter((entry) => entry.season === season);
          const resolved = seasonEps.length ? seasonEps : list;
          setEpisodes(resolved);
          // Functional update: `episode` is deliberately not a dependency (it
          // would refetch the season on every pick), so reading it from this
          // closure meant switching seasons kept replaying the *previous*
          // season's episode number — and could leave an episode selected that
          // does not exist in the new list.
          if (resolved.length) {
            setEpisode((current) =>
              resolved.some((ep) => ep.episode === current) ? current : resolved[0].episode,
            );
          }
        })
        .catch(() => { if (active) setEpisodes([]); });
      return () => { active = false; };
    }
    if (!resolvedTmdbId) {
      setEpisodes([]);
      return;
    }
    let active = true;
    tmdbService.getSeason(resolvedTmdbId, season)
      .then((list) => {
        if (!active) return;
        setEpisodes(list);
        if (list.length) {
          setEpisode((current) =>
            list.some((ep) => ep.episode === current) ? current : list[0].episode,
          );
        }
      })
      .catch(() => { if (active) setEpisodes([]); });
    return () => { active = false; };
  }, [media.type, resolvedTmdbId, season, animeSlug]);

  useEffect(() => {
    let cancelled = false;
    let loadingCleared = false;
    const clearLoading = () => {
      if (cancelled || loadingCleared) return;
      loadingCleared = true;
      setLoading(false);
    };
    setLoading(true); setStreams([]); setErrors([]);

    // A title that came out of a CloudStream extension is not a TMDB title: the
    // extension handed us the exact episode payload to load links from. Asking
    // Stremio/Nuvio/VyseTV for the same name would mix unrelated rips into a
    // list the user opened from one extension, and could even surface a
    // different film with the same title. So the other providers stay off.
    // (`extensionOnly` is computed once, above.)
    const enabledAddons = extensionOnly
      ? []
      : addons.filter((addon) => addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'stream'));
    const scrapers = extensionOnly
      ? []
      : repositories.filter((repo) => repo.enabled).flatMap((repo) =>
          repo.scrapers.filter((scraper) => scraper.enabled).map((scraper) => ({ repo, scraper })));
    setHealth(extensionOnly
      ? [{ id: `cloudstream:${media.cloudstreamApiName}`, name: `${media.cloudstreamApiName} (CloudStream)`, status: 'searching' as const }]
      : [
          // Counted from the source list itself: the literal said 39 while the
          // list had grown to 41, so the health row under-reported the work.
          { id: 'vysetv:scrapers', name: `VyseTV scrapers + Movy (${FILM_SOURCES.length} sources)`, status: 'searching' as const },
          { id: 'playtorrio:vod', name: 'PlayTorrio VOD (up to 4K UHD)', status: 'searching' as const },
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
      // Don't let slow/dead providers keep the UI in a "searching" state forever.
      // The cap has to be cleared on the way out: `clearLoading` is idempotent, so
      // leaving it armed was harmless, but a live timer firing 4.5 s after the
      // modal closed kept the closure (and everything it captured) alive.
      const loadingCap = window.setTimeout(clearLoading, 4500);
      try {
        const idJob = extensionOnly
          ? Promise.resolve({ tmdbId: undefined as string | undefined, imdbId: undefined as string | undefined })
          : tmdbService.resolveIds(media).catch(() => ({
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
            // rankStreams puts VyseTV scrapers first, then debrid, TorrServer,
            // addons and finally the older PlayTorrio scrapers.
            return rankStreams([...current, ...result.streams]).filter((stream) => {
              const key = stream.url || (stream.ytId ? `youtube:${stream.ytId}` : stream.id);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          });
          setErrors((current) => [...current, ...result.errors]);
          if (result.streams.length || result.errors.length) clearLoading();
        };
        const knownImdb = media.imdbId || (media.id.startsWith('tt') ? media.id : undefined);
        const knownTmdb = media.tmdbId ? String(media.tmdbId) : media.id.startsWith('tmdb:') ? media.id.slice(5) : undefined;

        // Stage 1 — the VyseTV scrapers (see FILM_SOURCES) plus Movy. They
        // publish as they finish in waves, and rankStreams keeps them at the top
        // of the list. Movy and Knaben have their own longer budgets, so their
        // results arrive last; the fast scrapers must not be held back waiting
        // for them.
        const filmJob = extensionOnly ? Promise.resolve() : runProvider('vysetv:scrapers', async () => {
          const result = await scrapeFilmSources(filmQueryFromMedia(media, s, ep), {
            onPartial: (partial) => {
              // Publish each wave as it lands, but keep the provider's health
              // entry as "searching" until the full list arrives.
              if (!cancelled && partial.streams.length) publish({ streams: partial.streams, errors: [] });
            },
          });
          return {
            streams: result.streams,
            errors: result.streams.length
              ? []
              : result.failures.slice(0, 2).map((failure) => ({
                  sourceName: failure.source, message: failure.message,
                })),
          };
        }, publish);

        const stremioJob = extensionOnly ? Promise.resolve() : (async () => {
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
        const nuvioJob = extensionOnly ? Promise.resolve() : (async () => {
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
        const playtorrioJob = extensionOnly ? Promise.resolve() : (async () => {
          const tmdbId = knownTmdb || (await idJob).tmdbId;
          const id = 'playtorrio:vod';
          return runProvider(id, async () => {
            const results = await findPlayTorrioStreams(media.title, media.type, tmdbId, media.year, s, ep);
            return { streams: results, errors: [] };
          }, (result) => {
            if (cancelled) return;
            setStreams((current) => {
              const seen = new Set<string>();
              // PlayTorrio results go first so its 4K rows are visible without scrolling
              const combined = [...result.streams, ...current];
              return combined.filter((stream) => {
                const key = stream.url || (stream.ytId ? `youtube:${stream.ytId}` : stream.id);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            });
            if (result.streams.length) clearLoading();
          });
        })();
        const cloudstreamJob = (async () => {
          // Only a title that came from an extension can be resolved by one:
          // CloudStream links are looked up by the extension's own item data,
          // not by an IMDb/TMDB id, so there is nothing to ask for a TMDB title.
          const apiName = media.cloudstreamApiName;
          const playables = media.cloudstreamPlayables ?? [];
          if (!apiName || !playables.length || !cloudStreamAvailable()) return;
          const wantedSeason = media.type === 'series' ? s : undefined;
          const wantedEpisode = media.type === 'series' ? ep : undefined;
          const playable = (wantedSeason && wantedEpisode
            ? playables.find((entry) => entry.season === wantedSeason && entry.episode === wantedEpisode)
            : undefined)
            ?? playables[0];
          if (!playable) return;
          const id = `cloudstream:${apiName}`;
          prefetch(apiName, playable.data);
          return runProvider(id, async () => {
            const links = await getLinks(apiName, playable.data);
            const streams = toStreamResults(apiName, links);
            return { streams, errors: [] };
          }, publish);
        })();
        const jobs = [filmJob, playtorrioJob, stremioJob, nuvioJob, cloudstreamJob];
        await Promise.all(jobs);
      } catch (error) {
        if (!cancelled) setErrors([{ sourceName: 'Source search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
      } finally {
        window.clearTimeout(loadingCap);
        if (!cancelled) clearLoading();
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [media, season, episode, requestKey, addons, repositories, nuvioSettings]);
  useEffect(() => {
    if (suspended) return;
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.classList.remove('modal-open');
    };
  }, [onClose, suspended]);

  const activeStreamAddons = addons.filter((addon) => addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'stream')).length;
  const activeScrapers = repositories.filter((repo) => repo.enabled).reduce((sum, repo) => sum + repo.scrapers.filter((scraper) => scraper.enabled).length, 0);
  // A CloudStream title has exactly one provider: the extension that supplied
  // it. Counting the other stacks here would promise sources that are not queried.
  const providerCount = extensionOnly
    ? 1
    : activeStreamAddons + activeScrapers + 2;

  const currentEpTitle = episodes.find((e) => e.episode === episode)?.title;

  return (
    <div
      className={`modal-backdrop source-backdrop ${suspended ? 'source-suspended' : ''}`}
      onMouseDown={(event) => event.target === event.currentTarget && !suspended && onClose()}
      aria-hidden={suspended || undefined}
      inert={suspended || undefined}
    >
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
          sourceSummary={extensionOnly
            ? `${media.cloudstreamApiName} extension`
            : `${providerCount} provider${providerCount === 1 ? '' : 's'}`}
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
        {onOpenEmbedded && !extensionOnly && (
          <div className="source-embed-fallback">
            <span className="source-embed-note">Nothing above plays?</span>
            <button type="button" className="button button-secondary button-small" onClick={onOpenEmbedded}>
              <MonitorPlay size={14} /> Embedded players
            </button>
          </div>
        )}
      </section>
    </div>
  );
};

export default SourceModal;
