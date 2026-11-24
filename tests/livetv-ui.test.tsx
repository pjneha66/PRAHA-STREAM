// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveTvView from '../components/LiveTvView';
import * as androidBridge from '../services/androidBridge';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';

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

/**
 * Live TV lands on Matches when nothing is starred (VyseTV's rule), so a test
 * that wants the channel list has to pick that tab first.
 */
function openChannelsTab(container: HTMLElement) {
  const tabs = [...container.querySelectorAll('.ltv-tab')] as HTMLButtonElement[];
  const channels = tabs.find((tab) => (tab.textContent || '').trim().startsWith('Channels'));
  if (!channels) throw new Error('Channels tab not found');
  channels.click();
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

  it('lands on Matches when nothing is starred, like VyseTV', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} playerSettings={DEFAULT_PLAYER_SETTINGS} onPlayerSettingsChange={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain('Fixtures from ESPN'));
    const active = container.querySelector('.ltv-tab.active');
    expect((active?.textContent || '').trim()).toBe('Matches');
  });

  it('mounts only a small window of rows for a 5,000-channel playlist', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} playerSettings={DEFAULT_PLAYER_SETTINGS} onPlayerSettingsChange={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain('5,000 channels'));
    openChannelsTab(container);
    await waitFor(() => expect(container.querySelectorAll('.ltv-channel').length).toBeGreaterThan(0));
    const mounted = container.querySelectorAll('.ltv-channel').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
    expect(container.querySelector('.ltv-virtual')).not.toBeNull();
  });

  it('exposes five mobile tabs and a channel action sheet', async () => {
    const { container } = render(<LiveTvView onPlayStream={vi.fn()} playerSettings={DEFAULT_PLAYER_SETTINGS} onPlayerSettingsChange={vi.fn()} />);
    expect(container.querySelectorAll('.ltv-tab').length).toBe(5);
    openChannelsTab(container);
    await waitFor(() => expect(container.querySelectorAll('.ltv-channel').length).toBeGreaterThan(0));
    const more = container.querySelector('.ltv-actions button:last-child') as HTMLButtonElement;
    expect(more).not.toBeNull();
    more.click();
    await waitFor(() => expect(container.querySelector('.ltv-sheet')).not.toBeNull());
    expect(container.textContent).toContain('Open externally');
    expect(container.textContent).toContain('Copy URL');
    expect(container.textContent).toContain('Next source');
  });

  it('plays a channel by handing the player the whole list and its index', async () => {
    const onPlay = vi.fn();
    const { container } = render(<LiveTvView onPlayStream={onPlay} playerSettings={DEFAULT_PLAYER_SETTINGS} onPlayerSettingsChange={vi.fn()} />);
    openChannelsTab(container);
    await waitFor(() => expect(container.querySelectorAll('.ltv-channel').length).toBeGreaterThan(0));
    const play = container.querySelector('.ltv-card-main') as HTMLButtonElement;
    play.click();
    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));

    // VyseTV's `openLivePlayer(context, items, i)`: the stream, plus the list it
    // came from and where in it the channel sits, so the player can zap.
    const playback = onPlay.mock.calls[0][0];
    expect(playback.stream).toMatchObject({
      sourceType: 'iptv',
      url: BIG[0].url,
      format: 'hls',
    });
    expect(playback.live.live).toBe(true);
    expect(playback.items.length).toBeGreaterThan(1);
    expect(playback.index).toBe(0);
    expect(playback.items[playback.index].url).toBe(BIG[0].url);
    // A playlist channel's star: every entry carries its own favourites key.
    expect(playback.items[playback.index].favoriteKey).toBeTruthy();
  });
});
