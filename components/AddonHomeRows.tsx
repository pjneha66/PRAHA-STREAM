import React, { useEffect, useRef, useState } from 'react';
import type { InstalledAddon, MediaItem, StremioCatalog } from '../types';
import { fetchStremioCatalog } from '../services/stremioService';
import { MediaRow } from './MediaCard';

type Job = { key: string; addon: InstalledAddon; catalog: StremioCatalog };
type Row = { items: MediaItem[]; status: 'loading' | 'ready' | 'error'; error?: string };

function catalogError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^HTTP \d{3}$/.test(message)) return message;
  if (/abort|timeout|timed out/i.test(message)) return 'Request timed out';
  if (/JSON|unexpected token/i.test(message)) return 'Invalid catalog response';
  // Browser fetch errors don't reliably distinguish an offline server from CORS.
  // Don't display the raw message: configured URLs may contain credentials.
  return 'Network error or browser access blocked';
}

/** Catalog-only addons are useful on home even without a TMDB key. */
const AddonHomeRows: React.FC<{
  addons: InstalledAddon[];
  watchlist: MediaItem[];
  compact: boolean;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
}> = ({ addons, watchlist, compact, onSelect, onToggleWatchlist }) => {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [retry, setRetry] = useState(0);
  const rowsRef = useRef<Record<string, Row>>({});
  const jobs: Job[] = addons.flatMap((addon) => addon.enabled
    ? (addon.manifest.catalogs || []).filter((catalog) => ['movie', 'series'].includes(catalog.type) && !catalog.extra?.some((extra) => extra.isRequired))
      .map((catalog) => ({ addon, catalog, key: JSON.stringify([addon.manifestUrl, catalog.type, catalog.id]) }))
    : []);
  const signature = JSON.stringify(jobs.map(({ key }) => key));

  useEffect(() => {
    let active = true;
    const next: Record<string, Row> = {};
    jobs.forEach(({ key }) => { next[key] = rowsRef.current[key]?.status === 'ready' ? rowsRef.current[key] : { items: [], status: 'loading' }; });
    const currentJobs = jobs.filter(({ key }) => next[key].status !== 'ready');
    rowsRef.current = next;
    setRows(next);
    // Limit parallel requests to avoid overwhelming addon servers. A retry only
    // requests failed catalogs, keeping successful rows visible.
    let nextIndex = 0;
    const run = async () => {
      while (active && nextIndex < currentJobs.length) {
        const { addon, catalog, key } = currentJobs[nextIndex++];
        try {
          const items = await fetchStremioCatalog(addon, catalog);
          if (active) { rowsRef.current = { ...rowsRef.current, [key]: { items, status: 'ready' } }; setRows(rowsRef.current); }
        } catch (error) {
          if (active) { rowsRef.current = { ...rowsRef.current, [key]: { items: [], status: 'error', error: catalogError(error) } }; setRows(rowsRef.current); }
        }
      }
    };
    for (let i = 0; i < Math.min(4, currentJobs.length); i++) void run();
    return () => { active = false; };
    // Catalog objects are stable while their manifest URLs and IDs remain unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, retry]);

  const failures = jobs.filter(({ key }) => rows[key]?.status === 'error');
  return <>
    {jobs.map(({ key, addon, catalog }) => rows[key]?.items.length ? <MediaRow key={key} title={`${catalog.name || catalog.id} · ${catalog.type === 'movie' ? 'Movies' : 'Series'}`} subtitle={addon.manifest.name} items={rows[key].items} watchlist={watchlist} compact={compact} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} /> : null)}
    {failures.length > 0 && <div className="home-cache-notice" role="status">
      <div>Some addon catalogs could not be loaded. {failures.map(({ addon, catalog, key }) => `${addon.manifest.name} / ${catalog.name || catalog.id} (${catalog.type}): ${rows[key].error}`).join('; ')}.
        <p>Check that the addon is online and enabled. On the web, the addon must allow browser access (CORS); Android uses native HTTP when available.</p>
      </div>
      <button className="text-button" onClick={() => setRetry((value) => value + 1)}>Retry catalogs</button>
    </div>}
  </>;
};
export default AddonHomeRows;
