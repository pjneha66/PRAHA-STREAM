import React, { useState } from 'react';
import {
  ArrowUpRight, Blocks, Check, ChevronDown, ChevronUp, CircleAlert,
  Cloud, PackageOpen, Play, Plug, RefreshCw, Search,
  ShieldCheck, Store, Trash2, WandSparkles, Zap,
} from 'lucide-react';
import { fetchStremioManifest } from '../services/stremioService';
import { fetchNuvioRepository, testNuvioScraper } from '../services/nuvioService';
import type { InstalledAddon, NuvioRepository, NuvioScraper } from '../types';
import { Toggle } from './SettingsView';

interface ExtensionsProps {
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  setAddons: (updater: InstalledAddon[] | ((current: InstalledAddon[]) => InstalledAddon[])) => void;
  setRepositories: (updater: NuvioRepository[] | ((current: NuvioRepository[]) => NuvioRepository[])) => void;
  notify: (message: string, tone?: 'default' | 'success' | 'error') => void;
  onOpenAddonBrowser?: () => void;
}

const resourceNames = (addon: InstalledAddon) => [...new Set(addon.manifest.resources.map((resource) => resource.name))];
const shortUrl = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

const ExtensionsView: React.FC<ExtensionsProps> = ({
  addons, repositories, setAddons, setRepositories, notify, onOpenAddonBrowser,
}) => {
  const [tab, setTab] = useState<'stremio' | 'nuvio'>('stremio');
  const [installUrl, setInstallUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const activeAddons = addons.filter((addon) => addon.enabled).length;
  const activeRepos = repositories.filter((repo) => repo.enabled).length;
  const catalogs = addons.filter((addon) => addon.enabled).reduce((sum, addon) => sum + addon.manifest.catalogs.length, 0);
  const providers = repositories.reduce((sum, repo) => sum + repo.scrapers.length, 0);

  const install = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!installUrl.trim()) { setInstallError('Enter a repository or manifest URL.'); return; }
    setInstalling(true); setInstallError('');
    try {
      if (tab === 'stremio') {
        const installed = await fetchStremioManifest(installUrl);
        if (addons.some((addon) => addon.manifestUrl === installed.manifestUrl || addon.manifest.id === installed.manifest.id)) throw new Error('That addon is already installed.');
        setAddons((current) => [...current, installed]);
        notify(`${installed.manifest.name} is ready to use.`, 'success');
      } else {
        const installed = await fetchNuvioRepository(installUrl);
        if (repositories.some((repo) => repo.manifestUrl === installed.manifestUrl)) throw new Error('That repository is already installed.');
        setRepositories((current) => [...current, installed]);
        notify(`${installed.name} added with ${installed.scrapers.length} provider${installed.scrapers.length === 1 ? '' : 's'}.`, 'success');
      }
      setInstallUrl('');
    } catch (error) {
      const message = error instanceof TypeError && error.message === 'Failed to fetch'
        ? 'The source could not be reached. Check the URL and make sure it allows browser CORS requests.'
        : error instanceof Error ? error.message : 'Installation failed.';
      setInstallError(message);
    } finally { setInstalling(false); }
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

  const testScraper = async (scraper: NuvioScraper, repositoryName: string) => {
    setBusy(scraper.id);
    try {
      const results = await testNuvioScraper(scraper, repositoryName);
      notify(results.length ? `${scraper.name} returned ${results.length} test stream${results.length === 1 ? '' : 's'}.` : `${scraper.name} ran successfully but returned no test streams.`, 'success');
    } catch (error) { notify(`${scraper.name}: ${error instanceof Error ? error.message : 'Test failed.'}`, 'error'); }
    finally { setBusy(''); }
  };

  return (
    <div className="standard-page extensions-page page-enter">
      <div className="extension-hero">
        <div className="extension-orbit orbit-one" /><div className="extension-orbit orbit-two" />
        <span className="extension-hero-icon"><WandSparkles size={26} /></span>
        <div><span className="page-kicker">POWERED BY YOUR SOURCES</span><h1>Make PRAHA your own.</h1><p>Connect the tools you already love. One calm, beautiful home for every catalog and stream.</p></div>
        <div className="compatibility-badges"><span><Blocks size={16} /> Stremio compatible</span><span><Zap size={16} /> Nuvio compatible</span>{onOpenAddonBrowser && <button className="compatibility-badge-button" onClick={onOpenAddonBrowser}><Store size={16} /> Browse addon directory</button>}</div>
      </div>

      <div className="extension-stats">
        <div><span className="stat-icon lime"><Plug size={19} /></span><p>Active sources<strong>{activeAddons + activeRepos}</strong></p><small>Ready when you are</small></div>
        <div><span className="stat-icon violet"><Cloud size={19} /></span><p>Available catalogs<strong>{catalogs}</strong></p><small>Across installed addons</small></div>
        <div><span className="stat-icon blue"><Zap size={19} /></span><p>Nuvio providers<strong>{providers}</strong></p><small>Individual scrapers</small></div>
      </div>

      <div className="extension-tabs">
        <button className={tab === 'stremio' ? 'active' : ''} onClick={() => { setTab('stremio'); setInstallError(''); }}><Blocks size={18} /><span>Stremio addons<small>Catalogs, metadata & streams</small></span><b>{addons.length}</b></button>
        <button className={tab === 'nuvio' ? 'active' : ''} onClick={() => { setTab('nuvio'); setInstallError(''); }}><Zap size={18} /><span>Nuvio plugins<small>Repositories & stream providers</small></span><b>{repositories.length}</b></button>
      </div>

      <section className="install-panel">
        <div className="install-panel-title"><span>{tab === 'stremio' ? <Blocks size={20} /> : <Zap size={20} />}</span><div><h2>Add {tab === 'stremio' ? 'a Stremio addon' : 'a Nuvio repository'}</h2><p>{tab === 'stremio'
          ? 'Paste a manifest URL or stremio:// link — or browse the community directory.'
          : 'Paste the repository URL. PRAHA will fetch its manifest and scraper files.'}</p></div></div>
        <form onSubmit={install} className="install-form">
          <div><Search size={17} /><input value={installUrl} onChange={(event) => { setInstallUrl(event.target.value); setInstallError(''); }} placeholder={tab === 'stremio' ? 'https://addon.example/manifest.json' : 'https://github.com/user/nuvio-repository'} aria-label="Extension URL" /></div>
          <button className="button button-primary" disabled={installing}>{installing ? <RefreshCw size={17} className="spin" /> : <Plug size={17} />}{installing ? 'Installing…' : 'Install'}</button>
          {tab === 'stremio' && onOpenAddonBrowser && <button type="button" className="button button-secondary" onClick={onOpenAddonBrowser}><Store size={17} /> Browse</button>}
        </form>
        {installError && <p className="install-error"><CircleAlert size={15} />{installError}</p>}
        <p className="install-hint"><ShieldCheck size={14} /> Only install sources you trust. Browser sources must permit CORS requests.</p>
      </section>

      <div className="installed-heading"><div><h2>Installed {tab === 'stremio' ? 'addons' : 'repositories'}</h2><p>{tab === 'stremio' ? 'Toggle a source to include or pause it across PRAHA.' : 'Control the whole repository or each provider individually.'}</p></div><span>{tab === 'stremio' ? addons.length : repositories.length} total</span></div>

      {tab === 'stremio' && (
        <div className="extension-list">
          {addons.map((addon) => {
            const isExpanded = expanded === addon.manifestUrl;
            return (
              <article className={`extension-card ${!addon.enabled ? 'disabled' : ''}`} key={addon.manifestUrl}>
                <div className="extension-card-main">
                  <div className="extension-logo">{addon.manifest.logo ? <img src={addon.manifest.logo} alt="" /> : <Blocks size={24} />}</div>
                  <div className="extension-info"><div className="extension-title"><h3>{addon.manifest.name}</h3><span>v{addon.manifest.version}</span>{addon.enabled && <span className="active-badge"><i />ACTIVE</span>}</div><p>{addon.manifest.description || 'Stremio addon'}</p><div className="resource-badges">{resourceNames(addon).map((resource) => <span key={resource}>{resource}</span>)}{addon.manifest.catalogs.length > 0 && <span>{addon.manifest.catalogs.length} catalogs</span>}</div></div>
                  <div className="extension-actions"><Toggle checked={addon.enabled} onChange={(enabled) => setAddons((current) => current.map((entry) => entry.manifestUrl === addon.manifestUrl ? { ...entry, enabled } : entry))} label={`${addon.enabled ? 'Disable' : 'Enable'} ${addon.manifest.name}`} /><button className="icon-button" onClick={() => refreshAddon(addon)} disabled={busy === addon.manifestUrl} aria-label={`Refresh ${addon.manifest.name}`}><RefreshCw size={17} className={busy === addon.manifestUrl ? 'spin' : ''} /></button><button className="icon-button danger" onClick={() => { setAddons((current) => current.filter((entry) => entry.manifestUrl !== addon.manifestUrl)); notify(`${addon.manifest.name} removed.`); }} aria-label={`Remove ${addon.manifest.name}`}><Trash2 size={17} /></button><button className="icon-button" onClick={() => setExpanded(isExpanded ? null : addon.manifestUrl)} aria-label="Show addon details">{isExpanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></div>
                </div>
                {isExpanded && <div className="extension-details"><span><b>Manifest</b>{addon.manifestUrl}</span><span><b>Addon ID</b>{addon.manifest.id}</span><span><b>Updated</b>{new Date(addon.updatedAt).toLocaleDateString()}</span>{addon.manifest.catalogs.length > 0 && <div>{addon.manifest.catalogs.map((catalog) => <span key={`${catalog.type}-${catalog.id}`}>{catalog.name || catalog.id} · {catalog.type}</span>)}</div>}</div>}
              </article>
            );
          })}
          {!addons.length && <div className="empty-state extension-empty"><span><PackageOpen size={27} /></span><h2>No Stremio addons yet</h2><p>Install a manifest above, or browse the community directory to add catalogs, metadata, subtitles, or streams.</p>{onOpenAddonBrowser && <button className="button button-primary" onClick={onOpenAddonBrowser}><Store size={16} /> Browse addons</button>}</div>}
        </div>
      )}

      {tab === 'nuvio' && (
        <div className="extension-list">
          {repositories.map((repository) => {
            const isExpanded = expanded === repository.manifestUrl || repository.scrapers.length > 0;
            return (
              <article className={`extension-card repository-card ${!repository.enabled ? 'disabled' : ''}`} key={repository.manifestUrl}>
                <div className="extension-card-main">
                  <div className="extension-logo nuvio"><Zap size={24} /></div>
                  <div className="extension-info"><div className="extension-title"><h3>{repository.name}</h3><span>v{repository.version}</span>{repository.enabled && <span className="active-badge"><i />ACTIVE</span>}</div><p>{repository.description || `Nuvio repository by ${repository.author || shortUrl(repository.manifestUrl)}`}</p><div className="resource-badges"><span>{repository.scrapers.length} providers</span><span>{shortUrl(repository.manifestUrl)}</span></div></div>
                  <div className="extension-actions"><Toggle checked={repository.enabled} onChange={(enabled) => setRepositories((current) => current.map((entry) => entry.manifestUrl === repository.manifestUrl ? { ...entry, enabled } : entry))} label={`Toggle ${repository.name}`} /><button className="icon-button" onClick={() => refreshRepository(repository)} disabled={busy === repository.manifestUrl} aria-label={`Refresh ${repository.name}`}><RefreshCw size={17} className={busy === repository.manifestUrl ? 'spin' : ''} /></button><button className="icon-button danger" onClick={() => { setRepositories((current) => current.filter((entry) => entry.manifestUrl !== repository.manifestUrl)); notify(`${repository.name} removed.`); }} aria-label={`Remove ${repository.name}`}><Trash2 size={17} /></button></div>
                </div>
                {isExpanded && <div className="scraper-list">{repository.scrapers.map((scraper) => <div className="scraper-row" key={scraper.id}><span className="scraper-icon"><Zap size={16} /></span><div><strong>{scraper.name}<small>v{scraper.version}</small></strong><p>{scraper.description || scraper.supportedTypes.join(' · ')}{scraper.contentLanguage?.length ? ` · ${scraper.contentLanguage.join(', ').toUpperCase()}` : ''}</p></div><span className={`scraper-status ${scraper.enabled ? '' : 'paused'}`}>{scraper.enabled ? 'Ready' : 'Paused'}</span><button className="test-button" onClick={() => testScraper(scraper, repository.name)} disabled={busy === scraper.id}>{busy === scraper.id ? <RefreshCw size={14} className="spin" /> : <Play size={14} />} Test</button><Toggle checked={scraper.enabled} onChange={(enabled) => setRepositories((current) => current.map((repo) => repo.manifestUrl === repository.manifestUrl ? { ...repo, scrapers: repo.scrapers.map((entry) => entry.id === scraper.id ? { ...entry, enabled: enabled && entry.manifestEnabled } : entry) } : repo))} label={`Toggle ${scraper.name}`} /></div>)}</div>}
              </article>
            );
          })}
          {!repositories.length && <div className="empty-state extension-empty nuvio-empty"><span><PackageOpen size={27} /></span><h2>Your plugin shelf is empty</h2><p>Add a Nuvio repository above. Its providers will appear here with individual controls and a built-in connection test.</p><div className="empty-features"><span><Check size={14} /> Worker isolation</span><span><Check size={14} /> Provider controls</span><span><Check size={14} /> Stream testing</span></div></div>}
        </div>
      )}

      <div className="extension-footer"><div><ShieldCheck size={18} /><p><strong>A note about compatibility</strong>Native plugin runtimes and a web browser have different network rules. Most standard scrapers work, but some sources may need CORS-enabled endpoints. PRAHA resolves streams from your installed Stremio addons and Nuvio plugins.</p></div><a href={tab === 'stremio' ? 'https://github.com/Stremio/stremio-addon-sdk' : 'https://github.com/NuvioMedia/NuvioMobile'} target="_blank" rel="noreferrer">View {tab === 'stremio' ? 'Stremio SDK' : 'Nuvio project'} <ArrowUpRight size={15} /></a></div>
    </div>
  );
};

export default ExtensionsView;
