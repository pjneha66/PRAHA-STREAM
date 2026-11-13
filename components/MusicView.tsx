import React, { useEffect, useRef, useState } from 'react';
import {
  CircleAlert, Disc3, FastForward, Heart, ListMusic, LoaderCircle,
  Mic2, Music, Music2, Pause, Play, Repeat, RotateCcw, RotateCw,
  Search, Shuffle, SkipBack, SkipForward, Sparkles, Volume2, VolumeX, X,
} from 'lucide-react';
import SkeletonGrid from './SkeletonGrid';
import { fetchSyncedLyrics, activeLyricIndex, type LyricLine } from '../services/lyricsService';
import {
  OctaveMusicService, FALLBACK_FEATURED_SECTIONS, type MusicAlbum, type MusicArtist,
  type MusicTrack, type OctaveSearchData,
} from '../services/musicService';

const TRENDING_GENRES = [
  'Top Hits', 'Synthwave', 'Electronic', 'Pop',
  'Anime OST', 'Hip-Hop', 'Lofi & Chill', 'Rock', 'Ambient',
];

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

const MusicView: React.FC<{ prefillQuery?: string }> = ({ prefillQuery }) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [featuredSections, setFeaturedSections] = useState<Record<string, MusicTrack[]>>(FALLBACK_FEATURED_SECTIONS);
  const [searchResults, setSearchResults] = useState<OctaveSearchData | null>(null);
  const [error, setError] = useState('');

  // Player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchIdRef = useRef<number>(0);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);

  useEffect(() => {
    let active = true;
    setLyrics(null);
    if (currentTrack?.title && currentTrack?.artist) {
      fetchSyncedLyrics({ title: currentTrack.title, artist: currentTrack.artist, duration: currentTrack.duration })
        .then((lines) => { if (active) setLyrics(lines); })
        .catch(() => undefined);
    }
    return () => { active = false; };
  }, [currentTrack?.id]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [resolvedStreamUrl, setResolvedStreamUrl] = useState<string | null>(null);
  const [streamLoading, setStreamLoading] = useState(false);
  const [isFullAudio, setIsFullAudio] = useState(false);

  // Load featured sections once on mount
  useEffect(() => {
    let active = true;
    setFeaturedLoading(true);
    OctaveMusicService.fetchFeaturedSections()
      .then((sections) => {
        if (active) {
          setFeaturedSections(sections);
          // If queue is empty, set first section tracks as default queue
          const firstSection = Object.values(sections)[0];
          if (firstSection && firstSection.length) {
            setQueue(firstSection);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setFeaturedLoading(false);
      });
    return () => { active = false; };
  }, []);

  const performSearch = async (searchTerm: string) => {
    const trimmed = searchTerm.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }
    const currentId = ++searchIdRef.current;
    setLoading(true);
    setError('');
    try {
      const data = await OctaveMusicService.searchFull(trimmed);
      if (searchIdRef.current !== currentId) return;
      setSearchResults(data);
      if (data.tracks.length === 0 && data.artists.length === 0 && data.albums.length === 0) {
        setError(`No music results found for "${trimmed}". Try another title or artist.`);
      }
    } catch {
      if (searchIdRef.current === currentId) {
        setError('Failed to search music catalog.');
      }
    } finally {
      if (searchIdRef.current === currentId) {
        setLoading(false);
      }
    }
  };

  // Universal-search deep link: a query issued in Discover lands here pre-filled.
  const appliedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const term = (prefillQuery || '').trim();
    if (!term || appliedPrefillRef.current === term) return;
    appliedPrefillRef.current = term;
    setQuery(term);
    performSearch(term);
  }, [prefillQuery]);

  // Play a track: full-length audio via the YouTube pipeline, 30s preview as fallback
  const playTrack = async (track: MusicTrack, newQueue?: MusicTrack[]) => {
    setCurrentTrack(track);
    if (newQueue) setQueue(newQueue);
    setCurrentTime(0);
    setError('');
    setStreamLoading(true);
    setResolvedStreamUrl(null);
    setIsFullAudio(false);

    try {
      // Full song first — 30-second previews are the fallback, not the feature.
      const full = await OctaveMusicService.resolveFullTrackAudio(track.title, track.artist);
      if (full) {
        setResolvedStreamUrl(full);
        setIsFullAudio(true);
        setIsPlaying(true);
        setStreamLoading(false);
        return;
      }
      const preview = track.previewUrl || await OctaveMusicService.getAudioStreamUrl(track.id, 'high') || null;
      if (preview) {
        setResolvedStreamUrl(preview);
        setIsPlaying(true);
        setError('Full stream unavailable — playing the 30-second preview.');
      } else {
        setError(`Audio stream unavailable for "${track.title}".`);
      }
    } catch {
      setError(`Audio stream unavailable for "${track.title}".`);
    } finally {
      setStreamLoading(false);
    }
  };

  // Audio player handlers
  const togglePlay = () => {
    if (!audioRef.current || !resolvedStreamUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const nextTrack = () => {
    if (!currentTrack || queue.length === 0) return;
    const currentIndex = queue.findIndex((t) => t.id === currentTrack.id);
    const nextIndex = (currentIndex + 1) % queue.length;
    playTrack(queue[nextIndex]);
  };

  const prevTrack = () => {
    if (!currentTrack || queue.length === 0) return;
    if (currentTime > 4 && audioRef.current) {
      audioRef.current.currentTime = 0;
      return;
    }
    const currentIndex = queue.findIndex((t) => t.id === currentTrack.id);
    const prevIndex = (currentIndex - 1 + queue.length) % queue.length;
    playTrack(queue[prevIndex]);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (audioRef.current) {
      audioRef.current.volume = val;
      setMuted(val === 0);
    }
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    const next = !muted;
    setMuted(next);
    audioRef.current.muted = next;
  };

  // Sync MediaSession for Android lock screen controls
  useEffect(() => {
    if (!currentTrack) return;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album || 'Octave Music',
        artwork: currentTrack.coverUrl ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => {
        audioRef.current?.play();
        setIsPlaying(true);
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        audioRef.current?.pause();
        setIsPlaying(false);
      });
      navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && audioRef.current) {
          audioRef.current.currentTime = details.seekTime;
          setCurrentTime(details.seekTime);
        }
      });
    }
  }, [currentTrack, queue]);

  return (
    <div className="music-view" style={{ padding: '1.5rem', maxWidth: '1440px', margin: '0 auto', paddingBottom: currentTrack ? '110px' : '40px' }}>
      <header style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
          <Music2 size={28} color="var(--accent, #f5c518)" />
          <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: 0 }}>Music Streaming</h1>
        </div>
        <p style={{ color: 'var(--muted, #a497c4)', margin: '0 0 1.25rem 0', fontSize: '0.95rem' }}>
          Stream high-fidelity tracks, explore chart toppers, artist discographies, and albums directly inside PRAHA.
        </p>

        {/* Search Bar */}
        <div style={{ display: 'flex', gap: '0.75rem', maxWidth: '650px', marginBottom: '1rem' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && performSearch(query)}
              placeholder="Search tracks, artists, albums…"
              className="text-input"
              style={{
                width: '100%',
                padding: '0.75rem 2.2rem 0.75rem 2.5rem',
                borderRadius: '10px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontSize: '0.95rem',
              }}
            />
            <Search size={18} style={{ position: 'absolute', left: '0.85rem', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setSearchResults(null); }}
                style={{
                  position: 'absolute',
                  right: '0.75rem',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#aaa',
                  cursor: 'pointer',
                  fontSize: '1rem',
                }}
              >
                ×
              </button>
            )}
          </div>
          <button
            className="button button-primary"
            onClick={() => performSearch(query)}
            disabled={loading}
            style={{ padding: '0 1.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem', borderRadius: '10px' }}
          >
            {loading ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}
            Search
          </button>
        </div>

        {/* Trending Genre Pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {TRENDING_GENRES.map((genre) => (
            <button
              key={genre}
              onClick={() => { setQuery(genre); performSearch(genre); }}
              style={{
                background: query === genre ? 'var(--accent, #f5c518)' : 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: query === genre ? '#000' : '#fff',
                padding: '0.35rem 0.85rem',
                borderRadius: '20px',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {genre}
            </button>
          ))}
        </div>
      </header>

      {/* Error State */}
      {error && (
        <div style={{ background: 'rgba(229,9,20,0.1)', border: '1px solid rgba(229,9,20,0.3)', padding: '1rem', borderRadius: '10px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <CircleAlert size={20} color="#e50914" />
          <span style={{ flex: 1, minWidth: '200px' }}>{error}</span>
          {query.trim() && (
            <button
              onClick={() => performSearch(query.trim())}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', border: '1px solid rgba(229,9,20,0.4)', background: 'rgba(229,9,20,0.15)', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}
            >
              Try again
            </button>
          )}
        </div>
      )}

      {/* Search Results Display */}
      {loading ? (
        <SkeletonGrid count={12} label="Searching music database…" />
      ) : searchResults ? (
        <div>
          {/* Tracks Section */}
          {searchResults.tracks.length > 0 && (
            <section style={{ marginBottom: '2.5rem' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Music size={20} color="var(--accent, #f5c518)" /> Tracks ({searchResults.tracks.length})
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
                {searchResults.tracks.map((track) => {
                  const isCurrent = currentTrack?.id === track.id;
                  return (
                    <div
                      key={track.id}
                      onClick={() => playTrack(track, searchResults.tracks)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.85rem',
                        padding: '0.65rem 0.85rem',
                        borderRadius: '10px',
                        background: isCurrent ? 'rgba(var(--accent-rgb, 245, 197, 24), 0.15)' : 'rgba(255,255,255,0.03)',
                        border: isCurrent ? '1px solid var(--accent, #f5c518)' : '1px solid rgba(255,255,255,0.06)',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}
                    >
                      <div style={{ position: 'relative', width: '48px', height: '48px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, background: '#222' }}>
                        {track.coverUrl ? (
                          <img src={track.coverUrl} alt={track.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Disc3 size={24} opacity={0.4} /></div>
                        )}
                        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', opacity: isCurrent ? 1 : 0, transition: 'opacity 0.15s' }}>
                          {isCurrent && isPlaying ? <Pause size={20} color="#fff" /> : <Play size={20} fill="#fff" color="#fff" />}
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: isCurrent ? 'var(--accent, #f5c518)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {track.title}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {track.artist}{track.album ? ` · ${track.album}` : ''}
                        </div>
                      </div>
                      <div style={{ fontSize: '0.78rem', color: '#666', flexShrink: 0 }}>
                        {formatTime(track.duration)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Artists Section */}
          {searchResults.artists.length > 0 && (
            <section style={{ marginBottom: '2.5rem' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Mic2 size={20} color="var(--accent, #f5c518)" /> Artists
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '1rem' }}>
                {searchResults.artists.map((artist) => (
                  <div
                    key={artist.id}
                    onClick={() => { setQuery(artist.name); performSearch(artist.name); }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      textAlign: 'center',
                      padding: '1rem',
                      borderRadius: '12px',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      cursor: 'pointer',
                      transition: 'transform 0.15s',
                    }}
                  >
                    <div style={{ width: '84px', height: '84px', borderRadius: '50%', overflow: 'hidden', marginBottom: '0.65rem', background: '#222' }}>
                      {artist.pictureUrl ? (
                        <img src={artist.pictureUrl} alt={artist.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Mic2 size={32} opacity={0.4} /></div>
                      )}
                    </div>
                    <strong style={{ fontSize: '0.9rem', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                      {artist.name}
                    </strong>
                    {artist.followers ? (
                      <span style={{ fontSize: '0.75rem', color: '#888', marginTop: '2px' }}>
                        {artist.followers.toLocaleString()} fans
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Albums Section */}
          {searchResults.albums.length > 0 && (
            <section style={{ marginBottom: '2.5rem' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Disc3 size={20} color="var(--accent, #f5c518)" /> Albums
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '1rem' }}>
                {searchResults.albums.map((album) => (
                  <div
                    key={album.id}
                    onClick={() => { setQuery(`${album.title} ${album.artist}`); performSearch(`${album.title} ${album.artist}`); }}
                    style={{
                      padding: '0.85rem',
                      borderRadius: '12px',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ width: '100%', aspectRatio: '1/1', borderRadius: '8px', overflow: 'hidden', marginBottom: '0.65rem', background: '#222' }}>
                      {album.coverUrl ? (
                        <img src={album.coverUrl} alt={album.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Disc3 size={36} opacity={0.4} /></div>
                      )}
                    </div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {album.title}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {album.artist}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        /* Featured Playlists & Charts */
        <div>
          {featuredLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem 0', gap: '1rem' }}>
              <LoaderCircle size={36} className="spin" color="var(--accent, #f5c518)" />
              <p style={{ color: '#aaa' }}>Loading featured music playlists…</p>
            </div>
          ) : (
            (Object.entries(featuredSections) as [string, MusicTrack[]][]).map(([sectionTitle, tracks]) => (
              <section key={sectionTitle} style={{ marginBottom: '2.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Sparkles size={18} color="var(--accent, #f5c518)" /> {sectionTitle}
                  </h2>
                  <button
                    onClick={() => { setQueue(tracks); playTrack(tracks[0], tracks); }}
                    className="button button-secondary"
                    style={{ padding: '0.35rem 0.85rem', fontSize: '0.82rem', borderRadius: '16px' }}
                  >
                    <Play size={13} fill="currentColor" /> Play all
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
                  {tracks.map((track) => {
                    const isCurrent = currentTrack?.id === track.id;
                    return (
                      <div
                        key={track.id}
                        onClick={() => playTrack(track, tracks)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.85rem',
                          padding: '0.65rem 0.85rem',
                          borderRadius: '10px',
                          background: isCurrent ? 'rgba(var(--accent-rgb, 245, 197, 24), 0.15)' : 'rgba(255,255,255,0.03)',
                          border: isCurrent ? '1px solid var(--accent, #f5c518)' : '1px solid rgba(255,255,255,0.06)',
                          cursor: 'pointer',
                          transition: 'background 0.15s, transform 0.15s',
                        }}
                      >
                        <div style={{ position: 'relative', width: '48px', height: '48px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, background: '#222' }}>
                          {track.coverUrl ? (
                            <img src={track.coverUrl} alt={track.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Disc3 size={24} opacity={0.4} /></div>
                          )}
                          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', opacity: isCurrent ? 1 : 0 }}>
                            {isCurrent && isPlaying ? <Pause size={20} color="#fff" /> : <Play size={20} fill="#fff" color="#fff" />}
                          </div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: isCurrent ? 'var(--accent, #f5c518)' : '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {track.title}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {track.artist}
                          </div>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#666', flexShrink: 0 }}>
                          {formatTime(track.duration)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {/* Persistent Audio Element */}
      <audio
        ref={audioRef}
        src={resolvedStreamUrl || undefined}
        loop={isLooping}
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
        onEnded={nextTrack}
        onError={() => {
          // Full-length stream failed: fall back to the 30-second preview.
          if (currentTrack?.previewUrl && resolvedStreamUrl !== currentTrack.previewUrl) {
            setResolvedStreamUrl(currentTrack.previewUrl);
            setIsFullAudio(false);
          }
        }}
        autoPlay
      />

      {/* Floating Bottom Music Player Bar */}
      {currentTrack && (
        <div style={{
          position: 'fixed',
          left: '14px',
          right: '14px',
          bottom: 'max(84px, calc(72px + env(safe-area-inset-bottom, 0px)))',
          zIndex: 80,
          background: 'rgba(18, 20, 26, 0.96)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.8)',
          padding: '10px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          {/* Top row: Track info & Controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            {/* Track Info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              <div style={{ width: '42px', height: '42px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, background: '#222' }}>
                {currentTrack.coverUrl ? (
                  <img src={currentTrack.coverUrl} alt={currentTrack.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}><Disc3 size={20} opacity={0.4} /></div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTrack.title}</span>
                  {lyrics && (
                    <div className="music-lyrics" aria-label="Synced lyrics">
                      {(() => {
                        const idx = activeLyricIndex(lyrics, currentTime);
                        const windowLines = lyrics.slice(Math.max(0, idx - 1), idx + 3);
                        return windowLines.map((line, i) => (
                          <p key={`${line.time}-${i}`} className={Math.max(0, idx - 1) + i === idx ? 'active' : ''}>
                            {line.text || '♪'}
                          </p>
                        ));
                      })()}
                    </div>
                  )}
                  {streamLoading ? null : (
                    <span style={{
                      flexShrink: 0,
                      fontSize: '9px',
                      fontWeight: 700,
                      letterSpacing: '0.5px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: isFullAudio ? 'rgba(74, 222, 128, 0.15)' : 'rgba(250, 179, 135, 0.15)',
                      color: isFullAudio ? '#4ade80' : '#fab135',
                    }}>
                      {isFullAudio ? 'FULL' : '30s PREVIEW'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#a497c4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {currentTrack.artist}
                </div>
              </div>
            </div>

            {/* Playback Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={prevTrack}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '6px' }}
                aria-label="Previous track"
              >
                <SkipBack size={18} />
              </button>

              <button
                onClick={togglePlay}
                style={{
                  width: '38px',
                  height: '38px',
                  borderRadius: '50%',
                  background: 'var(--accent, #f5c518)',
                  color: '#000',
                  border: 'none',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                }}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {streamLoading ? (
                  <LoaderCircle size={18} className="spin" />
                ) : isPlaying ? (
                  <Pause size={18} fill="#000" />
                ) : (
                  <Play size={18} fill="#000" />
                )}
              </button>

              <button
                onClick={nextTrack}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '6px' }}
                aria-label="Next track"
              >
                <SkipForward size={18} />
              </button>

              <button
                onClick={() => setIsLooping(!isLooping)}
                style={{ background: 'none', border: 'none', color: isLooping ? 'var(--accent, #f5c518)' : '#777', cursor: 'pointer', padding: '6px' }}
                aria-label="Toggle loop"
              >
                <Repeat size={16} />
              </button>

              <button
                onClick={() => setCurrentTrack(null)}
                style={{ background: 'none', border: 'none', color: '#777', cursor: 'pointer', padding: '6px' }}
                aria-label="Close player"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Bottom row: Scrub bar & Timestamps */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '0.72rem', color: '#777', minWidth: '32px', textAlign: 'right' }}>
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.5}
              value={currentTime}
              onChange={handleSeek}
              style={{
                flex: 1,
                height: '4px',
                accentColor: 'var(--accent, #f5c518)',
                cursor: 'pointer',
              }}
            />
            <span style={{ fontSize: '0.72rem', color: '#777', minWidth: '32px' }}>
              {formatTime(duration)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default MusicView;
