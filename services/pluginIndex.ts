// The plugin index: public repositories of JS plugins, to search and install
// with one press — VyseTV's "Find plugins" (Settings > Addons).
//
// A direct port of `lib/data/sources/plugins/plugin_index.dart` and the list
// half of `lib/screens/profile/plugin_index_page.dart` (GPL-3.0-or-later).
//
// One difference, forced by what PRAHA has: VyseTV builds its index once a day
// on its own server, so a device downloads a single small file. PRAHA has no
// such server, so the index comes from one of two places:
//
//   * a prebuilt index at `PLUGIN_INDEX_URL`, if one is ever published — the
//     same `{updated, repos}` shape, read exactly as upstream reads it; and
//   * this device's own discovery (`pluginDiscovery.ts`), which asks the public
//     code hosts for repositories and reads each one's manifest — the same job
//     VyseTV's server does, done on the device and cached here.
//
// Both land in one list, so the browser does not care where an entry came from.

import { pluginFetch } from './pluginTransport';
import type { PluginIndexEntry as DiscoveredEntry } from './pluginDiscovery';

/** How long a downloaded index is fresh before it is asked for again. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/** Where a published index would live. Empty: this build has none, so discovery is used. */
const PLUGIN_INDEX_URL = '';

/** This device's copy, kept across starts (VyseTV's `plugin_index.json`). */
const STORAGE_KEY = 'praha.v2.plugin-index';

/** A repository in the index. */
export interface PluginListing {
  /** Its link: what Install adds, exactly as pasting it in Addons does. */
  url: string;
  name: string;
  /** `scrapers` (a scraper list), `vega` (Vega providers) or `plugins` (a repo.json). */
  kind: string;
  author: string;
  description: string;
  /** How many plugins it has turned on. */
  plugins: number;
  /** Their names (the first forty). */
  names: string[];
  /** The languages its plugins say they are in (`en`, `tr`…). */
  languages: string[];
  /** `movie` and/or `tv`. */
  types: string[];
  /** When its repository last changed, as an ISO string. */
  updated?: string;
  stars: number;
  icon?: string;
  /** Hand-picked: shown first, with its description. */
  featured: boolean;
  /** For adults: shown only with adult content allowed. */
  adult: boolean;
}

/** The index as last read: when it was built, and its repositories. */
export interface PluginIndexData {
  built?: string;
  repos: PluginListing[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => String(entry)) : []);

/**
 * One entry of an index, or null when it cannot be one.
 *
 * Ported field for field: a missing name becomes the link's repository name, a
 * missing kind `scrapers`, a missing types list `['movie', 'tv']`, and an icon
 * that is not https is dropped (a plugin index must not be able to make the app
 * load a `file:` or `data:` picture).
 */
export function parseListing(value: unknown): PluginListing | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url) return null;
  const rawIcon = record.icon == null ? '' : String(record.icon);
  const types = strings(record.types);
  const trimmedName = record.name == null ? '' : String(record.name).trim();
  const rawKind = record.kind == null ? 'scrapers' : String(record.kind);
  return {
    url: record.url,
    name: trimmedName || repoName(record.url),
    // The engine calls a `repo.json` a `repo`; the index calls it `plugins`. A
    // published index written in the engine's words still filters correctly.
    kind: rawKind === 'repo' ? 'plugins' : rawKind,
    author: record.author == null ? '' : String(record.author),
    description: record.description == null ? '' : String(record.description),
    plugins: typeof record.plugins === 'number' ? Math.trunc(record.plugins) : 0,
    names: strings(record.names),
    languages: strings(record.languages),
    types: types.length ? types : ['movie', 'tv'],
    updated: isoOrUndefined(record.updated),
    stars: typeof record.stars === 'number' ? Math.trunc(record.stars) : 0,
    icon: rawIcon.startsWith('https://') ? rawIcon : undefined,
    featured: record.featured === true,
    adult: record.adult === true,
  };
}

/** A link's repository name: its second path segment ("owner/name" → "name"). */
function repoName(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[1] || 'Plugins';
  } catch {
    return 'Plugins';
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  if (!text) return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

/** An index from its JSON text. Throws when it is not one. */
export function parseIndex(text: string): PluginIndexData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That is not a plugin index.');
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  if (!record || !Array.isArray(record.repos)) throw new Error('That is not a plugin index.');
  const repos: PluginListing[] = [];
  for (const entry of record.repos) {
    const listing = parseListing(entry);
    if (listing) repos.push(listing);
  }
  return { built: isoOrUndefined(record.updated), repos };
}

/**
 * Whether `listing` matches `query`: its name, author, description or one of its
 * plugins' names, in any case. Empty matches everything.
 */
export function listingMatches(listing: PluginListing, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    listing.name.toLowerCase().includes(q) ||
    listing.author.toLowerCase().includes(q) ||
    listing.description.toLowerCase().includes(q) ||
    listing.names.some((name) => name.toLowerCase().includes(q))
  );
}

/**
 * A language's name for its code ('tr' → Turkish); the code itself when unknown.
 * The table is VyseTV's, which is why the odd three-letter spellings are there.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ar: 'Arabic', tr: 'Turkish', es: 'Spanish', pt: 'Portuguese', 'pt-br': 'Portuguese (BR)', hi: 'Hindi',
  fr: 'French', de: 'German', it: 'Italian', ita: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
  uk: 'Ukrainian', id: 'Indonesian', vi: 'Vietnamese', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  mal: 'Malayalam', kn: 'Kannada', hu: 'Hungarian', pl: 'Polish', th: 'Thai', fa: 'Persian', ur: 'Urdu', ro: 'Romanian',
  cs: 'Czech', sr: 'Serbian', hr: 'Croatian', bs: 'Bosnian', el: 'Greek', he: 'Hebrew', nl: 'Dutch', sv: 'Swedish',
  mn: 'Mongolian', ku: 'Kurdish', pa: 'Punjabi', et: 'Estonian', tl: 'Filipino', ms: 'Malay', multi: 'Many languages',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

/** "today", "3 days ago", "2 months ago". Empty for no date. */
export function ago(date: string | undefined): string {
  if (!date) return '';
  const when = Date.parse(date);
  if (Number.isNaN(when)) return '';
  const days = Math.floor((Date.now() - when) / 86400000);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months < 18 ? `${months} months ago` : `${Math.round(days / 365)} years ago`;
}

// ── the index on this device ──

let memory: PluginIndexData | null = null;
let fetchedAt = 0;
let loading: Promise<PluginIndexData> | null = null;

/** Test seam: forget the copy in memory. */
export function resetPluginIndex(): void {
  memory = null;
  fetchedAt = 0;
  loading = null;
}

/** This device's copy, at once and with no download (null when there is none). */
export function keptIndex(): PluginIndexData | null {
  if (memory) return memory;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return (memory = parseIndex(raw));
  } catch {
    return null;
  }
}

function store(data: PluginIndexData): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // A full or disabled store costs the offline copy, never the index.
  }
}

/** Reads a published index, or null when this build has none to read. */
async function fetchPublished(): Promise<PluginIndexData | null> {
  if (!PLUGIN_INDEX_URL) return null;
  try {
    const answer = await pluginFetch(PLUGIN_INDEX_URL, { timeout: 20000, headers: { Accept: 'application/json' } });
    if (answer.status === 0 || answer.status < 200 || answer.status >= 300) return null;
    return parseIndex(answer.text);
  } catch {
    return null;
  }
}

/** Puts a listing in the index's shape from what discovery found. */
function fromDiscovered(entry: DiscoveredEntry): PluginListing {
  return {
    url: entry.url,
    name: entry.name,
    // Discovery says `repo` (the engine's word for a `repo.json`); the index says
    // `plugins`. One vocabulary for the browser, whichever found the entry.
    kind: entry.kind === 'repo' ? 'plugins' : entry.kind,
    author: entry.author,
    description: entry.description,
    plugins: entry.plugins,
    names: entry.names,
    languages: entry.languages,
    types: entry.types,
    updated: entry.updated,
    stars: entry.stars,
    icon: entry.icon,
    featured: false,
    adult: entry.adult,
  };
}

/**
 * The index: this device's copy while it is fresh (a few hours), else read again
 * — from a published index when this build has one, and from discovery; the kept
 * copy when neither answers. Throws a message fit to show when there is nothing.
 *
 * `discover` is passed in rather than imported so this module stays free of the
 * network code, and so a test can stand in for it.
 */
export function loadPluginIndex(
  discover: () => Promise<DiscoveredEntry[]>,
  options: { fresh?: boolean } = {},
): Promise<PluginIndexData> {
  const fresh = options.fresh === true;
  if (!fresh && memory && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve(memory);
  if (loading) return loading;
  loading = (async () => {
    const published = await fetchPublished();
    let found: DiscoveredEntry[] = [];
    try {
      found = await discover();
    } catch {
      // Discovery is the fallback when no index is published; if it also fails
      // the kept copy is still worth showing.
    }
    const merged = mergeListings([
      ...(published?.repos ?? []),
      ...found.map(fromDiscovered),
    ]);
    if (merged.length) {
      const data: PluginIndexData = { built: published?.built, repos: merged };
      memory = data;
      fetchedAt = Date.now();
      store(data);
      return data;
    }
    const copy = keptIndex();
    if (copy) return copy;
    throw new Error("Couldn't load the plugin list. Check your connection and try again.");
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * The same repository however its link is spelled — VyseTV's `_same`: case and a
 * `refs/heads/` segment do not make it a different repository.
 */
export function sameRepository(url: string): string {
  return url.trim().toLowerCase().replaceAll('refs/heads/', '');
}

/**
 * Both lists as one, a published entry winning over a discovered one for the
 * same repository (it was checked by whoever built it), and a repository never
 * appearing twice.
 */
export function mergeListings(listings: PluginListing[]): PluginListing[] {
  const byUrl = new Map<string, PluginListing>();
  for (const listing of listings) {
    const key = sameRepository(listing.url);
    const seen = byUrl.get(key);
    // Keep the one that knows more: the published index carries languages and a
    // description, discovery mostly just the manifest.
    if (!seen || (listing.plugins > seen.plugins)) byUrl.set(key, listing);
  }
  return Array.from(byUrl.values());
}

/** The languages to offer as filters: the most common first, at most `limit`. */
export function topLanguages(repos: PluginListing[], limit = 14): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const listing of repos) {
    for (const code of listing.languages) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, count]) => ({ code, count }));
}
