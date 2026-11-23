import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight, Boxes, Check, ChevronDown, ChevronUp, CircleAlert, Compass, Download,
  ExternalLink, Layers, Loader2, PackageOpen, Plug, RefreshCw, Search, ShieldCheck,
  Trash2, TriangleAlert, Zap,
} from 'lucide-react';
import {
  addRepository, cloudStreamAvailable, getHome, getInstalledPlugins, getProviders,
  getRepositories, getRepositoryPlugins, installMissing, installPlugin, onInstallFinished,
  pickPluginFile, removeRepository, search, setCatalogEnabled, uninstallPlugin, updatePlugins,
  type CloudStreamSearchBatch,
} from '../services/cloudstreamService';
import type {
  CloudStreamAvailablePlugin, CloudStreamHomeSection, CloudStreamPlugin,
  CloudStreamProvider, CloudStreamRepository, CloudStreamSearchItem,
} from '../types';
import { Toggle } from './SettingsView';

interface CloudStreamViewProps {
  onOpenItem: (item: CloudStreamSearchItem) => void;
  notify: (message: string, tone?: 'default' | 'success' | 'error') => void;
}

/**
 * Two top-level sections, because browsing and maintenance are different jobs:
 * Browse is what you open to watch something, Manage is what you open when an
 * extension is missing, broken or needs updating. The four old peer tabs put the
 * search box below three screens of repository chrome, so Browse meant scrolling
 * past everything you did not want.
 */
type Section = 'browse' | 'manage';
type ManageTab = 'extensions' | 'repositories' | 'providers';

const shortUrl = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

const formatSize = (bytes?: number | null) => {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const STATUS_LABELS: Record<number, string> = { 0: 'Down', 1: 'Working', 2: 'Slow', 3: 'Beta' };

/**
 * CloudStream extensions.
 *
 * Everything on this screen is backed by the native host — a `.cs3` is Dalvik
 * bytecode, so the WebView can only ask the device what it has and what it found.
 * That is why this view is a management surface rather than a network client: the
 * repositories, the installed packages, and the provider list all come from the
 * host, and nothing is cached in localStorage.
 */
const CloudStreamView: React.FC<CloudStreamViewProps> = ({ onOpenItem, notify }) => {
  const available = cloudStreamAvailable();

  const [section, setSection] = useState<Section>('browse');
  const [manageTab, setManageTab] = useState<ManageTab>('extensions');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const [repositories, setRepositories] = useState<CloudStreamRepository[]>([]);
  const [plugins, setPlugins] = useState<CloudStreamPlugin[]>([]);
  const [providers, setProviders] = useState<CloudStreamProvider[]>([]);
  const [loading, setLoading] = useState(false);

  const [repoPlugins, setRepoPlugins] = useState<Record<string, CloudStreamAvailablePlugin[]>>({});
  const [repoUrl, setRepoUrl] = useState('');

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [searchBatches, setSearchBatches] = useState<CloudStreamSearchBatch[]>([]);
  const [searching, setSearching] = useState(false);

  const [home, setHome] = useState<CloudStreamHomeSection[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!available) return;
    setLoading(true);
    setError('');
    try {
      const [repos, installed, providerList] = await Promise.all([
        getRepositories(),
        getInstalledPlugins(),
        getProviders(),
      ]);
      setRepositories(repos);
      setPlugins(installed);
      setProviders(providerList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CloudStream could not be read.');
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => { void reload(); }, [reload]);

  // The picker installs on a background thread, so its outcome arrives later.
  useEffect(() => onInstallFinished((event) => {
    setBusy('');
    if (event.ok) {
      notify('Extension installed from file.', 'success');
      void reload();
    } else {
      notify(event.message || 'The package could not be installed.', 'error');
    }
  }), [notify, reload]);

  // A cancelled picker sends no event, so clearing on refocus keeps the button
  // from staying in its spinner state forever.
  useEffect(() => {
    if (busy !== 'sideload') return;
    const clear = () => setBusy((current) => (current === 'sideload' ? '' : current));
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, [busy]);

  /**
   * Guards against a stale response overwriting a newer one. It is a ref rather
   * than the `homeLoading` state so reloading right after a catalog toggle is
   * not swallowed while the first fetch is still in flight — which is exactly
   * what happened when the toggle's `await loadHome()` ran during the initial
   * load. StrictMode's double mount is safe: the first pair of effects bumps the
   * counter, and only the newest request is allowed to write state.
   */
  const homeRequestRef = useRef(0);
  /**
   * Which provider filter the automatic load has already covered. It replaces a
   * plain boolean so changing the dropdown refetches, while StrictMode's
   * mount/unmount/remount — which runs the effect twice with the same filter —
   * still fetches exactly once. `null` means "not loaded yet".
   */
  const requestedFilterRef = useRef<string | null>(null);

  const loadHome = useCallback(async () => {
    if (!available) return;
    const request = ++homeRequestRef.current;
    setHomeLoading(true);
    try {
      // The host filters by provider name, so a single-entry list is the whole
      // contract for "only this extension's catalogs".
      const rows = await getHome(providerFilter ? [providerFilter] : undefined);
      if (request === homeRequestRef.current) setHome(rows);
    } catch (err) {
      if (request === homeRequestRef.current) {
        // Let the automatic load try again once, instead of treating a single
        // failed fetch as "already loaded" for the rest of the session.
        requestedFilterRef.current = null;
        notify(err instanceof Error ? err.message : 'Home rows could not be loaded.', 'error');
      }
    } finally {
      if (request === homeRequestRef.current) setHomeLoading(false);
    }
  }, [available, notify, providerFilter]);

  // Load the rows as soon as Browse is shown, so switching to it is not a blank
  // screen waiting on a refresh press.
  //
  // `loadHome` itself does not refuse to run while a load is in flight (that
  // guard is what made catalog toggles silently skip their refresh), so the
  // "only once" behaviour has to live here. The ref survives StrictMode's
  // mount/unmount/remount, so the automatic fetch happens exactly once per
  // provider filter.
  //
  // There is deliberately no `homeLoading` check: bailing out early while a
  // load was in flight used to leave the ref unset, so the effect fired again
  // as soon as that load settled and the same filter was fetched twice. A
  // superseded response is discarded by the request id anyway.
  useEffect(() => {
    if (section !== 'browse') return;
    if (requestedFilterRef.current === providerFilter) return;
    if (!plugins.some((plugin) => plugin.loaded)) return;
    requestedFilterRef.current = providerFilter;
    void loadHome();
  }, [section, loadHome, plugins, providerFilter]);

  const handleAddRepository = async (event: React.FormEvent) => {
    event.preventDefault();
    const input = repoUrl.trim();
    if (!input) { setError('Enter a repository URL.'); return; }
    setBusy('add-repo');
    setError('');
    try {
      const repo = await addRepository(input);
      setRepoUrl('');
      await reload();
      notify(`${repo.name} added.`, 'success');
      setSection('manage');
      setManageTab('repositories');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The repository could not be added.';
      setError(message);
      notify(message, 'error');
    } finally {
      setBusy('');
    }
  };

  const handleRemoveRepository = async (repo: CloudStreamRepository) => {
    setBusy(`remove:${repo.url}`);
    try {
      await removeRepository(repo.url);
      await reload();
      notify(`${repo.name} removed. Installed extensions from it were kept.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The repository could not be removed.', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleLoadRepoPlugins = async (repo: CloudStreamRepository) => {
    if (expanded === repo.url) { setExpanded(null); return; }
    setExpanded(repo.url);
    if (repoPlugins[repo.url]) return;
    setBusy(`browse:${repo.url}`);
    try {
      const list = await getRepositoryPlugins(repo.url);
      setRepoPlugins((current) => ({ ...current, [repo.url]: list }));
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${repo.name}.`, 'error');
      setExpanded(null);
    } finally {
      setBusy('');
    }
  };

  const handleInstall = async (repo: CloudStreamRepository, plugin: CloudStreamAvailablePlugin) => {
    setBusy(`install:${plugin.internalName}`);
    try {
      const ok = await installPlugin(repo.url, plugin.internalName);
      if (!ok) throw new Error(`${plugin.name} failed to load.`);
      await reload();
      setRepoPlugins((current) => ({
        ...current,
        [repo.url]: (current[repo.url] ?? []).map((entry) => entry.internalName === plugin.internalName
          ? { ...entry, installed: true, installedVersion: entry.version, updateAvailable: false }
          : entry),
      }));
      notify(`${plugin.name} installed.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : `${plugin.name} could not be installed.`, 'error');
    } finally {
      setBusy('');
    }
  };

  const handleUninstall = async (plugin: CloudStreamPlugin) => {
    setBusy(`uninstall:${plugin.internalName}`);
    try {
      await uninstallPlugin(plugin.internalName);
      await reload();
      notify(`${plugin.name} removed.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The extension could not be removed.', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleUpdateAll = async () => {
    setBusy('update-all');
    try {
      const updated = await updatePlugins();
      await reload();
      notify(updated.length ? `Updated ${updated.length} extension${updated.length === 1 ? '' : 's'}.` : 'Everything is already up to date.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Update failed.', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleInstallMissing = async () => {
    setBusy('install-missing');
    try {
      const installed = await installMissing(true);
      await reload();
      notify(installed.length ? `Installed ${installed.length} extension${installed.length === 1 ? '' : 's'}.` : 'No new extensions were available.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Install failed.', 'error');
    } finally {
      setBusy('');
    }
  };

  const handleSideload = async () => {
    // A .cs3 lives behind a content:// uri, which a WebView file input cannot
    // hand to native code, so the host opens the picker and reports back.
    setBusy('sideload');
    try {
      const opened = await pickPluginFile();
      if (!opened) throw new Error('The file picker could not be opened.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not open the file picker.', 'error');
      setBusy('');
    }
  };

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    setError('');
    try {
      setSearchBatches(await search(term, providerFilter ? [providerFilter] : undefined));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Search failed.', 'error');
    } finally {
      setSearching(false);
    }
  };

  /**
   * Switching provider clears the visible rows first. The refetch is async, and
   * leaving the previous provider's catalogs on screen while it runs makes it
   * look as though the new provider returned them.
   */
  const handleProviderChange = (name: string) => {
    if (name === providerFilter) return;
    setProviderFilter(name);
    setHome([]);
    setSearchBatches([]);
    requestedFilterRef.current = null;
  };

  const handleToggleCatalog = async (apiName: string, sectionName: string, enabled: boolean) => {
    setHome((current) => current.map((row) => (
      row.apiName === apiName && row.section === sectionName ? { ...row, enabled } : row
    )));
    try {
      await setCatalogEnabled(apiName, sectionName, enabled);
      await loadHome();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not save that catalog.', 'error');
    }
  };

  const loadedPlugins = plugins.filter((plugin) => plugin.loaded).length;
  const failedPlugins = plugins.filter((plugin) => plugin.error).length;
  /**
   * Providers are what the host filters on (`api.name`), not extensions — one
   * extension can register several. Sorted so the list is stable between
   * reloads, and deduped because a provider name is the only identifier the
   * filter accepts.
   */
  const providerOptions = useMemo(() => {
    const seen = new Set<string>();
    return providers
      .filter((provider) => {
        if (!provider.name || seen.has(provider.name)) return false;
        seen.add(provider.name);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providers]);
  const totalResults = useMemo(
    () => searchBatches.reduce((sum, batch) => sum + batch.items.length, 0),
    [searchBatches],
  );
  const visibleBatches = useMemo(
    () => searchBatches.filter((batch) => batch.items.length || batch.error),
    [searchBatches],
  );

  if (!available) {
    return (
      <div className="standard-page cloudstream-page page-enter">
        <section className="cloudstream-unavailable">
          <span><Boxes size={30} /></span>
          <h1>CloudStream extensions run on the device.</h1>
          <p>
            A <code>.cs3</code> package is Android bytecode, so it can only be installed and run
            by the PRAHA Android app — not in a browser. Open PRAHA on Android to manage
            repositories and extensions here.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="standard-page cloudstream-page page-enter">
      <header className="cloudstream-head">
        <span className="cloudstream-head-icon"><Boxes size={22} /></span>
        <div>
          <h1>CloudStream</h1>
          <p>
            {loadedPlugins} extension{loadedPlugins === 1 ? '' : 's'} loaded · {providers.length} provider{providers.length === 1 ? '' : 's'} · {repositories.length} repositor{repositories.length === 1 ? 'y' : 'ies'}
            {failedPlugins > 0 && <span className="cloudstream-head-warn"> · {failedPlugins} failed</span>}
          </p>
        </div>
        <span className="cloudstream-head-badge"><Zap size={13} /> Native</span>
      </header>

      <div className="cloudstream-sections">
        <button className={section === 'browse' ? 'active' : ''} onClick={() => setSection('browse')}>
          <Compass size={18} />
          <span>Browse<small>Search and home rows</small></span>
        </button>
        <button className={section === 'manage' ? 'active' : ''} onClick={() => setSection('manage')}>
          <Layers size={18} />
          <span>Manage<small>Extensions, repositories, providers</small></span>
          <b>{plugins.length + repositories.length}</b>
        </button>
      </div>

      {error && <p className="install-error"><CircleAlert size={15} />{error}</p>}

      {section === 'browse' && (
        <>
          <section className="install-panel cloudstream-search">
            {providerOptions.length > 0 && (
              <label className="cloudstream-provider-picker">
                <Zap size={15} />
                <select
                  value={providerFilter}
                  onChange={(event) => handleProviderChange(event.target.value)}
                  aria-label="Filter by provider"
                >
                  <option value="">All providers ({providerOptions.length})</option>
                  {providerOptions.map((provider) => (
                    <option key={provider.name} value={provider.name}>
                      {provider.name}{provider.lang ? ` · ${provider.lang}` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
            )}
            <form onSubmit={handleSearch} className="install-form">
              <div>
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={providerFilter ? `Search ${providerFilter}…` : 'Search every CloudStream provider…'}
                  aria-label="Search CloudStream providers"
                />
              </div>
              <button className="button button-primary" disabled={searching || !query.trim()}>
                {searching ? <RefreshCw size={17} className="spin" /> : <Search size={17} />}
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
          </section>

          {visibleBatches.length > 0 ? (
            <div className="cloudstream-results">
              <div className="cloudstream-row-head">
                <div>
                  <h2>Results</h2>
                  <p>{totalResults} across {visibleBatches.filter((batch) => batch.items.length).length} provider{visibleBatches.filter((batch) => batch.items.length).length === 1 ? '' : 's'}</p>
                </div>
                <button className="button button-secondary button-small" onClick={() => { setSearchBatches([]); setQuery(''); }}>
                  Clear
                </button>
              </div>
              {visibleBatches.map((batch) => (
                <section className="cloudstream-batch" key={batch.apiName}>
                  <div className="cloudstream-row-head">
                    <div>
                      <h2>{batch.apiName}</h2>
                      {batch.error && <p className="cloudstream-batch-error"><TriangleAlert size={12} /> {batch.error}</p>}
                    </div>
                    <span className="cloudstream-count">{batch.items.length}</span>
                  </div>
                  <div className="cloudstream-grid">
                    {batch.items.map((item) => (
                      <button className="cloudstream-tile" key={`${batch.apiName}:${item.url}`} onClick={() => onOpenItem(item)}>
                        <span className="cloudstream-tile-art">
                          {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Boxes size={22} />}
                        </span>
                        <strong>{item.name}</strong>
                        <small>{[item.type, item.quality].filter(Boolean).join(' · ') || 'Title'}</small>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <>
              <div className="cloudstream-row-head">
                <div>
                  <h2>Home rows</h2>
                  <p>{providerFilter ? `Catalogs from ${providerFilter}.` : 'Catalogs from every loaded extension.'}</p>
                </div>
                <button className="button button-secondary button-small" onClick={loadHome} disabled={homeLoading}>
                  <RefreshCw size={14} className={homeLoading ? 'spin' : ''} /> Refresh
                </button>
              </div>
              {homeLoading && !home.length && (
                <p className="cloudstream-loading"><Loader2 size={15} className="spin" /> Reading catalogs…</p>
              )}
              {home.map((row) => (
                <section className="cloudstream-batch" key={`${row.apiName}:${row.section}`}>
                  <div className="cloudstream-row-head">
                    <div><h2>{row.name}</h2><p>{row.apiName}</p></div>
                    <label className="cloudstream-toggle" title={row.enabled === false ? 'Show this row' : 'Hide this row'}>
                      <span>{row.enabled === false ? 'Hidden' : 'Shown'}</span>
                      <Toggle
                        checked={row.enabled !== false}
                        onChange={(next) => void handleToggleCatalog(row.apiName, row.section, next)}
                        label={`Show the ${row.name} row`}
                      />
                    </label>
                  </div>
                  {row.enabled !== false && (
                    <div className="cloudstream-grid">
                      {row.items.map((item) => (
                        <button className="cloudstream-tile" key={`${row.apiName}:${item.url}`} onClick={() => onOpenItem(item)}>
                          <span className="cloudstream-tile-art">
                            {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Boxes size={22} />}
                          </span>
                          <strong>{item.name}</strong>
                          <small>{item.type || 'Title'}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              ))}
              {!home.length && !homeLoading && (
                <div className="empty-state extension-empty">
                  <span><Compass size={27} /></span>
                  <h2>
                    {!loadedPlugins
                      ? 'No extensions installed'
                      : providerFilter ? `No rows from ${providerFilter}` : 'No home rows'}
                  </h2>
                  <p>
                    {!loadedPlugins
                      ? 'Open Manage to add a repository and install extensions, then their catalogs appear here.'
                      : providerFilter
                        ? 'This provider has no home catalog. Search it above, or switch back to all providers.'
                        : 'Search above, or refresh to read the catalogs again.'}
                  </p>
                  {!loadedPlugins ? (
                    <button className="button button-primary" onClick={() => setSection('manage')}>
                      <Layers size={16} /> Manage extensions
                    </button>
                  ) : providerFilter ? (
                    <button className="button button-secondary" onClick={() => handleProviderChange('')}>
                      Show all providers
                    </button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </>
      )}

      {section === 'manage' && (
        <>
          <div className="cloudstream-subtabs">
            <button className={manageTab === 'extensions' ? 'active' : ''} onClick={() => setManageTab('extensions')}>
              <PackageOpen size={15} /> Extensions <b>{plugins.length}</b>
            </button>
            <button className={manageTab === 'repositories' ? 'active' : ''} onClick={() => setManageTab('repositories')}>
              <Layers size={15} /> Repositories <b>{repositories.length}</b>
            </button>
            <button className={manageTab === 'providers' ? 'active' : ''} onClick={() => setManageTab('providers')}>
              <Zap size={15} /> Providers <b>{providers.length}</b>
            </button>
          </div>

          {manageTab === 'extensions' && (
            <>
              <div className="cloudstream-toolbar">
                <button className="button button-primary" onClick={handleUpdateAll} disabled={busy === 'update-all' || !plugins.length}>
                  <RefreshCw size={16} className={busy === 'update-all' ? 'spin' : ''} /> Update all
                </button>
                <button className="button button-secondary" onClick={handleInstallMissing} disabled={busy === 'install-missing'}>
                  <Download size={16} className={busy === 'install-missing' ? 'spin' : ''} /> Install available
                </button>
                <button className="button button-secondary" onClick={handleSideload} disabled={busy === 'sideload'}>
                  <Plug size={16} className={busy === 'sideload' ? 'spin' : ''} /> From file
                </button>
              </div>

              <div className="extension-list">
                {plugins.map((plugin) => {
                  const isExpanded = expanded === plugin.internalName;
                  return (
                    <article className={`extension-card ${!plugin.loaded ? 'disabled' : ''}`} key={plugin.internalName}>
                      <div className="extension-card-main">
                        <div className="extension-logo"><Boxes size={24} /></div>
                        <div className="extension-info">
                          <div className="extension-title">
                            <h3>{plugin.name}</h3>
                            <span>v{plugin.version}</span>
                            {plugin.loaded && <span className="active-badge"><i />ACTIVE</span>}
                            {plugin.error && <span className="cloudstream-badge error">FAILED</span>}
                          </div>
                          <p>{plugin.error || (plugin.repositoryUrl ? shortUrl(plugin.repositoryUrl) : 'Installed from file')}</p>
                          <div className="resource-badges">
                            <span>{plugin.providerCount} provider{plugin.providerCount === 1 ? '' : 's'}</span>
                            <span>{plugin.extractorCount} extractor{plugin.extractorCount === 1 ? '' : 's'}</span>
                            {plugin.isOnline && <span>Online</span>}
                          </div>
                        </div>
                        <div className="extension-actions">
                          <button className="icon-button" onClick={() => setExpanded(isExpanded ? null : plugin.internalName)} aria-label="Show extension details">
                            {isExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
                          </button>
                          <button
                            className="icon-button danger"
                            onClick={() => handleUninstall(plugin)}
                            disabled={busy === `uninstall:${plugin.internalName}`}
                            aria-label={`Remove ${plugin.name}`}
                          >
                            {busy === `uninstall:${plugin.internalName}` ? <RefreshCw size={17} className="spin" /> : <Trash2 size={17} />}
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="extension-details">
                          <span><b>Internal name</b>{plugin.internalName}</span>
                          <span><b>Repository</b>{plugin.repositoryUrl ? shortUrl(plugin.repositoryUrl) : 'Sideloaded'}</span>
                          <span><b>State</b>{plugin.loaded ? 'Loaded' : plugin.error ? 'Failed to load' : 'Not loaded'}</span>
                        </div>
                      )}
                    </article>
                  );
                })}
                {!plugins.length && !loading && (
                  <div className="empty-state extension-empty">
                    <span><PackageOpen size={27} /></span>
                    <h2>No CloudStream extensions yet</h2>
                    <p>Add a repository, then install the extensions you want from it. Every provider they register becomes available to PRAHA.</p>
                    <button className="button button-primary" onClick={() => setManageTab('repositories')}>
                      <Layers size={16} /> Add a repository
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {manageTab === 'repositories' && (
            <>
              <section className="install-panel">
                <div className="install-panel-title">
                  <span><Layers size={20} /></span>
                  <div>
                    <h2>Add a CloudStream repository</h2>
                    <p>Paste a repository URL or a GitHub repo. PRAHA reads its <code>repo.json</code> and lists what it publishes.</p>
                  </div>
                </div>
                <form onSubmit={handleAddRepository} className="install-form">
                  <div>
                    <Search size={17} />
                    <input
                      value={repoUrl}
                      onChange={(event) => { setRepoUrl(event.target.value); setError(''); }}
                      placeholder="https://github.com/user/cloudstream-repo"
                      aria-label="CloudStream repository URL"
                    />
                  </div>
                  <button className="button button-primary" disabled={busy === 'add-repo'}>
                    {busy === 'add-repo' ? <RefreshCw size={17} className="spin" /> : <Plug size={17} />}
                    {busy === 'add-repo' ? 'Adding…' : 'Add'}
                  </button>
                </form>
              </section>

              <div className="extension-list">
                {repositories.map((repo) => {
                  const isExpanded = expanded === repo.url;
                  const list = repoPlugins[repo.url];
                  const installedHere = list?.filter((plugin) => plugin.installed).length ?? 0;
                  return (
                    <article className="extension-card repository-card" key={repo.url}>
                      <div className="extension-card-main">
                        <div className="extension-logo nuvio"><Layers size={24} /></div>
                        <div className="extension-info">
                          <div className="extension-title">
                            <h3>{repo.name}</h3>
                            {list && <span className="cloudstream-badge">{installedHere}/{list.length} installed</span>}
                          </div>
                          <p>{repo.description || shortUrl(repo.url)}</p>
                          <div className="resource-badges"><span>{shortUrl(repo.url)}</span></div>
                        </div>
                        <div className="extension-actions">
                          <button
                            className="icon-button"
                            onClick={() => handleLoadRepoPlugins(repo)}
                            disabled={busy === `browse:${repo.url}`}
                            aria-label={`Show extensions in ${repo.name}`}
                          >
                            {busy === `browse:${repo.url}` ? <RefreshCw size={17} className="spin" /> : isExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
                          </button>
                          <a className="icon-button" href={repo.url} target="_blank" rel="noreferrer" aria-label={`Open ${repo.name}`}><ExternalLink size={16} /></a>
                          <button
                            className="icon-button danger"
                            onClick={() => handleRemoveRepository(repo)}
                            disabled={busy === `remove:${repo.url}`}
                            aria-label={`Remove ${repo.name}`}
                          >
                            {busy === `remove:${repo.url}` ? <RefreshCw size={17} className="spin" /> : <Trash2 size={17} />}
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="scraper-list">
                          {!list && <div className="cloudstream-loading"><Loader2 size={16} className="spin" /> Reading repository…</div>}
                          {list?.map((plugin) => {
                            const installing = busy === `install:${plugin.internalName}`;
                            const size = formatSize(plugin.fileSize);
                            return (
                              <div className="scraper-row" key={plugin.internalName}>
                                <span className="scraper-icon"><Boxes size={16} /></span>
                                <div>
                                  <strong>{plugin.name}<small>v{plugin.version}</small></strong>
                                  <p>
                                    {plugin.description || plugin.tvTypes.join(' · ') || 'Extension'}
                                    {size ? ` · ${size}` : ''}
                                    {plugin.language ? ` · ${plugin.language.toUpperCase()}` : ''}
                                  </p>
                                </div>
                                <span className={`scraper-status ${plugin.status === 1 ? '' : 'paused'}`}>{STATUS_LABELS[plugin.status] ?? 'Unknown'}</span>
                                {plugin.installed ? (
                                  <button
                                    className={`test-button ${plugin.updateAvailable ? '' : 'is-installed'}`}
                                    onClick={() => handleInstall(repo, plugin)}
                                    disabled={installing || !plugin.updateAvailable}
                                    title={plugin.updateAvailable ? 'Update to the published version' : 'Already installed'}
                                  >
                                    {installing ? <RefreshCw size={14} className="spin" /> : plugin.updateAvailable ? <RefreshCw size={14} /> : <Check size={14} />}
                                    {plugin.updateAvailable ? 'Update' : 'Installed'}
                                  </button>
                                ) : (
                                  <button className="test-button" onClick={() => handleInstall(repo, plugin)} disabled={installing}>
                                    {installing ? <RefreshCw size={14} className="spin" /> : <Download size={14} />} Install
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
                {!repositories.length && !loading && (
                  <div className="empty-state extension-empty">
                    <span><Layers size={27} /></span>
                    <h2>No repositories added</h2>
                    <p>Add a CloudStream repository above to see the extensions it publishes.</p>
                  </div>
                )}
              </div>
            </>
          )}

          {manageTab === 'providers' && (
            <div className="extension-list">
              {providers.map((provider) => (
                <article className="extension-card" key={provider.name}>
                  <div className="extension-card-main">
                    <div className="extension-logo"><Zap size={24} /></div>
                    <div className="extension-info">
                      <div className="extension-title">
                        <h3>{provider.name}</h3>
                        {provider.lang && <span>{provider.lang}</span>}
                        {provider.hasMainPage && <span className="active-badge"><i />HOME</span>}
                      </div>
                      <p>{provider.sourcePlugin ? `From ${provider.sourcePlugin}` : 'Built in'}</p>
                      <div className="resource-badges">
                        {provider.supportedTypes.map((type) => <span key={type}>{type}</span>)}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
              {!providers.length && (
                <div className="empty-state extension-empty">
                  <span><Zap size={27} /></span>
                  <h2>No providers loaded</h2>
                  <p>Install an extension that registers providers, then they will be listed here.</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="extension-footer">
        <div>
          <ShieldCheck size={18} />
          <p><strong>Native CloudStream host</strong>Extensions run on the device against CloudStream's own API. Repositories are read over PRAHA's native HTTP, and each <code>.cs3</code> is verified before it loads.</p>
        </div>
        <a href="https://github.com/recloudstream/cloudstream" target="_blank" rel="noreferrer">CloudStream project <ArrowUpRight size={15} /></a>
      </div>
    </div>
  );
};

export default CloudStreamView;
