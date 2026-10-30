import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight, Blocks, Check, CircleAlert, ExternalLink, LoaderCircle,
  Plus, RefreshCw, Search, ShieldCheck, Sparkles, Star, Store,
} from 'lucide-react';
import { DIRECTORY_SITE, fetchDirectoryAddons, fetchDirectoryCategories } from '../services/addonBrowserService';
import { fetchStremioManifest } from '../services/stremioService';
import type { DirectoryAddon, InstalledAddon } from '../types';
import { Toggle } from './SettingsView';

interface AddonBrowserViewProps {
  addons: InstalledAddon[];
  setAddons: (updater: InstalledAddon[] | ((current: InstalledAddon[]) => InstalledAddon[])) => void;
  notify: (message: string, tone?: 'default' | 'success' | 'error') => void;
  onOpenExtensions: () => void;
}

const PAGE_SIZE = 24;

const formatStars = (value: number) => {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(value);
};

const typeLabel = (types: string[]) => {
  const labels = types
    .map((type) => (type === 'movie' ? 'Movies' : type === 'series' ? 'Series' : type === 'anime' ? 'Anime' : type === 'tv' ? 'Live TV' : type))
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 3).join(' · ');
};

const errorMessage = (error: unknown) => {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return 'This addon’s manifest could not be reached. It may be offline or block browser requests (CORS).';
  }
  return error instanceof Error ? error.message : 'The addon could not be installed.';
};

const AddonBrowserView: React.FC<AddonBrowserViewProps> = ({ addons, setAddons, notify, onOpenExtensions }) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sortBy, setSortBy] = useState<'stars' | 'createdAt'>('stars');
  const [familyFriendly, setFamilyFriendly] = useState(true);
  const [items, setItems] = useState<DirectoryAddon[]>([]);
  const [total, setTotal] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Array<{ name: string; slug: string }>>([]);
  const [installing, setInstalling] = useState('');
  const [installError, setInstallError] = useState<{ manifestUrl: string; message: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    fetchDirectoryCategories()
      .then((list) => { if (active) setCategories(list); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const loadPage = useCallback(async (targetPage: number) => {
    if (targetPage === 1) setLoading(true);
    else setLoadingMore(true);
    setError('');
    try {
      const result = await fetchDirectoryAddons({
        search: debouncedQuery,
        categories: category ? [category] : [],
        sortBy,
        order: 'desc',
        page: targetPage,
        limit: PAGE_SIZE,
        nsfw: familyFriendly ? 'exclude' : 'include',
      });
      setItems((current) => (targetPage === 1 ? result.addons : [...current, ...result.addons]));
      setTotal(result.pagination.total);
      setHasNextPage(result.pagination.hasNextPage);
      setPage(result.pagination.page);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The addon directory could not be loaded.');
      if (targetPage === 1) { setItems([]); setTotal(0); setHasNextPage(false); }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [category, debouncedQuery, familyFriendly, sortBy]);

  useEffect(() => { loadPage(1); }, [loadPage]);

  const installedManifestUrls = useMemo(
    () => new Set(addons.map((addon) => addon.manifestUrl)),
    [addons],
  );

  const install = async (addon: DirectoryAddon) => {
    if (!addon.manifestUrl) return;
    setInstalling(addon.manifestUrl);
    setInstallError(null);
    try {
      const installed = await fetchStremioManifest(addon.manifestUrl);
      if (addons.some((entry) => entry.manifestUrl === installed.manifestUrl || entry.manifest.id === installed.manifest.id)) {
        throw new Error('That addon is already installed.');
      }
      setAddons((current) => [...current, installed]);
      notify(`${installed.manifest.name} is ready to use.`, 'success');
    } catch (installFailure) {
      setInstallError({ manifestUrl: addon.manifestUrl, message: errorMessage(installFailure) });
    } finally {
      setInstalling('');
    }
  };

  const activeCategory = categories.find((entry) => entry.slug === category);

  return (
    <div className="standard-page addon-directory-page page-enter">
      <section className="directory-hero">
        <div className="directory-orbit directory-orbit-one" />
        <div className="directory-orbit directory-orbit-two" />
        <div className="directory-hero-copy">
          <span className="page-kicker"><Store size={14} /> STREMIO ADDON BROWSER</span>
          <h1>Find your next addon.</h1>
          <p>
            Search the community directory on{' '}
            <a href={DIRECTORY_SITE} target="_blank" rel="noreferrer">stremio-addons.net</a>{' '}
            and install catalogs, metadata, and streams without leaving PRAHA.
          </p>
          <div className="directory-search">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search addons by name, description, or slug…"
              aria-label="Search the Stremio addon directory"
            />
            {query && <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear addon search">×</button>}
          </div>
          <div className="directory-hero-links">
            <span><Sparkles size={13} /> {total ? `${total.toLocaleString()} addons indexed` : 'Live directory'}</span>
            <button className="text-button" onClick={onOpenExtensions}><Plus size={14} /> Paste a manifest URL instead</button>
          </div>
        </div>
        <div className="directory-hero-art" aria-hidden="true">
          <span><Blocks size={22} /></span>
          <span><Star size={18} /></span>
          <span><Store size={26} /></span>
        </div>
      </section>

      <div className="directory-toolbar">
        <div className="directory-categories" role="group" aria-label="Addon categories">
          <button className={`catalog-chip ${!category ? 'active' : ''}`} onClick={() => setCategory('')}>All categories</button>
          {categories.map((entry) => (
            <button
              key={entry.slug}
              className={`catalog-chip ${category === entry.slug ? 'active' : ''}`}
              onClick={() => setCategory(category === entry.slug ? '' : entry.slug)}
            >
              {entry.name}
            </button>
          ))}
        </div>
        <div className="directory-filters">
          <div className="filter-pills">
            <button className={sortBy === 'stars' ? 'active' : ''} onClick={() => setSortBy('stars')}>Most starred</button>
            <button className={sortBy === 'createdAt' ? 'active' : ''} onClick={() => setSortBy('createdAt')}>Newest</button>
          </div>
          <label className="directory-safe">
            <ShieldCheck size={14} />
            <span>Family friendly</span>
            <Toggle checked={familyFriendly} onChange={setFamilyFriendly} label="Hide adult addons" />
          </label>
        </div>
      </div>

      <div className="directory-heading">
        <div>
          <h2>{debouncedQuery ? `Results for “${debouncedQuery}”` : activeCategory ? activeCategory.name : 'Popular addons'}</h2>
          <p>{loading ? 'Searching the directory…' : `${items.length}${total && total > items.length ? ` of ${total.toLocaleString()}` : ''} addon${items.length === 1 ? '' : 's'} shown`}</p>
        </div>
        <a className="text-button" href={DIRECTORY_SITE} target="_blank" rel="noreferrer">Browse on stremio-addons.net <ArrowUpRight size={14} /></a>
      </div>

      {error && (
        <div className="directory-error" role="alert">
          <CircleAlert size={17} />
          <div><strong>The directory could not be reached</strong><p>{error}</p></div>
          <button className="button button-secondary button-small" onClick={() => loadPage(1)}><RefreshCw size={15} /> Retry</button>
        </div>
      )}

      {!error && loading && (
        <div className="directory-grid" aria-busy="true">
          {Array.from({ length: 8 }).map((_, index) => (
            <article className="directory-card skeleton" key={index}>
              <div className="directory-card-top"><span className="directory-logo" /><div><i /><i /></div></div>
              <span className="skeleton-line" /><span className="skeleton-line short" />
            </article>
          ))}
        </div>
      )}

      {!error && !loading && !items.length && (
        <div className="empty-state directory-empty">
          <span><Search size={27} /></span>
          <h2>No addons matched that search</h2>
          <p>Try a shorter term, clear the category filter, or turn off family friendly mode to include everything the directory lists.</p>
          <button className="button button-secondary" onClick={() => { setQuery(''); setCategory(''); }}>Reset filters</button>
        </div>
      )}

      {!error && items.length > 0 && (
        <div className="directory-grid">
          {items.map((addon) => {
            const isInstalled = installedManifestUrls.has(addon.manifestUrl);
            const isInstalling = installing === addon.manifestUrl;
            return (
              <article className={`directory-card ${isInstalled ? 'installed' : ''}`} key={addon.uuid || addon.manifestUrl}>
                <div className="directory-card-top">
                  <span className="directory-logo">
                    {addon.logo ? <img src={addon.logo} alt="" loading="lazy" /> : <Blocks size={24} />}
                  </span>
                  <div className="directory-card-title">
                    <h3>{addon.name}</h3>
                    <p>{[addon.version ? `v${addon.version}` : '', typeLabel(addon.types)].filter(Boolean).join(' · ') || 'Stremio addon'}</p>
                  </div>
                  <span className="directory-stars" title={`${addon.stars} stars on stremio-addons.net`}>
                    <Star size={12} fill="currentColor" />{formatStars(addon.stars)}
                  </span>
                </div>
                <p className="directory-description">{addon.description || 'This addon has no description yet.'}</p>
                <div className="directory-tags">
                  {addon.categories.slice(0, 3).map((entry) => <span key={entry.slug}>{entry.name}</span>)}
                  {isInstalled && <span className="directory-installed-tag"><Check size={11} /> Installed</span>}
                </div>
                {installError?.manifestUrl === addon.manifestUrl && (
                  <p className="directory-card-error"><CircleAlert size={13} /> {installError.message}</p>
                )}
                <div className="directory-card-actions">
                  <button
                    className={`button button-small ${isInstalled ? 'button-secondary' : 'button-primary'}`}
                    onClick={() => install(addon)}
                    disabled={isInstalled || isInstalling}
                  >
                    {isInstalling ? <LoaderCircle size={15} className="spin" /> : isInstalled ? <Check size={15} /> : <Plus size={15} />}
                    {isInstalling ? 'Installing…' : isInstalled ? 'Installed' : 'Install'}
                  </button>
                  {addon.configureUrl && (
                    <a className="button button-secondary button-small" href={addon.configureUrl} target="_blank" rel="noreferrer">
                      Configure <ExternalLink size={13} />
                    </a>
                  )}
                  <a className="directory-site-link" href={addon.siteUrl} target="_blank" rel="noreferrer" aria-label={`Open ${addon.name} on stremio-addons.net`}>
                    <ArrowUpRight size={15} />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {!error && hasNextPage && (
        <div className="directory-more">
          <button className="button button-secondary" onClick={() => loadPage(page + 1)} disabled={loadingMore}>
            {loadingMore ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
            {loadingMore ? 'Loading…' : 'Load more addons'}
          </button>
        </div>
      )}

      <footer className="directory-footer">
        <div>
          <ShieldCheck size={17} />
          <p><strong>Install only what you trust</strong>Addons run in your browser and can read the titles you open. Directory data and star counts are provided by stremio-addons.net.</p>
        </div>
        <a href={DIRECTORY_SITE} target="_blank" rel="noreferrer">Data from stremio-addons.net <ArrowUpRight size={14} /></a>
      </footer>
    </div>
  );
};

export default AddonBrowserView;
