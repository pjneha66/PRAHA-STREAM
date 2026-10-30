import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Blocks, Check, ChevronLeft, CircleAlert, Compass, Search,
} from 'lucide-react';
import { fetchStremioCatalog, findStremioStreams } from '../services/stremioService';
import type {
  InstalledAddon, MediaItem, SourceError, StreamResult, StremioCatalog,
} from '../types';
import { MediaCard } from './MediaCard';
import SourcePanel from './SourcePanel';

const normalizeType = (type: string) =>
  ['series', 'show', 'other', 'tv', 'anime', 'live'].includes(type.toLowerCase()) ? 'series' : 'movie';
const typeLabel = (type: string) => (type === 'movie' ? 'Movies' : 'Series');

interface StremioExplorerProps {
  addons: InstalledAddon[];
  watchlist: MediaItem[];
  compact: boolean;
  preferredLanguage: string;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

const StremioExplorer: React.FC<StremioExplorerProps> = ({
  addons, watchlist, compact, preferredLanguage, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const [stremioUrl, setStremioUrl] = useState<string | null>(null);
  const [baseCatalog, setBaseCatalog] = useState<StremioCatalog | null>(null);
  const [catalogItems, setCatalogItems] = useState<MediaItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchType, setSearchType] = useState<'all' | 'movie' | 'series'>('all');

  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [errors, setErrors] = useState<SourceError[]>([]);
  const [loading, setLoading] = useState(false);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);

  const activeAddon = useMemo(
    () => addons.find((addon) => addon.manifestUrl === stremioUrl) || null,
    [addons, stremioUrl],
  );

  useEffect(() => {
    if (!stremioUrl && addons.length) setStremioUrl(addons[0].manifestUrl);
    else if (stremioUrl && !addons.some((addon) => addon.manifestUrl === stremioUrl)) setStremioUrl(addons[0]?.manifestUrl || null);
  }, [addons, stremioUrl]);

  const loadCatalog = useCallback(async (target: StremioCatalog, addon: InstalledAddon, search = '') => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const items = await fetchStremioCatalog(addon, target, search ? { search } : {});
      setCatalogItems(items);
      if (!items.length) setCatalogError('No titles were returned for this catalog.');
    } catch (error) {
      setCatalogItems([]);
      setCatalogError(error instanceof Error ? error.message : 'The catalog could not be loaded.');
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const catalogsByType = useMemo(() => {
    if (!activeAddon) return [];
    const groups = new Map<string, StremioCatalog[]>();
    activeAddon.manifest.catalogs.forEach((catalog) => {
      const key = normalizeType(catalog.type);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(catalog);
    });
    return [...groups.entries()].map(([type, catalogs]) => ({ type, catalogs }));
  }, [activeAddon]);

  const searchCatalog = useMemo(() => {
    if (!activeAddon) return null;
    return activeAddon.manifest.catalogs.find((catalog) =>
      (searchType === 'all' || normalizeType(catalog.type) === searchType) &&
      catalog.extra?.some((extra) => extra.name === 'search'),
    ) || null;
  }, [activeAddon, searchType]);

  useEffect(() => {
    setBaseCatalog(null);
    setCatalogItems([]);
    setCatalogError('');
    setSearchTerm('');
    setSelected(null);
  }, [stremioUrl]);

  useEffect(() => {
    if (!activeAddon || baseCatalog) return;
    const first = catalogsByType[0]?.catalogs[0];
    if (first) setBaseCatalog(first);
  }, [activeAddon, catalogsByType, baseCatalog]);

  useEffect(() => {
    if (!activeAddon || !baseCatalog) return;
    const term = searchTerm.trim();
    if (term) {
      if (!searchCatalog) return;
      const timer = window.setTimeout(() => loadCatalog(searchCatalog, activeAddon, term), 400);
      return () => window.clearTimeout(timer);
    }
    loadCatalog(baseCatalog, activeAddon, '');
  }, [searchTerm, searchCatalog, activeAddon, baseCatalog, loadCatalog]);

  const loadStreams = useCallback(async (item: MediaItem, nextSeason: number, nextEpisode: number) => {
    setLoading(true);
    setErrors([]);
    setStreams([]);
    try {
      const result = await findStremioStreams(
        addons.filter((addon) => addon.enabled),
        item,
        item.type === 'series' ? nextSeason : undefined,
        item.type === 'series' ? nextEpisode : undefined,
      );
      setStreams(result.streams);
      setErrors(result.errors);
    } catch (error) {
      setErrors([{ sourceName: 'Stremio search', message: error instanceof Error ? error.message : 'Unable to search sources.' }]);
    } finally {
      setLoading(false);
    }
  }, [addons]);

  const openMedia = (item: MediaItem) => {
    setSeason(1);
    setEpisode(1);
    setSelected(item);
    loadStreams(item, 1, 1);
  };

  return (
    <div className="explorer">
      <aside className="explorer-sources">
        <p className="explore-list-label">Stremio addons</p>
        {addons.map((addon) => (
          <button key={addon.manifestUrl} className={`explore-source-card ${stremioUrl === addon.manifestUrl ? 'active' : ''} ${!addon.enabled ? 'disabled' : ''}`}
            onClick={() => setStremioUrl(addon.manifestUrl)}>
            <span className="explore-source-icon"><Blocks size={20} /></span>
            <span className="explore-source-copy">
              <strong>{addon.manifest.name}</strong>
              <small>{addon.manifest.version} · {addon.manifest.catalogs.length} catalogs</small>
            </span>
            {stremioUrl === addon.manifestUrl && <Check size={16} />}
          </button>
        ))}
      </aside>

      <section className="explorer-content">
        {selected ? (
          <div className="explorer-detail page-enter">
            <button className="text-button" onClick={() => setSelected(null)}><ChevronLeft size={15} /> Back to {activeAddon?.manifest.name || 'catalogs'}</button>
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
                providerCount={addons.filter((addon) => addon.enabled).length}
                preferredLanguage={preferredLanguage}
                onPlay={(stream) => onPlay(selected, stream)}
                onOpenExtensions={onOpenExtensions}
              />
            </div>
          </div>
        ) : activeAddon ? (
          <div className="explorer-detail page-enter">
            <header className="explorer-source-header">
              <span className="explore-source-icon large"><Blocks size={26} /></span>
              <div>
                <span className="page-kicker">STREMIO ADDON</span>
                <h2>{activeAddon.manifest.name}</h2>
                <p>{activeAddon.manifest.description || 'Catalogs, metadata, and streams from a Stremio addon.'}</p>
              </div>
              <span className={`source-state ${activeAddon.enabled ? 'online' : 'paused'}`}>{activeAddon.enabled ? 'Active' : 'Paused'}</span>
            </header>

            <div className="explorer-toolbar">
              {searchCatalog ? (
                <div className="explore-search">
                  <Search size={16} />
                  <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder={`Search ${activeAddon.manifest.name}…`} aria-label={`Search ${activeAddon.manifest.name}`} />
                  {searchTerm && <button className="search-clear" onClick={() => setSearchTerm('')} aria-label="Clear search">×</button>}
                </div>
              ) : <span className="explore-search-hint"><CircleAlert size={14} /> This addon has no searchable catalog.</span>}
              <div className="filter-pills">
                {(['all', 'movie', 'series'] as const).map((value) => (
                  <button key={value} className={searchType === value ? 'active' : ''} onClick={() => setSearchType(value)}>
                    {value === 'all' ? 'All' : value === 'movie' ? 'Movies' : 'Series'}
                  </button>
                ))}
              </div>
            </div>

            {catalogsByType.map((group) => (
              <section className="explore-catalog-group" key={group.type}>
                <div className="section-heading"><div><h2>{typeLabel(group.type)}</h2><p>{group.catalogs.length} catalog{group.catalogs.length === 1 ? '' : 's'}</p></div></div>
                <div className="catalog-chips">
                  {group.catalogs.map((catalog) => {
                    const selectedCatalog = !searchTerm.trim() && baseCatalog && baseCatalog.type === catalog.type && baseCatalog.id === catalog.id;
                    return (
                      <button key={`${catalog.type}-${catalog.id}`} className={`catalog-chip ${selectedCatalog ? 'active' : ''}`}
                        onClick={() => { setSearchTerm(''); setBaseCatalog(catalog); }}>
                        {catalog.name || catalog.id}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}

            {catalogLoading ? (
              <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
            ) : catalogItems.length ? (
              <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
                {catalogItems.map((item) => (
                  <MediaCard key={`${item.source}-${item.addonUrl || ''}-${item.id}`} item={item} onSelect={openMedia}
                    onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((entry) => entry.id === item.id)} compact={compact} />
                ))}
              </div>
            ) : (
              <div className="empty-state explore-empty">
                <span><CircleAlert size={26} /></span>
                <h2>{catalogError ? 'This catalog could not be loaded' : 'Nothing here yet'}</h2>
                <p>{catalogError || 'Pick another catalog or refine your search.'}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state explore-empty"><span><Compass size={26} /></span><h2>No addon selected</h2><p>Choose a Stremio addon to browse its catalogs.</p></div>
        )}
      </section>
    </div>
  );
};

export default StremioExplorer;
