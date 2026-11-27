import { useEffect, useState } from 'react';
import { ArrowLeft, Layers, Search } from 'lucide-react';
import { collectionMember, featuredCollections } from '../data/collections';
import { tmdbService, type TmdbCollection } from '../services/tmdbService';
import type { MediaItem } from '../types';
import { Artwork, MediaCard } from './MediaCard';
import './collections-view.css';

const filters = [
  ['all', 'All'],
  ['franchise', 'Movie franchises'],
  ['universe', 'Shared universes'],
] as const;

type Filter = typeof filters[number][0];
type Selection = { title: string; members: MediaItem[] } | TmdbCollection;

export default function CollectionsView({ tmdbReady, watchlist, onSelect, onToggleWatchlist, onOpenSettings }: {
  tmdbReady: boolean;
  watchlist: MediaItem[];
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onOpenSettings: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState({ query: '', page: 1 });
  const [remote, setRemote] = useState<TmdbCollection[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [movies, setMovies] = useState<MediaItem[]>([]);
  const [detailStatus, setDetailStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!search.query || !tmdbReady || filter === 'universe') return;
    let active = true;
    setSearching(true);
    setSearchError('');
    void tmdbService.searchCollections(search.query, search.page).then((result) => {
      if (!active) return;
      setRemote((current) => search.page === 1 ? result.items : [...current, ...result.items.filter(
        (item) => !current.some((existing) => existing.id === item.id),
      )]);
      setHasMore(result.hasMore);
    }).catch(() => {
      if (active) setSearchError('Couldn’t load TMDB collections. Try again.');
    }).finally(() => { if (active) setSearching(false); });
    return () => { active = false; };
  }, [search, tmdbReady, filter]);

  useEffect(() => {
    if (!selected || 'members' in selected) return;
    let active = true;
    setMovies([]);
    setDetailStatus('loading');
    void tmdbService.collectionMovies(selected.id).then((result) => {
      if (!active) return;
      setMovies(result);
      setDetailStatus('ready');
    }).catch(() => { if (active) setDetailStatus('error'); });
    return () => { active = false; };
  }, [selected]);

  if (selected) {
    const curated = 'members' in selected;
    const members = curated ? selected.members : movies;
    return <div className="collections-page page-enter">
      <button type="button" className="text-button" data-android-back onClick={() => setSelected(null)}>
        <ArrowLeft size={17} /> Collections
      </button>
      <h1>{selected.title}</h1>
      {!curated && detailStatus === 'loading' && <p role="status">Loading movies…</p>}
      {!curated && detailStatus === 'error' && <div role="status">
        <p>Couldn’t load this collection.</p>
        <button type="button" className="button button-secondary" onClick={() => setSelected({ ...selected })}>Retry</button>
      </div>}
      {!curated && detailStatus === 'ready' && !members.length && <p>No movies are listed in this collection.</p>}
      <div className="media-grid">
        {members.map((item) => <MediaCard key={item.id} item={item} onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist} inWatchlist={watchlist.some((saved) => saved.id === item.id)} />)}
      </div>
    </div>;
  }

  const query = search.query.toLowerCase();
  const curated = featuredCollections.filter((collection) =>
    (filter === 'all' || collection.kind === filter) &&
    (!query || [collection.title, collection.aliases, ...collection.members.map(([title]) => title)]
      .some((text) => text?.toLowerCase().includes(query))));
  const showRemote = Boolean(query && tmdbReady && filter !== 'universe');

  return <div className="collections-page page-enter">
    <h1>Collections</h1>
    <form className="collections-search" onSubmit={(event) => {
      event.preventDefault();
      setRemote([]);
      setHasMore(false);
      setSearch({ query: input.trim(), page: 1 });
    }}>
      <label className="search-input">
        <Search size={18} />
        <input type="search" aria-label="Search collections" placeholder="Search collections" value={input}
          maxLength={150} onChange={(event) => setInput(event.target.value)} />
      </label>
      <button className="button button-primary" type="submit">Search</button>
    </form>
    <div className="collections-filters" aria-label="Collection type">
      {filters.map(([id, label]) => <button type="button" className={`button button-secondary${filter === id ? ' collection-filter-active' : ''}`}
        key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
    </div>
    <div className="media-grid collections-grid">
      {curated.map((collection) => (
        <button key={collection.id} type="button" className="collection-card"
          onClick={() => setSelected({ title: collection.title, members: collection.members.map(collectionMember) })}>
          <div className="collection-covers">
            {collection.members.slice(0, 2).map((member) => <Artwork key={member[2]} src={collectionMember(member).poster} alt="" />)}
          </div>
          <strong>{collection.title}</strong>
          <span>{collection.kind === 'universe' ? 'Shared universe' : 'Movie franchise'} · {collection.members.length} titles</span>
        </button>
      ))}
      {showRemote && remote.map((item) => (
        <button key={item.id} type="button" className="collection-card" onClick={() => setSelected(item)}>
          <div className="collection-covers">{item.poster ? <Artwork src={item.poster} alt="" /> : <Layers size={30} />}</div>
          <strong>{item.title}</strong>
          <span>Movie franchise · TMDB</span>
        </button>
      ))}
    </div>
    {showRemote && searching && <p role="status">Searching TMDB collections…</p>}
    {showRemote && searchError && <div role="status">
      <p>{searchError}</p>
      <button type="button" className="button button-secondary" onClick={() => setSearch({ ...search })}>Retry</button>
    </div>}
    {query && !curated.length && (!showRemote || (!remote.length && !searching && !searchError)) && <p>No matching collections.</p>}
    {showRemote && hasMore && !searching && !searchError && <button type="button" className="button button-secondary"
      onClick={() => setSearch({ ...search, page: search.page + 1 })}>Load more</button>}
    {!tmdbReady && filter !== 'universe' && <button type="button" className="text-button" onClick={onOpenSettings}>Add a TMDB key to search more movie franchises</button>}
  </div>;
}
