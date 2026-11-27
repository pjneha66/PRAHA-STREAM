// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Artwork } from '../components/MediaCard';

afterEach(cleanup);

it('switches to the alternate artwork and reveals it only after decoding', async () => {
  render(<Artwork src="https://example.com/poster.jpg" fallback="https://example.com/backup.jpg" alt="Poster" />);
  fireEvent.error(screen.getByAltText('Poster'));
  const image = screen.getByAltText('Poster') as HTMLImageElement;
  expect(image.src).toBe('https://example.com/backup.jpg');
  expect(image.style.opacity).toBe('0');

  let decoded!: () => void;
  Object.defineProperty(image, 'naturalWidth', { value: 400 });
  image.decode = () => new Promise<void>((resolve) => { decoded = resolve; });
  fireEvent.load(image);
  expect(image.style.opacity).toBe('0');
  await act(async () => decoded());
  expect(image.style.opacity).toBe('');
});
