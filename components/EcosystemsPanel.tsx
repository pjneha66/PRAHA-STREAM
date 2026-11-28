// The Extensions tab's ecosystem panel: the Sora, SkyStream, Zangetsu and
// AnymeX ecosystems' repository lists, with one-tap install per entry — the
// same shape the 1-Click Directory uses, because that is the flow that fits a
// long listing best. Each install validates the extension the way its
// reference app does (a probe run in the sandbox) before it lands in the
// store, so a broken module is refused with its own error, not stored to fail
// later.

import React, { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, Plug, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import {
  DEFAULT_ECOSYSTEM_REPOS,
  ecosystemExtensions,
  installEcosystemExtensions,
  removeEcosystemExtension,
  setEcosystemEnabled,
  type EcosystemExtension,
  type EcosystemRepo,
} from '../services/ecosystems/store';
import { fetchEcosystemScript } from '../services/ecosystems/scripts';
import {
  installSoraModule, parseSoraManifest, parseSoraRepo, soraModuleKind, saveSoraSetting,
  soraSettingsSchema, validateSora,
  type SoraRepoEntry, type SoraSettingField,
} from '../services/ecosystems/sora';
import {
  installSkyStreamPackage, parseSkyStreamRepo, unpackSkyArchive, validateSkyStream,
  type SkyStreamRepoEntry,
} from '../services/ecosystems/skystream';
import {
  installZangetsuEntries, parseZangetsuRepo, validateZangetsu, type ZangetsuRepoEntry,
} from '../services/ecosystems/zangetsu';
import {
  installAnymexEntries, inspectAnymex, parseAnymexRepo, type AnymexRepoEntry,
} from '../services/ecosystems/anymex';
import { pluginFetch } from '../services/pluginTransport';
import './novels-view.css';

/** One listing entry, normalised across the four ecosystems. */
interface EcoListing {
  key: string;
  name: string;
  description: string;
  install: () => Promise<void>;
}

const ECOSYSTEM_LABELS: Record<string, string> = {
  sora: 'Sora',
  skystream: 'SkyStream',
  zangetsu: 'Zangetsu',
  anymex: 'AnymeX',
};

async function fetchText(url: string): Promise<string> {
  const answer = await pluginFetch(url, { timeout: 20000 });
  if (answer.status === 0) throw new Error(answer.error || `Could not download ${url}.`);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`The server answered ${answer.status}: ${url}`);
  }
  return answer.text;
}

const EcosystemsPanel: React.FC<{ notify: (message: string) => void }> = ({ notify }) => {
  const [installed, setInstalled] = useState<EcosystemExtension[]>([]);
  const [repoUrl, setRepoUrl] = useState('');
  const [activeRepo, setActiveRepo] = useState<EcosystemRepo | null>(null);
  const [listings, setListings] = useState<EcoListing[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = () => setInstalled(ecosystemExtensions('sora')
    .concat(ecosystemExtensions('skystream'), ecosystemExtensions('zangetsu'), ecosystemExtensions('anymex')));

  useEffect(() => {
    refresh();
    window.addEventListener('praha:ecosystems-changed', refresh);
    return () => window.removeEventListener('praha:ecosystems-changed', refresh);
  }, []);

  const perEcosystem = useMemo(() => {
    const groups: Record<string, EcosystemExtension[]> = { sora: [], skystream: [], zangetsu: [], anymex: [] };
    for (const entry of installed) groups[entry.ecosystem]?.push(entry);
    return groups;
  }, [installed]);

  const loadRepo = async (repo: EcosystemRepo) => {
    setLoadingList(true);
    setListError('');
    setActiveRepo(repo);
    setListings([]);
    try {
      const text = await fetchText(repo.url);
      // Each ecosystem's own parser; whatever it lists becomes install cards.
      if (repo.url.includes('skystream') || repo.url.endsWith('repo.json')) {
        const entries = parseSkyStreamRepo(text, repo.url);
        setListings(entries.map((entry: SkyStreamRepoEntry) => ({
          key: `skystream:${entry.id}`,
          name: entry.name,
          description: entry.description || 'SkyStream plugin',
          install: async () => {
            const answer = await pluginFetch(entry.url, { timeout: 30000 });
            if (answer.status !== 200) throw new Error(`Could not download the .sky package (${answer.status}).`);
            const { script, manifest } = await unpackSkyArchive(new TextEncoder().encode(answer.text).buffer as ArrayBuffer);
            void script;
            const entries = installSkyStreamPackage(manifest, entry.url, repo.url, false);
            const [installedEntry] = entries;
            const check = await validateSkyStream(installedEntry);
            if (!check.ok) {
              throw new Error(`Not a valid SkyStream extension: ${check.error}`);
            }
            installEcosystemExtensions(entries);
          },
        })));
        return;
      }
      try {
        // Sora: an index of module manifests, or one bare manifest.
        const entries = parseSoraRepo(text, repo.url);
        setListings(entries.map((entry: SoraRepoEntry) => ({
          key: `sora-manifest:${entry.manifestUrl}`,
          name: entry.name,
          description: entry.description,
          install: async () => {
            const manifestText = await fetchText(entry.manifestUrl);
            const manifest = parseSoraManifest(manifestText);
            const kind = soraModuleKind(manifest.type);
            if (!kind) {
              throw new Error(`"${manifest.sourceName}" is not a Sora module (type "${manifest.type}")`);
            }
            const extension = installSoraModule({ ...manifest, nsfw: manifest.nsfw || entry.nsfw }, manifest.scriptUrl, entry.manifestUrl, false);
            const check = await validateSora(extension, kind);
            if (!check.ok) {
              throw new Error(`Not a valid Sora module: ${check.error}`);
            }
            installEcosystemExtensions([extension]);
          },
        })));
        return;
      } catch (soraError) {
        // Not a Sora repo — fall through to the other ecosystems' parsers.
        void soraError;
      }
      try {
        const entries = parseZangetsuRepo(text, repo.url);
        setListings(entries.map((entry: ZangetsuRepoEntry) => ({
          key: `zangetsu:${entry.id}`,
          name: entry.name,
          description: entry.type ? `${entry.type}${entry.lang ? ` · ${entry.lang}` : ''}` : 'Zangetsu provider',
          install: async () => {
            const [installedEntry] = installZangetsuEntries([entry], repo.url, false);
            const check = await validateZangetsu(installedEntry);
            if (!check.ok) {
              throw new Error(`Not a valid Zangetsu provider: ${check.error}`);
            }
            installEcosystemExtensions([installedEntry]);
          },
        })));
        return;
      } catch (zangetsuError) {
        void zangetsuError;
      }
      const entries = parseAnymexRepo(text, repo.url);
      setListings(entries.map((entry: AnymexRepoEntry) => ({
        key: `anymex${entry.isManga ? 'm' : ''}:${entry.id}`,
        name: entry.name,
        description: `${entry.isManga ? 'Manga' : 'Anime'}${entry.lang ? ` · ${entry.lang}` : ''}`,
        install: async () => {
          // The Dart-only refusal needs the manifest entry, and the script must
          // carry the two names the harness bootstraps.
          const script = await fetchEcosystemScript(entry.url);
          if (!script.includes('DefaultExtension') || !script.includes('MProvider')) {
            throw new Error('This extension is Dart-only and needs the Mangayomi app — PRAHA runs JavaScript Anymex modules only.');
          }
          const [installedEntry] = installAnymexEntries([entry], repo.url, false);
          const probe = await inspectAnymex(installedEntry);
          if (!probe.ok) {
            throw new Error(`Not a valid AnymeX extension: ${probe.error}`);
          }
          installEcosystemExtensions([installedEntry]);
        },
      })));
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'That repository could not be read.');
    } finally {
      setLoadingList(false);
    }
  };

  const install = async (listing: EcoListing) => {
    setBusy(listing.key);
    try {
      await listing.install();
      notify(`${listing.name} installed.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The install failed.');
    } finally {
      setBusy('');
      refresh();
    }
  };

  const isInstalled = (key: string): boolean => installed.some((entry) =>
    entry.key === key || (entry.ecosystem === 'sora' && `sora-manifest:${entry.sourceUrl}` === key));

  // ── a Sora module's settings, edited the way Hikari's dialog renders them ──
  const [settingsFor, setSettingsFor] = useState<EcosystemExtension | null>(null);
  const [settingsFields, setSettingsFields] = useState<SoraSettingField[]>([]);
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string | boolean | string[]>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);

  const openSettings = async (extension: EcosystemExtension) => {
    setSettingsFor(extension);
    setSettingsFields([]);
    setSettingsLoading(true);
    try {
      const fields = await soraSettingsSchema(extension);
      setSettingsFields(fields);
      setSettingsDraft(Object.fromEntries(fields.map((field) => [field.key, field.value ?? (field.type === 'switch' ? false : field.type === 'multi_select' ? [] : '')])));
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = () => {
    if (!settingsFor) return;
    for (const field of settingsFields) {
      const value = settingsDraft[field.key];
      if (value === undefined) continue;
      saveSoraSetting(settingsFor, field, value);
    }
    notify(`${settingsFor.name} settings saved.`);
    setSettingsFor(null);
  };

  return (
    <>
      <section className="install-panel">
        <div className="install-panel-title"><span>◈</span><div>
          <h2>Extension ecosystems</h2>
          <p>Sora, SkyStream, Zangetsu and AnymeX repositories. Each install is validated in the sandbox before it is stored, and only reaches public addresses.</p>
        </div></div>
        <div className="directory-grid" style={{ marginTop: 12 }}>
          {Object.entries(DEFAULT_ECOSYSTEM_REPOS).flatMap(([ecosystem, repos]) =>
            repos.map((repo) => (
              <article className="directory-card" key={repo.url}>
                <div className="directory-card-head"><span className="directory-cat">{ECOSYSTEM_LABELS[ecosystem] ?? ecosystem}</span></div>
                <h3>{repo.name}</h3>
                <p>{repo.description}</p>
                <div className="directory-actions">
                  <button className={`button button-small ${activeRepo?.url === repo.url ? 'button-secondary' : 'button-primary'}`}
                    disabled={loadingList} onClick={() => void loadRepo(repo)}>
                    {loadingList && activeRepo?.url === repo.url ? <><RefreshCw size={14} className="spin" /> Loading…</> : <><Search size={14} /> Load list</>}
                  </button>
                </div>
              </article>
            )))}
        </div>
        <form className="install-form" style={{ marginTop: 12 }} onSubmit={(event) => {
          event.preventDefault();
          const url = repoUrl.trim();
          if (!url) return;
          void loadRepo({ url, name: url, description: '' });
        }}>
          <div><Search size={17} /><input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="Paste any Sora / SkyStream / Zangetsu / AnymeX repository URL" aria-label="Ecosystem repository URL" /></div>
          <button className="button button-primary" disabled={loadingList}>{loadingList ? <RefreshCw size={17} className="spin" /> : <Search size={17} />}{loadingList ? 'Loading…' : 'Load list'}</button>
        </form>
        {listError && <p className="install-error"><CircleAlert size={15} />{listError}</p>}
      </section>

      {listings.length > 0 && (
        <div className="installed-heading">
          <div><h2>{activeRepo?.name ?? 'Repository'} listing</h2><p>One tap installs and validates the extension.</p></div>
          <span>{listings.length} available</span>
        </div>
      )}
      {listings.length > 0 && (
        <div className="directory-grid">
          {listings.map((listing) => {
            const done = isInstalled(listing.key);
            return (
              <article className="directory-card" key={listing.key}>
                <h3>{listing.name}</h3>
                <p>{listing.description}</p>
                <div className="directory-actions">
                  <button className={`button button-small ${done ? 'button-secondary' : 'button-primary'}`}
                    disabled={done || busy === listing.key} onClick={() => void install(listing)}>
                    {done ? <><Check size={14} /> Installed</>
                      : busy === listing.key ? <><RefreshCw size={14} className="spin" /> Installing…</>
                        : <><Plug size={14} /> Install</>}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {(['sora', 'skystream', 'zangetsu', 'anymex'] as const).map((ecosystem) => perEcosystem[ecosystem].length ? (
        <div key={ecosystem}>
          <div className="installed-heading">
            <div><h2>Installed {ECOSYSTEM_LABELS[ecosystem] ?? ecosystem} extensions</h2><p>Toggle or remove; disabling keeps it listed but never asked.</p></div>
            <span>{perEcosystem[ecosystem].length} total</span>
          </div>
          <div className="extension-list">
            {perEcosystem[ecosystem].map((entry) => (
              <article className={`extension-card ${!entry.enabled ? 'disabled' : ''}`} key={entry.key}>
                <div className="extension-card-main">
                  <div className="extension-logo">{entry.logo ? <img src={entry.logo} alt="" /> : '◈'}</div>
                  <div className="extension-info">
                    <div className="extension-title">
                      <h3>{entry.name}</h3>
                      {entry.enabled && <span className="active-badge"><i />ACTIVE</span>}
                    </div>
                    <p>{entry.kind} · {entry.lang}{entry.version ? ` · v${entry.version}` : ''}</p>
                  </div>
                  <div className="extension-actions">
                    {entry.ecosystem === 'sora' && (
                      <button className="icon-button" onClick={() => void openSettings(entry)}
                        aria-label="Module settings"><Settings2 size={15} /></button>
                    )}
                    <button className="icon-button" onClick={() => { setEcosystemEnabled(entry.key, !entry.enabled); refresh(); }}
                      aria-label={entry.enabled ? 'Disable extension' : 'Enable extension'}>
                      {entry.enabled ? <Check size={15} /> : <Plug size={15} />}
                    </button>
                    <button className="icon-button" onClick={() => { removeEcosystemExtension(entry.key); refresh(); }}
                      aria-label="Remove extension"><Trash2 size={15} /></button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null)}

      {settingsFor && (
        <div className="novel-dialog" role="dialog" aria-modal="true" aria-label={`${settingsFor.name} settings`}>
          <header>
            <h2>{settingsFor.name} settings</h2>
            <button type="button" className="icon-button" onClick={() => setSettingsFor(null)} aria-label="Close settings"><X size={18} /></button>
          </header>
          {settingsLoading ? <p role="status">Reading the module's settings…</p>
            : !settingsFields.length ? <p>This module has no settings of its own.</p>
              : <div style={{ display: 'grid', gap: 12, padding: 16 }}>
                {settingsFields.map((field) => (
                  <label key={field.key} style={{ display: 'grid', gap: 4 }}>
                    <strong>{field.title}</strong>
                    {field.summary && <small>{field.summary}</small>}
                    {field.type === 'switch' && (
                      <input type="checkbox" checked={field.value === true}
                        onChange={(event) => setSettingsDraft((current) => ({ ...current, [field.key]: event.target.checked }))} />
                    )}
                    {field.type === 'edit_text' && (
                      <input type="text" value={String(settingsDraft[field.key] ?? '')}
                        onChange={(event) => setSettingsDraft((current) => ({ ...current, [field.key]: event.target.value }))} />
                    )}
                    {field.type === 'list' && (
                      <select value={String(settingsDraft[field.key] ?? '')}
                        onChange={(event) => setSettingsDraft((current) => ({ ...current, [field.key]: event.target.value }))}>
                        {field.entries.map((label, index) => (
                          <option key={field.entryValues[index] ?? label} value={field.entryValues[index] ?? label}>{label}</option>
                        ))}
                      </select>
                    )}
                    {field.type === 'multi_select' && (
                      <span style={{ display: 'grid', gap: 4 }}>
                        {field.entries.map((label, index) => {
                          const option = field.entryValues[index] ?? label;
                          const selected = Array.isArray(settingsDraft[field.key]) && (settingsDraft[field.key] as string[]).includes(option);
                          return (
                            <label key={option} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <input type="checkbox" checked={selected}
                                onChange={(event) => setSettingsDraft((current) => {
                                  const list = Array.isArray(current[field.key]) ? [...(current[field.key] as string[])] : [];
                                  return { ...current, [field.key]: event.target.checked ? [...new Set([...list, option])] : list.filter((entry) => entry !== option) };
                                })} />
                              {label}
                            </label>
                          );
                        })}
                      </span>
                    )}
                  </label>
                ))}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="button button-primary" onClick={saveSettings}>Save</button>
                  <button type="button" className="button button-secondary" onClick={() => setSettingsFor(null)}>Cancel</button>
                </div>
              </div>}
        </div>
      )}
    </>
  );
};

export default EcosystemsPanel;
