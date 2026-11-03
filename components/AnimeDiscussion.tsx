import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Heart, LoaderCircle, MessageSquare, RefreshCw } from 'lucide-react';
import { anikuraIds, anikuraService, animeService } from '../services/animeService';
import type { AnikuraComment } from '../services/animeService';
import type { MediaItem } from '../types';

const formatCommentDate = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (diffDays < 1) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

/**
 * Anikura episode discussion. Comments are gathered by Anikura from MyAnimeList
 * forums, Anikoto and Reanime and remain the property of their authors.
 */
const AnimeDiscussion: React.FC<{
  item: MediaItem;
  initialEpisode?: number;
  compact?: boolean;
}> = ({ item, initialEpisode = 1, compact }) => {
  const totalEpisodes = Math.max(
    Number(item.anime?.episodeCount) || 0,
    Number(item.seasons?.[0]?.episodeCount) || 0,
    0,
  );
  const [episode, setEpisode] = useState(Math.max(1, Math.min(initialEpisode, totalEpisodes || initialEpisode)));
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<AnikuraComment[]>([]);
  const [seriesUrl, setSeriesUrl] = useState<string | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [resolvedIds, setResolvedIds] = useState<ReturnType<typeof anikuraIds> | null>(null);
  const [resolving, setAssociating] = useState(false);

  const ids = useMemo(() => anikuraIds(item), [item]);

  useEffect(() => {
    setEpisode(Math.max(1, initialEpisode));
  }, [initialEpisode, item.id]);

  // Resolve an anime id for TMDB / Stremio titles via AniCore's title search.
  useEffect(() => {
    let active = true;
    if (ids.mal || ids.anilist || ids.tmdb || ids.id) {
      setResolvedIds(ids);
      setAssociating(false);
      return () => { active = false; };
    }
    setResolvedIds(null);
    setAssociating(true);
    animeService.findForMedia(item)
      .then((match) => { if (active && match) setResolvedIds(anikuraIds(match)); })
      .catch(() => undefined)
      .finally(() => { if (active) setAssociating(false); });
    return () => { active = false; };
  }, [item, ids]);

  const load = useCallback(async () => {
    if (!resolvedIds) return;
    setLoading(true);
    setError('');
    try {
      const result = await anikuraService.getComments(resolvedIds, episode, { sort: 'top', limit: 12 });
      setComments(result.comments);
      setTotal(result.total);
      setSeriesUrl(result.series?.watch_url || result.series?.url);
      if (!result.comments.length) setError('Anikura has no discussion for this episode yet.');
    } catch (caught) {
      setComments([]);
      setError(caught instanceof Error ? caught.message : 'Anikura did not answer.');
    } finally {
      setLoading(false);
    }
  }, [resolvedIds, episode]);

  useEffect(() => { void load(); }, [load]);

  if (!ids.mal && !ids.anilist && !ids.tmdb && !ids.id && !resolvedIds) {
    return (
      <section className={`anime-discussion ${compact ? 'compact' : ''}`}>
        <div className="anime-discussion-head">
          <h3><MessageSquare size={16} /> Episode discussion</h3>
        </div>
        {resolving ? (
          <p className="anime-discussion-empty"><LoaderCircle size={15} className="spin" /> Matching this title against AniCore…</p>
        ) : (
          <p className="anime-discussion-empty">Anikura needs a MAL, AniList or TMDB id for this title. Open it from the Anime tab to load its discussion.</p>
        )}
      </section>
    );
  }

  return (
    <section className={`anime-discussion ${compact ? 'compact' : ''}`}>
      <div className="anime-discussion-head">
        <h3><MessageSquare size={16} /> Episode discussion</h3>
        <div className="anime-discussion-controls">
          <button onClick={() => setEpisode((current) => Math.max(1, current - 1))} disabled={episode <= 1} aria-label="Previous episode"><ChevronLeft size={15} /></button>
          <span>Episode {episode}</span>
          <button onClick={() => setEpisode((current) => current + 1)} disabled={Boolean(totalEpisodes) && episode >= totalEpisodes} aria-label="Next episode"><ChevronRight size={15} /></button>
          <button onClick={() => void load()} aria-label="Reload discussion" disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>

      {loading ? (
        <p className="anime-discussion-empty"><LoaderCircle size={15} className="spin" /> Loading comments from Anikura…</p>
      ) : comments.length ? (
        <ul className="anime-comment-list">
          {comments.map((comment) => (
            <li key={comment.id}>
              {comment.author?.avatar
                ? <img src={comment.author.avatar} alt="" loading="lazy" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }} />
                : <span className="anime-comment-avatar">{(comment.author?.name || '?').charAt(0).toUpperCase()}</span>}
              <div>
                <div className="anime-comment-meta">
                  <strong>{comment.author?.name || 'Anikura user'}</strong>
                  <span>{formatCommentDate(comment.created_at)}</span>
                  {typeof comment.like_count === 'number' && <span className="anime-comment-likes"><Heart size={11} /> {comment.like_count}</span>}
                  {comment.parent_id && <span className="anime-comment-reply">reply</span>}
                </div>
                <p>{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="anime-discussion-empty">{error || 'No comments yet.'}</p>
      )}

      <div className="anime-discussion-foot">
        <span>{total ? `${total} comment${total === 1 ? '' : 's'} · gathered by Anikura` : 'Powered by Anikura'}</span>
        <a href={seriesUrl || 'https://anikura.club'} target="_blank" rel="noreferrer noopener">
          Open on Anikura <ExternalLink size={12} />
        </a>
      </div>
    </section>
  );
};

export default AnimeDiscussion;
