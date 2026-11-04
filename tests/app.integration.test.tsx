// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

const TITLE = {
  id: 46474,
  slug: 'sousou-no-frieren',
  title: 'Sousou no Frieren',
  titleEnglish: 'Frieren: Beyond Journey’s End',
  format: 'TV',
  status: 'FINISHED',
  season: 'FALL',
  seasonYear: 2023,
  episodeCount: 28,
  durationMinutes: 24,
  images: { poster: 'https://img/poster.jpg', banner: 'https://img/banner.jpg', logo: null },
  scores: { average: 91.7, mal: 9.24 },
  externalIds: { mal: 52991, anilist: 154587, tmdb: 209867, imdb: 'tt22248376' },
  genres: [{ name: 'Adventure' }, { name: 'Fantasy' }],
  studios: [{ name: 'Madhouse' }],
  synopsis: 'An elf mage learns what living is all about.',
};

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
}) as unknown as Response;

function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/anime/sousou-no-frieren/episodes')) {
      return json({
        pageInfo: { hasNextPage: false },
        items: [
          { id: 1, number: 1, seasonNumber: 1, title: 'The Journey’s End', thumbnail: 'https://img/e1.jpg' },
          { id: 2, number: 2, seasonNumber: 1, title: 'It Didn’t Have to Be Magic', thumbnail: 'https://img/e2.jpg' },
        ],
      });
    }
    if (url.includes('/v1/anime/sousou-no-frieren/characters')) {
      return json({ items: [{ id: 1, name: 'Frieren', role: 'MAIN', image: 'https://img/c.jpg', voiceActors: [{ name: 'Atsumi Tanezaki', image: 'https://img/va.jpg' }] }] });
    }
    if (url.includes('/v1/anime/sousou-no-frieren/recommendations')) {
      return json({ items: [] });
    }
    if (url.includes('/v1/anime/sousou-no-frieren')) {
      return json({ ...TITLE, contentRating: 'pg_13' });
    }
    if (url.includes('/v1/anime')) {
      return json({ pageInfo: { page: 1, perPage: 24, total: 1, hasNextPage: false }, items: [TITLE] });
    }
    if (url.includes('anikura.club/api/v1/comments')) {
      const episode = Number(new URL(url).searchParams.get('episode') || 1);
      return json({
        ok: true,
        series: { id: 1, watch_url: `https://anikura.club/watch/1?ep=${episode}` },
        page: { total: 1 },
        comments: [{
          id: `c-${episode}`,
          body: `Comment for episode ${episode}`,
          like_count: 7,
          author: { name: 'taiga', avatar: ' https://img/a.jpg' },
        }],
      });
    }
    if (url.includes('anikura.club')) return json({ ok: true, data: null });
    if (url.includes('api.tiffara.com/titles')) {
      const type = new URL(url).searchParams.get('types');
      return json({
        titles: [{
          id: type === 'TV_SERIES' ? 'tt22248376' : 'tt0245429',
          type: type || 'MOVIE',
          primaryTitle: type === 'TV_SERIES' ? 'Frieren: Beyond Journey’s End' : 'Spirited Away',
          primaryImage: { url: 'https://img/imdb.jpg' },
          startYear: 2023,
          genres: ['Animation'],
          plot: 'An IMDx fixture plot.',
          rating: { aggregateRating: 8.9 },
        }],
      });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem('praha.v2.settings', JSON.stringify({ tmdbApiKey: '' }));
  window.sessionStorage.setItem('praha.v2.session-profile-picked', 'default');
  window.location.hash = '#anime';
  installFetchMock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Netflix-style Who is watching gate & Anime/Comics in the app shell', () => {
  it('shows Netflix-style Who’s watching? on session launch, supports Add/Manage Profiles, and re-opens from topbar', async () => {
    window.sessionStorage.removeItem('praha.v2.session-profile-picked');
    // Even when profiles already exist in localStorage, new session still shows Who's watching
    window.localStorage.setItem('praha.v2.profiles', JSON.stringify([
      { id: 'default', name: 'Main Profile', avatarColor: '#e50914', createdAt: 1 },
    ]));
    window.location.hash = '#home';
    render(<App />);

    const gate = screen.getByRole('dialog', { name: 'Who’s watching?' });
    expect(gate).toBeTruthy();

    // Add a new profile with a custom image directly from the Netflix gate
    fireEvent.click(within(gate).getByRole('button', { name: 'Add Profile' }));
    const nameInput = screen.getByRole('textbox', { name: 'Profile name' });
    fireEvent.change(nameInput, { target: { value: 'Neha' } });
    const imgUrlInput = screen.getByRole('textbox', { name: 'Custom image URL' });
    fireEvent.change(imgUrlInput, { target: { value: 'https://img.example/custom-avatar.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const storedProfiles = JSON.parse(window.localStorage.getItem('praha.v2.profiles') || '[]');
    expect(storedProfiles.find((p: { name: string }) => p.name === 'Neha')?.avatarImage).toBe('https://img.example/custom-avatar.png');

    // Manage Profiles mode edits an existing profile (and supports file upload)
    fireEvent.click(screen.getByRole('button', { name: 'Manage Profiles' }));
    expect(screen.getByRole('dialog', { name: 'Manage Profiles:' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Neha' }));
    const fileInput = screen.getByLabelText('Upload custom profile photo') as HTMLInputElement;
    const fakeFile = new File(['avatar-bytes'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [fakeFile] } });
    await waitFor(() => expect(screen.getByText('Custom photo')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // Single-click the newly added profile tile to enter PRAHA STREAM
    fireEvent.click(screen.getByRole('button', { name: 'Neha' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who’s watching?' })).toBeNull());
    expect(window.sessionStorage.getItem('praha.v2.session-profile-picked')).toMatch(/^prof-/);

    // Re-open Who's watching? anytime from the topbar avatar button
    fireEvent.click(screen.getByRole('button', { name: /Switch profile \(Neha\)/ }));
    expect(await screen.findByRole('dialog', { name: 'Who’s watching?' })).toBeTruthy();
  }, 15000);

  it('opens the Manga & Comics tab and renders only manga & comics (without an Anime sub-tab)', async () => {
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/comic/bacakomik/latest')) {
        return json({ komikList: [{ title: 'Solo Leveling', slug: 'solo-leveling', cover: 'https://img.example/solo.jpg' }] });
      }
      if (url.includes('/comic/bacakomik/populer')) {
        return json({ komikList: [{ title: 'Omniscient Reader', slug: 'omniscient-reader', cover: 'https://img.example/orv.jpg' }] });
      }
      return json({});
    });
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Manga & Comics' })[0]);

    expect(await screen.findByText('Solo Leveling')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Anime/i })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Popular/i }));
    expect(await screen.findByText('Omniscient Reader')).toBeTruthy();
  }, 15000);

  it('enables IMDx from the Metadata settings card', async () => {
    window.location.hash = '#settings';
    render(<App />);

    const card = await waitFor(() => {
      const node = document.querySelector('.imdx-settings-card');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    }, { timeout: 8000 });
    expect(within(card).getByText('IMDx · Tiffara (optional)')).toBeTruthy();

    const toggle = within(card).getByRole('switch', { name: 'Enable IMDx metadata' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
    const saved = JSON.parse(window.localStorage.getItem('praha.v2.settings') || '{}');
    expect(saved.imdx.enabled).toBe(true);
    expect(saved).toHaveProperty('tmdbApiKey');
  }, 30000);

  it('falls back to IMDx for the home catalog when TMDB is not configured', async () => {
    window.localStorage.setItem('praha.v2.settings', JSON.stringify({
      tmdbApiKey: '',
      imdx: { enabled: true, baseUrl: 'https://api.tiffara.com', apiKey: '' },
    }));
    window.location.hash = '#home';
    render(<App />);

    expect(await screen.findByText('IMDX SPOTLIGHT', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getAllByText(/TMDB key not set/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Popular on IMDx/).length).toBeGreaterThan(0);
  }, 30000);

  it('renders AniCore rows, the provider strip and the episode discussion for a title', async () => {
    render(<App />);

    await waitFor(() => {
      expect(document.querySelectorAll('.media-card').length).toBeGreaterThan(0);
    }, { timeout: 8000 });
    expect(screen.getAllByText(/Frieren: Beyond Journey’s End/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/AniCore/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Anikura/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/IMDx · Tiffara/).length).toBeGreaterThan(0);

    const cardButton = document.querySelector('.media-card .poster-button');
    expect(cardButton).toBeTruthy();
    fireEvent.click(cardButton as Element);
    const dialog = await screen.findByRole('dialog', {}, { timeout: 8000 });
    expect(within(dialog).getByText('Seasons & Episodes')).toBeTruthy();
    expect(await within(dialog).findByText(/1\. The Journey’s End/, {}, { timeout: 8000 })).toBeTruthy();
    expect(within(dialog).getByText('AniList 154587')).toBeTruthy();
    expect(within(dialog).getByText(/MAL 52991/)).toBeTruthy();
    expect(await within(dialog).findByText('Atsumi Tanezaki', {}, { timeout: 8000 })).toBeTruthy();

    expect(await within(dialog).findByText('Comment for episode 1', {}, { timeout: 8000 })).toBeTruthy();
    expect(within(dialog).getByText(/gathered by Anikura/)).toBeTruthy();

    const episodeDiscussionButtons = within(dialog).getAllByRole('button', { name: 'Episode discussion' });
    fireEvent.click(episodeDiscussionButtons[1]);
    expect(await within(dialog).findByText('Comment for episode 2', {}, { timeout: 8000 })).toBeTruthy();
  }, 30000);

  it('searches AniCore from the top bar while the Anime tab is open', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText(/AniCore/).length).toBeGreaterThan(0);
    }, { timeout: 8000 });

    const input = screen.getAllByRole('textbox', { name: /search movies, shows, and anime/i })[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'frieren' } });

    await waitFor(() => {
      expect(screen.getAllByText(/ANIME SEARCH/i).length).toBeGreaterThan(0);
    }, { timeout: 8000 });
    expect((await screen.findAllByText('Frieren: Beyond Journey’s End', {}, { timeout: 8000 })).length).toBeGreaterThan(0);
  }, 30000);
});
