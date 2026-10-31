import React, { useEffect, useMemo, useState } from 'react';
import {
  Blocks, Check, Clapperboard, Film, LoaderCircle, Play, Plus, Star, Tv, Users, X,
} from 'lucide-react';
import { tmdbService } from '../services/tmdbService';
import type { LibraryStatus, MediaItem, TmdbEpisodeInfo, WatchProgress } from '../types';
import { Artwork, MediaCard } from './MediaCard';

const STATUS_OPTIONS: Array<{ value: LibraryStatus; label: string }> = [
  { value: 'watching', label: 'Watching' },
  { value: 'plan', label: 'Plan to Watch' },
  { value: 'hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'dropped', label: 'Dropped' },
];

const DetailsModal: React.FC<{
  item: MediaItem;
  watchlist: MediaItem[];
  history: WatchProgress[];
  onClose: () => void;
  onPlay: (item: MediaItem, season?: number, episode?: number, episodeTitle?: string) => void;
  onSelectRecommendation: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem, status?: LibraryStatus) => void;
  onUpdateStatus: (item: MediaItem, status: LibraryStatus) => void;
  inWatchlist: boolean;
}> = ({
  item,
  watchlist,
  history,
  onClose,
  onPlay,
  onSelectRecommendation,
  onToggleWatchlist,
  onUpdateStatus,
  inWatchlist,
}) => {
  const [showTrailer, setShowTrailer] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [episodes, setEpisodes] = useState<TmdbEpisodeInfo[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);

  const savedEntry = useMemo(
    () => watchlist.find((entry) => entry.id === item.id),
    [watchlist, item.id],
  );

  const savedProgress = useMemo(
    () => history.find((entry) => entry.media.id === item.id),
    [history, item.id],
  );

  useEffect(() => {
    setShowTrailer(false);
    if (savedProgress?.season) setSelectedSeason(savedProgress.season);
    else if (item.seasons?.length) setSelectedSeason(item.seasons[0].seasonNumber);
    else setSelectedSeason(1);
  }, [item.id, savedProgress?.season, item.seasons]);

  useEffect(() => {
    if (item.type !== 'series' || !item.tmdbId) {
      setEpisodes([]);
      return;
    }
    let active = true;
    setEpisodesLoading(true);
    tmdbService.getSeason(item.tmdbId, selectedSeason)
      .then((list) => { if (active) setEpisodes(list); })
      .catch(() => { if (active) setEpisodes([]); })
      .finally(() => { if (active) setEpisodesLoading(false); });
    return () => { active = false; };
  }, [item.id, item.type, item.tmdbId, selectedSeason]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  const seasonNumbers = useMemo(() => {
    if (item.seasons?.length) return item.seasons;
    const total = item.numberOfSeasons || (item.type === 'series' ? 1 : 0);
    return Array.from({ length: total }, (_, idx) => ({
      id: idx + 1,
      seasonNumber: idx + 1,
      name: `Season ${idx + 1}`,
      episodeCount: 0,
    }));
  }, [item.seasons, item.numberOfSeasons, item.type]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="details-modal details-modal-rich" role="dialog" aria-modal="true" aria-label={item.title}>
        <button className="modal-close floating" onClick={onClose} aria-label="Close details"><X size={20} /></button>

        <div className="details-backdrop">
          {showTrailer && item.trailerKey ? (
            <iframe
              className="details-trailer-frame"
              src={`https://www.youtube.com/embed/${item.trailerKey}?autoplay=1&rel=0`}
              title={item.trailerName || `${item.title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <Artwork src={item.backdrop || item.poster} alt="" />
          )}
          <div />
        </div>

        <div className="details-body">
          <div className="details-poster"><Artwork src={item.poster} alt={item.title} /></div>
          <div className="details-copy">
            <span className="details-kicker">
              {item.source === 'stremio' ? 'FROM YOUR ADDON' : item.type === 'movie' ? 'FEATURE FILM' : 'SERIES'}
            </span>
            <h2>{item.title}</h2>
            <div className="details-meta">
              {item.rating && <span className="hero-rating"><Star size={13} fill="currentColor" />{item.rating.toFixed(1)}</span>}
              <span>{item.year || '—'}</span>
              {item.runtime && <><i /><span>{item.runtime}</span></>}
              {item.maturity && <span className="maturity-badge">{item.maturity}</span>}
              {item.director && <><i /><span>By {item.director}</span></>}
            </div>

            {item.genres.length > 0 && (
              <div className="genre-list">{item.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
            )}

            <p className="details-overview">{item.overview || 'No description is available for this title yet.'}</p>

            <div className="details-actions">
              <button
                className="button button-primary"
                onClick={() => onPlay(
                  item,
                  item.type === 'series' ? (savedProgress?.season || selectedSeason) : undefined,
                  item.type === 'series' ? (savedProgress?.episode || 1) : undefined,
                  savedProgress?.episodeTitle,
                )}
              >
                <Play size={18} fill="currentColor" />
                {savedProgress && savedProgress.progress > 2
                  ? (item.type === 'series'
                    ? `Resume S${savedProgress.season || 1} E${savedProgress.episode || 1}`
                    : `Resume (${Math.round(savedProgress.progress)}%)`)
                  : 'Find sources'}
              </button>

              {item.trailerKey && (
                <button className="button button-secondary" onClick={() => setShowTrailer((prev) => !prev)}>
                  <Clapperboard size={18} /> {showTrailer ? 'Hide trailer' : 'Watch trailer'}
                </button>
              )}

              <button
                className={`button button-secondary ${inWatchlist ? 'is-saved' : ''}`}
                onClick={() => onToggleWatchlist(item, 'plan')}
              >
                {inWatchlist ? <Check size={18} /> : <Plus size={18} />}
                {inWatchlist ? 'In library' : 'Add to library'}
              </button>

              <select
                className="details-status-select"
                aria-label="Library status"
                value={savedEntry?.libraryStatus || (inWatchlist ? 'watching' : '')}
                onChange={(event) => {
                  const next = event.target.value as LibraryStatus;
                  if (next) onUpdateStatus(item, next);
                }}
              >
                <option value="" disabled>List status…</option>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="details-source-note">
              <Blocks size={15} />
              <span>Streams & subtitles are fetched live from your Stremio addons and Nuvio plugins.</span>
            </div>
          </div>
        </div>

        {item.type === 'series' && item.tmdbId && seasonNumbers.length > 0 && (
          <section className="details-section">
            <div className="details-section-head">
              <h3><Tv size={17} /> Seasons & Episodes</h3>
              <div className="season-tabs">
                {seasonNumbers.map((season) => (
                  <button
                    key={season.seasonNumber}
                    className={selectedSeason === season.seasonNumber ? 'active' : ''}
                    onClick={() => setSelectedSeason(season.seasonNumber)}
                  >
                    {season.name}{season.episodeCount ? ` (${season.episodeCount})` : ''}
                  </button>
                ))}
              </div>
            </div>

            {episodesLoading ? (
              <div className="details-episodes-loading">
                <LoaderCircle size={18} className="spin" /> Loading Season {selectedSeason} episodes…
              </div>
            ) : episodes.length > 0 ? (
              <div className="details-episode-list">
                {episodes.map((ep) => {
                  const epHistory = history.find(
                    (h) => h.media.id === item.id && h.season === selectedSeason && h.episode === ep.episode,
                  );
                  return (
                    <article key={ep.id} className="details-episode-card">
                      <button
                        className="details-episode-thumb"
                        onClick={() => onPlay(item, selectedSeason, ep.episode, ep.title)}
                        aria-label={`Play S${selectedSeason} E${ep.episode} ${ep.title}`}
                      >
                        <Artwork src={ep.still || item.backdrop || item.poster} alt={ep.title} />
                        <span className="ep-play-badge"><Play size={15} fill="currentColor" /></span>
                        {epHistory && (
                          <span className="ep-progress"><i style={{ width: `${Math.min(100, epHistory.progress)}%` }} /></span>
                        )}
                      </button>
                      <div className="details-episode-info">
                        <div className="details-episode-top">
                          <strong>{ep.episode}. {ep.title}</strong>
                          <span>
                            {ep.runtime ? `${ep.runtime}m` : ''}
                            {ep.airDate ? ` · ${ep.airDate}` : ''}
                            {ep.rating ? ` · ★ ${ep.rating}` : ''}
                          </span>
                        </div>
                        <p>{ep.overview || 'Tap to search available sources for this episode.'}</p>
                      </div>
                      <button
                        className="button button-small button-secondary"
                        onClick={() => onPlay(item, selectedSeason, ep.episode, ep.title)}
                      >
                        <Play size={13} fill="currentColor" /> Play
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </section>
        )}

        {item.cast && item.cast.length > 0 && (
          <section className="details-section">
            <div className="details-section-head">
              <h3><Users size={17} /> Cast</h3>
            </div>
            <div className="details-cast-row">
              {item.cast.map((actor) => (
                <div className="cast-chip" key={actor.id}>
                  <div className="cast-avatar"><Artwork src={actor.profile} alt={actor.name} /></div>
                  <div>
                    <strong>{actor.name}</strong>
                    {actor.character && <span>{actor.character}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {item.recommendations && item.recommendations.length > 0 && (
          <section className="details-section">
            <div className="details-section-head">
              <h3><Film size={17} /> More like this</h3>
            </div>
            <div className="details-rec-grid">
              {item.recommendations.slice(0, 6).map((rec) => (
                <MediaCard
                  key={rec.id}
                  item={rec}
                  onSelect={onSelectRecommendation}
                  onToggleWatchlist={onToggleWatchlist}
                  inWatchlist={watchlist.some((w) => w.id === rec.id)}
                  compact
                />
              ))}
            </div>
          </section>
        )}
      </section>
    </div>
  );
};

export default DetailsModal;
