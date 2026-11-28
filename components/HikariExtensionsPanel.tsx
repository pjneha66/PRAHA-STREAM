import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { bridgeRpcAvailable } from '../services/androidBridge';
import {
  HIKARI_REPO, hikiBrowse, hikiCatalogs, hikiProviders, installHiki, installedHiki, loadHikiRepo, openHikiTitle, setHikiEnabled,
  type HikiCatalog, type HikiEntry, type HikiMedia, type HikiProvider, type HikiRepo, type InstalledHiki,
} from '../services/hikariExtensions';
import type { MediaItem } from '../types';
import { Artwork } from './MediaCard';

const REPOS_KEY = 'praha.hikari.repos.v1';

function savedRepos(): Pick<HikiRepo, 'name' | 'url'>[] {
  try {
    const repos = JSON.parse(localStorage.getItem(REPOS_KEY) || '[]');
    return Array.isArray(repos) ? repos.filter((repo) => typeof repo?.url === 'string' && typeof repo?.name === 'string') : [];
  } catch {
    return [];
  }
}

export default function HikariExtensionsPanel({ adult, onOpen }: { adult: boolean; onOpen: (item: MediaItem) => void }) {
  const available = bridgeRpcAvailable();
  const [repos, setRepos] = useState(savedRepos);
  const [url, setUrl] = useState('');
  const [repo, setRepo] = useState<HikiRepo | null>(null);
  const [view, setView] = useState<'repos' | 'library'>('repos');
  const [installed, setInstalled] = useState<InstalledHiki[]>([]);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(48);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<InstalledHiki | null>(null);
  const [providers, setProviders] = useState<HikiProvider[]>([]);
  const [provider, setProvider] = useState<HikiProvider | null>(null);
  const [catalogs, setCatalogs] = useState<HikiCatalog[]>([]);
  const [catalog, setCatalog] = useState('');
  const [query, setQuery] = useState('');
  const [executedQuery, setExecutedQuery] = useState('');
  const [items, setItems] = useState<HikiMedia[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!available) return;
    let active = true;
    void installedHiki().then((next) => { if (active) setInstalled(next); }).catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : 'Could not read installed Hikari extensions.');
    });
    return () => { active = false; };
  }, [available]);

  async function run(label: string, job: () => Promise<void>) {
    setError('');
    setBusy(label);
    try { await job(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The Hikari request failed.'); }
    finally { setBusy(''); }
  }

  async function browseRepo(target: string) {
    await run('Loading repository…', async () => {
      const next = await loadHikiRepo(target);
      setRepo(next);
      setFilter('');
      setLimit(48);
      if (next.url !== HIKARI_REPO && !repos.some((item) => item.url === next.url)) {
        const updated = [...repos, { name: next.name, url: next.url }];
        localStorage.setItem(REPOS_KEY, JSON.stringify(updated));
        setRepos(updated);
      }
    });
  }

  async function queryItems(source: HikiProvider, row: string, term: string, nextPage = 1) {
    if (nextPage === 1) {
      setItems([]);
      setMore(false);
    }
    const results = await hikiBrowse(source.key, row, term, nextPage);
    const seen = new Set(nextPage === 1 ? [] : items.map((item) => item.id));
    const newItems = results.filter((item) => item.id && !seen.has(item.id) && seen.add(item.id));
    setItems(nextPage === 1 ? newItems : [...items, ...newItems]);
    setPage(nextPage);
    setMore(newItems.length > 0);
    setExecutedQuery(term);
  }

  async function selectProvider(next: HikiProvider) {
    setProvider(next);
    setCatalogs([]);
    setCatalog('');
    setQuery('');
    setItems([]);
    setMore(false);
    const rows = await hikiCatalogs(next.key);
    setCatalogs(rows);
    const first = rows[0]?.id ?? '';
    setCatalog(first);
    if (first) await queryItems(next, first, '');
  }

  async function selectPackage(item: InstalledHiki) {
    await run('Loading providers…', async () => {
      setSelection(item);
      setProvider(null);
      setProviders([]);
      setCatalogs([]);
      setItems([]);
      const next = await hikiProviders(item.id);
      setProviders(next);
      if (next[0]) await selectProvider(next[0]);
    });
  }

  async function install(entry: HikiEntry) {
    await run(`Installing ${entry.name}…`, async () => {
      await installHiki(entry);
      setInstalled(await installedHiki());
    });
  }

  if (!available) return <section className="install-panel"><h2>Hikari extensions</h2>
    <p>Browse and install native .hiki extensions in the PRAHA Android app.</p></section>;

  const visible = (entry: HikiEntry) => adult || !entry.adult;
  const packages = installed.filter(visible);
  const results = (repo?.plugins ?? []).filter(visible)
    .filter((entry) => entry.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return <>
    <section className="install-panel">
      <h2>Hikari extensions</h2>
      <div className="directory-actions" role="group" aria-label="Hikari sections">
        <button type="button" className="button button-secondary" aria-pressed={view === 'repos'} disabled={Boolean(busy)} onClick={() => setView('repos')}>Repositories</button>
        <button type="button" className="button button-secondary" aria-pressed={view === 'library'} disabled={Boolean(busy)} onClick={() => setView('library')}>Installed ({packages.length})</button>
      </div>
      {view === 'repos' && <>
        <div className="directory-actions">
          <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void browseRepo(HIKARI_REPO)}>Browse official repository</button>
          {repos.map((item) => <button type="button" className="button button-secondary" key={item.url} disabled={Boolean(busy)} onClick={() => void browseRepo(item.url)}>{item.name}</button>)}
        </div>
        <form className="install-form" onSubmit={(event) => { event.preventDefault(); if (url.trim()) void browseRepo(url); }}>
          <div><Search size={16} /><input aria-label="Hikari repository URL" placeholder="Hikari repo.json or GitHub repository" value={url} onChange={(event) => setUrl(event.target.value)} required /></div>
          <button className="button button-primary" disabled={Boolean(busy)}>Browse repository</button>
        </form>
      </>}
      {busy && <p role="status">{busy}</p>}
      {error && <p className="install-error" role="alert">{error}</p>}
    </section>

    {view === 'repos' && repo && <>
      <div className="installed-heading"><h2>{repo.name}</h2><span>{results.length} available</span></div>
      <input className="reading-select" type="search" aria-label="Filter Hikari packages" placeholder="Filter packages" value={filter}
        onChange={(event) => { setFilter(event.target.value); setLimit(48); }} />
      {results.length === 0 && <p>No matching .hiki packages.</p>}
      <div className="directory-grid">
        {results.slice(0, limit).map((entry) => {
          const saved = packages.find((item) => item.url === entry.url);
          const current = saved?.fileHash === entry.fileHash;
          return <article className="directory-card" key={entry.url}>
            <h3>{entry.name}</h3>
            <p>{entry.description || 'Hikari extension'}{entry.version ? ` · v${entry.version}` : ''}</p>
            <div className="directory-actions">
              <button className="button button-primary" disabled={Boolean(busy)} onClick={() => {
                if (saved && current && saved.enabled) {
                  setView('library');
                  void selectPackage(saved);
                } else if (!current) void install(entry);
              }} aria-disabled={current && !saved?.enabled}>{current ? (saved?.enabled ? 'Browse installed' : 'Installed · Disabled') : saved ? 'Update' : 'Install'}</button>
            </div>
          </article>;
        })}
      </div>
      {results.length > limit && <button className="button button-secondary" onClick={() => setLimit(limit + 48)}>Show more extensions</button>}
    </>}

    {view === 'library' && <>
      {!packages.length && <p>Install a .hiki package to browse its providers.</p>}
      <div className="directory-grid">
        {packages.map((item) => <article className="directory-card" key={item.id}>
          <h3>{item.name}</h3><p>{item.providers.join(' · ')}</p>
          <div className="directory-actions">
            <button className="button button-primary" disabled={Boolean(busy) || !item.enabled} onClick={() => void selectPackage(item)}>Browse {item.name}</button>
            <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void run('Saving extension…', async () => {
              await setHikiEnabled(item.id, !item.enabled);
              setInstalled(await installedHiki());
              if (selection?.id === item.id) { setSelection(null); setProvider(null); setItems([]); }
            })}>{item.enabled ? 'Disable' : 'Enable'}</button>
          </div>
        </article>)}
      </div>
      {selection && provider && <section className="install-panel">
        <h2>{provider.name}</h2>
        <div className="directory-actions">
          {providers.length > 1 && <select className="reading-select" aria-label="Hikari provider" disabled={Boolean(busy)} value={provider.key}
            onChange={(event) => {
              const next = providers.find((item) => item.key === event.target.value);
              if (next) void run('Loading provider…', () => selectProvider(next));
            }}>{providers.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</select>}
          {catalogs.length > 0 && <select className="reading-select" aria-label="Hikari catalog" disabled={Boolean(busy)} value={catalog}
            onChange={(event) => {
              const next = event.target.value;
              setCatalog(next);
              setQuery('');
              void run('Loading catalog…', () => queryItems(provider, next, ''));
            }}>{catalogs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        </div>
        <form className="install-form" onSubmit={(event) => {
          event.preventDefault();
          if (query.trim() || catalog) void run('Searching provider…', () => queryItems(provider, catalog, query.trim()));
        }}>
          <div><Search size={16} /><input aria-label="Search Hikari provider" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this provider" /></div>
          <button className="button button-primary" disabled={Boolean(busy)}>Search</button>
        </form>
        {!busy && !items.length && <p>{catalog || executedQuery ? 'No titles returned.' : 'Search for a title to get started.'}</p>}
        <div className="directory-grid">
          {items.map((item) => <article className="directory-card" key={item.id}>
            {item.posterUrl && <div className="source-title-art"><Artwork src={item.posterUrl} alt="" /></div>}
            <h3>{item.title || provider.name}</h3>
            <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void run('Opening title…', async () => {
              onOpen(await openHikiTitle(provider, item));
            })}>Open sources</button>
          </article>)}
        </div>
        {more && <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void run('Loading more titles…',
          () => queryItems(provider, catalog, executedQuery, page + 1))}>Load more</button>}
      </section>}
    </>}
  </>;
}
