// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BooksView from '../components/BooksView';
import ArchiveReader from '../components/ArchiveReader';
import { ALL_ARCHIVE_TEXTS, BooksService } from '../services/archiveService';
import { readScanPage } from '../services/continueStore';

const json = (data: unknown, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(data),
}) as Response;

const fetchMock = vi.fn<typeof fetch>();
const archiveHit = { identifier: 'test-read-scan', title: 'A Test Book', creator: 'Example Author' };
const isbn = '9780140328721';

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Books search and scan resume', () => {
  it('searches all catalogs by ISBN and resumes the same scan across catalogs', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.bookracy.com') return json({}, 503);
      if (url.pathname === '/advancedsearch.php') {
        return json({ response: { docs: url.searchParams.get('q')?.includes(isbn) ? [archiveHit] : [] } });
      }
      if (url.pathname === '/search.json') {
        return json({ docs: [{
          key: '/works/OL123W', title: 'A Test Book', ia: ['other-edition'], ebook_access: 'borrowable',
          editions: { docs: [{ key: '/books/OL234M', ia: [archiveHit.identifier], ebook_access: 'public' }] },
        }] });
      }
      if (url.pathname === '/metadata/test-read-scan') {
        return json({ metadata: { imagecount: '180' }, files: [] });
      }
      return json({}, 404);
    });

    render(<BooksView />);
    expect(screen.getByRole('tab', { name: 'All catalogs' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search books' }), { target: { value: 'ISBN 978-0-14-032872-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Bookracy unavailable.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open A Test Book' })).toHaveLength(1);
    const searched = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(searched.some((url) => url.hostname === 'openlibrary.org' && url.searchParams.get('isbn') === isbn)).toBe(true);
    expect(searched.some((url) => url.hostname === 'api.bookracy.com' && url.searchParams.get('query') === isbn)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Open A Test Book' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read online' }));
    const reader = await screen.findByRole('dialog', { name: 'Read A Test Book' });
    fireEvent.change(await within(reader).findByRole('slider', { name: 'Jump to page' }), { target: { value: '150' } });
    expect(within(reader).getByText('Page 150 / 180')).toBeTruthy();
    expect(readScanPage(archiveHit.identifier)).toBe(149);
    fireEvent.click(within(reader).getByRole('button', { name: 'Zoom in' }));
    expect(within(reader).getByRole('button', { name: 'Reset zoom to fit' }).textContent).toBe('125%');
    expect(readScanPage(archiveHit.identifier)).toBe(149);
    fireEvent.click(within(reader).getByRole('button', { name: 'Paged' }));
    expect(within(reader).getByText('Page 150 / 180')).toBeTruthy();
    fireEvent.click(within(reader).getByRole('button', { name: 'Next page' }));
    fireEvent.click(within(reader).getByRole('button', { name: 'Close reader' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'A Test Book' })).getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Open Library' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open A Test Book' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume page 151' }));
    expect(await screen.findByText('Page 151 / 180')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close reader' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'A Test Book' })).getByRole('button', { name: 'Close' }));

    const shelf = screen.getByRole('region', { name: 'Continue where you left off' });
    fireEvent.click(within(shelf).getByText('Resume'));
    expect(await screen.findByText('Page 151 / 180')).toBeTruthy();
  });

  it('matches Archive creator and title fields', async () => {
    fetchMock.mockResolvedValue(json({ response: { docs: [] } }));
    await BooksService.searchArchive('Mark Twain', ALL_ARCHIVE_TEXTS);
    const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('q');
    expect(query).toContain('title:("Mark" AND "Twain")');
    expect(query).toContain('creator:("Mark" AND "Twain")');
  });

  it('keeps restricted scans out of the image reader after retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({
      metadata: { 'access-restricted-item': 'true', imagecount: '35' },
    }));
    render(<ArchiveReader identifier="test-locked-scan" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Check loan/ })).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(readScanPage('test-locked-scan')).toBeUndefined();
  });

  it('opens public volumes in the app when the Archive listing has no scan count', async () => {
    const openProtectedEmbed = vi.fn(() => true);
    const openBrowser = vi.fn();
    vi.stubGlobal('PrahaNative', { openProtectedEmbed, openBrowser });
    fetchMock.mockResolvedValue(json({
      metadata: { title: 'Comic Collection' },
      files: [{ name: 'Vol 1.pdf' }, { name: 'Vol 2.cbz' }, { name: 'Locked.pdf', private: 'true' }],
    }));

    render(<ArchiveReader identifier="test-volume-collection" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vol 1.pdf' }));
    expect(openProtectedEmbed).toHaveBeenCalledWith('https://archive.org/download/test-volume-collection/Vol%201.pdf');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Locked.pdf' })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens publication sites through the isolated Android WebView', async () => {
    fetchMock.mockResolvedValue(json({ response: { docs: [] } }));
    const openProtectedEmbed = vi.fn(() => true);
    vi.stubGlobal('PrahaNative', { openProtectedEmbed });
    render(<BooksView />);
    fireEvent.click(screen.getByRole('button', { name: 'Anna’s Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'OceanofPDF' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Open Library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Library site' }));
    await waitFor(() => expect(openProtectedEmbed.mock.calls).toEqual([
      ['https://annas-archive.gl/'],
      ['https://theoceanofpdf.com/'],
      ['https://openlibrary.org/'],
    ]));
  });
});
