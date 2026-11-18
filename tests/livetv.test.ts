// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import CryptoJS from 'crypto-js';
import {
  M3uParser,
  IptvScraper,
  HardcodedChannels,
  IptvStore,
  IptvClient,
  IptvZapStore,
  buildIptvPlayback,
  detectIptvFormat,
  formatIptvBadge,
  type IptvPortal,
  type M3uChannel,
} from '../services/iptvService';
import { LiveTvPrefs } from '../services/liveTvPrefs';

describe('Live TV & IPTV Service Engine', () => {
  describe('M3U / M3U8 Playlist Parser', () => {
    it('parses standard extended M3U content with all attributes', () => {
      const sampleM3u = `
#EXTM3U
#EXTINF:-1 tvg-id="UFC.Live.HD" tvg-name="UFC HD" tvg-logo="https://img.example.com/ufc.png" group-title="Combat Sports",UFC 300 Main Event (1080p)
http://stream.example.com/live/ufc.m3u8
#EXTINF:-1 tvg-id="SkySportsF1" group-title="Motorsport",Sky Sports F1 HD
https://cdn.example.com/hls/f1/master.m3u8
#EXTGRP:Racing
#EXTINF:-1,beIN Sports 1 English
http://iptv.example.org:8080/bein1.ts
`;

      const channels = M3uParser.parse(sampleM3u);
      expect(channels.length).toBe(3);

      expect(channels[0].name).toBe('UFC 300 Main Event (1080p)');
      expect(channels[0].url).toBe('http://stream.example.com/live/ufc.m3u8');
      expect(channels[0].logo).toBe('https://img.example.com/ufc.png');
      expect(channels[0].group).toBe('Combat Sports');
      expect(channels[0].tvgId).toBe('UFC.Live.HD');

      expect(channels[1].name).toBe('Sky Sports F1 HD');
      expect(channels[1].url).toBe('https://cdn.example.com/hls/f1/master.m3u8');
      expect(channels[1].group).toBe('Motorsport');

      expect(channels[2].name).toBe('beIN Sports 1 English');
      expect(channels[2].url).toBe('http://iptv.example.org:8080/bein1.ts');
    });

    it('handles CRLF line endings and single-quoted attributes', () => {
      const sample = '#EXTM3U\r\n#EXTINF:-1 tvg-logo=\'https://logo.png\' group-title=\'News\',CNN HD\r\nhttp://cnn.stream.m3u8\r\n';
      const channels = M3uParser.parse(sample);
      expect(channels.length).toBe(1);
      expect(channels[0].name).toBe('CNN HD');
      expect(channels[0].logo).toBe('https://logo.png');
      expect(channels[0].group).toBe('News');
      expect(channels[0].url).toBe('http://cnn.stream.m3u8');
    });

    it('returns empty list on empty or whitespace input', () => {
      expect(M3uParser.parse('')).toEqual([]);
      expect(M3uParser.parse('   \n  \n  ')).toEqual([]);
    });
  });

  describe('Xtream-Codes Portal Extractor (IptvScraper)', () => {
    it('extracts URL query parameter credentials (?username=...&password=...)', () => {
      const sampleText = `
Here are the latest Xtream-Codes portals:
http://premium-iptv.net:8080/get.php?username=vipuser123&password=secretpass&type=m3u
Also another backup server:
https://stream.server4k.com:2095/playlist.php?user=sportsfan&pass=action2026
`;

      const portals = IptvScraper.extractPortals(sampleText, 'Test');
      expect(portals.length).toBe(2);

      expect(portals[0].url).toBe('http://premium-iptv.net:8080');
      expect(portals[0].username).toBe('vipuser123');
      expect(portals[0].password).toBe('secretpass');

      expect(portals[1].url).toBe('https://stream.server4k.com:2095');
      expect(portals[1].username).toBe('sportsfan');
      expect(portals[1].password).toBe('action2026');
    });

    it('extracts structured label credentials (Host / User / Pass / Usuário / Senha)', () => {
      const sampleText = `
🌍 Server Info:
Host: http://fast-panel.tv:8000
Username: testuser99
Password: passuser99

Portuguese panel:
🌐 Host: http://br-iptv.org:8888
Usuário: canalbrasil
Senha: brasil2026
`;

      const portals = IptvScraper.extractPortals(sampleText, 'Reddit');
      expect(portals.length).toBeGreaterThanOrEqual(2);

      const p1 = portals.find(p => p.url.includes('fast-panel.tv'));
      expect(p1).toBeDefined();
      expect(p1?.username).toBe('testuser99');
      expect(p1?.password).toBe('passuser99');

      const p2 = portals.find(p => p.url.includes('br-iptv.org'));
      expect(p2).toBeDefined();
      expect(p2?.username).toBe('canalbrasil');
      expect(p2?.password).toBe('brasil2026');
    });

    it('deduplicates identical portal credentials', () => {
      const sampleText = `
http://iptv.com:8080/get.php?username=dupuser&password=duppass
http://iptv.com:8080/get.php?username=dupuser&password=duppass
`;
      const portals = IptvScraper.extractPortals(sampleText);
      expect(portals.length).toBe(1);
    });

    it('guards against URLs leaking into username or password fields', () => {
      const text = 'Host: http://bad.com:80 User: http://leaked.com Pass: normal123';
      const portals = IptvScraper.extractPortals(text);
      expect(portals.length).toBe(0);
    });
  });

  describe('Hardcoded Channels & Matching Engine', () => {
    it('accurately matches combat sports channels with exclusions', () => {
      const boxingChannel = HardcodedChannels.byId('boxing')!;
      expect(boxingChannel).toBeDefined();

      // Positive matches
      expect(HardcodedChannels.matches('UK: SKY SPORTS BOXING HD', boxingChannel.keywords, boxingChannel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('US: DAZN BOXING FHD', boxingChannel.keywords, boxingChannel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('MATCHROOM FIGHT NIGHT LIVE', boxingChannel.keywords, boxingChannel.exclude)).toBe(true);

      // Exclusions
      expect(HardcodedChannels.matches('SKY CINEMA BOX OFFICE HD', boxingChannel.keywords, boxingChannel.exclude)).toBe(false);
      expect(HardcodedChannels.matches('KIDS BOX ENTERTAINMENT', boxingChannel.keywords, boxingChannel.exclude)).toBe(false);
    });

    it('accurately matches F1 and Motorsport streams', () => {
      const f1Channel = HardcodedChannels.byId('f1')!;
      expect(f1Channel).toBeDefined();

      expect(HardcodedChannels.matches('UK: SKY SPORTS F1 4K UHD', f1Channel.keywords, f1Channel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('US: FORMULA 1 GRAND PRIX RACE LIVE', f1Channel.keywords, f1Channel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('DE: SKY SPORT F1 HD', f1Channel.keywords, f1Channel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('US: CNN NEWSROOM', f1Channel.keywords, f1Channel.exclude)).toBe(false);
    });

    it('accurately matches Premier League and Champions League soccer', () => {
      const eplChannel = HardcodedChannels.byId('premier_league')!;
      const uclChannel = HardcodedChannels.byId('champions_league')!;

      expect(HardcodedChannels.matches('UK: SKY SPORTS PREMIER LEAGUE FHD', eplChannel.keywords, eplChannel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('US: PEACOCK PREMIER LEAGUE 1', eplChannel.keywords, eplChannel.exclude)).toBe(true);
      expect(HardcodedChannels.matches('TNT SPORTS UCL CHAMPIONS LEAGUE HD', uclChannel.keywords, uclChannel.exclude)).toBe(true);
    });

    it('accurately matches US Sports (ESPN, NBA, NFL)', () => {
      const espn = HardcodedChannels.byId('espn')!;
      const nba = HardcodedChannels.byId('nba')!;
      const nfl = HardcodedChannels.byId('nfl')!;

      expect(HardcodedChannels.matches('US: ESPN 2 LIVE HD', espn.keywords)).toBe(true);
      expect(HardcodedChannels.matches('US: NBA TV HD LIVE', nba.keywords)).toBe(true);
      expect(HardcodedChannels.matches('US: NFL NETWORK 1080P', nfl.keywords)).toBe(true);
    });
  });

  describe('Xtream-Codes Stream URL Builder & Date Formatter', () => {
    it('constructs correct live stream endpoints with credentials', () => {
      const portal: IptvPortal = {
        url: 'http://my-iptv.com:8080',
        username: 'alice',
        password: 'password123',
      };
      const stream = {
        streamId: '45678',
        name: 'Sky Sports Main Event',
        icon: '',
        categoryId: '1',
        containerExt: 'ts',
        kind: 'live' as const,
      };

      const url = IptvClient.streamUrl(portal, stream);
      expect(url).toBe('http://my-iptv.com:8080/live/alice/password123/45678.ts');
    });

    it('formats unix timestamp exp_date cleanly into readable date string', () => {
      // 1767225600 = 2026-01-01
      const formatted = IptvClient.formatExpiry(1767225600);
      expect(formatted).toContain('2026');
      expect(formatted).toContain('Jan');
    });
  });

  describe('Local Storage Store (IptvStore)', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('saves and loads verified portals', () => {
      const portals = [
        {
          portal: { url: 'http://test.com:80', username: 'u', password: 'p' },
          name: 'u',
          expiry: '2026-12-31',
          maxConnections: '2',
          activeConnections: '0',
        },
      ];

      IptvStore.savePortals(portals);
      const loaded = IptvStore.loadPortals();
      expect(loaded.length).toBe(1);
      expect(loaded[0].portal.url).toBe('http://test.com:80');
      expect(loaded[0].name).toBe('u');
    });

    it('saves and loads custom playlists', () => {
      const playlists = [
        {
          id: 'test-p1',
          name: 'My Channels',
          sourceUrl: 'http://example.com/ch.m3u',
          channels: [{ name: 'Ch 1', url: 'http://ch1.ts' }],
          updatedAt: Date.now(),
        },
      ];

      IptvStore.savePlaylists(playlists);
      const loaded = IptvStore.loadPlaylists();
      expect(loaded.length).toBe(1);
      expect(loaded[0].channels[0].name).toBe('Ch 1');
    });
  });
});

describe('Zap-list storage stays bounded on large playlists', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the playing channel first and never stores more than 400 entries', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ name: `Channel ${i}`, url: `https://host/${i}.m3u8` }));
    IptvZapStore.set(many, many[4321].url);
    const zap = IptvZapStore.get()!;
    expect(zap.channels.length).toBe(400);
    expect(zap.channels[0].url).toBe(many[4321].url);
    expect(zap.currentUrl).toBe(many[4321].url);
  });
});

describe('Live TV stream classification', () => {
  it('classifies HLS, DASH, MPEG-TS and direct URLs', () => {
    expect(detectIptvFormat('https://cdn.example.com/live.m3u8?token=1')).toBe('hls');
    expect(detectIptvFormat('https://cdn.example.com/watch?format=m3u8')).toBe('hls');
    expect(detectIptvFormat('https://cdn.example.com/watch?format=mpd')).toBe('dash');
    expect(detectIptvFormat('https://cdn.example.com/manifest.mpd')).toBe('dash');
    expect(detectIptvFormat('http://iptv.example.org:8080/live/u/p/456.ts')).toBe('mpegts');
    expect(detectIptvFormat('https://cdn.example.com/live/stream.flv?a=1')).toBe('mpegts');
    expect(detectIptvFormat('https://cdn.example.com/movie.mp4')).toBe('direct');
  });

  it('derives format hints from URL shape when the extension is missing', () => {
    expect(detectIptvFormat('https://host:8080/live/user/pass/12/playlist.m3u8')).toBe('hls');
    expect(detectIptvFormat('https://host:8080/live/user/pass/12')).toBe('mpegts');
  });

  it('uses the same classification for badges and the player engine hint', () => {
    const url = 'https://cdn.example.com/sports/xyz.m3u8';
    const { stream } = buildIptvPlayback({ name: 'F1', url, group: 'Motorsport' });
    expect(stream.format).toBe(detectIptvFormat(url));
    expect(formatIptvBadge(stream.format || '')).toBe('HLS');
    expect(formatIptvBadge('mpegts')).toBe('MPEG-TS');
  });
});

describe('Live TV local preferences', () => {
  beforeEach(() => localStorage.clear());

  it('caches health probes with a timestamp for card badges', () => {
    const url = 'https://cdn.example.com/a.m3u8';
    expect(LiveTvPrefs.getHealth(url)).toBeNull();
    const entry = LiveTvPrefs.setHealth(url, { ok: true, status: 206, latencyMs: 42, detail: 'Alive' });
    expect(entry.ok).toBe(true);
    expect(entry.at).toBeGreaterThan(0);
    expect(LiveTvPrefs.getHealth(url)?.latencyMs).toBe(42);
    expect(Object.keys(LiveTvPrefs.getAllHealth())).toContain(url);
  });

  it('keeps recently played channels most-recent-first and deduplicated', () => {
    const a = { name: 'Sky Sports F1', url: 'https://a/f1.m3u8', group: 'Motorsport' };
    const b = { name: 'ESPN', url: 'https://b/espn.ts', group: 'US Sports' };
    LiveTvPrefs.markPlayed(a);
    LiveTvPrefs.markPlayed(b);
    LiveTvPrefs.markPlayed(a);
    const recent = LiveTvPrefs.getLastPlayed();
    expect(recent.map((entry) => entry.url)).toEqual([a.url, b.url]);
    expect(recent[0].at).toBeGreaterThan(0);
  });

  it('remembers the playback mode per source', () => {
    LiveTvPrefs.setMode('https://a/one.ts', 'external');
    expect(LiveTvPrefs.getMode('https://a/one.ts')).toBe('external');
    expect(LiveTvPrefs.getMode('https://a/two.ts')).toBeNull();
    LiveTvPrefs.setMode('https://a/one.ts', 'internal');
    expect(LiveTvPrefs.getMode('https://a/one.ts')).toBe('internal');
  });

  it('finds the same channel on other sources despite country/quality noise', () => {
    const channels: M3uChannel[] = [
      { name: 'UK: SKY SPORTS F1 HD', url: 'https://a/f1.m3u8', group: 'Motorsport' },
      { name: 'US: FORMULA 1 GRAND PRIX LIVE', url: 'https://b/f1.ts', group: 'Motorsport' },
      { name: 'CNN HD', url: 'https://c/cnn.m3u8', group: 'News' },
    ];
    const alternates = LiveTvPrefs.findAlternates(channels, { name: 'Sky Sports F1', url: 'https://x/f1.m3u8' });
    expect(alternates.map((entry) => entry.url)).toEqual(['https://a/f1.m3u8']);
  });
});

