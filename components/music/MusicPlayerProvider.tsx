import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLyrics, activeLyricIndex, type LyricsData, type SyncedLyricLine } from '../../services/music/lyricsService';
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
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  streamLoading: boolean;
  streamError: string;
  isFullAudio: boolean;
  /** Synced lines when lrclib has them, otherwise empty. */
  lyrics: SyncedLyricLine[] | null;
  /** Unsynced text, when lrclib only knows the song as plain lyrics. */
  plainLyrics: string;
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

/**
 * Playback position lives in its own context: the audio element emits ~5
 * timeupdate events per second, and if those flowed through the main value,
 * every screen subscribed to the player (Music tab grids, shelf cards) would
 * re-render 5×/s. Only the seek bars / progress / lyrics consume this.
 */
export interface MusicPositionValue {
  currentTime: number;
  duration: number;
  activeLyric: number;
}

const MusicPositionContext = createContext<MusicPositionValue>({ currentTime: 0, duration: 0, activeLyric: -1 });

export function useMusicPosition(): MusicPositionValue {
  return useContext(MusicPositionContext);
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
  const [lyrics, setLyrics] = useState<SyncedLyricLine[] | null>(null);
  const [plainLyrics, setPlainLyrics] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>(() => readStored<MusicPlaylist[]>(PLAYLISTS_KEY, []));
  const [favorites, setFavorites] = useState<MusicTrack[]>(() => readStored<MusicTrack[]>(FAVORITES_KEY, []));
  const [activeLyric, setActiveLyric] = useState(-1);
  const streamSeqRef = useRef(0);
  /** Fresh addresses asked for after the current song broke. Port of `_retries`. */
  const streamRetriesRef = useRef(0);
  const shuffleHistoryRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    writeStored(PLAYLISTS_KEY, playlists);
  }, [playlists]);
  useEffect(() => {
    writeStored(FAVORITES_KEY, favorites);
  }, [favorites]);

  // Lyrics per track: synced lines when lrclib has them, otherwise plain text.
  useEffect(() => {
    let active = true;
    setLyrics(null);
    setPlainLyrics('');
    setActiveLyric(-1);
    if (currentTrack?.title && currentTrack?.artist) {
      fetchLyrics({
        id: currentTrack.id,
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        duration: currentTrack.duration,
      })
        .then((data: LyricsData) => {
          if (!active) return;
          setLyrics(data.isSynced && data.syncedLines.length ? data.syncedLines : null);
          setPlainLyrics(data.plainLyrics);
        })
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
    streamRetriesRef.current = 0;
    setStreamLoading(true);
    setStreamError('');
    setIsFullAudio(false);
    const startAudio = (url: string, attempt: number) => {
      const audio = audioRef.current;
      if (audio) {
        audio.src = url;
        // `isPlaying` is driven by the element's own play/pause events (see the
        // <audio> handlers). A rejected promise here only means this attempt did
        // not start, so it must not report a decision about the track — and it
        // must not touch state at all once a newer attempt owns the element,
        // which is what used to leave the bar showing Play over a song that was
        // already streaming.
        audio.play().catch(() => {
          if (attempt === streamSeqRef.current) setIsPlaying(false);
        });
      }
    };
    try {
      // The VyseTV chain already ends in the Deezer preview, so a resolved
      // stream is whatever quality is available rather than "full or nothing".
      const resolved = await OctaveMusicService.resolveTrack(track);
      if (seq !== streamSeqRef.current) return;
      if (resolved?.url) {
        setCurrentTime(0);
        setDuration(track.duration || 0);
        const isPreview = resolved.sourceUrl === track.previewUrl;
        setIsFullAudio(!isPreview);
        startAudio(resolved.url, seq);
        if (isPreview) {
          setDuration(0);
          setStreamError('Playing a preview. Full stream unavailable.');
        }
        return;
      }
      const rateLimited = OctaveMusicService.rateLimitMessage;
      if (rateLimited) {
        setStreamError(rateLimited);
      } else {
        setStreamError(`Audio stream unavailable for "${track.title}".`);
      }
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

  /**
   * A stream that broke mid-play: the URL was refused (403, expired edge) or
   * the element gave up. Port of `_trouble`: ask for a fresh address and carry
   * on from the same second — twice for a song that had started, once for one
   * that never did. After that, drop to the preview rather than stop dead.
   */
  const recoverStream = useCallback(async (track: MusicTrack, resumeAt: number) => {
    const started = resumeAt > 0;
    const budget = started ? 2 : 1;
    if (streamRetriesRef.current >= budget) {
      // Out of fresh addresses. A preview still plays something — but only
      // once: if the preview itself is what failed, there is nothing left.
      const audio = audioRef.current;
      const onPreview = audio?.src === track.previewUrl;
      if (track.previewUrl && audio && !onPreview) {
        setIsFullAudio(false);
        setDuration(0);
        setStreamError('Stream ended early. Playing a preview.');
        audio.src = track.previewUrl;
        audio.currentTime = 0;
        audio.play().catch(() => {
          // The element reports the real result through its own events.
        });
        return;
      }
      setStreamError(`Audio stream unavailable for "${track.title}".`);
      setIsPlaying(false);
      return;
    }

    streamRetriesRef.current += 1;
    // The address we were given is dead; do not let the cache hand it back.
    OctaveMusicService.forgetStreamUrl(track.id);

    const seq = ++streamSeqRef.current;
    setStreamLoading(true);
    try {
      const resolved = await OctaveMusicService.resolveTrack(track);
      if (seq !== streamSeqRef.current) return;
      const audio = audioRef.current;
      if (resolved?.url && audio) {
        const isPreview = resolved.sourceUrl === track.previewUrl;
        setIsFullAudio(!isPreview);
        setDuration(isPreview ? 0 : track.duration || 0);
        setStreamError(isPreview ? 'Playing a preview. Full stream unavailable.' : '');
        audio.src = resolved.url;
        // Resume only within full audio: a preview starts at its own beginning,
        // since the second we broke at does not exist in a 30 s clip.
        if (resumeAt > 0 && !isPreview) {
          // Seek once the new source knows its duration.
          const resume = () => {
            audio.currentTime = Math.min(resumeAt, Math.max(0, (audio.duration || resumeAt) - 0.5));
            audio.removeEventListener('loadedmetadata', resume);
          };
          audio.addEventListener('loadedmetadata', resume);
        }
        audio.play().catch(() => {
          if (seq === streamSeqRef.current) setIsPlaying(false);
        });
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
    if (audio) {
      audio.volume = next;
      audio.muted = next === 0;
    }
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
    const nextQueue = queue.filter((_, i) => i !== index);
    setQueue(nextQueue);
    if (index < queueIndex) {
      setQueueIndex(queueIndex - 1);
      return;
    }
    if (index > queueIndex) return;
    // The currently playing item was removed: stop it and load the item that
    // shifted into its place (or clear the player when the queue is empty).
    if (!nextQueue.length) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      setCurrentTrack(null);
      setQueueIndex(-1);
      setIsPlaying(false);
      return;
    }
    const newIndex = Math.min(index, nextQueue.length - 1);
    const nextTrack = nextQueue[newIndex];
    setQueueIndex(newIndex);
    setCurrentTrack(nextTrack);
    void loadStream(nextTrack);
  }, [queue, queueIndex, loadStream]);

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
    volume,
    muted,
    repeat,
    shuffle,
    streamLoading,
    streamError,
    isFullAudio,
    lyrics,
    plainLyrics,
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
    currentTrack, queue, queueIndex, isPlaying, volume, muted, repeat, shuffle,
    streamLoading, streamError, isFullAudio, lyrics, playlists, favorites, sheetOpen,
    playTrack, togglePlay, next, prev, seek, setVolume, toggleMute, cycleRepeat, toggleShuffle,
    addToQueue, removeFromQueue, playQueueIndex, clearPlayer, toggleFavorite, isFavorite,
    createPlaylist, addToPlaylist, deletePlaylist, playPlaylist,
  ]);

  const positionValue = useMemo<MusicPositionValue>(
    () => ({ currentTime, duration, activeLyric }),
    [currentTime, duration, activeLyric],
  );

  return (
    <MusicPlayerContext.Provider value={value}>
      <MusicPositionContext.Provider value={positionValue}>
        {children}
        <audio
          ref={audioRef}
          onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
          onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
          onEnded={() => advance(1)}
          // The element is the authority on whether it is playing. Without
          // these two, `isPlaying` only ever changed through the `play()`
          // promise chains above, so a stream that started on its own — an
          // autoplay, a MediaSession command, a source swap that resumed — left
          // the bar showing Play over a song that was already audible, until
          // some later action re-derived the flag.
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onError={() => {
            // The address died mid-play (403, expired signature, edge gone).
            // Re-resolve from the same second before giving up on full audio.
            const track = currentTrack;
            if (!track) return;
            const at = audioRef.current?.currentTime ?? 0;
            void recoverStream(track, at);
          }}
        />
      </MusicPositionContext.Provider>
    </MusicPlayerContext.Provider>
  );
};

export { formatTime };
