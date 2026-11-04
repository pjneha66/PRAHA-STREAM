import { nativeFetchText } from './androidBridge';

export interface AudiobookItem {
  id: string;
  title: string;
  author?: string;
  coverImage?: string;
  source: string;
  sourceName: string;
  pageUrl: string;
}

export interface AudiobookChapter {
  id: string;
  title: string;
  url: string;
  headers?: Record<string, string>;
  duration?: number;
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
  const regex = /<source[^>]*src="([^"]+)"/gi;
  const sources: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (m[1].startsWith('http') && (m[1].includes('.mp3') || m[1].includes('.m4a') || m[1].includes('.ogg') || m[1].includes('/audio/'))) {
      sources.push(m[1]);
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

async function searchBookAudio(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://bookaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'bookaudiobooks', 'BookAudio', 'book');
  } catch {
    return [];
  }
}

// ── 3. GoldenAudiobooks ─────────────────────────────────────────────────────

async function searchGolden(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://goldenaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'goldenaudiobooks', 'Golden Audiobooks', 'golden');
  } catch {
    return [];
  }
}

// ── 4. FullLengthAudiobooks ─────────────────────────────────────────────────

async function searchFullLength(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://fulllengthaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'fulllengthaudiobooks', 'Full Length Audiobooks', 'full');
  } catch {
    return [];
  }
}

// ── 5. HotAudiobooks ────────────────────────────────────────────────────────

async function searchHot(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://hotaudiobooks.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'hotaudiobooks', 'Hot Audiobooks', 'hot');
  } catch {
    return [];
  }
}

// ── 6. Audiozaic ────────────────────────────────────────────────────────────

async function searchAudiozaic(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://audiozaic.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'audiozaic', 'Audiozaic', 'zaic');
  } catch {
    return [];
  }
}

// ── 7. AudioAZ ──────────────────────────────────────────────────────────────

async function searchAudioAZ(query: string): Promise<AudiobookItem[]> {
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

async function searchAudiobooks4Soul(query: string): Promise<AudiobookItem[]> {
  try {
    const html = await fetchHtml(`https://audiobooks4soul.com/?s=${encodeURIComponent(query)}`);
    return parseWpResults(html, 'audiobooks4soul', 'Audiobooks4Soul', 'soul');
  } catch {
    return [];
  }
}

// ── 9. Audionest ────────────────────────────────────────────────────────────

async function searchAudionest(query: string): Promise<AudiobookItem[]> {
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

// ── Aggregator & Chapter Fetchers ───────────────────────────────────────────

export async function searchAllAudiobooks(query: string): Promise<AudiobookItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const scrapers = [
    searchAudiobookBay(trimmed),
    searchGolden(trimmed),
    searchBookAudio(trimmed),
    searchFullLength(trimmed),
    searchHot(trimmed),
    searchAudiozaic(trimmed),
    searchAudioAZ(trimmed),
    searchAudiobooks4Soul(trimmed),
    searchAudionest(trimmed),
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

export async function getAudiobookChapters(book: AudiobookItem): Promise<AudiobookChapter[]> {
  try {
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

      const chapters: AudiobookChapter[] = [];
      for (let i = 0; i < blobs.length; i++) {
        try {
          const decryptRes = await fetchHtml(
            `https://audiobooks4soul.com/wp-content/plugins/custom-story-audio/inc/security/decrypt.php?encrypted=${encodeURIComponent(blobs[i])}`,
          );
          if (decryptRes.startsWith('http') && !decryptRes.includes('Soulful_Exploration')) {
            chapters.push({
              id: `soul-ch-${i + 1}`,
              title: `Chapter ${i + 1}`,
              url: decryptRes.trim(),
              headers: { Referer: 'https://audiobooks4soul.com/', 'User-Agent': USER_AGENT },
            });
          }
        } catch {
          // Continue to next chapter
        }
      }
      return chapters;
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

