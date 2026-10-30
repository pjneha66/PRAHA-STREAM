import React, { useState } from 'react';
import {
  ArrowRight, Blocks, Check, ChevronLeft, ChevronRight, Info, Play, Plus, Star,
} from 'lucide-react';
import { CURATED_MEDIA, FEATURED_MEDIA } from '../data/catalog';
import type { InstalledAddon, MediaItem, NuvioRepository, WatchProgress } from '../types';
import { Artwork, ContinueCard, MediaRow } from './MediaCard';

interface HomeViewProps {
  trending: MediaItem[];
  history: WatchProgress[];
  watchlist: MediaItem[];
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  onSelect: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
  onOpenExtensions: () => void;
  onOpenLibrary: () => void;
  compact: boolean;
}

const HomeView: React.FC<HomeViewProps> = ({
  trending, history, watchlist, addons, repositories, onSelect, onPlay,
  onToggleWatchlist, onOpenExtensions, onOpenLibrary, compact,
}) => {
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const featured = FEATURED_MEDIA[featuredIndex];
  const saved = watchlist.some((item) => item.id === featured.id);
  const activeSources = addons.filter((addon) => addon.enabled).length + repositories.filter((repo) => repo.enabled).length;
  const moveFeatured = (direction: number) => setFeaturedIndex((current) => (current + direction + FEATURED_MEDIA.length) % FEATURED_MEDIA.length);

  return (
    <div className="home-view page-enter">
      <section className="hero" key={featured.id}>
        <Artwork src={featured.backdrop || featured.poster} alt="" className="hero-art" />
        <div className="hero-overlay" />
        <div className="hero-content">
          <div className="hero-eyebrow"><span /> PRAHA SPOTLIGHT</div>
          <h1>{featured.title}</h1>
          <div className="hero-meta">
            {featured.rating && <span className="hero-rating"><Star size={13} fill="currentColor" /> {featured.rating.toFixed(1)}</span>}
            <span>{featured.year}</span><i />
            <span>{featured.runtime}</span><i />
            <span className="maturity-badge">{featured.maturity}</span>
          </div>
          <p>{featured.overview}</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onPlay(featured)}><Play size={18} fill="currentColor" /> Watch now</button>
            <button className="button button-glass" onClick={() => onSelect(featured)}><Info size={18} /> More details</button>
            <button className={`hero-save ${saved ? 'saved' : ''}`} onClick={() => onToggleWatchlist(featured)} aria-label="Toggle watchlist">
              {saved ? <Check size={19} /> : <Plus size={19} />}
            </button>
          </div>
        </div>
        <div className="hero-pagination">
          <span><b>0{featuredIndex + 1}</b> / 0{FEATURED_MEDIA.length}</span>
          <button onClick={() => moveFeatured(-1)} aria-label="Previous featured title"><ChevronLeft size={18} /></button>
          <button onClick={() => moveFeatured(1)} aria-label="Next featured title"><ChevronRight size={18} /></button>
        </div>
        <div className="hero-dots">{FEATURED_MEDIA.map((item, index) => <button key={item.id} className={index === featuredIndex ? 'active' : ''} onClick={() => setFeaturedIndex(index)} aria-label={`Feature ${item.title}`} />)}</div>
      </section>

      {history.length > 0 && (
        <section className="media-section continue-section">
          <div className="section-heading">
            <div><h2>Pick up where you left off</h2><p>Your next chapter is waiting.</p></div>
            <button className="text-button" onClick={onOpenLibrary}>View library <ArrowRight size={15} /></button>
          </div>
          <div className="continue-row">
            {history.slice(0, 4).map((entry) => <ContinueCard key={`${entry.media.id}-${entry.season || 0}-${entry.episode || 0}`} entry={entry} onPlay={onPlay} />)}
          </div>
        </section>
      )}

      <MediaRow title="Trending now" subtitle="What everyone is pressing play on." items={trending.slice(0, 12)}
        onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} watchlist={watchlist} compact={compact} />

      <section className="source-banner">
        <div className="source-banner-copy">
          <span className="source-banner-icon"><Blocks size={23} /></span>
          <div><span>BUILT AROUND YOU</span><h2>One library. Every source.</h2><p>Bring your Stremio addons and Nuvio plugins together in a single, beautifully organized home.</p></div>
        </div>
        <div className="source-banner-action">
          <span><i className={activeSources ? 'online' : ''} />{activeSources} active source{activeSources === 1 ? '' : 's'}</span>
          <button className="button button-light" onClick={onOpenExtensions}>Explore extensions <ArrowRight size={16} /></button>
        </div>
      </section>

      <MediaRow title="Modern classics" subtitle="Essential stories, handpicked for you." items={[...CURATED_MEDIA].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 10)}
        onSelect={onSelect} onToggleWatchlist={onToggleWatchlist} watchlist={watchlist} compact={compact} />
    </div>
  );
};

export default HomeView;
