import React, { useState } from 'react';
import {
  ArrowRight, Blocks, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, Info, Play, Plus, RotateCcw, Star,
} from 'lucide-react';
import type { HomeCatalog, InstalledAddon, MediaItem, NuvioRepository, WatchProgress } from '../types';
import { Artwork, ContinueCard, MediaRow } from './MediaCard';
import TmdbSetupCard from './TmdbSetupCard';
import AddonHomeRows from './AddonHomeRows';
import JellyfinHome from './JellyfinHome';
import type { JellyfinSnapshot } from '../services/jellyfinService';
import { DEFAULT_HOME_ROWS } from '../services/homeCache';
import type { HomeRowId, HomeRowSettings } from '../services/homeCache';

interface HomeViewProps {
  catalog: HomeCatalog;
  jellyfinSnapshot?: JellyfinSnapshot | null;
  loading: boolean;
  error: string;
  tmdbReady: boolean;
  history: WatchProgress[];
  watchlist: MediaItem[];
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  onSelect: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onEmbeddedPlayers: (item: MediaItem) => void;
  onResumeEntry: (entry: WatchProgress) => void;
  onRemoveHistory: (entry: WatchProgress) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onOpenExtensions: () => void;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  compact: boolean;
  homeRows: HomeRowSettings;
  onHomeRowsChange: (settings: HomeRowSettings) => void;
  /** Optional IMDb-style titles from IMDx (Tiffara). Additive to TMDB, never a replacement. */
  imdxSpotlight?: MediaItem[];
  imdxEnabled?: boolean;
}

const HomeView: React.FC<HomeViewProps> = ({
  catalog, jellyfinSnapshot = null, loading, error, tmdbReady, history, watchlist, addons, repositories,
  onSelect, onPlay, onEmbeddedPlayers, onResumeEntry, onRemoveHistory, onToggleWatchlist,
  onOpenExtensions, onOpenLibrary, onOpenSettings, onRetry, compact, homeRows, onHomeRowsChange,
  imdxSpotlight = [], imdxEnabled = false,
}) => {
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const spotlight = catalog.hero;
  const featured = spotlight[Math.min(featuredIndex, Math.max(spotlight.length - 1, 0))];
  const saved = featured ? watchlist.some((item) => item.id === featured.id) : false;
  const activeSources = addons.filter((addon) => addon.enabled).length + repositories.filter((repo) => repo.enabled).length;
  const moveFeatured = (direction: number) => setFeaturedIndex((current) => (current + direction + spotlight.length) % spotlight.length);

  const jellyfinRow = <JellyfinHome snapshot={jellyfinSnapshot} onOpenSettings={onOpenSettings} />;
  const addonRows = <AddonHomeRows addons={addons} watchlist={watchlist} compact={compact} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} />;

  const sourceBanner = (
    <section className="source-banner">
      <div className="source-banner-copy">
        <span className="source-banner-icon"><Blocks size={23} /></span>
        <div><span>BUILT AROUND YOU</span><h2>One library. Every source.</h2><p>Bring your Stremio addons and Nuvio plugins together in one Android & web home.</p></div>
      </div>
      <div className="source-banner-action">
        <span><i className={activeSources ? 'online' : ''} />{activeSources} active source{activeSources === 1 ? '' : 's'}</span>
        <button className="button button-light" onClick={onOpenExtensions}>Explore extensions <ArrowRight size={16} /></button>
      </div>
    </section>
  );

  const imdxCatalog = !tmdbReady && imdxEnabled
    && Boolean(catalog.hero.length || catalog.trending.length || catalog.movies.length || catalog.series.length);

  if (!tmdbReady && !imdxEnabled) {
    return (
      <div className="home-view page-enter">
        <section className="hero hero-empty">
          <div className="hero-overlay" />
          <div className="hero-content">
            <div className="hero-eyebrow"><span /> LIVE FROM TMDB</div>
            <h1>Your catalog, streamed from TMDB.</h1>
            <p>PRAHA ships no bundled list of movies and shows. Trending titles, posters, ratings, genres, trailers, and episode guides are fetched live from TMDB with your own API key.</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={onOpenSettings}><Info size={18} /> Add your TMDB key</button>
              <button className="button button-glass" onClick={onOpenExtensions}><Blocks size={18} /> Manage sources</button>
            </div>
          </div>
        </section>
        <TmdbSetupCard onOpenSettings={onOpenSettings} />
        {jellyfinRow}
        {addonRows}
        {sourceBanner}
      </div>
    );
  }

  if (loading && !featured) {
    return (
      <div className="home-view page-enter">
        <section className="hero hero-loading"><div className="hero-overlay" /><div className="hero-content">
          <div className="hero-eyebrow"><span /> {tmdbReady ? 'LOADING FROM TMDB' : 'LOADING FROM IMDX'}</div>
          <h1>Fetching tonight’s spotlight…</h1>
          <p>{tmdbReady ? 'Trending titles, artwork, and ratings are on their way from TMDB.' : 'Popular titles and ratings are on their way from IMDx.'}</p>
        </div></section>
        {jellyfinRow}
        {addonRows}
        <div className="media-grid">
          {Array.from({ length: 12 }).map((_, index) => <div className="media-skeleton" key={index}><span /><i /><i /></div>)}
        </div>
      </div>
    );
  }

  if (error && !spotlight.length && !catalog.trending.length && !catalog.movies.length && !catalog.series.length && !catalog.topRated.length) {
    return (
      <div className="home-view page-enter">
        <div className="empty-state"><span><CircleAlert size={28} /></span><h2>{tmdbReady ? 'TMDB did not answer' : 'Your metadata providers did not answer'}</h2><p>{error}</p>
          <div className="tmdb-setup-actions">
            <button className="button button-primary" onClick={onRetry}><RotateCcw size={16} /> Try again</button>
            <button className="button button-secondary" onClick={onOpenSettings}>Check your API key</button>
          </div>
        </div>
        {jellyfinRow}
        {addonRows}
        {sourceBanner}
      </div>
    );
  }

  if (!spotlight.length && !catalog.trending.length && !catalog.movies.length && !catalog.series.length && !catalog.topRated.length) {
    return (
      <div className="home-view page-enter">
        <div className="empty-state"><span><CircleAlert size={28} /></span><h2>{tmdbReady ? 'TMDB returned no titles' : 'No titles came back yet'}</h2>
          <p>{tmdbReady
            ? 'Your key connected, but no catalogue results came back. Retry, or check the key’s API access in your TMDB account.'
            : 'IMDx is enabled but returned no titles. Retry, check the IMDx card in Settings, or add a TMDB key for the full TMDB catalog.'}</p>
          <div className="tmdb-setup-actions">
            <button className="button button-primary" onClick={onRetry}><RotateCcw size={16} /> Try again</button>
            <button className="button button-secondary" onClick={onOpenSettings}>Check your API key</button>
          </div>
        </div>
        {jellyfinRow}
        {addonRows}
        {sourceBanner}
      </div>
    );
  }

  return (
    <div className="home-view page-enter">
      {!tmdbReady && imdxCatalog && (
        <div className="home-cache-notice" role="status">
          TMDB key not set — this catalog comes from IMDx (Tiffara). Add your TMDB key for trending, trailers and episode guides.
          <button className="text-button" onClick={onOpenSettings}>Open settings</button>
        </div>
      )}
      {error && <div className="home-cache-notice" role="status">Showing saved titles; refresh failed. <button className="text-button" onClick={onRetry}>Try again</button></div>}
      {featured && (
        <section className="hero" key={featured.id}>
          <Artwork src={featured.backdrop || featured.poster} alt="" className="hero-art" />
          <div className="hero-overlay" />
          <div className="hero-content">
            <div className="hero-eyebrow"><span /> {tmdbReady ? 'TMDB SPOTLIGHT' : 'IMDX SPOTLIGHT'}</div>
            <h1>{featured.title}</h1>
            <div className="hero-meta">
              {featured.rating && <span className="hero-rating"><Star size={13} fill="currentColor" /> {featured.rating.toFixed(1)}</span>}
              {featured.year && <><span>{featured.year}</span><i /></>}
              {featured.runtime && <><span>{featured.runtime}</span><i /></>}
              {featured.maturity && <span className="maturity-badge">{featured.maturity}</span>}
            </div>
            <p>{featured.overview || 'No description is available for this title yet.'}</p>
            <div className="hero-actions">
              <button className="button button-primary" onClick={() => onPlay(featured)}><Play size={18} fill="currentColor" /> Watch now</button>
              <button className="button button-glass" onClick={() => onEmbeddedPlayers(featured)}><ExternalLink size={18} /> Embedded players</button>
              <button className="button button-glass" onClick={() => onSelect(featured)}><Info size={18} /> More details</button>
              <button className={`hero-save ${saved ? 'saved' : ''}`} onClick={() => onToggleWatchlist(featured)} aria-label="Toggle watchlist">
                {saved ? <Check size={19} /> : <Plus size={19} />}
              </button>
            </div>
            {featured.genres.length > 0 && <div className="genre-list">{featured.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>}
          </div>
          {spotlight.length > 1 && (
            <>
              <div className="hero-pagination">
                <span><b>0{featuredIndex + 1}</b> / 0{spotlight.length}</span>
                <button onClick={() => moveFeatured(-1)} aria-label="Previous featured title"><ChevronLeft size={18} /></button>
                <button onClick={() => moveFeatured(1)} aria-label="Next featured title"><ChevronRight size={18} /></button>
              </div>
              <div className="hero-dots">{spotlight.map((item, index) => <button key={item.id} className={index === featuredIndex ? 'active' : ''} onClick={() => setFeaturedIndex(index)} aria-label={`Feature ${item.title}`} />)}</div>
            </>
          )}
        </section>
      )}

      <details className="home-row-settings">
        <summary>Customize home rows</summary>
        <p>Show, hide, or reorder rows for this profile.</p>
        {homeRows.order.map((row, index) => {
          const names: Record<HomeRowId, string> = { continue: 'Continue watching', trending: 'Trending', movies: 'Popular movies', series: 'Popular series', topRated: 'Top rated' };
          const move = (direction: number) => {
            const order = [...homeRows.order];
            const target = index + direction;
            if (target < 0 || target >= order.length) return;
            [order[index], order[target]] = [order[target], order[index]];
            onHomeRowsChange({ ...homeRows, order });
          };
          return <div className="home-row-setting" key={row}>
            <label><input type="checkbox" checked={!homeRows.hidden.includes(row)} onChange={(event) => onHomeRowsChange({ ...homeRows, hidden: event.target.checked ? homeRows.hidden.filter((item) => item !== row) : [...homeRows.hidden, row] })} /> {names[row]}</label>
            <span><button className="icon-button" onClick={() => move(-1)} disabled={index === 0} aria-label={`Move ${names[row]} up`}>↑</button><button className="icon-button" onClick={() => move(1)} disabled={index === homeRows.order.length - 1} aria-label={`Move ${names[row]} down`}>↓</button></span>
          </div>;
        })}
        <button className="text-button" onClick={() => onHomeRowsChange(DEFAULT_HOME_ROWS)}>Reset rows</button>
      </details>
      {homeRows.order.filter((row) => !homeRows.hidden.includes(row)).map((row) => {
        if (row === 'continue') return history.length ? <section className="media-section continue-section" key={row}>
          <div className="section-heading"><div><h2>Pick up where you left off</h2><p>Resume at your exact timestamp or jump to the next episode.</p></div><button className="text-button" onClick={onOpenLibrary}>View library <ArrowRight size={15} /></button></div>
          <div className="continue-row">{history.slice(0, 6).map((entry) => <ContinueCard key={`${entry.media.id}-${entry.season || 0}-${entry.episode || 0}`} entry={entry} onPlay={onPlay} onResumeEntry={onResumeEntry} onRemove={onRemoveHistory} />)}</div>
        </section> : null;
        const rows = {
          trending: ['Trending this week', 'Live from TMDB — what everyone is pressing play on.'],
          movies: ['Popular movies', 'TMDB’s most-watched films right now.'],
          series: ['Popular series', 'Binge-worthy shows trending on TMDB.'],
          topRated: ['Top rated of all time', 'The highest-rated films in the TMDB database.'],
        };
        const [title, subtitle] = rows[row];
        return <MediaRow key={row} title={title} subtitle={subtitle} items={catalog[row].slice(0, 20)} onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} watchlist={watchlist} compact={compact} />;
      })}
      {imdxSpotlight.length > 0 && (
        <MediaRow
          title="Popular on IMDx"
          subtitle="An extra, IMDb-style row from the optional Tiffara API — TMDB stays your primary catalog."
          items={imdxSpotlight}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      )}
      {jellyfinRow}
      {addonRows}
      {sourceBanner}
    </div>
  );
};

export default HomeView;
