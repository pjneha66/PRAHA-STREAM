// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NovelsView from '../components/NovelsView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('opens an English novel chapter in the text reader and remembers it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const pages: Record<string, string> = {
      '/': '<a href="/novel.html">Test Novel</a>',
      '/novel.html': '<div data-novel-id="123"></div>',
      '/ajax/chapter-archive': '<ul class="list-chapter"><li><a href="/novel/first.html">Chapter 1</a></li></ul>',
      '/novel/first.html': '<div id="chr-content"><p>A readable chapter.</p><script>script removed</script></div>',
    };
    return { ok: !!pages[url.pathname], status: 200, text: async () => pages[url.pathname] || '' } as Response;
  }));
  render(<NovelsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test Novel' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Chapter 1' }));
  expect(await screen.findByText('A readable chapter.')).toBeTruthy();
  expect(screen.queryByText('script removed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to chapters' }));
  expect(screen.getByRole('button', { name: 'Resume Chapter 1' })).toBeTruthy();
});
