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
      cloudstreamRepositories: [],
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
