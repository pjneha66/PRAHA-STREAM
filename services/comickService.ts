import { isAndroidApp, nativeFetchText } from './androidBridge';

/**
 * Comick source (https://comick-source-api.notaspider.dev) — an aggregator
 * gateway over MangaPark/Vortex/Mgeko/WeebCentral-style sites. The API exposes
 * search (NDJSON, one JSON batch per upstream source) and chapter lists, but
 * NOT page images; chapter pages are scraped directly from the aggregator.
 *
 * The API sends no CORS headers at all, so plain desktop browsers cannot reach
 * it: in a browser the calls relay through the vite dev/preview server
 * (`/comick-api`, `/comick-page` — see comickRelayPlugin in vite.config.ts),
 * while the Android app talks to it directly over nativeFetchText.
 */

const COMICK_API_ORIGIN = 'https://comick-source-api.notaspider.dev';
const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const API_SEARCH = new URL('/api/search', COMICK_API_ORIGIN).toString();
const API_CHAPTERS = new URL('/api/chapters', COMICK_API_ORIGIN).toString();
const BROWSER_RELAY_SEARCH = '/comick-api/api/search';
const BROWSER_RELAY_CHAPTERS = '/comick-api/api/chapters';
const browserNeedsRelay = (): boolean => !isAndroidApp();

export interface ComickSeries {
  /** Composite id: `${sourceLabel}|${upstreamId|url}` */
  id: string;
  sourceLabel: string;
  title: string;
  /** Absolute series URL on the aggregator (used for chapter resolution). */
  url: string;
  cover?: string;
  latestChapter?: number;
}

export interface ComickChapter {
  /** Absolute chapter URL on the aggregator (used for page scraping). */
  url: string;
  title: string;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Upstream sources with "Active" status (from the API's /api/sources list
 * cross-checked against the upstream health table). Shutdown (MangaPark,
 * Weebdex, Bato, Falcon) and Unstable entries are excluded — searching them
 * only wastes seconds of the 30s stream window and returns 403s.
 */
const ACTIVE_SOURCES = [
  'arven-comics', 'asmodeus-scans', 'asurascan', 'athrea-scans', 'demonicscans',
  'elf-toon', 'eva-scans', 'flamecomics', 'galaxy-degen-scans', 'hades-scans',
  'kappabeast', 'kdt-scans', 'kenscans', 'ks-group', 'kuramanga', 'lagoonscans',
  'lhtranslation', 'lua-comic', 'madarascans', 'magus-manga', 'mangago',
  'mangakatana', 'mangaread', 'mangasushi', 'mangataro', 'manhuaplus', 'mgeko',
  'novelcool', 'project-suki', 'rd-scans', 'ritharscans', 'rizz-fables',
  'rokari-comics', 'scythe-scans', 'spider-scans', 'stonescape', 'thunderscans',
  'topmanhua', 'utoon', 'violetscans', 'vortex-scans', 'webtoon', 'weebcentral',
  "writers'-scans", 'yaksha-comics', 'yaksha-scans',
];

/** Display names for the Comick source dropdown (id → label). */
export const COMICK_SOURCE_OPTIONS: Array<{ id: string; name: string }> = [
  { id: 'arven-comics', name: 'Arven Comics' },
  { id: 'asmodeus-scans', name: 'Asmodeus Scans' },
  { id: 'asurascan', name: 'AsuraScan' },
  { id: 'athrea-scans', name: 'Athrea Scans' },
  { id: 'demonicscans', name: 'DemonicScans' },
  { id: 'elf-toon', name: 'Elf Toon' },
  { id: 'eva-scans', name: 'Eva Scans' },
  { id: 'flamecomics', name: 'FlameComics' },
  { id: 'galaxy-degen-scans', name: 'Galaxy Degen Scans' },
  { id: 'hades-scans', name: 'Hades Scans' },
  { id: 'kappabeast', name: 'KappaBeast' },
  { id: 'kdt-scans', name: 'KDT Scans' },
  { id: 'kenscans', name: 'Kenscans' },
  { id: 'ks-group', name: 'KS Group' },
  { id: 'kuramanga', name: 'KuraManga' },
  { id: 'lagoonscans', name: 'LagoonScans' },
  { id: 'lhtranslation', name: 'LHTranslation' },
  { id: 'lua-comic', name: 'Lua Comic' },
  { id: 'madarascans', name: 'Madarascans' },
  { id: 'magus-manga', name: 'Magus Manga' },
  { id: 'mangago', name: 'Mangago' },
  { id: 'mangakatana', name: 'MangaKatana' },
  { id: 'mangaread', name: 'MangaRead' },
  { id: 'mangasushi', name: 'Mangasushi' },
  { id: 'mangataro', name: 'Mangataro' },
  { id: 'manhuaplus', name: 'Manhuaplus' },
  { id: 'mgeko', name: 'Mgeko' },
  { id: 'novelcool', name: 'NovelCool' },
  { id: 'project-suki', name: 'Project Suki' },
  { id: 'rd-scans', name: 'RD Scans' },
  { id: 'ritharscans', name: 'Ritharscans' },
  { id: 'rizz-fables', name: 'Rizz Fables' },
  { id: 'rokari-comics', name: 'Rokari Comics' },
  { id: 'scythe-scans', name: 'Scythe Scans' },
  { id: 'spider-scans', name: 'Spider Scans' },
  { id: 'stonescape', name: 'Stonescape' },
  { id: 'thunderscans', name: 'Thunderscans' },
  { id: 'topmanhua', name: 'TopManhua' },
  { id: 'utoon', name: 'UTOON' },
  { id: 'violetscans', name: 'Violetscans' },
  { id: 'vortex-scans', name: 'Vortex Scans' },
  { id: 'webtoon', name: 'WEBTOON' },
  { id: 'weebcentral', name: 'WeebCentral' },
  { id: "writers'-scans", name: "Writers' Scans" },
  { id: 'yaksha-comics', name: 'Yaksha Comics' },
  { id: 'yaksha-scans', name: 'Yaksha Scans' },
];

/** Raw search against one source id (verbatim — no dash conversion). */
async function searchComickSourceRaw(query: string, source: string, signal?: AbortSignal): Promise<ComickSeries[]> {
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const res = await nativeFetchText(browserNeedsRelay() ? BROWSER_RELAY_SEARCH : API_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, source }),
    timeoutMs: 50000,
  });
  if (!res.ok || !res.data) return [];
  const series: ComickSeries[] = [];
  for (const line of res.data.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('{')) continue;
    try {
      const batch = JSON.parse(trimmedLine) as { source?: string; results?: Array<Record<string, unknown>> };
      const sourceLabel = String(batch.source || source);
      for (const entry of batch.results || []) {
        const url = String(entry.url || '');
        const title = String(entry.title || '').trim();
        if (!isHttpUrl(url) || !title) continue;
        series.push({
          id: `${sourceLabel}|${String(entry.id ?? url)}`,
          sourceLabel,
          title,
          url,
          cover: typeof entry.coverImage === 'string' && isHttpUrl(entry.coverImage) ? entry.coverImage : undefined,
          latestChapter: Number(entry.latestChapter) || undefined,
        });
      }
    } catch {
      // Malformed batch line — skip it.
    }
  }
  return series;
}

/** Per-source search — converts the dash id to the search endpoint's space form. */
async function searchComickSource(query: string, source: string, signal?: AbortSignal): Promise<ComickSeries[]> {
  // The search endpoint validates source ids with SPACES ("vortex scans"),
  // unlike /api/sources which uses dashes ("vortex-scans").
  return searchComickSourceRaw(query, source.replaceAll('-', ' '), signal);
}

/**
 * Search Comick. Two transports:
 *  - Android (direct native): ONE 'all' request — the upstream streams every
 *    source's NDJSON batch and closes after ~30s; a single request avoids
 *    queueing 46 jobs behind the ~6-worker native HTTP pool. (nativeFetchText
 *    buffers until close, so batches can't be streamed to the UI here.)
 *  - Desktop browser (relay): ONE streaming request (/comick-stream) that
 *    pushes each source's NDJSON batch as it completes — `onBatch` fires
 *    progressively and the first results land in a few seconds.
 */
export async function searchComick(
  query: string,
  subSource?: string,
  options?: { signal?: AbortSignal; onBatch?: (batch: ComickSeries[]) => void },
): Promise<ComickSeries[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const signal = options?.signal;
  const seen = new Set<string>();
  const dedupe = (entries: ComickSeries[]): ComickSeries[] =>
    entries.filter((entry) => {
      const key = entry.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const parseBatches = (data: string): ComickSeries[] => {
    const series: ComickSeries[] = [];
    for (const line of data.split('\n')) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith('{')) continue;
      try {
        const batch = JSON.parse(trimmedLine) as { source?: string; results?: Array<Record<string, unknown>> };
        const sourceLabel = String(batch.source || 'Comick');
        for (const entry of batch.results || []) {
          const url = String(entry.url || '');
          const title = String(entry.title || '').trim();
          if (!isHttpUrl(url) || !title) continue;
          series.push({
            id: `${sourceLabel}|${String(entry.id ?? url)}`,
            sourceLabel,
            title,
            url,
            cover: typeof entry.coverImage === 'string' && isHttpUrl(entry.coverImage) ? entry.coverImage : undefined,
            latestChapter: Number(entry.latestChapter) || undefined,
          });
        }
      } catch {
        // Malformed batch line — skip it.
      }
    }
    return series;
  };

  // Browser: one streaming relay request, batches parsed as they arrive.
  if (browserNeedsRelay()) {
    const series: ComickSeries[] = [];
    try {
      const response = await fetch('/comick-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, source: subSource || 'all' }),
        signal,
      });
      if (!response.ok || !response.body) return [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let done = false;
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        done = Boolean(streamDone);
        if (value) {
          lineBuf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).trim();
            lineBuf = lineBuf.slice(idx + 1);
            if (!line.startsWith('{')) continue;
            const batch = parseBatches(line);
            const fresh = batch.filter((entry) => {
              const key = entry.title.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            if (fresh.length) {
              series.push(...fresh);
              options?.onBatch?.(fresh);
            }
          }
        }
      }
    } catch {
      return dedupe(series).slice(0, 40);
    }
    return series.slice(0, 40);
  }

  // Device: single native request (all sources) or a single chosen source.
  const source = subSource || 'all';
  const searchSource = source === 'all' ? source : source.replaceAll('-', ' ');
  const batches = await searchComickSourceRaw(trimmed, searchSource, signal);
  return dedupe(batches).slice(0, 40);
}

/** Chapter list for a series page URL on its aggregator. */
export async function comickChapters(seriesUrl: string): Promise<ComickChapter[]> {
  if (!isHttpUrl(seriesUrl)) return [];
  try {
    const res = await nativeFetchText(browserNeedsRelay() ? BROWSER_RELAY_CHAPTERS : API_CHAPTERS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: seriesUrl }),
      timeoutMs: 50000,
    });
    if (!res.ok || !res.data) return [];
    const parsed = JSON.parse(res.data) as { chapters?: Array<{ id?: string | number; number?: number; title?: string; url?: string }> };
    const chapters: ComickChapter[] = [];
    for (const chapter of parsed.chapters || []) {
      const url = String(chapter.url || '');
      if (!isHttpUrl(url)) continue;
      const number = Number(chapter.number);
      const title = String(chapter.title || '').trim() || (Number.isFinite(number) ? `Chapter ${number}` : 'Chapter');
      chapters.push({ url, title });
    }
    return chapters;
  } catch {
    return [];
  }
}

/**
 * Pulls page images out of an aggregator chapter page. Covers and site chrome
 * live in different directories than the actual pages, so the largest group of
 * same-directory images wins.
 */
export async function comickChapterImages(chapterUrl: string): Promise<string[]> {
  if (!isHttpUrl(chapterUrl)) return [];
  try {
    // Browser: scrape through the vite relay (aggregators block cross-origin
    // reads); device: fetch the chapter page directly over nativeFetchText.
    const fetchUrl = browserNeedsRelay()
      ? '/comick-page?url=' + encodeURIComponent(chapterUrl)
      : chapterUrl;
    const res = await nativeFetchText(fetchUrl, {
      headers: { 'User-Agent': SCRAPER_UA, Accept: 'text/html' },
      timeoutMs: 25000,
    });
    if (!res.ok || !res.data) return [];
    return extractPageImages(res.data, chapterUrl);
  } catch {
    return [];
  }
}

const IMAGE_SUFFIXES = ['.webp', '.jpg', '.jpeg', '.png'];

export function extractPageImages(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    try {
      const url = new URL(raw, baseUrl).toString();
      const lower = url.toLowerCase();
      if (!IMAGE_SUFFIXES.some((suffix) => lower.includes(suffix))) return;
      if (/\.(svg|ico)/i.test(url)) return;
      if (/(logo|banner|icon|avatar|favicon|placeholder)/i.test(url)) return;
      if (!found.includes(url)) found.push(url);
    } catch {
      // Malformed URL fragment — skip.
    }
  };

  // Regex-free extraction: split tags and attribute values on plain strings.
  for (const tag of html.split('<img').slice(1)) {
    const tagBody = tag.split('>')[0] || '';
    for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'src', 'srcset']) {
      for (const quote of ['"', "'"]) {
        const marker = `${attr}=${quote}`;
        const start = tagBody.indexOf(marker);
        if (start === -1) continue;
        const valueStart = start + marker.length;
        const end = tagBody.indexOf(quote, valueStart);
        if (end === -1) continue;
        for (const piece of tagBody.slice(valueStart, end).split(',')) {
          push(piece.trim().split(' ')[0] || '');
        }
      }
    }
  }
  // Raw URLs embedded in scripts (Next.js hydration payloads etc.).
  for (const chunk of html.split('"')) {
    for (const piece of chunk.split(' ')) {
      const trimmedPiece = piece.trim();
      const lower = trimmedPiece.toLowerCase();
      if (lower.startsWith('https://') || lower.startsWith('http://')) push(trimmedPiece);
      else if (lower.startsWith('/_next') === false && lower.startsWith('/') && IMAGE_SUFFIXES.some((suffix) => lower.includes(suffix))) push(trimmedPiece);
    }
  }

  // Group by directory and keep the largest group (the actual page set).
  const groups = new Map<string, string[]>();
  for (const url of found) {
    const dir = new URL('.', url).toString();
    const bucket = groups.get(dir) || [];
    bucket.push(url);
    groups.set(dir, bucket);
  }
  let best: string[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  return best.slice(0, 80);
}
