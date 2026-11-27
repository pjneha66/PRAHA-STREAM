import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark, CircleAlert, Headphones, LoaderCircle, Pause, Play,
  RotateCcw, RotateCw, Search, Volume2, X, Sparkles,
} from 'lucide-react';
import {
  searchAllAudiobooks, getAudiobookChapters, CURATED_FEATURED_AUDIOBOOKS,
  searchAudiobooks, getChapters, AUDIOBOOK_SOURCE_NAMES,
  type AudiobookItem, type AudiobookChapter, type Audiobook as ScrapedAudiobook,
} from '../services/audiobookService';
import ContinueShelf from './ContinueShelf';
import { Artwork } from './MediaCard';
import './listening-view.css';
import { readContinue, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';
import { resolvePlayableStreamUrl } from '../services/androidBridge';

const TRENDING_SUGGESTIONS = [
  'Dune', 'Harry Potter', 'The Hobbit', 'Atomic Habits',
  'Project Hail Mary', 'Sherlock Holmes', 'Game of Thrones', '1984',
];

// One-tap browses of the archive.org audio_bookspoetry collection.
const ARCHIVE_BROWSE_TERMS = [
  'Poetry', 'Shakespeare', 'Edgar Allan Poe', 'Emily Dickinson', 'Rumi',
  'Walt Whitman', 'Jane Austen', 'Mark Twain',
];

/**
 * Adapts a VyseTV-port `Audiobook` record to the view's `AudiobookItem` shape.
 * The `uuid` is preserved as `id` so `openBook` can find the raw record back.
 */
function toViewBook(book: ScrapedAudiobook): AudiobookItem {
  const sourceName =
    AUDIOBOOK_SOURCE_NAMES[book.source as keyof typeof AUDIOBOOK_SOURCE_NAMES] || book.source;
  return {
    id: book.uuid,
    title: book.title,
    author: book.author,
    coverImage: book.coverImage,
    source: book.source,
    sourceName,
    pageUrl: book.pageUrl,
  };
}

const AudiobooksView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [books, setBooks] = useState<AudiobookItem[]>(CURATED_FEATURED_AUDIOBOOKS);
  const [error, setError] = useState('');

  // Live source mode. `classic` is the original aggregator (unchanged default);
  // `vyse` is the ported VyseTV 8-source scraper.
  const [sourceMode, setSourceMode] = useState<'classic' | 'vyse'>('classic');
  // Books returned by the ported scraper, keyed by their uuid, so chapter
  // resolution can hand the original `Audiobook` record to `getChapters`.
  const scrapedBooksRef = useRef<Map<string, ScrapedAudiobook>>(new Map());

  // Selected book & chapters
  const [selectedBook, setSelectedBook] = useState<AudiobookItem | null>(null);
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>(() => readContinue('audiobook'));
  const [chapters, setChapters] = useState<AudiobookChapter[]>([]);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchIdRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Curated featured collection is displayed instantly on mount (zero freeze/load).
  // Live scraper search only executes when the user initiates a query.

  const performSearch = async (searchTerm: string) => {
    const trimmed = searchTerm.trim();
    if (!trimmed) return;
    const currentId = ++searchIdRef.current;
    setLoading(true);
    setError('');
    try {
      if (sourceMode === 'vyse') {
        const scraped = await searchAudiobooks(trimmed);
        if (searchIdRef.current !== currentId) return;
        if (scraped.length > 0) {
          // Keep the raw records so chapter resolution uses the exact source id.
          const registry = new Map<string, ScrapedAudiobook>();
          scraped.forEach((book) => registry.set(book.uuid, book));
          scrapedBooksRef.current = registry;
          setBooks(scraped.map((book) => toViewBook(book)));
        } else {
          setError('No audiobooks found across the 8 live scrapers. Showing featured collection.');
        }
        return;
      }

      const results = await searchAllAudiobooks(trimmed);
      if (searchIdRef.current !== currentId) return;
      if (results.length > 0) {
        setBooks(results);
      } else {
        setError('No audiobooks found across the 9 sources. Showing featured collection.');
      }
    } catch {
      if (searchIdRef.current === currentId) {
        setError('Failed to query live audiobook sources. Showing featured collection.');
      }
    } finally {
      if (searchIdRef.current === currentId) {
        setLoading(false);
      }
    }
  };

  const openBook = async (book: AudiobookItem) => {
    setSelectedBook(book);
    recordContinue({
      domain: 'audiobook',
      id: book.id,
      title: book.title,
      cover: book.coverImage,
      detail: book.author,
      payload: {
        author: book.author,
        source: book.source,
        sourceName: book.sourceName,
        pageUrl: book.pageUrl,
      },
    });
    setContinueEntries(readContinue('audiobook'));
    setChaptersLoading(true);
    setChapters([]);
    setCurrentChapterIndex(0);
    try {
      const scraped = scrapedBooksRef.current.get(book.id);
      const fetched = scraped ? await getChapters(scraped) : await getAudiobookChapters(book);
      setChapters(fetched);
    } catch {
      // Ignored
    } finally {
      setChaptersLoading(false);
    }
  };

  const resumeAudiobook = (entry: ContinueEntry) => {
    const payload = (entry.payload || {}) as { author?: string; source?: string; sourceName?: string; pageUrl?: string };
    void openBook({
      id: entry.id,
      title: entry.title,
      author: payload.author,
      coverImage: entry.cover,
      source: payload.source || 'archive',
      sourceName: payload.sourceName || 'archive.org',
      pageUrl: payload.pageUrl || '',
    });
  };

  const playChapter = (index: number) => {
    setCurrentChapterIndex(index);
    setIsPlaying(true);
  };

  // Chapter bookmarks (port of PlayTorrio's audiobook player): per-book,
  // persisted, one-tap jump back to the saved spot.
  const [bookmarks, setBookmarks] = useState<Array<{ chapter: number; time: number; label: string }>>(() => {
    try {
      const raw = localStorage.getItem('praha.audiobook.bookmarks.v1');
      return raw ? (JSON.parse(raw) as Record<string, Array<{ chapter: number; time: number; label: string }>>)[selectedBookId()] || [] : [];
    } catch {
      return [];
    }
  });

  function selectedBookId(): string {
    return selectedBook?.id || '';
  }

  // Reload the bookmark list whenever a different book opens.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('praha.audiobook.bookmarks.v1');
      const all = raw ? (JSON.parse(raw) as Record<string, Array<{ chapter: number; time: number; label: string }>>) : {};
      setBookmarks(all[selectedBookId()] || []);
    } catch {
      setBookmarks([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBook?.id]);

  const persistBookmarks = (list: Array<{ chapter: number; time: number; label: string }>) => {
    try {
      const raw = localStorage.getItem('praha.audiobook.bookmarks.v1');
      const all = raw ? (JSON.parse(raw) as Record<string, Array<{ chapter: number; time: number; label: string }>>) : {};
      if (selectedBookId()) all[selectedBookId()] = list;
      localStorage.setItem('praha.audiobook.bookmarks.v1', JSON.stringify(all));
    } catch {
      // best effort
    }
  };

  const addBookmark = () => {
    if (!selectedBookId()) return;
    const entry = { chapter: currentChapterIndex, time: Math.floor(currentTime), label: `Ch. ${currentChapterIndex + 1} · ${formatStamp(currentTime)}` };
    const next = [entry, ...bookmarks].slice(0, 20);
    setBookmarks(next);
    persistBookmarks(next);
  };

  const jumpToBookmark = (bookmark: { chapter: number; time: number }) => {
    if (bookmark.chapter !== currentChapterIndex) {
      setCurrentChapterIndex(bookmark.chapter);
    }
    requestAnimationFrame(() => {
      if (audioRef.current) audioRef.current.currentTime = bookmark.time;
      setCurrentTime(bookmark.time);
    });
  };

  const formatStamp = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const seekRelative = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
  };

  const changeRate = () => {
    const rates = [0.75, 1, 1.25, 1.5, 2];
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIdx];
    setPlaybackRate(nextRate);
    if (audioRef.current) audioRef.current.playbackRate = nextRate;
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const activeChapter = chapters[currentChapterIndex];

  const streamAudioUrl = React.useMemo(() => {
    if (!activeChapter?.url) return '';
    // Ported VyseTV chapters carry `httpHeaders`; classic ones carry `headers`.
    const chapterHeaders = activeChapter.headers ?? activeChapter.httpHeaders;
    if (chapterHeaders && Object.keys(chapterHeaders).length > 0) {
      return resolvePlayableStreamUrl({
        id: activeChapter.id,
        title: activeChapter.title,
        url: activeChapter.url,
        headers: chapterHeaders,
        sourceName: selectedBook?.sourceName || 'Audiobook',
        sourceType: 'playtorrio',
        quality: 'Auto',
      });
    }
    return activeChapter.url;
  }, [activeChapter, selectedBook]);

  // Update MediaSession API for Android background playback
  useEffect(() => {
    if ('mediaSession' in navigator && selectedBook && activeChapter) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeChapter.title,
        artist: selectedBook.title,
        album: selectedBook.sourceName,
        artwork: selectedBook.coverImage ? [{ src: selectedBook.coverImage, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => {
        audioRef.current?.play();
        setIsPlaying(true);
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audioRef.current?.pause();
        setIsPlaying(false);
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => seekRelative(-15));
      navigator.mediaSession.setActionHandler('seekforward', () => seekRelative(15));
    }
  }, [selectedBook, activeChapter]);

  const closePlayer = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setIsPlaying(false);
    setSelectedBook(null);
    setChapters([]);
    setCurrentChapterIndex(0);
    setCurrentTime(0);
    setDuration(0);
  };

  return (
    <div className="standard-page page-enter audiobooks-view listening-page">
      <h1 className="listening-heading">Audiobooks</h1>
      <form className="music-search" onSubmit={(event) => { event.preventDefault(); void performSearch(query); }}>
        <div className="music-search-field">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, author, or series"
            aria-label="Search audiobooks"
          />
        </div>
        <button className="button button-primary button-small" type="submit" disabled={loading}>Search</button>
      </form>

      <div className="audiobook-source-controls">
        <select aria-label="Audiobook sources" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as typeof sourceMode)}>
          <option value="classic">Classic · 9 sources + Archive</option>
          <option value="vyse">Live · 8 scrapers</option>
        </select>
        <details className="audiobook-source-info">
          <summary>Browse sources</summary>
          <p>AudiobookBay, BookAudio, Golden, FullLength, Hot, Audiozaic, AudioAZ, Audiobooks4Soul, Audionest, and Internet Archive.</p>
          <h2>Archive poetry &amp; literature</h2>
          <div className="listening-chips" aria-label="Archive poetry and literature">
            {ARCHIVE_BROWSE_TERMS.map((term) => (
              <button key={term} type="button" className="music-genre-chip"
                aria-pressed={query === term} onClick={() => { setQuery(term); void performSearch(term); }}>{term}</button>
            ))}
          </div>
        </details>
      </div>
      <div className="listening-chips" aria-label="Audiobook suggestions">
        {TRENDING_SUGGESTIONS.map((tag) => (
          <button key={tag} type="button" className="music-genre-chip" aria-pressed={query === tag}
            onClick={() => { setQuery(tag); void performSearch(tag); }}>{tag}</button>
        ))}
      </div>

      <ContinueShelf
        entries={continueEntries}
        onResume={resumeAudiobook}
        onDismiss={(entry) => {
          removeContinue('audiobook', entry.id);
          setContinueEntries(readContinue('audiobook'));
        }}
      />

      {error && <div className="music-error" role="alert"><CircleAlert size={16} /> {error}</div>}
      {loading ? (
        <p className="audiobook-status" role="status"><LoaderCircle size={20} className="spin" /> Searching audiobooks…</p>
      ) : books.length > 0 ? (
        <section className="audiobook-catalog">
          <h2>{books === CURATED_FEATURED_AUDIOBOOKS ? 'Featured audiobooks' : 'Search results'}</h2>
          <div className="audiobook-grid">
            {books.map((book) => (
              <button
                type="button"
                key={book.id}
                className="audiobook-card"
                onClick={() => void openBook(book)}
                aria-label={`Open ${book.title}`}
              >
                <span className="audiobook-cover">
                  <Artwork src={book.coverImage} alt={book.title} />
                  <span className="audiobook-cover-icon" aria-hidden="true"><Headphones size={16} /></span>
                </span>
                <strong>{book.title}</strong>
                {book.author && <small>{book.author}</small>}
                <small>{book.sourceName}</small>
              </button>
            ))}
          </div>
        </section>
      ) : !error ? (
        <div className="empty-state">
          <h2>Explore audiobooks</h2>
          <div className="listening-chips">
            {['Sci-Fi & Fantasy', 'Mystery & Thriller', 'Philosophy', 'Classics', 'Self-Development'].map((genre) => (
              <button key={genre} type="button" className="music-genre-chip"
                onClick={() => { setQuery(genre.split(' ')[0]); void performSearch(genre.split(' ')[0]); }}>
                <Sparkles size={13} /> {genre}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {selectedBook && (
        <div className={`modal-backdrop audiobook-chapter-backdrop${activeChapter ? ' with-player' : ''}`}
          onMouseDown={(event) => event.target === event.currentTarget && setSelectedBook(null)}>
          <section className="source-modal audiobook-chapter-sheet" role="dialog" aria-modal="true" aria-label={selectedBook.title}>
            <header className="audiobook-chapter-header">
              <span className="audiobook-cover"><Artwork src={selectedBook.coverImage} alt={selectedBook.title} /></span>
              <div>
                <h2>{selectedBook.title}</h2>
                {selectedBook.author && <p>{selectedBook.author}</p>}
                <p>{selectedBook.sourceName}</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close chapters" data-android-back onClick={() => setSelectedBook(null)}><X size={20} /></button>
            </header>
            {chaptersLoading ? (
              <p className="audiobook-status" role="status"><LoaderCircle size={20} className="spin" /> Loading chapters…</p>
            ) : !chapters.length ? (
              <p className="audiobook-status">This source did not return playable chapters.</p>
            ) : (
              <div className="audiobook-chapter-list" aria-label="Audiobook chapters">
                {chapters.map((chapter, index) => (
                  <button type="button" key={chapter.id} className={currentChapterIndex === index ? 'active' : ''}
                    onClick={() => playChapter(index)}>
                    {currentChapterIndex === index && isPlaying ? <Volume2 size={17} /> : <Play size={16} />}
                    <span>{chapter.title}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Floating Audio Player Bar — two stacked rows so nothing overlaps on phones */}
      {selectedBook && activeChapter && (
        <div className="audiobook-bar">
          <audio
            ref={audioRef}
            src={streamAudioUrl}
            autoPlay={isPlaying}
            onError={() => {
              setError('Unable to stream this chapter directly. Check internet or try another chapter.');
            }}
            onTimeUpdate={() => {
              if (audioRef.current) {
                setCurrentTime(audioRef.current.currentTime);
                setDuration(audioRef.current.duration || 0);
              }
            }}
            onEnded={() => {
              if (currentChapterIndex < chapters.length - 1) {
                playChapter(currentChapterIndex + 1);
              } else {
                setIsPlaying(false);
              }
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />

          <div className="audiobook-bar-top">
            {selectedBook.coverImage && (
              <img src={selectedBook.coverImage} alt="" className="audiobook-bar-art" />
            )}
            <div className="audiobook-bar-copy">
              <strong>{activeChapter.title}</strong>
              <small>{selectedBook.title}</small>
            </div>
            {bookmarks.length > 0 && (
              <select
                onChange={(event) => {
                  const entry = bookmarks[Number(event.target.value)];
                  if (entry) jumpToBookmark(entry);
                  event.currentTarget.selectedIndex = 0;
                }}
                aria-label="Jump to bookmark"
                className="audiobook-bar-bookmarks"
              >
                <option value="">⚑ {bookmarks.length}</option>
                {bookmarks.map((entry, index) => (
                  <option key={`${entry.chapter}-${entry.time}-${index}`} value={index}>{entry.label}</option>
                ))}
              </select>
            )}
            <button onClick={changeRate} className="audiobook-bar-rate" aria-label="Change playback speed">
              {playbackRate}x
            </button>
            <button onClick={closePlayer} className="audiobook-bar-close" aria-label="Close player">
              <X size={17} />
            </button>
          </div>

          <div className="audiobook-bar-scrub">
            <button onClick={() => seekRelative(-15)} aria-label="Rewind 15 seconds">
              <RotateCcw size={17} />
            </button>
            <button onClick={togglePlay} className="audiobook-bar-play" aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
            </button>
            <button onClick={() => seekRelative(15)} aria-label="Forward 15 seconds">
              <RotateCw size={17} />
            </button>
            <span className="audiobook-bar-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={currentTime}
              onChange={(e) => {
                const val = Number(e.target.value);
                setCurrentTime(val);
                if (audioRef.current) audioRef.current.currentTime = val;
              }}
              aria-label="Seek"
            />
            <span className="audiobook-bar-time">{formatTime(duration)}</span>
            <button onClick={addBookmark} className="audiobook-bar-bookmark" aria-label="Bookmark this spot">
              <Bookmark size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AudiobooksView;

