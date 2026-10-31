/// <reference lib="webworker" />

const worker = self as unknown as DedicatedWorkerGlobalScope;
const originalFetch = worker.fetch.bind(worker);

interface PendingProxyRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const pendingProxy = new Map<string, PendingProxyRequest>();

function proxyFetchViaMainThread(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
  }
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const reqId = `cs-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<Response>((resolve, reject) => {
    pendingProxy.set(reqId, { resolve, reject });
    worker.postMessage({ type: 'fetch-proxy', reqId, url, method, headers, body });
  });
}

const smartFetch: typeof fetch = async (input, init) => {
  try {
    return await originalFetch(input, init);
  } catch {
    return proxyFetchViaMainThread(input, init);
  }
};

Object.defineProperty(worker, 'fetch', { value: smartFetch, writable: true, configurable: true });

worker.onmessage = async (event) => {
  const payload = event.data;
  if (payload?.type === 'fetch-proxy-response') {
    const pending = pendingProxy.get(payload.reqId);
    if (!pending) return;
    pendingProxy.delete(payload.reqId);
    if (payload.error) {
      pending.reject(new Error(payload.error));
    } else {
      pending.resolve(new Response(payload.data ?? '', {
        status: payload.status || 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    }
    return;
  }

  const { code, mode, args, providerId, tmdbApiKey } = payload;
  try {
    const source = tmdbApiKey ? code.replace(/YOUR_TMDB_API_KEY/g, tmdbApiKey) : code;
    if (source.includes('YOUR_TMDB_API_KEY')) {
      throw new Error('This extension needs your TMDB API key. Add it in Settings → TMDB API, then try again.');
    }
    const module = { exports: {} as Record<string, unknown> };
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

    const fallback = args.tmdbId
      ? decode(await getStreams(args.tmdbId, args.mediaType, args.season ?? undefined, args.episode ?? undefined))
      : [];
    worker.postMessage({ ok: true, result: fallback });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
