// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveTvView from '../components/LiveTvView';
import { IptvSources, IptvSourceStore, LiveMatchesScraper } from '../services/iptvService';
import * as androidBridge from '../services/androidBridge';

const BIG = Array.from({ length: 5000 }, (_, i) => ({
  name: `Channel ${i}`,
  url: `https://host.example/${i}.m3u8`,
  group: 'Sports',
}));

describe('Live TV mobile rebuild', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(androidBridge, 'nativeFetchText').mockRejectedValue(new Error('offline'));
    vi.spyOn(IptvSources, 'loadPlaylist').mockResolvedValue(BIG as never);
    vi.spyOn(IptvSourceStore, 'loadLastSource').mockReturnValue({ name: 'Big playlist', url: 'https://host.example/all.m3u8' });
    vi.spyOn(LiveMatchesScraper, 'fetchNuvioSportsMatches').mockResolvedValue([]);
    vi.spyOn(LiveMatchesScraper, 'fetchDamiTvMatches').mockResolvedValue([]);
    vi.spyOn(LiveMatchesScraper, 'fetchPpvMatches').mockResolvedValue([]);
  });

  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  it('mounts only a small window of rows for a 5,000-channel playlist', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain('5,000 channels'));
    // The old grid mounted 250 cards (each with an image and several buttons).
    const mounted = container.querySelectorAll('.ltv-channel').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
    expect(container.querySelector('.ltv-virtual')).not.toBeNull();
  });

  it('exposes mobile tabs and a channel action menu', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} />);
    expect(container.querySelectorAll('.ltv-tab').length).toBe(5);
    await waitFor(() => expect(container.querySelectorAll('.ltv-channel').length).toBeGreaterThan(0));
    const more = container.querySelector('.ltv-actions button:last-child') as HTMLButtonElement;
    expect(more).not.toBeNull();
    more.click();
    await waitFor(() => expect(container.querySelector('.ltv-sheet')).not.toBeNull());
    expect(container.textContent).toContain('Open externally');
    expect(container.textContent).toContain('Copy URL');
    expect(container.textContent).toContain('Next source');
  });
});
