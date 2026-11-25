// Finding public plugin repositories on the code hosts.
//
// VyseTV builds its index once a day on its own server, which is why its app only
// downloads one small file (`plugin_index.dart`). PRAHA has no server, so the same
// job is done here: search the public code hosts for repositories that look like
// plugin repositories, then read each one's file and keep the ones that really
// parse — the same check `loadPluginRepo` makes when a link is pasted.
//
// Three things shape this file:
//
//   * A repository search, not a file search. GitHub's `/search/code` answers 401
//     to anyone who is not signed in, so it can never work in an app; its
//     `/search/repositories` is open, and a repository worth listing has its
//     manifest at a predictable path, which is cheaper to probe than to find.
//   * Every request goes through `pluginFetch`, so the host guard runs before each
//     address is opened (a public search result cannot redirect this device at its
//     own network).
//   * A candidate only becomes a listing if its file parses as a repository, so a
//     random `manifest.json` never reaches the browser and then fails Install.
//
// The hosts rate-limit anonymous searches hard (GitHub: ten a minute), so the
// query list is short and each host is asked once per refresh; `pluginIndex.ts`
// caches the result, which is what the page shows.

import { pluginFetch } from './pluginTransport';
import { parsePluginRepo, type PluginRepo } from './jsPlugins';

/** One repository discovery found, in the index's own shape. */
export interface PluginIndexEntry {
  url: string;
  name: string;
  kind: string;
  author: string;
  description: string;
  plugins: number;
  names: string[];
  languages: string[];
  types: string[];
  updated?: string;
  stars: number;
  icon?: string;
  adult: boolean;
}

/**
 * Where a repository's file sits inside its own repository, in the order it is
 * looked for. These are the names the three shapes are published under: a
 * `repo.json`, a scraper list and a Vega manifest are all called one of these.
 */
const MANIFEST_PATHS = ['repo.json', 'plugins.json', 'manifest.json', 'plugin.json'] as const;

/**
 * What is searched for, and why each is there:
 *
 *   * `vyse plugins` / `vysetv` — repositories written for VyseTV itself;
 *   * `scraper plugins` — scraper lists for the same contract;
 *   * `vega providers` — Vega provider manifests;
 *   * `stremio scraper plugin` — the community's own plugin repositories.
 */
const SEARCHES = ['vyse plugins', 'vysetv', 'scraper plugins', 'vega providers', 'stremio scraper plugin'];

/** How many repositories are read per refresh, and how many of those run at once. */
const MAX_CANDIDATES = 20;
const AT_ONCE = 4;

/** A search hit: a repository, before it is known to hold a plugin file. */
interface Candidate {
  /** "owner/name" on GitHub, "group/project" on GitLab. */
  slug: string;
  /** The address of a file in it, given a path. */
  fileAt: (path: string) => string;
  stars: number;
  updated?: string;
  description: string;
  /** The repository's page — the human-recognisable address, for display only. */
  page: string;
}

/**
 * An address on a host, with its path assembled from already-split segments.
 *
 * Every segment comes from a code host's own JSON — a repository name, a branch, a
 * file path — so it is somebody else's text. `URL` and `encodeURIComponent` are
 * what keep a name containing `/`, `?` or `..` from changing which address is
 * opened: each can only ever be one segment of that path.
 */
function address(host: string, segments: string[]): string {
  const url = new URL(host);
  url.pathname = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return url.toString();
}

/** An address on a host whose query is set key by key, never spliced in. */
function queryAddress(host: string, params: Record<string, string>): string {
  const url = new URL(host);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Reads a host's JSON answer; null on any failure (a rate limit is not an error here). */
async function readJson(url: string): Promise<any> {
  try {
    const answer = await pluginFetch(url, {
      timeout: 20000,
      headers: { Accept: 'application/json', 'User-Agent': 'PRAHA-Stream (plugin discovery)' },
    });
    if (answer.status < 200 || answer.status >= 300) return null;
    return JSON.parse(answer.text);
  } catch {
    // Not signed in, rate-limited, offline: the other host still gets its turn.
    return null;
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

/** Repositories matching one query on GitHub. */
export async function searchGitHub(query: string): Promise<Candidate[]> {
  const url = queryAddress('https://api.github.com/search/repositories', {
    q: [query, 'in:name,description,readme'].join(' '),
    sort: 'stars',
    per_page: '20',
  });
  const hits = await readJson(url);
  const items = Array.isArray(hits?.items) ? hits.items : [];
  const out: Candidate[] = [];
  for (const item of items as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const fullName = typeof record.full_name === 'string' ? record.full_name : '';
    const parts = fullName.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    // `HEAD` resolves to the default branch; the named branch is used when the API
    // gave one, since it is what the repository actually is.
    const branch = typeof record.default_branch === 'string' && record.default_branch ? record.default_branch : 'HEAD';
    out.push({
      slug: fullName,
      fileAt: (file: string) => address('https://raw.githubusercontent.com', [...parts, branch, file]),
      stars: typeof record.stargazers_count === 'number' ? record.stargazers_count : 0,
      updated: isoOrUndefined(record.pushed_at) ?? isoOrUndefined(record.updated_at),
      description: typeof record.description === 'string' ? record.description : '',
      page: address('https://github.com', parts),
    });
  }
  return out;
}

/** Projects matching one query on GitLab. */
export async function searchGitLab(query: string): Promise<Candidate[]> {
  const url = queryAddress('https://gitlab.com/api/v4/projects', {
    search: query,
    order_by: 'star_count',
    per_page: '20',
  });
  const hits = await readJson(url);
  const items = Array.isArray(hits) ? hits : [];
  const out: Candidate[] = [];
  for (const item of items as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path_with_namespace === 'string' ? record.path_with_namespace : '';
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    const branch = typeof record.default_branch === 'string' && record.default_branch ? record.default_branch : 'main';
    out.push({
      slug: path,
      // GitLab's file route: `/group/project/-/raw/<branch>/<file>`.
      fileAt: (file: string) => address('https://gitlab.com', [...parts, '-', 'raw', branch, file]),
      stars: typeof record.star_count === 'number' ? record.star_count : 0,
      updated: isoOrUndefined(record.last_activity_at),
      description: typeof record.description === 'string' ? record.description : '',
      page: address('https://gitlab.com', parts),
    });
  }
  return out;
}

/**
 * Language codes a repository's own words name.
 *
 * The published index has real language tags from whoever curated it; a discovered
 * repository only has its name and description, so this reads those. It is a hint
 * for the filter chips, not a claim: a repository that says nothing gets no
 * language, and one that says "Arabic" gets `ar`.
 */
const LANGUAGE_WORDS: [RegExp, string][] = [
  [/\barab(i|ic)\b/i, 'ar'],
  [/\bturk(ish|ey)\b/i, 'tr'],
  [/\bgerman\b|\bdeutsch\b/i, 'de'],
  [/\bhindi\b/i, 'hi'],
  [/\bspanish\b|\bespa[nñ]ol\b/i, 'es'],
  [/\bportugu/i, 'pt'],
  [/\bfrench\b|\bfran[cç]ais\b/i, 'fr'],
  [/\bitalian\b|\bitaliano\b/i, 'it'],
  [/\bjapanese\b/i, 'ja'],
  [/\bkorean\b/i, 'ko'],
  [/\bchinese\b|\bmandarin\b/i, 'zh'],
  [/\brussian\b/i, 'ru'],
  [/\bukrain/i, 'uk'],
  [/\bindonesian\b/i, 'id'],
  [/\bvietnamese\b/i, 'vi'],
  [/\bbengali\b/i, 'bn'],
  [/\btamil\b/i, 'ta'],
  [/\btelugu\b/i, 'te'],
  [/\bmalayalam\b/i, 'ml'],
  [/\bpolish\b/i, 'pl'],
  [/\bthai\b/i, 'th'],
  [/\bpersian\b|\bfarsi\b/i, 'fa'],
  [/\burdu\b/i, 'ur'],
  [/\bdutch\b/i, 'nl'],
  [/\bswedish\b/i, 'sv'],
  [/\bgreek\b/i, 'el'],
  [/\bhebrew\b/i, 'he'],
  [/\bmulti\b|\bworldwide\b/i, 'multi'],
];

function languagesOf(text: string): string[] {
  const out: string[] = [];
  for (const [pattern, code] of LANGUAGE_WORDS) {
    if (pattern.test(text) && !out.includes(code)) out.push(code);
  }
  return out;
}

function pluginLanguages(plugins: PluginRepo['plugins']): string[] {
  const out: string[] = [];
  for (const plugin of plugins) {
    for (const code of languagesOf([plugin.name, plugin.note].join(' '))) {
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

/**
 * A candidate as an index entry, when its file really is a plugin repository.
 *
 * `parsePluginRepo` is the same check an instalment makes, so nothing reaches the
 * browser that Install would then refuse. A Vega manifest is a bare array, a
 * scraper list has `scrapers`, a repo file has `plugins`; all three parse.
 */
export function entryFromRepo(repo: PluginRepo, candidate: Candidate): PluginIndexEntry {
  const plugins = repo.plugins;
  const types = new Set<string>();
  for (const plugin of plugins) for (const type of plugin.types) types.add(type);
  const parts = candidate.slug.split('/').filter(Boolean);
  return {
    // The file's own address, because Install re-reads it as a link: a repository
    // page would only be a page, not a manifest.
    url: repo.url,
    name: repo.name || parts[1] || candidate.slug,
    kind: repo.kind,
    author: parts[0] ?? '',
    description: candidate.description,
    plugins: plugins.length,
    names: plugins.slice(0, 40).map((plugin) => plugin.name),
    // A plugin that declares a language wins; the repository's own words fill the rest.
    languages: pluginLanguages(plugins),
    types: types.size ? Array.from(types) : ['movie', 'tv'],
    updated: candidate.updated,
    stars: candidate.stars,
    adult: false,
  };
}

/**
 * Reads one candidate's manifest, trying the published names in order.
 *
 * The page URL is what the listing shows; the file URL is what `parsePluginRepo`
 * resolves each plugin's script against, so it has to be the file's own address.
 */
async function readCandidate(candidate: Candidate): Promise<PluginIndexEntry | null> {
  const words = languagesOf([candidate.slug, candidate.description].join(' '));
  for (const path of MANIFEST_PATHS) {
    try {
      const url = candidate.fileAt(path);
      const answer = await pluginFetch(url, { timeout: 12000 });
      if (answer.status < 200 || answer.status >= 300) continue;
      const repo = parsePluginRepo(answer.text, url);
      if (!repo.plugins.length) continue;
      const entry = entryFromRepo(repo, candidate);
      return { ...entry, languages: entry.languages.length ? entry.languages : words };
    } catch {
      // Not this name (a 404 is a parse error too): try the next.
      continue;
    }
  }
  return null;
}

/** Every candidate's repositories, read a few at a time, in a stable order. */
async function readAll(candidates: Candidate[]): Promise<PluginIndexEntry[]> {
  const out: PluginIndexEntry[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const candidate = candidates[next++];
      const entry = await readCandidate(candidate);
      if (entry) out.push(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, candidates.length) }, worker));
  return out;
}

/**
 * The public repositories the code hosts know about, from what is found this run.
 *
 * A failed host is not an error: the other one's results still stand, and an empty
 * answer means the cache keeps whatever it had.
 */
export async function discoverPluginRepositories(): Promise<PluginIndexEntry[]> {
  const searches = await Promise.all([
    ...SEARCHES.map((query) => searchGitHub(query).catch(() => [] as Candidate[])),
    ...SEARCHES.slice(0, 2).map((query) => searchGitLab(query).catch(() => [] as Candidate[])),
  ]);
  // One candidate per repository, whichever search found it.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const hit of searches.flat()) {
    const key = hit.slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(hit);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return readAll(candidates);
}

/** The file names a repository is published as, for callers that need the list. */
export const pluginRepositoryFiles = MANIFEST_PATHS;
