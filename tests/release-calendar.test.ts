import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeFetchText } from '../services/androidBridge';
import {
  CALENDAR_COUNTRIES, countryName, groupAnime, loadAnimeCalendar, loadTmdbCalendar,
  parseLegacySimkl, type AnimeRelease,
} from '../services/releaseCalendar';

vi.mock('../services/androidBridge', async (loadActual) => ({
  ...(await loadActual<typeof import('../services/androidBridge')>()),
  nativeFetchText: vi.fn(),
}));

vi.mock('../services/tmdbConfig', async (loadActual) => ({
  ...(await loadActual<typeof import('../services/tmdbConfig')>()),
  getTmdbApiKey: vi.fn(() => 'test-key'),
}));

describe('SIMKL legacy anime calendar', () => {
  const FIXTURE = JSON.stringify([
    { anime: { title: 'Frieren', ids: { simkl: 101 } }, airing_at: '2026-11-29T14:30:00Z', episode: { episode: 12 } },
    { anime: { name: 'Fallback Name', ids: { simkl: 102 } }, date: '2026-11-30T00:00:00Z' },
    { anime: { title: 'No Date' } },
    { anime: { title: '' } },
    'garbage',
  ]);

  it('parses legacy entries, skipping rows without a title or parsable date', () => {
    const rows = parseLegacySimkl(FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ simklId: 101, title: 'Frieren' });
    expect(rows[1]).toMatchObject({ simklId: 102, title: 'Fallback Name' });
    expect(rows[0].airAt).toBe(Date.parse('2026-11-29T14:30:00Z'));
  });

  it('accepts the alternative date keys and wrapped payloads', () => {
    const rows = parseLegacySimkl(JSON.stringify({ items: [
      { anime: { title: 'A' }, releaseDate: '2026-01-02T00:00:00Z' },
      { anime: { title: 'B' }, airingAt: '2026-01-01T00:00:00Z' },
    ] }));
    expect(rows.map((r) => r.title)).toEqual(['B', 'A']);
  });

  it('returns nothing for hostile payloads', () => {
    expect(parseLegacySimkl('not json')).toEqual([]);
    expect(parseLegacySimkl('[]')).toEqual([]);
    expect(parseLegacySimkl('{"anime": 42}')).toEqual([]);
  });

  it('caches the fetch for three hours and falls back to the cache on failure', async () => {
    vi.mocked(nativeFetchText)
      .mockResolvedValueOnce({ ok: true, status: 200, data: FIXTURE })
      .mockResolvedValueOnce({ ok: false, status: 500, data: '' });
    const first = await loadAnimeCalendar();
    expect(first).toHaveLength(2);
    expect(nativeFetchText).toHaveBeenCalledTimes(1);
    const second = await loadAnimeCalendar();
    expect(second).toHaveLength(2);
    expect(nativeFetchText).toHaveBeenCalledTimes(1);
    vi.resetAllMocks();
  });
});

describe('TMDB movies and series calendar', () => {
  const TODAY = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function moviePage(pages: number, entries: Array<Record<string, unknown>>) {
    return { results: entries, total_pages: pages };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/movie/upcoming')) {
        return { ok: true, json: async () => moviePage(1, [
          { id: 1, title: 'Future Movie', release_date: iso(3), poster_path: '/fm.jpg', genre_ids: [28, 12], overview: 'Boom' },
          { id: 1, title: 'Duplicate dropped', release_date: iso(3) },
          { id: 2, title: 'Yesterday Movie', release_date: iso(-1) },
          { id: 3, title: 'Too Old', release_date: '2020-01-01' },
        ]) };
      }
      if (String(url).includes('/tv/on_the_air') || String(url).includes('/tv/airing_today')) {
        return { ok: true, json: async () => moviePage(1, [
          { id: 9, name: 'Airing Show', first_air_date: '2024-05-06', poster_path: '/as.jpg', genre_ids: [18] },
        ]) };
      }
      return { ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch);
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

  it('groups upcoming movies by day, deduped, filtered to yesterday and newer, capped at 90', async () => {
    const groups = await loadTmdbCalendar('movie', 'us');
    expect(groups).toHaveLength(2);
    // Hikari labels non-today days with the weekday, so yesterday reads "Fri, …".
    const yesterday = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 1);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][yesterday.getDay()];
    expect(groups[0].label).toMatch(new RegExp(`^${weekday},`));
    expect(groups[0].entries.map((e) => e.title)).toEqual(['Yesterday Movie']);
    // iso(3) is three days out, which Hikari labels with the weekday.
    const upcoming = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 3);
    const upcomingWeekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][upcoming.getDay()];
    expect(groups[1].label).toMatch(new RegExp(`^${upcomingWeekday},`));
    expect(groups[1].entries.map((e) => e.title)).toEqual(['Future Movie']);
    expect(groups[1].entries[0].genres).toEqual(['Action', 'Adventure']);
    expect(groups[1].entries[0].poster).toContain('image.tmdb.org/t/p/w500/fm.jpg');
    expect(groups[1].entries[0].raw.id).toBe(1);
  });

  it('puts on-the-air series in today group with region name for airing-today blurbs', async () => {
    const groups = await loadTmdbCalendar('tv', 'JP');
    expect(groups).toHaveLength(1);
    expect(groups[0].entries[0]).toMatchObject({ kind: 'tv', title: 'Airing Show', genres: ['Drama'] });
    const airingToday = await loadTmdbCalendar('episode', 'JP');
    expect(airingToday[0].entries[0].blurb).toBe('Airing today · Japan');
  });

  it('serves the cached groups when the API turns hostile', async () => {
    const first = await loadTmdbCalendar('movie', 'gb');
    expect(first.length).toBeGreaterThan(0);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    const second = await loadTmdbCalendar('movie', 'gb');
    expect(second).toEqual(first);
  });
});

describe('calendar grouping helpers', () => {
  it('lists the 20 Hikari regions and falls back on unknown codes', () => {
    expect(CALENDAR_COUNTRIES).toHaveLength(20);
    expect(countryName('JP')).toBe('Japan');
    expect(countryName('XX')).toBe('XX');
  });

  it('groups anime releases into day buckets with episode blurbs', () => {
    const base = Date.now();
    const releases: AnimeRelease[] = [
      { simklId: 1, title: 'Show A', titleRomaji: 'A Raw', airAt: base + 3600000, episode: 5, episodeTitle: 'Fifth', totalEpisodes: 12 },
      { simklId: 2, title: 'Show B', airAt: base + 7200000 },
      { simklId: 3, title: 'Show C', airAt: base + 26 * 3600000 },
    ];
    const groups = groupAnime(releases);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups[0].entries[0].title).toBe('Show A · A Raw');
    expect(groups[0].entries[0].blurb).toBe('Episode 5 · Fifth');
    expect(groups[0].entries[1].title).toBe('Show B');
  });
});
