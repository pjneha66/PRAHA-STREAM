import React from 'react';
import {
  ChevronUp, Disc3, LoaderCircle, Pause, Play, SkipBack, SkipForward, X,
} from 'lucide-react';
import { useMusicPlayer } from './MusicPlayerProvider';

/**
 * Persistent mini player bar (SimpMusic-style): floats above the bottom nav on
 * every tab once a track is loaded. Tap to expand the Now Playing sheet.
 */
const MusicPlayerBar: React.FC<{ hidden?: boolean }> = ({ hidden }) => {
  const player = useMusicPlayer();
  const { currentTrack } = player;
  if (hidden || !currentTrack) return null;

  return (
    <div className="music-bar">
      <button type="button" className="music-bar-main" onClick={() => player.setSheetOpen(true)} aria-label="Open Now Playing">
        <span className="music-bar-art">
          {currentTrack.coverUrl ? (
            <img src={currentTrack.coverUrl} alt="" />
          ) : (
            <Disc3 size={20} />
          )}
        </span>
        <span className="music-bar-copy">
          <strong>{currentTrack.title}</strong>
          <small>{currentTrack.artist}{player.isFullAudio ? '' : ' · preview unavailable'}</small>
        </span>
        {player.streamLoading && <LoaderCircle size={15} className="spin music-bar-spinner" />}
      </button>
      <div className="music-bar-controls">
        <button type="button" className="music-bar-btn" onClick={player.prev} aria-label="Previous track">
          <SkipBack size={17} />
        </button>
        <button
          type="button"
          className="music-bar-btn music-bar-play"
          onClick={player.togglePlay}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
        >
          {player.streamLoading ? <LoaderCircle size={17} className="spin" /> : player.isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button type="button" className="music-bar-btn" onClick={player.next} aria-label="Next track">
          <SkipForward size={17} />
        </button>
      </div>
      <button type="button" className="music-bar-btn music-bar-close" onClick={player.clearPlayer} aria-label="Close player">
        <X size={16} />
      </button>
      <button type="button" className="music-bar-expand" onClick={() => player.setSheetOpen(true)} aria-label="Expand player">
        <ChevronUp size={14} />
      </button>
      <div className="music-bar-progress" aria-hidden="true">
        <span style={{ width: `${player.duration ? Math.min(100, (player.currentTime / player.duration) * 100) : 0}%` }} />
      </div>
    </div>
  );
};

export default MusicPlayerBar;
