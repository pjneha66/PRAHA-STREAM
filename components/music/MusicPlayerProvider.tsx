import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSyncedLyrics, activeLyricIndex, type LyricLine } from '../../services/lyricsService';
import { OctaveMusicService, type MusicTrack } from '../../services/musicService';

/**
 * SimpMusic-style persistent audio player. Lives at App level so music keeps
 * playing across tabs (the old player died with the Music tab unmount).
 * Owns the single <audio> element, queue state, repeat/shuffle, MediaSession
 * lock-screen controls, and the synced-lyrics feed for the Now Playing sheet.
 */

export type RepeatMode = 'off' | 'all' | 'one';

export interface MusicPlaylist {
  id: string;
  name: string;
  createdAt: number;
  tracks: MusicTrack[];
}

const FAVORITES_KEY = 'praha.music.favorites.v1';
const PLAYLISTS_KEY = 'praha.music.playlists.v1';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* best effort */ }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export interface MusicPlayerValue {
  currentTrack: MusicTrack | null;
  queue: MusicTrack[];
  queueIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  streamLoading: boolean;
  streamError: string;
  isFullAudio: boolean;
  lyrics: LyricLine[] | null;
  activeLyric: number;
  playlists: MusicPlaylist[];
  favorites: MusicTrack[];
  /** Opens Now Playing expanded state. */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  playTrack: (track: MusicTrack, queue?: MusicTrack[]) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  addToQueue: (tracks: MusicTrack | MusicTrack[]) => void;
  removeFromQueue: (index: number) => void;
  playQueueIndex: (index: number) => void;
  clearPlayer: () => void;
  toggleFavorite: (track: MusicTrack) => void;
  isFavorite: (trackId: string) => boolean;
  createPlaylist: (name: string, tracks?: MusicTrack[]) => MusicPlaylist | null;
  addToPlaylist: (playlistId: string, tracks: MusicTrack | MusicTrack[]) => void;
  deletePlaylist: (playlistId: string) => void;
  playPlaylist: (playlist: MusicPlaylist) => void;
}

const MusicPlayerContext = createContext<MusicPlayerValue | null>(null);

export function useMusicPlayer(): MusicPlayerValue {
  const value = useContext(MusicPlayerContext);
  if (!value) throw new Error('useMusicPlayer must be used inside <MusicPlayerProvider>');
  return value;
}

export const MusicPlayerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [queue, setQueue] = useState<MusicTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [shuffle, setShuffle] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [isFullAudio, setIsFullAudio] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>(() => readStored<MusicPlaylist[]>(PLAYLISTS_KEY, []));
  const [favorites, setFavorites] = useState<MusicTrack[]>(() => readStored<MusicTrack[]>(FAVORITES_KEY, []));
  const [activeLyric, setActiveLyric] = useState(-1);
  const streamSeqRef = useRef(0);
  const shuffleHistoryRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    writeStored(PLAYLISTS_KEY, playlists);
  }, [playlists]);
  useEffect(() => {
    writeStored(FAVORITES_KEY, favorites);
  }, [favorites]);

  // Synced lyrics per track.
  useEffect(() => {
    let active = true;
    setLyrics(null);
    setActiveLyric(-1);
    if (currentTrack?.title && currentTrack?.artist) {
      fetchSyncedLyrics({ title: currentTrack.title, artist: currentTrack.artist, duration: currentTrack.duration })
        .then((lines) => { if (active) setLyrics(lines); })
        .catch(() => undefined);
    }
    return () => { active = false; };
  }, [currentTrack?.id]);

  // Track the active lyric line while playing (drives the Now Playing view).
  useEffect(() => {
    if (!lyrics?.length || !isPlaying) return;
    const timer = window.setInterval(() => {
      setActiveLyric(activeLyricIndex(lyrics, audioRef.current?.currentTime ?? 0));
    }, 250);
    return () => window.clearInterval(timer);
  }, [lyrics, isPlaying]);

  /** Loads a resolved stream URL into the audio element. */
  const loadStream = useCallback(async (track: MusicTrack) => {
    const seq = ++streamSeqRef.current;
    setStreamLoading(true);
    setStreamError('');
    setIsFullAudio(false);
    try {
      const full = await OctaveMusicService.resolveFullTrackAudio(track.title, track.artist, track.id);
      if (seq !== streamSeqRef.current) return;
      if (full) {
        setCurrentTime(0);
        setDuration(track.duration || 0);
        setIsFullAudio(true);
        const audio = audioRef.current;
        if (audio) {
          audio.src = full;
          audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
        }
        return;
      }
      setStreamError(`Audio stream unavailable for "${track.title}".`);
      setIsPlaying(false);
    } catch {
      if (seq === streamSeqRef.current) {
        setStreamError(`Audio stream unavailable for "${track.title}".`);
        setIsPlaying(false);
      }
    } finally {
      if (seq === streamSeqRef.current) setStreamLoading(false);
    }
  }, []);

  const playTrack = useCallback((track: MusicTrack, nextQueue?: MusicTrack[]) => {
    setCurrentTrack(track);
    if (nextQueue && nextQueue.length) {
      setQueue(nextQueue);
      setQueueIndex(Math.max(0, nextQueue.findIndex((entry) => entry.id === track.id)));
      shuffleHistoryRef.current = new Set();
    } else {
      setQueue((existing) => {
        if (existing.some((entry) => entry.id === track.id)) {
          setQueueIndex(existing.findIndex((entry) => entry.id === track.id));
          return existing;
        }
        setQueueIndex(existing.length);
        return [...existing, track];
      });
    }
    void loadStream(track);
  }, [loadStream]);

  const playQueueIndex = useCallback((index: number) => {
    if (index < 0 || index >= queue.length) return;
    setQueueIndex(index);
    setCurrentTrack(queue[index]);
    void loadStream(queue[index]);
  }, [queue, loadStream]);

  const advance = useCallback((direction: 1 | -1) => {
    if (!currentTrack || !queue.length) return;
    if (shuffle) {
      const history = shuffleHistoryRef.current;
      history.add(queueIndex);
      const candidates = queue.map((_, index) => index).filter((index) => !history.has(index));
      if (!candidates.length) {
        history.clear();
        shuffleHistoryRef.current.add(queueIndex);
        const fresh = queue.map((_, index) => index).filter((index) => index !== queueIndex);
        const pick = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : queueIndex;
        playQueueIndex(pick);
        return;
      }
      playQueueIndex(candidates[Math.floor(Math.random() * candidates.length)]);
      return;
    }
    const nextIndex = queueIndex + direction;
    if (nextIndex < 0) {
      playQueueIndex(0);
      return;
    }
    if (nextIndex >= queue.length) {
      if (repeat === 'all') {
        playQueueIndex(0);
      } else {
        setIsPlaying(false);
        audioRef.current?.pause();
      }
      return;
    }
    playQueueIndex(nextIndex);
  }, [currentTrack, queue, queueIndex, shuffle, repeat, playQueueIndex]);

  const next = useCallback(() => advance(1), [advance]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 4) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    advance(-1);
  }, [advance]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) {
      audio.play().then(() => setIsPlaying(true)).catch(() => undefined);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((next: number) => {
    setVolumeState(next);
    const audio = audioRef.current;
    if (audio) audio.volume = next;
    setMuted(next === 0);
  }, []);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = !muted;
    setMuted(next);
    audio.muted = next;
  }, [muted]);

  const cycleRepeat = useCallback(() => {
    setRepeat((mode) => (mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'));
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffle((value) => {
      if (!value) shuffleHistoryRef.current = new Set();
      return !value;
    });
  }, []);

  const addToQueue = useCallback((tracks: MusicTrack | MusicTrack[]) => {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    setQueue((existing) => {
      const seen = new Set(existing.map((entry) => entry.id));
      const fresh = list.filter((entry) => !seen.has(entry.id));
      return [...existing, ...fresh];
    });
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setQueue((existing) => existing.filter((_, i) => i !== index));
    if (index === queueIndex) return;
    if (index < queueIndex) setQueueIndex((value) => value - 1);
  }, [queueIndex]);

  const clearPlayer = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setCurrentTrack(null);
    setQueue([]);
    setQueueIndex(-1);
    setIsPlaying(false);
    setSheetOpen(false);
    setStreamError('');
  }, []);

  const toggleFavorite = useCallback((track: MusicTrack) => {
    setFavorites((existing) => {
      if (existing.some((entry) => entry.id === track.id)) {
        return existing.filter((entry) => entry.id !== track.id);
      }
      return [track, ...existing].slice(0, 200);
    });
  }, []);

  const isFavorite = useCallback((trackId: string) => favorites.some((entry) => entry.id === trackId), [favorites]);

  const createPlaylist = useCallback((name: string, tracks?: MusicTrack[]) => {
    const cleanName = name.trim();
    if (!cleanName) return null;
    const playlist: MusicPlaylist = {
      id: `pl-${Date.now()}`,
      name: cleanName,
      createdAt: Date.now(),
      tracks: tracks ? [...tracks] : [],
    };
    setPlaylists((existing) => [...existing, playlist]);
    return playlist;
  }, []);

  const addToPlaylist = useCallback((playlistId: string, tracks: MusicTrack | MusicTrack[]) => {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    setPlaylists((existing) => existing.map((playlist) => {
      if (playlist.id !== playlistId) return playlist;
      const seen = new Set(playlist.tracks.map((entry) => entry.id));
      return { ...playlist, tracks: [...playlist.tracks, ...list.filter((entry) => !seen.has(entry.id))] };
    }));
  }, []);

  const deletePlaylist = useCallback((playlistId: string) => {
    setPlaylists((existing) => existing.filter((playlist) => playlist.id !== playlistId));
  }, []);

  const playPlaylist = useCallback((playlist: MusicPlaylist) => {
    if (!playlist.tracks.length) return;
    playTrack(playlist.tracks[0], playlist.tracks);
  }, [playTrack]);

  // MediaSession: Android lock-screen controls.
  useEffect(() => {
    if (!currentTrack || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album || 'PRAHA Music',
      artwork: currentTrack.coverUrl ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime);
    });
  }, [currentTrack, togglePlay, next, prev, seek]);

  // Loop the current track when repeat is set to one.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.loop = repeat === 'one';
  }, [repeat, currentTrack]);

  const value = useMemo<MusicPlayerValue>(() => ({
    currentTrack,
    queue,
    queueIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    repeat,
    shuffle,
    streamLoading,
    streamError,
    isFullAudio,
    lyrics,
    activeLyric,
    playlists,
    favorites,
    sheetOpen,
    setSheetOpen,
    playTrack,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    cycleRepeat,
    toggleShuffle,
    addToQueue,
    removeFromQueue,
    playQueueIndex,
    clearPlayer,
    toggleFavorite,
    isFavorite,
    createPlaylist,
    addToPlaylist,
    deletePlaylist,
    playPlaylist,
  }), [
    currentTrack, queue, queueIndex, isPlaying, currentTime, duration, volume, muted, repeat, shuffle,
    streamLoading, streamError, isFullAudio, lyrics, activeLyric, playlists, favorites, sheetOpen,
    playTrack, togglePlay, next, prev, seek, setVolume, toggleMute, cycleRepeat, toggleShuffle,
    addToQueue, removeFromQueue, playQueueIndex, clearPlayer, toggleFavorite, isFavorite,
    createPlaylist, addToPlaylist, deletePlaylist, playPlaylist,
  ]);

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
        onEnded={() => advance(1)}
      />
    </MusicPlayerContext.Provider>
  );
};

export { formatTime };
