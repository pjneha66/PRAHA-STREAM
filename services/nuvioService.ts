import type {
  NuvioManifestScraper, NuvioRepository, NuvioScraper, NuvioSettingField,
  SourceError, StreamResult,
} from '../types';
import { nativeFetchText } from './androidBridge';
import { getTmdbApiKey } from './tmdbConfig';

async function fetchText(url: string, timeoutMs = 20000) {
  const response = await nativeFetchText(url, { timeoutMs });
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${new URL(url).hostname}.`);
  return response.data;
}

export function normalizeNuvioRepositoryUrl(rawUrl: string) {
  let value = rawUrl.trim();
  if (!value) throw new Error('Paste a Nuvio repository URL to continue.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  url.hash = '';
  if (!url.pathname.endsWith('/manifest.json')) url.pathname = `${url.pathname.replace(/\/$/, '')}/manifest.json`;
  return url.toString();
}

const normalizeType = (type: string) => ['series', 'show', 'other'].includes(type.toLowerCase()) ? 'tv' : type.toLowerCase();

export async function fetchNuvioRepository(rawUrl: string, previous?: NuvioRepository): Promise<NuvioRepository> {
  const manifestUrl = normalizeNuvioRepositoryUrl(rawUrl);
  const payload = await fetchText(manifestUrl);
  let manifest: {
    name: string; version: string; description?: string; author?: string; scrapers: NuvioManifestScraper[];
  };
  try {
    manifest = JSON.parse(payload);
  } catch {
    throw new Error('The repository manifest is not valid JSON.');
  }
  if (!manifest.name?.trim() || !manifest.version?.trim() || !Array.isArray(manifest.scrapers) || !manifest.scrapers.length) {
    throw new Error('A Nuvio manifest needs a name, version, and at least one scraper.');
  }
  const baseUrl = manifestUrl.split('?')[0].replace(/\/manifest\.json$/, '');
  const scrapers = await Promise.all(manifest.scrapers.map(async (info): Promise<NuvioScraper | null> => {
    try {
      if (!info.id || !info.name || !info.version || !info.filename) return null;
      const codeUrl = /^https?:\/\//.test(info.filename) ? info.filename : `${baseUrl}/${info.filename.replace(/^\//, '')}`;
      const code = await fetchText(codeUrl);
      const id = `${manifestUrl.toLowerCase()}:${info.id}`;
      const old = previous?.scrapers.find((scraper) => scraper.id === id);
      return {
        ...info,
        id,
        repositoryUrl: manifestUrl,
        enabled: info.enabled === false ? false : old?.enabled ?? true,
        manifestEnabled: info.enabled !== false,
        supportedTypes: info.supportedTypes || ['movie', 'tv'],
        code,
      };
    } catch (error) {
      console.warn(`Unable to install Nuvio scraper ${info.name}`, error);
      return null;
    }
  }));
  const installed = scrapers.filter((scraper): scraper is NuvioScraper => Boolean(scraper));
  if (!installed.length) throw new Error('The repository loaded, but none of its scraper files could be fetched. Check CORS and the repository URLs.');
  return {
    manifestUrl,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    enabled: previous?.enabled ?? true,
    scrapers: installed,
    installedAt: previous?.installedAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function runWorker(
  scraper: NuvioScraper,
  args: Record<string, unknown>,
  mode: 'streams' | 'settings' = 'streams',
  scraperSettings: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./nuvioWorker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The scraper timed out after 30 seconds.'));
    }, 30000);
    worker.onmessage = async (event) => {
      const msg = event.data;
      if (msg?.type === 'fetch-proxy') {
        try {
          const res = await nativeFetchText(msg.url, {
            method: msg.method,
            headers: msg.headers,
            body: msg.body,
            timeoutMs: 18000,
          });
          worker.postMessage({
            type: 'fetch-proxy-response',
            reqId: msg.reqId,
            status: res.status,
            data: res.data,
          });
        } catch (err) {
          worker.postMessage({
            type: 'fetch-proxy-response',
            reqId: msg.reqId,
            error: err instanceof Error ? err.message : 'Proxy fetch failed',
          });
        }
        return;
      }

      window.clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || 'The scraper failed.'));
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || 'The plugin worker could not start.'));
    };
    worker.postMessage({
      code: scraper.code,
      args,
      scraperId: scraper.id,
      settings: scraperSettings,
      tmdbApiKey: getTmdbApiKey(),
      mode,
    });
  });
}

function normalizeResults(raw: any[], scraper: NuvioScraper, repositoryName: string): StreamResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.reduce<StreamResult[]>((results, item, index) => {
    const url = typeof item?.url === 'string' ? item.url : item?.url?.url;
    if (!url && !item?.infoHash) return results;
    results.push({
      id: `${scraper.id}-${index}-${item.infoHash || url}`,
      title: item.title || item.name || 'Stream',
      url: url || `magnet:?xt=urn:btih:${item.infoHash}`,
      sourceName: repositoryName,
      sourceType: 'nuvio',
      quality: item.quality,
      size: item.size,
      language: item.language,
      provider: item.provider || scraper.name,
      seeders: Number(item.seeders) || undefined,
      peers: Number(item.peers) || undefined,
      infoHash: item.infoHash,
      referer: item.referer,
      headers: item.headers,
      subtitles: item.subtitles,
    });
    return results;
  }, []);
}

export async function findNuvioStreams(
  repositories: NuvioRepository[],
  tmdbId: string,
  mediaType: 'movie' | 'series',
  season?: number,
  episode?: number,
  scraperSettingsMap: Record<string, Record<string, unknown>> = {},
): Promise<{ streams: StreamResult[]; errors: SourceError[] }> {
  const type = normalizeType(mediaType);
  const jobs: Array<{ scraper: NuvioScraper; repositoryName: string }> = [];
  repositories.filter((repo) => repo.enabled).forEach((repo) => {
    repo.scrapers.filter((scraper) => scraper.enabled && scraper.supportedTypes.map(normalizeType).includes(type))
      .forEach((scraper) => jobs.push({ scraper, repositoryName: repo.name }));
  });
  const results = await Promise.allSettled(jobs.map(async ({ scraper, repositoryName }) => {
    const raw = await runWorker(
      scraper,
      { tmdbId, mediaType: type, season: season ?? null, episode: episode ?? null },
      'streams',
      scraperSettingsMap[scraper.id] || {},
    );
    return normalizeResults(raw, scraper, repositoryName);
  }));
  const streams: StreamResult[] = [];
  const errors: SourceError[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') streams.push(...result.value);
    else errors.push({ sourceName: jobs[index].scraper.name, message: result.reason?.message || 'Scraper failed.' });
  });
  return { streams, errors };
}

export async function getNuvioScraperSettingsSchema(
  scraper: NuvioScraper,
  currentSettings: Record<string, unknown> = {},
): Promise<NuvioSettingField[]> {
  const raw = await runWorker(scraper, {}, 'settings', currentSettings);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && (item.key || item.name))
    .map((item) => ({
      key: String(item.key || item.name),
      label: item.label || item.title || item.name || String(item.key),
      type: item.type || 'text',
      defaultValue: item.default ?? item.defaultValue ?? '',
      placeholder: item.placeholder,
      description: item.description,
      options: Array.isArray(item.options) ? item.options : undefined,
    }));
}

export async function testNuvioScraper(
  scraper: NuvioScraper,
  repositoryName: string,
  scraperSettings: Record<string, unknown> = {},
) {
  const mediaType = scraper.supportedTypes.map(normalizeType).includes('movie') ? 'movie' : 'tv';
  const raw = await runWorker(scraper, {
    tmdbId: '603', mediaType, season: mediaType === 'tv' ? 1 : null, episode: mediaType === 'tv' ? 1 : null,
  }, 'streams', scraperSettings);
  return normalizeResults(raw, scraper, repositoryName);
}
