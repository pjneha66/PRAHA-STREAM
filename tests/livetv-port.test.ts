// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  toEpochMs,
  nowNext,
  epgProgress,
  guideTime,
  upcomingGuide,
  splitGroupPath,
  buildGroupTree,
  buildXtreamGroupTree,
  buildM3uGroupTree,
  flattenGroups,
  findGroup,
  parsePlaylistText,
  importPlaylists,
  summarizeImport,
  importPortalsFromJson,
  parseEspnScoreboard,
  ESPN_LEAGUES,
  channelsForMatch,
  resolveBroadcast,
  mergeMatchSources,
  dedupeLiveMatches,
  bestEpgMatch,
  hitGroupKey,
  groupHits,
  normalizeLiveTvAppearance,
  loadLiveTvAppearance,
  saveLiveTvAppearance,
  updateLiveTvAppearance,
  resetLiveTvAppearance,
  toggleVisibleCategory,
  reorderVisibleCategory,
  buildPreviewUrl,
  buildEpgPreviewUrl,
  favoriteKey,
  toggleFavoriteKey,
  adoptFavoriteEntries,
  pasteRawUrl,
  isPasteShEncryptedUrl,
  portalKey,
} from '../services/liveTv/index';
import type { LiveMatchEvent } from '../services/iptvService';

const KICKOFF = new Date('2026-11-21T20:00:00Z').getTime();

beforeEach(() => {
  localStorage.clear();
});

describe('EPG now/next', () => {
  const guide = [
    { title: 'News', start: KICKOFF - 3600_000, stop: KICKOFF - 60_000 },
    { title: 'Match', description: 'Live coverage', start: KICKOFF, stop: KICKOFF + 7200_000 },
    { title: 'Highlights', start: KICKOFF + 7200_000, stop: KICKOFF + 10800_000 },
  ];

  it('converts Xtream seconds, millis and ISO strings', () => {
    expect(toEpochMs(1700000000)).toBe(1700000000000);
    expect(toEpochMs(1700000000000)).toBe(1700000000000);
    expect(toEpochMs('2026-11-21T20:00:00Z')).toBe(KICKOFF);
    expect(toEpochMs('not a date')).toBeNull();
  });

  it('picks the on-air row and the one after it at the boundary', () => {
    const at = KICKOFF;
    const { now, next } = nowNext(guide, at);
    expect(now?.title).toBe('Match');
    expect(next?.title).toBe('Highlights');
  });

  it('clamps progress to 0…1 and formats guide times', () => {
    const { now } = nowNext(guide, KICKOFF + 3600_000);
    expect(epgProgress(now, KICKOFF + 3600_000)).toBeCloseTo(0.5);
    expect(epgProgress(now, KICKOFF - 100_000)).toBe(0);
    expect(epgProgress(now, KICKOFF + 99_000_000)).toBe(1);
    expect(guideTime(KICKOFF)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('drops ended rows from a refreshed guide', () => {
    expect(upcomingGuide(guide, KICKOFF + 60_000).map((entry) => entry.title)).toEqual(['Match', 'Highlights']);
  });
});

describe('group trees', () => {
  it('splits mixed provider separators into nested segments', () => {
    expect(splitGroupPath('US / Sports | Soccer')).toEqual(['US', 'Sports', 'Soccer']);
    expect(splitGroupPath('')).toEqual([]);
  });

  it('nests generic groups and counts the whole subtree', () => {
    const tree = buildGroupTree(
      [{ name: 'a', group: 'Sports / Soccer' }, { name: 'b', group: 'Sports / Tennis' }, { name: 'c', group: '' }],
      (item) => item.group,
    );
    expect(tree.count).toBe(3);
    const sports = findGroup(tree, ['Sports'])!;
    expect(sports.count).toBe(2);
    expect(sports.children.map((node) => node.name)).toEqual(['Soccer', 'Tennis']);
    expect(flattenGroups(tree).map((node) => node.name)).toContain('Uncategorised');
  });

  it('keeps empty Xtream categories and places streams by category id', () => {
    const tree = buildXtreamGroupTree(
      [{ id: '1', name: 'Sports / Soccer' }, { id: '2', name: 'News' }],
      [{ streamId: '10', name: 'ESPN', categoryId: '1' }, { streamId: '11', name: 'CNN', categoryId: '?'}],
    );
    expect(findGroup(tree, ['Sports', 'Soccer'])?.items.map((item) => item.name)).toEqual(['ESPN']);
    expect(findGroup(tree, ['Other'])?.items.map((item) => item.name)).toEqual(['CNN']);
    expect(findGroup(tree, ['News'])?.count).toBe(0);
  });

  it('nests M3U playlists into group-title paths', () => {
    const tree = buildM3uGroupTree([
      { name: 'Mine', channels: [{ name: 'A', url: 'u1', group: 'UK | Soccer' }, { name: 'B', url: 'u2' }] },
    ]);
    expect(findGroup(tree, ['Mine', 'UK', 'Soccer'])?.items).toHaveLength(1);
    expect(tree.count).toBe(2);
  });
});

describe('multi-playlist import', () => {
  it('parses EXTINF attributes and EXTGRP headers', () => {
    const channels = parsePlaylistText('#EXTM3U\n#EXTINF:-1 tvg-id="cnn.us" tvg-logo="l.png" group-title="News",CNN\nhttp://x/cnn.m3u8\n#EXTGRP: Sports\n#EXTINF:-1,BBC\nhttp://x/bbc.m3u8\n');
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ name: 'CNN', tvgId: 'cnn.us', group: 'News', logo: 'l.png' });
    expect(channels[1].group).toBe('Sports');
  });

  it('counts added / skipped / failed for a batch', async () => {
    const bodies: Record<string, string> = {
      'https://a/x.m3u/': '#EXTM3U\n#EXTINF:-1,A\nhttps://a/a.m3u8\n',
      'https://b/x.m3u': 'garbage',
    };
    const fetchText = async (url: string) => {
      if (url === 'https://c/x.m3u') throw new Error('timeout');
      return bodies[url] || '';
    };
    const result = await importPlaylists(
      [
        { name: 'A', sourceUrl: 'https://a/x.m3u/' },
        { name: 'A again', sourceUrl: 'https://a/x.m3u' },
        { name: 'B', sourceUrl: 'https://b/x.m3u' },
        { name: 'C', sourceUrl: 'https://c/x.m3u' },
        { name: 'Bad', sourceUrl: 'not-a-url' },
        { name: 'Inline', text: '#EXTM3U\n#EXTINF:-1,D\nhttps://d/d.m3u8\n' },
      ],
      { fetchText, existing: [{ id: 'old', name: 'Old', sourceUrl: 'https://old/list.m3u', channels: [], updatedAt: 0 }] },
    );
    expect(summarizeImport(result)).toEqual({ added: 2, skipped: 1, failed: 3 });
    expect(result.playlists.map((item) => item.name)).toEqual(['A', 'Inline']);
    expect(result.errors).toHaveLength(3);
  });

  it('bulk-imports portals, skipping duplicates and counting failed verification', async () => {
    const json = JSON.stringify([
      { url: 'http://one', username: 'u', password: 'p' },
      { url: 'http://two', username: 'u', password: 'p' },
      { url: 'http://three', username: 'v', password: 'w' },
      { url: '', username: 'x', password: 'y' },
    ]);
    const result = await importPortalsFromJson(json, {
      existing: [{ url: 'http://one', username: 'u', password: 'p' }],
      verify: async (portal) => portal.url === 'http://three',
    });
    // The row with an empty URL is filtered while parsing (as in VyseTV);
    // the existing credential and the batch duplicate are both skipped.
    expect(result).toMatchObject({ added: 1, skipped: 2, failed: 0 });
    expect(result.portals[0].url).toBe('http://three');
    expect((await importPortalsFromJson('nope')).error).toContain('Invalid JSON');
  });
});

describe('match finder', () => {
  const league = ESPN_LEAGUES.find((item) => item.path === 'soccer/eng.1')!;
  const scoreboard = {
    leagues: [{ logos: [{ href: 'https://logo/pl.png' }] }],
    events: [{
      id: '123',
      date: '2026-11-21T20:00:00Z',
      name: 'Arsenal vs Chelsea',
      status: { type: { state: 'in', shortDetail: "67'" } },
      competitions: [{
        venue: { fullName: 'Emirates' },
        competitors: [
          { homeAway: 'home', score: '2', team: { shortDisplayName: 'Arsenal', abbreviation: 'ARS', logo: 'https://a.png' } },
          { homeAway: 'away', score: '1', team: { shortDisplayName: 'Chelsea', abbreviation: 'CHE', logo: 'https://c.png' } },
        ],
        broadcasts: [{ names: ['USA Net'] }],
        geoBroadcasts: [{ media: { shortName: 'TNT' } }],
      }],
    }],
  };

  it('parses an ESPN scoreboard into live matches with broadcasters', () => {
    const matches = parseEspnScoreboard(scoreboard, league);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: 'soccer/eng.1/123', state: 'live', status: "67'", home: { name: 'Arsenal', score: '2' }, away: { name: 'Chelsea' } });
    expect(matches[0].broadcasts).toEqual(['USA Net', 'TNT']);
    expect(matches[0].start).toBe(KICKOFF);
  });

  it('resolves ESPN aliases and falls back to the league rights holders', () => {
    const match = parseEspnScoreboard(scoreboard, league)[0];
    const channels = channelsForMatch(match, [{ id: 'nbc_sports', name: 'NBC Sports' }, { id: 'sky_sports', name: 'Sky Sports' }]);
    expect(channels.filter((channel) => channel.id === 'nbc_sports')).toHaveLength(1);
    expect(channels.map((channel) => channel.id)).toContain('sky_sports');
    expect(resolveBroadcast('Some Random TV').id).toBe('bc_some random tv');
  });

  it('merges ESPN fixtures with existing scraper results without duplicates', () => {
    const existing: LiveMatchEvent[] = [{
      id: 'nuvio-42', title: 'Arsenal vs Chelsea', league: 'Premier League', category: 'Soccer',
      timeLabel: 'LIVE NOW', isLive: true, streamUrl: 'https://stream/x', startsAt: Math.floor(KICKOFF / 1000) + 30,
    }];
    const schedule = parseEspnScoreboard(scoreboard, league);
    const merged = mergeMatchSources(existing, schedule);
    expect(merged).toHaveLength(1);
    expect(merged[0].streamUrl).toBe('https://stream/x');
    expect(dedupeLiveMatches([...existing, { ...existing[0], id: 'dami-42' }])).toHaveLength(1);
  });

  it('finds the guide row mentioning both teams inside the kick-off window', () => {
    const schedule = parseEspnScoreboard(scoreboard, league)[0];
    const best = bestEpgMatch(schedule, [
      { title: 'Arsenal v Chelsea', start: KICKOFF - 7200_000, stop: KICKOFF - 7000_000 },
      { title: 'Live: Chelsea vs Arsenal', start: KICKOFF - 300_000, stop: KICKOFF + 5400_000 },
    ]);
    expect(best?.title).toBe('Live: Chelsea vs Arsenal');
  });

  it('groups equivalent feeds by number and language and dedupes their hits', () => {
    expect(hitGroupKey('beIN SPORTS 2 AR')).toBe(hitGroupKey('BEIN 2 AR'));
    const groups = groupHits(['beIN 1 AR', 'beIN 2 AR', 'beIN 2 AR'], (name) => name);
    expect([...groups.values()].map((list) => list.length)).toEqual([1, 2]);
  });
});

describe('appearance persistence', () => {
  it('normalises bad values and merges newly added categories', () => {
    const value = normalizeLiveTvAppearance({
      heroStyle: 'nonsense', heroRotateSeconds: 999, browserGridColumns: 0,
      visibleCategories: ['My category'], cardDensity: 'cinematic',
    });
    expect(value.heroStyle).toBe('immersive');
    expect(value.heroRotateSeconds).toBe(60);
    expect(value.browserGridColumns).toBe(1);
    expect(value.visibleCategories[0]).toBe('My category');
    expect(value.visibleCategories).toContain('International Sports');
    expect(value.cardDensity).toBe('cinematic');
  });

  it('round-trips through localStorage and supports reset', () => {
    saveLiveTvAppearance({ ...loadLiveTvAppearance(), browserLayout: 'compactList', showEpgSnippet: false });
    expect(loadLiveTvAppearance().browserLayout).toBe('compactList');
    updateLiveTvAppearance({ heroStyle: 'minimalist' });
    expect(loadLiveTvAppearance()).toMatchObject({ heroStyle: 'minimalist', showEpgSnippet: false });
    expect(resetLiveTvAppearance().heroStyle).toBe('immersive');
  });

  it('toggles and reorders visible categories without emptying the list', () => {
    const original = loadLiveTvAppearance().visibleCategories;
    const trimmed = toggleVisibleCategory(original[0]);
    expect(trimmed).not.toContain(original[0]);
    const reordered = reorderVisibleCategory(0, 2);
    expect(reordered[1]).toBe(trimmed[0]);
  });
});

describe('portal browser helpers', () => {
  const portal = { url: 'http://example.com:8080/', username: 'u@x', password: 'p/ss', source: 'Manual' };
  const stream = { streamId: '42', name: 'ESPN', containerExt: 'ts' };

  it('builds Xtream preview and EPG URLs with encoded credentials', () => {
    expect(buildPreviewUrl(portal, stream)).toBe('http://example.com:8080/live/u%40x/p%2Fss/42.ts');
    expect(buildEpgPreviewUrl(portal, '42', 2)).toContain('action=get_short_epg');
    expect(portalKey(portal)).toBe('http://example.com:8080|u@x|p/ss');
  });

  it('toggles per-portal favourites and adopts bare keys with stream details', () => {
    const key = favoriteKey(portal, stream);
    expect(toggleFavoriteKey([], key)).toEqual([key]);
    expect(toggleFavoriteKey([key], key)).toEqual([]);
    expect(adoptFavoriteEntries([], portal, [stream], [key])[0]).toMatchObject({
      key, title: 'ESPN', url: buildPreviewUrl(portal, stream), from: 'Manual',
    });
  });

  it('recognises paste sites and converts raw URLs', () => {
    expect(isPasteShEncryptedUrl('https://paste.sh/abc#key')).toBe(true);
    expect(pasteRawUrl('https://pastebin.com/abc123')).toBe('https://pastebin.com/raw/abc123');
    expect(pasteRawUrl('https://pastes.dev/xyz')).toBe('https://api.pastes.dev/xyz');
    expect(pasteRawUrl('https://paste.ee/p/AbCDe')).toBe('https://paste.ee/r/AbCDe');
    expect(pasteRawUrl('https://pastee.dev/d/AbCDe')).toBe('https://pastee.dev/r/AbCDe');
  });
});
