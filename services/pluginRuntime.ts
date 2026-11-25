// Runs one plugin — a hand-written one, a scraper-list entry, or a Vega provider
// — and answers with the streams it found.
//
// This is the main-thread half of the plugin engine ported from VyseTV's
// `runPlugin` in `lib/data/sources/plugins/js_plugins.dart`
// (GPL-3.0-or-later). The division is deliberate:
//
//   * the *script* runs in `nuvioWorker.ts`, the app's one sandbox, where
//     `fetch`/`XMLHttpRequest` are gone and `http()` is the only door out;
//   * the *network* is answered here, through `pluginTransport.ts`, which checks
//     the host before every redirect hop.
//
// Neither half is sufficient alone: a sandbox with an unguarded transport hands
// the router's admin page to a plugin author, and a guarded transport with a
// plugin still holding `fetch` is bypassed entirely.
//
// One worker per run, terminated when the run ends — the same lifecycle
// `nuvioService.ts` uses, and for the same reason: a plugin that never settles
// must not leave a thread behind.

import { pluginFetch } from './pluginTransport';
import {
  parsePluginStreams,
  pluginStreamToResult,
  type PluginEntry,
  type PluginQuery,
  type PluginStream,
} from './jsPlugins';
import type { StreamResult } from '../types';

/** VyseTV's `_runTimeout`: 25 s for the whole run, network included. */
const RUN_TIMEOUT_MS = 25000;

export interface PluginRunResult {
  streams: StreamResult[];
  /** The same links before they were mapped, for callers that want plugin metadata. */
  raw: PluginStream[];
  /** The plugin's `console.*` lines and any failure, for the plugin log. */
  log: string[];
  error?: string;
}

interface PluginJobMessage {
  type: 'plugin-run';
  code: string;
  query: Record<string, unknown>;
  kind: 'plugin' | 'scraper' | 'vega';
  name?: string;
  /** Ask this global instead of `getStreams` — a catalog page, a title's details. */
  entry?: string;
}

/** What the worker answers when the run finishes. */
interface PluginDoneMessage {
  type: 'plugin-done';
  ok: boolean;
  streams?: unknown;
  /** The answer of an `entry` call, untouched: `{metas}`, `{meta}`, … */
  value?: unknown;
  log?: string[];
  error?: string;
}

/** A named function's answer, for the browsing and details pages. */
export interface PluginEntryResult {
  value: unknown;
  log: string[];
  error?: string;
}

/** What the worker asks for mid-run. */
interface PluginHttpMessage {
  type: 'plugin-http';
  reqId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout?: number;
}

/**
 * The query a plugin is asked, from the app's own notion of a title.
 *
 * `season`/`episode` are only meaningful for a show, and a plugin that reads them
 * for a film would search for "S01E02" on a film's page; they are dropped there.
 */
export function buildPluginQuery(input: {
  tmdbId?: number | null;
  imdbId?: string | null;
  isTv: boolean;
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  titles?: string[];
  isAnime?: boolean;
  season?: number | null;
  episode?: number | null;
}): PluginQuery {
  return {
    tmdbId: input.tmdbId ?? null,
    imdbId: input.imdbId ?? null,
    type: input.isTv ? 'tv' : 'movie',
    isTv: input.isTv,
    title: input.title,
    originalTitle: input.originalTitle ?? undefined,
    year: input.year ?? null,
    titles: input.titles,
    isAnime: input.isAnime,
    season: input.isTv ? (input.season ?? null) : null,
    episode: input.isTv ? (input.episode ?? null) : null,
  };
}

/** The script text a plugin's kind needs, composed from its modules. */
export interface ComposedPlugin {
  code: string;
  kind: 'plugin' | 'scraper' | 'vega';
}

/**
 * Runs a composed plugin script and returns its streams.
 *
 * `fetchText` is used only to compose a Vega provider (whose modules live beside
 * its manifest); it is the guarded repository fetch, never a bare `fetch`.
 */
export function runPlugin(
  plugin: PluginEntry,
  composed: ComposedPlugin,
  query: PluginQuery,
): Promise<PluginRunResult> {
  return new Promise((resolve) => {
    runJob(plugin, composed, query as unknown as Record<string, unknown>, undefined, (done, log) => {
      const raw: PluginStream[] = done.ok ? parsePluginStreams(done.streams) : [];
      resolve({
        streams: raw.map((stream, index) => pluginStreamToResult(stream, plugin, index)),
        raw,
        log,
        error: done.ok ? undefined : done.error || 'The plugin failed.',
      });
    });
  });
}

/**
 * Asks one of a plugin's other functions — `__scraperCatalog`, `__vegaMeta` and
 * the like — and answers whatever it returns.
 *
 * The same sandbox, the same transport and the same timeout as a stream ask; only
 * the function that is called differs.
 */
export function runPluginEntry(
  plugin: PluginEntry,
  composed: ComposedPlugin,
  entry: string,
  args: Record<string, unknown>,
): Promise<PluginEntryResult> {
  return new Promise((resolve) => {
    runJob(plugin, composed, args, entry, (done, log) => {
      resolve({
        value: done.ok ? done.value ?? null : null,
        log,
        error: done.ok ? undefined : done.error || 'The plugin failed.',
      });
    });
  });
}

/** The worker plumbing both asks share. */
function runJob(
  plugin: PluginEntry,
  composed: ComposedPlugin,
  query: Record<string, unknown>,
  entry: string | undefined,
  settle: (done: PluginDoneMessage, log: string[]) => void,
): void {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./nuvioWorker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    settle(
      { type: 'plugin-done', ok: false, error: error instanceof Error ? error.message : 'The plugin sandbox could not start.' },
      [],
    );
    return;
  }

  let settled = false;
  const finish = (done: PluginDoneMessage, log: string[]) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    worker.terminate();
    settle(done, log);
  };

  const timer = globalThis.setTimeout(() => {
    finish({ type: 'plugin-done', ok: false, error: 'The plugin timed out after 25 seconds.' }, []);
  }, RUN_TIMEOUT_MS);

  worker.onmessage = async (event: MessageEvent) => {
    const message = event.data as PluginHttpMessage | PluginDoneMessage | undefined;
    if (!message || typeof message !== 'object') return;

    if ((message as PluginHttpMessage).type === 'plugin-http') {
      const request = message as PluginHttpMessage;
      // The transport never throws; a blocked address is an ordinary answer.
      const answer = await pluginFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeout: request.timeout,
      }).catch((error: unknown) => ({
        status: 0,
        url: request.url,
        headers: {},
        text: '',
        error: error instanceof Error ? error.message : 'The request failed.',
      }));
      worker.postMessage({ type: 'plugin-http-response', reqId: request.reqId, ...answer });
      return;
    }

    if ((message as PluginDoneMessage).type === 'plugin-done') {
      const done = message as PluginDoneMessage;
      finish(done, Array.isArray(done.log) ? done.log : []);
    }
  };

  worker.onerror = (event) => {
    finish({ type: 'plugin-done', ok: false, error: event.message || 'The plugin crashed.' }, []);
  };

  const job: PluginJobMessage = {
    type: 'plugin-run',
    code: composed.code,
    query,
    kind: composed.kind,
    name: plugin.name,
    entry,
  };
  worker.postMessage(job);
}

/** The lines a plugin printed, for the plugin log the user can read. */
export function describePluginRun(plugin: PluginEntry, result: PluginRunResult): string[] {
  const lines = [...result.log];
  if (result.error) lines.push(`error: ${result.error}`);
  return lines.map((line) => `[${plugin.name}] ${line}`);
}
