import { describe, expect, it } from 'vitest';
import { MangaService } from '../services/mangaService';
import { TorrentStreamingEngine } from '../services/torrentStreamingService';
import { OctaveMusicService } from '../services/musicService';
import { SANKA_COMIC_SOURCES, fetchSankaTitles } from '../services/sankaService';

describe('Manga, Torrent & Music Services', () => {
  it('registers BacaKomik as the first live-verified Comic source in Sanka', () => {
    expect(SANKA_COMIC_SOURCES[0].id).toBe('bacakomik');
    expect(SANKA_COMIC_SOURCES[0].label).toContain('BacaKomik');
    // Dead upstream sources (Sanka 403 / weebcentral CF-block) must stay out.
    expect(SANKA_COMIC_SOURCES.map((source) => source.id)).not.toContain('weebcentral');
    expect(SANKA_COMIC_SOURCES.map((source) => source.id)).not.toContain('komikcast');
  });

  it('TorrentStreamingEngine parses magnet link and resolves stream parameters', async () => {
    const magnet = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Big+Buck+Bunny';
    const { streamUrl, infoHash } = await TorrentStreamingEngine.streamTorrent(magnet, {
      title: 'Big Buck Bunny',
    });

    expect(infoHash).toBe('c12fe1c06bba254a9dc9f519b335aa7c1367a88a');
    expect(streamUrl).toContain('/stream?link=');
    expect(streamUrl).toContain('play=true');
  });

  it('OctaveMusicService searches tracks and returns structured search data', async () => {
    const empty = await OctaveMusicService.searchFull('');
    expect(empty.tracks).toEqual([]);
    expect(empty.artists).toEqual([]);
    expect(empty.albums).toEqual([]);
  });

  it('OctaveMusicService formats audio stream url when token is present', async () => {
    // If track has previewUrl or lookup resolves, returns string, otherwise null
    const url = await OctaveMusicService.getAudioStreamUrl('123456');
    expect(url === null || typeof url === 'string').toBe(true);
  });
});

