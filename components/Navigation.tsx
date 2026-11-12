import React, { useEffect, useRef, useState } from 'react';
import {
  Blocks, BookHeadphones, BookOpen, Check, Compass, Home, LayoutGrid, Library,
  MoreHorizontal, Music2, Play, Plus, Search, Settings, Sparkles, Tv, Tv2,
  UserPlus, Users, X,
} from 'lucide-react';
import { ProfileAvatar } from './ProfilePicker';
import type { AppView, UserProfile } from '../types';

interface NavigationProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  sourceCount: number;
  profiles: UserProfile[];
  activeProfile: UserProfile;
  onSelectProfile: (profileId: string) => void;
  onOpenProfilePicker?: () => void;
  children: React.ReactNode;
}

const mainNav = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'livetv' as const, label: 'Live TV', icon: Tv2 },
  { id: 'anime' as const, label: 'Anime', icon: Tv },
  { id: 'sanka' as const, label: 'Manga & Comics', icon: BookOpen },
  { id: 'music' as const, label: 'Music Streaming', icon: Music2 },
  { id: 'audiobooks' as const, label: 'Audiobooks', icon: BookHeadphones },
  { id: 'discover' as const, label: 'Discover', icon: Compass },
  { id: 'flow' as const, label: 'Flow · YouTube', icon: Play },
  { id: 'explore' as const, label: 'Explore', icon: LayoutGrid },
  { id: 'library' as const, label: 'My Library', icon: Library },
];

const primaryMobileNavItems = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'livetv' as const, label: 'Live TV', icon: Tv2 },
  { id: 'anime' as const, label: 'Anime', icon: Tv },
  { id: 'sanka' as const, label: 'Comics', icon: BookOpen },
];

const moreNavItems = [
  { id: 'music' as const, label: 'Music Streaming', icon: Music2, desc: 'High-res audio, albums & charts' },
  { id: 'audiobooks' as const, label: 'Audiobooks', icon: BookHeadphones, desc: '9 audiobook sources & player' },
  { id: 'flow' as const, label: 'Flow · YouTube', icon: Play, desc: 'Video streams & trending clips' },
  { id: 'discover' as const, label: 'Discover', icon: Compass, desc: 'Recommendations & genres' },
  { id: 'library' as const, label: 'My Library', icon: Library, desc: 'Watchlist & history' },
  { id: 'extensions' as const, label: 'Addons & Plugins', icon: Blocks, desc: 'Stremio & Nuvio sources' },
  { id: 'settings' as const, label: 'Settings', icon: Settings, desc: 'Debrid, player & auto-updates' },
];

const Navigation: React.FC<NavigationProps> = ({
  view, onNavigate, query, onQueryChange, onSearch, sourceCount,
  profiles, activeProfile, onSelectProfile, onOpenProfilePicker, children,
}) => {
  const searchRef = useRef<HTMLInputElement>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const profilePopoverRef = useRef<HTMLDivElement>(null);
  const moreSheetRef = useRef<HTMLDivElement>(null);
  const profileRestoreRef = useRef<HTMLElement | null>(null);
  const moreRestoreRef = useRef<HTMLElement | null>(null);

  // `useSpatialNavigation` scopes D-pad arrow keys to the topmost [role="dialog"].
  // These overlays previously had no dialog semantics, so focus escaped behind
  // them on Android TV (audit M-14). Move focus in, close on Escape, and put
  // focus back on the trigger when the overlay closes.
  useEffect(() => {
    if (!profileMenuOpen) return;
    profileRestoreRef.current = document.activeElement as HTMLElement | null;
    profilePopoverRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      profileRestoreRef.current?.focus();
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    moreRestoreRef.current = document.activeElement as HTMLElement | null;
    moreSheetRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      moreRestoreRef.current?.focus();
    };
  }, [moreOpen]);

  const isMoreActive = moreNavItems.some((item) => item.id === view);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const navButton = (item: { id: AppView; label: string; icon: typeof Home }) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        className={`nav-item ${view === item.id ? 'active' : ''}`}
        onClick={() => onNavigate(item.id)}
        aria-current={view === item.id ? 'page' : undefined}
      >
        <Icon size={19} strokeWidth={view === item.id ? 2.4 : 1.8} />
        <span>{item.label}</span>
        {item.id === 'extensions' && sourceCount > 0 && <span className="nav-count">{sourceCount}</span>}
      </button>
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => onNavigate('home')} aria-label="PRAHA home">
          <span className="brand-mark"><span /></span>
          <span className="brand-word">PRAHA<span>STREAM</span></span>
        </button>

        <nav className="side-nav" aria-label="Main navigation">
          <p className="nav-label">MENU</p>
          {mainNav.map(navButton)}
          <p className="nav-label nav-label-spaced">YOUR SPACE</p>
          {navButton({ id: 'extensions', label: 'Extensions', icon: Blocks })}
          {navButton({ id: 'settings', label: 'Settings', icon: Settings })}
        </nav>

        <div className="sidebar-bottom">
          <div className="source-mini-card">
            <span className="source-mini-icon"><Sparkles size={17} /></span>
            <strong>Your sources.<br />Your stories.</strong>
            <p>{sourceCount || 'No'} active source{sourceCount === 1 ? '' : 's'}</p>
            <button onClick={() => onNavigate('extensions')}>Manage sources <Plus size={14} /></button>
          </div>

          <div className="profile-switcher-wrap">
            <button
              className="profile-chip"
              onClick={() => setProfileMenuOpen((open) => !open)}
              aria-expanded={profileMenuOpen}
            >
              <ProfileAvatar profile={activeProfile} size="sm" />
              <span>
                <strong>{activeProfile.name}</strong>
                <small>{activeProfile.isKids ? 'Kids profile' : `${profiles.length} local profile${profiles.length === 1 ? '' : 's'}`}</small>
              </span>
              <Settings size={15} />
            </button>

            {profileMenuOpen && (
              <div
                className="profile-popover"
                role="dialog"
                aria-modal="true"
                aria-label="Switch profile"
                ref={profilePopoverRef}
              >
                <p>Switch profile</p>
                {profiles.map((prof, idx) => (
                  <button
                    key={prof.id}
                    className={prof.id === activeProfile.id ? 'active' : ''}
                    onClick={() => {
                      onSelectProfile(prof.id);
                      setProfileMenuOpen(false);
                    }}
                  >
                    <ProfileAvatar profile={prof} size="xs" index={idx} />
                    <b>{prof.name}</b>
                    {prof.id === activeProfile.id && <Check size={14} />}
                  </button>
                ))}
                {onOpenProfilePicker && (
                  <button
                    className="profile-manage-link"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      onOpenProfilePicker();
                    }}
                  >
                    <Users size={14} /> Who’s watching? screen
                  </button>
                )}
                <button
                  className={onOpenProfilePicker ? '' : 'profile-manage-link'}
                  onClick={() => {
                    setProfileMenuOpen(false);
                    onNavigate('settings');
                  }}
                >
                  <UserPlus size={14} /> Manage profiles & backup
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button className="mobile-brand" onClick={() => onNavigate('home')} aria-label="PRAHA home">
            <span className="brand-mark"><span /></span><b>PRAHA</b>
          </button>
          <form className="global-search" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
            <Search size={18} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search movies, shows, anime, and sources…"
              aria-label="Search movies, shows, and anime"
            />
            {query ? (
              <button type="button" className="search-clear" onClick={() => onQueryChange('')} aria-label="Clear search">×</button>
            ) : <kbd>⌘ K</kbd>}
          </form>
          <button className="top-source-button" onClick={() => onNavigate('extensions')}>
            <span className="status-dot" />
            <span>{sourceCount} source{sourceCount === 1 ? '' : 's'}</span>
            <Plus size={16} />
          </button>
          <button
            className="top-avatar-btn"
            onClick={() => (onOpenProfilePicker ? onOpenProfilePicker() : onNavigate('settings'))}
            aria-label={`Switch profile (${activeProfile.name})`}
            title={`Switch profile (${activeProfile.name})`}
          >
            <ProfileAvatar profile={activeProfile} size="sm" />
          </button>
        </header>
        <main className="main-content">{children}</main>
      </div>

      {/* Mobile Bottom Navigation: 4 Primary Tabs + More Hub */}
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {primaryMobileNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = view === item.id;
          return (
            <button
              key={item.id}
              className={`mobile-nav-btn ${isActive ? 'active' : ''}`}
              onClick={() => {
                setMoreOpen(false);
                onNavigate(item.id);
              }}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <div className="mobile-nav-icon-wrap">
                <Icon size={20} strokeWidth={isActive ? 2.4 : 1.8} />
              </div>
              <span className="mobile-nav-label">{item.label}</span>
            </button>
          );
        })}

        {/* 5th Tab: More Button */}
        <button
          className={`mobile-nav-btn ${isMoreActive || moreOpen ? 'active' : ''}`}
          onClick={() => setMoreOpen((prev) => !prev)}
          aria-label="More features"
          aria-expanded={moreOpen}
        >
          <div className="mobile-nav-icon-wrap">
            <LayoutGrid size={20} strokeWidth={isMoreActive || moreOpen ? 2.4 : 1.8} />
            {sourceCount > 0 && <span className="mobile-nav-badge">{sourceCount}</span>}
          </div>
          <span className="mobile-nav-label">
            {isMoreActive
              ? (moreNavItems.find((i) => i.id === view)?.label.split(' ')[0] || 'More')
              : 'More'}
          </span>
        </button>
      </nav>

      {/* Sleek Mobile Bottom Sheet for More Features */}
      {moreOpen && (
        <div className="mobile-more-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More features"
            ref={moreSheetRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-more-handle" />
            <div className="mobile-more-header">
              <h3>More Features</h3>
              <button className="mobile-more-close" onClick={() => setMoreOpen(false)} aria-label="Close menu">
                <X size={18} />
              </button>
            </div>
            <div className="mobile-more-grid">
              {moreNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = view === item.id;
                return (
                  <button
                    key={item.id}
                    className={`mobile-more-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      onNavigate(item.id);
                      setMoreOpen(false);
                    }}
                  >
                    <div className="mobile-more-item-icon">
                      <Icon size={20} strokeWidth={isActive ? 2.4 : 1.8} />
                      {item.id === 'extensions' && sourceCount > 0 && (
                        <span className="mobile-nav-badge">{sourceCount}</span>
                      )}
                    </div>
                    <div className="mobile-more-item-text">
                      <strong>{item.label}</strong>
                      <span>{item.desc}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Navigation;
