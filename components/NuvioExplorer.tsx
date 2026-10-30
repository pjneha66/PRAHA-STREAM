import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, ChevronLeft, CircleAlert, LoaderCircle, Play, Search, Zap,
} from 'lucide-react';
import { findNuvioStreams, testNuvioScraper } from '../services/nuvioService';
import { tmdbService } from '../services/tmdbService';
import type {
  MediaItem, NuvioRepository, NuvioScraper, SourceError, StreamResult,
} from '../types';
import { MediaCard } from './MediaCard';
import SourcePanel from './SourcePanel';

const normalizeType = (type: string) =>
  ['series', 'show', 'other', 'tv', 'anime', 'live'].includes(type.toLowerCase()) ? 'series' : 'movie';
const typeLabel = (type: string) => (type === 'movie' ? 'Movies' : 'Series');

interface NuvioExplorerProps {
  repositories: NuvioRepository[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

const NuvioExplorer: React.FC<NuvioExplorerProps> = ({
  repositories, watchlist, compact, preferredLanguage, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const providers = useMemo(() => repositories
    .filter((repo) => repo.enabled)
    .flatMap((repo) => repo.scrapers.filter((scraper) => scraper.enabled).map((scraper) => ({ scraper, repository: repo }))), [repositories]);

  const [providerId, setProviderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState('');

  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(false);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);

  const active = useMemo(() => providers.find((provider) => provider.scraper.id === providerId) || null, [providers, providerId]);

  useEffect(() => {
    if (!providerId && providers.length) setProviderId(providers[0].scraper.id);
    else if (providerId && !providers.some((provider) => provider.scraper.id === providerId)) setProviderId(providers[0]?.scraper.id || null);
  }, [providers, providerId]);

  useEffect(() => {
    setSelected(null);
    setQuery('');
    setResults([]);
    setSearchError('');
  }, [providerId]);

  useEffect(() => {
    const term = query.trim();
    if (!term) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const items = await tmdbService.search(term);
        if (!cancelled) setResults(items);
      } catch (error) {
        if (!cancelled) {
          setResults([]);
          setSearchError(error instanceof Error ? error.message : 'Search failed.');
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  const loadStreams = useCallback(async (item: MediaItem, nextSeason: number, nextEpisode: number) => {
    if (!active) return;
    setLoading(true);
    setErrors([]);
    setStreams([]);
    try {
      const scoped: NuvioRepository = { ...active.repository, scrapers: [active.scraper] };
      const result = await findNuvioStreams(
        [scoped],
        item.tmdbId ? String(item.tmdbId) : '',
        item.type,
        item.type === 'series' ? nextSeason : undefined,
        item.type === 'series' ? nextEpisode : undefined,
      );
      setStreams(result.streams);
      setErrors(result.errors);
    } catch (error) {
      setErrors([{ sourceName: 'Nuvio search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
    } finally {
      setLoading(false);
    }
  }, [active]);

  const openMedia = (item: MediaItem) => {
    setSeason(1);
    setEpisode(1);
    setSelected(item);
    loadStreams(item, 1, 1);
  };

  const testScraper = async (scraper: NuvioScraper) => {
    setBusy(scraper.id);
    try {
      const result = await testNuvioScraper(scraper, active?.repository.name || scraper.id);
      // Test results are surfaced through the provider’s own toast in Extensions;
      // here we simply confirm it ran.
      if (!result.length) setSearchError(`${scraper.name} ran but returned no test streams.`);
    } catch (error) {
      setSearchError(`${scraper.name}: ${error instanceof Error ? error.message : 'Test failed.'}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="explorer">
      <aside className="explorer-sources">
        <p className="explore-list-label">Nuvio providers</p>
        {providers.map(({ scraper, repository }) => (
          <button key={scraper.id} className={`explore-source-card ${providerId === scraper.id ? 'active' : ''} ${!scraper.enabled ? 'disabled' : ''}`}
            onClick={() => setProviderId(scraper.id)}>
            <span className="explore-source-icon"><Zap size={20} /></span>
            <span className="explorer-source-copy">
              <strong>{scraper.name}</strong>
              <small>{repository.name} · {scraper.supportedTypes.map(normalizeType).map(typeLabel).join('/')}</small>
            </span>
            {providerId === scraper.id && <Check size={16} />}
          </button>
        ))}
      </aside>

      <section className="explorer-content">
        {selected ? (
          <div className="explorer-detail page-enter">
            <button className="text-button" onClick={() => setSelected(null)}><ChevronLeft size={15} /> Back to {active?.scraper.name || 'providers'}</button>
            <div className="source-panel-card">
              <SourcePanel
                media={selected}
                streams={streams}
                loading={loading}
                errors={errors}
                season={season}
                episode={episode}
                onSeasonChange={(value) => { setSeason(value); loadStreams(selected, value, episode); }}
                onEpisodeChange={(value) => { setEpisode(value); loadStreams(selected, season, value); }}
                onRefresh={() => loadStreams(selected, season, episode)}
                providerCount={1}
                preferredLanguage={preferredLanguage}
                onPlay={(stream) => onPlay(selected, stream)}
                onOpenExtensions={onOpenExtensions}
              />
            </div>
          </div>
        ) : active ? (
          <div className="explorer-detail page-enter">
            <header className="explorer-source-header">
              <span className="explore-source-icon large"><Zap size={26} /></span>
              <div>
                <span className="page-kicker">NUVIO PROVIDER</span>
                <h2>{active.scraper.name}</h2>
                <p>{active.scraper.description || `${active.repository.name} · ${active.scraper.supportedTypes.map(normalizeType).map(typeLabel).join(' & ')}`}</p>
              </div>
              <span className={`source-state ${active.scraper.enabled ? 'online' : 'paused'}`}>{active.scraper.enabled ? 'Ready' : 'Paused'}</span>
            </header>

            <div className="provider-tags explorer-provider-tags">
              {active.scraper.supportedTypes.map(normalizeType).map((type) => <span key={type}>{typeLabel(type)}</span>)}
              {active.scraper.contentLanguage?.length ? <span>{active.scraper.contentLanguage.join(', ').toUpperCase()}</span> : null}
              {active.scraper.formats?.length ? <span>{active.scraper.formats.join(' · ')}</span> : null}
              <button className="test-button" onClick={() => testScraper(active.scraper)} disabled={busy === active.scraper.id}>
                {busy === active.scraper.id ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />} Test
              </button>
            </div>

            <div className="explorer-toolbar">
              <div className="explore-search">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search with ${active.scraper.name}…`} aria-label={`Search with ${active.scraper.name}`} />
                {query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
              </div>
            </div>
            {searchError && <p className="explore-note"><CircleAlert size={14} />{searchError}</p>}

            {searching ? (
              <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
            ) : results.length ? (
              <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                {results.map((item) => (
                  <MediaCard key={`${item.source}-${item.tmdbId || ''}-${item.id}`} item={item} onSelect={openMedia}
                    onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
                ))}
              </div>
            ) : (
              <div className="empty-state explore-empty">
                <span><Search size={26} /></span>
                <h2>{query ? 'No results' : 'Search to find something to watch'}</h2>
                <p>{query ? 'Try a different title, or check your TMDB API key in Settings.' : 'Nuvio providers resolve streams from TMDB IDs, so search here to find titles.'}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state explore-empty"><span><Zap size={26} /></span><h2>No provider selected</h2><p>Choose a Nuvio provider to search and play.</p></div>
        )}
      </section>
    </div>
  );
};

export default NuvioExplorer;
