// Asking a repository's plugins what they can find for one title.
//
// A port of VyseTV's `PluginEngine._find` in
// `lib/data/sources/plugins/js_plugins.dart` (GPL-3.0-or-later). Three pieces of
// that method are behaviour, not optimisation, and are kept here:
//
//   * a plugin that keeps failing (its site is gone) is asked *after* the rest —
//     `_failures` counts consecutive failures and sorts on them, so one dead
//     scraper does not delay every title;
//   * results are kept ten minutes, keyed by repository and query, so reopening
//     the source list or moving to the next episode does not re-run everything;
//   * plugins run `_atOnce` at a time and each one's streams are published the
//     moment it lands, so a slow plugin holds nothing up.
//
// The plugins themselves are third-party code: `composePlugin` downloads their
// scripts through the guarded transport, and `runPlugin` runs them in the
// sandbox with `http()` as their only door out.

import { composePlugin } from './pluginScripts';
import { runPlugin, type ComposedPlugin } from './pluginRuntime';
import { pluginStreamToResult } from './jsPlugins';
import type { PluginEntry, PluginQuery, PluginRepo, PluginStream } from './jsPlugins';
import type { StreamResult } from '../types';

/** One link one plugin found, with the plugin that found it. */
export interface PluginHit {
  plugin: PluginEntry;
  stream: PluginStream;
  /** Its position in that plugin's own answer, for a stable id. */
  index: number;
  /** The same link as the source list shows it, built once when it is found. */
  result: StreamResult;
}

/** VyseTV's `_found` entry: a run's results and when they landed. */
interface CachedRun {
  at: number;
  hits: PluginHit[];
  done: Promise<PluginHit[]>;
}

/** VyseTV keeps a run's results for ten minutes. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * VyseTV's `_atOnce`: `max(3, min(8, processors))`.
 *
 * Each run is a worker plus a script, and a phone cannot hold a hundred of
 * those at once; eight is where a modern device stops gaining from more.
 */
const atOnce = (): number => {
  const cores = typeof navigator !== 'undefined' ? Number(navigator.hardwareConcurrency) || 4 : 4;
  return Math.max(3, Math.min(8, cores));
};

const found = new Map<string, CachedRun>();

/** Consecutive failures per `repo#plugin`, so a dead plugin sinks to the back. */
const failures = new Map<string, number>();

/** The scripts already downloaded, shared across runs. */
const scripts = new Map<string, ComposedPlugin>();

/** Forgets every cached run. Tests use it; the app lets the ten minutes expire. */
export function clearPluginCache(): void {
  found.clear();
  failures.clear();
  scripts.clear();
}

const failureKey = (repoUrl: string, pluginId: string) => `${repoUrl}#${pluginId}`;

/**
 * The plugins of `repo` that can answer this query.
 *
 * A film asks only plugins that declare `movie`, a show only `tv`; `readTypes`
 * already normalises a plugin that declared neither to `['movie','tv']`, so an
 * ordinary `includes` covers every case.
 *
 * A comic plugin is never asked: its "streams" are a chapter's pages, which the
 * manga section reads, and a video source list has no use for them.
 */
function askable(repo: PluginRepo, query: PluginQuery, only?: string): PluginEntry[] {
  // One of a plugin's own titles: that plugin alone, asked for it by its own id.
  if (only) return repo.plugins.filter((plugin) => plugin.id === only);
  if (query.ownId) return repo.plugins.filter((plugin) => !plugin.comic);
  const wanted = query.isTv ? 'tv' : 'movie';
  return repo.plugins.filter((plugin) => !plugin.comic && plugin.types.includes(wanted));
}

/**
 * Runs one plugin and answers its hits, or throws with what went wrong.
 *
 * A plugin that found nothing is not a failure: an empty answer is a legitimate
 * answer, and counting it would demote a plugin that simply has no link for this
 * title.
 */
async function ask(plugin: PluginEntry, query: PluginQuery): Promise<PluginHit[]> {
  const composed = await composePlugin(plugin, scripts);
  const result = await runPlugin(plugin, composed, query);
  if (result.error && !result.raw.length) throw new Error(result.error);
  return result.raw.map((stream, index) => ({
    plugin,
    index,
    stream,
    result: pluginStreamToResult(stream, plugin, index),
  }));
}

/**
 * One repository's plugins, asked for one title.
 *
 * `onSome` hears everything found so far each time a plugin lands something, so
 * the source list can fill in instead of waiting for the slowest plugin. The
 * promise still resolves with the complete list, in the repository's order.
 */
export async function findPluginStreams(
  repo: PluginRepo,
  query: PluginQuery,
  options: {
    onSome?: (hits: PluginHit[]) => void;
    /** Only these plugin ids, when the caller has its own enablement list. */
    enabledIds?: string[];
    /** Just this plugin (one of its own titles, asked by its own id). */
    only?: string;
  } = {},
): Promise<PluginHit[]> {
  const key = `${repo.url}|${options.only ?? ''}|${JSON.stringify(query)}`;
  const cached = found.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    if (options.onSome && cached.hits.length) options.onSome(cached.hits);
    return cached.done;
  }

  const plugins = askable(repo, query, options.only).filter(
    (plugin) => !options.enabledIds || options.enabledIds.includes(plugin.id),
  );

  const run: CachedRun = { at: Date.now(), hits: [], done: Promise.resolve([]) };
  run.done = (async () => {
    // Ask the reliable ones first: upstream's failure-count sort, stable on the
    // repository's own order for equal counts.
    const order = plugins
      .map((plugin, index) => ({ plugin, index }))
      .sort((a, b) => {
        const fa = failures.get(failureKey(repo.url, a.plugin.id)) ?? 0;
        const fb = failures.get(failureKey(repo.url, b.plugin.id)) ?? 0;
        return fa !== fb ? fa - fb : a.index - b.index;
      });

    const answers = new Map<string, PluginHit[]>();
    let next = 0;
    const collect = () => plugins.flatMap((plugin) => answers.get(plugin.id) ?? []);

    const worker = async () => {
      while (next < order.length) {
        const { plugin } = order[next++];
        try {
          answers.set(plugin.id, await ask(plugin, query));
          failures.delete(failureKey(repo.url, plugin.id));
        } catch {
          // What went wrong is in the plugin's own log; here it only matters
          // that this plugin is less likely to answer next time.
          const failed = failureKey(repo.url, plugin.id);
          failures.set(failed, (failures.get(failed) ?? 0) + 1);
        }
        // Publish in the repository's order, so a partial list reads the same as
        // the final one.
        const soFar = collect();
        if (soFar.length) {
          run.hits = soFar;
          options.onSome?.(soFar);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(atOnce(), order.length) }, worker));
    return collect();
  })();

  found.set(key, run);
  // Nothing found (or it failed): ask again next time rather than caching an
  // empty answer for ten minutes.
  void run.done.then(
    (hits) => {
      if (!hits.length && found.get(key) === run) found.delete(key);
    },
    () => {
      if (found.get(key) === run) found.delete(key);
    },
  );

  return run.done;
}

/**
 * Several repositories at once, through one cache entry each.
 *
 * The caller hears each repository's findings as they land — merged, so a
 * partial list never shows only the first repository's plugins.
 */
export async function findPluginStreamsEverywhere(
  repos: PluginRepo[],
  query: PluginQuery,
  options: {
    onSome?: (hits: PluginHit[]) => void;
    enabledIds?: string[];
    /** Just this plugin (one of its own titles, asked by its own id). */
    only?: string;
  } = {},
): Promise<PluginHit[]> {
  const landed = new Map<PluginRepo, PluginHit[]>();
  const publish = () => {
    if (!options.onSome) return;
    const merged = repos.flatMap((repo) => landed.get(repo) ?? []);
    if (merged.length) options.onSome(merged);
  };

  const perRepo = await Promise.all(
    repos.map((repo) =>
      findPluginStreams(repo, query, {
        enabledIds: options.enabledIds,
        only: options.only,
        onSome: (hits) => {
          landed.set(repo, hits);
          publish();
        },
      }).catch(() => [] as PluginHit[]),
    ),
  );
  return perRepo.flat();
}
