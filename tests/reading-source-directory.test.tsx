// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import ReadingSourceDirectory from '../components/ReadingSourceDirectory';
import type { NsfwMode } from '../types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('hides Kotatsu hentai by default and shows only English sources in each mode', async () => {
  const sites = [
    { name: 'Twokinds', lang: 'en', contentType: 'COMICS' },
    { name: 'Adult catalog', lang: 'en', contentType: 'HENTAI' },
    { name: 'Broken catalog', lang: 'en', contentType: 'HENTAI', isBroken: true },
    { name: 'Non-English catalog', lang: 'ja', contentType: 'HENTAI' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites }))));
  const openReader = vi.fn();
  function Directory() {
    const [mode, setMode] = useState<NsfwMode>('off');
    return <ReadingSourceDirectory repository="kotatsu" readers={{ Twokinds: openReader }} adultMode={mode} onAdultMode={setMode} />;
  }
  const { container } = render(<Directory />);
  const details = container.querySelector('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));

  fireEvent.click(await screen.findByRole('button', { name: 'Twokinds · Open in PRAHA' }));
  expect(openReader).toHaveBeenCalledOnce();
  expect(screen.queryByText('Adult catalog')).toBeNull();

  const hentai = screen.getByRole('combobox', { name: 'Hentai' });
  fireEvent.change(hentai, { target: { value: 'on' } });
  expect(screen.getByText('Adult catalog')).toBeTruthy();
  expect(screen.queryByText('Broken catalog')).toBeNull();
  expect(screen.queryByText('Non-English catalog')).toBeNull();

  fireEvent.change(hentai, { target: { value: 'only' } });
  expect(screen.getByText('Adult catalog')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Twokinds/ })).toBeNull();
});
