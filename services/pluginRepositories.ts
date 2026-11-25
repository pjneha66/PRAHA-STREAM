// The plugin repositories this device has installed, and the conversions
// between what is stored and what the engine runs.
//
// A port of the install side of VyseTV's `lib/data/sources/plugins/js_plugins.dart`
// (GPL-3.0-or-later). VyseTV keeps an installed repository as its parsed listing
// plus a per-plugin enable flag; the app stores that list in
// `praha.v2.plugin-repositories` and never keeps the scripts, which are fetched
// at run time and cached in memory by `pluginFinder`.
//
// The repository file itself is read through the guarded transport: a plugin
// repository is a third-party link a user pasted, and it has no business pointing
// at this device's own network.

import { loadPluginRepo, type PluginEntry, type PluginRepo } from './jsPlugins';
import { pluginFetch } from './pluginTransport';
import * as pluginCatalogs from './pluginCatalogs';
import type { PluginRepository, PluginRepositoryEntry } from '../types';

/** Fetches text through the guarded transport, refusing a non-200 answer. */
async function fetchText(url: string): Promise<string> {
  const answer = await pluginFetch(url, { timeout: 20000, headers: { Accept: 'application/json, text/plain, */*' } });
  if (answer.status === 0) throw new Error(answer.error || `Could not reach ${url}.`);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`That repository's server answered ${answer.status}.`);
  }
  return answer.text;
}

const entryFromPlugin = (plugin: PluginEntry): PluginRepositoryEntry => ({
  ...plugin,
  enabled: true,
});

/** The stored shape of a freshly read repository. */
export function toStoredRepository(repo: PluginRepo): PluginRepository {
  const now = Date.now();
  return {
    url: repo.url,
    name: repo.name || hostLabel(repo.url),
    kind: repo.kind,
    enabled: true,
    plugins: repo.plugins.map(entryFromPlugin),
    installedAt: now,
    updatedAt: now,
  };
}

/** A repository's name when its file gave none: the host it came from. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Plugin repository';
  }
}

/**
 * The engine's view of a stored repository: only its enabled plugins.
 *
 * The disabled ones are dropped here rather than filtered at every call site, so
 * a run cannot accidentally ask a plugin the user turned off.
 */
export function activeRepo(stored: PluginRepository): PluginRepo {
  return {
    url: stored.url,
    name: stored.name,
    kind: stored.kind,
    plugins: stored.plugins
      .filter((plugin) => plugin.enabled)
      .map(({ enabled: _enabled, ...plugin }) => plugin as PluginEntry),
  };
}

/** Every enabled repository, ready to run. */
export function activeRepos(stored: PluginRepository[]): PluginRepo[] {
  return stored.filter((repo) => repo.enabled).map(activeRepo);
}

/**
 * Reads a repository the user pasted and answers it in stored form.
 *
 * The link is checked inside `loadPluginRepo`, so a repository that points at a
 * private address is refused with a message the user can act on.
 */
export async function installPluginRepository(rawUrl: string): Promise<PluginRepository> {
  const repo = await loadPluginRepo(rawUrl, fetchText);
  return toStoredRepository(repo);
}

/**
 * Reads the repository again, keeping the user's per-plugin switches.
 *
 * A plugin that disappeared from the repository is dropped; one that is new is
 * enabled — the user asked for this repository, so its new plugins are wanted.
 */
export async function refreshPluginRepository(stored: PluginRepository): Promise<PluginRepository> {
  const repo = await loadPluginRepo(stored.url, fetchText);
  const before = new Map(stored.plugins.map((plugin) => [plugin.id, plugin.enabled]));
  return {
    ...toStoredRepository(repo),
    name: repo.name || stored.name,
    installedAt: stored.installedAt,
    enabled: stored.enabled,
    plugins: repo.plugins.map((plugin) => ({
      ...entryFromPlugin(plugin),
      enabled: before.get(plugin.id) ?? true,
    })),
  };
}

/** One plugin switched on or off. */
export function setPluginEnabled(
  stored: PluginRepository,
  pluginId: string,
  enabled: boolean,
): PluginRepository {
  return {
    ...stored,
    updatedAt: Date.now(),
    plugins: stored.plugins.map((plugin) => (plugin.id === pluginId ? { ...plugin, enabled } : plugin)),
  };
}

/** How many plugins a repository has that this device is actually running. */
export function enabledPluginCount(stored: PluginRepository): number {
  return stored.enabled ? stored.plugins.filter((plugin) => plugin.enabled).length : 0;
}

/**
 * Reads a fresh repository's Vega providers' lists, so installing one already
 * knows what can be browsed.
 *
 * VyseTV does this at install (`_describeVega`): a provider's catalog module is
 * plain data, and reading it then means browsing costs nothing afterwards. A
 * provider whose script will not come down is left as it was — it still finds
 * streams, it just has nothing to list.
 */
export async function describeInstalledRepository(stored: PluginRepository): Promise<PluginRepository> {
  try {
    const described = await pluginCatalogs.describeRepo(activeRepo(stored));
    const byId = new Map(described.plugins.map((plugin) => [plugin.id, plugin]));
    return {
      ...stored,
      plugins: stored.plugins.map((plugin) => {
        const fresh = byId.get(plugin.id);
        if (!fresh || (!fresh.catalogs.length && !fresh.details)) return plugin;
        return { ...plugin, catalogs: fresh.catalogs, details: fresh.details };
      }),
    };
  } catch {
    // A repository that cannot be read is still a repository: the user can
    // refresh it later, and its stream plugins work without their lists.
    return stored;
  }
}
