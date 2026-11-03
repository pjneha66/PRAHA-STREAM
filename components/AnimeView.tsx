import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, BookOpen, Check, ChevronDown, CircleAlert, ExternalLink, LoaderCircle, MessageSquare,
  Play, Plus, RefreshCw, RotateCcw, Sparkles, Star, Tv,
} from 'lucide-react';
import { ANICORE_SITE, ANIKURA_SITE, ANIME_FORMATS, ANIME_GENRES, SEASON_LABEL, animeService, anikuraIds, anikuraService, currentAnimeSeason } from '../services/animeService';
import { IMDX_DOCS_URL, imdxService } from '../services/imdxService';
import type { AnikuraComment } from '../services/animeService';
import type { ImdxSettings, MediaItem } from '../types';
import { Artwork, MediaCard, MediaRow } from './MediaCard';
import AnimeDiscussion from './AnimeDiscussion';

type FormatFilter = 'ALL' | (typeof ANIME_FORMATS)[number];
type SortOption = 'trending' | 'score' | 'newest' | 'popularity';

const FORMAT_TABS: Array<{ id: FormatFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'TV', label: 'TV' },
  { id: 'MOVIE', label: 'Movies' },
  { id: 'OVA', label: 'OVA' },
  { id: 'ONA', label: 'ONA' },
  { id: 'SPECIAL', label: 'Specials' },
];

const SORT_OPTIONS: Array<{ id: SortOption; label: string }> = [
  { id: 'trending', label: 'Trending' },
  { id: 'score', label: 'Highest rated' },
  { id: 'popularity', label: 'Most popular' },
  { id: 'newest', label: 'Newest' },
];

const MIN_SCORE_OPTIONS = [
  { value: 0, label: 'Any score' },
  { value: 70, label: '7.0+ ★' },
  { value: 80, label: '8.0+ ★' },
  { value: 85, label: '8.5+ ★' },
];

interface AnimeRows {
  trending: MediaItem[];
  topRated: MediaItem[];
  season: MediaItem[];
  airing: MediaItem[];
  movies: MediaItem[];
}

const EMPTY_ROWS: AnimeRows = { trending: [], topRated: [], season: [], airing: [], movies: [] };

const AnimeView: React.FC<{
  query: string;
  watchlist: MediaItem[];
  compact: boolean;
  imdx: ImdxSettings;
  onSelect: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onEmbeddedPlayers: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onOpenSettings: () => void;
  onClearSearch: () => void;
}> = ({
  query, watchlist, compact, imdx, onSelect, onPlay, onEmbeddedPlayers, onToggleWatchlist, onOpenSettings, onClearSearch,
}) => {
  const season = useMemo(() => currentAnimeSeason(), []);
  const [rows, setRows] = useState<AnimeRows>(EMPTY_ROWS);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [rowsError, setRowsError] = useState('');

  const [format, setFormat] = useState<FormatFilter>('ALL');
  const [sort, setSort] = useState<SortOption>('trending');
  const [minScore, setMinScore] = useState(0);
  const [genre, setGenre] = useState('all');

  const [grid, setGrid] = useState<MediaItem[]>([]);
  const [gridPage, setGridPage] = useState(1);
  const [gridHasMore, setGridHasMore] = useState(false);
  const [gridLoading, setGridLoading] = useState(true);
  const [gridLoadingMore, setGridLoadingMore] = useState(false);
  const [gridError, setGridError] = useState('');

  const [searchResults, setSearchResults] = useState<MediaItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [imdxNotice, setImdxNotice] = useState('');

  const [spotlightComments, setSpotlightComments] = useState<AnikuraComment[]>([]);
  const [spotlightLoading, setSpotlightLoading] = useState(false);

  const trimmedQuery = query.trim();
  const imdxEnabled = Boolean(imdx?.enabled);
  const featured = rows.trending[0];

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    setRowsError('');
    const results = await Promise.allSettled([
      animeService.trending(20),
      animeService.topRated(20),
      animeService.thisSeason(20, new Date()),
      animeService.airing(20),
      animeService.movies(20),
    ]);
    const pick = (index: number) => results[index].status === 'fulfilled'
      ? (results[index] as PromiseFulfilledResult<MediaItem[]>).value
      : [];
    const nextRows: AnimeRows = {
      trending: pick(0),
      topRated: pick(1),
      season: pick(2),
      airing: pick(3),
      movies: pick(4),
    };
    setRows(nextRows);
    setRowsLoading(false);
    const failed = results.filter((entry) => entry.status === 'rejected');
    if (failed.length === results.length) {
      const first = failed[0] as PromiseRejectedResult;
      setRowsError(first.reason instanceof Error ? first.reason.message : 'AniCore did not answer.');
    } else if (failed.length && !nextRows.trending.length) {
      setRowsError('Some anime rows could not be loaded. Pull to retry.');
    }
  }, []);

  useEffect(() => { void loadRows(); }, [loadRows]);

  const loadGrid = useCallback(async (page: number, append: boolean) => {
    if (append) setGridLoadingMore(true);
    else {
      setGridLoading(true);
      setGridError('');
    }
    try {
      const result = await animeService.browse({
        page,
        perPage: 30,
        sort,
        format: format === 'ALL' ? undefined : format,
        minScore: minScore || undefined,
      });
      setGrid((current) => (append ? [...current, ...result.items] : result.items));
      setGridPage(page);
      setGridHasMore(result.hasMore);
    } catch (error) {
      if (!append) setGrid([]);
      setGridHasMore(false);
      setGridError(error instanceof Error ? error.message : 'AniCore did not answer.');
    } finally {
      setGridLoading(false);
      setGridLoadingMore(false);
    }
  }, [sort, format, minScore]);

  useEffect(() => { void loadGrid(1, false); }, [loadGrid]);

  // Search runs across AniCore plus the optional IMDx (Tiffara) index.
  useEffect(() => {
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearchError('');
      setImdxNotice('');
      setSearchLoading(false);
      return;
    }
    let active = true;
    setSearchLoading(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      const [anicoreResult, imdxResult] = await Promise.allSettled([
        animeService.search(trimmedQuery, 1, 30),
        imdxEnabled ? imdxService.search(trimmedQuery, imdx) : Promise.resolve([] as MediaItem[]),
      ]);
      if (!active) return;
      const animeItems = anicoreResult.status === 'fulfilled' ? anicoreResult.value.items : [];
      const imdxItems = imdxResult.status === 'fulfilled' ? imdxResult.value : [];
      setSearchResults([...animeItems, ...imdxItems]);
      if (anicoreResult.status === 'rejected') {
        setSearchError(anicoreResult.reason instanceof Error ? anicoreResult.reason.message : 'AniCore did not answer.');
      }
      if (imdxResult.status === 'rejected') {
        setImdxNotice(imdxResult.reason instanceof Error ? imdxResult.reason.message : 'IMDx did not answer.');
      } else if (!imdxEnabled) {
        setImdxNotice('');
      }
      setSearchLoading(false);
    }, 320);
    return () => { active = false; window.clearTimeout(timer); };
  }, [trimmedQuery, imdxEnabled, imdx]);

  // Anikura spotlight: the top trending title's first-episode discussion.
  useEffect(() => {
    if (!featured) {
      setSpotlightComments([]);
      return;
    }
    let active = true;
    setSpotlightLoading(true);
    anikuraService.getComments(anikuraIds(featured), 1, { limit: 4 })
      .then((result) => { if (active) setSpotlightComments(result.comments); })
      .catch(() => { if (active) setSpotlightComments([]); })
      .finally(() => { if (active) setSpotlightLoading(false); });
    return () => { active = false; };
  }, [featured]);

  const filteredGrid = useMemo(() => {
    if (genre === 'all') return grid;
    return grid.filter((item) => item.genres.some((value) => value.toLowerCase() === genre.toLowerCase()));
  }, [grid, genre]);

  const saved = featured ? watchlist.some((item) => item.id === featured.id) : false;
  const totalAnime = rows.trending.length + rows.topRated.length;

  if (trimmedQuery) {
    return (
      <div className="standard-page anime-view page-enter">
        <div className="page-heading">
          <div>
            <span className="page-kicker"><Sparkles size={14} /> ANIME SEARCH</span>
            <h1>Results for “{query.trim()}”</h1>
            <p>{searchLoading ? 'Searching AniCore and IMDx…' : `${searchResults.length} anime${imdxEnabled ? ' and IMDx titles' : ''} found.`}</p>
          </div>
          <button className="button button-secondary" onClick={onClearSearch}><RotateCcw size={15} /> Clear search</button>
        </div>

        {imdxNotice && <div className="anime-notice" role="status">{imdxNotice}</div>}
        {searchError && searchResults.length > 0 && (
          <div className="anime-notice" role="status">AniCore could not answer ({searchError}); showing the results that did load.</div>
        )}
        {searchError && !searchResults.length && (
          <div className="empty-state">
            <span><CircleAlert size={26} /></span>
            <h2>AniCore did not answer</h2>
            <p>{searchError}</p>
            <button className="button button-secondary" onClick={onOpenSettings}>Check metadata settings</button>
          </div>
        )}

        {searchLoading && !searchResults.length ? (
          <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
        ) : searchResults.length ? (
          <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
            {searchResults.map((item) => (
              <MediaCard
                key={`${item.source}-${item.id}`}
                item={item}
                onSelect={onSelect}
                onToggleWatchlist={onToggleWatchlist}
                inWatchlist={watchlist.some((entry) => entry.id === item.id)}
                compact={compact}
              />
            ))}
          </div>
        ) : !searchLoading && !searchError ? (
          <div className="empty-state">
            <span><Tv size={26} /></span>
            <h2>No anime found</h2>
            <p>Try a Japanese, romaji or English title. AniCore indexes over 32,000 shows across Kitsu, TVDB, TMDB, AniList and MAL.</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="standard-page anime-view page-enter">
      <div className="page-heading anime-heading">
        <div>
          <span className="page-kicker"><Sparkles size={14} /> ANICORE · ANIKURA · IMDX</span>
          <h1>Anime, indexed.</h1>
          <p>Over 32,000 shows resolved from Kitsu, TVDB, TMDB, AniList and MAL — with Anikura episode discussions and optional IMDx metadata.</p>
        </div>
        <div className="anime-heading-badges">
          <span><i className="dot-live" /> {SEASON_LABEL[season.season]} {season.year}</span>
          <span>{totalAnime || '—'} titles loaded</span>
        </div>
      </div>

      {rowsError && (
        <div className="anime-notice" role="status">
          {rowsError} <button className="text-button" onClick={() => void loadRows()}>Retry</button>
        </div>
      )}

      {rowsLoading && !featured ? (
        <>
          <div className="anime-hero-skeleton" />
          <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
        </>
      ) : featured ? (
        <section className="anime-hero">
          <Artwork src={featured.backdrop || featured.poster} alt="" className="anime-hero-art" />
          <div className="anime-hero-overlay" />
          <div className="anime-hero-copy">
            <div className="hero-eyebrow"><span /> ANICORE TRENDING #{1}</div>
            <h2>{featured.title}</h2>
            <div className="hero-meta">
              {featured.rating && <span className="hero-rating"><Star size={13} fill="currentColor" /> {featured.rating.toFixed(1)}</span>}
              {featured.year && <><span>{featured.year}</span><i /></>}
              {featured.anime?.format && <><span>{featured.anime.format}</span><i /></>}
              {featured.anime?.episodeCount && <><span>{featured.anime.episodeCount} episodes</span><i /></>}
              {featured.anime?.status && <span className="maturity-badge">{featured.anime.status}</span>}
            </div>
            <p>{featured.overview || 'No synopsis is available for this title yet.'}</p>
            {featured.anime?.studios?.length ? (
              <div className="genre-list">{featured.anime.studios.map((studio) => <span key={studio}>{studio}</span>)}</div>
            ) : null}
            <div className="hero-actions">
              <button className="button button-primary" onClick={() => onPlay(featured)}><Play size={18} fill="currentColor" /> Find sources</button>
              <button className="button button-glass" onClick={() => onSelect(featured)}><BookOpen size={18} /> Details & episodes</button>
              <button className="button button-glass" onClick={() => onEmbeddedPlayers(featured)}><ExternalLink size={18} /> Embedded players</button>
              <button className={`hero-save ${saved ? 'saved' : ''}`} onClick={() => onToggleWatchlist(featured)} aria-label="Toggle library">
                {saved ? <Check size={19} /> : <Plus size={19} />}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <div className="empty-state">
          <span><CircleAlert size={28} /></span>
          <h2>AniCore did not answer</h2>
          <p>PRAHA could not reach the AniCore index. Web browsers can block third-party APIs, so retry, or open the Android app where requests are unrestricted.</p>
          <div className="tmdb-setup-actions">
            <button className="button button-primary" onClick={() => void loadRows()}><RefreshCw size={16} /> Try again</button>
            <a className="button button-secondary" href={`${ANICORE_SITE}`} target="_blank" rel="noreferrer noopener">Open AniCore <ExternalLink size={14} /></a>
          </div>
        </div>
      )}

      <div className="anime-provider-strip">
        <a className="anime-provider-card" href={`${ANICORE_SITE}`} target="_blank" rel="noreferrer noopener">
          <span className="provider-mark">AC</span>
          <div><strong>AniCore</strong><small>Catalogs, episodes &amp; cross-source ids</small></div>
          <ExternalLink size={14} />
        </a>
        <a className="anime-provider-card" href={`${ANIKURA_SITE}/api`} target="_blank" rel="noreferrer noopener">
          <span className="provider-mark">AK</span>
          <div><strong>Anikura</strong><small>Episode comments from across the web</small></div>
          <ExternalLink size={14} />
        </a>
        <button className={`anime-provider-card ${imdxEnabled ? 'active' : ''}`} onClick={onOpenSettings} type="button">
          <span className="provider-mark">IX</span>
          <div><strong>IMDx · Tiffara</strong><small>{imdxEnabled ? 'Metadata search enabled' : 'Optional IMDb-style metadata'}</small></div>
          <span className={`provider-state ${imdxEnabled ? 'on' : ''}`}>{imdxEnabled ? 'On' : 'Off'}</span>
        </button>
      </div>

      <section className="anime-spotlight-grid">
        {featured && (
          <div className="anime-anikura-card">
            <div className="anikura-card-head">
              <h3><MessageSquare size={16} /> Anikura · episode 1 discussion</h3>
              <a href={`${ANIKURA_SITE}`} target="_blank" rel="noreferrer noopener">anikura.club <ExternalLink size={12} /></a>
            </div>
            {spotlightLoading ? (
              <p className="anime-discussion-empty"><LoaderCircle size={15} className="spin" /> Gathering comments…</p>
            ) : spotlightComments.length ? (
              <ul className="anime-comment-list compact">
                {spotlightComments.slice(0, 3).map((comment) => (
                  <li key={comment.id}>
                    {comment.author?.avatar
                      ? <img src={comment.author.avatar} alt="" loading="lazy" />
                      : <span className="anime-comment-avatar">{(comment.author?.name || '?').charAt(0).toUpperCase()}</span>}
                    <div>
                      <div className="anime-comment-meta"><strong>{comment.author?.name || 'Anikura user'}</strong>{typeof comment.like_count === 'number' && <span className="anime-comment-likes">♥ {comment.like_count}</span>}</div>
                      <p>{comment.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="anime-discussion-empty">No Anikura discussion for this title yet. Open any anime's details to browse episode comments.</p>
            )}
            {featured && (
              <div className="anime-discussion-foot">
                <span>Comments belong to their authors.</span>
                <button className="text-button" onClick={() => onSelect(featured)}>Full discussion <ArrowRight size={13} /></button>
              </div>
            )}
          </div>
        )}

        {featured && (
          <div className="anime-quick-card">
            <h3><Sparkles size={16} /> Provider coverage</h3>
            <div className="anime-provider-tags">
              {(featured.anime?.sources || []).map((source) => <span key={source}>{source}</span>)}
            </div>
            <p>AniCore keeps five independent databases side by side, so a title split into separate seasons here still resolves to the right TMDB, IMDb, MAL and AniList ids for your sources.</p>
            <div className="anime-id-grid">
              <span>MAL <b>{featured.anime?.malId || '—'}</b></span>
              <span>AniList <b>{featured.anime?.anilistId || '—'}</b></span>
              <span>TMDB <b>{featured.tmdbId || '—'}</b></span>
              <span>IMDb <b>{featured.imdbId || 'sync'}</b></span>
            </div>
            <a className="button button-secondary" href={IMDX_DOCS_URL} target="_blank" rel="noreferrer noopener">IMDx API docs <ExternalLink size={14} /></a>
          </div>
        )}
      </section>

      <div className="filter-bar anime-filter-bar">
        <div className="filter-pills">
          {FORMAT_TABS.map((tab) => (
            <button key={tab.id} className={format === tab.id ? 'active' : ''} onClick={() => setFormat(tab.id)}>{tab.label}</button>
          ))}
        </div>
        <div className="discover-select-group">
          <label className="source-select">
            <select aria-label="Sort anime" value={sort} onChange={(event) => setSort(event.target.value as SortOption)}>
              {SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="source-select">
            <select aria-label="Minimum score" value={minScore} onChange={(event) => setMinScore(Number(event.target.value))}>
              {MIN_SCORE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="source-select">
            <select aria-label="Genre" value={genre} onChange={(event) => setGenre(event.target.value)}>
              <option value="all">All genres</option>
              {ANIME_GENRES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </div>

      {rows.trending.length > 0 && (
        <MediaRow
          title="Trending on AniCore"
          subtitle="What the anime index is watching right now."
          items={rows.trending}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}
      {rows.season.length > 0 && (
        <MediaRow
          title={`${SEASON_LABEL[season.season]} ${season.year} season`}
          subtitle="Simulcasts and premieres in the current anime season."
          items={rows.season}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}
      {rows.topRated.length > 0 && (
        <MediaRow
          title="Highest rated of all time"
          subtitle="Frieren, FMA: Brotherhood, Gintama and the rest of the top shelf."
          items={rows.topRated}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}
      {rows.airing.length > 0 && (
        <MediaRow
          title="Airing now"
          subtitle="Shows with new episodes still landing."
          items={rows.airing}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}
      {rows.movies.length > 0 && (
        <MediaRow
          title="Anime films"
          subtitle="Theatrical features from the same unified index."
          items={rows.movies}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}

      <section className="anime-browse">
        <div className="section-heading">
          <div>
            <h2>Browse the full index</h2>
            <p>Filter all 32,000+ records by format, score and genre.</p>
          </div>
          <button className="text-button" onClick={() => void loadGrid(1, false)}><RefreshCw size={14} /> Refresh</button>
        </div>

        {gridError && !filteredGrid.length ? (
          <div className="empty-state">
            <span><CircleAlert size={26} /></span>
            <h2>Could not load the index</h2>
            <p>{gridError}</p>
            <button className="button button-secondary" onClick={() => void loadGrid(1, false)}>Try again</button>
          </div>
        ) : gridLoading ? (
          <div className="media-grid">{Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}</div>
        ) : filteredGrid.length ? (
          <>
            <div className={`media-grid ${compact ? 'compact-grid' : ''}`}>
              {filteredGrid.map((item) => (
                <MediaCard
                  key={item.id}
                  item={item}
                  onSelect={onSelect}
                  onToggleWatchlist={onToggleWatchlist}
                  inWatchlist={watchlist.some((entry) => entry.id === item.id)}
                  compact={compact}
                />
              ))}
            </div>
            {gridHasMore && (
              <div className="discover-load-more">
                <button className="button button-secondary" onClick={() => void loadGrid(gridPage + 1, true)} disabled={gridLoadingMore}>
                  {gridLoadingMore ? <LoaderCircle size={16} className="spin" /> : <ChevronDown size={16} />}
                  {gridLoadingMore ? 'Loading more…' : 'Load more anime'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <span><Tv size={26} /></span>
            <h2>No titles match those filters</h2>
            <p>Try a different format, a lower score, or clear the genre filter.</p>
            <button className="button button-secondary" onClick={() => { setFormat('ALL'); setMinScore(0); setGenre('all'); }}>
              <RotateCcw size={15} /> Reset filters
            </button>
          </div>
        )}
      </section>

      <section className="anime-discussion-preview">
        {featured && <AnimeDiscussion item={featured} compact />}
      </section>
    </div>
  );
};

export default AnimeView;
