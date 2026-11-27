// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AniList client + manga reader port (VyseTV `anilist.dart` / `manga_reader_page.dart`).
 * `nativeFetchText` is mocked: no test here touches the network.
 *
 * This file is `.ts` (not `.tsx`), so elements are built with `createElement`.
 */

const nativeFetchText = vi.fn();
vi.mock('../services/androidBridge', async () => {
  const actual = await vi.importActual<typeof import('../services/androidBridge')>(
    '../services/androidBridge',
  );
  return {
    ...actual,
    nativeFetchText: (...args: unknown[]) => nativeFetchText(...args),
  };
});

import {
  ANILIST_ENDPOINT, lookupByMalId, searchAnime, type AniListMedia,
} from '../services/anilistService';
import { MangaReader, type MangaReaderProps } from '../components/MangaReader';

/** A payload shaped exactly like a live `Page.media` answer. */
const MEDIA_NODE = {
  id: 154587,
  idMal: 52991,
  type: 'ANIME',
  format: 'TV',
  status: 'FINISHED',
  episodes: 28,
  duration: 24,
  season: 'FALL',
  seasonYear: 2023,
  averageScore: 91,
  popularity: 420000,
  favourites: 31000,
  genres: ['Adventure', 'Drama', 'Fantasy'],
  isAdult: false,
  title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End", native: '葬送のフリーレン' },
  coverImage: {
    extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/b154587-xxl.jpg',
    large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/b154587.jpg',
    color: '#e4a15d',
  },
  nextAiringEpisode: null,
  bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-xxl.jpg',
  description: 'An elf mage learns what living is all about.',
};

/** `idMal: null` and no banner are normal for AniList originals. */
const ORIGINAL_NODE = {
  ...MEDIA_NODE,
  id: 99999,
  idMal: null,
  bannerImage: null,
  title: { romaji: 'Original Show', english: null, native: null },
  coverImage: { extraLarge: null, large: 'https://s4.anilist.co/cover.jpg', color: null },
};

const PAGE_RESPONSE = {
  data: { Page: { pageInfo: { total: 1, hasNextPage: false }, media: [MEDIA_NODE] } },
};

function respondWith(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, data: JSON.stringify(payload) };
}

interface GraphQLBody {
  query: string;
  variables: Record<string, unknown>;
}

function lastBody(): GraphQLBody {
  const calls = nativeFetchText.mock.calls;
  const call = calls[calls.length - 1] as [string, { body: string }];
  return JSON.parse(call[1].body) as GraphQLBody;
}

describe('anilistService', () => {
  beforeEach(() => {
    nativeFetchText.mockReset();
    nativeFetchText.mockResolvedValue(respondWith(PAGE_RESPONSE));
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('POSTs a GraphQL body to the AniList endpoint with isAdult: false by default', async () => {
    await searchAnime('frieren');

    const [url, options] = nativeFetchText.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(ANILIST_ENDPOINT);
    expect(ANILIST_ENDPOINT).toBe('https://graphql.anilist.co');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = lastBody();
    expect(body.query).toContain('Page(page: $page, perPage: $perPage)');
    expect(body.query).toContain('media(type: ANIME, search: $search, sort: [SEARCH_MATCH], isAdult: false)');
    // Fields come from the Dart card; AniList rejects anything else.
    expect(body.query).toContain('id idMal type format status episodes');
    expect(body.query).toContain('title { romaji english native }');
    expect(body.query).toContain('coverImage { extraLarge large color }');
    expect(body.variables).toEqual({ page: 1, perPage: 30, search: 'frieren' });
  });

  it("searchAnime({adult:'only'}) asks AniList for isAdult: true", async () => {
    await searchAnime('kanojo', { adult: 'only', page: 2, perPage: 10 });

    const body = lastBody();
    expect(body.query).toContain('isAdult: true');
    expect(body.query).not.toContain('isAdult: false');
    expect(body.variables).toEqual({ page: 2, perPage: 10, search: 'kanojo' });
  });

  it("searchAnime({adult:'include'}) sends no isAdult argument at all", async () => {
    await searchAnime('monogatari', { adult: 'include' });
    expect(lastBody().query).not.toContain('isAdult:');
  });

  it('parses a real-shaped AniList payload', async () => {
    const results = await searchAnime('frieren');
    expect(results).toHaveLength(1);
    const media: AniListMedia = results[0];
    expect(media.id).toBe(154587);
    expect(media.idMal).toBe(52991);
    expect(media.title.romaji).toBe('Sousou no Frieren');
    expect(media.title.english).toBe("Frieren: Beyond Journey's End");
    expect(media.title.native).toBe('葬送のフリーレン');
    expect(media.coverImage.extraLarge).toContain('b154587-xxl.jpg');
    expect(media.coverImage.large).toContain('b154587.jpg');
    expect(media.bannerImage).toContain('/banner/154587');
    expect(media.isAdult).toBe(false);
    expect(media.averageScore).toBe(91);
    expect(media.episodes).toBe(28);
    expect(media.status).toBe('FINISHED');
    expect(media.format).toBe('TV');
    expect(media.genres).toEqual(['Adventure', 'Drama', 'Fantasy']);
    expect(media.description).toContain('elf mage');
  });

  it('keeps a null idMal and a missing bannerImage without throwing', async () => {
    nativeFetchText.mockResolvedValue(
      respondWith({ data: { Page: { pageInfo: { total: 1, hasNextPage: false }, media: [ORIGINAL_NODE] } } }),
    );
    const results = await searchAnime('original');
    expect(results).toHaveLength(1);
    expect(results[0].idMal).toBeNull();
    expect(results[0].bannerImage).toBeNull();
    expect(results[0].title.english).toBeNull();
    expect(results[0].coverImage.extraLarge).toBeNull();
    expect(results[0].coverImage.large).toBe('https://s4.anilist.co/cover.jpg');
  });

  it('skips nodes without an id and survives a malformed list', async () => {
    nativeFetchText.mockResolvedValue(
      respondWith({ data: { Page: { media: [{ title: { romaji: 'no id' } }, MEDIA_NODE, null] } } }),
    );
    const results = await searchAnime('anything');
    expect(results.map((m) => m.id)).toEqual([154587]);
  });

  it('lookupByMalId returns the media and null for an unknown MAL id', async () => {
    nativeFetchText.mockResolvedValue(respondWith({ data: { Media: MEDIA_NODE } }));
    const found = await lookupByMalId(52991);
    expect(found?.id).toBe(154587);
    const body = lastBody();
    expect(body.query).toContain('Media(idMal: $malId, type: ANIME)');
    expect(body.variables).toEqual({ malId: 52991 });

    nativeFetchText.mockResolvedValue(
      respondWith({ errors: [{ message: 'Not Found.' }], data: null }, 404),
    );
    await expect(lookupByMalId(1)).resolves.toBeNull();
    // An invalid id never hits the network.
    await expect(lookupByMalId(0)).resolves.toBeNull();
  });

  it('waits out a 429 answer and retries instead of failing', async () => {
    nativeFetchText
      .mockResolvedValueOnce({ ok: false, status: 429, data: '', headers: { 'retry-after': '1' } })
      .mockResolvedValueOnce(respondWith(PAGE_RESPONSE));
    const results = await searchAnime('frieren');
    expect(results).toHaveLength(1);
    expect(nativeFetchText).toHaveBeenCalledTimes(2);
  }, 20000);
});

// ───────────────────────── reader ─────────────────────────

const IMAGES = Array.from({ length: 43 }, (_, i) => `https://cdn.example/page-${i + 1}.jpg`);

function renderReader(overrides: Partial<MangaReaderProps> = {}) {
  const props: MangaReaderProps = {
    chapterId: 'ch-1',
    chapterTitle: 'Chapter 12',
    chapterNumber: '12',
    images: IMAGES,
    onClose: vi.fn(),
    onNextChapter: vi.fn(),
    hasNextChapter: true,
    ...overrides,
  };
  return render(createElement(MangaReader, props));
}

const setPaged = () => localStorage.setItem('praha.manga.reader-mode.v1', 'paged');
const setPositions = (positions: Record<string, number>) =>
  localStorage.setItem('praha.manga.pos.v1', JSON.stringify(positions));

describe('MangaReader', () => {
  beforeEach(() => {
    localStorage.clear();
    nativeFetchText.mockReset();
  });

  afterEach(() => { cleanup(); localStorage.clear(); });

  it('shows a "12 / 43" page counter', async () => {
    renderReader();
    expect(screen.getByText('1 / 43')).toBeTruthy();
    cleanup();
    setPaged();
    setPositions({ 'ch-1': 11 });
    renderReader();
    await waitFor(() => expect(screen.getByText('12 / 43')).toBeTruthy());
  });

  it('advances on ArrowRight in paged mode', async () => {
    setPaged();
    setPositions({ 'ch-1': 11 });
    renderReader();
    await waitFor(() => expect(screen.getByText('12 / 43')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('13 / 43')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByText('12 / 43')).toBeTruthy());
  });

  it('keeps a horizontal swipe on the current page while zoomed and restores page turns at fit', () => {
    setPaged();
    renderReader();
    const stage = screen.getByAltText('Page 1').closest('.mr-stage')!;
    const swipe = () => {
      fireEvent.touchStart(stage, { touches: [{ clientX: 200, clientY: 60 }] });
      fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 80, clientY: 60 }] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Reset zoom to fit' }).textContent).toBe('125%');
    swipe();
    expect(screen.getByText('1 / 43')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom to fit' }));
    swipe();
    expect(screen.getByText('2 / 43')).toBeTruthy();
  });

  it('ignores arrow keys in webtoon mode', async () => {
    renderReader();
    expect(screen.getByText('1 / 43')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('1 / 43')).toBeTruthy());
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderReader({ onClose });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('persists the reading mode across a remount', async () => {
    renderReader();
    // Starts in webtoon mode: the toggle offers page mode.
    fireEvent.click(screen.getByRole('button', { name: 'Switch to page mode' }));
    expect(localStorage.getItem('praha.manga.reader-mode.v1')).toBe('paged');

    cleanup();
    renderReader();
    expect(screen.getByRole('button', { name: 'Switch to webtoon mode' })).toBeTruthy();
  });

  it('saves the page position per chapter and restores it', async () => {
    setPaged();
    renderReader();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('2 / 43')).toBeTruthy());
    const stored = JSON.parse(localStorage.getItem('praha.manga.pos.v1') ?? '{}') as Record<string, number>;
    expect(stored['ch-1']).toBe(1);

    cleanup();
    renderReader();
    await waitFor(() => expect(screen.getByText('2 / 43')).toBeTruthy());

    // Another chapter keeps its own entry.
    cleanup();
    renderReader({ chapterId: 'ch-2' });
    await waitFor(() => expect(screen.getByText('1 / 43')).toBeTruthy());
  });

  it('offers the next chapter on the last page', async () => {
    setPaged();
    setPositions({ 'ch-1': 42 });
    const onNextChapter = vi.fn();
    renderReader({ onNextChapter });
    await waitFor(() => expect(screen.getByText('43 / 43')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onNextChapter).toHaveBeenCalledTimes(1);
  });

  it('renders a broken page without losing the rest of the strip', async () => {
    renderReader({
      images: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    });
    fireEvent.error(screen.getByAltText('Page 1'));
    await waitFor(() => expect(screen.getByText('1 page could not be loaded.')).toBeTruthy());
    expect(screen.getByAltText('Page 2')).toBeTruthy();
  });

  it('pinches the page within the reader without advancing the chapter', async () => {
    setPaged();
    renderReader();
    const page = screen.getByAltText('Page 1');
    fireEvent.touchStart(page, { touches: [{ clientX: 100, clientY: 180 }, { clientX: 200, clientY: 180 }] });
    fireEvent.touchMove(page, { touches: [{ clientX: 50, clientY: 180 }, { clientX: 250, clientY: 180 }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset zoom to fit' }).textContent).toBe('200%'));
    fireEvent.touchEnd(page, { touches: [], changedTouches: [{ clientX: 50, clientY: 180 }] });
    expect(screen.getByText('1 / 43')).toBeTruthy();
    expect(screen.getByAltText('Page 1')).toBe(page);
  });
});
