// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  bareAddonMedia,
  catalogTitle,
  idFor,
  mediaFromAddon,
  minutes,
  parseVideos,
  segment,
  streamIdFor,
  typeLabel,
  typeOk,
  type AddonTarget,
} from '../services/metaAddons';
import type { InstalledAddon } from '../types';

/**
 * "Any metadata addon, from Nuvio, Stremio or Vega" means two hard things: a
 * title keeps the id its own addon gave it, and an addon is only asked by an id
 * it declared it accepts. Both live here — `idFor` is the second, and the
 * collection/episode reading is the first (a collection's films are titles, a
 * show's videos are episodes, and telling them apart is what decides which).
 */

describe('mediaFromAddon — a title from a catalog or details answer', () => {
  it('keeps the addon\'s own id, which is what it will be asked by', () => {
    const item = mediaFromAddon({ id: 'kitsu:7442', type: 'anime', name: 'A Show' });
    expect(item).toMatchObject({ id: 'kitsu:7442', addonType: 'anime', type: 'series', title: 'A Show' });
  });

  it('reads the id from `imdb_id` when that is all there is', () => {
    expect(mediaFromAddon({ imdb_id: 'tt0944947', name: 'Game of Thrones' })?.id).toBe('tt0944947');
  });

  it('refuses a row with no id or no name, since it could not be opened', () => {
    for (const value of [null, 'text', {}, { id: 'tt1' }, { name: 'A' }]) {
      expect(mediaFromAddon(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('calls `series`, `anime` and `channel` shows, keeping the addon\'s own word', () => {
    for (const kind of ['series', 'anime', 'channel']) {
      expect(mediaFromAddon({ id: 'x', name: 'A', type: kind }), kind)
        .toMatchObject({ type: 'series', addonType: kind });
    }
    expect(mediaFromAddon({ id: 'x', name: 'A', type: 'movie' })).toMatchObject({ type: 'movie', addonType: 'movie' });
  });

  it('does not call a `tv` entry a show: in a plugin repository it is a live channel', () => {
    // One playable item, and `typeLabel` already heads that list "TV channels".
    expect(mediaFromAddon({ id: 'x', name: 'A', type: 'tv' })).toMatchObject({ type: 'movie', addonType: 'tv' });
  });

  it('finds the year in releaseInfo or in released', () => {
    expect(mediaFromAddon({ id: 'x', name: 'A', releaseInfo: '2008-2013' })?.year).toBe('2008');
    expect(mediaFromAddon({ id: 'x', name: 'A', released: '1999-03-31T00:00:00Z' })?.year).toBe('1999');
  });

  it('takes TMDB\'s id from either spelling, so the built-in sources can play it', () => {
    expect(mediaFromAddon({ id: 'x', name: 'A', tmdbId: 550 })?.tmdbId).toBe(550);
    expect(mediaFromAddon({ id: 'tmdb:550', name: 'A' })?.tmdbId).toBe(550);
  });

  it('reads a show from its videos when the addon called it a film', () => {
    // A catalog of "movies" whose entries carry episodes: they are a show.
    const item = mediaFromAddon({
      id: 'tt0944947',
      name: 'Game of Thrones',
      type: 'movie',
      videos: [{ id: 'tt0944947:1:1' }, { id: 'tt0944947:1:2' }],
    });
    expect(item?.type).toBe('series');
  });

  it('does not call a collection a show just because it lists several films', () => {
    const item = mediaFromAddon({
      id: 'mc:1234',
      name: 'The Trilogy',
      type: 'movie',
      videos: [{ id: 'tt1' }, { id: 'tt2' }, { id: 'tt3' }],
    });
    expect(item?.type).toBe('movie');
  });

  it('keeps only a picture and a logo that are http', () => {
    const item = mediaFromAddon({
      id: 'x', name: 'A',
      poster: 'https://cdn.example/p.jpg',
      background: 'file:///etc/passwd',
      logo: 'javascript:alert(1)',
    });
    expect(item?.poster).toBe('https://cdn.example/p.jpg');
    expect(item?.backdrop).toBeUndefined();
  });

  it('carries the addon it came from, which is what asks first for details', () => {
    const from = { manifestUrl: 'https://addon.example/manifest.json' } as InstalledAddon;
    expect(mediaFromAddon({ id: 'x', name: 'A' }, { from })?.addonUrl).toBe('https://addon.example/manifest.json');
  });
});

describe('bareAddonMedia — a title from an id alone', () => {
  it('makes a show from a show type, with nothing filled in yet', () => {
    expect(bareAddonMedia('series', 'tt0944947:1:1')).toMatchObject({
      id: 'tt0944947:1:1', imdbId: 'tt0944947', type: 'series', addonType: 'series', title: '',
    });
  });

  it('reads a TMDB id out of the id', () => {
    expect(bareAddonMedia('movie', 'tmdb:550')?.tmdbId).toBe(550);
  });
});

describe('parseVideos — a show\'s episodes', () => {
  it('orders them by season and number', () => {
    const videos = parseVideos([
      { id: 'x:2:1', season: 2, episode: 1, title: 'S2E1' },
      { id: 'x:1:2', season: 1, episode: 2 },
      { id: 'x:1:1', season: 1, episode: 1 },
    ]);
    expect(videos.map((video) => `${video.season}:${video.episode}`)).toEqual(['1:1', '1:2', '2:1']);
  });

  it('names an unnamed episode after its number', () => {
    expect(parseVideos([{ id: 'x:1:7', season: 1, episode: 7 }])[0].name).toBe('Episode 7');
  });

  it('keeps one episode per season and number', () => {
    const videos = parseVideos([
      { id: 'a', season: 1, episode: 1, title: 'First' },
      { id: 'b', season: 1, episode: 1, title: 'Duplicate' },
    ]);
    expect(videos).toHaveLength(1);
    expect(videos[0].name).toBe('First');
  });

  it('numbers a seasonless run from the oldest, as a channel\'s videos are', () => {
    const videos = parseVideos([
      { id: 'c', title: 'Second', released: '2026-02-01' },
      { id: 'a', title: 'First', released: '2026-01-01' },
    ]);
    expect(videos.map((video) => `${video.season}:${video.episode}:${video.name}`)).toEqual(['0:1:First', '0:2:Second']);
  });

  it('drops a video with no id at all', () => {
    const videos = parseVideos([{ title: 'No id' }, { id: 'ok', season: 1, episode: 1 }, null, 'text']);
    expect(videos.map((video) => video.id)).toEqual(['ok']);
  });

  it('takes a collection film\'s id from its TMDB id when it has none', () => {
    const videos = parseVideos([{ tmdbId: 603, title: 'The Matrix' }]);
    expect(videos[0].id).toBe('tmdb:603');
  });

  it('reads the fields the episode list shows', () => {
    const [video] = parseVideos([{
      id: 'x:1:1',
      season: 1,
      episode: 1,
      name: 'Pilot',
      overview: 'The one that starts it',
      thumbnail: 'https://cdn.example/t.jpg',
      released: '2008-01-20T00:00:00Z',
      runtime: '58 min',
      imdbSeason: 1,
      imdbEpisode: 1,
      streams: [{ url: 'https://cdn.example/e.m3u8' }],
    }]);
    expect(video).toMatchObject({
      name: 'Pilot',
      overview: 'The one that starts it',
      thumbnail: 'https://cdn.example/t.jpg',
      released: '2008-01-20',
      imdbSeason: 1,
      imdbEpisode: 1,
    });
    expect(video.runtime).toBe(58);
    expect(video.inline).toHaveLength(1);
  });

  it('answers nothing for anything that is not a list', () => {
    for (const value of [null, undefined, 'text', 42, {}]) {
      expect(parseVideos(value)).toEqual([]);
    }
  });
});

describe('minutes — a runtime, however it is written', () => {
  it('reads a number, a "90 min" and a "1h 30m"', () => {
    expect(minutes(90)).toBe(90);
    expect(minutes('90 min')).toBe(90);
    expect(minutes('1h 30m')).toBe(90);
    expect(minutes('2h')).toBe(120);
  });

  it('answers nothing for a runtime it cannot read', () => {
    expect(minutes('long')).toBeUndefined();
    expect(minutes(undefined)).toBeUndefined();
    expect(minutes(0)).toBeUndefined();
  });
});

describe('segment / typeLabel / catalogTitle', () => {
  it('makes a heading out of an addon\'s own word for its type', () => {
    expect(typeLabel('movie')).toBe('Movies');
    expect(typeLabel('series')).toBe('Series');
    expect(typeLabel('anime')).toBe('Anime');
    expect(typeLabel('collections')).toBe('Collections');
    expect(typeLabel('kitsu')).toBe('Kitsu');
    expect(typeLabel('')).toBe('Titles');
  });

  it('names a catalog and what it lists, without saying it twice', () => {
    expect(catalogTitle({ name: 'Popular Movies', type: 'movie' })).toBe('Popular Movies');
    expect(catalogTitle({ name: 'Popular', type: 'movie' })).toBe('Popular · Movies');
    expect(catalogTitle({ type: 'series' })).toBe('Series');
  });

  it('escapes a segment so a title\'s own id cannot change the address', () => {
    expect(segment('a b')).toBe('a%20b');
    expect(segment('../etc')).toBe('..%2Fetc');
    expect(segment('a/b')).toBe('a%2Fb');
  });
});

describe('idFor — the id an addon is asked by', () => {
  const target = (over: Partial<AddonTarget> = {}): AddonTarget => ({
    type: 'series',
    raw: 'tt0944947',
    imdb: 'tt0944947',
    imdbSeason: 1,
    imdbEpisode: 1,
    title: 'Game of Thrones',
    videos: [],
    inline: [],
    ...over,
  });

  it('asks an addon with no prefixes by the IMDb id', () => {
    expect(idFor(target(), [])).toBe('tt0944947');
    expect(idFor(target({ type: 'movie' }), [])).toBe('tt0944947');
  });

  it('asks by the episode when one is named', () => {
    expect(idFor(target({ season: 1, episode: 1 }), [])).toBe('tt0944947:1:1');
    expect(idFor(target({ video: 'tt0944947:1:9' }), [])).toBe('tt0944947:1:9');
  });

  it('uses the title\'s own id when the addon accepts it — how a Kitsu title is asked', () => {
    const kitsu = target({ raw: 'kitsu:7442', imdb: undefined, imdbSeason: undefined, imdbEpisode: undefined, type: 'anime' });
    expect(idFor(kitsu, ['kitsu:'])).toBe('kitsu:7442');
    expect(idFor(kitsu, ['tt'])).toBeNull();
  });

  it('offers TMDB\'s id when the addon takes `tmdb:`', () => {
    expect(idFor(target({ raw: 'x', imdb: 'tt0944947', tmdb: 1399, type: 'movie' }), ['tmdb:'])).toBe('tmdb:1399');
  });

  it('never asks for an episode under id numbers that are not known', () => {
    // A show whose episodes came from Kitsu has no IMDb numbers: asking for
    // `tt…:1:1` would fetch a different episode, so it is not asked at all.
    const kitsu = target({ raw: 'kitsu:7442', imdb: 'tt0944947', imdbSeason: undefined, imdbEpisode: undefined, season: 1, episode: 1, type: 'anime' });
    expect(idFor(kitsu, [])).toBeNull();
    expect(idFor(kitsu, ['kitsu:'])).toBe('kitsu:7442:1:1');
  });

  it('answers null when the addon names a prefix the title has no id for', () => {
    expect(idFor(target(), ['kitsu:'])).toBeNull();
    expect(idFor(target({ raw: 'x', imdb: undefined }), ['tt'])).toBeNull();
  });
});

describe('streamIdFor / typeOk — whether an addon can be asked at all', () => {
  const addon = (resources: InstalledAddon['manifest']['resources']): InstalledAddon => ({
    manifestUrl: 'https://addon.example/manifest.json',
    manifest: { id: 'a', name: 'A', version: '1', resources, types: ['movie', 'series'], catalogs: [] },
    enabled: true,
    installedAt: 0,
    updatedAt: 0,
  });

  const target = { type: 'series', raw: 'tt0944947', imdb: 'tt0944947', title: 'A', videos: [], inline: [] } as AddonTarget;

  it('asks by the stream resource\'s own prefixes', () => {
    expect(streamIdFor(addon([{ name: 'stream', types: [], idPrefixes: ['tt'] }]), target)).toBe('tt0944947');
    expect(streamIdFor(addon([{ name: 'stream', types: [], idPrefixes: ['kitsu:'] }]), target)).toBeNull();
  });

  it('does not ask an addon that only carries other types', () => {
    expect(streamIdFor(addon([{ name: 'stream', types: ['movie'] }]), target)).toBeNull();
    expect(streamIdFor(addon([{ name: 'stream', types: ['series'] }]), target)).toBe('tt0944947');
  });

  it('treats an addon that names no types as taking any', () => {
    expect(typeOk(target, [])).toBe(true);
    expect(typeOk(target, ['movie'])).toBe(false);
  });
});
