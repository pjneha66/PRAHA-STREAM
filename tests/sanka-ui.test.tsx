// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SankaExplorer from '../components/SankaExplorer';
import { clearSankaCache } from '../services/sankaService';

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

describe('Sanka comic reader & pagination flow', () => {
  afterEach(() => {
    cleanup();
    clearSankaCache();
    vi.unstubAllGlobals();
  });

  it('opens directly on comics, supports Load more pagination, and reads chapter pages', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/comic/bacakomik/latest')) {
        return json({
          hasNextPage: true,
          komikList: [
            { title: 'Omniscient Reader', slug: 'omniscient-reader', cover: 'https://images.example/orv.jpg', chapter: 'Ch. 220', type: 'Manhwa' },
          ],
        });
      }
      if (url.endsWith('/comic/bacakomik/latest?page=2')) {
        return json({
          hasNextPage: false,
          komikList: [
            { title: 'Return of the Mount Hua Sect', slug: 'mount-hua', cover: 'https://images.example/hua.jpg', chapter: 'Ch. 150', type: 'Manhwa' },
          ],
        });
      }
      if (url.endsWith('/comic/bacakomik/detail/omniscient-reader')) {
        return json({
          detail: {
            title: 'Omniscient Reader',
            synopsis: 'Only I know the end of this world.',
            chapters: [{ title: 'Chapter 1', slug: 'omniscient-reader-chapter-1' }],
          },
        });
      }
      if (url.endsWith('/comic/bacakomik/chapter/omniscient-reader-chapter-1')) {
        return json({ images: ['https://images.example/orv-page-1.jpg'] });
      }
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SankaExplorer />);

    expect(await screen.findByRole('button', { name: 'Open Omniscient Reader chapters' })).toBeTruthy();

    // Load page 2 via Load more button
    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i });
    fireEvent.click(loadMoreBtn);

    expect(await screen.findByRole('button', { name: 'Open Return of the Mount Hua Sect chapters' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
    expect(screen.getByText('Showing all 2 loaded titles')).toBeTruthy();

    // Open comic details & read chapter 1
    fireEvent.click(screen.getByRole('button', { name: 'Open Omniscient Reader chapters' }));
    const chapterBtn = await screen.findByRole('button', { name: /^Chapter 1$/ });
    fireEvent.click(chapterBtn);

    expect(await screen.findByRole('dialog', { name: 'Chapter 1' })).toBeTruthy();
    const pageImg = await screen.findByAltText('Page 1');
    expect(pageImg.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('automatically falls back to Komikindo when the default comic source is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/comic/bacakomik/')) return json({ error: 'down' }, 502);
      if (url.includes('/comic/komikindo/latest')) {
        return json({ comics: [{ title: 'Blue Period', link: '/manga/blue-period/', image: 'https://images.example/cover.jpg', chapter: 'Ch. 68' }] });
      }
      if (url.includes('/comic/komikindo/manga/blue-period')) {
        return json({ title: 'Blue Period', synopsis: 'A young artist.', chapters: [{ chapter: 'Chapter 1', link: '/ch/blue-period-chapter-1/' }] });
      }
      if (url.includes('/comic/komikindo/chapter/blue-period-chapter-1') || url.includes('/comic/chapter/ch/blue-period-chapter-1')) {
        return json({ images: ['https://images.example/page-1.jpg'] });
      }
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SankaExplorer />);
    expect(await screen.findByText('Loaded comics from Komikindo.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Blue Period chapters' }));

    const chapter = await screen.findByRole('button', { name: /^Chapter 1$/ });
    fireEvent.click(chapter);
    expect(await screen.findByRole('dialog', { name: 'Chapter 1' })).toBeTruthy();
    expect(await screen.findByAltText('Page 1')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
