import type { NuvioManifestScraper, NuvioRepository, NuvioScraper, SourceError, StreamResult } from '../types';
import { getTmdbApiKey } from './tmdbConfig';

async function fetchText(url: string, timeout = 20000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${new URL(url).hostname}.`);
    return await response.text();
  } finally {
    window.clearTimeout(timer);
  }
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

function runWorker(scraper: NuvioScraper, args: Record<string, unknown>, mode = 'streams'): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./nuvioWorker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The scraper timed out after 30 seconds.'));
    }, 30000);
    worker.onmessage = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || 'The scraper failed.'));
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
      settings: {},
      tmdbApiKey: getTmdbApiKey(),
      mode,
    });
  });
}

function normalizeResults(raw: any[], scraper: NuvioScraper, repositoryName: string): StreamResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.reduce<StreamResult[]>((results, item, index) => {
    const url = typeof item?.url === 'string' ? item.url : item?.url?.url;
    if (!url) return results;
    results.push({
      id: `${scraper.id}-${index}-${item.infoHash || url}`,
      title: item.title || item.name || 'Stream',
      url,
      sourceName: repositoryName,
      sourceType: 'nuvio',
      quality: item.quality,
      size: item.size,
      language: item.language,
      provider: item.provider || scraper.name,
      seeders: Number(item.seeders) || undefined,
      peers: Number(item.peers) || undefined,
      infoHash: item.infoHash,
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
): Promise<{ streams: StreamResult[]; errors: SourceError[] }> {
  const type = normalizeType(mediaType);
  const jobs: Array<{ scraper: NuvioScraper; repositoryName: string }> = [];
  repositories.filter((repo) => repo.enabled).forEach((repo) => {
    repo.scrapers.filter((scraper) => scraper.enabled && scraper.supportedTypes.map(normalizeType).includes(type))
      .forEach((scraper) => jobs.push({ scraper, repositoryName: repo.name }));
  });
  const results = await Promise.allSettled(jobs.map(async ({ scraper, repositoryName }) => {
    const raw = await runWorker(scraper, { tmdbId, mediaType: type, season: season ?? null, episode: episode ?? null });
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

export async function testNuvioScraper(scraper: NuvioScraper, repositoryName: string) {
  const mediaType = scraper.supportedTypes.map(normalizeType).includes('movie') ? 'movie' : 'tv';
  const raw = await runWorker(scraper, {
    tmdbId: '603', mediaType, season: mediaType === 'tv' ? 1 : null, episode: mediaType === 'tv' ? 1 : null,
  });
  return normalizeResults(raw, scraper, repositoryName);
}
