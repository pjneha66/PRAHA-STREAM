// Getting a plugin's script — the text the sandbox will run.
//
// Three shapes, matching the three repository kinds in `jsPlugins.ts`:
//
//   * a plain plugin: one file, used as it is;
//   * a scraper-list entry: one CommonJS file, wrapped by `composeScraperScript`
//     so it answers the plugin contract through the adapter;
//   * a Vega provider: `dist/<value>/{posts,meta,stream,episodes,catalog}.js`,
//     stitched into one script that calls `__vega.source(...)` and
//     `__vega.module(...)` — the same composition VyseTV's `composeVegaPlugin`
//     performs (GPL-3.0-or-later), which is why the marker lines match.
//
// Every download goes through `pluginFetch`, so a repository cannot point a
// script URL at this device's own network. A script is also capped: 512 KB is
// VyseTV's `_maxScript`, and a plugin that large is not a plugin.

import { pluginFetch } from './pluginTransport';
import { MAX_SCRIPT_BYTES, type PluginEntry } from './jsPlugins';
import { composeScraperScript } from './scraperAdapter';
import type { ComposedPlugin } from './pluginRuntime';

/** Where a Vega provider's built modules live. */
const VEGA_MODULES = ['posts', 'meta', 'stream', 'episodes', 'catalog'] as const;

/** The text that starts a Vega plugin's script, as upstream writes it. */
export const VEGA_MARKER = '// @vega-provider ';

/** The text that starts a scraper-list plugin's script. */
export const SCRAPER_MARKER = '// @scraper ';

const tooBig = (url: string) => `That script is larger than 512 KB, so it was not run (${url}).`;

/** Fetches one script body, refusing anything over the cap. */
async function fetchScript(url: string): Promise<string> {
  const answer = await pluginFetch(url, { timeout: 20000 });
  if (answer.status === 0) {
    throw new Error(answer.error || `Could not download ${url}.`);
  }
  if (answer.status === 404) {
    throw new Error(`That script is missing (404): ${url}`);
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`The script's server answered ${answer.status}: ${url}`);
  }
  if (answer.text.length > MAX_SCRIPT_BYTES) throw new Error(tooBig(url));
  return answer.text;
}

/**
 * A Vega provider's script: its modules in one file.
 *
 * `plugin.url` is the provider's folder (`…/dist/<value>`), and the repository
 * root is that minus `/dist/<value>` — which is how the provider finds its own
 * `urls.json` at run time.
 */
async function composeVega(plugin: PluginEntry): Promise<ComposedPlugin> {
  const distUrl = plugin.url.replace(/\/+$/, '');
  const value = distUrl.slice(distUrl.lastIndexOf('/') + 1);
  const base = distUrl.slice(0, distUrl.length - `/dist/${value}`.length);

  // All at once; episodes and catalog may legitimately be absent (404).
  const codes = await Promise.all(
    VEGA_MODULES.map(async (module) => {
      try {
        return await fetchScript(`${distUrl}/${module}.js`);
      } catch (error) {
        if (module === 'episodes' || module === 'catalog') return null;
        throw error;
      }
    }),
  );

  const parts = [
    `${VEGA_MARKER}${value}`,
    `// @vega-version ${plugin.version}`,
    `__vega.source(${JSON.stringify(base)}, ${JSON.stringify(value)});`,
  ];
  VEGA_MODULES.forEach((module, index) => {
    const code = codes[index];
    if (code == null) return;
    parts.push(
      `__vega.module(${JSON.stringify(module)}, function (exports, module, require, __awaiter, providerGlobal) {`,
      code,
      '});',
    );
  });
  // Browsing and details, by the names VyseTV's runtime exposes, so the engine
  // can ask for a page or a title the same way it asks for a stream.
  parts.push(
    'globalThis.__vegaCatalog = function (q) { return __vega.catalog(q); };',
    'globalThis.__vegaMeta = function (q) { return __vega.meta(q); };',
    // Its own lists, read at install: the catalog module is plain data, so it
    // is run without a request being made (VyseTV's `__vyseDescribe`).
    'globalThis.__vyseDescribe = function () { return __vega.describe(); };',
  );
  return { code: parts.join('\n'), kind: 'vega' };
}

/** A scraper-list entry's script: the scraper, wrapped for the adapter. */
async function composeScraper(plugin: PluginEntry): Promise<ComposedPlugin> {
  const code = await fetchScript(plugin.url);
  return { code: composeScraperScript(plugin.id, plugin.version, code), kind: 'scraper' };
}

/** A plain plugin's script. */
async function composePlain(plugin: PluginEntry): Promise<ComposedPlugin> {
  return { code: await fetchScript(plugin.url), kind: 'plugin' };
}

/**
 * The script for one plugin, by the shape its repository declared.
 *
 * `cache` is optional and keyed by URL; a run asks for the same plugin many times
 * as the user browses, and re-downloading a 200 KB provider each time is waste.
 */
export async function composePlugin(
  plugin: PluginEntry,
  cache?: Map<string, ComposedPlugin>,
): Promise<ComposedPlugin> {
  const key = `${plugin.url}#${plugin.version}#${plugin.scraper ? 's' : plugin.vega ? 'v' : 'p'}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const composed = plugin.vega
    ? await composeVega(plugin)
    : plugin.scraper
      ? await composeScraper(plugin)
      : await composePlain(plugin);
  cache?.set(key, composed);
  return composed;
}
