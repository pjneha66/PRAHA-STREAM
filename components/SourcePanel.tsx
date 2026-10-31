import React, { useMemo, useState } from 'react';
import {
  Blocks, Check, CircleAlert, Copy, Film, HardDrive, Languages, Play, RefreshCw,
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

export interface ParsedBadges {
  resolution?: string;
  hdr?: string;
  audio?: string;
  codec?: string;
  source?: string;
  debrid?: string;
  size?: string;
}

export const parseStreamBadges = (stream: StreamResult): ParsedBadges => {
  const text = `${stream.title || ''} ${stream.provider || ''} ${stream.quality || ''} ${stream.url || ''}`.toUpperCase();
  const badges: ParsedBadges = {};

  if (/2160P|4K|UHD/.test(text)) badges.resolution = '4K UHD';
  else if (/1080P|FHD/.test(text)) badges.resolution = '1080p';
  else if (/720P|HD/.test(text)) badges.resolution = '720p';
  else if (/480P|SD/.test(text)) badges.resolution = '480p';

  if (/DOLBY VISION|\bDV\b|DOVI/.test(text)) badges.hdr = 'DV';
  else if (/HDR10\+/.test(text)) badges.hdr = 'HDR10+';
  else if (/HDR/.test(text)) badges.hdr = 'HDR';

  if (/ATMOS/.test(text)) badges.audio = 'Atmos';
  else if (/TRUEHD/.test(text)) badges.audio = 'TrueHD';
  else if (/DTS-HD/.test(text)) badges.audio = 'DTS-HD';
  else if (/DTS/.test(text)) badges.audio = 'DTS';
  else if (/5\.1|\bDD\+?|E-AC-3/.test(text)) badges.audio = '5.1';
  else if (/7\.1/.test(text)) badges.audio = '7.1';

  if (/HEVC|H\.?265|X265/.test(text)) badges.codec = 'HEVC';
  else if (/AV1/.test(text)) badges.codec = 'AV1';
  else if (/AVC|H\.?264|X264/.test(text)) badges.codec = 'H.264';

  if (/REMUX/.test(text)) badges.source = 'REMUX';
  else if (/WEB-?DL|WEBRIP/.test(text)) badges.source = 'WEB-DL';
  else if (/BLURAY|BLU-RAY|BDRIP/.test(text)) badges.source = 'BluRay';

  if (/\[\+?RD\]|REAL-?DEBRID/.test(text)) badges.debrid = 'RD';
  else if (/\[\+?TB\]|TORBOX/.test(text)) badges.debrid = 'TB';
  else if (/\[\+?AD\]|ALLDEBRID/.test(text)) badges.debrid = 'AD';
  else if (/\[\+?PM\]|PREMIUMIZE/.test(text)) badges.debrid = 'PM';
  else if (/CACHED|⚡/.test(text)) badges.debrid = 'Cached';

  if (stream.size) badges.size = stream.size;
  return badges;
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
          <p>{media.year || ''} · {media.type === 'movie' ? 'Movie' : 'Series'} <i /> Stremio & Nuvio</p>
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
        {loading ? Array.from({ length: Math.max(3, Math.min(providerCount, 5)) }).map((_, index) => <div className="stream-skeleton" key={index}><span /><div><i /><i /></div></div>) : filtered.map((stream) => {
          const badges = parseStreamBadges(stream);
          return (
            <article className="stream-row" key={stream.id}>
              <button className="stream-play" onClick={() => onPlay(stream)} aria-label={`Play ${stream.title}`}><Play size={18} fill="currentColor" /></button>
              <div className="stream-main">
                <div className="stream-title">
                  <strong>{stream.title}</strong>
                  {badges.resolution && <span className="badge-pill badge-res">{badges.resolution}</span>}
                  {badges.hdr && <span className="badge-pill badge-hdr">{badges.hdr}</span>}
                  {badges.audio && <span className="badge-pill badge-audio">{badges.audio}</span>}
                  {badges.codec && <span className="badge-pill badge-codec">{badges.codec}</span>}
                  {badges.source && <span className="badge-pill badge-source">{badges.source}</span>}
                  {badges.debrid && <span className="badge-pill badge-debrid">⚡ {badges.debrid}</span>}
                </div>
                <div className="stream-meta">
                  <span className={`stream-origin ${stream.sourceType}`}>
                    {stream.sourceType === 'nuvio' ? <Zap size={11} /> : <Blocks size={11} />}
                    {stream.sourceName}
                  </span>
                  {stream.provider && stream.provider !== stream.sourceName && <span>{stream.provider}</span>}
                  {badges.size && <span><HardDrive size={11} />{badges.size}</span>}
                  {stream.language && <span><Languages size={12} />{stream.language}</span>}
                  {typeof stream.seeders === 'number' && <span className="seeders"><Users size={12} />{stream.seeders} seeders</span>}
                </div>
              </div>
              <div className="stream-actions">
                <button className="icon-button" onClick={() => copyStream(stream)} aria-label="Copy stream URL">{copied === stream.id ? <Check size={16} /> : <Copy size={16} />}</button>
                <button className="button button-small button-primary" onClick={() => onPlay(stream)}>{stream.url.startsWith('magnet:') ? 'Open' : 'Play'}<Play size={14} fill="currentColor" /></button>
              </div>
            </article>
          );
        })}
        {!loading && !filtered.length && (
          <div className="empty-state source-empty">
            <span><Film size={28} /></span>
            <h2>{providerCount ? 'No streams found for this title' : 'Add a stream provider to press play'}</h2>
            <p>{providerCount ? 'Try another episode, refresh your sources, or install an addon that supports this title’s ID.' : 'Install a Stremio stream addon or a Nuvio provider to start watching.'}</p>
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
