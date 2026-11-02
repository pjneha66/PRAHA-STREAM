import React, { useMemo, useState } from 'react';
import {
  Blocks, Check, CircleAlert, Copy, Film, HardDrive, Languages, Play, RefreshCw,
  ShieldCheck, Users, X, Zap, Star,
} from 'lucide-react';
import type { MediaItem, SourceError, StreamResult, TmdbEpisodeInfo, TmdbSeasonSummary, ProviderHealth } from '../types';
import { Artwork } from './MediaCard';
import { filterAndSortStreams, sourceKey, streamQuality } from '../services/sourcePreferences';

export const qualityOf = streamQuality;

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
  health?: ProviderHealth[];
  preferredSource?: string;
  onPreferredSourceChange?: (key: string) => void;
  season?: number;
  episode?: number;
  seasons?: TmdbSeasonSummary[];
  episodes?: TmdbEpisodeInfo[];
  onSeasonChange?: (value: number) => void;
  onEpisodeChange?: (value: number) => void;
  onRefresh?: () => void;
  providerCount: number;
  preferredLanguage: string;
  onPlay: (stream: StreamResult, alternatives?: StreamResult[]) => void;
  onOpenExtensions?: () => void;
  showClose?: boolean;
  onClose?: () => void;
}

const SourcePanel: React.FC<SourcePanelProps> = ({
  media, streams, loading, errors, season, episode, seasons, episodes,
  onSeasonChange, onEpisodeChange, onRefresh, providerCount, preferredLanguage,
  onPlay, onOpenExtensions, showClose, onClose, health = [], preferredSource = '', onPreferredSourceChange,
}) => {
  const [quality, setQuality] = useState('all');
  const [provider, setProvider] = useState('all');
  const [language, setLanguage] = useState('all');
  const [codec, setCodec] = useState('all');
  const [subtitles, setSubtitles] = useState('all');
  const [copied, setCopied] = useState('');
  const filters = { quality, provider, language, codec, subtitles };
  const filtered = useMemo(() => filterAndSortStreams(streams, filters, preferredSource, preferredLanguage),
    [streams, quality, provider, language, codec, subtitles, preferredSource, preferredLanguage]);
  const allRanked = useMemo(() => filterAndSortStreams(streams, { quality: 'all', provider: 'all', language: 'all', codec: 'all', subtitles: 'all' }, preferredSource, preferredLanguage), [streams, preferredSource, preferredLanguage]);
  const providers = useMemo(() => Array.from(new Map(streams.map((stream) => [sourceKey(stream), stream.sourceName])).entries()), [streams]);
  const languages = useMemo(() => Array.from(new Set(streams.map((stream) => stream.language?.toLowerCase()).filter((value): value is string => Boolean(value)))).sort(), [streams]);
  const hasFilters = [quality, provider, language, codec, subtitles].some((value) => value !== 'all');
  const play = (stream: StreamResult) => onPlay(stream, allRanked.filter((candidate) => candidate !== stream));

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
        <div className="source-search-status"><span className={`status-dot ${loading ? 'pulse' : ''}`} />{loading ? `Searching ${providerCount} provider${providerCount === 1 ? '' : 's'}… ${filtered.length} found` : `${filtered.length} stream${filtered.length === 1 ? '' : 's'} found`}</div>
        <div className="quality-filters">{['all', '4K', '1080p', '720p', '480p'].map((value) => <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)}>{value === 'all' ? 'All quality' : value}</button>)}</div>
        <button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh streams"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>
      {onPreferredSourceChange && <p className="source-preference-hint">Star a provider to rank it first for this profile. Subtitle filters use only metadata reported by the stream.</p>}
      <div className="source-filter-bar" aria-label="Filter streams">
        <label>Provider <select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All providers</option>{providers.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Language <select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">All languages</option>{languages.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
        <label>Codec <select value={codec} onChange={(event) => setCodec(event.target.value)}><option value="all">All codecs</option><option>HEVC</option><option>H.264</option><option>AV1</option><option>Unknown</option></select></label>
        <label>Subtitles <select value={subtitles} onChange={(event) => setSubtitles(event.target.value)}><option value="all">Any</option><option value="available">Reported</option><option value="unknown">Not reported</option></select></label>
        {hasFilters && <button className="button button-secondary button-small" onClick={() => { setQuality('all'); setProvider('all'); setLanguage('all'); setCodec('all'); setSubtitles('all'); }}>Clear filters</button>}
      </div>
      {health.length > 0 && <details className="source-health"><summary>Provider health · {health.filter((item) => item.status !== 'searching').length}/{health.length} checked</summary>
        <ul>{health.map((item) => <li key={item.id}><strong>{item.name}</strong><span className={`health-${item.status}`}>{item.status === 'searching' ? 'Searching…' : item.status === 'ready' ? `${item.count} found` : item.status === 'empty' ? 'No streams' : item.status === 'unsupported' ? 'Not supported' : 'Failed'}{item.message ? ` · ${item.message}` : ''}</span></li>)}</ul>
      </details>}
      <div className="stream-list">
        {filtered.map((stream) => {
          const badges = parseStreamBadges(stream);
          return (
            <article className="stream-row" key={stream.id}>
              <button className="stream-play" onClick={() => play(stream)} aria-label={`Play ${stream.title}`}><Play size={18} fill="currentColor" /></button>
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
                {onPreferredSourceChange && <button className="icon-button" onClick={() => onPreferredSourceChange(sourceKey(stream) === preferredSource ? '' : sourceKey(stream))} aria-label={sourceKey(stream) === preferredSource ? `Remove ${stream.sourceName} preference` : `Prefer ${stream.sourceName}`} aria-pressed={sourceKey(stream) === preferredSource} title={sourceKey(stream) === preferredSource ? 'Preferred provider' : 'Prefer this provider'}><Star size={16} fill={sourceKey(stream) === preferredSource ? 'currentColor' : 'none'} /></button>}
                <button className="icon-button" onClick={() => copyStream(stream)} aria-label="Copy stream URL">{copied === stream.id ? <Check size={16} /> : <Copy size={16} />}</button>
                <button className="button button-small button-primary" onClick={() => play(stream)}>{stream.url.startsWith('magnet:') ? 'Open' : 'Play'}<Play size={14} fill="currentColor" /></button>
              </div>
            </article>
          );
        })}
        {loading && !filtered.length && Array.from({ length: Math.max(3, Math.min(providerCount, 5)) }).map((_, index) => <div className="stream-skeleton" key={index}><span /><div><i /><i /></div></div>)}
        {!loading && !filtered.length && (
          <div className="empty-state source-empty">
            <span><Film size={28} /></span>
            <h2>{hasFilters && streams.length ? 'No streams match these filters' : providerCount ? 'No streams found for this title' : 'Add a stream provider to press play'}</h2>
            <p>{hasFilters && streams.length ? 'Clear or change your filters to see more streams.' : providerCount ? 'Try another episode, refresh your sources, or install an addon that supports this title’s ID.' : 'Install a Stremio stream addon or a Nuvio provider to start watching.'}</p>
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
