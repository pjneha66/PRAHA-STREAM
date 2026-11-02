import { describe, expect, it } from 'vitest';
import { CINEMETA_ADDON, DEFAULT_PROFILE, DEFAULT_SETTINGS, normalizeSettings } from '../data/defaults';
import { buildAndroidIntentUrl, extractStreamHeaders } from '../services/androidBridge';
import { createBackupBundle, validateAndParseBackup } from '../services/backupSyncService';
import { buildMagnetUri, extractInfoHash, isMagnetOrTorrent } from '../services/debridService';
import { getAddonConfigureUrl, normalizeStremioUrl, supportsResource } from '../services/stremioService';
import { convertToWebVtt } from '../services/subtitleService';
import { isValidCatalog, mapTmdbItem } from '../services/tmdbService';

describe('subtitleService.convertToWebVtt', () => {
  it('converts SRT subtitles into valid WEBVTT and shifts timestamps by offset', () => {
    const srt = [
      '1',
      '00:00:02,500 --> 00:00:05,000',
      'Hello from PRAHA!',
      '',
      '2',
      '00:01:10,000 --> 00:01:12,250',
      'Second cue line',
    ].join('\r\n');

    const vtt = convertToWebVtt(srt, 1.5);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.500');
    expect(vtt).toContain('00:01:11.500 --> 00:01:13.750');
    expect(vtt).toContain('Hello from PRAHA!');
    expect(vtt).not.toMatch(/^\d+$/m);
  });

  it('converts ASS dialogue events into WEBVTT cues', () => {
    const ass = [
      '[Script Info]',
      'Title: Sample',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:10.00,0:00:13.50,Default,,0,0,0,,{\\i1}Styled line\\NLine two{\\i0}',
    ].join('\n');

    const vtt = convertToWebVtt(ass, 0);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:10.000 --> 00:00:13.500');
    expect(vtt).toContain('Styled line\nLine two');
  });
});

describe('stremioService helpers', () => {
  it('normalizes stremio:// and bare domain links to https manifest.json', () => {
    expect(normalizeStremioUrl('stremio://opensubtitles-v3.strem.io/manifest.json'))
      .toBe('https://opensubtitles-v3.strem.io/manifest.json');
    expect(normalizeStremioUrl('v3-cinemeta.strem.io'))
      .toBe('https://v3-cinemeta.strem.io/manifest.json');
  });

  it('computes configure URL only for configurable addons', () => {
    expect(getAddonConfigureUrl(CINEMETA_ADDON)).toBeUndefined();
    const configurable = {
      ...CINEMETA_ADDON,
      manifestUrl: 'https://cyberflix.elfhosted.com/manifest.json',
      manifest: {
        ...CINEMETA_ADDON.manifest,
        behaviorHints: { configurable: true },
      },
    };
    expect(getAddonConfigureUrl(configurable)).toBe('https://cyberflix.elfhosted.com/configure');
  });

  it('checks subtitle and stream resource support accurately', () => {
    const subAddon = {
      ...CINEMETA_ADDON,
      manifest: {
        ...CINEMETA_ADDON.manifest,
        resources: [{ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }],
      },
    };
    expect(supportsResource(subAddon, 'subtitles', 'series', 'tt0903747')).toBe(true);
    expect(supportsResource(subAddon, 'stream', 'series', 'tt0903747')).toBe(false);
  });
});

describe('debridService & androidBridge helpers', () => {
  it('extracts infoHash and builds magnet URIs cleanly', () => {
    const hash = '0123456789abcdef0123456789abcdef01234567';
    expect(extractInfoHash({ url: '', infoHash: hash })).toBe(hash);
    expect(isMagnetOrTorrent({ url: '', infoHash: hash })).toBe(true);
    const magnet = buildMagnetUri({ url: '', infoHash: hash, title: 'Sample 4K' });
    expect(magnet).toContain(`magnet:?xt=urn:btih:${hash}`);
    expect(magnet).toContain('dn=Sample%204K');
  });

  it('builds Android intent:// URLs targeting VLC and merges proxy headers', () => {
    const intent = buildAndroidIntentUrl('https://cdn.example.com/live/master.m3u8', 'Night Episode', 'vlc');
    expect(intent).toContain('intent://cdn.example.com/live/master.m3u8#Intent;scheme=https;type=video/*;package=org.videolan.vlc;');
    expect(intent).toContain('S.title=Night%20Episode;end');

    const headers = extractStreamHeaders({
      referer: 'https://embed.example.com/',
      headers: { 'User-Agent': 'PrahaAndroid/2.1' },
      behaviorHints: { proxyHeaders: { request: { Origin: 'https://embed.example.com' } } },
    });
    expect(headers.Referer).toBe('https://embed.example.com/');
    expect(headers['User-Agent']).toBe('PrahaAndroid/2.1');
    expect(headers.Origin).toBe('https://embed.example.com');
  });
});

describe('backupSyncService & settings normalization', () => {
  it('round-trips a full PRAHA backup bundle with profiles and settings', () => {
    const settings = normalizeSettings({ tmdbApiKey: 'test-key', dpadNavigation: true });
    const bundle = createBackupBundle({
      settings,
      addons: [CINEMETA_ADDON],
      repositories: [],
      nuvioSettings: { 'repo:scraper1': { quality: '1080p' } },
      profiles: [DEFAULT_PROFILE],
      activeProfileId: 'default',
      profileData: {
        default: {
          watchlist: [],
          history: [],
        },
      },
    });

    const parsed = validateAndParseBackup(JSON.stringify(bundle));
    expect(parsed.app).toBe('praha-stream');
    expect(parsed.settings.tmdbApiKey).toBe('test-key');
    expect(parsed.settings.dpadNavigation).toBe(true);
    expect(parsed.settings.player.theme).toBe(DEFAULT_SETTINGS.player.theme);
    expect(parsed.nuvioSettings?.['repo:scraper1']?.quality).toBe('1080p');
  });

  it('validates TMDB catalog types and item mapping', () => {
    expect(isValidCatalog('airing_today', 'tv')).toBe(true);
    expect(isValidCatalog('airing_today', 'movie')).toBe(false);
    const mapped = mapTmdbItem({
      id: 1396,
      name: 'Breaking Bad',
      poster_path: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
      first_air_date: '2008-01-20',
      vote_average: 8.91,
      genre_ids: [18, 80],
    }, 'tv');
    expect(mapped?.id).toBe('tmdb:1396');
    expect(mapped?.type).toBe('series');
    expect(mapped?.year).toBe('2008');
    expect(mapped?.genres).toEqual(['Drama', 'Crime']);
  });
});

describe('source filters and preferences', () => {
  it('sorts preferred providers first without mutating the input', async () => {
    const { filterAndSortStreams, sourceKey } = await import('../services/sourcePreferences');
    const streams = [
      { id: '1', title: '1080p H264', url: 'https://a', sourceName: 'A', sourceType: 'stremio' as const, language: 'en', seeders: 99 },
      { id: '2', title: '4K HEVC', url: 'https://b', sourceName: 'B', sourceType: 'nuvio' as const, language: 'fr' },
    ];
    const filters = { quality: 'all', provider: 'all', language: 'all', codec: 'all', subtitles: 'all' };
    expect(filterAndSortStreams(streams, filters, sourceKey(streams[1]), 'en').map((s) => s.id)).toEqual(['2', '1']);
    expect(streams[0].id).toBe('1');
    expect(sourceKey(streams[0])).not.toContain('https://');
  });

  it('filters by reported metadata and leaves unknown subtitles distinct', async () => {
    const { filterAndSortStreams, sourceKey, streamQuality } = await import('../services/sourcePreferences');
    const streams = [
      { id: '1', title: 'FHD H.264', url: 'https://a', sourceName: 'A', sourceType: 'stremio' as const, language: 'EN', subtitles: [{ id: 's', url: 'https://sub', language: 'en' }] },
      { id: '2', title: '720p HEVC', url: 'https://b', sourceName: 'B', sourceType: 'nuvio' as const },
    ];
    expect(streamQuality(streams[0])).toBe('1080p');
    const filters = { quality: '1080p', provider: sourceKey(streams[0]), language: 'en', codec: 'H.264', subtitles: 'available' };
    expect(filterAndSortStreams(streams, filters, '', 'en').map((s) => s.id)).toEqual(['1']);
    expect(filterAndSortStreams(streams, { ...filters, subtitles: 'unknown' }, '', 'en')).toEqual([]);
  });
});

describe('playback recovery policy', () => {
  it('waits before reconnecting, limits retries, and never retries ineligible playback', async () => {
    const { stallAction, STALL_TIMEOUT_MS, MAX_STALL_RETRIES } = await import('../components/player/recovery');
    expect(stallAction(STALL_TIMEOUT_MS - 1, 0, true)).toBe('wait');
    expect(stallAction(STALL_TIMEOUT_MS, 0, false)).toBe('wait');
    expect(stallAction(STALL_TIMEOUT_MS, 0, true)).toBe('retry');
    expect(stallAction(STALL_TIMEOUT_MS, MAX_STALL_RETRIES - 1, true)).toBe('retry');
    expect(stallAction(STALL_TIMEOUT_MS, MAX_STALL_RETRIES, true)).toBe('fail');
  });

  it('gives actionable media errors without exposing source URLs', async () => {
    const { mediaErrorMessage } = await import('../components/player/recovery');
    expect(mediaErrorMessage(2)).toContain('network');
    expect(mediaErrorMessage(3)).toContain('decoded');
    expect(mediaErrorMessage(4)).toContain('not supported');
    expect(mediaErrorMessage()).toContain('another source');
  });
});

describe('home cache and row preferences', () => {
  it('validates cache age and handles malformed data', async () => {
    const { readHomeCache, writeHomeCache } = await import('../services/homeCache');
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const item = { id: 'tmdb:1', title: 'Film', poster: 'poster', genres: [] };
    const catalog = { hero: [], trending: [item], movies: [], series: [], topRated: [] } as any;
    writeHomeCache(storage, catalog, 1000);
    expect(readHomeCache(storage, 1001)).toEqual(catalog);
    expect(readHomeCache(storage, 1000 + 8 * 86400000)).toBeNull();
    data.set('praha.v2.home-cache', '{');
    expect(readHomeCache(storage, 1001)).toBeNull();
  });
  it('normalizes old or invalid row preferences without losing new rows', async () => {
    const { normalizeHomeRows } = await import('../services/homeCache');
    const rows = normalizeHomeRows({ order: ['movies', 'movies', 'invalid'], hidden: ['series', 'invalid'] });
    expect(rows.order).toEqual(['movies', 'continue', 'trending', 'series', 'topRated']);
    expect(rows.hidden).toEqual(['series']);
  });
});

describe('Jellyfin connection URL', () => {
  it('keeps a reverse proxy path and rejects embedded secrets and non-http URLs', async () => {
    const { normalizeJellyfinUrl } = await import('../services/jellyfinService');
    expect(normalizeJellyfinUrl('https://example.com/jellyfin/')).toBe('https://example.com/jellyfin');
    expect(() => normalizeJellyfinUrl('https://user:secret@example.com')).toThrow();
    expect(() => normalizeJellyfinUrl('https://example.com/?api_key=secret')).toThrow();
    expect(() => normalizeJellyfinUrl('file:///etc/passwd')).toThrow();
  });
});

describe('embedded provider templates', () => {
  it('constructs movie and episode URLs without mixing them into sources', async () => {
    const { EMBED_PRESETS, buildEmbedUrl } = await import('../services/embedProviders');
    const movie = { id: 'tmdb:550', tmdbId: 550, type: 'movie' } as any;
    const series = { id: 'tt0903747', imdbId: 'tt0903747', type: 'series' } as any;
    expect(buildEmbedUrl(EMBED_PRESETS[0], movie)).toBe('https://vidlink.pro/movie/550');
    expect(buildEmbedUrl(EMBED_PRESETS[1], series, 2, 3)).toBe('https://vidrock.net/tv/tt0903747/2/3');
    expect(() => buildEmbedUrl(EMBED_PRESETS[0], series, 2, 3)).toThrow(/TMDB or IMDb ID/);
    expect(() => buildEmbedUrl(EMBED_PRESETS[1], series, 0, 1)).toThrow(/positive/);
  });
  it('rejects unsafe or malformed custom templates', async () => {
    const { validateEmbedTemplate } = await import('../services/embedProviders');
    expect(() => validateEmbedTemplate('http://example.com/{id}', 'movie')).toThrow();
    expect(() => validateEmbedTemplate('https://user:pw@example.com/{id}', 'movie')).toThrow();
    expect(() => validateEmbedTemplate('https://{id}.example.com/player', 'movie')).toThrow();
    expect(() => validateEmbedTemplate('https://example.com/{id}', 'series')).toThrow();
    expect(() => validateEmbedTemplate('https://example.com/{id}/{season}/{episode}', 'series')).not.toThrow();
  });
});

describe('documented embedded player templates', () => {
  it('builds a valid movie and episode URL for every preset', async () => {
    const { EMBED_PRESETS, buildEmbedUrl } = await import('../services/embedProviders');
    const movie = { id: 'tmdb:550', tmdbId: 550, type: 'movie' } as any;
    const tv = { id: 'tmdb:1399', tmdbId: 1399, type: 'series' } as any;
    expect(new Set(EMBED_PRESETS.map((p) => p.id)).size).toBe(EMBED_PRESETS.length);
    for (const provider of EMBED_PRESETS) {
      const movieUrl = new URL(buildEmbedUrl(provider, movie));
      const tvUrl = new URL(buildEmbedUrl(provider, tv, 2, 3));
      expect(movieUrl.protocol, provider.name).toBe('https:');
      expect(movieUrl.href, provider.name).toContain('550');
      expect(tvUrl.href, provider.name).toContain('1399');
      expect(tvUrl.href, provider.name).not.toMatch(/%7B|\{/i);
    }
    const byId = (id: string) => EMBED_PRESETS.find((p) => p.id === id)!;
    expect(buildEmbedUrl(byId('primesrc'), tv, 2, 3)).toBe('https://primesrc.me/embed/tv?tmdb=1399&season=2&episode=3');
    expect(buildEmbedUrl(byId('superembed'), tv, 2, 3)).toBe('https://multiembed.mov/?video_id=1399&tmdb=1&s=2&e=3');
    expect(buildEmbedUrl(byId('cinemaos'), tv, 2, 3)).toBe('https://cinemaos.tech/player/1399/2/3');
    expect(buildEmbedUrl(byId('cinextream'), tv, 2, 3)).toBe('https://cinextream.cc/api/embed/tv/1399/2/3');
    expect(buildEmbedUrl(byId('vidapi'), tv, 2, 3)).toBe('https://vaplayer.ru/embed/tv/1399/2/3');
  });

  it('honors valid local domain changes but ignores invalid overrides', async () => {
    const { EMBED_PRESETS, applyEmbedOverrides, buildEmbedUrl } = await import('../services/embedProviders');
    const preset = EMBED_PRESETS[0];
    const override = { [preset.id]: { movie: 'https://new.example/movie/{tmdb}', series: 'https://new.example/tv/{tmdb}/{season}/{episode}' } };
    const updated = applyEmbedOverrides([preset], override)[0];
    const movie = { id: 'tmdb:550', tmdbId: 550, type: 'movie' } as any;
    expect(buildEmbedUrl(updated, movie)).toBe('https://new.example/movie/550');
    expect(applyEmbedOverrides([preset], { [preset.id]: { ...override[preset.id], movie: 'http://bad.example/{tmdb}' } })[0]).toEqual(preset);
    expect(applyEmbedOverrides([preset], null)[0]).toEqual(preset);
    expect(applyEmbedOverrides([preset], {})[0]).toEqual(preset);
  });
});

describe('embedded-player automatic update feed', () => {
  it('accepts only known IDs and fully valid HTTPS templates', async () => {
    const { parseEmbedUpdate, validateUpdateUrl } = await import('../services/embedUpdates');
    const entry = { id: 'vidlink', movie: 'https://new.example/movie/{tmdb}', series: 'https://new.example/tv/{tmdb}/{season}/{episode}' };
    expect(parseEmbedUpdate({ version: 1, providers: [entry] }).vidlink).toEqual({ movie: entry.movie, series: entry.series });
    expect(parseEmbedUpdate({ version: 1, providers: [{ ...entry, id: 'unknown' }, entry] }).vidlink).toEqual({ movie: entry.movie, series: entry.series });
    expect(() => parseEmbedUpdate({ version: 1, providers: [entry, entry] })).toThrow();
    expect(() => parseEmbedUpdate({ version: 1, providers: [{ ...entry, movie: 'http://bad.example/{id}' }] })).toThrow();
    expect(() => parseEmbedUpdate({ version: 2, providers: [] })).toThrow();
    expect(() => validateUpdateUrl('https://user:pass@example.com/feed')).toThrow();
    expect(() => validateUpdateUrl('https://example.com/feed?token=secret')).toThrow();
    expect(validateUpdateUrl('https://example.com/feed.json')).toBe('https://example.com/feed.json');
  });
  it('fetches bounded JSON without cookies, referrers or redirects', async () => {
    const { fetchEmbedUpdate } = await import('../services/embedUpdates');
    const { vi } = await import('vitest');
    const original = globalThis.fetch;
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, providers: [] }), { status: 200 }));
    globalThis.fetch = mock;
    try {
      expect(await fetchEmbedUpdate('https://example.com/feed.json')).toEqual({});
      expect(mock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      mock.mockResolvedValueOnce(new Response('x'.repeat(65537), { status: 200 }));
      await expect(fetchEmbedUpdate('https://example.com/feed.json')).rejects.toThrow(/too large/);
      mock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      await expect(fetchEmbedUpdate('https://example.com/feed.json')).rejects.toThrow(/503/);
    } finally { globalThis.fetch = original; }
  });
});


it('ships a valid update feed covering every built-in provider', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseEmbedUpdate, DEFAULT_EMBED_UPDATE_URL } = await import('../services/embedUpdates');
  const { EMBED_PRESETS } = await import('../services/embedProviders');
  const feed = parseEmbedUpdate(JSON.parse(readFileSync('public/embed-providers.json', 'utf8')));
  expect(DEFAULT_EMBED_UPDATE_URL).toContain('/main/public/embed-providers.json');
  expect(Object.keys(feed)).toHaveLength(EMBED_PRESETS.length);
  for (const preset of EMBED_PRESETS) expect(feed[preset.id]).toBeDefined();
});

it('bundles the Android protected-player host list and denies popup windows', async () => {
  const { readFileSync } = await import('node:fs');
  const hosts = readFileSync('android/app/src/main/assets/embed-block-hosts.txt', 'utf8');
  expect(hosts).toContain('0.0.0.0 doubleclick.net');
  expect(hosts).toContain('0.0.0.0 google-analytics.com');
  expect(hosts.split('\n').filter((line) => line.startsWith('0.0.0.0 ')).length).toBeGreaterThan(50000);
  expect(readFileSync('android/app/src/main/assets/embed-block-hosts-LICENSE.txt', 'utf8')).toContain('MIT License');
  const activity = readFileSync('android/app/src/main/java/com/praha/stream/ProtectedEmbedActivity.java', 'utf8');
  expect(activity).toContain('setSupportMultipleWindows(true)');
  expect(activity).toMatch(/onCreateWindow\([^)]*\)\s*\{\s*return false;/);
  expect(activity).toContain('setAllowFileAccess(false)');
  expect(activity).toContain('filter.blocks(uri.getHost())');
});
