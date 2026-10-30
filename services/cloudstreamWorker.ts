/// <reference lib="webworker" />

const worker = self as unknown as DedicatedWorkerGlobalScope;

/**
 * CloudStream JavaScript extensions expose three optional entry points:
 *   search(query)          -> SearchResult[]      (JSON string or array)
 *   getEpisodes(showId)    -> Episode[]           (JSON string or array)
 *   getStreams(mediaId)    -> StreamSource[]      (JSON string or array)
 *
 * They may be attached to `module.exports` or declared as globals. Some
 * CloudStream repositories also ship a Nuvio-style `getStreams(tmdbId,
 * mediaType, season, episode)`, so we fall back to that contract when the
 * CloudStream-style call returns nothing.
 */
worker.onmessage = async (event) => {
  const { code, mode, args, providerId, tmdbApiKey } = event.data;
  try {
    // CloudStream JS plugins may ship a placeholder TMDB key — inject the
    // user's own key when one is provided so TMDB-based plugins work.
    const source = tmdbApiKey ? code.replace(/YOUR_TMDB_API_KEY/g, tmdbApiKey) : code;
    if (source.includes('YOUR_TMDB_API_KEY')) {
      throw new Error('This extension needs your TMDB API key. Add it in Settings → TMDB API, then try again.');
    }
    const module = { exports: {} as Record<string, unknown> };
    // WorkerGlobalScope.self is a getter-only accessor in browsers, so a
    // plain assignment (Object.assign included) throws
    // "Cannot set property self ... which has only a getter". `self` already
    // refers to the worker scope, so leave it alone and install only the
    // Node-style aliases plugin code may expect.
    const setGlobal = (name: string, value: unknown) => {
      Object.defineProperty(worker, name, { value, writable: true, configurable: true });
    };
    setGlobal('window', worker);
    setGlobal('global', worker);
    setGlobal('SCRAPER_ID', providerId);
    setGlobal('SCRAPER_SETTINGS', {});
    const require = (name: string) => {
      throw new Error(`Module '${name}' is not available in the PRAHA CloudStream web runtime.`);
    };
    const evaluate = new Function(
      'module', 'exports', 'require',
      `${source}\n;return { exported: module.exports, localSearch: typeof search === 'function' ? search : undefined, localGetHome: typeof getHome === 'function' ? getHome : undefined, localGetEpisodes: typeof getEpisodes === 'function' ? getEpisodes : undefined, localGetStreams: typeof getStreams === 'function' ? getStreams : undefined };`,
    );
    const context = evaluate(module, module.exports, require);
    const exported = context.exported as Record<string, unknown>;

    const decode = (result: unknown) => {
      if (typeof result === 'string') {
        try { return JSON.parse(result); } catch { return []; }
      }
      return Array.isArray(result) ? result : [];
    };

    if (mode === 'search') {
      const search = exported.search || context.localSearch || (worker as any).search;
      if (typeof search !== 'function') throw new Error('This extension does not export search().');
      worker.postMessage({ ok: true, result: decode(await search(args.query)) });
      return;
    }

    if (mode === 'home') {
      const getHome = exported.getHome || context.localGetHome || (worker as any).getHome;
      if (typeof getHome !== 'function') throw new Error('This extension does not export getHome().');
      worker.postMessage({ ok: true, result: decode(await getHome()) });
      return;
    }

    if (mode === 'episodes') {
      const getEpisodes = exported.getEpisodes || context.localGetEpisodes || (worker as any).getEpisodes;
      if (typeof getEpisodes !== 'function') throw new Error('This extension does not export getEpisodes().');
      worker.postMessage({ ok: true, result: decode(await getEpisodes(args.showId)) });
      return;
    }

    const getStreams = exported.getStreams || context.localGetStreams || (worker as any).getStreams;
    if (typeof getStreams !== 'function') throw new Error('This extension does not export getStreams().');

    // CloudStream contract: getStreams(mediaId).
    let raw = [];
    if (args.mediaId) {
      try {
        raw = decode(await getStreams(args.mediaId));
      } catch {
        raw = [];
      }
    }
    if (raw.length) {
      worker.postMessage({ ok: true, result: raw });
      return;
    }

    // Some CloudStream repositories also ship a Nuvio-style getStreams(tmdbId,
    // mediaType, season, episode). Only try it when we actually have a TMDB id.
    const fallback = args.tmdbId
      ? decode(await getStreams(args.tmdbId, args.mediaType, args.season ?? undefined, args.episode ?? undefined))
      : [];
    worker.postMessage({ ok: true, result: fallback });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
