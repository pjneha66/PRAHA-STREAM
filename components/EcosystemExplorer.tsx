// Browsing the installed extension ecosystems' catalogs: the Explore tab's
// rows for Sora, SkyStream and Zangetsu (the movies/series surfaces) and the
// AnymeX anime ones. Each extension is one selectable source; its rows or its
// search results show as cards, and a card opens its episodes and streams
// exactly the way the Stremio explorer does.
//
// What each ecosystem's rows are, per its reference app: SkyStream and Zangetsu
// answer a home feed; Sora modules have no browse endpoint, so their rows are
// the seeded searches upstream picks. AnymeX has Popular/Latest.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Play, RefreshCw, Search, X } from 'lucide-react';
import { MediaCard, MediaRow } from './MediaCard';
import { findEcosystemStreams } from '../services/ecosystems/streams';
import { soraCatalogPage, soraSearch } from '../services/ecosystems/sora';
import { skyStreamHome, skyStreamSearch } from '../services/ecosystems/skystream';
import { zangetsuHomeRows, zangetsuSearch } from '../services/ecosystems/zangetsu';
import { anymexCatalog, anymexEpisodes, anymexSearch } from '../services/ecosystems/anymex';
import { ecosystemExtensions, type EcosystemExtension } from '../services/ecosystems/store';
import type { MediaItem, StreamResult } from '../types';

interface EcosystemExplorerProps {
  watchlist: MediaItem[];
  compact: boolean;
  onToggleWatchlist: (item: MediaItem) => void;
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onOpenExtensions: () => void;
}

interface EcoRow {
  title: string;
  items: MediaItem[];
}

/** The extensions this explorer browses, in the tab that owns their content. */
const browseable = (entry: EcosystemExtension): boolean =>
  entry.ecosystem !== 'anymex' || entry.kind === 'anime';

const EcosystemExplorer: React.FC<EcosystemExplorerProps> = ({
  watchlist, compact, onToggleWatchlist, onPlay, onOpenExtensions,
}) => {
  const [extensions, setExtensions] = useState<EcosystemExtension[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rows, setRows] = useState<EcoRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowsError, setRowsError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [streams, setStreams] = useState<StreamResult[]>([]);
  const [streamError, setStreamError] = useState('');
  const [loadingStreams, setLoadingStreams] = useState(false);

  useEffect(() => {
    const refresh = () => {
      const list = ecosystemExtensions('sora')
        .concat(ecosystemExtensions('skystream'), ecosystemExtensions('zangetsu'), ecosystemExtensions('anymex'))
        .filter((entry) => entry.enabled && browseable(entry));
      setExtensions(list);
      setActiveId((current) => (current && list.some((entry) => entry.key === current) ? current : list[0]?.key ?? null));
    };
    refresh();
    window.addEventListener('praha:ecosystems-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('praha:ecosystems-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const active = useMemo(
    () => extensions.find((entry) => entry.key === activeId) ?? null,
    [extensions, activeId],
  );

  const loadRows = useCallback(async (extension: EcosystemExtension) => {
    setLoadingRows(true);
    setRowsError('');
    setRows([]);
    try {
      let loaded: EcoRow[] = [];
      if (extension.ecosystem === 'zangetsu') {
        loaded = await zangetsuHomeRows(extension);
      } else if (extension.ecosystem === 'skystream') {
        loaded = await skyStreamHome(extension);
      } else if (extension.ecosystem === 'sora') {
        // A Sora module has no browse endpoint: page 1 of each seeded row.
        const catalogs = extension.kind === 'series'
          ? ['browse', 'popular', 'series']
          : ['browse', 'movies'];
        const pages = await Promise.all(catalogs.map(async (catalogId) => ({
          title: catalogId === 'browse' ? 'Browse' : catalogId === 'popular' ? 'Popular' : catalogId === 'series' ? 'Series' : 'Movies',
          items: await soraCatalogPage(extension, catalogId, 1),
        })));
        loaded = pages.filter((row) => row.items.length);
      } else {
        const popular = await anymexCatalog(extension, 'popular');
        const latest = await anymexCatalog(extension, 'latest');
        loaded = [
          { title: 'Popular', items: popular },
          { title: 'Latest', items: latest },
        ].filter((row) => row.items.length);
      }
      setRows(loaded);
    } catch (error) {
      setRowsError(error instanceof Error ? error.message : 'This extension returned nothing.');
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => {
    if (active) void loadRows(active);
  }, [active, loadRows]);

  const runSearch = useCallback(async (query: string) => {
    if (!active || !query.trim()) return;
    setSearching(true);
    try {
      let items: MediaItem[] = [];
      if (active.ecosystem === 'sora') items = await soraSearch(active, query.trim());
      else if (active.ecosystem === 'skystream') items = await skyStreamSearch(active, query.trim());
      else if (active.ecosystem === 'zangetsu') items = await zangetsuSearch(active, query.trim());
      else items = await anymexSearch(active, query.trim());
      setResults(items);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [active]);

  const openMedia = (item: MediaItem) => {
    setSeason(1);
    setEpisode(1);
    setSelected(item);
    setStreams([]);
    setStreamError('');
  };

  const loadStreams = useCallback(async (item: MediaItem, nextSeason: number, nextEpisode: number) => {
    if (!active) return;
    setLoadingStreams(true);
    setStreamError('');
    try {
      const found = await findEcosystemStreams(active, {
        title: item.title,
        ownId: item.providerMediaId,
        season: item.type === 'series' ? nextSeason : null,
        episode: item.type === 'series' ? nextEpisode : null,
      });
      setStreams(found);
      if (!found.length) setStreamError('No playable sources for this title.');
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : 'This extension failed.');
    } finally {
      setLoadingStreams(false);
    }
  }, [active]);

  // AnymeX anime keeps its episodes in the detail answer; series items from the
  // other ecosystems resolve their episode inside the stream finder.
  useEffect(() => {
    if (!selected || !active || active.ecosystem !== 'anymex') return;
    let cancelled = false;
    anymexEpisodes(active, selected.providerMediaId ?? '').then((list) => {
      if (cancelled) return;
      const picked = list.find((entry) => entry.season === season && entry.number === episode)
        ?? list.find((entry) => entry.number === episode)
        ?? list[0];
      if (picked) void loadStreams(selected, picked.season, picked.number);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [selected, active, season, episode, loadStreams]);

  useEffect(() => {
    if (!selected || !active || active.ecosystem === 'anymex') return;
    void loadStreams(selected, season, episode);
  }, [selected, active, season, episode, loadStreams]);

  if (!extensions.length) {
    return (
      <div className="empty-state explore-empty">
        <span>◈</span>
        <h2>No extension sources installed</h2>
        <p>Install Sora, SkyStream, Zangetsu or AnymeX extensions to browse their catalogs here.</p>
        <button className="button button-primary" onClick={onOpenExtensions}>Manage sources</button>
      </div>
    );
  }

  if (selected && active) {
    return (
      <div className="explorer">
        <button className="text-button" onClick={() => setSelected(null)}>
          <ChevronLeft size={15} /> Back to {active.name}
        </button>
        <div className="detail-head" style={{ display: 'flex', gap: 16, marginTop: 12 }}>
          {selected.poster && <img src={selected.poster} alt="" width={110} style={{ borderRadius: 10 }} />}
          <div>
            <h2>{selected.title}</h2>
            <p>{selected.overview || 'No description on this source.'}</p>
            {selected.type === 'series' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input type="number" min={1} value={season} aria-label="Season"
                  onChange={(event) => setSeason(Math.max(1, Number(event.target.value) || 1))}
                  style={{ width: 70 }} />
                <input type="number" min={1} value={episode} aria-label="Episode"
                  onChange={(event) => setEpisode(Math.max(1, Number(event.target.value) || 1))}
                  style={{ width: 70 }} />
              </div>
            )}
          </div>
        </div>
        <div className="source-list" style={{ marginTop: 16 }}>
          {loadingStreams && <p role="status">Searching {active.name}…</p>}
          {streamError && !loadingStreams && <p>{streamError}</p>}
          {streams.map((stream) => (
            <button key={stream.id} className="source-row" onClick={() => onPlay(selected, stream)}>
              <span><Play size={15} /></span>
              <span className="source-row-title">{stream.title}</span>
              <span className="source-row-meta">{stream.sourceName}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const list = searchTerm.trim() ? results : rows.flatMap((row) => row.items);

  return (
    <div className="explorer">
      <div className="reading-controls" style={{ flexWrap: 'wrap' }}>
        <select className="reading-select" aria-label="Extension source" value={activeId ?? ''}
          onChange={(event) => { setActiveId(event.target.value); setSearchTerm(''); setResults([]); }}>
          {extensions.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.name} — {entry.ecosystem === 'sora' ? 'Sora' : entry.ecosystem === 'skystream' ? 'SkyStream' : entry.ecosystem === 'zangetsu' ? 'Zangetsu' : 'AnymeX'}
            </option>
          ))}
        </select>
        <form className="global-search" onSubmit={(event) => { event.preventDefault(); void runSearch(searchTerm); }} style={{ flex: 1, minWidth: 220 }}>
          <Search size={16} />
          <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={`Search ${active?.name ?? 'this source'}`} aria-label="Search this source" />
          {searchTerm && <button type="button" className="search-clear" onClick={() => { setSearchTerm(''); setResults([]); }} aria-label="Clear search"><X size={14} /></button>}
        </form>
        <button type="button" className="text-button" onClick={() => active && void loadRows(active)} aria-label="Refresh rows">
          <RefreshCw size={15} />
        </button>
      </div>

      {loadingRows && <p role="status">Loading {active?.name}…</p>}
      {rowsError && <p>{rowsError}</p>}
      {searching && <p role="status">Searching…</p>}

      {!searchTerm.trim() && rows.map((row) => (
        <MediaRow
          key={row.title}
          title={row.title}
          items={row.items}
          watchlist={watchlist}
          compact={compact}
          onToggleWatchlist={onToggleWatchlist}
          onSelect={openMedia}
        />
      ))}

      {searchTerm.trim() && (
        <div className={compact ? 'card-grid compact' : 'card-grid'}>
          {list.map((item) => (
            <MediaCard key={`${item.source}-${item.id}`} item={item} onSelect={openMedia}
              inWatchlist={watchlist.some((entry) => entry.id === item.id)}
              onToggleWatchlist={() => onToggleWatchlist(item)} compact={compact} />
          ))}
          {!list.length && !searching && <p>No results on this source.</p>}
        </div>
      )}
    </div>
  );
};

export default EcosystemExplorer;
