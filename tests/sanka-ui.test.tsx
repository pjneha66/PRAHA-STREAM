// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SankaExplorer from '../components/SankaExplorer';

const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('Sanka comic reader flow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads a comic, opens its chapters, and displays chapter pages', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/comic/homepage')) return json({ data: [{ title: 'Blue Period', slug: 'blue-period', cover: 'https://images.example/cover.jpg' }] });
      if (url.endsWith('/comic/komiku/manga/blue-period')) return json({ data: { title: 'Blue Period', synopsis: 'A young artist.', chapters: [{ title: 'Chapter 1', slug: 'blue-period-chapter-1' }] } });
      if (url.endsWith('/comic/komiku/chapter/blue-period-chapter-1')) return json({ data: { images: ['https://images.example/page-1.jpg'] } });
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: /Manga & comics/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Blue Period chapters' }));

    const chapter = await screen.findByRole('button', { name: 'Chapter 1' });
    fireEvent.click(chapter);
    expect(await screen.findByRole('dialog', { name: 'Chapter 1' })).toBeTruthy();
    expect(await screen.findByAltText('Page 1')).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });
});
