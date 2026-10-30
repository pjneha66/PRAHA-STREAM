import React, { useEffect, useMemo, useState } from 'react';
import {
  Blocks, Check, ChevronDown, CircleAlert, Copy, Film, Languages,
  Play, RefreshCw, ShieldCheck, Users, X, Zap,
} from 'lucide-react';
import { findStremioStreams } from '../services/stremioService';
import { findNuvioStreams } from '../services/nuvioService';
import { tmdbService } from '../services/tmdbService';
import type { InstalledAddon, MediaItem, NuvioRepository, SourceError, StreamResult } from '../types';
import { Artwork } from './MediaCard';

const qualityOf = (stream: StreamResult) => {
  const text = `${stream.quality || ''} ${stream.title}`.toLowerCase();
  if (/2160|4k|uhd/.test(text)) return '4K';
  if (/1080/.test(text)) return '1080p';
  if (/720/.test(text)) return '720p';
  if (/480/.test(text)) return '480p';
  return stream.quality || 'AUTO';
};

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
  const [quality, setQuality] = useState('all');
  const [copied, setCopied] = useState('');

  const activeStreamAddons = addons.filter((addon) => addon.enabled && addon.manifest.resources.some((resource) => resource.name === 'stream')).length;
  const activeScrapers = repositories.filter((repo) => repo.enabled).reduce((sum, repo) => sum + repo.scrapers.filter((scraper) => scraper.enabled).length, 0);
  const providerCount = activeStreamAddons + activeScrapers;

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

  const filtered = useMemo(() => {
    const result = quality === 'all' ? streams : streams.filter((stream) => qualityOf(stream) === quality);
    return [...result].sort((a, b) => {
      const aPreferred = a.language?.toLowerCase().startsWith(preferredLanguage) ? 1 : 0;
      const bPreferred = b.language?.toLowerCase().startsWith(preferredLanguage) ? 1 : 0;
      return bPreferred - aPreferred || (b.seeders || 0) - (a.seeders || 0);
    });
  }, [streams, quality, preferredLanguage]);

  const copyStream = async (stream: StreamResult) => {
    await navigator.clipboard.writeText(stream.url);
    setCopied(stream.id);
    window.setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="modal-backdrop source-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="source-modal" role="dialog" aria-modal="true" aria-label={`Sources for ${media.title}`}>
        <header className="source-header">
          <div className="source-title-art"><Artwork src={media.poster} alt="" /></div>
          <div><span className="page-kicker">SOURCE FINDER</span><h2>{media.title}</h2><p>{media.year} · {media.type === 'movie' ? 'Movie' : 'Series'} <i /> Searching your library of sources</p></div>
          <button className="modal-close" onClick={onClose} aria-label="Close source finder"><X size={20} /></button>
        </header>
        {media.type === 'series' && <div className="episode-picker"><span>Watching</span><label>Season<select value={season} onChange={(event) => setSeason(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => <option key={index + 1}>{index + 1}</option>)}</select><ChevronDown size={13} /></label><label>Episode<select value={episode} onChange={(event) => setEpisode(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1}>{index + 1}</option>)}</select><ChevronDown size={13} /></label></div>}
        <div className="source-toolbar">
          <div className="source-search-status"><span className={`status-dot ${loading ? 'pulse' : ''}`} />{loading ? `Searching ${providerCount} provider${providerCount === 1 ? '' : 's'}…` : `${filtered.length} stream${filtered.length === 1 ? '' : 's'} found`}</div>
          <div className="quality-filters">{['all', '4K', '1080p', '720p'].map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)}>{value === 'all' ? 'All quality' : value}</button>)}</div>
          <button className="icon-button" onClick={() => setRequestKey((key) => key + 1)} disabled={loading} aria-label="Refresh streams"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
        </div>
        <div className="stream-list">
          {loading ? Array.from({ length: Math.max(3, Math.min(providerCount, 5)) }).map((_, index) => <div className="stream-skeleton" key={index}><span /><div><i /><i /></div></div>) : filtered.map((stream) => (
            <article className="stream-row" key={stream.id}>
              <button className="stream-play" onClick={() => onPlay(stream)} aria-label={`Play ${stream.title}`}><Play size={18} fill="currentColor" /></button>
              <div className="stream-main"><div className="stream-title"><strong>{stream.title}</strong><span className={`quality-badge quality-${qualityOf(stream).replace('p', '')}`}>{qualityOf(stream)}</span></div><div className="stream-meta"><span className={`stream-origin ${stream.sourceType}`}>{stream.sourceType === 'nuvio' ? <Zap size={11} /> : <Blocks size={11} />}{stream.sourceName}</span>{stream.provider && <span>{stream.provider}</span>}{stream.size && <span>{stream.size}</span>}{stream.language && <span><Languages size={12} />{stream.language}</span>}{typeof stream.seeders === 'number' && <span className="seeders"><Users size={12} />{stream.seeders} seeders</span>}</div></div>
              <div className="stream-actions"><button className="icon-button" onClick={() => copyStream(stream)} aria-label="Copy stream URL">{copied === stream.id ? <Check size={16} /> : <Copy size={16} />}</button><button className="button button-small button-primary" onClick={() => onPlay(stream)}>{stream.url.startsWith('magnet:') ? 'Open' : 'Play'}<Play size={14} fill="currentColor" /></button></div>
            </article>
          ))}
          {!loading && !filtered.length && (
            <div className="empty-state source-empty"><span><Film size={28} /></span><h2>{providerCount ? 'No streams found for this title' : 'Add a stream provider to press play'}</h2><p>{providerCount ? 'Try another episode, refresh your sources, or install an addon that supports this title’s ID.' : 'Cinemeta provides beautiful catalogs and metadata. Pair it with a Stremio stream addon or Nuvio repository to start watching.'}</p><button className="button button-primary" onClick={onOpenExtensions}><Blocks size={17} /> Manage extensions</button></div>
          )}
        </div>
        {!loading && errors.length > 0 && <details className="source-errors"><summary><CircleAlert size={14} />{errors.length} source{errors.length === 1 ? '' : 's'} couldn’t respond</summary>{errors.map((error, index) => <p key={`${error.sourceName}-${index}`}><strong>{error.sourceName}</strong>{error.message}</p>)}</details>}
        <footer className="source-footer"><ShieldCheck size={14} /><span>PRAHA does not host media. Availability and playback are provided by your installed sources.</span></footer>
      </section>
    </div>
  );
};

export default SourceModal;
