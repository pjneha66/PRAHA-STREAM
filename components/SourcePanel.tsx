import React, { useEffect, useMemo, useState } from 'react';
import { matchBadgeRule } from '../services/badgeRules';
import { bridgeRpcAvailable } from '../services/androidBridge';
import { canDownloadVideo, matchEpisodeDownload, planVideoDownload, queueVideoDownloads, type VideoDownloadPlan } from '../services/videoDownloads';
import { copyText } from '../services/clipboard';
import {
  ArrowDownToLine, Blocks, Check, ChevronDown, CircleAlert, Copy, Film, HardDrive,
  Languages, Play, RefreshCw, ShieldCheck, SlidersHorizontal, Star, Users, X, Zap,
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
  settledEpisode?: string;
  errors: SourceError[];
  health?: ProviderHealth[];
  preferredSource?: string;
  lastSource?: string;
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
  /**
   * Where these streams come from, shown under the title. The panel is shared by
   * the Home/Search finder (many stacks at once) and by a title opened from a
   * CloudStream extension (exactly one), so the header cannot hardcode it.
   */
  sourceSummary?: string;
}

const SourcePanel: React.FC<SourcePanelProps> = ({
  media, streams, loading, settledEpisode, errors, season, episode, seasons, episodes,
  onSeasonChange, onEpisodeChange, onRefresh, providerCount, preferredLanguage,
  onPlay, onOpenExtensions, showClose, onClose, health = [], preferredSource = '', onPreferredSourceChange,
  sourceSummary, lastSource,
}) => {
  const [quality, setQuality] = useState('all');
  const [downloadHint, setDownloadHint] = useState('');
  const [batch, setBatch] = useState<Record<string, VideoDownloadPlan>>({});
  const [queueing, setQueueing] = useState(false);
  const [exportBatch, setExportBatch] = useState(false);
  const [range, setRange] = useState<{ season: number; pending: number[]; anchor: StreamResult; skipped: number } | null>(null);
  const episodeKey = `${media.id}|${season ?? 1}|${episode ?? 1}`;
  const selectedEpisodes = Object.values<VideoDownloadPlan>(batch);
  const queuedCount = selectedEpisodes.length;
  const matchingStream = selectedEpisodes[0] && !batch[episodeKey]
    ? matchEpisodeDownload(streams, selectedEpisodes[0].stream)
    : undefined;

  async function enqueue(plans: VideoDownloadPlan[], clearBatch = false) {
    setQueueing(true);
    try {
      const requested = plans.map((plan) => ({ ...plan, export: exportBatch }));
      const remaining = await queueVideoDownloads(requested);
      const count = plans.length - remaining.length;
      if (clearBatch) {
        const failed = new Set(plans.filter((_, index) => remaining.includes(requested[index])));
        setBatch((current: Record<string, VideoDownloadPlan>) => Object.fromEntries(Object.entries(current).filter(([, plan]) => failed.has(plan))));
      }
      setDownloadHint(`${count} of ${plans.length} added to Video Downloads.`);
    } catch {
      setDownloadHint('Could not add all videos to the download queue.');
    } finally {
      setQueueing(false);
    }
  }
  const [provider, setProvider] = useState('all');
  const [language, setLanguage] = useState('all');
  const [codec, setCodec] = useState('all');
  const [subtitles, setSubtitles] = useState('all');
  const [copied, setCopied] = useState('');
  const filters = { quality, provider, language, codec, subtitles };
  const filtered = useMemo(() => filterAndSortStreams(streams, filters, preferredSource, preferredLanguage, lastSource),
    [streams, quality, provider, language, codec, subtitles, preferredSource, preferredLanguage, lastSource]);
  const allRanked = useMemo(() => filterAndSortStreams(streams, { quality: 'all', provider: 'all', language: 'all', codec: 'all', subtitles: 'all' }, preferredSource, preferredLanguage, lastSource), [streams, preferredSource, preferredLanguage, lastSource]);
  const providers = useMemo(() => Array.from(new Map(streams.map((stream) => [sourceKey(stream), stream.sourceName])).entries()), [streams]);
  const languages = useMemo(() => Array.from(new Set(streams.map((stream) => stream.language?.toLowerCase()).filter((value): value is string => Boolean(value)))).sort(), [streams]);
  const advancedCount = [provider, language, codec, subtitles].filter((value) => value !== 'all').length;
  const hasFilters = advancedCount > 0 || quality !== 'all';
  const play = (stream: StreamResult) => onPlay(stream, allRanked.filter((candidate) => candidate !== stream));

  const copyStream = async (stream: StreamResult) => {
    if (await copyText(stream.url)) {
      setCopied(stream.id);
      window.setTimeout(() => setCopied(''), 1500);
    } else {
      // The WebView denied the write (no secure context, or the permission is
      // off). Say so rather than leaving a button that appears to do nothing.
      setDownloadHint('Copying is blocked here — use Download, or open the stream in your browser.');
      window.setTimeout(() => setDownloadHint(''), 3500);
    }
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

  const knownEpisodes = episodes?.length
    ? episodes.map((item) => item.episode)
    : Array.from({ length: seasons?.find((item) => item.seasonNumber === (season ?? 1))?.episodeCount ?? 0 }, (_, index) => index + 1);

  function findRemainingEpisodes() {
    const currentSeason = season ?? 1;
    const pending = knownEpisodes.filter((number) => number > (episode ?? 1) && !batch[`${media.id}|${currentSeason}|${number}`]);
    if (!pending.length || !selectedEpisodes[0] || !onEpisodeChange) return;
    setRange({ season: currentSeason, pending, anchor: selectedEpisodes[0].stream, skipped: 0 });
    onEpisodeChange(pending[0]);
  }

  useEffect(() => {
    if (!range) return;
    if ((season ?? 1) !== range.season || episode !== range.pending[0]) {
      setRange(null);
      return;
    }
    if (settledEpisode !== episodeKey) return;
    const match = matchEpisodeDownload(streams, range.anchor);
    if (match) {
      setBatch((current) => ({ ...current, [episodeKey]: planVideoDownload(media, match, range.season, episode) }));
    }
    const remaining = range.pending.slice(1);
    const skipped = range.skipped + (match ? 0 : 1);
    if (remaining.length) {
      setRange({ ...range, pending: remaining, skipped });
      onEpisodeChange?.(remaining[0]);
    } else {
      setRange(null);
      setDownloadHint(skipped ? `${skipped} episodes had no matching source. Review the batch before queuing.` : 'Episode sources are ready. Review the batch before queuing.');
    }
  }, [episode, episodeKey, media, onEpisodeChange, range, season, settledEpisode, streams]);

  const checkedProviders = health.filter((item) => item.status !== 'searching').length;
  // How many providers are actually still running. This used to print the total
  // provider count, so after the first provider answered the line kept claiming
  // every provider was searching and never appeared to make progress.
  const searchingProviders = health.length
    ? health.filter((item) => item.status === 'searching').length
    : providerCount;
  const summary = sourceSummary || (providerCount === 1 ? '1 provider' : `${providerCount} providers`);

  return (
    <>
      <header className="source-header">
        <div className="source-title-art"><Artwork src={media.poster} alt="" /></div>
        <div className="source-header-copy">
          <span className="page-kicker">SOURCE FINDER</span>
          <h2>{media.title}</h2>
          <div className="source-header-meta">
            {media.year && <span>{media.year}</span>}
            <span>{media.type === 'movie' ? 'Movie' : 'Series'}</span>
            <span className="source-header-providers"><Blocks size={11} />{summary}</span>
          </div>
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
        <div className="source-search-status">
          <span className={`status-dot ${loading ? 'pulse' : ''}`} />
          <strong>{filtered.length}</strong>
          <span>{filtered.length === 1 ? 'stream' : 'streams'}{loading ? ` · searching ${searchingProviders}…` : ' found'}</span>
        </div>
        <div className="quality-filters" role="group" aria-label="Filter by quality">
          {['all', '4K', '1080p', '720p', '480p'].map((value) => (
            <button key={value} className={quality === value ? 'active' : ''} onClick={() => setQuality(value)}>
              {value === 'all' ? 'All' : value}
            </button>
          ))}
        </div>
        <details className="source-filters">
          <summary className={advancedCount ? 'active' : ''}>
            <SlidersHorizontal size={14} />
            Filters{advancedCount ? ` (${advancedCount})` : ''}
            <ChevronDown size={13} className="source-filters-chevron" />
          </summary>
          <div className="source-filter-bar" aria-label="Filter streams">
            <label>Provider <select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All providers</option>{providers.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
            <label>Language <select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="all">All languages</option>{languages.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
            <label>Codec <select value={codec} onChange={(event) => setCodec(event.target.value)}><option value="all">All codecs</option><option>HEVC</option><option>H.264</option><option>AV1</option><option>Unknown</option></select></label>
            <label>Subtitles <select value={subtitles} onChange={(event) => setSubtitles(event.target.value)}><option value="all">Any</option><option value="available">Reported</option><option value="unknown">Not reported</option></select></label>
            {hasFilters && <button className="button button-secondary button-small" onClick={() => { setQuality('all'); setProvider('all'); setLanguage('all'); setCodec('all'); setSubtitles('all'); }}>Clear filters</button>}
          </div>
          {onPreferredSourceChange && <p className="source-preference-hint">Star a provider to give it priority across titles. Subtitle filters use only metadata reported by the stream.</p>}
        </details>
        <button className="icon-button source-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh streams" title="Refresh streams"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
      </div>

      {health.length > 0 && <details className="source-health"><summary>Provider health · {checkedProviders}/{health.length} checked</summary>
        <ul>{health.map((item) => <li key={item.id}><strong>{item.name}</strong><span className={`health-${item.status}`}>{item.status === 'searching' ? 'Searching…' : item.status === 'ready' ? `${item.count} found` : item.status === 'empty' ? 'No streams' : item.status === 'unsupported' ? 'Not supported' : 'Failed'}{item.message ? ` · ${item.message}` : ''}</span></li>)}</ul>
      </details>}
      {queuedCount > 0 && <div className="source-toolbar">
        <button className="button button-primary" disabled={queueing || Boolean(range)} onClick={() => void enqueue(selectedEpisodes, true)}>
          Queue {queuedCount} {queuedCount === 1 ? 'episode' : 'episodes'}
        </button>
        {matchingStream && <button className="button button-secondary" disabled={queueing}
          onClick={() => setBatch((current) => ({ ...current, [episodeKey]: planVideoDownload(media, matchingStream, season, episode) }))}>
          Add matching source
        </button>}
        {settledEpisode !== undefined && knownEpisodes.some((number) => number > (episode ?? 1)) && !range &&
          <button className="button button-secondary" disabled={queueing} onClick={findRemainingEpisodes}>Find rest of season</button>}
        {range && <button className="button button-secondary" onClick={() => setRange(null)}>Stop finding sources</button>}
        <button className="button button-secondary" disabled={queueing || Boolean(range)} onClick={() => setBatch({})}>Clear selection</button>
        <label><input type="checkbox" checked={exportBatch} onChange={(event) => setExportBatch(event.target.checked)} /> Save to Downloads</label>
        {range ? <span role="status">Finding sources for episode {range.pending[0]}.</span> : <span>Select another episode to add it to this batch.</span>}
      </div>}
      {downloadHint && <p className="download-hint" role="status">{downloadHint}</p>}
      <div className="stream-list">
        {filtered.map((stream) => {
          const badges = parseStreamBadges(stream);
          return (
            <article className="stream-row" key={stream.id}>
              <button className="stream-play" onClick={() => play(stream)} aria-label={`Play ${stream.title}`} title="Play stream">
                <Play size={18} fill="currentColor" />
              </button>
              <div className="stream-main">
                <div className="stream-title">
                  <strong>
                    {stream.title}
                    {(() => {
                      const badge = matchBadgeRule(`${stream.title || ''} ${stream.provider || ''}`);
                      return badge ? <span className="stream-badge-rule" style={{ color: badge.color, borderColor: badge.color }}>{badge.label}</span> : null;
                    })()}
                  </strong>
                  <span className="stream-badges">
                    {badges.resolution && <span className="badge-pill badge-res">{badges.resolution}</span>}
                    {badges.hdr && <span className="badge-pill badge-hdr">{badges.hdr}</span>}
                    {badges.audio && <span className="badge-pill badge-audio">{badges.audio}</span>}
                    {badges.codec && <span className="badge-pill badge-codec">{badges.codec}</span>}
                    {badges.source && <span className="badge-pill badge-source">{badges.source}</span>}
                    {badges.debrid && <span className="badge-pill badge-debrid">⚡ {badges.debrid}</span>}
                  </span>
                </div>
                <div className="stream-meta">
                  <span className={`stream-origin ${stream.sourceType}`}>
                    {stream.sourceType === 'nuvio' ? <Zap size={11} /> : stream.sourceType === 'cloudstream' ? <Blocks size={11} /> : <Blocks size={11} />}
                    {stream.sourceName}
                  </span>
                  {stream.provider && stream.provider !== stream.sourceName && <span>{stream.provider}</span>}
                  {badges.size && <span><HardDrive size={11} />{badges.size}</span>}
                  {stream.language && <span><Languages size={12} />{stream.language}</span>}
                  {typeof stream.seeders === 'number' && <span className="seeders"><Users size={12} />{stream.seeders}</span>}
                </div>
              </div>
              <div className="stream-actions">
                {onPreferredSourceChange && <button className="icon-button" onClick={() => onPreferredSourceChange(sourceKey(stream) === preferredSource ? '' : sourceKey(stream))} aria-label={sourceKey(stream) === preferredSource ? `Remove ${stream.sourceName} preference` : `Prefer ${stream.sourceName}`} aria-pressed={sourceKey(stream) === preferredSource} title={sourceKey(stream) === preferredSource ? 'Preferred provider' : 'Prefer this provider'}><Star size={16} fill={sourceKey(stream) === preferredSource ? 'currentColor' : 'none'} /></button>}
                {bridgeRpcAvailable() && canDownloadVideo(stream) && <>
                  <button className="icon-button" title="Download to device" aria-label={`Download ${stream.title}`} disabled={queueing}
                    onClick={() => void enqueue([planVideoDownload(media, stream, season, episode)])}>
                    <ArrowDownToLine size={16} />
                  </button>
                  {media.type === 'series' && <button className="button button-secondary button-small" disabled={queueing}
                    aria-pressed={batch[episodeKey]?.stream.id === stream.id}
                    onClick={() => setBatch((current) => {
                      const next = { ...current };
                      if (next[episodeKey]?.stream.id === stream.id) delete next[episodeKey];
                      else next[episodeKey] = planVideoDownload(media, stream, season, episode);
                      return next;
                    })}>{batch[episodeKey]?.stream.id === stream.id ? 'Selected' : 'Add to batch'}</button>}
                </>}
                <button className="icon-button" onClick={() => copyStream(stream)} aria-label="Copy stream URL">{copied === stream.id ? <Check size={16} /> : <Copy size={16} />}</button>
                <button className="button button-small button-primary stream-play-cta" onClick={() => play(stream)}>{stream.url.startsWith('magnet:') ? 'Open' : 'Play'}<Play size={14} fill="currentColor" /></button>
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
      <footer className="source-footer"><ShieldCheck size={14} /><span>PRAHA hosts no media — playback comes from your sources.</span></footer>
    </>
  );
};

export default React.memo(SourcePanel);
