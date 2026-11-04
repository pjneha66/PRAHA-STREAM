import { describe, expect, it } from 'vitest';
import { searchAllAudiobooks, getAudiobookChapters, type AudiobookItem } from '../services/audiobookService';

describe('9 Audiobook Sources Service', () => {
  it('returns empty array on blank query without crashing', async () => {
    const results = await searchAllAudiobooks('');
    expect(results).toEqual([]);
  });

  it('handles getAudiobookChapters gracefully for standard sources', async () => {
    const mockBook: AudiobookItem = {
      id: 'golden_123',
      title: 'The Hobbit',
      source: 'goldenaudiobooks',
      sourceName: 'Golden Audiobooks',
      pageUrl: 'https://goldenaudiobooks.com/the-hobbit-audiobook/',
    };

    const chapters = await getAudiobookChapters(mockBook);
    expect(Array.isArray(chapters)).toBe(true);
  });

  it('handles audiobookbay torrent stream chapter fallback', async () => {
    const mockAbb: AudiobookItem = {
      id: 'abb_123',
      title: 'Dune',
      source: 'audiobookbay',
      sourceName: 'AudiobookBay',
      pageUrl: 'https://audiobookbay.lu/abss/dune-frank-herbert/',
    };

    const chapters = await getAudiobookChapters(mockAbb);
    expect(Array.isArray(chapters)).toBe(true);
  });
});

