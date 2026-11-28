import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prahaRpc } from '../services/androidBridge';
import { hikiStreams, loadHikiRepo, toHikiStreams, type HikiTitle } from '../services/hikariExtensions';

vi.mock('../services/androidBridge', async (loadActual) => ({
  ...(await loadActual<typeof import('../services/androidBridge')>()),
  prahaRpc: vi.fn(),
}));

const provider = { name: 'Sample Hikari', key: 'test/sample', description: '' };

beforeEach(() => vi.resetAllMocks());

describe('Hikari extension host integration', () => {
  it('normalizes a GitHub repository link to the published Hikari index', async () => {
    vi.mocked(prahaRpc).mockResolvedValueOnce({ name: 'Repo', plugins: [] });
    await loadHikiRepo('https://github.com/example/extensions');
    expect(prahaRpc).toHaveBeenCalledWith('hikiRepo', [
      'https://raw.githubusercontent.com/example/extensions/builds/repo.json',
    ], 40000);
  });

  it('passes the selected season and episode back to the owning extension', async () => {
    const title: HikiTitle = {
      provider,
      media: { id: 'native:item', title: 'Test', type: 'SERIES' },
      episodes: [{ id: 'one', season: 1, number: 1 }, { id: 'two', season: 2, number: 1 }],
    };
    vi.mocked(prahaRpc).mockResolvedValueOnce([]);
    await hikiStreams(title, 2, 1);
    expect(prahaRpc).toHaveBeenCalledWith('hikiStreams', [provider.key, title.media, title.episodes[1]], 80000);
    expect(await hikiStreams(title, 2, 2)).toEqual([]);
    expect(prahaRpc).toHaveBeenCalledTimes(1);
  });

  it('keeps stream headers, subtitles and torrent selection for PRAHA playback', () => {
    const rows = toHikiStreams(provider, [
      { name: 'Adaptive', url: 'https://example.com/video.m3u8', isM3u8: true,
        headers: { Referer: 'https://example.com/' }, subtitles: [{ lang: 'en', url: 'https://example.com/en.vtt' }] },
      { name: 'Torrent', isTorrent: true, infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
        fileIdx: 2, trackers: ['udp://tracker.example.com:1337'] },
      { name: 'Invalid', url: 'file:///private.xml' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sourceType: 'hikari', format: 'hls', headers: { Referer: 'https://example.com/' },
      subtitles: [{ language: 'en', url: 'https://example.com/en.vtt' }] });
    expect(rows[1]).toMatchObject({ fileIdx: 2 });
    expect(rows[1].url).toContain('&tr=udp%3A%2F%2Ftracker');
  });
});
