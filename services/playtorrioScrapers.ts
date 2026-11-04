import { nativeFetchText } from './androidBridge';
import type { StreamResult } from '../types';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Shared Helpers ───────────────────────────────────────────────────────────

function rot13(input: string): string {
  return input.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 97 ? 97 : 65;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const la = a.length;
  const lb = b.length;
  const d: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[la][lb];
}

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 10000): Promise<string> {
  const mergedHeaders = { 'User-Agent': USER_AGENT, ...headers };
  const res = await nativeFetchText(url, { headers: mergedHeaders, timeoutMs });
  if (!res.ok && res.status !== 200 && res.status !== 206) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.data;
}

// ── 1. 4KHDHub Scraper (Primary 4K Provider) ─────────────────────────────────

export class FourKHDHubScraper {
  private static resolvedBaseUrl: string = 'https://4khdhub.one';

  static async scrape(
    title: string,
    type: 'movie' | 'series',
    year?: number,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    try {
      const baseUrl = this.resolvedBaseUrl;
      const searchUrl = `${baseUrl}/?s=${encodeURIComponent(title)}`;
      const html = await fetchText(searchUrl);
      const isSeries = type === 'series';
      const formatFilter = isSeries ? 'Series' : 'Movies';

      // Parse movie cards
      const cardRegex = /<a[^>]*class="[^"]*movie-card[^"]*"[^>]*href="([^"]+)"[\s\S]*?<\/a>/gi;
      let matchedPageUrl = '';
      let match: RegExpExecArray | null;

      while ((match = cardRegex.exec(html)) !== null) {
        const cardHtml = match[0];
        const cardHref = match[1];

        if (!cardHtml.includes(formatFilter)) continue;

        if (year) {
          const yearMatch = cardHtml.match(/class="movie-card-meta"[^>]*>\s*(\d{4})/i);
          if (yearMatch && Math.abs(parseInt(yearMatch[1], 10) - year) > 1) continue;
        }

        const titleMatch = cardHtml.match(/class="movie-card-title"[^>]*>([^<]+)<\//i);
        const cardTitle = (titleMatch ? titleMatch[1] : '').replace(/\[.*?\]/g, '').trim();

        const diff = levenshtein(cardTitle.toLowerCase(), title.toLowerCase());
        if (diff < 5 || (cardTitle.toLowerCase().includes(title.toLowerCase()) && diff < 16)) {
          matchedPageUrl = cardHref.startsWith('http') ? cardHref : new URL(cardHref, baseUrl).href;
          break;
        }
      }

      if (!matchedPageUrl) return sources;

      const pageHtml = await fetchText(matchedPageUrl);

      // Extract HubCloud or HubDrive links
      const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const downloadUrls: { url: string; label: string; quality: string }[] = [];

      let lMatch: RegExpExecArray | null;
      while ((lMatch = linkRegex.exec(pageHtml)) !== null) {
        const href = lMatch[1];
        const text = lMatch[2];
        if (text.includes('HubCloud') || text.includes('HubDrive') || href.includes('hubcloud') || href.includes('hubdrive')) {
          const is4k = /2160p|4k|uhd/i.test(pageHtml) || /2160p|4k|uhd/i.test(text);
          const is1080 = /1080p|fhd/i.test(pageHtml) || /1080p|fhd/i.test(text);
          const q = is4k ? '4K' : is1080 ? '1080p' : 'Auto';
          downloadUrls.push({ url: href, label: text.replace(/<[^>]+>/g, '').trim(), quality: q });
        }
      }

      for (const item of downloadUrls.slice(0, 3)) {
        try {
          const resolved = await this.resolveRedirect(item.url);
          if (resolved) {
            sources.push({
              id: `4khdhub-${sources.length + 1}-${Date.now()}`,
              title: `4KHDHub · ${item.quality === '4K' ? '4K UHD' : '1080p Direct'} · HubCloud`,
              url: resolved,
              sourceName: '4KHDHub',
              sourceType: 'playtorrio',
              quality: item.quality,
              provider: '4KHDHub (PlayTorrio)',
              headers: { 'User-Agent': USER_AGENT, Referer: baseUrl },
            });
          }
        } catch {
          // Continue to next download item
        }
      }
    } catch {
      // Scrape error handled gracefully
    }
    return sources;
  }

  private static async resolveRedirect(redirectUrl: string): Promise<string | null> {
    try {
      const html = await fetchText(redirectUrl);
      const downloadMatch = html.match(/<a id="download" href="([^"]+)"/i);
      let nextUrl = downloadMatch ? downloadMatch[1] : '';

      if (!nextUrl) {
        const varMatch = html.match(/var url = '([^']+)';/i);
        if (varMatch) nextUrl = varMatch[1];
      }

      if (!nextUrl) {
        const encMatch = html.match(/'o','(.*?)'/);
        if (encMatch && encMatch[1]) {
          const raw = encMatch[1];
          const s1 = atob(raw);
          const s2 = atob(s1);
          const s3 = rot13(s2);
          const s4 = atob(s3);
          const parsed = JSON.parse(s4);
          return atob(parsed.o);
        }
        return null;
      }

      const intermediate = await fetchText(nextUrl);
      const finalMatch = intermediate.match(/<a href="([^"]+)"[^>]*class="[^"]*btn-success/i);
      return finalMatch ? finalMatch[1] : null;
    } catch {
      return null;
    }
  }
}

// ── 2. MovieNight Scraper (4K HLS) ──────────────────────────────────────────

export class MovieNightScraper {
  private static base = 'https://movienig.ht';
  private static servers = [
    { id: 'dallas', label: 'Dallas 4K' },
    { id: 'seattle', label: 'Seattle 4K' },
    { id: 'austin', label: 'Austin' },
    { id: 'helena', label: 'Helena' },
    { id: 'vixsrc-1', label: 'Newport Beach' },
  ];

  static async scrape(
    title: string,
    type: 'movie' | 'series',
    tmdbId?: number | string,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    if (!tmdbId) return sources;

    for (const server of this.servers.slice(0, 3)) {
      try {
        const isTv = type === 'series';
        const path = isTv
          ? `/api/stream/v1/tv/${tmdbId}/${season || 1}/${episode || 1}?title=${encodeURIComponent(title)}&server=${server.id}&only=1`
          : `/api/stream/v1/movie/${tmdbId}?title=${encodeURIComponent(title)}&server=${server.id}&only=1`;

        const body = await fetchText(`${this.base}${path}`, {
          Referer: `${this.base}/`,
          Origin: this.base,
          Accept: 'text/event-stream',
        }, 6000);

        if (body.includes('event: done')) {
          const dataIdx = body.indexOf('data: ', body.indexOf('event: done'));
          if (dataIdx !== -1) {
            const jsonText = body.slice(dataIdx + 6).split('\n')[0].trim();
            const data = JSON.parse(jsonText);
            if (Array.isArray(data.sources)) {
              for (const src of data.sources) {
                if (src.url) {
                  const quality = src.quality || (server.label.includes('4K') ? '4K' : '1080p');
                  sources.push({
                    id: `movienight-${server.id}-${sources.length + 1}`,
                    title: `MovieNight · ${server.label} · ${quality}`,
                    url: src.url,
                    sourceName: 'MovieNight',
                    sourceType: 'playtorrio',
                    quality,
                    provider: `MovieNight ${server.label}`,
                    headers: { 'User-Agent': USER_AGENT, Referer: `${this.base}/` },
                  });
                }
              }
            }
          }
        }
      } catch {
        // Individual server fallback
      }
    }
    return sources;
  }
}

// ── 3. Videasy Scraper (Multi-CDN) ──────────────────────────────────────────

export class VideasyScraper {
  private static apiBase = 'https://api.speedracelight.com';
  private static providers = [
    { path: '/cdn/sources-with-title', label: 'Yoru' },
    { path: '/neon2/sources-with-title', label: 'Neon' },
    { path: '/m4uhd/sources-with-title', label: 'Breach' },
    { path: '/meine/sources-with-title', label: 'Killjoy' },
    { path: '/lamovie/sources-with-title', label: 'Omen' },
  ];

  static async scrape(
    title: string,
    type: 'movie' | 'series',
    tmdbId?: number | string,
    year?: number,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    if (!tmdbId) return sources;

    try {
      const seedRes = await fetchText(`${this.apiBase}/seed?mediaId=${tmdbId}`, {
        Referer: 'https://player.videasy.to/',
      }, 5000);
      const seedData = JSON.parse(seedRes);
      const seed = seedData.seed;
      if (!seed) return sources;

      const isTv = type === 'series';
      const params = new URLSearchParams({
        title,
        mediaType: isTv ? 'tv' : 'movie',
        tmdbId: String(tmdbId),
        enc: '2',
        seed,
        ...(year ? { year: String(year) } : {}),
        ...(isTv && season ? { seasonId: String(season) } : {}),
        ...(isTv && episode ? { episodeId: String(episode) } : {}),
      });

      for (const p of this.providers.slice(0, 3)) {
        try {
          const raw = await fetchText(`${this.apiBase}${p.path}?${params.toString()}`, {
            Referer: 'https://player.videasy.to/',
            Origin: 'https://player.videasy.to',
          }, 6000);

          const json = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : null;
          const streamList = json?.sources;
          if (Array.isArray(streamList)) {
            for (const s of streamList) {
              const url = s.url || s.file;
              if (url && typeof url === 'string' && url.startsWith('http')) {
                sources.push({
                  id: `videasy-${p.label}-${sources.length + 1}`,
                  title: `Videasy · ${p.label} · ${s.quality || 'Auto'}`,
                  url,
                  sourceName: 'Videasy',
                  sourceType: 'playtorrio',
                  quality: s.quality || '1080p',
                  provider: `Videasy ${p.label}`,
                  headers: { 'User-Agent': USER_AGENT, Referer: 'https://player.videasy.to/' },
                });
              }
            }
          }
        } catch {
          // Continue to next Videasy provider
        }
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── 4. VidCore Scraper ──────────────────────────────────────────────────────

export class VidCoreScraper {
  private static bases = ['https://www.vidcore.org', 'https://vidcore.org'];

  static async scrape(
    type: 'movie' | 'series',
    tmdbId?: number | string,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    if (!tmdbId) return sources;

    for (const base of this.bases) {
      try {
        const isTv = type === 'series';
        const params = new URLSearchParams({
          id: String(tmdbId),
          type: isTv ? 'tv' : 'movie',
          ...(isTv && season ? { season: String(season) } : {}),
          ...(isTv && episode ? { episode: String(episode) } : {}),
        });

        const raw = await fetchText(`${base}/api/sources?${params.toString()}`, {
          Referer: `${base}/embed/${isTv ? 'tv' : 'movie'}/${tmdbId}`,
          Origin: base,
          Accept: 'application/json',
        }, 6000);

        const data = JSON.parse(raw);
        if (Array.isArray(data.sources)) {
          for (const s of data.sources) {
            const url = s.url;
            if (url && typeof url === 'string' && url.startsWith('http')) {
              sources.push({
                id: `vidcore-${sources.length + 1}`,
                title: `VidCore · ${s.label || s.quality || 'Multi-Server'}`,
                url,
                sourceName: 'VidCore',
                sourceType: 'playtorrio',
                quality: s.quality || '1080p',
                provider: 'VidCore',
                headers: { 'User-Agent': USER_AGENT, Referer: `${base}/` },
              });
            }
          }
        }
        if (sources.length > 0) break;
      } catch {
        // Fallback to next VidCore base
      }
    }
    return sources;
  }
}

// ── 5. FlyStream Scraper (4K HEVC) ──────────────────────────────────────────

export class FlyStreamScraper {
  private static base = 'https://flystream.net';

  static async scrape(
    title: string,
    type: 'movie' | 'series',
    tmdbId?: number | string,
    year?: number,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    try {
      const isTv = type === 'series';
      const randomViewer = Math.random().toString(36).substring(2, 18);
      const params = new URLSearchParams({
        type: isTv ? 'tv' : 'movie',
        viewerId: randomViewer,
        title,
        ...(tmdbId ? { tmdbId: String(tmdbId) } : {}),
        ...(year ? { year: String(year) } : {}),
        ...(isTv && season ? { season: String(season) } : {}),
        ...(isTv && episode ? { episode: String(episode) } : {}),
      });

      const raw = await fetchText(`${this.base}/api/streams?${params.toString()}`, {
        Referer: `${this.base}/`,
        Accept: 'application/json',
      }, 7000);

      const data = JSON.parse(raw);
      if (Array.isArray(data.streams)) {
        for (const s of data.streams) {
          const rawUrl = s.url;
          if (!rawUrl) continue;
          const url = rawUrl.startsWith('/') ? `${this.base}${rawUrl}` : rawUrl;
          if (typeof url === 'string' && url.startsWith('http')) {
            const is4k = /4k|2160/i.test(s.quality || '') || /hevc/i.test(s.videoCodec || '');
            sources.push({
              id: `flystream-${sources.length + 1}`,
              title: `FlyStream · ${s.name || title} · ${is4k ? '4K HEVC' : '1080p'}`,
              url,
              sourceName: 'FlyStream',
              sourceType: 'playtorrio',
              quality: is4k ? '4K' : (s.quality || '1080p'),
              provider: 'FlyStream Direct',
              headers: { 'User-Agent': USER_AGENT, Referer: `${this.base}/` },
            });
          }
        }
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── 6. MultiEmbed / 2embed Scraper ──────────────────────────────────────────

export class MultiEmbedScraper {
  private static base = 'https://www.2embed.cc';

  static async scrape(
    type: 'movie' | 'series',
    tmdbId?: number | string,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    if (!tmdbId) return sources;

    try {
      const isTv = type === 'series';
      const embedPath = isTv
        ? `/embedtv/${tmdbId}&s=${season || 1}&e=${episode || 1}`
        : `/embed/${tmdbId}`;

      const html = await fetchText(`${this.base}${embedPath}`, {
        Referer: `${this.base}/`,
      }, 7000);

      const serverUrls: string[] = [];
      const onclickRegex = /onclick="go\('([^']+)'\)"/g;
      let m: RegExpExecArray | null;
      while ((m = onclickRegex.exec(html)) !== null) {
        if (m[1].startsWith('http')) serverUrls.push(m[1]);
      }

      for (const sUrl of serverUrls.slice(0, 2)) {
        if (sUrl.includes('/xps')) {
          const xpsPageUrl = isTv
            ? `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}?autostart=true`
            : `https://play.xpass.top/e/movie/${tmdbId}?autostart=true`;

          try {
            const xpsHtml = await fetchText(xpsPageUrl, { Referer: 'https://streamsrcs.2embed.cc/' }, 6000);
            const playlistMatch = xpsHtml.match(/"playlist"\s*:\s*"([^"]+)"/);
            if (playlistMatch && playlistMatch[1]) {
              const plUrl = playlistMatch[1].startsWith('http') ? playlistMatch[1] : `https://play.xpass.top/${playlistMatch[1]}`;
              const plRaw = await fetchText(plUrl, { Referer: xpsPageUrl }, 6000);
              const plJson = JSON.parse(plRaw);
              if (Array.isArray(plJson.playlist)) {
                for (const item of plJson.playlist) {
                  if (Array.isArray(item.sources)) {
                    for (const src of item.sources) {
                      if (src.file && src.file.startsWith('http')) {
                        sources.push({
                          id: `multiembed-${sources.length + 1}`,
                          title: `MultiEmbed · 2embed XPS · ${src.label || 'Auto'}`,
                          url: src.file,
                          sourceName: 'MultiEmbed',
                          sourceType: 'playtorrio',
                          quality: '1080p',
                          provider: '2embed Multi-CDN',
                          headers: { 'User-Agent': USER_AGENT, Referer: 'https://play.xpass.top/' },
                        });
                      }
                    }
                  }
                }
              }
            }
          } catch {
            // Ignored
          }
        }
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── 7. VidSrc Scraper ───────────────────────────────────────────────────────

export class VidSrcScraper {
  private static apiBase = 'https://data.vidsrcme.ru';

  static async scrape(
    type: 'movie' | 'series',
    tmdbId?: number | string,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    if (!tmdbId) return sources;

    try {
      const isTv = type === 'series';
      const params = new URLSearchParams({
        type: isTv ? 'tv' : 'movie',
        tmdb: String(tmdbId),
        stream_urls: '',
        ...(isTv && season ? { season: String(season) } : {}),
        ...(isTv && episode ? { episode: String(episode) } : {}),
      });

      const raw = await fetchText(`${this.apiBase}/api.php?${params.toString()}`, {
        Referer: 'https://cloudorchestranova.com/',
        Accept: 'application/json',
      }, 6000);

      const json = JSON.parse(raw);
      if (json.status_code === '200' && json.data && Array.isArray(json.data.stream_urls)) {
        for (let i = 0; i < json.data.stream_urls.length; i++) {
          const url = String(json.data.stream_urls[i]).trim();
          if (url.startsWith('http')) {
            sources.push({
              id: `vidsrc-${i + 1}`,
              title: `VidSrc · Server ${i + 1} · HLS`,
              url,
              sourceName: 'VidSrc',
              sourceType: 'playtorrio',
              quality: '1080p',
              provider: 'VidSrc Stream',
              headers: { 'User-Agent': USER_AGENT, Referer: 'https://cloudorchestranova.com/' },
            });
          }
        }
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── 8. XDownloader / Films365 Scraper (Direct High-Speed MP4) ───────────────

export class XDownloaderScraper {
  private static baseUrl = 'https://www.films365.org';
  private static headers = {
    Authorization: 'Bearer 79a02956be35835728a044b11e2ae793149d45fb2c89cb6d029ec01aac19bfdb',
    'Content-Type': 'application/json',
    'User-Agent': 'MovieDownloader/1.0',
  };

  static async scrape(
    title: string,
    type: 'movie' | 'series',
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    try {
      const searchRes = await nativeFetchText(`${this.baseUrl}/api/mobile/search`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query: title }),
        timeoutMs: 6000,
      });

      if (!searchRes.ok) return sources;
      const searchJson = JSON.parse(searchRes.data);
      const results = searchJson.results;
      if (!results) return sources;

      const items: any[] = results.all || results.movies || results.tvs || [];
      if (!items.length) return sources;

      const targetType = type === 'series' ? 'tv' : 'movie';
      const cleanSearch = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      let matched = items.find((i: any) => {
        const itemTitle = (i.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return itemTitle === cleanSearch || itemTitle.includes(cleanSearch);
      });
      if (!matched) matched = items[0];

      const itemId = matched.id || matched.tmdbId;
      if (!itemId) return sources;

      const detailsRes = await fetchText(`${this.baseUrl}/api/mobile/details?id=${itemId}&type=${targetType}`, this.headers, 6000);
      const detailsJson = JSON.parse(detailsRes);
      const data = detailsJson.data;
      if (!data) return sources;

      if (targetType === 'movie') {
        const streamUrl = data.downloadUrl || data.videoUrl;
        if (streamUrl && streamUrl.startsWith('http')) {
          sources.push({
            id: `xdownloader-${Date.now()}`,
            title: 'X-Downloader · Direct MP4 High-Speed',
            url: streamUrl,
            sourceName: 'X-Downloader',
            sourceType: 'playtorrio',
            quality: '1080p',
            provider: 'Films365 CDN',
          });
        }
      } else if (Array.isArray(data.seasons) && season) {
        const targetSeason = data.seasons.find((s: any) => s.seasonNumber === season);
        if (targetSeason && Array.isArray(targetSeason.episodes) && episode) {
          const targetEpisode = targetSeason.episodes.find((e: any) => e.episodeNumber === episode);
          if (targetEpisode) {
            const streamUrl = targetEpisode.downloadUrl || targetEpisode.videoUrl;
            if (streamUrl && streamUrl.startsWith('http')) {
              sources.push({
                id: `xdownloader-s${season}e${episode}`,
                title: `X-Downloader · Direct MP4 (S${season}E${episode})`,
                url: streamUrl,
                sourceName: 'X-Downloader',
                sourceType: 'playtorrio',
                quality: '1080p',
                provider: 'Films365 CDN',
              });
            }
          }
        }
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── 9. Torrent Scraper (TorrentGalaxy & Knaben) ──────────────────────────────

export class TorrentScraper {
  static async scrape(
    title: string,
    type: 'movie' | 'series',
    year?: number,
    season?: number,
    episode?: number,
  ): Promise<StreamResult[]> {
    const sources: StreamResult[] = [];
    try {
      let query = title.trim();
      if (type === 'movie' && year) query += ` ${year}`;
      else if (type === 'series' && season) query += ` S${String(season).padStart(2, '0')}`;

      const knabenUrl = `https://knaben.org/search/${encodeURIComponent(query)}/0/1/seeders`;
      const html = await fetchText(knabenUrl, { 'User-Agent': USER_AGENT }, 6000);

      const magnetRegex = /href="(magnet:\?xt=urn:btih:[^"]+)"/gi;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = magnetRegex.exec(html)) !== null && count < 5) {
        const magnet = m[1];
        const hashMatch = magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
        const hash = hashMatch ? hashMatch[1] : '';
        const nameMatch = magnet.match(/dn=([^&]+)/i);
        const name = nameMatch ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')) : `Torrent ${count + 1}`;
        const is4k = /2160p|4k|uhd/i.test(name);
        const is1080 = /1080p|fhd/i.test(name);

        sources.push({
          id: `torrent-${hash || count}`,
          title: `Torrent · ${name}`,
          url: magnet,
          sourceName: 'TorrentGalaxy/Knaben',
          sourceType: 'playtorrio',
          quality: is4k ? '4K' : is1080 ? '1080p' : 'Auto',
          provider: 'P2P Torrent Engine',
          infoHash: hash,
          seeders: 25,
        });
        count++;
      }
    } catch {
      // Ignored
    }
    return sources;
  }
}

// ── Master PlayTorrio Scraper Aggregator ─────────────────────────────────────

export async function findPlayTorrioStreams(
  title: string,
  type: 'movie' | 'series',
  tmdbId?: number | string,
  year?: number,
  season?: number,
  episode?: number,
): Promise<StreamResult[]> {
  if (!title || !title.trim()) return [];

  const jobs: Promise<StreamResult[]>[] = [
    // 4KHDHub runs first as top priority
    FourKHDHubScraper.scrape(title, type, year, season, episode),
    MovieNightScraper.scrape(title, type, tmdbId, season, episode),
    VideasyScraper.scrape(title, type, tmdbId, year, season, episode),
    VidCoreScraper.scrape(type, tmdbId, season, episode),
    FlyStreamScraper.scrape(title, type, tmdbId, year, season, episode),
    MultiEmbedScraper.scrape(type, tmdbId, season, episode),
    VidSrcScraper.scrape(type, tmdbId, season, episode),
    XDownloaderScraper.scrape(title, type, season, episode),
    TorrentScraper.scrape(title, type, year, season, episode),
  ];

  const results = await Promise.allSettled(jobs);
  const all: StreamResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      all.push(...r.value);
    }
  }

  // Ensure 4KHDHub streams are at the absolute top of the return array
  return all.sort((a, b) => {
    const is4kHubA = /4khd/i.test(a.sourceName);
    const is4kHubB = /4khd/i.test(b.sourceName);
    if (is4kHubA && !is4kHubB) return -1;
    if (!is4kHubA && is4kHubB) return 1;
    const is4kA = a.quality === '4K';
    const is4kB = b.quality === '4K';
    if (is4kA && !is4kB) return -1;
    if (!is4kA && is4kB) return 1;
    return 0;
  });
}
