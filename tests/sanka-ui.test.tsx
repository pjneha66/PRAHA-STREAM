// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    localStorage.removeItem('praha.v2.chapter-order');
    vi.unstubAllGlobals();
  });

  it('opens OceanofPDF files directly and preserves the explicit catalog fallback', async () => {
    const openProtectedEmbed = vi.fn(() => true);
    const openReaderFile = vi.fn(() => true);
    vi.stubGlobal('PrahaNative', { openProtectedEmbed, openReaderFile });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('annas-archive.gl')) return json({}, 403);
      if (url.includes('theoceanofpdf.com')) return {
        ok: true, status: 200, text: async () => url.endsWith('/comic-title/')
          ? '<article><a href="/files/comic.cbz">Read comic</a></article>'
          : '<div class="wp-block-post"><h2 class="wp-block-post-title"><a href="/comic-title/">Download Comic Title</a></h2></div>',
      } as Response;
      return json({ data: [] });
    }));

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: 'OceanofPDF' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Comic Title' }));
    await waitFor(() => expect(openReaderFile).toHaveBeenCalledWith('https://theoceanofpdf.com/files/comic.cbz'));

    fireEvent.click(screen.getByRole('tab', { name: 'Anna’s Archive' }));
    expect(await screen.findByText('Open the site’s catalog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse Anna’s Archive' }));
    await waitFor(() => expect(openProtectedEmbed).toHaveBeenCalledWith('https://annas-archive.gl/search?content=book_comic'));
  });

  it.each([
    ['Comics-All', 'https://comics-all.com', '/123-comic.html', '<a class="preview-title" href="/123-comic.html">Test Issue</a>', 'story'],
    ['ComicSnake', 'https://comicsnake.com', '/publisher/123-comic.html', '<a class="comics_th-in" href="/publisher/123-comic.html" title="Test Issue"><img alt="Cover"></a>', 'story'],
    ['GetComics', 'https://getcomics.org', '/publisher/test-issue/', '<article class="post"><h1 class="post-title"><a href="/publisher/test-issue/">Test Issue</a></h1></article>', 's'],
  ])('searches %s and opens the issue in the Android publication reader', async (label, origin, path, html, searchParam) => {
    const openReaderFile = vi.fn(() => true);
    vi.stubGlobal('PrahaNative', { openReaderFile });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { origin: requestOrigin, searchParams, pathname } = new URL(String(input));
      if (requestOrigin === origin) return {
        ok: true, status: 200, text: async () => pathname === path ? '<article><a href="/files/issue.cbr">Comic</a></article>'
          : searchParams.get(searchParam) === 'Test Issue' ? html : '<html></html>',
      } as Response;
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: label }));
    const field = screen.getByRole('textbox', { name: 'Search manga and comics' });
    fireEvent.change(field, { target: { value: 'Test Issue' } });
    fireEvent.submit(field.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test Issue' }));
    await waitFor(() => expect(openReaderFile).toHaveBeenCalledWith(origin + '/files/issue.cbr'));
  });

  it('opens the ComicSnake download host and searches other sources if it is unavailable', async () => {
    const host = 'https://florenfile.com/abc123/Test_Issue.cbz.html';
    const openProtectedEmbed = vi.fn(() => true);
    const openReaderFile = vi.fn(() => true);
    vi.stubGlobal('PrahaNative', { openProtectedEmbed, openReaderFile });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/publisher/123-issue.html')) return {
        ok: true, status: 200, text: async () => `<a href="${host}" class="dsgnmoo">CBZ</a>`,
      };
      if (url.startsWith('https://comicsnake.com/')) return {
        ok: true, status: 200, text: async () => '<a class="comics_th-in" href="/publisher/123-issue.html" title="Test Issue (Test Issue #24)"></a>',
      };
      return json({ data: [] });
    }));

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: 'ComicSnake' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test Issue (Test Issue #24)' }));
    await waitFor(() => expect(openProtectedEmbed).toHaveBeenCalledWith(host));
    expect(openReaderFile).not.toHaveBeenCalled();

    fireEvent(window, new Event('praha:comic-find-source'));
    expect(screen.getByRole('tab', { name: 'All Sources' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Search manga and comics' }) as HTMLInputElement).value).toBe('Test Issue #24');
    expect(screen.queryByRole('dialog', { name: 'Test Issue (Test Issue #24)' })).toBeNull();
  });

  it('keeps a missing direct file actionable and lets the issue be saved', async () => {
    const listing = 'https://comicsnake.com/publisher/123-test-issue.html';
    const openProtectedEmbed = vi.fn(() => true);
    const toggle = vi.fn();
    vi.stubGlobal('PrahaNative', { openProtectedEmbed });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === listing) return { ok: true, status: 200, text: async () => '<article><a href="https://files.example/download">Download host</a></article>' };
      if (url.startsWith('https://comicsnake.com/')) return {
        ok: true, status: 200, text: async () => '<a class="comics_th-in" href="/publisher/123-test-issue.html" title="Test Issue"><img alt="Cover"></a>',
      };
      return json({ data: [] });
    }));

    render(<SankaExplorer onToggleReading={toggle} />);
    fireEvent.click(screen.getByRole('tab', { name: 'ComicSnake' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test Issue' }));
    const detail = within(screen.getByRole('dialog', { name: 'Test Issue' }));
    expect((await detail.findByRole('alert')).textContent).toMatch(/no direct reader file/i);
    fireEvent.click(detail.getByRole('button', { name: 'Save to Library' }));
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sanka', item: expect.objectContaining({ title: 'Test Issue', sourceUrl: listing }) }));
    fireEvent.click(detail.getByRole('button', { name: 'Open listing' }));
    await waitFor(() => expect(openProtectedEmbed).toHaveBeenCalledWith(listing));
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
            chapters: [
              { title: 'Chapter 10', slug: 'omniscient-reader-chapter-10' },
              { title: 'Chapter 1', slug: 'omniscient-reader-chapter-1' },
              { title: 'Chapter 2.5', slug: 'omniscient-reader-chapter-2-5' },
            ],
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
    const order = await screen.findByRole('combobox', { name: 'Chapter order' });
    fireEvent.change(order, { target: { value: 'asc' } });
    expect(screen.getAllByRole('button', { name: /^Chapter [0-9]/ }).map((button) => button.textContent))
      .toEqual(['Chapter 1', 'Chapter 2.5', 'Chapter 10']);
    const chapterBtn = screen.getByRole('button', { name: /^Chapter 1$/ });
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

  it('opens MangaDex and Pepper&Carrot from All Sources and lists every chapter page', async () => {
    const manga = { id: 'manga-id', attributes: { title: { en: 'Test Manga' }, contentRating: 'safe' } };
    const chapter = { id: 'chapter-id', attributes: { chapter: '1', title: null, pages: 3 } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.mangadex.org/manga?')) return json({ data: [manga], total: 1 });
      if (url.includes('/manga/manga-id/feed?')) {
        return json({
          data: [
            { id: 'external-id', attributes: { title: 'External preview', pages: 0, externalUrl: 'https://example.com' } },
            chapter,
          ],
          total: 2,
        });
      }
      if (url.includes('/manga/manga-id?')) return json({ data: manga });
      if (url.includes('/at-home/server/chapter-id?')) {
        return json({ baseUrl: 'https://images.example', chapter: { hash: 'hash', data: ['a.png', 'b.png', 'c.png'] } });
      }
      if (url.includes('archive.org/advancedsearch.php')) return json({}, 503);
      return json({ data: [] });
    }));

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: 'All Sources' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Test Manga chapters' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter 1' }));
    expect(await screen.findByAltText('Page 1')).toHaveProperty('src', 'https://images.example/data/hash/a.png');
    expect(screen.getByAltText('Page 3')).toHaveProperty('src', 'https://images.example/data/hash/c.png');
    expect(screen.queryByText('External preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open Pepper&Carrot chapters' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Episode 1 · Potion of Flight/ }));
    expect(await screen.findByAltText('Page 1')).toHaveProperty('src', expect.stringMatching(/E01P00\.jpg$/));
    expect(screen.getByAltText('Page 5')).toHaveProperty('src', expect.stringMatching(/E01P04\.jpg$/));
  });

  it('groups translated title aliases and lets the reader switch to the other provider', async () => {
    const manga = {
      id: 'shared-manga', attributes: { title: { en: 'Shared Title' }, altTitles: [{ id: 'Judul Bersama' }], contentRating: 'safe' },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.mangadex.org/manga?')) return json({ data: [manga], total: 1 });
      if (url.includes('/manga/shared-manga/feed?')) return json({ data: [], total: 0 });
      if (url.includes('/manga/shared-manga?')) return json({ data: manga });
      if (url.endsWith('/comic/bacakomik/latest')) return json({ comics: [{ title: 'Judul Bersama', slug: 'judul-bersama' }] });
      if (url.endsWith('/comic/bacakomik/detail/judul-bersama')) {
        return json({ detail: { title: 'Judul Bersama', chapters: [{ title: 'Chapter 1', slug: 'chapter-one' }] } });
      }
      return json({ data: [] });
    }));

    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: 'All Sources' }));
    await screen.findByText(/2 editions/);
    const cards = screen.getAllByRole('button', { name: /^Open (Shared Title|Judul Bersama) chapters$/ });
    expect(cards).toHaveLength(1);
    fireEvent.click(cards[0]);
    const alternate = await screen.findByRole('button', { name: /^Switch to (BacaKomik|MangaDex)$/ });
    const switchingToMangaDex = alternate.textContent?.includes('MangaDex');
    fireEvent.click(alternate);
    expect(await screen.findByRole('dialog', { name: switchingToMangaDex ? 'Shared Title' : 'Judul Bersama' })).toBeTruthy();
  });

  it('loads translated comic pages after filtering the catalog by language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [] })));
    render(<SankaExplorer />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pepper&Carrot' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Comic language' }), { target: { value: 'fr' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pepper&Carrot chapters' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start Episode 1 · Potion of Flight' }));
    expect(await screen.findByAltText('Page 1')).toHaveProperty('src', expect.stringMatching(/\/fr_Pepper.*E01P00\.jpg$/));
    expect(screen.getByAltText('Page 5')).toHaveProperty('src', expect.stringMatching(/\/fr_Pepper.*E01P04\.jpg$/));
  });
});
