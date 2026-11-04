// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AddonHomeRows from '../components/AddonHomeRows';
import { CINEMETA_ADDON, normalizeSettings } from '../data/defaults';
import { fetchStremioCatalog } from '../services/stremioService';

vi.mock('../services/stremioService', () => ({ fetchStremioCatalog: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('addon home catalogs', () => {
  it('loads enabled browseable catalogs, and removes them when disabled', async () => {
    const addon = { ...CINEMETA_ADDON, manifest: { ...CINEMETA_ADDON.manifest, name: 'Streaming Catalogs', catalogs: [
      { id: 'nfx', name: 'Netflix', type: 'movie' },
      { id: 'search', type: 'movie', extra: [{ name: 'search', isRequired: true }] },
    ] } };
    vi.mocked(fetchStremioCatalog).mockResolvedValue([{ id: 'tt123', title: 'Test Movie', type: 'movie', source: 'stremio', poster: '', overview: '', genres: [] }]);
    const props = { addons: [addon], watchlist: [], compact: false, onSelect: vi.fn(), onToggleWatchlist: vi.fn() };
    const { rerender } = render(<AddonHomeRows {...props} />);
    expect(await screen.findByText('Netflix · Movies')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View Test Movie' })).toBeTruthy();
    expect(fetchStremioCatalog).toHaveBeenCalledTimes(1);
    rerender(<AddonHomeRows {...props} addons={[{ ...addon, enabled: false }]} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'View Test Movie' })).toBeNull());
  });
  it('identifies failed catalogs and retries them without discarding successful rows', async () => {
    const addon = { ...CINEMETA_ADDON, manifest: { ...CINEMETA_ADDON.manifest, name: 'Streaming Catalogs', catalogs: [
      { id: 'nfx', name: 'Netflix', type: 'movie' },
      { id: 'dnp', name: 'Disney+', type: 'movie' },
    ] } };
    const item = { id: 'tt123', title: 'Test Movie', type: 'movie' as const, source: 'stremio' as const, poster: '', overview: '', genres: [] };
    let failed = false;
    vi.mocked(fetchStremioCatalog).mockImplementation(async (_addon, catalog) => {
      if (catalog.id === 'dnp' && !failed) { failed = true; throw new Error('HTTP 503'); }
      return [item];
    });
    render(<AddonHomeRows addons={[addon]} watchlist={[]} compact={false} onSelect={vi.fn()} onToggleWatchlist={vi.fn()} />);
    expect(await screen.findByText(/Streaming Catalogs \/ Disney\+ \(movie\): HTTP 503/)).toBeTruthy();
    expect(screen.getByText('Netflix · Movies')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry catalogs' }));
    expect(await screen.findByText('Disney+ · Movies')).toBeTruthy();
    expect(screen.getByText('Netflix · Movies')).toBeTruthy();
    expect(vi.mocked(fetchStremioCatalog).mock.calls.filter(([, catalog]) => catalog.id === 'nfx')).toHaveLength(1);
  });
  it('merges enrichment preferences into old settings', () => {
    const settings = normalizeSettings({ tmdbEnrichment: { ...normalizeSettings({}).tmdbEnrichment, trailers: false } });
    expect(settings.tmdbEnrichment.trailers).toBe(false);
    expect(normalizeSettings({}).tmdbEnrichment.enabled).toBe(true);
  });
});
