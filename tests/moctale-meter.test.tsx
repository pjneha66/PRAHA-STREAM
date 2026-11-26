// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MoctaleMeter from '../components/MoctaleMeter';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('displays the percentages supplied by the relay', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({
    state: 'ready', url: 'https://www.moctale.in/content/sample-2025',
    buckets: [
      { label: 'Perfection', percent: 35 }, { label: 'Go for it', percent: 55 },
      { label: 'Timepass', percent: 10 }, { label: 'Skip', percent: 0 },
    ],
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<MoctaleMeter title="Sample" year="2025" type="anime" />);
  expect(await screen.findByText('35%')).toBeTruthy();
  expect(screen.getByText('55%')).toBeTruthy();
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('type')).toBe('anime');
});

it('shows a source link when live values are unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    state: 'unavailable', url: 'https://www.moctale.in/content/sample-2025',
  })));
  render(<MoctaleMeter title="Sample" year="2025" type="movie" />);
  expect(await screen.findByText('Live Meter unavailable.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Moctale' })).toBeTruthy();
  expect(screen.queryByText(/%$/)).toBeNull();
});

it('opens the Android title and displays only the Meter returned for that title', async () => {
  const url = 'https://www.moctale.in/content/sample-2025';
  const openProtectedEmbed = vi.fn(() => true);
  const loadMoctaleMeter = vi.fn(() => true);
  vi.stubGlobal('PrahaNative', { openProtectedEmbed, loadMoctaleMeter });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ state: 'unavailable', url })));
  render(<MoctaleMeter title="Sample" year="2025" type="series" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Moctale' }));
  expect(openProtectedEmbed).toHaveBeenCalledWith(url);
  expect(loadMoctaleMeter).toHaveBeenCalledWith(url);
  const result = {
    state: 'ready', score: 76, votes: 200,
    buckets: [
      { label: 'Perfection', percent: 76 }, { label: 'Go for it', percent: 21 },
      { label: 'Timepass', percent: 3 }, { label: 'Skip', percent: 1, lessThan: true },
    ],
  };
  fireEvent(window, new CustomEvent('praha:moctale-meter', { detail: { ...result, url: 'https://www.moctale.in/content/other-2025' } }));
  expect(screen.queryByText('76%')).toBeNull();
  fireEvent(window, new CustomEvent('praha:moctale-meter', { detail: { ...result, url } }));
  expect(await screen.findByText('<1%')).toBeTruthy();
  expect(screen.getByText(/200 votes/)).toBeTruthy();
});
