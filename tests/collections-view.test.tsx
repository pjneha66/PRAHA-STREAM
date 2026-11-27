// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CollectionsView from '../components/CollectionsView';
import HoldToSaveButton from '../components/HoldToSaveButton';
import { tmdbService } from '../services/tmdbService';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const touch = { pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, clientX: 50, clientY: 50 };

it('saves on a stationary touch, suppresses the release click, and cancels a swipe', () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const open = vi.fn();
  render(<HoldToSaveButton onSave={save} onClick={open}>Title</HoldToSaveButton>);
  const card = screen.getByRole('button', { name: 'Title' });

  fireEvent.pointerDown(card, touch);
  act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerUp(card, touch);
  fireEvent.click(card, { detail: 1 });
  expect(save).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();

  fireEvent.pointerDown(card, touch);
  fireEvent.pointerMove(card, { ...touch, clientY: 95 });
  act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerCancel(card, touch);
  expect(save).toHaveBeenCalledTimes(1);

  fireEvent.pointerDown(card, touch);
  fireEvent.pointerUp(card, touch);
  fireEvent.click(card, { detail: 1 });
  expect(open).toHaveBeenCalledTimes(1);
});

function renderCollections(tmdbReady: boolean) {
  const onSelect = vi.fn();
  render(<CollectionsView tmdbReady={tmdbReady} watchlist={[]} onSelect={onSelect}
    onToggleWatchlist={vi.fn()} onOpenSettings={vi.fn()} />);
  return onSelect;
}

it('opens a built-in shared universe and passes its TV entry to the title details', () => {
  const onSelect = renderCollections(false);
  fireEvent.click(screen.getByRole('button', { name: 'Shared universes' }));
  expect(screen.queryByRole('button', { name: /Back to the Future/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Marvel Cinematic Universe/ }));
  fireEvent.click(screen.getByRole('button', { name: 'View Loki' }));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ imdbId: 'tt9140554', type: 'series' }));
  fireEvent.click(screen.getByRole('button', { name: 'Collections' }));
  expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy();
});

it('searches TMDB franchises and opens a result with its full movie list', async () => {
  const search = vi.spyOn(tmdbService, 'searchCollections').mockResolvedValue({
    items: [{ id: 7, title: 'Shrek Collection' }], hasMore: false,
  });
  const movies = vi.spyOn(tmdbService, 'collectionMovies').mockResolvedValue([{
    id: 'tmdb:808', title: 'Shrek', tmdbId: 808, type: 'movie', source: 'tmdb', poster: '', overview: '', genres: [],
  }]);
  renderCollections(true);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Shrek' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: /Shrek Collection/ }));
  expect(search).toHaveBeenCalledWith('Shrek', 1);
  expect(movies).toHaveBeenCalledWith(7);
  expect(await screen.findByRole('button', { name: 'View Shrek' })).toBeTruthy();
});
