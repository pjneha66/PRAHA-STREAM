import React, { useEffect, useRef, useState } from 'react';
import {
  Blocks, Check, Compass, Home, LayoutGrid, Library, Plus, Search, Settings, Sparkles, UserPlus,
} from 'lucide-react';
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
  children: React.ReactNode;
}

const mainNav = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'discover' as const, label: 'Discover', icon: Compass },
  { id: 'explore' as const, label: 'Explore', icon: LayoutGrid },
  { id: 'library' as const, label: 'My Library', icon: Library },
];

const mobileNavItems = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'discover' as const, label: 'Discover', icon: Compass },
  { id: 'library' as const, label: 'Library', icon: Library },
  { id: 'extensions' as const, label: 'Addons', icon: Blocks },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
];

const Navigation: React.FC<NavigationProps> = ({
  view, onNavigate, query, onQueryChange, onSearch, sourceCount,
  profiles, activeProfile, onSelectProfile, children,
}) => {
  const searchRef = useRef<HTMLInputElement>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

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

  const initial = (activeProfile.name || 'P').trim().charAt(0).toUpperCase();

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
              <span className="avatar" style={{ background: activeProfile.avatarColor, color: '#11150c' }}>{initial}</span>
              <span>
                <strong>{activeProfile.name}</strong>
                <small>{activeProfile.isKids ? 'Kids profile' : `${profiles.length} local profile${profiles.length === 1 ? '' : 's'}`}</small>
              </span>
              <Settings size={15} />
            </button>

            {profileMenuOpen && (
              <div className="profile-popover" role="menu">
                <p>Switch profile</p>
                {profiles.map((prof) => (
                  <button
                    key={prof.id}
                    className={prof.id === activeProfile.id ? 'active' : ''}
                    onClick={() => {
                      onSelectProfile(prof.id);
                      setProfileMenuOpen(false);
                    }}
                  >
                    <span className="avatar small" style={{ background: prof.avatarColor, color: '#11150c' }}>
                      {prof.name.charAt(0).toUpperCase()}
                    </span>
                    <b>{prof.name}</b>
                    {prof.id === activeProfile.id && <Check size={14} />}
                  </button>
                ))}
                <button
                  className="profile-manage-link"
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
              placeholder="Search movies, shows, and sources…"
              aria-label="Search movies and shows"
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
            className="top-avatar"
            style={{ background: activeProfile.avatarColor, color: '#11150c' }}
            onClick={() => onNavigate('settings')}
            aria-label={`Profile: ${activeProfile.name}`}
          >
            {initial}
          </button>
        </header>
        <main className="main-content">{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = view === item.id;
          return (
            <button
              key={item.id}
              className={`mobile-nav-btn ${isActive ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <div className="mobile-nav-icon-wrap">
                <Icon size={20} strokeWidth={isActive ? 2.4 : 1.8} />
                {item.id === 'extensions' && sourceCount > 0 && (
                  <span className="mobile-nav-badge">{sourceCount}</span>
                )}
              </div>
              <span className="mobile-nav-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};

export default Navigation;
