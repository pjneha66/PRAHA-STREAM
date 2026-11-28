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
import { getTmdbApiKey } from './tmdbConfig';
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
  kind: 'plugin' | 'scraper' | 'vega' | 'ecosystem';
  name?: string;
  /** Ask this global instead of `getStreams` — a catalog page, a title's details. */
  entry?: string;
  /** Positional entry arguments (ecosystem extensions are called positionally). */
  args?: unknown[];
  /** Whole-run budget; ecosystem calls carry their reference runtime's budgets. */
  timeoutMs?: number;
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

/** An extension preference read/write, answered from the app frame. */
interface EcoPrefsMessage {
  type: 'eco-prefs';
  op: 'get' | 'set';
  reqId: string;
  storeKey: string;
  key: string;
  value?: string;
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
  kind: 'plugin' | 'scraper' | 'vega' | 'ecosystem';
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
/** The worker realm never holds the real TMDB key: request strings carrying the
 * placeholder are rewritten here, in the app frame (audit H-open), the way the
 * Nuvio scraper proxy rewrites its own proxied requests. */
const TMDB_KEY_PLACEHOLDER = '__PRAHA_TMDB__';

/** Where an extension's preferences live: `<storeKey>` → `{key: value}`. */
const PREFS_STORE_KEY = 'praha.ecosystems.prefs.v1';

function readPrefsStore(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(PREFS_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

/** One extension's stored preferences, as the settings UI reads them. */
export function readEcosystemPrefs(storeKey: string): Record<string, string> {
  return { ...(readPrefsStore()[storeKey] ?? {}) };
}

/** Writes one preference (empty removes it), the way the worker's round trip does. */
export function writeEcosystemPref(storeKey: string, key: string, value: string): void {
  ecoPrefOp('set', storeKey, key, value);
}

function ecoPrefOp(op: string, storeKey: string, key: string, value?: string): string | null {
  const store = readPrefsStore();
  const bucket = store[storeKey] ?? (store[storeKey] = {});
  if (op === 'set') {
    if (value == null || value === '') delete bucket[key];
    else bucket[key] = value;
    try {
      localStorage.setItem(PREFS_STORE_KEY, JSON.stringify(store));
    } catch { /* storage full: the preference just does not survive a reload */ }
    return null;
  }
  return bucket[key] ?? null;
}

function restoreTmdbKey(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.includes(TMDB_KEY_PLACEHOLDER)) return raw;
  return raw.split(TMDB_KEY_PLACEHOLDER).join(getTmdbApiKey() || '');
}

function restoreTmdbKeyInHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key] = restoreTmdbKey(value);
  return out;
}

/** Extra options an ecosystem call passes through to the worker. */
interface RunJobOptions {
  args?: unknown[];
  timeoutMs?: number;
}

function runJob(
  plugin: Pick<PluginEntry, 'name'>,
  composed: ComposedPlugin,
  query: Record<string, unknown>,
  entry: string | undefined,
  settle: (done: PluginDoneMessage, log: string[]) => void,
  options: RunJobOptions = {},
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

  const budget = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const timer = globalThis.setTimeout(() => {
    finish({ type: 'plugin-done', ok: false, error: `The plugin timed out after ${Math.round(budget / 1000)} seconds.` }, []);
  }, budget);

  worker.onmessage = async (event: MessageEvent) => {
    const message = event.data as PluginHttpMessage | PluginDoneMessage | EcoPrefsMessage | undefined;
    if (!message || typeof message !== 'object') return;

    if ((message as EcoPrefsMessage).type === 'eco-prefs') {
      const request = message as EcoPrefsMessage;
      const value = ecoPrefOp(request.op, request.storeKey, request.key, request.value);
      worker.postMessage({ type: 'eco-prefs-response', reqId: request.reqId, value });
      return;
    }

    if ((message as PluginHttpMessage).type === 'plugin-http') {
      const request = message as PluginHttpMessage;
      // The transport never throws; a blocked address is an ordinary answer.
      // The worker realm never holds the real TMDB key: ecosystem preludes put
      // the `__PRAHA_TMDB__` placeholder into the query and it is rewritten
      // here, the same way the Nuvio scraper proxy rewrites it (audit H-open).
      const answer = await pluginFetch(restoreTmdbKey(request.url), {
        method: request.method,
        headers: restoreTmdbKeyInHeaders(request.headers),
        body: restoreTmdbKey(request.body),
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
    ...(options.args ? { args: options.args } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  worker.postMessage(job);
}

/**
 * Calls one named function of an ecosystem extension (Sora module, SkyStream
 * plugin, Zangetsu provider, AnymeX extension) and answers the same
 * `{"ok", data|error}` envelope its reference runtime parses:
 *
 *   - the function ran → `{ ok: true, data }` (a missing answer is `data: null`);
 *   - it threw, or the run timed out → `{ ok: false, error }`.
 *
 * `code` is the composed script — the ecosystem's prelude plus the extension's
 * own source — and the function is reached by its global name, called
 * positionally with `args` exactly as the reference runtime calls it.
 */
export function runEcosystemCall(
  extension: { name: string },
  code: string,
  fnName: string,
  args: unknown[],
  options: { timeoutMs?: number; /** The entry builds its own `{ok, data|error}` envelope (SkyStream). */ envelope?: boolean } = {},
): Promise<{ ok: boolean; data?: unknown; log: string[]; error?: string }> {
  return new Promise((resolve) => {
    runJob(
      extension,
      { code, kind: 'ecosystem' },
      {},
      fnName,
      (done, log) => {
        if (!done.ok) {
          resolve({ ok: false, log, error: done.error || 'The extension failed.' });
          return;
        }
        const value = done.value ?? null;
        if (options.envelope && value && typeof value === 'object' && typeof (value as Record<string, unknown>).ok === 'boolean') {
          const envelope = value as Record<string, unknown>;
          resolve({
            ok: envelope.ok === true,
            data: envelope.ok === true ? envelope.data ?? null : null,
            error: envelope.ok === true ? undefined : String(envelope.error ?? 'The extension failed.'),
            log,
          });
          return;
        }
        resolve({ ok: true, data: value, log });
      },
      { args, timeoutMs: options.timeoutMs },
    );
  });
}

/** The lines a plugin printed, for the plugin log the user can read. */
export function describePluginRun(plugin: PluginEntry, result: PluginRunResult): string[] {
  const lines = [...result.log];
  if (result.error) lines.push(`error: ${result.error}`);
  return lines.map((line) => `[${plugin.name}] ${line}`);
}
