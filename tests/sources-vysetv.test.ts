import { describe, expect, it } from 'vitest';
import { parseTorrentTitle, parseTorrentPath } from '../services/sources/parseTorrentTitle';
import { infoHashOf, trackersOf, bytesOf, parseApi, parseHtml, filterHits, type KnabenHit } from '../services/sources/knaben';
import { decryptMovyPayload, movyQuality, MOVY_SERVERS } from '../services/sources/movy';

describe('parseTorrentTitle (VyseTV port)', () => {
  it('reads a film release into title, year and resolution', () => {
    const parsed = parseTorrentTitle('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX');
    expect(parsed.title).toBe('Dune Part Two');
    expect(parsed.year).toBe(2024);
    expect(parsed.resolution).toBe('2160p');
  });

  it('reads a single episode', () => {
    const parsed = parseTorrentTitle('Fallout.S01E02.1080p.WEB-DL.x264');
    expect(parsed.title).toBe('Fallout');
    expect(parsed.season).toBe(1);
    expect(parsed.episode).toBe(2);
  });

  it('reads an episode range as [start, end]', () => {
    const parsed = parseTorrentTitle('The.Bear.S03E01-E04.1080p.WEB-DL');
    expect(parsed.season).toBe(3);
    expect(parsed.episodeRange).toEqual([1, 4]);
  });

  it('leaves a season pack with no episode', () => {
    const parsed = parseTorrentTitle('Severance.S02.2160p.WEB-DL.COMPLETE');
    expect(parsed.season).toBe(2);
    expect(parsed.episode ?? null).toBeNull();
  });

  it('takes the season from a parent folder when the file name has none', () => {
    const parsed = parseTorrentPath('Show/Season 05/01 - Episode.mkv');
    expect(parsed.season).toBe(5);
  });
});

describe('knaben (VyseTV port)', () => {
  const magnet = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=Some.Release&tr=udp%3A%2F%2Ftracker.example%3A1337';

  it('normalises an info hash from a magnet link', () => {
    expect(infoHashOf(magnet)).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(infoHashOf('abcdef0123456789abcdef0123456789abcdef01')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(infoHashOf('not a hash')).toBeNull();
  });

  it('converts a base32 info hash to hex', () => {
    // The same 20 bytes, written the way old magnets do.
    expect(infoHashOf('VPG66AJDIVTYTK6N54ASGRLHRGV433YB')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(infoHashOf('not-a-hash-at-all')).toBeNull();
  });

  it('pulls trackers out of a magnet', () => {
    expect(trackersOf(magnet)).toEqual(['udp://tracker.example:1337']);
  });

  it('reads a size label', () => {
    expect(bytesOf('885.68 MB')).toBe(885680000);
    expect(bytesOf('2.4 GB')).toBe(2400000000);
    expect(bytesOf('no size here')).toBeNull();
  });

  it('parses the JSON API answer', () => {
    const body = JSON.stringify({
      hits: [
        { title: 'Fallout.S01E02.1080p.WEB-DL.x264', hash: 'abcdef0123456789abcdef0123456789abcdef01', magnetUrl: magnet, bytes: 1_500_000_000, seeders: 42, categoryId: 2000000 },
        { title: 'Something.Else.2020.1080p', hash: '1111111111111111111111111111111111111111', magnetUrl: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111', bytes: 900_000_000, seeders: 3, categoryId: 3000000 },
      ],
    });
    const hits = parseApi(body);
    expect(hits).toHaveLength(2);
    expect(hits[0].name).toBe('Fallout.S01E02.1080p.WEB-DL.x264');
    expect(hits[0].infoHash).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(hits[0].seeders).toBe(42);
  });

  it('drops a hit with no hash and ignores a non-video category list', () => {
    const body = JSON.stringify({
      hits: [
        { title: 'No.Hash.Release', magnetUrl: 'magnet:?xt=urn:btih:zzz', seeders: 1 },
        { title: 'An.Album.2024.FLAC', hash: '2222222222222222222222222222222222222222', magnetUrl: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222', seeders: 9, categoryId: [1000000] },
        { title: 'A.Film.2024.1080p', hash: '3333333333333333333333333333333333333333', magnetUrl: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333', seeders: 4, categoryId: [2000000] },
      ],
    });
    const hits = parseApi(body);
    expect(hits.map((hit) => hit.name)).toEqual(['A.Film.2024.1080p']);
  });

  it('returns nothing for a body that is not JSON', () => {
    expect(parseApi('<html>nope</html>')).toEqual([]);
  });

  it('parses the search page fallback', () => {
    const html = `<table><tbody><tr>
      <td>TV</td><td>x</td><td>1.2 GB</td><td>x</td><td>128</td><td>x</td>
      <td><div class="text-wrap w-100"><a href="/details/1">Fallout S01E02 1080p</a></div></td>
      <td><a href="${magnet}">magnet</a></td>
    </tr></tbody></table>`;
    const hits = parseHtml(html);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Fallout S01E02 1080p');
    expect(hits[0].seeders).toBe(128);
    expect(hits[0].bytes).toBe(1200000000);
  });

  it('keeps only the requested title, season and episode', () => {
    const base: Omit<KnabenHit, 'name'> = { infoHash: 'abcdef0123456789abcdef0123456789abcdef01', seeders: 10, trackers: [], pack: false };
    const hits: KnabenHit[] = [
      { ...base, name: 'Fallout.S01E02.1080p.WEB-DL' },
      { ...base, name: 'Fallout.S01E03.1080p.WEB-DL' },
      { ...base, name: 'Fallout.S02E02.1080p.WEB-DL' },
      { ...base, name: 'Fallout.S01.1080p.WEB-DL' },
      { ...base, name: 'Fallout.2024.1080p.WEB-DL' },
      { ...base, name: 'Another.Show.S01E02.1080p' },
    ];
    const kept = filterHits(hits, { title: 'Fallout', series: true, season: 1, episode: 2 });
    const names = kept.map((hit) => hit.name);
    expect(names).toContain('Fallout.S01E02.1080p.WEB-DL');
    expect(names).toContain('Fallout.S01.1080p.WEB-DL'); // a season pack is kept
    expect(names).not.toContain('Fallout.S01E03.1080p.WEB-DL');
    expect(names).not.toContain('Fallout.S02E02.1080p.WEB-DL');
    expect(names).not.toContain('Another.Show.S01E02.1080p');
    // A release with no season or episode at all is kept, as in the Dart: it
    // cannot be proven wrong, so it is left for the player to try.
    expect(names).toContain('Fallout.2024.1080p.WEB-DL');
  });

  it('marks a season pack as a pack', () => {
    const hit: KnabenHit = { name: 'Severance.S02.2160p.COMPLETE', infoHash: 'abcdef0123456789abcdef0123456789abcdef01', seeders: 5, trackers: [], pack: false };
    expect(filterHits([hit], { title: 'Severance', series: true, season: 2, episode: 3 })[0].pack).toBe(true);
  });

  it('sorts the survivors by seeders, best first', () => {
    const base: Omit<KnabenHit, 'name' | 'seeders'> = { infoHash: 'abcdef0123456789abcdef0123456789abcdef01', trackers: [], pack: false };
    const hits: KnabenHit[] = [
      { ...base, name: 'Dune.Part.Two.2024.1080p', seeders: 5 },
      { ...base, name: 'Dune.Part.Two.2024.2160p', seeders: 90 },
    ];
    const kept = filterHits(hits, { title: 'Dune: Part Two', series: false, year: 2024 });
    expect(kept.map((hit) => hit.seeders)).toEqual([90, 5]);
  });
});

describe('movy (VyseTV port)', () => {
  it('lists all 17 servers in VyseTV order', () => {
    expect(MOVY_SERVERS).toHaveLength(17);
    expect(MOVY_SERVERS[0].name).toBe('Miami');
    expect(MOVY_SERVERS[MOVY_SERVERS.length - 1].name).toBe('Cancun');
  });

  it('labels the dubs VyseTV labels', () => {
    const dubs = MOVY_SERVERS.filter((server) => server.audio).map((server) => `${server.name}:${server.audio}`);
    expect(dubs).toEqual(['Munich:German', 'Berlin:German', 'Paris:French', 'Delhi:Hindi', 'Cancun:Spanish']);
  });

  it('rejects a payload without the mvm1 magic', () => {
    // base64 of four bytes that are not the magic, so the check fails before decoding.
    expect(() => decryptMovyPayload('AAAAAA==', 'seed', 1)).toThrow('magic mismatch');
  });

  it('reads a quality out of the label, or 4K out of the URL', () => {
    // `_quality` only looks at the URL for 2160p; the rest comes from the label.
    expect(movyQuality('2160p', 'https://x/y.m3u8')).toBe('4K');
    expect(movyQuality('Auto', 'https://x/2160p/y.m3u8')).toBe('4K');
    expect(movyQuality('1080p', 'https://x/y.m3u8')).toBe('1080p');
    expect(movyQuality('Auto', 'https://x/1080p/y.m3u8')).toBe('');
  });
});
