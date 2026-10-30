/// <reference lib="webworker" />

import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async (event) => {
  const { code, args, scraperId, settings, tmdbApiKey, mode } = event.data;
  try {
    const module = { exports: {} as Record<string, unknown> };
    Object.assign(worker as any, {
      window: worker,
      global: worker,
      SCRAPER_ID: scraperId,
      SCRAPER_SETTINGS: settings || {},
      TMDB_API_KEY: tmdbApiKey || '',
      cheerio,
      CryptoJS,
    });
    const require = (name: string) => {
      if (['cheerio', 'cheerio-without-node-native', 'react-native-cheerio'].includes(name)) return cheerio;
      if (name === 'crypto-js') return CryptoJS;
      throw new Error(`Module '${name}' is not available in the PRAHA web runtime.`);
    };
    const evaluate = new Function(
      'module', 'exports', 'require',
      `${code}\n;return { exported: module.exports, localGetStreams: typeof getStreams === 'function' ? getStreams : undefined, localOnSettings: typeof onSettings === 'function' ? onSettings : undefined };`,
    );
    const context = evaluate(module, module.exports, require);
    const exported = context.exported as Record<string, unknown>;

    if (mode === 'settings') {
      const onSettings = exported.onSettings || context.localOnSettings || (worker as any).onSettings;
      const layout = typeof onSettings === 'function' ? await onSettings() : [];
      worker.postMessage({ ok: true, result: layout });
      return;
    }

    const getStreams = exported.getStreams || context.localGetStreams || (worker as any).getStreams;
    if (typeof getStreams !== 'function') throw new Error('The scraper does not export getStreams().');
    const result = await getStreams(args.tmdbId, args.mediaType, args.season ?? undefined, args.episode ?? undefined);
    worker.postMessage({ ok: true, result: result || [] });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
