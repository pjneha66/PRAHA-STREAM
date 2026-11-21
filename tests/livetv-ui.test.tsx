// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveTvView from '../components/LiveTvView';
import * as androidBridge from '../services/androidBridge';

const BIG = Array.from({ length: 5000 }, (_, index) => ({
  name: `Channel ${index}`,
  url: `https://host.example/${index}.m3u8`,
  group: 'Sports',
}));

function seedPlaylist() {
  localStorage.setItem('pt_iptv_m3u_playlists_v1', JSON.stringify([{
    id: 'big',
    name: 'Big playlist',
    sourceUrl: 'https://host.example/all.m3u8',
    addedAt: 1,
    updatedAt: 1,
    channels: BIG,
  }]));
}

describe('Live TV port UI', () => {
  beforeEach(() => {
    localStorage.clear();
    seedPlaylist();
    vi.spyOn(androidBridge, 'nativeFetchText').mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('mounts only a small window of rows for a 5,000-channel playlist', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain('5,000 channels'));
    const mounted = container.querySelectorAll('.ltv-channel').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
    expect(container.querySelector('.ltv-virtual')).not.toBeNull();
  });

  it('exposes five mobile tabs and a channel action sheet', async () => {
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

  it('plays a channel through the unchanged onPlayStream contract', async () => {
    const onPlay = vi.fn();
    const { container } = render(<LiveTvView onPlayStream={onPlay} />);
    await waitFor(() => expect(container.querySelectorAll('.ltv-channel').length).toBeGreaterThan(0));
    const play = container.querySelector('.ltv-card-main') as HTMLButtonElement;
    play.click();
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(onPlay.mock.calls[0][1]).toMatchObject({
      sourceType: 'iptv',
      url: BIG[0].url,
      format: 'hls',
    });
  });
});
