import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookHeart, CircleAlert, Disc3, Heart, ListMusic, LoaderCircle, Mic2,
  Music2, Pause, Play, Plus, Search, Sparkles, X,
} from 'lucide-react';
import SkeletonGrid from './SkeletonGrid';
import { OctaveMusicService, type MusicTrack, type OctaveSearchData } from '../services/musicService';
import { useMusicPlayer, formatTime, type MusicPlaylist } from './music/MusicPlayerProvider';

const TRENDING_GENRES = [
  'Trending', 'Synthwave', 'Electronic', 'Pop', 'Anime OST',
  'Hip-Hop', 'Lofi & Chill', 'Rock', 'Ambient', 'Bollywood', 'K-Pop',
];

/**
 * Music tab (SimpMusic-style): home rails from the YouTube music surface,
 * search with track/artist results, liked-songs and local playlists. Playback
 * itself lives in the persistent MusicPlayerProvider — leaving this tab never
 * interrupts the song.
 */
const MusicView: React.FC<{ prefillQuery?: string }> = ({ prefillQuery }) => {
  const player = useMusicPlayer();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState<Record<string, MusicTrack[]>>({});
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [searchResults, setSearchResults] = useState<OctaveSearchData | null>(null);
  const [error, setError] = useState('');
  const searchIdRef = useRef(0);

  // Home shelves, fetched once.
  useEffect(() => {
    let active = true;
    setSectionsLoading(true);
    OctaveMusicService.fetchFeaturedSections()
      .then((sectionsResult) => { if (active) setSections(sectionsResult); })
      .catch(() => undefined)
      .finally(() => { if (active) setSectionsLoading(false); });
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
      if (!data.tracks.length && !data.artists.length) {
        setError(`No music results found for "${trimmed}". Try another title or artist.`);
      }
    } catch {
      if (searchIdRef.current === currentId) setError('Failed to search the music catalog.');
    } finally {
      if (searchIdRef.current === currentId) setLoading(false);
    }
  };

  // Universal-search deep link: a query issued in Discover lands here pre-filled.
  const appliedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const term = (prefillQuery || '').trim();
    if (!term || appliedPrefillRef.current === term) return;
    appliedPrefillRef.current = term;
    setQuery(term);
    void performSearch(term);
  }, [prefillQuery]);

  const playTrack = (track: MusicTrack, contextQueue: MusicTrack[]) => {
    player.playTrack(track, contextQueue);
  };

  const isCurrent = (trackId: string) => player.currentTrack?.id === trackId;

  const TrackRow: React.FC<{ track: MusicTrack; contextQueue: MusicTrack[]; showIndex?: boolean; index?: number }> =
  ({ track, contextQueue, showIndex, index }) => {
    const current = isCurrent(track.id);
    return (
      <div className={`music-row ${current ? 'active' : ''}`}>
        {showIndex && <span className="music-row-index">{index !== undefined ? index + 1 : ''}</span>}
        <button type="button" className="music-row-main" onClick={() => playTrack(track, contextQueue)} aria-label={`Play ${track.title}`}>
          <span className="music-row-art">
            {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <Disc3 size={18} />}
            <span className="music-row-hover-icon">{current && player.isPlaying ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}</span>
          </span>
          <span className="music-row-copy">
            <strong className={current ? 'accent' : ''}>{track.title}</strong>
            <small>{track.artist}</small>
          </span>
        </button>
        <button
          type="button"
          className={`music-row-fav ${player.isFavorite(track.id) ? 'active' : ''}`}
          onClick={() => player.toggleFavorite(track)}
          aria-label={player.isFavorite(track.id) ? `Unlike ${track.title}` : `Like ${track.title}`}
          aria-pressed={player.isFavorite(track.id)}
        >
          <Heart size={15} fill={player.isFavorite(track.id) ? 'currentColor' : 'none'} />
        </button>
        <button type="button" className="music-row-queue" onClick={() => player.addToQueue(track)} aria-label={`Add ${track.title} to queue`}>
          <Plus size={15} />
        </button>
        <span className="music-row-duration">{track.duration ? formatTime(track.duration) : ''}</span>
      </div>
    );
  };

  const ArtistCard: React.FC<{ name: string; pictureUrl?: string }> = ({ name, pictureUrl }) => (
    <button
      type="button"
      className="music-artist-card"
      onClick={() => { setQuery(name); void performSearch(name); }}
      aria-label={`Search ${name}`}
    >
      <span className="music-artist-art">
        {pictureUrl ? <img src={pictureUrl} alt="" loading="lazy" /> : <Mic2 size={26} />}
      </span>
      <strong>{name}</strong>
    </button>
  );

  const PlaylistShelf: React.FC = () => {
    const favoritesShelf = useMemo(
      () => (player.favorites.length ? [{ id: 'liked', name: 'Liked Songs', createdAt: 0, tracks: player.favorites } as MusicPlaylist] : []),
      [player.favorites],
    );
    const playlists = [...favoritesShelf, ...player.playlists];
    if (!playlists.length) return null;
    return (
      <div className="music-playlists-rail">
        {playlists.map((playlist) => (
          <div key={playlist.id} className="music-playlist-card">
            <button type="button" className="music-playlist-open" onClick={() => player.playPlaylist(playlist)} aria-label={`Play ${playlist.name}`}>
              <span className="music-playlist-art"><BookHeart size={22} /></span>
              <strong>{playlist.name}</strong>
              <small>{playlist.tracks.length} tracks</small>
            </button>
            {playlist.id !== 'liked' && (
              <button type="button" className="music-playlist-delete" onClick={() => player.deletePlaylist(playlist.id)} aria-label={`Delete ${playlist.name}`}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="standard-page page-enter music-page">
      <div className="music-hero">
        <span className="music-hero-tile" aria-hidden="true"><Music2 size={22} /></span>
        <div>
          <span className="page-kicker">YOUTUBE MUSIC · FULL STREAMS · SYNCED LYRICS</span>
          <h1>Music</h1>
          <p>Full-length streaming with a persistent player, synced lyrics, queue, and playlists — keep the song playing as you browse.</p>
        </div>
      </div>

      <form className="music-search" onSubmit={(event) => { event.preventDefault(); void performSearch(query); }}>
        <div className="music-search-field">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Songs, artists, or moods…"
            aria-label="Search music"
          />
          {query && (
            <button type="button" className="search-clear" aria-label="Clear music search" onClick={() => { setQuery(''); setSearchResults(null); }}>
              ×
            </button>
          )}
        </div>
        <button className="button button-primary button-small" type="submit" disabled={loading}>Search</button>
      </form>

      <div className="music-genre-rail">
        {TRENDING_GENRES.map((genre) => (
          <button
            key={genre}
            type="button"
            className={`music-genre-chip ${query === genre && searchResults ? 'active' : ''}`}
            onClick={() => { setQuery(genre); void performSearch(genre); }}
          >
            {genre}
          </button>
        ))}
      </div>

      {error && (
        <div className="music-error" role="alert">
          <CircleAlert size={15} /> {error}
          {query.trim() && (
            <button onClick={() => void performSearch(query.trim())}>Retry</button>
          )}
        </div>
      )}

      {loading ? (
        <SkeletonGrid count={12} label="Searching music…" />
      ) : searchResults ? (
        <div className="music-results">
          {searchResults.tracks.length > 0 && (
            <section className="music-section">
              <h2><Music2 size={15} /> Tracks ({searchResults.tracks.length})</h2>
              <div className="music-rows">
                {searchResults.tracks.map((track) => (
                  <TrackRow key={track.id} track={track} contextQueue={searchResults.tracks} />
                ))}
              </div>
            </section>
          )}
          {searchResults.artists.length > 0 && (
            <section className="music-section">
              <h2><Mic2 size={15} /> Artists</h2>
              <div className="music-artist-grid">
                {searchResults.artists.map((artist) => (
                  <ArtistCard key={artist.id} name={artist.name} pictureUrl={artist.pictureUrl} />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div className="music-home">
          <PlaylistShelf />

          {sectionsLoading ? (
            <SkeletonGrid count={8} label="Loading shelves…" variant="row" />
          ) : (
            (Object.entries(sections) as Array<[string, MusicTrack[]]>).map(([sectionTitle, tracks]) => (
              <section key={sectionTitle} className="music-section">
                <div className="music-section-head">
                  <h2><Sparkles size={15} /> {sectionTitle}</h2>
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    onClick={() => tracks[0] && playTrack(tracks[0], tracks)}
                  >
                    <Play size={12} fill="currentColor" /> Play all
                  </button>
                </div>
                <div className="music-rail">
                  {tracks.map((track) => (
                    <div key={track.id} className={`music-rail-card ${isCurrent(track.id) ? 'active' : ''}`}>
                      <button type="button" className="music-rail-open" onClick={() => playTrack(track, tracks)} aria-label={`Play ${track.title}`}>
                        <span className="music-rail-art">
                          {track.coverUrl ? <img src={track.coverUrl} alt="" loading="lazy" /> : <Disc3 size={26} />}
                          <span className="music-rail-hover">{isCurrent(track.id) && player.isPlaying ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}</span>
                        </span>
                        <strong title={track.title}>{track.title}</strong>
                        <small>{track.artist}</small>
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {player.currentTrack && !player.sheetOpen && (
        <p className="music-now-playing-hint">
          <ListMusic size={13} /> Playing in background — use the bar below on any tab.
        </p>
      )}
    </div>
  );
};

export default MusicView;
