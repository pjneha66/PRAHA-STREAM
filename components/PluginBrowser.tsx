import React, { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, Package, RefreshCw, Search, Star, X } from 'lucide-react';

import { discoverPluginRepositories } from '../services/pluginDiscovery';
import {
  ago, keptIndex, languageName, listingMatches, loadPluginIndex, sameRepository, topLanguages,
  type PluginIndexData, type PluginListing,
} from '../services/pluginIndex';
import type { PluginRepository } from '../types';

/**
 * "Find plugins": the community's public plugin repositories, one press from
 * installed. A port of VyseTV's `plugin_index_page.dart` (GPL-3.0-or-later).
 *
 * Three controls, exactly as upstream: what kind of repository, how to sort, and
 * which language. The language chips are built from what the index holds rather
 * than a fixed list, so a picker never offers a language nobody publishes in.
 */

/** What a repository is, which is how a user decides whether they want it. */
type Kind = 'all' | 'scrapers' | 'vega' | 'plugins';

const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'scrapers', label: 'Scraper lists' },
  { id: 'vega', label: 'Vega' },
  { id: 'plugins', label: 'Plugin repos' },
];

type Sort = 'best' | 'updated' | 'stars';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'best', label: 'Most plugins' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'stars', label: 'Most starred' },
];

/** A hue of its own per repository, from its name — upstream's fallback icon. */
function hueOf(name: string): number {
  let hash = 7;
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) & 0xffff;
  return hash % 360;
}

const initialOf = (name: string): string => (name ? Array.from(name)[0].toUpperCase() : '?');

interface PluginBrowserProps {
  installed: PluginRepository[];
  /** Reads a repository's link and installs it; the same call pasting a URL makes. */
  onInstall: (url: string) => Promise<void>;
  busyUrl: string;
  /** A message for the card whose install failed. */
  failure: { url: string; message: string } | null;
  /** Whether adult repositories may be shown at all. */
  allowAdult: boolean;
}

const PluginBrowser: React.FC<PluginBrowserProps> = ({ installed, onInstall, busyUrl, failure, allowAdult }) => {
  const [data, setData] = useState<PluginIndexData | null>(() => keptIndex());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [language, setLanguage] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('best');

  const load = async (fresh: boolean) => {
    setLoading(true);
    setError('');
    try {
      const next = await loadPluginIndex(discoverPluginRepositories, { fresh });
      setData(next);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't load the plugin list.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // The kept copy shows at once; the fresh one replaces it when it arrives.
    void load(false);
  }, []);

  const visible = useMemo(() => {
    if (!data) return [] as PluginListing[];
    const list = data.repos.filter((listing) => (
      (allowAdult || !listing.adult) &&
      (kind === 'all' || listing.kind === kind) &&
      (language === null || listing.languages.includes(language)) &&
      listingMatches(listing, query)
    ));
    const byPlugins = (a: PluginListing, b: PluginListing) => b.plugins - a.plugins;
    if (sort === 'updated') {
      list.sort((a, b) => (Date.parse(b.updated ?? '') || 0) - (Date.parse(a.updated ?? '') || 0) || byPlugins(a, b));
    } else if (sort === 'stars') {
      list.sort((a, b) => b.stars - a.stars || byPlugins(a, b));
    } else {
      list.sort((a, b) => (a.featured !== b.featured ? (a.featured ? -1 : 1) : byPlugins(a, b)));
    }
    return list;
  }, [data, kind, language, query, sort, allowAdult]);

  const languages = useMemo(() => (data ? topLanguages(data.repos.filter((listing) => allowAdult || !listing.adult)) : []), [data, allowAdult]);
  const installedKeys = useMemo(() => new Set(installed.map((repo) => sameRepository(repo.url))), [installed]);

  const total = data ? data.repos.filter((listing) => allowAdult || !listing.adult).length : 0;
  const pluginCount = data ? data.repos.filter((listing) => allowAdult || !listing.adult).reduce((sum, listing) => sum + listing.plugins, 0) : 0;

  return (
    <section className="plugin-browser">
      <div className="plugin-browser-head">
        <div>
          <h2>Find plugins</h2>
          <p>
            {data
              ? `${total} repositories with ${pluginCount} plugin${pluginCount === 1 ? '' : 's'} from the community. One press adds one to your list.`
              : 'Repositories of scraper plugins from the community.'}
          </p>
        </div>
        <button className="button button-secondary button-small" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> {loading ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <div className="plugin-browser-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search plugins, sites, languages"
          aria-label="Search plugins"
        />
        {query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Clear search"><X size={15} /></button>}
      </div>

      <div className="plugin-browser-filters">
        {KINDS.map((entry) => (
          <button key={entry.id} className={kind === entry.id ? 'active' : ''} aria-pressed={kind === entry.id} onClick={() => setKind(entry.id)}>{entry.label}</button>
        ))}
        <span className="plugin-browser-sep" />
        {SORTS.map((entry) => (
          <button key={entry.id} className={sort === entry.id ? 'active' : ''} aria-pressed={sort === entry.id} onClick={() => setSort(entry.id)}>{entry.label}</button>
        ))}
      </div>

      {languages.length > 0 && (
        <div className="plugin-browser-filters languages">
          <button className={language === null ? 'active' : ''} aria-pressed={language === null} onClick={() => setLanguage(null)}>Every language</button>
          {languages.map((entry) => (
            <button
              key={entry.code}
              className={language === entry.code ? 'active' : ''}
              aria-pressed={language === entry.code}
              onClick={() => setLanguage(language === entry.code ? null : entry.code)}
            >
              {languageName(entry.code)}<small>{entry.count}</small>
            </button>
          ))}
        </div>
      )}

      {!data && loading && <p className="plugin-browser-note"><RefreshCw size={15} className="spin" /> Reading the community's repositories…</p>}

      {!data && !loading && (
        <p className="plugin-browser-note">
          <CircleAlert size={15} /> {error || "Couldn't load the plugin list."}
          <button className="button button-secondary button-small" onClick={() => void load(true)}>Try again</button>
        </p>
      )}

      {data && !visible.length && (
        <p className="plugin-browser-note">
          Nothing matches. Try other words, or another language.
          <button className="button button-secondary button-small" onClick={() => { setQuery(''); setKind('all'); setLanguage(null); }}>Show all</button>
        </p>
      )}

      <div className="plugin-browser-grid">
        {visible.map((listing) => {
          const installedAlready = installedKeys.has(sameRepository(listing.url));
          const isBusy = busyUrl === listing.url;
          const cardError = failure && failure.url === listing.url ? failure.message : '';
          const hues = hueOf(listing.name);
          const shownLanguages = listing.languages.slice(0, 3).map(languageName).join(' · ');
          const more = listing.languages.length > 3 ? ` +${listing.languages.length - 3}` : '';
          return (
            <article
              className={`plugin-card ${listing.featured ? 'featured' : ''} ${installedAlready ? 'installed' : ''}`}
              key={listing.url}
            >
              <div className="plugin-card-top">
                <span
                  className="plugin-card-icon"
                  style={{ background: `linear-gradient(135deg, hsl(${hues}, 55%, 45%), hsl(${(hues + 40) % 360}, 60%, 30%))` }}
                >
                  {listing.icon
                    ? <img src={listing.icon} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                    : initialOf(listing.name)}
                </span>
                <div className="plugin-card-title">
                  <h3>
                    {listing.name}
                    {listing.featured && <span className="plugin-card-picked" title="Picked">★</span>}
                  </h3>
                  <p>
                    {[listing.author ? `by ${listing.author}` : '', listing.kind === 'vega' ? 'Vega providers' : listing.kind === 'plugins' ? 'Plugin repo' : 'Scraper list']
                      .filter(Boolean).join(' · ')}
                  </p>
                </div>
                {isBusy ? (
                  <span className="plugin-card-action busy"><RefreshCw size={15} className="spin" /></span>
                ) : installedAlready ? (
                  <span className="plugin-card-action done"><Check size={14} /> Installed</span>
                ) : (
                  <button className="plugin-card-action install" disabled={Boolean(busyUrl)} onClick={() => void onInstall(listing.url)}>
                    <Package size={14} /> Install
                  </button>
                )}
              </div>

              <p className={`plugin-card-body ${cardError ? 'error' : ''}`}>
                {cardError || (listing.description || listing.names.slice(0, 8).join(', '))}
              </p>

              <div className="plugin-card-tags">
                <span className="strong">{listing.plugins} plugin{listing.plugins === 1 ? '' : 's'}</span>
                {shownLanguages && <span>{shownLanguages}{more}</span>}
                <span className="spacer" />
                {listing.stars > 0 && <span className="stars"><Star size={12} />{listing.stars}</span>}
                {listing.updated && <span>{ago(listing.updated)}</span>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export default PluginBrowser;
