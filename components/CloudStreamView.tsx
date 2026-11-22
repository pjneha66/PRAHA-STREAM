import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

type Tab = 'extensions' | 'repositories' | 'browse' | 'providers';

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

  const [tab, setTab] = useState<Tab>('extensions');
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

  const loadHome = useCallback(async () => {
    if (!available || homeLoading) return;
    setHomeLoading(true);
    try {
      setHome(await getHome());
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Home rows could not be loaded.', 'error');
    } finally {
      setHomeLoading(false);
    }
  }, [available, homeLoading, notify]);

  useEffect(() => {
    if (tab === 'browse' && !home.length && !homeLoading) void loadHome();
  }, [tab, home.length, homeLoading, loadHome]);

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
      setTab('repositories');
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
      setSearchBatches(await search(term));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Search failed.', 'error');
    } finally {
      setSearching(false);
    }
  };

  const handleToggleCatalog = async (apiName: string, section: string, enabled: boolean) => {
    setHome((current) => current.map((row) => (row.apiName === apiName && row.section === section ? { ...row, ...{} } : row)));
    try {
      await setCatalogEnabled(apiName, section, enabled);
      await loadHome();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not save that catalog.', 'error');
    }
  };

  const loadedPlugins = plugins.filter((plugin) => plugin.loaded).length;
  const updateCount = plugins.filter((plugin) => plugin.error).length;
  const totalResults = useMemo(
    () => searchBatches.reduce((sum, batch) => sum + batch.items.length, 0),
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
      <div className="extension-hero cloudstream-hero">
        <div className="extension-orbit orbit-one" /><div className="extension-orbit orbit-two" />
        <span className="extension-hero-icon"><Boxes size={26} /></span>
        <div>
          <span className="page-kicker">CLOUDSTREAM EXTENSIONS</span>
          <h1>Every CloudStream source, in PRAHA.</h1>
          <p>Install real <code>.cs3</code> extensions and their repositories. They run natively on the device, exactly as they do in CloudStream.</p>
        </div>
        <div className="compatibility-badges">
          <span><Zap size={16} /> Native Dalvik host</span>
          <span><ShieldCheck size={16} /> SHA-256 verified</span>
        </div>
      </div>

      <div className="extension-stats">
        <div><span className="stat-icon lime"><Plug size={19} /></span><p>Loaded extensions<strong>{loadedPlugins}</strong></p><small>of {plugins.length} installed</small></div>
        <div><span className="stat-icon blue"><Layers size={19} /></span><p>Providers<strong>{providers.length}</strong></p><small>Across every extension</small></div>
        <div><span className="stat-icon violet"><Compass size={19} /></span><p>Repositories<strong>{repositories.length}</strong></p><small>{updateCount > 0 ? `${updateCount} need attention` : 'All healthy'}</small></div>
      </div>

      <div className="extension-tabs">
        <button className={tab === 'extensions' ? 'active' : ''} onClick={() => setTab('extensions')}><PackageOpen size={18} /><span>Extensions<small>Installed & running</small></span><b>{plugins.length}</b></button>
        <button className={tab === 'repositories' ? 'active' : ''} onClick={() => setTab('repositories')}><Layers size={18} /><span>Repositories<small>Sources of .cs3 packages</small></span><b>{repositories.length}</b></button>
        <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}><Compass size={18} /><span>Browse<small>Home rows & search</small></span><b>{home.length}</b></button>
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}><Zap size={18} /><span>Providers<small>What each extension offers</small></span><b>{providers.length}</b></button>
      </div>

      {error && <p className="install-error"><CircleAlert size={15} />{error}</p>}

      {tab === 'extensions' && (
        <>
          <div className="cloudstream-toolbar">
            <button className="button button-primary" onClick={handleUpdateAll} disabled={busy === 'update-all' || !plugins.length}>
              {busy === 'update-all' ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />} Update all
            </button>
            <button className="button button-secondary" onClick={handleInstallMissing} disabled={busy === 'install-missing'}>
              {busy === 'install-missing' ? <RefreshCw size={16} className="spin" /> : <Download size={16} />} Install everything available
            </button>
            <button className="button button-secondary" onClick={handleSideload} disabled={busy === 'sideload'}>
              {busy === 'sideload' ? <RefreshCw size={16} className="spin" /> : <Plug size={16} />} Install from file
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
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'repositories' && (
        <>
          <section className="install-panel">
            <div className="install-panel-title">
              <span><Layers size={20} /></span>
              <div>
                <h2>Add a CloudStream repository</h2>
                <p>Paste a repository URL or a GitHub repo. PRAHA reads its <code>repo.json</code> and lists the extensions it publishes.</p>
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

      {tab === 'browse' && (
        <>
          <section className="install-panel">
            <form onSubmit={handleSearch} className="install-form">
              <div>
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search every CloudStream provider…"
                  aria-label="Search CloudStream providers"
                />
              </div>
              <button className="button button-primary" disabled={searching || !query.trim()}>
                {searching ? <RefreshCw size={17} className="spin" /> : <Search size={17} />}
                {searching ? 'Searching…' : 'Search'}
              </button>
            </form>
            <p className="install-hint"><ShieldCheck size={14} /> Each provider searches on the device. Results appear grouped by extension.</p>
          </section>

          {searchBatches.length > 0 && (
            <div className="cloudstream-results">
              <div className="installed-heading">
                <div><h2>Results</h2><p>{totalResults} across {searchBatches.filter((batch) => batch.items.length).length} provider{searchBatches.filter((batch) => batch.items.length).length === 1 ? '' : 's'}</p></div>
                <button className="button button-secondary button-small" onClick={() => { setSearchBatches([]); setQuery(''); }}>Clear</button>
              </div>
              {searchBatches.filter((batch) => batch.items.length || batch.error).map((batch) => (
                <section className="cloudstream-batch" key={batch.apiName}>
                  <div className="section-heading">
                    <div><h2>{batch.apiName}</h2>{batch.error && <p><TriangleAlert size={13} /> {batch.error}</p>}</div>
                    <span>{batch.items.length}</span>
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
          )}

          {!searchBatches.length && (
            <>
              <div className="installed-heading">
                <div><h2>Home rows</h2><p>Catalogs every loaded extension publishes.</p></div>
                <button className="button button-secondary button-small" onClick={loadHome} disabled={homeLoading}>
                  {homeLoading ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
                </button>
              </div>
              {home.map((section) => (
                <section className="cloudstream-batch" key={`${section.apiName}:${section.section}`}>
                  <div className="section-heading">
                    <div><h2>{section.name}</h2><p>{section.apiName}</p></div>
                    <button
                      className="test-button"
                      onClick={() => handleToggleCatalog(section.apiName, section.section, false)}
                      title="Hide this row"
                    >
                      <Check size={13} /> Shown
                    </button>
                  </div>
                  <div className="cloudstream-grid">
                    {section.items.map((item) => (
                      <button className="cloudstream-tile" key={`${section.apiName}:${item.url}`} onClick={() => onOpenItem(item)}>
                        <span className="cloudstream-tile-art">
                          {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Boxes size={22} />}
                        </span>
                        <strong>{item.name}</strong>
                        <small>{item.type || 'Title'}</small>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {!home.length && !homeLoading && (
                <div className="empty-state extension-empty">
                  <span><Compass size={27} /></span>
                  <h2>No home rows</h2>
                  <p>Install an extension with a main page to see its catalogs here, or search above.</p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === 'providers' && (
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
