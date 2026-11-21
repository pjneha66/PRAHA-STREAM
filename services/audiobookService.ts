/**
 * Audiobook service.
 *
 * Two layers live in this module:
 *
 *  1. The original "classic" aggregator (`searchAllAudiobooks`,
 *     `getAudiobookChapters`, `CURATED_FEATURED_AUDIOBOOKS`) — unchanged, and
 *     still the default path in `components/AudiobooksView.tsx`.
 *  2. A faithful port of VyseTV's `AudiobookScraperService`
 *     (`searchAudiobooks`, `getChapters`, `Audiobook`) covering the 8 live
 *     scrapers with the exact URL patterns, per-source chapter extraction and
 *     `RelevanceScorer` ordering from the Dart original.
 *
 * Shared-file note: no change to `types.ts`, `App.tsx` or `data/defaults.ts`
 * is required by this port. `AudiobookChapter` gained one optional field
 * (`httpHeaders`) in this file only, so existing callers are unaffected.
 */
import { nativeFetchText } from './androidBridge';

export interface AudiobookItem {
  id: string;
  title: string;
  author?: string;
  coverImage?: string;
  source: string;
  sourceName: string;
  pageUrl: string;
  chapters?: AudiobookChapter[];
}

export interface AudiobookChapter {
  id: string;
  title: string;
  url: string;
  headers?: Record<string, string>;
  duration?: number;
  /**
   * Per-chapter playback headers produced by the ported VyseTV scraper
   * (`Referer` + desktop Chrome `User-Agent`). Kept separate from `headers`
   * so existing callers keep their current shape; the audiobook view maps
   * `httpHeaders` → `headers` when it hands a chapter to the player.
   */
  httpHeaders?: Record<string, string>;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchHtml(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await nativeFetchText(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    timeoutMs: 5000,
  });
  return res.data || '';
}

function cleanTitle(raw: string): string {
  let t = raw
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  t = t.replace(/\[\s*(?:Listen|Download|Audiobook|Stream|MP3|Free)\s*\]/gi, '');
  const quoteMatch = t.match(/["“]([^"”]+)["”]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    t = quoteMatch[1];
  }
  return t.replace(/["“„”'']/g, '')
    .replace(/\s*Audiobook\s*/gi, ' ')
    .replace(/[,:\-–—\s]+$/, '')
    .replace(/^[,:\-–—\s]+/, '')
    .trim();
}

function parseWpResults(html: string, source: string, sourceName: string, prefix: string): AudiobookItem[] {
  const books: AudiobookItem[] = [];
  if (!html) return books;

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const nodes = doc.querySelectorAll('article, .post, .type-post, li.post');
      const elements = nodes.length ? Array.from(nodes) : Array.from(doc.querySelectorAll('h2, h3'));
      for (const el of elements) {
        const link = (el.querySelector('h2 a, h3 a, a') || el) as HTMLAnchorElement | null;
        if (!link) continue;
        const href = link.getAttribute('href') || link.href;
        if (!href || href.startsWith('#') || href.includes('javascript:')) continue;

        const rawTitle = link.textContent || '';
        const title = cleanTitle(rawTitle);
        if (!title || title.length < 2) continue;

        let coverImage = '';
        const img = el.querySelector('img') as HTMLImageElement | null;
        if (img) {
          coverImage = img.getAttribute('data-lazy-src') || img.getAttribute('data-src') || img.getAttribute('src') || '';
          if (coverImage.startsWith('data:image') || coverImage.includes('histats') || coverImage.includes('logo')) {
            coverImage = '';
          }
        }

        books.push({
          id: `${prefix}_${href}`,
          title,
          coverImage,
          source,
          sourceName,
          pageUrl: href,
        });
      }
      if (books.length > 0) return books;
    } catch {
      // Fallback to fast linear regex
    }
  }

  // Linear regex fallback without nested catastrophic backtracking
  const hMatches = html.matchAll(/<h[23][^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi);
  for (const m of hMatches) {
    const url = m[1];
    const rawTitle = m[2];
    const title = cleanTitle(rawTitle);
    if (!title) continue;
    books.push({
      id: `${prefix}_${url}`,
      title,
      coverImage: '',
      source,
      sourceName,
      pageUrl: url,
    });
  }
  return books;
}

function extractAudioSources(html: string): string[] {
  const sources: string[] = [];
  const regex = /(?:<source[^>]*src=["']|<audio[^>]*src=["']|data-audio=["']|data-mp3=["'])(https?:\/\/[^"'>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (m[1].startsWith('http') && (m[1].includes('.mp3') || m[1].includes('.m4a') || m[1].includes('.ogg') || m[1].includes('/audio/'))) {
      if (!sources.includes(m[1])) {
        sources.push(m[1]);
      }
    }
  }
  if (sources.length === 0) {
    const directMp3 = /(https?:\/\/[^"'\s<>]+\.(?:mp3|m4a|ogg))/gi;
    while ((m = directMp3.exec(html)) !== null) {
      if (!m[1].includes('favicon') && !sources.includes(m[1])) {
        sources.push(m[1]);
      }
    }
  }
  return sources;
}

// ── 1. AudiobookBay ─────────────────────────────────────────────────────────

async function searchAudiobookBay(query: string): Promise<AudiobookItem[]> {
  try {
    const url = `https://audiobookbay.lu/?s=${encodeURIComponent(query)}&tt=1&sc=1`;
    const html = await fetchHtml(url);
    if (!html) return [];
    const books: AudiobookItem[] = [];

    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const posts = doc.querySelectorAll('.post');
        for (const post of posts) {
          const link = post.querySelector('a[href*="/abss/"]') as HTMLAnchorElement | null;
          if (!link) continue;
          const href = link.getAttribute('href') || '';
          const pageUrl = href.startsWith('/') ? `https://audiobookbay.lu${href}` : href;
          const title = cleanTitle(link.textContent || '');
          if (!title) continue;

          const img = post.querySelector('img') as HTMLImageElement | null;
          let coverImage = '';
          if (img) {
            const src = img.getAttribute('src') || '';
            if (!src.includes('logo') && !src.includes('default_cover')) {
              coverImage = src.startsWith('/') ? `https://audiobookbay.lu${src}` : src;
            }
          }

          books.push({
            id: `abb_${pageUrl}`,
            title,
            coverImage,
            source: 'audiobookbay',
            sourceName: 'AudiobookBay',
            pageUrl,
          });
        }
        if (books.length > 0) return books;
      } catch {}
    }

    const matches = html.matchAll(/<a[^>]*href="(\/abss\/[^"]+)"[^>]*>([^<]+)<\/a>/gi);
    for (const m of matches) {
      const pageUrl = `https://audiobookbay.lu${m[1]}`;
      const title = cleanTitle(m[2]);
      if (!title) continue;
      books.push({
        id: `abb_${pageUrl}`,
        title,
        coverImage: '',
        source: 'audiobookbay',
        sourceName: 'AudiobookBay',
        pageUrl,
      });
    }
    return books;
  } catch {
    return [];
  }
}

// ── 2. BookAudiobooks ───────────────────────────────────────────────────────

async function searchBookAudioLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://bookaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'bookaudiobooks', 'BookAudio', 'book');
  } catch {
    return [];
  }
}

// ── 3. GoldenAudiobooks ─────────────────────────────────────────────────────

async function searchGoldenLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://goldenaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'goldenaudiobooks', 'Golden Audiobooks', 'golden');
  } catch {
    return [];
  }
}

// ── 4. FullLengthAudiobooks ─────────────────────────────────────────────────

async function searchFullLengthLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://fulllengthaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'fulllengthaudiobooks', 'Full Length Audiobooks', 'full');
  } catch {
    return [];
  }
}

// ── 5. HotAudiobooks ────────────────────────────────────────────────────────

async function searchHotLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://hotaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'hotaudiobooks', 'Hot Audiobooks', 'hot');
  } catch {
    return [];
  }
}

// ── 6. Audiozaic ────────────────────────────────────────────────────────────

async function searchAudiozaicLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://audiozaic.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'audiozaic', 'Audiozaic', 'zaic');
  } catch {
    return [];
  }
}

// ── 7. AudioAZ ──────────────────────────────────────────────────────────────

async function searchAudioAZLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://audioaz.com/en/search?q=${encodeURIComponent(query)}`);
    const regex = /href="(\/en\/(?:audiobook|archive)\/[^"]+)"[^>]*title="([^"]+)"/gi;
    const books: AudiobookItem[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
      const pageUrl = `https://audioaz.com${m[1]}`;
      books.push({
        id: `az_${m[1]}`,
        title: cleanTitle(m[2]),
        source: 'audioaz',
        sourceName: 'AudioAZ',
        pageUrl,
      });
    }
    return books;
  } catch {
    return [];
  }
}

// ── 8. Audiobooks4Soul ──────────────────────────────────────────────────────

async function searchAudiobooks4SoulLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://audiobooks4soul.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'audiobooks4soul', 'Audiobooks4Soul', 'soul');
  } catch {
    return [];
  }
}

// ── 9. Audionest ────────────────────────────────────────────────────────────

async function searchAudionestLegacy(query: string): Promise<AudiobookItem[]> {
  try {
    const res = await nativeFetchText('https://search.audionestapp.com/indexes/trackfiles/search', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer MWJiNWM0MjA2N2ZkM2RiMDNhNWFmNGNk',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, limit: 20 }),
      timeoutMs: 6000,
    });
    if (!res.ok) return [];
    const data = JSON.parse(res.data);
    const hits = data.hits || [];
    return hits.map((hit: any) => ({
      id: `nest_${hit.id}`,
      title: cleanTitle(hit.title || 'Audionest Book'),
      coverImage: hit.thumbnailUrl || hit.img_prefix || '',
      source: 'audionest',
      sourceName: 'Audionest',
      pageUrl: String(hit.id),
    }));
  } catch {
    return [];
  }
}

/**
 * Internet Archive — the `audio_bookspoetry` community collection (75k+ free
 * public-domain audiobook readings: LibriVox poetry, literature, essays).
 * Chapters resolve lazily from the item's metadata API.
 */
async function searchArchiveAudiobooks(query: string): Promise<AudiobookItem[]> {
  const trimmed = query.trim();
  try {
    const titleFilter = trimmed ? ` AND title:(${trimmed})` : '';
    const q = `(collection:audio_bookspoetry) AND mediatype:audio${titleFilter}`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&rows=20&output=json`;
    const res = await nativeFetchText(url, { timeoutMs: 15000 });
    if (!res.ok || !res.data.trim().startsWith('{')) return [];
    const data = JSON.parse(res.data) as { response?: { docs?: Array<Record<string, unknown>> } };
    const docs = data.response?.docs || [];
    return docs
      .filter((doc) => typeof doc.identifier === 'string')
      .map((doc) => {
        const identifier = String(doc.identifier);
        const creator = Array.isArray(doc.creator) ? String(doc.creator[0]) : doc.creator ? String(doc.creator) : undefined;
        return {
          id: `archive:${identifier}`,
          title: String(doc.title || identifier).slice(0, 140),
          author: creator,
          coverImage: `https://archive.org/services/img/${identifier}`,
          source: 'archive',
          sourceName: 'Internet Archive · Poetry & Lit',
          pageUrl: `https://archive.org/details/${identifier}`,
        } satisfies AudiobookItem;
      });
  } catch {
    return [];
  }
}

/** Resolves the mp3 chapter list for an archive.org audio item. */
async function getArchiveAudiobookChapters(book: AudiobookItem): Promise<AudiobookChapter[]> {
  const identifier = book.id.startsWith('archive:') ? book.id.slice('archive:'.length) : book.pageUrl.split('/details/')[1] || '';
  if (!identifier) return [];
  const res = await nativeFetchText(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { timeoutMs: 12000 });
  if (!res.ok || !res.data.trim().startsWith('{')) return [];
  const data = JSON.parse(res.data) as { files?: Array<{ name?: string; format?: string; length?: string; title?: string }> };
  return (data.files || [])
    .filter((file) => file.name && /\.(mp3|m4a|ogg|flac)$/i.test(file.name))
    .slice(0, 200)
    .map((file, idx) => {
      const seconds = file.length ? Number(file.length) || undefined : undefined;
      const name = String(file.name).split('/').pop() || String(file.name);
      return {
        id: `archive-ch-${idx}`,
        title: file.title || name.replace(/\.(mp3|m4a|ogg|flac)$/i, '').replace(/[_-]+/g, ' ').trim() || `Track ${idx + 1}`,
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(String(file.name))}`,
        duration: seconds,
      };
    });
}

// ── Aggregator & Chapter Fetchers ───────────────────────────────────────────

export async function searchAllAudiobooks(query: string): Promise<AudiobookItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const scrapers = [
    searchAudiobookBay(trimmed),
    searchGoldenLegacy(trimmed),
    searchBookAudioLegacy(trimmed),
    searchFullLengthLegacy(trimmed),
    searchHotLegacy(trimmed),
    searchAudiozaicLegacy(trimmed),
    searchAudioAZLegacy(trimmed),
    searchAudiobooks4SoulLegacy(trimmed),
    searchAudionestLegacy(trimmed),
    searchArchiveAudiobooks(trimmed),
  ];

  const results = await Promise.allSettled(scrapers);
  const all: AudiobookItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      all.push(...r.value);
    }
  }

  // Exact & substring match prioritization
  const qLower = trimmed.toLowerCase();
  return all.sort((a, b) => {
    const aExact = a.title.toLowerCase() === qLower ? 2 : a.title.toLowerCase().includes(qLower) ? 1 : 0;
    const bExact = b.title.toLowerCase() === qLower ? 2 : b.title.toLowerCase().includes(qLower) ? 1 : 0;
    return bExact - aExact;
  });
}

export const CURATED_FEATURED_AUDIOBOOKS: AudiobookItem[] = [
  {
    id: 'count-of-monte-cristo-dumas',
    title: 'The Count of Monte Cristo',
    author: 'Alexandre Dumas',
    coverImage: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?auto=format&fit=crop&w=600&q=80',
    source: 'librivox',
    sourceName: 'Curated Classics',
    pageUrl: '',
    chapters: [
      { id: 'mc-1', title: 'Chapter 1: Marseilles — The Arrival', url: 'https://dn720708.ca.archive.org/0/items/count_monte_cristo_0711_librivox/count_of_monte_cristo_001_dumas_64kb.mp3' },
      { id: 'mc-2', title: 'Chapter 2: Father and Son', url: 'https://dn720708.ca.archive.org/0/items/count_monte_cristo_0711_librivox/count_of_monte_cristo_002_dumas_64kb.mp3' },
      { id: 'mc-3', title: 'Chapter 3: The Catalans', url: 'https://dn720708.ca.archive.org/0/items/count_monte_cristo_0711_librivox/count_of_monte_cristo_003_dumas_64kb.mp3' },
      { id: 'mc-4', title: 'Chapter 4: Conspiracy', url: 'https://dn720708.ca.archive.org/0/items/count_monte_cristo_0711_librivox/count_of_monte_cristo_004_dumas_64kb.mp3' },
    ],
  },
  {
    id: 'this-side-of-paradise-fitzgerald',
    title: 'This Side of Paradise',
    author: 'F. Scott Fitzgerald',
    coverImage: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=600&q=80',
    source: 'librivox',
    sourceName: 'Curated Literature',
    pageUrl: '',
    chapters: [
      { id: 'tsp-1', title: 'Book 1: The Romantic Egotist', url: 'https://dn710701.ca.archive.org/0/items/this_side_paradise_librivox/thissideofparadise_01_fitzgerald_64kb.mp3' },
      { id: 'tsp-2', title: 'Book 1, Part 2: Spires and Gargoyles', url: 'https://dn710701.ca.archive.org/0/items/this_side_paradise_librivox/thissideofparadise_02_fitzgerald_64kb.mp3' },
      { id: 'tsp-3', title: 'Book 2: The Education of a Personage', url: 'https://dn710701.ca.archive.org/0/items/this_side_paradise_librivox/thissideofparadise_03_fitzgerald_64kb.mp3' },
    ],
  },
  {
    id: 'the-time-machine-wells',
    title: 'The Time Machine',
    author: 'H.G. Wells',
    coverImage: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=600&q=80',
    source: 'librivox',
    sourceName: 'Curated Classics',
    pageUrl: 'https://archive.org/details/timemachine_sjm_librivox',
    chapters: [
      { id: 'tm-1', title: 'Chapter 1', url: 'https://archive.org/download/timemachine_sjm_librivox/timemachine_01_wells_64kb.mp3' },
      { id: 'tm-2', title: 'Chapter 2', url: 'https://archive.org/download/timemachine_sjm_librivox/timemachine_02_wells_64kb.mp3' },
      { id: 'tm-3', title: 'Chapter 3', url: 'https://archive.org/download/timemachine_sjm_librivox/timemachine_03_wells_64kb.mp3' },
    ],
  },
  {
    id: 'the-art-of-war-sun-tzu',
    title: 'The Art of War',
    author: 'Sun Tzu',
    coverImage: 'https://images.unsplash.com/photo-1544716278-e513176f20b5?auto=format&fit=crop&w=600&q=80',
    source: 'librivox',
    sourceName: 'Curated Non-Fiction',
    pageUrl: 'https://archive.org/details/art_of_war_librivox',
    chapters: [
      { id: 'aow-1', title: 'Books 1–2', url: 'https://archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3' },
      { id: 'aow-2', title: 'Books 3–4', url: 'https://archive.org/download/art_of_war_librivox/art_of_war_03-04_sun_tzu_64kb.mp3' },
      { id: 'aow-3', title: 'Books 5–6', url: 'https://archive.org/download/art_of_war_librivox/art_of_war_05-06_sun_tzu_64kb.mp3' },
    ],
  },
  {
    id: 'sherlock-holmes-doyle',
    title: 'The Adventures of Sherlock Holmes',
    author: 'Arthur Conan Doyle',
    coverImage: 'https://images.unsplash.com/photo-1589829085413-56de8ae18c73?auto=format&fit=crop&w=600&q=80',
    source: 'librivox',
    sourceName: 'LibriVox',
    pageUrl: 'https://archive.org/details/adventures_holmes',
    chapters: [
      { id: 'sh-1', title: 'A Scandal in Bohemia', url: 'https://archive.org/download/adventures_holmes/adventureholmes_01_doyle_64kb.mp3' },
      { id: 'sh-2', title: 'The Red-Headed League', url: 'https://archive.org/download/adventures_holmes/adventureholmes_02_doyle_64kb.mp3' },
    ],
  },
];

export async function getAudiobookChapters(book: AudiobookItem): Promise<AudiobookChapter[]> {
  try {
    if (book.chapters && book.chapters.length > 0) {
      return book.chapters;
    }

    if (book.source === 'archive') {
      return await getArchiveAudiobookChapters(book);
    }

    if (book.source === 'audiobookbay') {
      const html = await fetchHtml(book.pageUrl);
      const audioSources = extractAudioSources(html);
      if (audioSources.length > 0) {
        return audioSources.map((url, i) => ({
          id: `abb-ch-${i + 1}`,
          title: `Chapter ${i + 1}`,
          url,
          headers: { Referer: 'https://audiobookbay.lu/', 'User-Agent': USER_AGENT },
        }));
      }
      // If direct audio not in HTML, check magnet
      const magnetMatch = html.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
      if (magnetMatch) {
        return [{
          id: 'abb-torrent',
          title: 'Full Audiobook (Torrent Stream)',
          url: magnetMatch[1],
        }];
      }
    }

    if (['goldenaudiobooks', 'fulllengthaudiobooks', 'hotaudiobooks', 'bookaudiobooks', 'audioaz'].includes(book.source)) {
      const html = await fetchHtml(book.pageUrl);
      const audioSources = extractAudioSources(html);
      const host = new URL(book.pageUrl).host;
      return audioSources.map((url, i) => ({
        id: `${book.source}-ch-${i + 1}`,
        title: audioSources.length === 1 ? 'Full Audiobook' : `Chapter ${i + 1}`,
        url,
        headers: { Referer: `https://${host}/`, 'User-Agent': USER_AGENT },
      }));
    }

    if (book.source === 'audiozaic') {
      const html = await fetchHtml(book.pageUrl);
      const listenMatch = html.match(/window\.open\('([^']+)'/);
      const listenUrl = listenMatch ? (listenMatch[1].startsWith('/') ? `https://audiozaic.com${listenMatch[1]}` : listenMatch[1]) : book.pageUrl;
      const audioHtml = await fetchHtml(listenUrl);
      const sources = extractAudioSources(audioHtml);
      return sources.map((url, i) => ({
        id: `zaic-ch-${i + 1}`,
        title: `Chapter ${i + 1}`,
        url,
        headers: { Referer: 'https://audiozaic.com/', 'User-Agent': USER_AGENT },
      }));
    }

    if (book.source === 'audiobooks4soul') {
      const html = await fetchHtml(book.pageUrl);
      const dataSrcRegex = /data-src=['"]([^'"]+)['"]/gi;
      const blobs: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = dataSrcRegex.exec(html)) !== null) {
        blobs.push(m[1]);
      }

      const settled = await Promise.all(
        blobs.map(async (blob, i): Promise<(AudiobookChapter & { index: number }) | null> => {
          try {
            const decryptRes = await fetchHtml(
              `https://audiobooks4soul.com/wp-content/plugins/custom-story-audio/inc/security/decrypt.php?encrypted=${encodeURIComponent(blob)}`,
            );
            if (decryptRes.startsWith('http') && !decryptRes.includes('Soulful_Exploration')) {
              return {
                id: `soul-ch-${i + 1}`,
                title: `Chapter ${i + 1}`,
                url: decryptRes.trim(),
                headers: { Referer: 'https://audiobooks4soul.com/', 'User-Agent': USER_AGENT },
                index: i,
              };
            }
          } catch {
            // Continue
          }
          return null;
        }),
      );
      return settled
        .filter((ch): ch is (AudiobookChapter & { index: number }) => ch !== null)
        .sort((a, b) => a.index - b.index)
        .map(({ index: _, ...rest }) => rest);
    }

    if (book.source === 'audionest') {
      const res = await nativeFetchText(`https://api.audionestapp.com/api/v1/tracks/${book.pageUrl}`, {
        headers: { Authorization: 'Bearer MWJiNWM0MjA2N2ZkM2RiMDNhNWFmNGNk' },
        timeoutMs: 6000,
      });
      if (res.ok) {
        const data = JSON.parse(res.data);
        const tracks = data.tracks || [];
        return tracks.map((t: any, i: number) => ({
          id: `nest-ch-${i + 1}`,
          title: t.title || `Part ${i + 1}`,
          url: t.audioUrl || t.streamUrl,
        }));
      }
    }
  } catch {
    // Return empty on failure
  }
  return [];
}

// ───────────────────────────────────────────────────────────────────────────
// VyseTV port — `AudiobookScraperService`
//
// Faithful TypeScript port of lib/services/audiobook/audiobook_scraper_service.dart
// (8 live sources) plus lib/utils/search/relevance_scorer.dart. The classic
// aggregator above is untouched; everything below is additive.
// ───────────────────────────────────────────────────────────────────────────

/** A book row as returned by the VyseTV scrapers (models/audiobook/audiobook_model.dart). */
export interface Audiobook {
  uuid: string;
  audioBookId: string;
  dynamicSlugId: string;
  title: string;
  author?: string;
  coverImage: string;
  source: string;
  pageUrl: string;
}

export type AudiobookSourceId =
  | 'bookaudiobooks'
  | 'goldenaudiobooks'
  | 'fulllengthaudiobooks'
  | 'hotaudiobooks'
  | 'audiozaic'
  | 'audioaz'
  | 'audiobooks4soul'
  | 'audionest';

/** Human labels for the 8 ported sources. */
export const AUDIOBOOK_SOURCE_NAMES: Record<AudiobookSourceId, string> = {
  bookaudiobooks: 'BookAudio',
  goldenaudiobooks: 'Golden Audiobooks',
  fulllengthaudiobooks: 'Full Length Audiobooks',
  hotaudiobooks: 'Hot Audiobooks',
  audiozaic: 'Audiozaic',
  audioaz: 'AudioAZ',
  audiobooks4soul: 'Audiobooks4Soul',
  audionest: 'Audionest',
};

/** Per-source search timeout (the Dart original uses 5s). */
export const AUDIOBOOK_SEARCH_TIMEOUT_MS = 5000;

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** Shorter UA the Dart original attaches to chapter playback headers. */
const CHAPTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const AUDIONEST_SEARCH_URL = 'https://search.audionestapp.com/indexes/trackfiles/search';
const AUDIONEST_SEARCH_KEY = 'MWJiNWM0MjA2N2ZkM2RiMDNhNWFmNGNk';
const AUDIONEST_FIRESTORE_URL =
  'https://firestore.googleapis.com/v1/projects/learningfirebase-ae02f/databases/(default)/documents:runQuery';
const AUDIONEST_API_KEY = 'AIzaSyAG-z_yl0_55NEYTEKGoVJyixtHG-FhnfA';

/** Builds the `Referer: https://{host}/` every source request needs. */
function refererFor(url: string): string {
  try {
    return `https://${new URL(url).host}/`;
  } catch {
    return '';
  }
}

/**
 * Races `task` against a timer, resolving with `fallback` on timeout or
 * rejection. The timer is always cleared, so no handle is left behind.
 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    task.then(finish, () => finish(fallback));
  });
}

/** GETs a page through the native bridge with the desktop UA + host Referer. */
async function fetchSourceHtml(url: string, timeoutMs = AUDIOBOOK_SEARCH_TIMEOUT_MS): Promise<string> {
  const res = await nativeFetchText(url, {
    headers: { 'User-Agent': DESKTOP_CHROME_UA, Referer: refererFor(url) },
    timeoutMs,
  });
  return res.data || '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Port of `_extractWpAudio`: every `<source ... src="...">` in a book page. */
function extractWpSourceUrls(html: string): string[] {
  const urls: string[] = [];
  const regex = /<source[^>]*src="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    if (match[1] && !urls.includes(match[1])) urls.push(match[1]);
  }
  return urls;
}

/** Port of `_cleanAudiobookTitle`. */
function cleanAudiobookTitle(rawTitle: string): string {
  let title = rawTitle
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  title = title.replace(/\[\s*(?:Listen|Download|Audiobook|Stream|MP3|Free)\s*\]/gi, '');

  const quoteMatch = title.match(/["“”]([^"“”]+)["“”]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    title = quoteMatch[1];
  }

  const cleaned = title
    .replace(/["“”„‘’]/g, '')
    .replace(/\s*Audiobook\s*/gi, ' ')
    .replace(/[,:\-–—\s]+$/, '')
    .replace(/^[,:\-–—\s]+/, '')
    .trim();

  return cleaned || rawTitle.trim();
}

/** Port of `_parseWordPressResults` (block → `h2/h3 > a` → cover image). */
function parseWordPressResults(html: string, source: string, prefix: string): Audiobook[] {
  const books: Audiobook[] = [];
  if (!html) return books;

  const blockExp =
    /(?:<article[^>]*>|<div[^>]*class="[^"]*post[^"]*"[^>]*>|<li[^>]*class="[^"]*post[^"]*"[^>]*>)([\s\S]*?)(?:<\/article>|div<!-- end .post -->|<\/div>\s*<\/article>|<\/li>)/gi;
  const blocks: string[] = [];
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockExp.exec(html)) !== null) {
    blocks.push(blockMatch[1] ?? '');
  }
  const candidates = blocks.length > 0 ? blocks : [html];

  for (const block of candidates) {
    const titleMatch = block.match(/<h[23][^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
    if (!titleMatch) continue;

    const url = titleMatch[1];
    const title = cleanAudiobookTitle(titleMatch[2]);
    if (!url || !title) continue;

    let coverImage = '';
    const imgMatch = block.match(/<img[^>]+>/i);
    if (imgMatch) {
      const imgTag = imgMatch[0];
      for (const attr of ['data-lazy-src', 'data-src', 'src']) {
        const attrMatch = imgTag.match(new RegExp(`${attr}="([^"]+)"`, 'i'));
        if (!attrMatch) continue;
        const value = attrMatch[1];
        if (
          !value.startsWith('data:image') &&
          !value.includes('histats.com') &&
          !value.includes('yandex.ru')
        ) {
          coverImage = value;
          break;
        }
      }
    }

    books.push({
      uuid: `${prefix}_${url}`,
      audioBookId: url,
      dynamicSlugId: url,
      title,
      coverImage: coverImage.trim(),
      source,
      pageUrl: url,
    });
  }
  return books;
}

// ── Per-source searches ─────────────────────────────────────────────────────

async function searchBookAudio(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://bookaudiobooks.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'bookaudiobooks', 'book');
}

async function searchGolden(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://goldenaudiobooks.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'goldenaudiobooks', 'golden');
}

async function searchFullLength(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://fulllengthaudiobooks.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'fulllengthaudiobooks', 'full');
}

async function searchHot(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://hotaudiobooks.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'hotaudiobooks', 'hot');
}

async function searchAudiozaic(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://audiozaic.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'audiozaic', 'zaic');
}

async function searchAudioAZ(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://audioaz.com/en/search?q=${encodeURIComponent(query)}`);
  const books: Audiobook[] = [];
  const regex = /href="(\/en\/(?:audiobook|archive)\/[^"]+)"[^>]*title="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const path = match[1];
    const pageUrl = `https://audioaz.com${path}`;
    books.push({
      uuid: `az_${path}`,
      audioBookId: pageUrl,
      dynamicSlugId: pageUrl,
      title: cleanAudiobookTitle(match[2]).trim(),
      coverImage: '',
      source: 'audioaz',
      pageUrl,
    });
  }
  return books;
}

async function searchAudiobooks4Soul(query: string): Promise<Audiobook[]> {
  const html = await fetchSourceHtml(`https://audiobooks4soul.com/?s=${encodeURIComponent(query)}`);
  return parseWordPressResults(html, 'audiobooks4soul', 'soul');
}

async function searchAudionest(query: string): Promise<Audiobook[]> {
  const res = await nativeFetchText(AUDIONEST_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUDIONEST_SEARCH_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': DESKTOP_CHROME_UA,
      Referer: 'https://search.audionestapp.com/',
    },
    body: JSON.stringify({ q: query, limit: 30 }),
    timeoutMs: AUDIOBOOK_SEARCH_TIMEOUT_MS,
  });
  if (!res.ok) return [];

  const data = parseJsonObject(res.data);
  if (!data) return [];

  const books: Audiobook[] = [];
  for (const rawHit of asArray(data.hits)) {
    const hit = asRecord(rawHit);
    if (!hit) continue;
    const id = hit.id === undefined || hit.id === null ? '' : String(hit.id);
    if (!id) continue;
    const cover = asString(hit.thumbnailUrl) || asString(hit.img_prefix);
    books.push({
      uuid: `nest_${id}`,
      audioBookId: id,
      dynamicSlugId: id,
      title: asString(hit.title),
      coverImage: cover.trim(),
      source: 'audionest',
      pageUrl: id,
    });
  }
  return books;
}

// ── Relevance (port of RelevanceScorer) ─────────────────────────────────────

function normalizeForScore(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripArticles(value: string): string {
  return value.replace(/^(?:the|a|an)\s+/i, '').trim();
}

/**
 * Port of VyseTV's `RelevanceScorer.score`. Higher is better; an exact title
 * match (with or without a leading article) scores 10000.
 */
export function audiobookRelevanceScore(title: string, query: string): number {
  const cleanTitle = normalizeForScore(title);
  const cleanQuery = normalizeForScore(query);
  if (!cleanTitle || !cleanQuery) return 0;

  const strippedTitle = stripArticles(cleanTitle);
  const strippedQuery = stripArticles(cleanQuery);

  if (cleanTitle === cleanQuery || strippedTitle === strippedQuery) return 10000;

  let total = 0;

  if (cleanTitle.includes(cleanQuery) || strippedTitle.includes(strippedQuery)) total += 5000;
  if (cleanTitle.startsWith(cleanQuery) || strippedTitle.startsWith(strippedQuery)) total += 3000;

  const queryTokens = cleanQuery.split(/\s+/).filter(Boolean);
  const titleTokens = new Set(cleanTitle.split(/\s+/).filter(Boolean));

  if (queryTokens.length > 0) {
    let matched = 0;
    for (const qToken of queryTokens) {
      if (titleTokens.has(qToken)) {
        matched += 1;
        continue;
      }
      const partial = Array.from(titleTokens).some((t) => t.includes(qToken) || qToken.includes(t));
      if (partial) matched += 1;
    }
    const ratio = matched / queryTokens.length;
    if (queryTokens.length > 1 && ratio < 1) {
      // Multi-word query that misses a term is capped hard, exactly as in Dart.
      total = (total + ratio * 200) * 0.1;
    } else {
      total += ratio * 1000;
      if (ratio === 1) total += 2000;
    }
  }

  return total;
}

const SEARCH_SCRAPERS: ReadonlyArray<(query: string) => Promise<Audiobook[]>> = [
  searchBookAudio,
  searchGolden,
  searchFullLength,
  searchHot,
  searchAudiozaic,
  searchAudioAZ,
  searchAudiobooks4Soul,
  searchAudionest,
];

/**
 * Searches all 8 ported sources in parallel (bounded: exactly one request per
 * source, `Promise.allSettled`, 5s timeout each) and returns the merged list
 * ordered by relevance to `query`.
 */
export async function searchAudiobooks(query: string): Promise<Audiobook[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const settled = await Promise.allSettled(
    SEARCH_SCRAPERS.map((scraper) =>
      withTimeout(scraper(trimmed), AUDIOBOOK_SEARCH_TIMEOUT_MS, [] as Audiobook[]),
    ),
  );

  const all: Audiobook[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }

  return all
    .map((book, index) => ({ book, index, score: audiobookRelevanceScore(book.title, trimmed) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.book);
}

// ── Chapter extraction ──────────────────────────────────────────────────────

function buildChapters(prefix: string, urls: string[], referer: string, titles?: string[]): AudiobookChapter[] {
  return urls.map((url, index) => ({
    id: `${prefix}-ch-${index + 1}`,
    title: titles?.[index] ?? `Chapter ${index + 1}`,
    url,
    httpHeaders: { Referer: referer, 'User-Agent': CHAPTER_UA },
  }));
}

/** WordPress sources: chapters are the `<source src>` tags on the book page. */
async function getStandardWpChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  const html = await fetchSourceHtml(book.pageUrl);
  const streams = extractWpSourceUrls(html);
  return buildChapters(book.source, streams, refererFor(book.pageUrl));
}

async function getAudiozaicChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  const html = await fetchSourceHtml(book.pageUrl);
  const match = html.match(/window\.open\('([^']+)'/);
  if (!match) return [];

  let listenUrl = match[1];
  if (listenUrl.startsWith('/')) listenUrl = `https://audiozaic.com${listenUrl}`;

  const audioPage = await fetchSourceHtml(listenUrl);
  const streams = extractWpSourceUrls(audioPage);
  return buildChapters('audiozaic', streams, 'https://audiozaic.com/');
}

async function getAudioAZChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  const html = await fetchSourceHtml(book.pageUrl);
  const streams = extractWpSourceUrls(html);
  const titles = streams.map((_url, index) => (streams.length === 1 ? 'Full Audiobook' : `Part ${index + 1}`));
  return buildChapters('audioaz', streams, 'https://audioaz.com/', titles);
}

async function getAudiobooks4SoulChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  const html = await fetchSourceHtml(book.pageUrl);
  const playlistMatch = html.match(/<div[^>]*class="[^"]*simp-playlist[^"]*"[\s\S]*?<\/div>/i);
  if (!playlistMatch) return [];

  const blobs: string[] = [];
  const dataSrcExp = /data-src=(?:'|")([^'"]+)(?:'|")/g;
  let match: RegExpExecArray | null;
  while ((match = dataSrcExp.exec(playlistMatch[0])) !== null) {
    blobs.push(match[1]);
  }

  const chapters: AudiobookChapter[] = [];
  let chapterNum = 1;
  for (const blob of blobs) {
    try {
      const decryptUrl =
        'https://audiobooks4soul.com/wp-content/plugins/custom-story-audio/inc/security/decrypt.php' +
        `?encrypted=${encodeURIComponent(blob)}`;
      const res = await nativeFetchText(decryptUrl, {
        headers: { 'User-Agent': DESKTOP_CHROME_UA, Referer: 'https://audiobooks4soul.com/' },
        timeoutMs: AUDIOBOOK_SEARCH_TIMEOUT_MS,
      });
      const body = (res.data || '').trim();
      if (res.status !== 200 || !body.startsWith('http')) continue;
      if (body.includes('Soulful_Exploration')) continue;
      chapters.push({
        id: `audiobooks4soul-ch-${chapterNum}`,
        title: `Chapter ${chapterNum}`,
        url: body,
        httpHeaders: { Referer: 'https://audiobooks4soul.com/', 'User-Agent': CHAPTER_UA },
      });
      chapterNum += 1;
    } catch {
      // Skip a chapter that will not decrypt; the rest still play.
    }
  }
  return chapters;
}

let audionestIdToken: string | null = null;
let audionestTokenExpiry = 0;

async function audionestEnsureToken(force = false): Promise<string | null> {
  if (!force && audionestIdToken && Date.now() < audionestTokenExpiry) return audionestIdToken;
  try {
    const res = await nativeFetchText(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${AUDIONEST_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
        timeoutMs: AUDIOBOOK_SEARCH_TIMEOUT_MS,
      },
    );
    if (res.status !== 200) return null;
    const data = parseJsonObject(res.data);
    if (!data) return null;
    const token = asString(data.idToken);
    if (!token) return null;
    const expiresIn = Number.parseInt(asString(data.expiresIn) || '3600', 10) || 3600;
    audionestIdToken = token;
    audionestTokenExpiry = Date.now() + Math.max(0, expiresIn - 60) * 1000;
    return token;
  } catch {
    return null;
  }
}

/** Reads `document.fields.urlLink.arrayValue.values[].stringValue` from runQuery. */
function parseFirestoreUrlLinks(raw: string): string[] {
  const entries = parseJsonArray(raw);
  if (!entries) return [];
  for (const entry of entries) {
    const row = asRecord(entry);
    if (!row) continue;
    const document = asRecord(row.document);
    if (!document) continue;
    const fields = asRecord(document.fields);
    if (!fields) continue;
    const urlLink = asRecord(fields.urlLink);
    const arrayValue = urlLink ? asRecord(urlLink.arrayValue) : null;
    const values = arrayValue ? asArray(arrayValue.values) : [];
    const urls: string[] = [];
    for (const value of values) {
      const record = asRecord(value);
      const stringValue = record ? asString(record.stringValue) : '';
      if (stringValue) urls.push(stringValue);
    }
    if (urls.length > 0) return urls;
  }
  return [];
}

async function getAudionestChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  let token = await audionestEnsureToken();
  if (!token) return [];

  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'TrackFiles' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'book_id' },
          op: 'EQUAL',
          value: { integerValue: book.audioBookId },
        },
      },
      limit: 1,
    },
  });

  const runQuery = (idToken: string): Promise<{ ok: boolean; status: number; data: string }> =>
    nativeFetchText(AUDIONEST_FIRESTORE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        'User-Agent': DESKTOP_CHROME_UA,
        Referer: 'https://firestore.googleapis.com/',
      },
      body,
      timeoutMs: AUDIOBOOK_SEARCH_TIMEOUT_MS,
    });

  let res = await runQuery(token);
  if (res.status === 401 || res.status === 403) {
    const refreshed = await audionestEnsureToken(true);
    if (!refreshed) return [];
    token = refreshed;
    res = await runQuery(token);
  }
  if (res.status !== 200) return [];

  const urls = parseFirestoreUrlLinks(res.data);
  const titles = urls.map((_url, index) => (urls.length === 1 ? 'Full Audiobook' : `Chapter ${index + 1}`));
  return urls.map((url, index) => ({
    id: `audionest-ch-${index + 1}`,
    title: titles[index],
    url,
  }));
}

/**
 * Resolves the playable chapter list for a book produced by
 * {@link searchAudiobooks}. Never throws: a failing source yields `[]`.
 */
export async function getChapters(book: Audiobook): Promise<AudiobookChapter[]> {
  try {
    switch (book.source) {
      case 'goldenaudiobooks':
      case 'fulllengthaudiobooks':
      case 'hotaudiobooks':
      case 'bookaudiobooks':
      case 'audiobooks4soul':
        return book.source === 'audiobooks4soul'
          ? await getAudiobooks4SoulChapters(book)
          : await getStandardWpChapters(book);
      case 'audiozaic':
        return await getAudiozaicChapters(book);
      case 'audioaz':
        return await getAudioAZChapters(book);
      case 'audionest':
        return await getAudionestChapters(book);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

