import React, { useEffect, useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpRight, Blocks, Check, ChevronDown, ChevronUp, CircleAlert,
  Cloud, Compass, ExternalLink, Layers, Package, PackageOpen, Play, Plug, RefreshCw,
  Search, Settings2, ShieldCheck, Sliders, Trash2, WandSparkles, X, Zap,
} from 'lucide-react';
import { CURATED_EXTENSIONS, type CuratedExtensionItem } from '../data/extensionCatalog';
import {
  fetchStremioAddonCatalogs, fetchStremioManifest, getAddonConfigureUrl,
  type DiscoveredStremioAddon,
} from '../services/stremioService';
import {
  fetchNuvioRepository, getNuvioScraperSettingsSchema, testNuvioScraper,
} from '../services/nuvioService';
import { fetchCloudStreamRepository } from '../services/cloudstreamService';
import type {
  CloudStreamRepository, InstalledAddon, NuvioRepository, NuvioScraper, NuvioSettingField,
} from '../types';
import { Toggle } from './SettingsView';

interface ExtensionsProps {
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  cloudstreamRepositories: CloudStreamRepository[];
  nuvioSettings: Record<string, Record<string, unknown>>;
  setAddons: (updater: InstalledAddon[] | ((current: InstalledAddon[]) => InstalledAddon[])) => void;
  setRepositories: (updater: NuvioRepository[] | ((current: NuvioRepository[]) => NuvioRepository[])) => void;
  setCloudstreamRepositories: (updater: CloudStreamRepository[] | ((current: CloudStreamRepository[]) => CloudStreamRepository[])) => void;
  setNuvioSettings: (updater: Record<string, Record<string, unknown>> | ((current: Record<string, Record<string, unknown>>) => Record<string, Record<string, unknown>>)) => void;
  notify: (message: string, tone?: 'default' | 'success' | 'error') => void;
}

const resourceNames = (addon: InstalledAddon) => [...new Set(addon.manifest.resources.map((resource) => resource.name))];
const shortUrl = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

function moveItem<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= list.length) return list;
  const copy = [...list];
  const [picked] = copy.splice(index, 1);
  copy.splice(nextIndex, 0, picked);
  return copy;
}

const ExtensionsView: React.FC<ExtensionsProps> = ({
  addons, repositories, cloudstreamRepositories, nuvioSettings,
  setAddons, setRepositories, setCloudstreamRepositories, setNuvioSettings, notify,
}) => {
  const [tab, setTab] = useState<'stremio' | 'nuvio' | 'cloudstream' | 'directory'>('stremio');
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catalogAddons, setCatalogAddons] = useState<DiscoveredStremioAddon[]>([]);
  const [editingScraper, setEditingScraper] = useState<NuvioScraper | null>(null);
  const [scraperSchema, setScraperSchema] = useState<NuvioSettingField[]>([]);
  const [scraperDraft, setScraperDraft] = useState<Record<string, unknown>>({});
  const [schemaLoading, setSchemaLoading] = useState(false);

  const activeAddons = addons.filter((addon) => addon.enabled).length;
  const activeRepos = repositories.filter((repo) => repo.enabled).length;
  const activeCsRepos = cloudstreamRepositories.filter((repo) => repo.enabled).length;
  const catalogs = addons.filter((addon) => addon.enabled).reduce((sum, addon) => sum + addon.manifest.catalogs.length, 0);
  const providers = repositories.reduce((sum, repo) => sum + repo.scrapers.length, 0);
  const csProviders = cloudstreamRepositories.reduce((sum, repo) => sum + repo.providers.length, 0);

  useEffect(() => {
    if (tab !== 'directory') return;
    let active = true;
    fetchStremioAddonCatalogs(addons)
      .then((list) => { if (active) setCatalogAddons(list); })
      .catch(() => { if (active) setCatalogAddons([]); });
    return () => { active = false; };
  }, [tab, addons]);

  const installFromUrl = async (targetUrl: string, kind: 'stremio' | 'nuvio' | 'cloudstream') => {
    setInstalling(true); setInstallError(''); setBusy(targetUrl);
    try {
      if (kind === 'stremio') {
        const installed = await fetchStremioManifest(targetUrl);
        if (addons.some((addon) => addon.manifestUrl === installed.manifestUrl || addon.manifest.id === installed.manifest.id)) {
          throw new Error('That addon is already installed.');
        }
        setAddons((current) => [...current, installed]);
        notify(`${installed.manifest.name} is ready to use.`, 'success');
      } else if (kind === 'nuvio') {
        const installed = await fetchNuvioRepository(targetUrl);
        if (repositories.some((repo) => repo.manifestUrl === installed.manifestUrl)) {
          throw new Error('That repository is already installed.');
        }
        setRepositories((current) => [...current, installed]);
        notify(`${installed.name} added with ${installed.scrapers.length} provider${installed.scrapers.length === 1 ? '' : 's'}.`, 'success');
      } else {
        const installed = await fetchCloudStreamRepository(targetUrl);
        if (cloudstreamRepositories.some((repo) => repo.manifestUrl === installed.manifestUrl)) {
          throw new Error('That repository is already installed.');
        }
        setCloudstreamRepositories((current) => [...current, installed]);
        notify(`${installed.name} added with ${installed.providers.length} extension${installed.providers.length === 1 ? '' : 's'}.`, 'success');
      }
      setInstallUrl('');
    } catch (error) {
      const message = error instanceof TypeError && error.message === 'Failed to fetch'
        ? 'The source could not be reached. Check the URL and network connection.'
        : error instanceof Error ? error.message : 'Installation failed.';
      setInstallError(message);
      notify(message, 'error');
    } finally {
      setInstalling(false);
      setBusy('');
    }
  };

  const install = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!installUrl.trim()) { setInstallError('Enter a repository or manifest URL.'); return; }
    const targetKind = tab === 'directory' ? 'stremio' : tab;
    await installFromUrl(installUrl, targetKind);
  };

  const refreshAddon = async (addon: InstalledAddon) => {
    setBusy(addon.manifestUrl);
    try {
      const refreshed = await fetchStremioManifest(addon.manifestUrl);
      setAddons((current) => current.map((entry) => entry.manifestUrl === addon.manifestUrl ? { ...refreshed, enabled: entry.enabled, installedAt: entry.installedAt } : entry));
      notify(`${addon.manifest.name} is up to date.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not refresh addon.', 'error'); }
    finally { setBusy(''); }
  };

  const refreshRepository = async (repository: NuvioRepository) => {
    setBusy(repository.manifestUrl);
    try {
      const refreshed = await fetchNuvioRepository(repository.manifestUrl, repository);
      setRepositories((current) => current.map((entry) => entry.manifestUrl === repository.manifestUrl ? refreshed : entry));
      notify(`${repository.name} is up to date.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not refresh repository.', 'error'); }
    finally { setBusy(''); }
  };

  const refreshCloudStreamRepository = async (repository: CloudStreamRepository) => {
    setBusy(repository.manifestUrl);
    try {
      const refreshed = await fetchCloudStreamRepository(repository.manifestUrl, repository);
      setCloudstreamRepositories((current) => current.map((entry) => entry.manifestUrl === repository.manifestUrl ? refreshed : entry));
      notify(`${repository.name} is up to date.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not refresh repository.', 'error'); }
    finally { setBusy(''); }
  };

  const testScraper = async (scraper: NuvioScraper, repositoryName: string) => {
    setBusy(scraper.id);
    try {
      const results = await testNuvioScraper(scraper, repositoryName, nuvioSettings[scraper.id] || {});
      notify(results.length ? `${scraper.name} returned ${results.length} test stream${results.length === 1 ? '' : 's'}.` : `${scraper.name} ran successfully but returned no test streams.`, 'success');
    } catch (error) { notify(`${scraper.name}: ${error instanceof Error ? error.message : 'Test failed.'}`, 'error'); }
    finally { setBusy(''); }
  };

  const openScraperSettings = async (scraper: NuvioScraper) => {
    setEditingScraper(scraper);
    const existing = nuvioSettings[scraper.id] || {};
    setScraperDraft({ ...existing });
    setSchemaLoading(true);
    try {
      const schema = await getNuvioScraperSettingsSchema(scraper, existing);
      setScraperSchema(schema);
      const merged: Record<string, unknown> = { ...existing };
      schema.forEach((field) => {
        if (merged[field.key] === undefined && field.defaultValue !== undefined) {
          merged[field.key] = field.defaultValue;
        }
      });
      setScraperDraft(merged);
    } catch {
      setScraperSchema([]);
    } finally {
      setSchemaLoading(false);
    }
  };

  const saveScraperSettings = () => {
    if (!editingScraper) return;
    setNuvioSettings((current) => ({ ...current, [editingScraper.id]: scraperDraft }));
    notify(`Saved settings for ${editingScraper.name}.`, 'success');
    setEditingScraper(null);
  };

  const isCuratedInstalled = (item: CuratedExtensionItem) =>
    addons.some((addon) => addon.manifestUrl.toLowerCase() === item.manifestUrl.toLowerCase());

  return (
    <div className="standard-page extensions-page page-enter">
      <div className="extension-hero">
        <div className="extension-orbit orbit-one" /><div className="extension-orbit orbit-two" />
        <span className="extension-hero-icon"><WandSparkles size={26} /></span>
        <div><span className="page-kicker">POWERED BY YOUR SOURCES</span><h1>Make PRAHA your own.</h1><p>Connect Stremio addons, Nuvio scrapers, and CloudStream extensions with native Android CORS bypass and priority ordering.</p></div>
        <div className="compatibility-badges"><span><Blocks size={16} /> Stremio + Subtitles</span><span><Zap size={16} /> Nuvio compatible</span><span><Package size={16} /> CloudStream compatible</span></div>
      </div>

      <div className="extension-stats">
        <div><span className="stat-icon lime"><Plug size={19} /></span><p>Active sources<strong>{activeAddons + activeRepos + activeCsRepos}</strong></p><small>Ready when you are</small></div>
        <div><span className="stat-icon violet"><Cloud size={19} /></span><p>Available catalogs<strong>{catalogs}</strong></p><small>Across installed addons</small></div>
        <div><span className="stat-icon blue"><Zap size={19} /></span><p>Nuvio providers<strong>{providers}</strong></p><small>Individual scrapers</small></div>
        <div><span className="stat-icon cloudstream"><Layers size={19} /></span><p>CloudStream extensions<strong>{csProviders}</strong></p><small>From installed repos</small></div>
      </div>

      <div className="extension-tabs">
        <button className={tab === 'stremio' ? 'active' : ''} onClick={() => { setTab('stremio'); setInstallError(''); }}><Blocks size={18} /><span>Stremio addons<small>Catalogs, subtitles & streams</small></span><b>{addons.length}</b></button>
        <button className={tab === 'nuvio' ? 'active' : ''} onClick={() => { setTab('nuvio'); setInstallError(''); }}><Zap size={18} /><span>Nuvio plugins<small>Repositories & scrapers</small></span><b>{repositories.length}</b></button>
        <button className={tab === 'cloudstream' ? 'active' : ''} onClick={() => { setTab('cloudstream'); setInstallError(''); }}><Package size={18} /><span>CloudStream<small>Repositories & extensions</small></span><b>{cloudstreamRepositories.length}</b></button>
        <button className={tab === 'directory' ? 'active' : ''} onClick={() => { setTab('directory'); setInstallError(''); }}><Compass size={18} /><span>1-Click Directory<small>Subtitles, anime & catalogs</small></span><b>{CURATED_EXTENSIONS.length}</b></button>
      </div>

      {tab !== 'directory' && (
        <section className="install-panel">
          <div className="install-panel-title"><span>{tab === 'stremio' ? <Blocks size={20} /> : tab === 'nuvio' ? <Zap size={20} /> : <Package size={20} />}</span><div><h2>Add {tab === 'stremio' ? 'a Stremio addon' : tab === 'nuvio' ? 'a Nuvio repository' : 'a CloudStream repository'}</h2><p>{tab === 'stremio'
            ? 'Paste a manifest URL or stremio:// link. Subtitle addons like OpenSubtitles work automatically.'
            : tab === 'nuvio'
              ? 'Paste the repository URL. PRAHA fetches its manifest and runs scrapers with Android native HTTP.'
              : 'Paste a repo.json or plugins.json URL. PRAHA fetches its manifest and extension list.'}</p></div></div>
          <form onSubmit={install} className="install-form">
            <div><Search size={17} /><input value={installUrl} onChange={(event) => { setInstallUrl(event.target.value); setInstallError(''); }} placeholder={tab === 'stremio' ? 'https://addon.example/manifest.json' : tab === 'nuvio' ? 'https://github.com/user/nuvio-repository' : 'https://raw.githubusercontent.com/user/repo/builds/repo.json'} aria-label="Extension URL" /></div>
            <button className="button button-primary" disabled={installing}>{installing ? <RefreshCw size={17} className="spin" /> : <Plug size={17} />}{installing ? 'Installing…' : 'Install'}</button>
          </form>
          {installError && <p className="install-error"><CircleAlert size={15} />{installError}</p>}
          <p className="install-hint"><ShieldCheck size={14} /> Use ↑ / ↓ arrows below to prioritize which providers return streams first.</p>
        </section>
      )}

      {tab === 'directory' && (
        <section className="directory-section">
          <div className="installed-heading">
            <div>
              <h2>Community Addon Directory</h2>
              <p>One-tap official & open-source subtitle, anime, and catalog addons. No media is bundled.</p>
            </div>
            <span>{CURATED_EXTENSIONS.length + catalogAddons.length} available</span>
          </div>
          <div className="directory-grid">
            {CURATED_EXTENSIONS.map((item) => {
              const installed = isCuratedInstalled(item);
              return (
                <article className="directory-card" key={item.id}>
                  <div className="directory-card-head">
                    <span className="directory-cat">{item.category}</span>
                    {item.badge && <span className="directory-badge">{item.badge}</span>}
                  </div>
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                  <div className="directory-actions">
                    {item.configureUrl && (
                      <a className="button button-secondary button-small" href={item.configureUrl} target="_blank" rel="noreferrer">
                        <Settings2 size={14} /> Configure <ExternalLink size={12} />
                      </a>
                    )}
                    <button
                      className={`button button-small ${installed ? 'button-secondary' : 'button-primary'}`}
                      disabled={installed || busy === item.manifestUrl}
                      onClick={() => installFromUrl(item.manifestUrl, item.kind)}
                    >
                      {installed ? <><Check size={14} /> Installed</> : busy === item.manifestUrl ? <><RefreshCw size={14} className="spin" /> Installing…</> : <><Plug size={14} /> Install</>}
                    </button>
                  </div>
                </article>
              );
            })}

            {catalogAddons.map((disc) => {
              const installed = addons.some((a) => a.manifest.id === disc.manifest.id || a.manifestUrl === disc.transportUrl);
              return (
                <article className="directory-card" key={disc.transportUrl}>
                  <div className="directory-card-head">
                    <span className="directory-cat">Addon Catalog</span>
                  </div>
                  <h3>{disc.manifest.name}</h3>
                  <p>{disc.manifest.description || `v${disc.manifest.version}`}</p>
                  <div className="directory-actions">
                    <button
                      className={`button button-small ${installed ? 'button-secondary' : 'button-primary'}`}
                      disabled={installed || busy === disc.transportUrl}
                      onClick={() => installFromUrl(disc.transportUrl, 'stremio')}
                    >
                      {installed ? <><Check size={14} /> Installed</> : <><Plug size={14} /> Install</>}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {tab !== 'directory' && (
        <div className="installed-heading">
          <div>
            <h2>Installed {tab === 'stremio' ? 'addons' : tab === 'nuvio' ? 'repositories' : 'extensions'}</h2>
            <p>{tab === 'stremio' ? 'Toggle, configure, or reorder sources across PRAHA.' : tab === 'nuvio' ? 'Control each repository, configure scraper settings, and test connections.' : 'Control the whole repository or each extension individually.'}</p>
          </div>
          <span>{tab === 'stremio' ? addons.length : tab === 'nuvio' ? repositories.length : cloudstreamRepositories.length} total</span>
        </div>
      )}

      {tab === 'stremio' && (
        <div className="extension-list">
          {addons.map((addon, index) => {
            const isExpanded = expanded === addon.manifestUrl;
            const configureUrl = getAddonConfigureUrl(addon);
            return (
              <article className={`extension-card ${!addon.enabled ? 'disabled' : ''}`} key={addon.manifestUrl}>
                <div className="extension-card-main">
                  <div className="extension-logo">{addon.manifest.logo ? <img src={addon.manifest.logo} alt="" /> : <Blocks size={24} />}</div>
                  <div className="extension-info">
                    <div className="extension-title">
                      <h3>{addon.manifest.name}</h3>
                      <span>v{addon.manifest.version}</span>
                      {addon.enabled && <span className="active-badge"><i />ACTIVE</span>}
                    </div>
                    <p>{addon.manifest.description || 'Stremio addon'}</p>
                    <div className="resource-badges">
                      {resourceNames(addon).map((resource) => <span key={resource}>{resource}</span>)}
                      {addon.manifest.catalogs.length > 0 && <span>{addon.manifest.catalogs.length} catalogs</span>}
                    </div>
                  </div>
                  <div className="extension-actions">
                    <button className="icon-button" disabled={index === 0} onClick={() => setAddons((cur) => moveItem(cur, index, -1))} aria-label="Move addon up" title="Higher priority"><ArrowUp size={15} /></button>
                    <button className="icon-button" disabled={index === addons.length - 1} onClick={() => setAddons((cur) => moveItem(cur, index, 1))} aria-label="Move addon down" title="Lower priority"><ArrowDown size={15} /></button>
                    {configureUrl && (
                      <a className="icon-button" href={configureUrl} target="_blank" rel="noreferrer" aria-label={`Configure ${addon.manifest.name}`} title="Configure addon">
                        <Settings2 size={16} />
                      </a>
                    )}
                    <Toggle checked={addon.enabled} onChange={(enabled) => setAddons((current) => current.map((entry) => entry.manifestUrl === addon.manifestUrl ? { ...entry, enabled } : entry))} label={`${addon.enabled ? 'Disable' : 'Enable'} ${addon.manifest.name}`} />
                    <button className="icon-button" onClick={() => refreshAddon(addon)} disabled={busy === addon.manifestUrl} aria-label={`Refresh ${addon.manifest.name}`}><RefreshCw size={17} className={busy === addon.manifestUrl ? 'spin' : ''} /></button>
                    <button className="icon-button danger" onClick={() => { setAddons((current) => current.filter((entry) => entry.manifestUrl !== addon.manifestUrl)); notify(`${addon.manifest.name} removed.`); }} aria-label={`Remove ${addon.manifest.name}`}><Trash2 size={17} /></button>
                    <button className="icon-button" onClick={() => setExpanded(isExpanded ? null : addon.manifestUrl)} aria-label="Show addon details">{isExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="extension-details">
                    <span><b>Manifest</b>{addon.manifestUrl}</span>
                    <span><b>Addon ID</b>{addon.manifest.id}</span>
                    <span><b>Updated</b>{new Date(addon.updatedAt).toLocaleDateString()}</span>
                    {addon.manifest.catalogs.length > 0 && (
                      <div>{addon.manifest.catalogs.map((catalog) => <span key={`${catalog.type}-${catalog.id}`}>{catalog.name || catalog.id} · {catalog.type}</span>)}</div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {!addons.length && <div className="empty-state extension-empty"><span><PackageOpen size={27} /></span><h2>No Stremio addons yet</h2><p>Install a manifest above or browse the 1-Click Directory tab.</p></div>}
        </div>
      )}

      {tab === 'nuvio' && (
        <div className="extension-list">
          {repositories.map((repository, index) => {
            const isExpanded = expanded === repository.manifestUrl || repository.scrapers.length > 0;
            return (
              <article className={`extension-card repository-card ${!repository.enabled ? 'disabled' : ''}`} key={repository.manifestUrl}>
                <div className="extension-card-main">
                  <div className="extension-logo nuvio"><Zap size={24} /></div>
                  <div className="extension-info"><div className="extension-title"><h3>{repository.name}</h3><span>v{repository.version}</span>{repository.enabled && <span className="active-badge"><i />ACTIVE</span>}</div><p>{repository.description || `Nuvio repository by ${repository.author || shortUrl(repository.manifestUrl)}`}</p><div className="resource-badges"><span>{repository.scrapers.length} providers</span><span>{shortUrl(repository.manifestUrl)}</span></div></div>
                  <div className="extension-actions">
                    <button className="icon-button" disabled={index === 0} onClick={() => setRepositories((cur) => moveItem(cur, index, -1))} aria-label="Move repository up"><ArrowUp size={15} /></button>
                    <button className="icon-button" disabled={index === repositories.length - 1} onClick={() => setRepositories((cur) => moveItem(cur, index, 1))} aria-label="Move repository down"><ArrowDown size={15} /></button>
                    <Toggle checked={repository.enabled} onChange={(enabled) => setRepositories((current) => current.map((entry) => entry.manifestUrl === repository.manifestUrl ? { ...entry, enabled } : entry))} label={`Toggle ${repository.name}`} />
                    <button className="icon-button" onClick={() => refreshRepository(repository)} disabled={busy === repository.manifestUrl} aria-label={`Refresh ${repository.name}`}><RefreshCw size={17} className={busy === repository.manifestUrl ? 'spin' : ''} /></button>
                    <button className="icon-button danger" onClick={() => { setRepositories((current) => current.filter((entry) => entry.manifestUrl !== repository.manifestUrl)); notify(`${repository.name} removed.`); }} aria-label={`Remove ${repository.name}`}><Trash2 size={17} /></button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="scraper-list">
                    {repository.scrapers.map((scraper) => (
                      <div className="scraper-row" key={scraper.id}>
                        <span className="scraper-icon"><Zap size={16} /></span>
                        <div>
                          <strong>{scraper.name}<small>v{scraper.version}</small></strong>
                          <p>{scraper.description || scraper.supportedTypes.join(' · ')}{scraper.contentLanguage?.length ? ` · ${scraper.contentLanguage.join(', ').toUpperCase()}` : ''}</p>
                        </div>
                        <span className={`scraper-status ${scraper.enabled ? '' : 'paused'}`}>{scraper.enabled ? 'Ready' : 'Paused'}</span>
                        <button className="test-button" onClick={() => openScraperSettings(scraper)} title="Configure scraper">
                          <Sliders size={14} /> Settings
                        </button>
                        <button className="test-button" onClick={() => testScraper(scraper, repository.name)} disabled={busy === scraper.id}>
                          {busy === scraper.id ? <RefreshCw size={14} className="spin" /> : <Play size={14} />} Test
                        </button>
                        <Toggle
                          checked={scraper.enabled}
                          onChange={(enabled) => setRepositories((current) => current.map((repo) => repo.manifestUrl === repository.manifestUrl ? { ...repo, scrapers: repo.scrapers.map((entry) => entry.id === scraper.id ? { ...entry, enabled: enabled && entry.manifestEnabled } : entry) } : repo))}
                          label={`Toggle ${scraper.name}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          {!repositories.length && <div className="empty-state extension-empty nuvio-empty"><span><PackageOpen size={27} /></span><h2>Your plugin shelf is empty</h2><p>Add a Nuvio repository above. Its providers appear here with individual controls, scraper settings, and stream testing.</p><div className="empty-features"><span><Check size={14} /> Android CORS bypass</span><span><Check size={14} /> Scraper settings</span><span><Check size={14} /> Stream testing</span></div></div>}
        </div>
      )}

      {tab === 'cloudstream' && (
        <div className="extension-list">
          {cloudstreamRepositories.map((repository, index) => {
            const isExpanded = expanded === repository.manifestUrl || repository.providers.length > 0;
            return (
              <article className={`extension-card repository-card ${!repository.enabled ? 'disabled' : ''}`} key={repository.manifestUrl}>
                <div className="extension-card-main">
                  <div className="extension-logo cloudstream"><Package size={24} /></div>
                  <div className="extension-info"><div className="extension-title"><h3>{repository.name}</h3><span>v{repository.manifestVersion ?? '—'}</span>{repository.enabled && <span className="active-badge"><i />ACTIVE</span>}</div><p>{repository.description || `CloudStream repository by ${shortUrl(repository.manifestUrl)}`}</p><div className="resource-badges"><span>{repository.providers.length} extensions</span><span>{shortUrl(repository.manifestUrl)}</span></div></div>
                  <div className="extension-actions">
                    <button className="icon-button" disabled={index === 0} onClick={() => setCloudstreamRepositories((cur) => moveItem(cur, index, -1))} aria-label="Move repository up"><ArrowUp size={15} /></button>
                    <button className="icon-button" disabled={index === cloudstreamRepositories.length - 1} onClick={() => setCloudstreamRepositories((cur) => moveItem(cur, index, 1))} aria-label="Move repository down"><ArrowDown size={15} /></button>
                    <Toggle checked={repository.enabled} onChange={(enabled) => setCloudstreamRepositories((current) => current.map((entry) => entry.manifestUrl === repository.manifestUrl ? { ...entry, enabled } : entry))} label={`Toggle ${repository.name}`} />
                    <button className="icon-button" onClick={() => refreshCloudStreamRepository(repository)} disabled={busy === repository.manifestUrl} aria-label={`Refresh ${repository.name}`}><RefreshCw size={17} className={busy === repository.manifestUrl ? 'spin' : ''} /></button>
                    <button className="icon-button danger" onClick={() => { setCloudstreamRepositories((current) => current.filter((entry) => entry.manifestUrl !== repository.manifestUrl)); notify(`${repository.name} removed.`); }} aria-label={`Remove ${repository.name}`}><Trash2 size={17} /></button>
                  </div>
                </div>
                {isExpanded && <div className="scraper-list">{repository.providers.map((provider) => <div className="scraper-row" key={provider.id}><span className="scraper-icon cloudstream">{provider.iconUrl ? <img src={provider.iconUrl.replace('%size%', '64')} alt="" /> : <Package size={16} />}</span><div><strong>{provider.name}<small>v{provider.version ?? '—'}</small></strong><p>{provider.description || provider.tvTypes?.join(' · ')}{provider.language ? ` · ${provider.language.toUpperCase()}` : ''}</p></div><span className={`scraper-status ${provider.enabled ? '' : 'paused'}`}>{provider.enabled ? 'Ready' : 'Paused'}</span><Toggle checked={provider.enabled} onChange={(enabled) => setCloudstreamRepositories((current) => current.map((repo) => repo.manifestUrl === repository.manifestUrl ? { ...repo, providers: repo.providers.map((entry) => entry.id === provider.id ? { ...entry, enabled: enabled && entry.manifestEnabled } : entry) } : repo))} label={`Toggle ${provider.name}`} /></div>)}</div>}
              </article>
            );
          })}
          {!cloudstreamRepositories.length && <div className="empty-state extension-empty cloudstream-empty"><span><PackageOpen size={27} /></span><h2>Your extension shelf is empty</h2><p>Add a CloudStream repository above. Its extensions appear here with individual controls.</p></div>}
        </div>
      )}

      {editingScraper && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditingScraper(null)}>
          <section className="scraper-settings-modal" role="dialog" aria-modal="true" aria-label={`${editingScraper.name} settings`}>
            <header>
              <div>
                <span className="page-kicker">PROVIDER SETTINGS</span>
                <h3>{editingScraper.name}</h3>
              </div>
              <button className="modal-close" onClick={() => setEditingScraper(null)} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="scraper-settings-body">
              {schemaLoading ? (
                <p>Inspecting provider settings schema…</p>
              ) : scraperSchema.length > 0 ? (
                scraperSchema.map((field) => (
                  <label className="scraper-field" key={field.key}>
                    <strong>{field.label || field.key}</strong>
                    {field.description && <small>{field.description}</small>}
                    {field.type === 'boolean' || field.type === 'toggle' ? (
                      <Toggle
                        checked={Boolean(scraperDraft[field.key])}
                        onChange={(val) => setScraperDraft((cur) => ({ ...cur, [field.key]: val }))}
                        label={field.label || field.key}
                      />
                    ) : field.options?.length ? (
                      <select
                        value={String(scraperDraft[field.key] ?? '')}
                        onChange={(e) => setScraperDraft((cur) => ({ ...cur, [field.key]: e.target.value }))}
                      >
                        {field.options.map((opt) => {
                          const value = typeof opt === 'string' ? opt : opt.value;
                          const label = typeof opt === 'string' ? opt : opt.label;
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    ) : (
                      <input
                        type={field.type === 'password' ? 'password' : 'text'}
                        value={String(scraperDraft[field.key] ?? '')}
                        placeholder={field.placeholder || ''}
                        onChange={(e) => setScraperDraft((cur) => ({ ...cur, [field.key]: e.target.value }))}
                      />
                    )}
                  </label>
                ))
              ) : (
                <label className="scraper-field">
                  <strong>Custom provider settings (JSON)</strong>
                  <small>This scraper did not declare a dynamic form schema. You can still supply key-value JSON passed to <code>SCRAPER_SETTINGS</code>.</small>
                  <textarea
                    rows={5}
                    defaultValue={JSON.stringify(scraperDraft, null, 2)}
                    onChange={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        if (parsed && typeof parsed === 'object') setScraperDraft(parsed);
                      } catch {
                        // Wait until valid JSON before updating draft
                      }
                    }}
                  />
                </label>
              )}
            </div>
            <footer>
              <button className="button button-secondary" onClick={() => setEditingScraper(null)}>Cancel</button>
              <button className="button button-primary" onClick={saveScraperSettings}><Check size={15} /> Save settings</button>
            </footer>
          </section>
        </div>
      )}

      <div className="extension-footer"><div><ShieldCheck size={18} /><p><strong>Android Native Networking</strong>Inside the PRAHA Android APK, Stremio addons, Nuvio scrapers, and CloudStream plugins automatically route blocked requests and custom stream headers through PRAHA’s native Android HTTP & local stream proxy.</p></div><a href={tab === 'nuvio' ? 'https://github.com/NuvioMedia/NuvioMobile' : tab === 'cloudstream' ? 'https://github.com/recloudstream/cloudstream' : 'https://github.com/Stremio/stremio-addon-sdk'} target="_blank" rel="noreferrer">View project docs <ArrowUpRight size={15} /></a></div>
    </div>
  );
};

export default ExtensionsView;
