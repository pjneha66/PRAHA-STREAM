/**
 * Tests for the VyseTV → TypeScript audiobook port.
 *
 * `nativeFetchText` is the only network path in the service (the Android
 * native bridge), so mocking it keeps these tests offline and deterministic
 * while still exercising every URL pattern and parser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FetchCall {
  url: string;
  options: FetchOptions;
}

interface FakeReply {
  ok: boolean;
  status: number;
  data: string;
}

type ReplyHandler = (url: string, options: FetchOptions) => FakeReply | undefined;

const harness = vi.hoisted(() => ({
  calls: [] as FetchCall[],
  handler: null as ReplyHandler | null,
}));

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: async (url: string, options: FetchOptions = {}): Promise<FakeReply> => {
    harness.calls.push({ url, options });
    const reply = harness.handler?.(url, options);
    return reply ?? { ok: true, status: 200, data: '' };
  },
}));

import {
  searchAudiobooks,
  getChapters,
  audiobookRelevanceScore,
  AUDIOBOOK_SOURCE_NAMES,
  type Audiobook,
} from '../services/audiobookService';

const QUERY = 'The Hobbit';
const ENCODED_QUERY = encodeURIComponent(QUERY);

function book(overrides: Partial<Audiobook> = {}): Audiobook {
  return {
    uuid: 'golden_test',
    audioBookId: 'https://goldenaudiobooks.com/dune-audiobook/',
    dynamicSlugId: 'https://goldenaudiobooks.com/dune-audiobook/',
    title: 'Dune',
    coverImage: '',
    source: 'goldenaudiobooks',
    pageUrl: 'https://goldenaudiobooks.com/dune-audiobook/',
    ...overrides,
  };
}

/** A WordPress search-results page with one post per title. */
function wpSearchPage(entries: Array<{ href: string; title: string; cover?: string }>): string {
  const articles = entries
    .map(
      (entry) => `<article class="post type-post">
  <h2 class="entry-title"><a href="${entry.href}">${entry.title}</a></h2>
  <img data-lazy-src="${entry.cover ?? 'https://cdn.example/cover.jpg'}" src="data:image/gif;base64,R0lGOD" />
</article>`,
    )
    .join('\n');
  return `<html><body><div class="site-main">${articles}</div></body></html>`;
}

beforeEach(() => {
  harness.calls = [];
  harness.handler = null;
});

describe('audiobook port · source URLs', () => {
  it('builds the exact URL for all 8 sources, with Referer + desktop UA', async () => {
    harness.handler = (url) => {
      if (url.startsWith('https://search.audionestapp.com/')) {
        return { ok: true, status: 200, data: JSON.stringify({ hits: [] }) };
      }
      return { ok: true, status: 200, data: '<html><body></body></html>' };
    };

    await searchAudiobooks(QUERY);

    const getUrls = harness.calls.filter((call) => call.options.method !== 'POST').map((call) => call.url);
    expect(getUrls).toContain(`https://bookaudiobooks.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://goldenaudiobooks.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://fulllengthaudiobooks.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://hotaudiobooks.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://audiozaic.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://audioaz.com/en/search?q=${ENCODED_QUERY}`);
    expect(getUrls).toContain(`https://audiobooks4soul.com/?s=${ENCODED_QUERY}`);
    expect(getUrls).toHaveLength(7);

    const audionest = harness.calls.find((call) => call.url === 'https://search.audionestapp.com/indexes/trackfiles/search');
    expect(audionest?.options.method).toBe('POST');
    expect(JSON.parse(audionest?.options.body ?? '{}')).toEqual({ q: QUERY, limit: 30 });

    // Exactly one request per source: 7 GETs + 1 POST, nothing duplicated.
    expect(harness.calls).toHaveLength(8);

    const wordpressCall = harness.calls.find((call) => call.url.startsWith('https://goldenaudiobooks.com/'));
    expect(wordpressCall?.options.headers?.Referer).toBe('https://goldenaudiobooks.com/');
    expect(wordpressCall?.options.headers?.['User-Agent']).toContain('Chrome/120');
    expect(wordpressCall?.options.timeoutMs).toBe(5000);

    expect(AUDIOBOOK_SOURCE_NAMES.audioaz).toBe('AudioAZ');
  });

  it('returns an empty list for a blank query without touching the network', async () => {
    expect(await searchAudiobooks('   ')).toEqual([]);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('audiobook port · WordPress parsing', () => {
  it('parses WordPress search results into books with cleaned titles and covers', async () => {
    harness.handler = (url) => {
      if (url.startsWith('https://goldenaudiobooks.com/?s=')) {
        return {
          ok: true,
          status: 200,
          data: wpSearchPage([
            {
              href: 'https://goldenaudiobooks.com/dune-audiobook/',
              title: '[Listen] Dune Audiobook',
              cover: 'https://goldenaudiobooks.com/covers/dune.jpg',
            },
          ]),
        };
      }
      return { ok: true, status: 200, data: '' };
    };

    const books = await searchAudiobooks('Dune');
    const golden = books.filter((entry) => entry.source === 'goldenaudiobooks');

    expect(golden).toHaveLength(1);
    expect(golden[0].title).toBe('Dune');
    expect(golden[0].coverImage).toBe('https://goldenaudiobooks.com/covers/dune.jpg');
    expect(golden[0].pageUrl).toBe('https://goldenaudiobooks.com/dune-audiobook/');
    expect(golden[0].audioBookId).toBe('https://goldenaudiobooks.com/dune-audiobook/');
    expect(golden[0].uuid).toBe('golden_https://goldenaudiobooks.com/dune-audiobook/');
  });

  it('extracts <source src> chapter streams from a WordPress book page', async () => {
    const bookPage = `<html><body><div class="entry-content">
  <audio id="player" preload="none">
    <source src="https://goldenaudiobooks.com/audio/hobbit-01.mp3" type="audio/mpeg" />
    <source src="https://goldenaudiobooks.com/audio/hobbit-02.mp3" type="audio/mpeg" />
  </audio>
</div></body></html>`;

    harness.handler = (url) => {
      if (url === 'https://goldenaudiobooks.com/the-hobbit-audiobook/') {
        return { ok: true, status: 200, data: bookPage };
      }
      return { ok: true, status: 200, data: '' };
    };

    const chapters = await getChapters(book({ pageUrl: 'https://goldenaudiobooks.com/the-hobbit-audiobook/' }));
    expect(chapters.map((chapter) => chapter.url)).toEqual([
      'https://goldenaudiobooks.com/audio/hobbit-01.mp3',
      'https://goldenaudiobooks.com/audio/hobbit-02.mp3',
    ]);
    expect(chapters[0].title).toBe('Chapter 1');
    expect(chapters[1].title).toBe('Chapter 2');
    expect(chapters[0].httpHeaders?.Referer).toBe('https://goldenaudiobooks.com/');
    // Upstream uses a deliberately shorter UA for chapter playback, not the
    // full desktop Chrome UA used for search pages.
    expect(chapters[0].httpHeaders?.['User-Agent']).toContain('AppleWebKit/537.36');
  });

  it('follows the audiozaic window.open() listen URL before extracting sources', async () => {
    harness.handler = (url) => {
      if (url === 'https://audiozaic.com/dune-audiobook/') {
        return {
          ok: true,
          status: 200,
          data: `<html><body><button onclick="window.open('/listen/dune-123');">Listen</button></body></html>`,
        };
      }
      if (url === 'https://audiozaic.com/listen/dune-123') {
        return {
          ok: true,
          status: 200,
          data: '<audio><source src="https://audiozaic.com/audio/dune-01.mp3" /></audio>',
        };
      }
      return { ok: true, status: 200, data: '' };
    };

    const chapters = await getChapters(
      book({
        source: 'audiozaic',
        pageUrl: 'https://audiozaic.com/dune-audiobook/',
        audioBookId: 'https://audiozaic.com/dune-audiobook/',
      }),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].url).toBe('https://audiozaic.com/audio/dune-01.mp3');
    expect(chapters[0].httpHeaders?.Referer).toBe('https://audiozaic.com/');
  });

  it('decrypts audiobooks4soul playlist data-src blobs', async () => {
    harness.handler = (url) => {
      if (url === 'https://audiobooks4soul.com/dune-audiobook/') {
        return {
          ok: true,
          status: 200,
          data: '<div class="simp-playlist"><div class="track" data-src="ENC+blob+/1="></div></div>',
        };
      }
      if (url.startsWith('https://audiobooks4soul.com/wp-content/plugins/custom-story-audio/inc/security/decrypt.php')) {
        return { ok: true, status: 200, data: 'https://audiobooks4soul.com/audio/decrypted-01.mp3\n' };
      }
      return { ok: true, status: 200, data: '' };
    };

    const chapters = await getChapters(
      book({
        source: 'audiobooks4soul',
        pageUrl: 'https://audiobooks4soul.com/dune-audiobook/',
        audioBookId: 'https://audiobooks4soul.com/dune-audiobook/',
      }),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Chapter 1');
    expect(chapters[0].url).toBe('https://audiobooks4soul.com/audio/decrypted-01.mp3');

    const decryptCall = harness.calls.find((call) => call.url.includes('/decrypt.php'));
    expect(decryptCall?.url).toBe(
      'https://audiobooks4soul.com/wp-content/plugins/custom-story-audio/inc/security/decrypt.php?encrypted=ENC%2Bblob%2B%2F1%3D',
    );
  });
});

describe('audiobook port · audionest', () => {
  it('parses hits from the trackfiles search index', async () => {
    harness.handler = (url) => {
      if (url === 'https://search.audionestapp.com/indexes/trackfiles/search') {
        return {
          ok: true,
          status: 200,
          data: JSON.stringify({
            hits: [
              { id: 4242, title: 'Dune', thumbnailUrl: 'https://cdn.audionest/dune.jpg' },
              { id: 99, title: 'Dune Messiah', img_prefix: 'https://cdn.audionest/messiah' },
              { title: 'no id, skipped' },
            ],
          }),
        };
      }
      return { ok: true, status: 200, data: '' };
    };

    const books = await searchAudiobooks('Dune');
    const nest = books.filter((entry) => entry.source === 'audionest');

    expect(nest).toHaveLength(2);
    // VyseTV's own RelevanceScorer ranks "Dune Messiah" above an exact "Dune"
    // (substring + prefix bonuses), so look results up by id rather than order.
    const dune = nest.find((entry) => entry.audioBookId === '4242');
    expect(dune?.uuid).toBe('nest_4242');
    expect(dune?.coverImage).toBe('https://cdn.audionest/dune.jpg');
    expect(nest.find((entry) => entry.audioBookId === '99')?.coverImage).toBe('https://cdn.audionest/messiah');
  });

  it('reads Firestore runQuery urlLink arrayValue values', async () => {
    harness.handler = (url, options) => {
      if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signUp')) {
        return { ok: true, status: 200, data: JSON.stringify({ idToken: 'anon-token', expiresIn: '3600' }) };
      }
      if (url === 'https://firestore.googleapis.com/v1/projects/learningfirebase-ae02f/databases/(default)/documents:runQuery') {
        expect(options.headers?.Authorization).toBe('Bearer anon-token');
        const body = JSON.parse(options.body ?? '{}') as {
          structuredQuery: { from: Array<{ collectionId: string }>; where: { fieldFilter: { value: { integerValue: string } } } };
        };
        expect(body.structuredQuery.from[0].collectionId).toBe('TrackFiles');
        expect(body.structuredQuery.where.fieldFilter.value.integerValue).toBe('4242');
        return {
          ok: true,
          status: 200,
          data: JSON.stringify([
            {
              document: {
                fields: {
                  urlLink: {
                    arrayValue: {
                      values: [
                        { stringValue: 'https://cdn.audionest/dune-01.mp3' },
                        { stringValue: 'https://cdn.audionest/dune-02.mp3' },
                      ],
                    },
                  },
                },
              },
            },
            { readTime: '2026-01-01T00:00:00Z' },
          ]),
        };
      }
      return { ok: true, status: 200, data: '' };
    };

    const chapters = await getChapters(
      book({ source: 'audionest', audioBookId: '4242', pageUrl: '4242' }),
    );

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({ title: 'Chapter 1', url: 'https://cdn.audionest/dune-01.mp3' });
    expect(chapters[1]).toMatchObject({ title: 'Chapter 2', url: 'https://cdn.audionest/dune-02.mp3' });
  });

  it('labels a single audionest track as the full audiobook', async () => {
    harness.handler = (url) => {
      if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
        return { ok: true, status: 200, data: JSON.stringify({ idToken: 'anon-token-2', expiresIn: '3600' }) };
      }
      if (url.includes('documents:runQuery')) {
        return {
          ok: true,
          status: 200,
          data: JSON.stringify([
            {
              document: {
                fields: { urlLink: { arrayValue: { values: [{ stringValue: 'https://cdn.audionest/full.mp3' }] } } },
              },
            },
          ]),
        };
      }
      return { ok: true, status: 200, data: '' };
    };

    const chapters = await getChapters(
      book({ source: 'audionest', audioBookId: '777', pageUrl: '777' }),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Full Audiobook');
    expect(chapters[0].url).toBe('https://cdn.audionest/full.mp3');
  });
});

describe('audiobook port · relevance ordering', () => {
  it('puts an exact title match first', async () => {
    const page = wpSearchPage([
      { href: 'https://goldenaudiobooks.com/children-of-dune/', title: 'Children of Dune' },
      { href: 'https://goldenaudiobooks.com/dune/', title: 'Dune' },
      { href: 'https://goldenaudiobooks.com/dune-messiah/', title: 'Dune Messiah' },
    ]);

    harness.handler = (url) => {
      if (url.startsWith('https://goldenaudiobooks.com/?s=')) return { ok: true, status: 200, data: page };
      return { ok: true, status: 200, data: '' };
    };

    const books = await searchAudiobooks('Dune Messiah');
    expect(books[0].title).toBe('Dune Messiah');
    expect(books[0].pageUrl).toBe('https://goldenaudiobooks.com/dune-messiah/');
  });

  it('scores exact, article-stripped and partial matches in the documented order', () => {
    expect(audiobookRelevanceScore('Dune', 'Dune')).toBe(10000);
    expect(audiobookRelevanceScore('Hobbit', 'The Hobbit')).toBe(10000);
    expect(audiobookRelevanceScore('Dune Messiah', 'Dune')).toBeGreaterThan(
      audiobookRelevanceScore('Dune Messiah', 'Hobbit'),
    );
    // A multi-word query that misses a term is capped far below a full hit.
    expect(audiobookRelevanceScore('Dune Messiah Book Two', 'Dune Hobbit')).toBeLessThan(1000);
    expect(audiobookRelevanceScore('', 'Dune')).toBe(0);
  });
});
