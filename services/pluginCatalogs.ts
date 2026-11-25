// Plugin repositories that list titles to browse: their catalogs and their titles'
// details, answered the way a Stremio addon answers them — so Home, Discover,
// search and the details pages show them like any metadata addon's.
//
// A direct port of VyseTV's `lib/data/sources/plugins/plugin_catalogs.dart` and
// the `Addon.ofPlugins` half of `lib/data/sources/addons.dart`
// (GPL-3.0-or-later). A plugin's title goes by
// `pl:<repository key>:<plugin id>:<its own id>` and plays from that plugin,
// asked for its own id.
//
// Which plugins' catalogs show is the user's: a scraper list's are on when it is
// added, a Vega provider's off (a repository of them can list hundreds).

import { composePlugin } from './pluginScripts';
import { runPluginEntry, type ComposedPlugin } from './pluginRuntime';
import { readDescribedCatalogs, type PluginCatalog, type PluginEntry, type PluginRepo } from './jsPlugins';
import type { InstalledAddon, MediaItem, PluginRepository, StremioCatalog } from '../types';

// ── which repositories there are ──

/**
 * The repositories this device has installed, kept here so a plugin-backed
 * addon can be answered from anywhere without every caller carrying the list.
 * `App.tsx` keeps it in step with the stored repositories.
 */
let installed: PluginRepository[] = [];

/** Called whenever the installed repositories change. */
export function setInstalledPluginRepositories(list: PluginRepository[]): void {
  installed = list;
}

/** The stored repository at `url`, when this device has it. */
export function storedRepository(url: string): PluginRepository | undefined {
  return installed.find((repo) => repo.url === url);
}

/** The engine's view of a stored repository: its enabled plugins only. */
export function enabledPlugins(stored: PluginRepository): PluginEntry[] {
  return stored.plugins
    .filter((plugin) => plugin.enabled)
    .map(({ enabled: _enabled, ...plugin }) => plugin as PluginEntry);
}

/** The repository at `url` as the engine runs it, when it is installed and on. */
export function engineRepo(url: string): PluginRepo | null {
  const stored = storedRepository(url);
  if (!stored || !stored.enabled) return null;
  return { url: stored.url, name: stored.name, kind: stored.kind, plugins: enabledPlugins(stored) };
}

/**
 * The plugins of `stored` whose catalogs are browsed: the user's pick once made,
 * else VyseTV's default — a scraper list's that list titles, none of a Vega
 * provider's.
 */
export function browsePlugins(stored: PluginRepository): string[] {
  if (stored.browse) return stored.browse;
  return stored.plugins
    .filter((plugin) => plugin.enabled && !plugin.vega && !plugin.comic && (plugin.catalogs?.length ?? 0) > 0)
    .map((plugin) => plugin.id);
}

/**
 * Plugin `pluginId` of `stored` with its catalogs browsed or not — VyseTV's
 * `Addons.setBrowse`.
 *
 * The pick is stored as a whole list rather than a flag per plugin, because
 * "not picked yet" (absent) means something different from "none": the default
 * is decided then, and a user who turns every one off keeps them off.
 */
export function setPluginBrowse(
  stored: PluginRepository,
  pluginId: string,
  on: boolean,
): PluginRepository {
  const current = browsePlugins(stored);
  const next = on
    ? Array.from(new Set([...current, pluginId]))
    : current.filter((id) => id !== pluginId);
  return { ...stored, browse: next, updatedAt: Date.now() };
}

// ── ids ──

/**
 * A short, stable id for a repository's link — VyseTV's `PluginRepos.repoKey`:
 * FNV-1a over the UTF-8 bytes, in base 36. (Not a hash of the JS string: the
 * key has to match what another device computes, and code units would not.)
 */
export function repoKey(url: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(url)) {
    h = Math.imul((h ^ byte) >>> 0, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** What the ids of the repository at `repoUrl`'s titles start with. */
export function prefix(repoUrl: string): string {
  return `pl:${repoKey(repoUrl)}:`;
}

/** A title of `plugin` (its own id `own`) as PRAHA knows it. */
export function wrap(repoUrl: string, plugin: string, own: string): string {
  return `${prefix(repoUrl)}${plugin}:${own}`;
}

/** `id` as its plugin and its own id, when it is one of `repoUrl`'s titles. */
export function unwrap(repoUrl: string | undefined, id: string | null | undefined): { plugin: string; own: string } | null {
  if (!repoUrl || !id) return null;
  const head = prefix(repoUrl);
  if (!id.startsWith(head)) return null;
  const rest = id.slice(head.length);
  const at = rest.indexOf(':');
  if (at <= 0 || at === rest.length - 1) return null;
  return { plugin: rest.slice(0, at), own: rest.slice(at + 1) };
}

/** A plugin's name as a heading: "!HDFilmCehennemi" (a sorting trick) is "HDFilmCehennemi". */
export function plainName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// ── catalogs as the addon lists them ──

/**
 * `c`, one of plugin `p`'s catalogs, as one of its repository's addon catalogs:
 * its id `<plugin>/<catalog>`, its name led by the plugin's.
 *
 * The flags a Stremio catalog cannot hold (a genre is required, it only answers
 * a search) go into `extra`, which is what the app's catalog UI already reads.
 */
export function addonCatalog(p: PluginEntry, c: PluginCatalog): StremioCatalog {
  const extra: NonNullable<StremioCatalog['extra']> = [];
  if (c.search) extra.push({ name: 'search', isRequired: c.searchOnly === true });
  if (c.genres?.length) {
    extra.push({ name: 'genre', isRequired: c.genreRequired === true, options: c.genres });
  }
  return {
    type: c.type,
    id: `${p.id}/${c.id}`,
    name: `${plainName(p.name)} · ${c.name}`,
    ...(extra.length ? { extra } : {}),
  };
}

/**
 * A repository as an installed addon: its plugins' lists as catalogs, its titles'
 * details kept with their catalogs off (they are in the watch history).
 *
 * VyseTV's `Addon.ofPlugins`. `browse` is the plugins whose catalogs are on —
 * a scraper list's by default, a Vega repository's none, because a repository of
 * them can list hundreds.
 */
export function pluginAddon(
  repo: PluginRepo,
  options: { browse?: string[]; on?: boolean } = {},
): InstalledAddon {
  const browse = options.browse ?? repo.plugins.filter((p) => !p.vega && !p.comic && p.catalogs.length).map((p) => p.id);
  const listed = repo.plugins.filter((p) => browse.includes(p.id) && !p.comic);
  // Details stay on with a catalog switched off — those titles are in the user's
  // history, and a page still has to open (upstream: `r.plugins.any((p) =>
  // p.catalogs.isNotEmpty && !p.comic)`).
  const details = repo.plugins.some((p) => p.catalogs.length && !p.comic);
  const resources: InstalledAddon['manifest']['resources'] = [{ name: 'catalog', types: ['movie', 'series'] }];
  if (details) {
    // Its titles' details: the meta prefix is what tells `metaAddons` these ids
    // belong here, and the resource is what lets them be asked for. No `stream`
    // resource: a plugin's links come from the plugin engine, not from an HTTP
    // endpoint this repository does not have.
    resources.push({ name: 'meta', types: ['movie', 'series'], idPrefixes: [prefix(repo.url)] });
  }
  return {
    manifestUrl: repo.url,
    manifest: {
      id: `plugins.${repoKey(repo.url)}`,
      name: repo.name,
      description: pluginAbout(repo.plugins),
      version: '1',
      resources,
      types: ['movie', 'series'],
      idPrefixes: [prefix(repo.url)],
      catalogs: listed.flatMap((p) => p.catalogs.map((c) => addonCatalog(p, c))),
    },
    enabled: options.on ?? true,
    installedAt: Date.now(),
    updatedAt: Date.now(),
    // Marked so the catalog and details paths ask the plugins rather than a URL.
    plugins: true,
  };
}

/** "12 plugins: A, B, C and 9 more". */
export function pluginAbout(plugins: PluginEntry[]): string {
  const shown = plugins.slice(0, 3).map((p) => p.name).join(', ');
  return `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}: ${shown}${plugins.length > 3 ? ` and ${plugins.length - 3} more` : ''}`;
}

/**
 * The installed repositories as addons, for the catalog and details lists.
 *
 * `browse` follows VyseTV: a scraper list's catalogs are on when it is added, a
 * Vega provider's off — a repository of them can list hundreds. A repository
 * with no catalogs at all is left out: it is only a source list.
 */
export function pluginAddons(stored: PluginRepository[] = installed): InstalledAddon[] {
  return stored
    .filter((repo) => repo.enabled)
    .map((repo) => pluginAddon(engineRepoView(repo), { browse: browsePlugins(repo) }))
    // A repository that lists nothing and answers no details has nothing to show
    // as an addon: its plugins are a source list, and the source list finds them
    // by itself.
    .filter((addon) => addon.manifest.catalogs.length > 0 || addon.manifest.resources.some((resource) => resource.name === 'meta'));
}

/** A stored repository as the engine's view, without the enabled filter on the repo. */
function engineRepoView(stored: PluginRepository): PluginRepo {
  return { url: stored.url, name: stored.name, kind: stored.kind, plugins: enabledPlugins(stored) };
}

/** One of a Vega provider's lists, as its catalog module names it. */
export interface Described {
  catalogs: PluginCatalog[];
  /** It gives a title's details itself (its `meta` module is there). */
  details: boolean;
}

/**
 * Reads a Vega provider's own lists from its script, without running a search.
 *
 * Its catalog module is plain data, so this costs one composition and no
 * network beyond the provider's own files. Fails quietly: a provider whose
 * script will not come down still finds streams, it just has nothing to browse.
 */
export async function describeVega(plugin: PluginEntry): Promise<Described | null> {
  try {
    const composed = await composePlugin(plugin);
    const answer = await runPluginEntry(plugin, composed, '__vyseDescribe', {});
    if (answer.error || !answer.value) return null;
    const record = answer.value as Record<string, unknown>;
    return {
      catalogs: readDescribedCatalogs(record, plugin.comic),
      details: record.meta === true,
    };
  } catch {
    return null;
  }
}

/**
 * A repository with its Vega providers' lists read.
 *
 * VyseTV does this at install (`_describeVega`), a few at a time; the lists and
 * whether a provider gives details are then stored with the plugin, so browsing
 * costs nothing afterwards. A repository of hundreds would be hundreds of
 * downloads, so it stops at `limit`.
 */
export async function describeRepo(
  repo: PluginRepo,
  options: { limit?: number; atOnce?: number } = {},
): Promise<PluginRepo> {
  const limit = options.limit ?? 60;
  const atOnce = Math.max(1, options.atOnce ?? 4);
  const todo = repo.plugins.filter((p) => p.vega).slice(0, limit);
  if (!todo.length) return repo;
  const read = new Map<string, Described>();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const plugin = todo[next++];
      const described = await describeVega(plugin);
      if (described) read.set(plugin.id, described);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, todo.length) }, worker));
  if (!read.size) return repo;
  return {
    ...repo,
    plugins: repo.plugins.map((plugin) => {
      const described = read.get(plugin.id);
      if (!described) return plugin;
      return { ...plugin, catalogs: described.catalogs, details: described.details };
    }),
  };
}

// ── pages ──
// A Vega provider counts pages (how many a page holds: its first page's); a paged
// script hands the token for the page after each one.
const sizes = new Map<string, number>();
const nextTokens = new Map<string, string>();
const paged = new Set<string>();

/** Test seam: forget the page counts and tokens. */
export function resetPluginCatalogPaging(): void {
  sizes.clear();
  nextTokens.clear();
  paged.clear();
}

/** The plugin `id` of the repository at `repoUrl`, from what this device has. */
function findPlugin(repoUrl: string, id: string): PluginEntry | null {
  return enabledPlugins(storedRepository(repoUrl) ?? { url: repoUrl, name: '', kind: 'repo', enabled: true, plugins: [], installedAt: 0, updatedAt: 0 })
    .find((plugin) => plugin.id === id) ?? null;
}

/**
 * Plugin `id` of the repository at `url` asked `entry` (a page of one of its
 * catalogs, a title's details): its answer. Throws when it fails.
 */
export async function askPlugin(
  url: string,
  id: string,
  entry: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const plugin = findPlugin(url, id);
  if (!plugin) throw new Error('That repository no longer has this plugin.');
  const composed: ComposedPlugin = await composePlugin(plugin);
  const answer = await runPluginEntry(plugin, composed, entry, args);
  if (answer.error) throw new Error(answer.error);
  return answer.value;
}

/**
 * One page of `catalog`, a catalog of the plugin repository `addon` (the first,
 * or after `skip` titles), as a Stremio addon answers: `{metas}`, the titles' ids
 * made the repository's.
 */
export async function page(
  addon: InstalledAddon,
  catalog: StremioCatalog,
  options: { genre?: string; search?: string; skip?: number } = {},
): Promise<{ metas: Record<string, unknown>[] }> {
  const at = catalog.id.indexOf('/');
  if (at <= 0) return { metas: [] };
  const pluginId = catalog.id.slice(0, at);
  const plugin = findPlugin(addon.manifestUrl, pluginId);
  const own = plugin?.catalogs.find((entry) => entry.id === catalog.id.slice(at + 1));
  if (!plugin || !own) return { metas: [] };

  const skip = options.skip ?? 0;
  const key = `${addon.manifestUrl}|${catalog.id}|${options.genre ?? ''}|${options.search ?? ''}`;
  let answer: unknown;
  if (plugin.vega) {
    const size = sizes.get(key);
    const pageNumber = skip <= 0 ? 1 : 1 + (size == null || size === 0 ? 1 : Math.round(skip / size));
    answer = await askPlugin(addon.manifestUrl, plugin.id, '__vegaCatalog', {
      filter: own.filter ?? '',
      page: pageNumber,
      search: options.search,
      genre: options.genre,
      type: own.type,
      comic: plugin.comic,
    });
  } else {
    let token: string | undefined;
    if (skip > 0 && paged.has(key)) {
      token = nextTokens.get(`${key}|${skip}`);
      // The last page was the last.
      if (token == null) return { metas: [] };
    }
    answer = await askPlugin(addon.manifestUrl, plugin.id, '__scraperCatalog', {
      catalogId: own.id,
      type: own.type,
      skip,
      pageToken: token,
      search: options.search,
      genre: options.genre,
    });
  }

  const record = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const metas = Array.isArray(record.metas) ? record.metas : [];
  const out = metas
    .slice(0, 200)
    .filter((meta): meta is Record<string, unknown> => Boolean(meta) && typeof meta === 'object' && (meta as Record<string, unknown>).id != null)
    .map((meta) => ownIds(addon.manifestUrl, plugin.id, meta, own.type));

  if (plugin.vega && skip <= 0) sizes.set(key, out.length);
  if (typeof record.next === 'string' && out.length) {
    paged.add(key);
    nextTokens.set(`${key}|${skip + out.length}`, record.next);
  }
  return { metas: out };
}

/**
 * `id`'s details from its plugin, as a Stremio addon answers: `{meta}`. The meta
 * is null when the plugin gives none — its page then shows TMDB's, or the
 * catalog's own copy.
 */
export async function meta(
  addon: InstalledAddon,
  type: string,
  id: string,
): Promise<{ meta: Record<string, unknown> | null }> {
  const own = unwrap(addon.manifestUrl, id);
  if (!own) return { meta: null };
  const plugin = findPlugin(addon.manifestUrl, own.plugin);
  if (!plugin || !plugin.details) return { meta: null };
  const answer = plugin.vega
    ? await askPlugin(addon.manifestUrl, plugin.id, '__vegaMeta', { link: own.own })
    : await askPlugin(addon.manifestUrl, plugin.id, '__scraperMeta', {
        id: own.own,
        type: type === 'series' ? 'tv' : type,
      });
  const record = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const raw = record.meta;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw as Record<string, unknown>).length) return { meta: null };
  // Its key stays the catalog's.
  return { meta: { ...ownIds(addon.manifestUrl, plugin.id, raw as Record<string, unknown>, type), id } };
}

/**
 * A plugin's title (or details) with its ids, and its episodes', made the
 * repository's; its kind in PRAHA's words ("tv" is a show).
 */
function ownIds(
  repoUrl: string,
  plugin: string,
  raw: Record<string, unknown>,
  kind: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const ownId = String(raw.id ?? '');
  out.id = wrap(repoUrl, plugin, ownId);
  const t = String(raw.type ?? kind);
  out.type = t === 'tv' || t === 'show' ? 'series' : t;
  if (out.name == null && raw.title != null) out.name = raw.title;
  // A site's titles often have one picture: its page shows it behind, as the
  // sources screen does.
  if (typeof out.background !== 'string' && typeof out.poster === 'string') out.background = out.poster;
  if (Array.isArray(raw.videos)) {
    out.videos = raw.videos
      .filter((video): video is Record<string, unknown> => Boolean(video) && typeof video === 'object')
      .map((video) => ({
        ...video,
        id: wrap(
          repoUrl,
          plugin,
          String(video.id ?? `${ownId}:${video.season}:${video.episode}`),
        ),
      }));
  }
  return out;
}

/**
 * A title of a plugin repository as an item: its own id kept beside the
 * repository's, so the stream list knows which plugin to ask.
 *
 * Returns null when `item` did not come from a plugin repository.
 */
export function pluginOwnOf(item: MediaItem, videoId?: string): { repoUrl: string; plugin: string; own: string } | null {
  const repoUrl = item.addonUrl;
  if (!repoUrl) return null;
  const own = unwrap(repoUrl, videoId) ?? unwrap(repoUrl, item.id);
  if (!own) return null;
  return { repoUrl, plugin: own.plugin, own: own.own };
}
