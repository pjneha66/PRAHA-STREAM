import React, { useEffect, useState } from 'react';
import { findStremioStreams } from '../services/stremioService';
import { findNuvioStreams } from '../services/nuvioService';
import { tmdbService } from '../services/tmdbService';
import type { InstalledAddon, MediaItem, NuvioRepository, SourceError, StreamResult } from '../types';
import SourcePanel from './SourcePanel';

const SourceModal: React.FC<{
  media: MediaItem;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  preferredLanguage: string;
  onClose: () => void;
  onOpenExtensions: () => void;
  onPlay: (stream: StreamResult) => void;
}> = ({ media, addons, repositories, preferredLanguage, onClose, onOpenExtensions, onPlay }) => {
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setStreams([]); setErrors([]);
    const load = async () => {
      try {
        const ids = await tmdbService.resolveIds(media).catch(() => ({ tmdbId: media.tmdbId ? String(media.tmdbId) : undefined, imdbId: media.imdbId }));
        const resolved = { ...media, imdbId: ids.imdbId || media.imdbId };
        const stremioJob = findStremioStreams(addons, resolved, media.type === 'series' ? season : undefined, media.type === 'series' ? episode : undefined);
        const nuvioJob = ids.tmdbId
          ? findNuvioStreams(repositories, ids.tmdbId, media.type, media.type === 'series' ? season : undefined, media.type === 'series' ? episode : undefined)
          : Promise.resolve({ streams: [], errors: repositories.length ? [{ sourceName: 'Nuvio', message: 'A TMDB ID could not be resolved for this title.' }] : [] });
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
          onSeasonChange={setSeason}
          onEpisodeChange={setEpisode}
          onRefresh={() => setRequestKey((key) => key + 1)}
          providerCount={providerCount}
          preferredLanguage={preferredLanguage}
          onPlay={onPlay}
          onOpenExtensions={onOpenExtensions}
          showClose
          onClose={onClose}
        />
      </section>
    </div>
  );
};

export default SourceModal;
