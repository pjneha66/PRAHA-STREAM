import { useEffect, useState } from 'react';
import { Braces, Search } from 'lucide-react';
import {
  openRuleTitle, ruleScraperBrowse, ruleScraperCatalogs, ruleScraperSearch,
  type RuleMedia, type RuleScraperConfig,
} from '../services/ruleScraper';
import type { MediaItem } from '../types';
import { Artwork } from './MediaCard';

/**
 * Rule sources — the Extensions tab for the JSON-rule scraper. A config is the
 * same JSON Hikari's UniversalScraper accepts (HTML selector rules, or an
 * "api" block); it is pasted once, stored locally, and then browsed like any
 * other source: catalogs → titles → Open sources.
 */

const CONFIGS_KEY = 'praha.ruleScraper.sources.v1';

interface StoredConfig { id: string; name: string; config: RuleScraperConfig }

function loadConfigs(): StoredConfig[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIGS_KEY) || '[]');
    return Array.isArray(raw)
      ? raw.filter((c) => c && typeof c?.id === 'string' && typeof c?.name === 'string' && c?.config && typeof c.config === 'object')
      : [];
  } catch {
    return [];
  }
}

function saveConfigs(configs: StoredConfig[]) {
  try { localStorage.setItem(CONFIGS_KEY, JSON.stringify(configs)); } catch { /* private mode */ }
}

function configId(config: RuleScraperConfig): string {
  const seed = `${config.name}|${config.baseUrl || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return `rule_${Math.abs(hash).toString(36)}`;
}

export default function RuleScraperPanel({ onOpen }: { onOpen: (item: MediaItem) => void }) {
  const [configs, setConfigs] = useState<StoredConfig[]>(loadConfigs);
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState<StoredConfig | null>(null);
  const [catalogs, setCatalogs] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [catalog, setCatalog] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<RuleMedia[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { saveConfigs(configs); }, [configs]);

  async function run(label: string, job: () => Promise<void>) {
    setError('');
    setBusy(label);
    try { await job(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The rule source failed.'); }
    finally { setBusy(''); }
  }

  function addConfig() {
    void run('Validating config…', async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(draft); } catch { throw new Error('The config is not valid JSON.'); }
      const config = parsed as RuleScraperConfig;
      if (!config || typeof config !== 'object' || !config.name) throw new Error('The config needs a "name" field.');
      if (!config.baseUrl && !config.api) throw new Error('The config needs a "baseUrl" or an "api" block.');
      const id = configId(config);
      const next = [...configs.filter((c) => c.id !== id), { id, name: config.name, config }];
      setConfigs(next);
      setActive(next.find((c) => c.id === id) ?? null);
      setDraft('');
    });
  }

  function openConfig(stored: StoredConfig) {
    void run('Loading catalogs…', async () => {
      setActive(stored);
      const rows = await ruleScraperCatalogs(stored.config);
      setCatalogs(rows);
      const first = rows[0]?.id ?? '';
      setCatalog(first);
      setQuery('');
      setItems(first ? await ruleScraperBrowse(stored.config, first) : []);
    });
  }

  function browseCatalog(next: string) {
    if (!active) return;
    void run('Loading catalog…', async () => {
      setCatalog(next);
      setQuery('');
      setItems(await ruleScraperBrowse(active.config, next));
    });
  }

  function search() {
    if (!active) return;
    void run('Searching…', async () => {
      setItems(await ruleScraperSearch(active.config, query.trim()));
    });
  }

  function openTitle(media: RuleMedia) {
    if (!active) return;
    void run('Opening title…', async () => {
      onOpen(await openRuleTitle(active.config, media));
    });
  }

  return <>
    <section className="install-panel">
      <h2><Braces size={20} /> Rule sources</h2>
      <p>JSON-rule scrapers: paste a config (the same rules Hikari's UniversalScraper accepts) and browse it as a source.</p>
      <form className="install-form" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) addConfig(); }}>
        <div><Braces size={16} /><textarea aria-label="Rule source config JSON" placeholder='{"name":"MySite","baseUrl":"https://…","search":{…},"streams":{…}}'
          rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} /></div>
        <button className="button button-primary" disabled={Boolean(busy)}>Add source</button>
      </form>
      {busy && <p role="status">{busy}</p>}
      {error && <p className="install-error" role="alert">{error}</p>}
    </section>

    <div className="directory-grid">
      {configs.map((stored) => <article className="directory-card" key={stored.id}>
        <h3>{stored.name}</h3>
        <p>{stored.config.baseUrl || stored.config.api && 'JSON API'}</p>
        <div className="directory-actions">
          <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void openConfig(stored)}>
            Browse {stored.name}
          </button>
          <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => {
            setConfigs(configs.filter((c) => c.id !== stored.id));
            if (active?.id === stored.id) { setActive(null); setItems([]); setCatalogs([]); }
          }}>Remove</button>
        </div>
      </article>)}
      {!configs.length && <p>No rule sources yet — paste a config above.</p>}
    </div>

    {active && <section className="install-panel">
      <h2>{active.name}</h2>
      <div className="directory-actions">
        {catalogs.length > 0 && <select className="reading-select" aria-label="Rule source catalog" value={catalog}
          disabled={Boolean(busy)} onChange={(event) => browseCatalog(event.target.value)}>
          {catalogs.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>}
      </div>
      <form className="install-form" onSubmit={(event) => { event.preventDefault(); if (query.trim()) search(); }}>
        <div><Search size={16} /><input aria-label="Search rule source" placeholder="Search this source"
          value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <button className="button button-primary" disabled={Boolean(busy)}>Search</button>
      </form>
      {!busy && !items.length && <p>No titles returned.</p>}
    </section>}

    {active && items.length > 0 && <div className="directory-grid">
      {items.map((media) => <article className="directory-card" key={media.id}>
        {media.posterUrl && <div className="source-title-art"><Artwork src={media.posterUrl} alt="" /></div>}
        <h3>{media.title}</h3>
        <div className="directory-actions">
          <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void openTitle(media)}>Open sources</button>
        </div>
      </article>)}
    </div>}
  </>;
}
