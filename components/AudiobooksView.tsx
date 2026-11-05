import React, { useEffect, useRef, useState } from 'react';
import {
  BookHeadphones, CircleAlert, Headphones, LoaderCircle, Pause, Play,
  RotateCcw, RotateCw, Search, Volume2, X, Sparkles,
} from 'lucide-react';
import {
  searchAllAudiobooks, getAudiobookChapters, CURATED_FEATURED_AUDIOBOOKS,
  type AudiobookItem, type AudiobookChapter,
} from '../services/audiobookService';

const TRENDING_SUGGESTIONS = [
  'Dune', 'Harry Potter', 'The Hobbit', 'Atomic Habits',
  'Project Hail Mary', 'Sherlock Holmes', 'Game of Thrones', '1984',
];

const AudiobooksView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [books, setBooks] = useState<AudiobookItem[]>(CURATED_FEATURED_AUDIOBOOKS);
  const [error, setError] = useState('');

  // Selected book & chapters
  const [selectedBook, setSelectedBook] = useState<AudiobookItem | null>(null);
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

  const playChapter = (index: number) => {
    setCurrentChapterIndex(index);
    setIsPlaying(true);
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
          <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: 0 }}>9 Audiobook Sources</h1>
        </div>
        <p style={{ color: 'var(--text-secondary, #999)', margin: '0 0 1.25rem 0' }}>
          Listen to unabridged audiobooks across AudiobookBay, BookAudio, Golden, FullLength, Hot, Audiozaic, AudioAZ, Audiobooks4Soul, and Audionest.
        </p>

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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
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
          <div className="source-modal" style={{ maxWidth: '650px', padding: '1.5rem' }}>
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

      {/* Floating Audio Player Bar */}
      {selectedBook && activeChapter && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(20,20,22,0.96)',
          backdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          padding: '0.75rem 1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 999,
          boxShadow: '0 -8px 32px rgba(0,0,0,0.6)',
        }}>
          <audio
            ref={audioRef}
            src={activeChapter.url}
            autoPlay={isPlaying}
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

          {/* Book Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: '220px', maxWidth: '30%' }}>
            {selectedBook.coverImage && (
              <img
                src={selectedBook.coverImage}
                alt=""
                style={{ width: '45px', height: '45px', borderRadius: '6px', objectFit: 'cover' }}
              />
            )}
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 700, fontSize: '0.88rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeChapter.title}
              </div>
              <div style={{ fontSize: '0.78rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedBook.title}
              </div>
            </div>
          </div>

          {/* Controls & Scrubber */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem', flex: 1, maxWidth: '550px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
              <button onClick={() => seekRelative(-15)} style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer' }} title="Rewind 15s">
                <RotateCcw size={18} />
              </button>
              <button
                onClick={togglePlay}
                style={{
                  background: '#e50914',
                  border: 'none',
                  color: '#fff',
                  width: '38px',
                  height: '38px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                {isPlaying ? <Pause size={18} fill="#fff" /> : <Play size={18} fill="#fff" style={{ marginLeft: '2px' }} />}
              </button>
              <button onClick={() => seekRelative(15)} style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer' }} title="Forward 15s">
                <RotateCw size={18} />
              </button>
            </div>

            {/* Scrubber */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%' }}>
              <span style={{ fontSize: '0.72rem', color: '#888', minWidth: '35px', textAlign: 'right' }}>{formatTime(currentTime)}</span>
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
                style={{ flex: 1, accentColor: '#e50914', height: '4px' }}
              />
              <span style={{ fontSize: '0.72rem', color: '#888', minWidth: '35px' }}>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Speed & Close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              onClick={changeRate}
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#fff',
                padding: '0.3rem 0.6rem',
                borderRadius: '6px',
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              {playbackRate}x
            </button>
            <button onClick={() => { setIsPlaying(false); }} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AudiobooksView;

