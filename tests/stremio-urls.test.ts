import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CINEMETA_ADDON } from '../data/defaults';
import { fetchStremioCatalog, fetchStremioMeta, findStremioStreams } from '../services/stremioService';
import { nativeFetchText } from '../services/androidBridge';

vi.mock('../services/androidBridge', () => ({ nativeFetchText: vi.fn() }));
const fetchMock = vi.mocked(nativeFetchText);
const media = { id: 'tt123', imdbId: 'tt123', type: 'movie' as const, title: 'Example', overview: '', poster: '', genres: [], source: 'stremio' as const };

beforeEach(() => { fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, data: '{"metas": [], "streams": []}' }); });

describe('Stremio resource paths', () => {
  it('does not add a double slash for root-level manifests', async () => {
    await fetchStremioCatalog(CINEMETA_ADDON, { type: 'movie', id: 'top' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://v3-cinemeta.strem.io/catalog/movie/top.json');
    await fetchStremioMeta(CINEMETA_ADDON, media);
    expect(fetchMock.mock.calls[1][0]).toBe('https://v3-cinemeta.strem.io/meta/movie/tt123.json');
    const streamAddon = { ...CINEMETA_ADDON, manifest: { ...CINEMETA_ADDON.manifest, resources: [{ name: 'stream', types: ['movie'] }] } };
    await findStremioStreams([streamAddon], media);
    expect(fetchMock.mock.calls[2][0]).toBe('https://v3-cinemeta.strem.io/stream/movie/tt123.json');
  });
  it('preserves configured paths and manifest query parameters', async () => {
    const addon = { ...CINEMETA_ADDON, manifestUrl: 'https://example.com/config%3D/manifest.json?key=abc' };
    await fetchStremioCatalog(addon, { type: 'series', id: 'nfx' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/config%3D/catalog/series/nfx.json?key=abc');
  });
});
