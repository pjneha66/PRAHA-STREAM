// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import EmbedModal from '../components/EmbedModal';
import type { StreamResult } from '../types';

const { scrapeFilmSources, openProtectedEmbed } = vi.hoisted(() => ({
  scrapeFilmSources: vi.fn(),
  openProtectedEmbed: vi.fn(async () => true),
}));

vi.mock('../services/sourceOrchestrator', () => ({
  filmQueryFromMedia: (_media: unknown, season: number, episode: number) => ({ season, episode }),
  scrapeFilmSources,
}));
vi.mock('../services/androidBridge', () => ({
  isAndroidApp: () => true,
  openProtectedEmbed,
  openSafeExternalUrl: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

it('offers direct streams during the scan and opens the applied episode in the Android player', async () => {
  localStorage.setItem('praha.v2.embed-update-config', JSON.stringify({ enabled: false, url: '' }));
  const direct: StreamResult = { id: 'direct', url: 'https://media.example/video.m3u8', title: 'Example stream', sourceName: 'Example', sourceType: 'scraper' };
  const torrent: StreamResult = { id: 'torrent', url: '', infoHash: 'a'.repeat(40), title: 'Example torrent', sourceName: 'Example', sourceType: 'scraper' };
  scrapeFilmSources.mockImplementation(async (_query, { onPartial, signal }) => {
    onPartial({ streams: [direct, torrent], failures: [] });
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { streams: [], failures: [] };
  });

  const play = vi.fn();
  render(<EmbedModal media={{ id: 'tmdb:42', title: 'Example Series', type: 'series', tmdbId: 42 }} onClose={() => {}} onPlay={play} />);
  const directPanel = within(screen.getByRole('region', { name: 'Direct sources' }));
  expect(await directPanel.findByText('Example stream')).toBeTruthy();
  expect(directPanel.queryByText('Example torrent')).toBeNull();
  expect(directPanel.getByText('Checking sources…')).toBeTruthy();
  fireEvent.click(directPanel.getByRole('button', { name: 'Play' }));
  expect(play).toHaveBeenCalledWith(direct, 1, 1, undefined, []);

  fireEvent.change(screen.getByRole('spinbutton', { name: 'Episode' }), { target: { value: '3' } });
  expect(scrapeFilmSources).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(scrapeFilmSources).toHaveBeenCalledTimes(2);
  const links = within(screen.getByRole('region', { name: 'Embed sites' }));
  fireEvent.change(links.getByRole('searchbox', { name: 'Filter players' }), { target: { value: 'Videasy' } });
  fireEvent.click(links.getByRole('button', { name: 'Open player' }));
  await waitFor(() => expect(openProtectedEmbed).toHaveBeenCalledWith('https://player.videasy.to/tv/42/1/3'));
});
