import { useState } from 'react';
import { loadReadingCatalog, type ReadingCatalog, type ReadingSource } from '../services/readingCatalogs';
import type { NsfwMode } from '../types';

const labels = { kotatsu: 'Kotatsu Redo', lnreader: 'LNReader', ireader: 'IReader' };
const PAGE_SIZE = 30;

export default function ReadingSourceDirectory({ repository, readers, readerLabels, adultMode = 'off', onAdultMode, collapseListings = false }: {
  repository: ReadingCatalog;
  readers: Record<string, () => void>;
  readerLabels?: Record<string, string>;
  adultMode?: NsfwMode;
  onAdultMode?: (mode: NsfwMode) => void;
  collapseListings?: boolean;
}) {
  const label = labels[repository];
  const [sources, setSources] = useState<ReadingSource[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const load = async () => {
    setLoading(true);
    setError(false);
    try { setSources(await loadReadingCatalog(repository)); }
    catch { setError(true); }
    finally { setLoading(false); }
  };

  const term = query.trim().toLowerCase();
  const visible = (sources ?? []).filter(({ name, adult }) =>
    (adultMode === 'on' || adult === (adultMode === 'only')) && name.toLowerCase().includes(term));
  const playable = (collapseListings && !sources ? Object.keys(readers).map((name) => ({ name, adult: false })) : visible)
    .filter(({ name }) => Object.hasOwn(readers, name) && adultMode !== 'only' && name.toLowerCase().includes(term));
  const listings = visible.filter(({ name }) => !Object.hasOwn(readers, name));
  const remaining = <>
    <ul>{listings.slice(0, limit).map(({ name }) => <li key={name}>{name}</li>)}</ul>
    {limit < listings.length && <button type="button" className="button button-secondary" onClick={() => setLimit(limit + PAGE_SIZE)}>Show more sources</button>}
  </>;

  return (
    <details className="reading-source-directory" onToggle={(event) => {
      if (event.currentTarget.open && !sources && !loading && !error) void load();
    }}>
      <summary>{label} source directory</summary>
      {onAdultMode && <label>
        Hentai <select value={adultMode} onChange={(event) => { onAdultMode(event.target.value as NsfwMode); setLimit(PAGE_SIZE); }}>
          <option value="off">Hidden</option>
          <option value="on">Show with other sources</option>
          <option value="only">Hentai only</option>
        </select>
      </label>}
      <input type="search" aria-label={`Filter ${label} sources`} placeholder="Filter sources" value={query}
        onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
      {loading && <p role="status">Loading sources…</p>}
      {error && <p role="alert">Could not load sources. <button type="button" onClick={() => void load()}>Retry</button></p>}
      {sources && !visible.length && <p>No matching sources.</p>}
      {playable.length > 0 && <ul className={collapseListings ? 'reading-source-actions' : undefined}>
        {playable.map(({ name }) => <li key={name}><button type="button" className="button button-secondary" onClick={readers[name]}>
          {readerLabels?.[name] ?? name}{!collapseListings && ' · Open in PRAHA'}
        </button></li>)}
      </ul>}
      {listings.length > 0 && (collapseListings ? <details className="reading-source-listings" open={term ? true : undefined}>
        <summary>Catalog-only sources ({listings.length})</summary>
        {remaining}
      </details> : <>
        <p>Catalog entries pending reader integration</p>
        {remaining}
      </>)}
    </details>
  );
}
