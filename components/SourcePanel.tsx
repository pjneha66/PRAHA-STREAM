import React, { useMemo, useState } from 'react';
import {
  Blocks, Check, CircleAlert, Copy, Film, Languages, Play, RefreshCw,
  ShieldCheck, Users, X, Zap,
} from 'lucide-react';
import type { MediaItem, SourceError, StreamResult, TmdbEpisodeInfo, TmdbSeasonSummary } from '../types';
import { Artwork } from './MediaCard';

export const qualityOf = (stream: StreamResult) => {
  const text = `${stream.quality || ''} ${stream.title}`.toLowerCase();
  if (/2160|4k|uhd/.test(text)) return '4K';
  if (/1080/.test(text)) return '1080p';
  if (/720/.test(text)) return '720p';
  if (/480/.test(text)) return '480p';
  return stream.quality || 'AUTO';
};

interface SourcePanelProps {
  media: MediaItem;
  streams: StreamResult[];
  loading: boolean;
  errors: SourceError[];
  season?: number;
  episode?: number;
  seasons?: TmdbSeasonSummary[];
  episodes?: TmdbEpisodeInfo[];
  onSeasonChange?: (value: number) => void;
  onEpisodeChange?: (value: number) => void;
  onRefresh?: () => void;
  providerCount: number;
  preferredLanguage: string;
  onPlay: (stream: StreamResult) => void;
  onOpenExtensions?: () => void;
  showClose?: boolean;
  onClose?: () => void;
}

const SourcePanel: React.FC<SourcePanelProps> = ({
  media, streams, loading, errors, season, episode, seasons, episodes,
  onSeasonChange, onEpisodeChange, onRefresh, providerCount, preferredLanguage,
  onPlay, onOpenExtensions, showClose, onClose,
}) => {
  const [quality, setQuality] = useState('all');
  const [copied, setCopied] = useState('');

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

  const seasonOptions = useMemo(() => {
    if (seasons && seasons.length) return seasons.map((s) => ({ value: s.seasonNumber, label: `${s.seasonNumber} · ${s.name}` }));
    const count = media.numberOfSeasons || 10;
    return Array.from({ length: count }, (_, idx) => ({ value: idx + 1, label: `Season ${idx + 1}` }));
  }, [seasons, media.numberOfSeasons]);

  const episodeOptions = useMemo(() => {
    if (episodes && episodes.length) {
      return episodes.map((ep) => ({ value: ep.episode, label: `${ep.episode} · ${ep.title}` }));
    }
    const matchingSeason = seasons?.find((s) => s.seasonNumber === (season ?? 1));
    const count = matchingSeason?.episodeCount || 24;
    return Array.from({ length: count }, (_, idx) => ({ value: idx + 1, label: `Episode ${idx + 1}` }));
  }, [episodes, seasons, season]);

  return (
    <>
      <header className="source-header">
        <div className="source-title-art"><Artwork src={media.poster} alt="" /></div>
        <div>
          <span className="page-kicker">SOURCE FINDER</span>
          <h2>{media.title}</h2>
          <p>{media.year || ''} · {media.type === 'movie' ? 'Movie' : 'Series'} <i /> Stremio, Nuvio & CloudStream</p>
        </div>
        {showClose && <button className="modal-close" onClick={onClose} aria-label="Close source finder"><X size={20} /></button>}
      </header>
      {media.type === 'series' && onSeasonChange && (
        <div className="episode-picker">
          <span>Watching</span>
          <label>
            Season
            <select value={season ?? 1} onChange={(event) => onSeasonChange(Number(event.target.value))}>
              {seasonOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
          <label>
            Episode
            <select value={episode ?? 1} onChange={(event) => onEpisodeChange?.(Number(event.target.value))}>
              {episodeOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="source-toolbar">
        <div className="source-search-status"><span className={`status-dot ${loading ? 'pulse' : ''}`} />{loading ? `Searching ${providerCount} provider${providerCount === 1 ? '' : 's'}…` : `${filtered.length} stream${filtered.length === 1 ? '' : 's'} found`}</div>
        <div className="quality-filters">{['all', '4K', '1080p', '720p'].map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)}>{value === 'all' ? 'All quality' : value}</button>)}</div>
        <button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh streams"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>
      <div className="stream-list">
        {loading ? Array.from({ length: Math.max(3, Math.min(providerCount, 5)) }).map((_, index) => <div className="stream-skeleton" key={index}><span /><div><i /><i /></div></div>) : filtered.map((stream) => (
          <article className="stream-row" key={stream.id}>
            <button className="stream-play" onClick={() => onPlay(stream)} aria-label={`Play ${stream.title}`}><Play size={18} fill="currentColor" /></button>
            <div className="stream-main">
              <div className="stream-title"><strong>{stream.title}</strong><span className={`quality-badge quality-${qualityOf(stream).replace('p', '')}`}>{qualityOf(stream)}</span></div>
              <div className="stream-meta">
                <span className={`stream-origin ${stream.sourceType}`}>{stream.sourceType === 'cloudstream' ? <Zap size={11} /> : stream.sourceType === 'nuvio' ? <Zap size={11} /> : <Blocks size={11} />}{stream.sourceName}</span>
                {stream.provider && stream.provider !== stream.sourceName && <span>{stream.provider}</span>}
                {stream.size && <span>{stream.size}</span>}
                {stream.language && <span><Languages size={12} />{stream.language}</span>}
                {typeof stream.seeders === 'number' && <span className="seeders"><Users size={12} />{stream.seeders} seeders</span>}
              </div>
            </div>
            <div className="stream-actions">
              <button className="icon-button" onClick={() => copyStream(stream)} aria-label="Copy stream URL">{copied === stream.id ? <Check size={16} /> : <Copy size={16} />}</button>
              <button className="button button-small button-primary" onClick={() => onPlay(stream)}>{stream.url.startsWith('magnet:') ? 'Open' : 'Play'}<Play size={14} fill="currentColor" /></button>
            </div>
          </article>
        ))}
        {!loading && !filtered.length && (
          <div className="empty-state source-empty">
            <span><Film size={28} /></span>
            <h2>{providerCount ? 'No streams found for this title' : 'Add a stream provider to press play'}</h2>
            <p>{providerCount ? 'Try another episode, refresh your sources, or install an addon that supports this title’s ID.' : 'Install a Stremio stream addon, a Nuvio provider, or a CloudStream JavaScript extension to start watching.'}</p>
            {onOpenExtensions && <button className="button button-primary" onClick={onOpenExtensions}><Blocks size={17} /> Manage extensions</button>}
          </div>
        )}
      </div>
      {!loading && errors.length > 0 && (
        <details className="source-errors">
          <summary><CircleAlert size={14} />{errors.length} source{errors.length === 1 ? '' : 's'} couldn’t respond</summary>
          {errors.map((error, index) => <p key={`${error.sourceName}-${index}`}><strong>{error.sourceName}</strong>{error.message}</p>)}
        </details>
      )}
      <footer className="source-footer"><ShieldCheck size={14} /><span>PRAHA does not host media. Availability and playback are provided by your installed sources.</span></footer>
    </>
  );
};

export default SourcePanel;
