import React, { useEffect, useRef, useState } from 'react';
import {
  BookHeadphones, Bookmark, CircleAlert, Headphones, LoaderCircle, Pause, Play,
  RotateCcw, RotateCw, Search, Volume2, X, Sparkles,
} from 'lucide-react';
import {
  searchAllAudiobooks, getAudiobookChapters, CURATED_FEATURED_AUDIOBOOKS,
  type AudiobookItem, type AudiobookChapter,
} from '../services/audiobookService';
import ContinueShelf from './ContinueShelf';
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

const AudiobooksView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [books, setBooks] = useState<AudiobookItem[]>(CURATED_FEATURED_AUDIOBOOKS);
  const [error, setError] = useState('');

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
      const fetched = await getAudiobookChapters(book);
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
    if (activeChapter.headers && Object.keys(activeChapter.headers).length > 0) {
      return resolvePlayableStreamUrl({
        id: activeChapter.id,
        title: activeChapter.title,
        url: activeChapter.url,
        headers: activeChapter.headers,
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

  return (
    <div className="audiobooks-view" style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <BookHeadphones size={28} color="#e50914" />
          <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: 0 }}>10 Audiobook Sources</h1>
        </div>
        <p style={{ color: 'var(--text-secondary, #999)', margin: '0 0 1.25rem 0' }}>
          Listen to unabridged audiobooks across AudiobookBay, BookAudio, Golden, FullLength, Hot, Audiozaic, AudioAZ,
          Audiobooks4Soul, Audionest, and the Internet Archive poetry &amp; literature collection (75,000+ free readings).
        </p>

        <ContinueShelf
          entries={continueEntries}
          onResume={resumeAudiobook}
          onDismiss={(entry) => {
            removeContinue('audiobook', entry.id);
            setContinueEntries(readContinue('audiobook'));
          }}
        />

        {/* Search Bar */}
        <div style={{ display: 'flex', gap: '0.75rem', maxWidth: '650px', marginBottom: '1rem' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && performSearch(query)}
              placeholder="Search by title, author, or series…"
              className="text-input"
              style={{
                width: '100%',
                padding: '0.75rem 1rem 0.75rem 2.5rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontSize: '0.95rem',
              }}
            />
            <Search size={18} style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
          </div>
          <button
            className="button button-primary"
            onClick={() => performSearch(query)}
            disabled={loading}
            style={{ padding: '0 1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            {loading ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}
            Search
          </button>
        </div>

        {/* Quick Suggestion Pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
          {TRENDING_SUGGESTIONS.map((tag) => (
            <button
              key={tag}
              onClick={() => { setQuery(tag); performSearch(tag); }}
              style={{
                background: query === tag ? 'var(--accent, #e50914)' : 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#fff',
                padding: '0.35rem 0.75rem',
                borderRadius: '20px',
                fontSize: '0.82rem',
                cursor: 'pointer',
              }}
            >
              {tag}
            </button>
          ))}
        </div>

        {/* Internet Archive · audio_bookspoetry one-tap browse */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.78rem', color: '#a497c4', fontWeight: 700, letterSpacing: '0.4px' }}>ARCHIVE · POETRY &amp; LIT:</span>
          {ARCHIVE_BROWSE_TERMS.map((term) => (
            <button
              key={term}
              onClick={() => { setQuery(term); performSearch(term); }}
              style={{
                background: 'rgba(214, 247, 122, 0.1)',
                border: '1px solid rgba(214, 247, 122, 0.35)',
                color: '#d6f77a',
                padding: '0.35rem 0.75rem',
                borderRadius: '20px',
                fontSize: '0.82rem',
                cursor: 'pointer',
              }}
            >
              {term}
            </button>
          ))}
        </div>
      </header>

      {/* Error state */}
      {error && (
        <div style={{ background: 'rgba(229,9,20,0.1)', border: '1px solid rgba(229,9,20,0.3)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <CircleAlert size={20} color="#e50914" />
          <span>{error}</span>
        </div>
      )}

      {/* Grid of Results */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem 0', gap: '1rem' }}>
          <LoaderCircle size={36} className="spin" color="#e50914" />
          <p style={{ color: '#aaa' }}>Searching all 9 audiobook repositories in parallel…</p>
        </div>
      ) : books.length > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '1.25rem',
          marginBottom: selectedBook ? '7rem' : '2rem',
        }}>
          {books.map((book) => (
            <div
              key={book.id}
              onClick={() => openBook(book)}
              style={{
                background: 'rgba(255,255,255,0.04)',
                borderRadius: '10px',
                overflow: 'hidden',
                cursor: 'pointer',
                transition: 'transform 0.2s, box-shadow 0.2s',
                display: 'flex',
                flexDirection: 'column',
                border: selectedBook?.id === book.id ? '2px solid #e50914' : '1px solid rgba(255,255,255,0.08)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
            >
              <div style={{ width: '100%', height: '220px', background: '#1c1c1e', position: 'relative', overflow: 'hidden' }}>
                {book.coverImage ? (
                  <img
                    src={book.coverImage}
                    alt={book.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                  />
                ) : (
                  <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                    <Headphones size={42} opacity={0.3} />
                  </div>
                )}
                <span style={{
                  position: 'absolute',
                  bottom: '8px',
                  right: '8px',
                  background: 'rgba(0,0,0,0.75)',
                  fontSize: '0.7rem',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backdropFilter: 'blur(4px)',
                }}>
                  {book.sourceName}
                </span>
              </div>
              <div style={{ padding: '0.85rem', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: '0.9rem', lineHeight: '1.3', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {book.title}
                </strong>
                <span style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.5rem' }}>
                  {book.sourceName}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : !error ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4rem 1rem',
          textAlign: 'center',
          background: 'rgba(255,255,255,0.02)',
          borderRadius: '16px',
          border: '1px dashed rgba(255,255,255,0.1)',
        }}>
          <Headphones size={48} style={{ color: 'var(--accent, #e50914)', marginBottom: '1rem', opacity: 0.8 }} />
          <h2 style={{ fontSize: '1.3rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Explore Unabridged Audiobooks</h2>
          <p style={{ color: '#888', maxWidth: '500px', fontSize: '0.9rem', margin: '0 0 1.5rem 0' }}>
            Choose a trending title above or search by book name, author, or narrator to stream full audiobooks with chapter navigation.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', justifyContent: 'center', maxWidth: '600px' }}>
            {['Sci-Fi & Fantasy', 'Mystery & Thriller', 'Philosophy', 'Classics', 'Self-Development'].map((genre) => (
              <button
                key={genre}
                onClick={() => { setQuery(genre.split(' ')[0]); performSearch(genre.split(' ')[0]); }}
                className="button button-secondary"
                style={{ borderRadius: '20px', padding: '0.4rem 1rem', fontSize: '0.85rem' }}
              >
                <Sparkles size={13} style={{ marginRight: '6px' }} /> {genre}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Book Detail & Chapter Selector Modal */}
      {selectedBook && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSelectedBook(null)}>
          <div className="source-modal" style={{ maxWidth: '650px', padding: '1.5rem', paddingBottom: activeChapter ? '9rem' : '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: '#e50914', fontWeight: 700, letterSpacing: '1px' }}>AUDIOBOOK DETAILS</span>
                <h2 style={{ fontSize: '1.4rem', margin: '0.25rem 0 0 0' }}>{selectedBook.title}</h2>
                <span style={{ fontSize: '0.85rem', color: '#999' }}>Source: {selectedBook.sourceName}</span>
              </div>
              <button className="modal-close" onClick={() => setSelectedBook(null)}><X size={20} /></button>
            </div>

            <div style={{ marginBottom: '1.5rem', maxHeight: '350px', overflowY: 'auto' }}>
              {chaptersLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '0.75rem' }}>
                  <LoaderCircle size={24} className="spin" color="#e50914" />
                  <span>Fetching chapter streams…</span>
                </div>
              ) : chapters.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  No playable chapters resolved for this source.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {chapters.map((ch, idx) => (
                    <button
                      key={ch.id}
                      onClick={() => playChapter(idx)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.75rem 1rem',
                        borderRadius: '8px',
                        background: currentChapterIndex === idx ? 'rgba(229,9,20,0.15)' : 'rgba(255,255,255,0.05)',
                        border: currentChapterIndex === idx ? '1px solid rgba(229,9,20,0.4)' : '1px solid transparent',
                        color: '#fff',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        {currentChapterIndex === idx && isPlaying ? <Volume2 size={16} color="#e50914" /> : <Play size={15} />}
                        <span style={{ fontWeight: currentChapterIndex === idx ? 700 : 400 }}>{ch.title}</span>
                      </div>
                      <span style={{ fontSize: '0.78rem', color: '#888' }}>Stream</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
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
            <button onClick={() => { setIsPlaying(false); }} className="audiobook-bar-close" aria-label="Close player">
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

