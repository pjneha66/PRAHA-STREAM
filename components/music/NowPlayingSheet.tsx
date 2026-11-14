import React, { useState } from 'react';
import {
  ChevronDown, Disc3, ListMusic, LoaderCircle, Mic2, Music2, Pause, Play,
  Repeat, Repeat1, ScrollText, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X,
} from 'lucide-react';
import { useMusicPlayer, formatTime, type MusicPlaylist } from './MusicPlayerProvider';

/**
 * Full-screen Now Playing sheet (SimpMusic-style): big artwork, seek bar,
 * full synced-lyrics view with active-line highlight and tap-to-seek, and a
 * queue manager. Opened from the mini player bar.
 */
const NowPlayingSheet: React.FC = () => {
  const player = useMusicPlayer();
  const [tab, setTab] = useState<'player' | 'lyrics' | 'queue'>('player');
  const [playlistName, setPlaylistName] = useState('');
  const { currentTrack } = player;
  if (!player.sheetOpen || !currentTrack) return null;

  return (
    <div
      className="modal-backdrop music-sheet-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && player.setSheetOpen(false)}
    >
      <section className="music-sheet" role="dialog" aria-modal="true" aria-label="Now Playing">
        <header className="music-sheet-header">
          <button type="button" className="icon-button" onClick={() => player.setSheetOpen(false)} aria-label="Minimize player">
            <ChevronDown size={18} />
          </button>
          <span className="page-kicker">NOW PLAYING · {player.isFullAudio ? 'FULL STREAM' : 'QUEUE'}</span>
          <button type="button" className="icon-button" onClick={player.clearPlayer} aria-label="Close player">
            <X size={18} />
          </button>
        </header>

        <div className="music-sheet-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'player'} className={tab === 'player' ? 'active' : ''} onClick={() => setTab('player')}>
            <Music2 size={13} /> Player
          </button>
          <button type="button" role="tab" aria-selected={tab === 'lyrics'} className={tab === 'lyrics' ? 'active' : ''} onClick={() => setTab('lyrics')} disabled={!player.lyrics}>
            <ScrollText size={13} /> Lyrics
          </button>
          <button type="button" role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>
            <ListMusic size={13} /> Queue ({player.queue.length})
          </button>
        </div>

        {tab === 'player' && (
          <div className="music-sheet-body">
            <div className="music-sheet-art">
              {currentTrack.coverUrl ? (
                <img src={currentTrack.coverUrl} alt={currentTrack.title} />
              ) : (
                <Disc3 size={72} />
              )}
            </div>
            <div className="music-sheet-meta">
              <h2>{currentTrack.title}</h2>
              <p>{currentTrack.artist}{currentTrack.album ? ` · ${currentTrack.album}` : ''}</p>
            </div>

            {player.streamError && <p className="music-sheet-error" role="alert">{player.streamError}</p>}

            <div className="music-sheet-seek">
              <span>{formatTime(player.currentTime)}</span>
              <input
                type="range"
                min={0}
                max={player.duration || 100}
                step={0.5}
                value={Math.min(player.currentTime, player.duration || 100)}
                onChange={(event) => player.seek(Number(event.target.value))}
                aria-label="Seek"
              />
              <span>{formatTime(player.duration)}</span>
            </div>

            <div className="music-sheet-controls">
              <button type="button" className="music-sheet-side-btn" onClick={player.toggleShuffle} aria-label="Toggle shuffle" aria-pressed={player.shuffle}>
                <Shuffle size={17} />
              </button>
              <button type="button" className="music-sheet-btn" onClick={player.prev} aria-label="Previous track">
                <SkipBack size={20} fill="currentColor" />
              </button>
              <button
                type="button"
                className="music-sheet-play"
                onClick={player.togglePlay}
                aria-label={player.isPlaying ? 'Pause' : 'Play'}
              >
                {player.streamLoading ? <LoaderCircle size={24} className="spin" /> : player.isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
              </button>
              <button type="button" className="music-sheet-btn" onClick={player.next} aria-label="Next track">
                <SkipForward size={20} fill="currentColor" />
              </button>
              <button type="button" className="music-sheet-side-btn" onClick={player.cycleRepeat} aria-label="Toggle repeat" aria-pressed={player.repeat !== 'off'}>
                {player.repeat === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
              </button>
            </div>

            <div className="music-sheet-volume">
              <button type="button" className="music-sheet-side-btn" onClick={player.toggleMute} aria-label="Toggle mute">
                {player.muted || player.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={player.muted ? 0 : player.volume}
                onChange={(event) => player.setVolume(Number(event.target.value))}
                aria-label="Volume"
              />
            </div>
          </div>
        )}

        {tab === 'lyrics' && (
          <div className="music-lyrics-view">
            {player.lyrics?.length ? player.lyrics.map((line, index) => (
              <button
                key={`${line.time}-${index}`}
                type="button"
                className={`music-lyric-line ${index === player.activeLyric ? 'active' : ''}`}
                onClick={() => player.seek(line.time)}
              >
                {line.text || '♪'}
              </button>
            )) : (
              <p className="music-lyrics-empty"><Mic2 size={22} /> No synced lyrics found for this track.</p>
            )}
          </div>
        )}

        {tab === 'queue' && (
          <div className="music-queue-view">
            <div className="music-queue-actions">
              <input
                value={playlistName}
                onChange={(event) => setPlaylistName(event.target.value)}
                placeholder="Save queue as playlist…"
                aria-label="Playlist name"
              />
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={!playlistName.trim() || !player.queue.length}
                onClick={() => {
                  const created = player.createPlaylist(playlistName, player.queue);
                  if (created) setPlaylistName('');
                }}
              >
                Save
              </button>
            </div>
            {player.queue.map((track, index) => (
              <div key={`${track.id}-${index}`} className={`music-queue-row ${index === player.queueIndex ? 'active' : ''}`}>
                <button type="button" className="music-queue-main" onClick={() => player.playQueueIndex(index)}>
                  <span className="music-queue-index">{index === player.queueIndex && player.isPlaying ? <LoaderCircle size={13} className="spin" /> : index + 1}</span>
                  <span className="music-queue-copy">
                    <strong>{track.title}</strong>
                    <small>{track.artist}</small>
                  </span>
                  <span className="music-queue-duration">{track.duration ? formatTime(track.duration) : ''}</span>
                </button>
                <button type="button" className="music-queue-remove" onClick={() => player.removeFromQueue(index)} aria-label={`Remove ${track.title} from queue`}>
                  <X size={14} />
                </button>
              </div>
            ))}
            {!player.queue.length && <p className="music-lyrics-empty"><ListMusic size={22} /> Queue is empty.</p>}
          </div>
        )}

        <footer className="music-sheet-playlists">
          <span className="music-sheet-playlists-label"><Disc3 size={13} /> Playlists</span>
          <div className="music-sheet-playlist-row">
            {player.playlists.slice(0, 6).map((playlist: MusicPlaylist) => (
              <button
                key={playlist.id}
                type="button"
                className="music-playlist-chip"
                onClick={() => player.playPlaylist(playlist)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  player.deletePlaylist(playlist.id);
                }}
                title={`${playlist.name} · ${playlist.tracks.length} tracks (long-press/right-click to delete)`}
              >
                <Music2 size={12} /> {playlist.name}
              </button>
            ))}
            {!player.playlists.length && <span className="music-playlists-empty">Save the queue as a playlist to keep it here.</span>}
            {player.playlists.length > 6 && <span className="music-playlists-empty">+{player.playlists.length - 6} more</span>}
          </div>
        </footer>
      </section>
    </div>
  );
};

export default NowPlayingSheet;
