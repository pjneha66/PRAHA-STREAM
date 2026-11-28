import { createPortal } from 'react-dom';
import React, { useEffect, useRef, useState } from 'react';
import { MonitorPlay } from 'lucide-react';
import { findStremioStreams, supportsResource } from '../services/stremioService';
import { addonTarget, streamIdFor } from '../services/metaAddons';
import { findNuvioStreams } from '../services/nuvioService';
import { findPlayTorrioStreams } from '../services/playtorrioScrapers';
import {
  cloudStreamAvailable, getLinks, prefetch, toStreamResults,
} from '../services/cloudstreamService';
import { filmQueryFromMedia, rankStreams, scrapeFilmSources } from '../services/sourceOrchestrator';
import { findRefreshedStream } from '../services/sourcePreferences';
import { findPluginStreamsEverywhere } from '../services/pluginFinder';
import { buildPluginQuery } from '../services/pluginRuntime';
import { activeRepos } from '../services/pluginRepositories';
import * as pluginCatalogs from '../services/pluginCatalogs';
import { enabledEcosystemExtensions, listEcosystemExtensions } from '../services/ecosystems/store';
import { findEcosystemStreams } from '../services/ecosystems/streams';
import { FILM_SOURCES } from '../services/filmSources';
import { tmdbService } from '../services/tmdbService';
import { animeService } from '../services/animeService';
import type {
  InstalledAddon, MediaItem, NuvioRepository, PluginRepository,
  SourceError, StreamResult, TmdbEpisodeInfo, TmdbSeasonSummary, ProviderHealth,
} from '../types';
import SourcePanel from './SourcePanel';
import { hikiStreams } from '../services/hikariExtensions';
import { ruleScraperStreamsFor } from '../services/ruleScraper';

/**
 * The empty plugin list. It must be one shared array: a `= []` default in the
 * destructuring below would build a fresh array on every render, the load
 * effect depends on `pluginRepositories`, and a new identity each pass would
 * restart the whole source search forever.
 */
const NO_PLUGIN_REPOSITORIES: PluginRepository[] = [];

const SourceModal: React.FC<{
  media: MediaItem;
  initialSeason?: number;
  initialEpisode?: number;
  initialEpisodeTitle?: string;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  /** Installed JavaScript plugin repositories (VyseTV's plugin engine). */
  pluginRepositories?: PluginRepository[];
  nuvioSettings: Record<string, Record<string, unknown>>;
  tmdbApiKey?: string;
  preferredLanguage: string;
  preferredSource: string;
  lastSource?: string;
  retryStream?: StreamResult;
  onResume?: (stream: StreamResult) => void;
  onPreferredSourceChange: (key: string) => void;
  onClose: () => void;
  /** Last resort only — opens the iframe aggregator when every source failed. */
  onOpenEmbedded?: (season?: number, episode?: number) => void;
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
  initialEpisodeTitle,
  addons,
  repositories,
  pluginRepositories = NO_PLUGIN_REPOSITORIES,
  nuvioSettings,
  tmdbApiKey,
  preferredLanguage,
  preferredSource,
  lastSource,
  retryStream,
  onResume,
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
  const [settledEpisode, setSettledEpisode] = useState('');
  const [requestKey, setRequestKey] = useState(0);
  const [recovering, setRecovering] = useState(Boolean(retryStream));
  const [refreshedStream, setRefreshedStream] = useState<StreamResult>();
  const resumePending = useRef(Boolean(retryStream));

  useEffect(() => {
    if (!refreshedStream || !onResume || !resumePending.current || suspended) return;
    resumePending.current = false;
    onResume(refreshedStream);
  }, [refreshedStream, onResume, suspended]);

  const stopRecovery = () => {
    resumePending.current = false;
    setRecovering(false);
  };

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
  const hikariTitle = media.hikari;
  const ruleTitle = media.ruleScraper;
  const extensionName = hikariTitle?.provider.name || ruleTitle?.config.name || media.cloudstreamApiName;
  const extensionOnly = Boolean(
    hikariTitle || ruleTitle || media.cloudstreamApiName && media.cloudstreamPlayables?.length && cloudStreamAvailable(),
  );

  // Load real season metadata from AniCore (anime) or TMDB for series
  useEffect(() => {
    if (media.type !== 'series' || hikariTitle) return;
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
  }, [media, animeSlug, hikariTitle]);

  // Load real episode titles for the active season
  useEffect(() => {
    if (media.type !== 'series') {
      setEpisodes([]);
      return;
    }
    if (hikariTitle) {
      const list = hikariTitle.episodes.filter((entry) => entry.season === season)
        .map((entry) => ({ id: entry.number, season: entry.season, episode: entry.number,
          title: entry.name || `Episode ${entry.number}`, overview: '', still: entry.image }));
      setEpisodes(list);
      if (list.length) setEpisode((current) => list.some((item) => item.episode === current) ? current : list[0].episode);
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
  }, [media.type, resolvedTmdbId, season, animeSlug, hikariTitle]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
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
    // The JavaScript plugins, one health row per plugin so a dead one is visible
    // rather than folded into a single "plugins" line.
    const pluginRepos = extensionOnly ? [] : activeRepos(pluginRepositories);
    const pluginJobs = pluginRepos.flatMap((repo) =>
      repo.plugins.map((plugin) => ({ repo, plugin })));
    const ecosystemRows = extensionOnly ? [] : listEcosystemExtensions()
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        id: `eco:${entry.key}`,
        name: `${entry.name} (${entry.ecosystem === 'sora' ? 'Sora' : entry.ecosystem === 'skystream' ? 'SkyStream' : entry.ecosystem === 'zangetsu' ? 'Zangetsu' : 'AnymeX'})`,
        status: 'searching' as const,
      }));
    const ownEcosystem = ecosystemRows.find((row) => row.id === `eco:${media.providerId}`);
    setHealth(extensionOnly
      ? [{ id: hikariTitle ? `hiki:${hikariTitle.provider.key}` : `cloudstream:${media.cloudstreamApiName}`,
          name: `${extensionName} (${hikariTitle ? 'Hikari' : 'CloudStream'})`, status: 'searching' as const }]
      : [
          // Counted from the source list itself: the literal said 39 while the
          // list had grown to 41, so the health row under-reported the work.
          { id: 'vysetv:scrapers', name: `VyseTV scrapers + Movy (${FILM_SOURCES.length} sources)`, status: 'searching' as const },
          { id: 'playtorrio:vod', name: 'PlayTorrio VOD (up to 4K UHD)', status: 'searching' as const },
          ...enabledAddons.map((addon) => ({ id: `stremio:${addon.manifestUrl}`, name: addon.manifest.name, status: 'searching' as const })),
          ...scrapers.map(({ repo, scraper }) => ({ id: `nuvio:${scraper.id}`, name: `${repo.name} · ${scraper.name}`, status: 'searching' as const })),
          ...pluginJobs.map(({ repo, plugin }) => ({ id: `plugin:${repo.url}:${plugin.id}`, name: `${repo.name} · ${plugin.name}`, status: 'searching' as const })),
          // A title from one ecosystem extension is asked of that one alone.
          ...(ownEcosystem ? [ownEcosystem] : ecosystemRows),
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

        const checkRecovery = (results: StreamResult[]) => {
          if (!retryStream || !resumePending.current || season !== initialSeason || episode !== initialEpisode) return;
          const match = findRefreshedStream(results, retryStream);
          if (match) setRefreshedStream((current) => current ?? match);
        };

        // Run providers independently so a slow scraper never blocks results
        // from providers that have already responded.
        const publish = (result: { streams: StreamResult[]; errors: SourceError[] }) => {
          if (cancelled) return;
          checkRecovery(result.streams);
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
          if (result.streams.length) clearLoading();
        };
        const knownImdb = media.imdbId || (media.id.startsWith('tt') ? media.id : undefined);
        const knownTmdb = media.tmdbId ? String(media.tmdbId) : media.id.startsWith('tmdb:') ? media.id.slice(5) : undefined;

        // Stage 1 — the VyseTV scrapers (see FILM_SOURCES) plus Movy. They
        // publish as each source finishes, and rankStreams keeps them at the top
        // of the list. Movy and Knaben have their own longer budgets, so their
        // results arrive last; the fast scrapers must not be held back waiting
        // for them.
        const filmJob = extensionOnly ? Promise.resolve() : runProvider('vysetv:scrapers', async () => {
          const seen = new Set<string>();
          const result = await scrapeFilmSources(filmQueryFromMedia(media, s, ep), {
            signal: controller.signal,
            preferredSource: retryStream,
            onPartial: (partial) => {
              if (cancelled) return;
              const fresh = partial.streams.filter((stream) => {
                const key = JSON.stringify([stream.sourceName, stream.id]);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              if (fresh.length) publish({ streams: fresh, errors: [] });
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

        // A title that came from a metadata addon is asked for streams by the
        // ids its addon gave it (`kitsu:7442:1`, `tt0944947:1:1`), not by
        // whatever prefix a stream addon happens to accept. `addonTarget`
        // resolves the episode's own video id, and `streamAskFor` picks, per
        // addon, the first id that addon declared it understands.
        const metaTargetJob = media.source === 'stremio' && media.addonUrl
          ? addonTarget(media, addons, media.type === 'series' ? { season: s, episode: ep } : undefined)
            .catch(() => null)
          : Promise.resolve(null);
        const stremioJob = extensionOnly ? Promise.resolve() : (async () => {
          const metaTarget = await metaTargetJob;
          if (cancelled) return;
          const streamAsk = metaTarget
            ? (addon: InstalledAddon) => {
                const id = streamIdFor(addon, metaTarget);
                return id ? { id, type: metaTarget.type } : null;
              }
            : undefined;

          const imdbId = streamAsk ? undefined : knownImdb || (await idJob).imdbId;
          const resolved = streamAsk ? media : { ...media, imdbId: imdbId || media.imdbId };
          await Promise.all(enabledAddons.map((addon) => {
            const id = `stremio:${addon.manifestUrl}`;
            if (streamAsk) {
              if (!streamAsk(addon)) {
                updateHealth(id, { status: 'unsupported', message: 'This provider has no id for this title.' });
                return Promise.resolve();
              }
            } else if (!supportsResource(addon, 'stream', media.type, resolved.imdbId || media.id)) {
              updateHealth(id, { status: 'unsupported', message: 'This provider does not support this title type or ID.' });
              return Promise.resolve();
            }
            return runProvider(id, () => findStremioStreams([addon], resolved, s, ep, streamAsk), publish);
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
            const results = await findPlayTorrioStreams(media.title, media.type, tmdbId, media.year, s, ep,
              (streams) => publish({ streams, errors: [] }));
            return { streams: results, errors: [] };
          }, (result) => {
            if (cancelled) return;
            checkRecovery(result.streams);
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
        // Stage 1.5 — the extension ecosystems (Sora, SkyStream, Zangetsu,
        // AnymeX). Each installed extension is its own provider row, asked the
        // same way: search the title, resolve the episode, list the links. A
        // title that came from one of them is asked of that extension alone.
        const ecosystemJob = extensionOnly ? Promise.resolve() : (async () => {
          const all = listEcosystemExtensions().filter((entry) => entry.enabled);
          if (!all.length) return;
          // One of this extension's own titles: that extension alone, by its id.
          const ownKey = all.find((entry) => media.source === entry.ecosystem && media.providerId === entry.key);
          const asked = ownKey ? [ownKey] : all;
          return Promise.all(asked.map((extension) => runProvider(`eco:${extension.key}`, async () => {
            const streams = await findEcosystemStreams(extension, {
              title: media.title,
              year: media.year ? Number(media.year) || null : null,
              ownId: ownKey ? media.providerMediaId ?? undefined : undefined,
              season: media.type === 'series' ? s ?? null : null,
              episode: media.type === 'series' ? ep ?? null : null,
            });
            return { streams, errors: [] };
          }, publish)));
        })();
        // Stage 2 — the JavaScript plugins of every installed repository. They
        // report the same way VyseTV's do: each one publishes the moment it
        // lands, so a slow plugin (they run 3–8 at a time) holds nothing up.
        // A plugin that finds no link is not an error; only one that could not
        // run at all turns its row red.
        const pluginJob = extensionOnly ? Promise.resolve() : (async () => {
          if (!pluginRepos.length) return;
          // One of a plugin's own titles (from its catalog): that plugin alone,
          // asked by the id it gave it — the site's own link, not a name search.
          const metaTarget = await metaTargetJob;
          if (cancelled) return;
          const own = pluginCatalogs.pluginOwnOf(media, metaTarget?.video);
          const query = buildPluginQuery({
            tmdbId: media.tmdbId ?? (media.id.startsWith('tmdb:') ? Number(media.id.slice(5)) : null),
            imdbId: knownImdb || media.imdbId || null,
            isTv: media.type === 'series',
            title: media.title,
            originalTitle: media.originalTitle,
            year: media.year ?? null,
            season: s ?? null,
            episode: ep ?? null,
          });
          if (own) query.ownId = own.own;
          // The rows start as "searching"; the first plugin to land clears them
          // all, because `findPluginStreamsEverywhere` publishes a merged list.
          const answered = new Set<string>();
          try {
            await findPluginStreamsEverywhere(own ? pluginRepos.filter((repo) => repo.url === own.repoUrl) : pluginRepos, query, {
              only: own?.plugin,
              onSome: (hits) => {
                if (cancelled || !hits.length) return;
                for (const hit of hits) {
                  const key = `${hit.plugin.id}`;
                  if (answered.has(key)) continue;
                  answered.add(key);
                  const repo = pluginRepos.find((candidate) => candidate.plugins.some((p) => p.id === hit.plugin.id));
                  if (repo) updateHealth(`plugin:${repo.url}:${hit.plugin.id}`, { status: 'ready' });
                }
                publish({ streams: hits.map((hit) => hit.result), errors: [] });
              },
            });
            // Every plugin that did not land a link is idle, not broken.
            for (const { repo, plugin } of pluginJobs) {
              if (!answered.has(plugin.id)) {
                updateHealth(`plugin:${repo.url}:${plugin.id}`, { status: 'empty', message: 'No link for this title.' });
              }
            }
          } catch (error) {
            for (const { repo, plugin } of pluginJobs) {
              updateHealth(`plugin:${repo.url}:${plugin.id}`, {
                status: 'error',
                message: error instanceof Error ? error.message : 'The plugin repository failed.',
              });
            }
          }
        })();
        const hikariJob = hikariTitle ? runProvider(`hiki:${hikariTitle.provider.key}`, async () => {
          try {
            return { streams: await hikiStreams(hikariTitle, s, ep), errors: [] };
          } catch (error) {
            return { streams: [], errors: [{ sourceName: hikariTitle.provider.name,
              message: error instanceof Error ? error.message : 'Hikari could not load the streams.' }] };
          }
        }, publish) : Promise.resolve();
        const ruleJob = ruleTitle ? runProvider(`rule:${ruleTitle.config.name}`, async () => {
          try {
            return { streams: await ruleScraperStreamsFor(ruleTitle, s, ep), errors: [] };
          } catch (error) {
            return { streams: [], errors: [{ sourceName: ruleTitle.config.name,
              message: error instanceof Error ? error.message : 'The rule source could not load the streams.' }] };
          }
        }, publish) : Promise.resolve();
        const jobs = [filmJob, playtorrioJob, stremioJob, nuvioJob, pluginJob, cloudstreamJob, ecosystemJob, hikariJob, ruleJob];
        await Promise.all(jobs);
      } catch (error) {
        if (!cancelled) setErrors([{ sourceName: 'Source search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
      } finally {
        window.clearTimeout(loadingCap);
        if (!cancelled) {
          clearLoading();
          setRecovering(false);
          setSettledEpisode(`${media.id}|${season ?? 1}|${episode ?? 1}`);
        }
      }
    };
    setSettledEpisode('');
    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [media, season, episode, requestKey, addons, repositories, pluginRepositories, nuvioSettings, retryStream]);
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

  const currentEpTitle = episodes.find((e) => e.episode === episode)?.title
    ?? (season === initialSeason && episode === initialEpisode ? initialEpisodeTitle : undefined);

  return createPortal(
    <div
      className={`modal-backdrop source-backdrop ${suspended ? 'source-suspended' : ''}`}
      onMouseDown={(event) => event.target === event.currentTarget && !suspended && onClose()}
      aria-hidden={suspended || undefined}
      inert={suspended || undefined}
    >
      <section className="source-modal" role="dialog" aria-modal="true" aria-label={`Sources for ${media.title}`}>
        {retryStream && resumePending.current && (
          <div className="source-embed-fallback" role="status">
            {recovering ? `Reconnecting to ${retryStream.sourceName}…` : `${retryStream.sourceName} was unavailable. Choose a stream to continue.`}
          </div>
        )}
        <SourcePanel
          media={media}
          streams={streams}
          loading={loading}
          settledEpisode={settledEpisode}
          errors={errors}
          health={health}
          preferredSource={preferredSource}
          lastSource={lastSource}
          onPreferredSourceChange={onPreferredSourceChange}
          season={season}
          episode={episode}
          seasons={seasons}
          episodes={episodes}
          onSeasonChange={(nextSeason) => { stopRecovery(); setSeason(nextSeason); setEpisode(1); }}
          onEpisodeChange={(nextEpisode) => { stopRecovery(); setEpisode(nextEpisode); }}
          onRefresh={() => { stopRecovery(); setRequestKey((key) => key + 1); }}
          providerCount={providerCount}
          preferredLanguage={preferredLanguage}
          sourceSummary={extensionOnly
            ? `${extensionName} extension`
            : `${providerCount} provider${providerCount === 1 ? '' : 's'}`}
          onPlay={(stream, alternatives) => {
            stopRecovery();
            onPlay(
              stream,
              media.type === 'series' ? season : undefined,
              media.type === 'series' ? episode : undefined,
              media.type === 'series' ? currentEpTitle : undefined,
              alternatives,
            );
          }}
          onOpenExtensions={onOpenExtensions}
          showClose
          onClose={onClose}
        />
        {onOpenEmbedded && !extensionOnly && (
          <div className="source-embed-fallback">
            <span className="source-embed-note">Nothing above plays?</span>
            <button type="button" className="button button-secondary button-small" onClick={() => onOpenEmbedded(season, episode)}>
              <MonitorPlay size={14} /> Embedded players
            </button>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
};

export default SourceModal;
