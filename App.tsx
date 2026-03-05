
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { tmdbService } from './services/tmdbService';
import {
    type MediaItem, type FavoriteItem, type WatchlistItem, type HistoryItem, type Settings, type CurrentVideoInfo, type UserProfile
} from './types';
import ResultCard from './components/ResultCard';
import SeasonEpisodeModal from './components/modals/SeasonEpisodeModal';
import VideoPlayer from './components/VideoPlayer';
import SettingsModal from './components/modals/SettingsModal';
import ProfileSelection from './components/ProfileSelection';
import { DEFAULT_SETTINGS, SERVERS, CORS_PROXY_URL } from './constants';

// Enhanced hook to handle profile-specific storage
const useLocalStorage = <T,>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] => {
    // We use a state that updates whenever the key changes
    const [storedValue, setStoredValue] = useState<T>(initialValue);

    // Effect to load data whenever the key changes (e.g., changing profile)
    useEffect(() => {
        try {
            const item = window.localStorage.getItem(key);
            if (item) {
                const parsed = JSON.parse(item);
                // Simple validation for array types to prevent crashes
                if (Array.isArray(initialValue) && !Array.isArray(parsed)) {
                    setStoredValue(initialValue);
                } else {
                    setStoredValue(parsed);
                }
            } else {
                setStoredValue(initialValue);
            }
        } catch (error) {
            console.error(`[LocalStorage] Error parsing key "${key}":`, error);
            setStoredValue(initialValue);
        }
    }, [key]); // Dependency on key is crucial for profile switching

    const setValue = (value: T | ((val: T) => T)) => {
        try {
            const valueToStore = value instanceof Function ? (value as ((val: T) => T))(storedValue) : value;
            setStoredValue(valueToStore);
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) {
            console.error(`[LocalStorage] Error setting key "${key}":`, error);
        }
    };
    return [storedValue, setValue];
};

type AppState = {
    activeTab: 'trending' | 'indian' | 'search' | 'favorites' | 'watchlist' | 'anime' | 'animation' | 'indian_series' | 'k_drama' | 'wrestling' | 'sports' | 'documentary';
    trendingType: 'movie' | 'tv';
};

const App: React.FC = () => {
    // --- Profile Management State ---
    const [profiles, setProfiles] = useLocalStorage<UserProfile[]>('parha-profiles', []);
    const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
    const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);

    // --- Data State (Keyed by Profile ID) ---
    // If no profile is selected, we use a temporary key, but UI blocks interaction until profile selection.
    const storageKeyPrefix = activeProfileId ? `parha-${activeProfileId}` : 'parha-temp';
    
    const [settings, setSettings] = useLocalStorage<Settings>(`${storageKeyPrefix}-settings`, DEFAULT_SETTINGS);
    const [favorites, setFavorites] = useLocalStorage<FavoriteItem[]>(`${storageKeyPrefix}-favorites`, []);
    const [watchlist, setWatchlist] = useLocalStorage<WatchlistItem[]>(`${storageKeyPrefix}-watchlist`, []);
    const [history, setHistory] = useLocalStorage<HistoryItem[]>(`${storageKeyPrefix}-history`, []);

    // --- UI State ---
    const [results, setResults] = useState<MediaItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchType, setSearchType] = useState('');
    const [activeTab, setActiveTab] = useState<AppState['activeTab']>('trending');
    const [trendingType, setTrendingType] = useState<'movie' | 'tv'>('movie');

    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [isSeasonModalOpen, setIsSeasonModalOpen] = useState(false);
    const [selectedShowForSeasons, setSelectedShowForSeasons] = useState<MediaItem | null>(null);
    const [currentVideoInfo, setCurrentVideoInfo] = useState<CurrentVideoInfo | null>(null);
    const [currentServerKey, setCurrentServerKey] = useState<string>(Object.keys(SERVERS)[0]);

    const activeProfile = profiles.find(p => p.id === activeProfileId);
    const adBlockerEnabled = settings.adBlocker;

    // --- Profile Initialization Logic ---
    useEffect(() => {
        // Migration/Init logic: If no profiles exist, create a default one and migrate old global data if found.
        if (profiles.length === 0) {
            const defaultId = 'default-user';
            const defaultProfile: UserProfile = { id: defaultId, name: 'User', avatar: 'bg-blue-500', created: Date.now() };
            
            // Check for legacy data
            const legacyFavorites = window.localStorage.getItem('parha-favorites');
            const legacyWatchlist = window.localStorage.getItem('parha-watchlist');
            const legacyHistory = window.localStorage.getItem('parha-history');
            const legacySettings = window.localStorage.getItem('parha-settings');

            if (legacyFavorites) window.localStorage.setItem(`parha-${defaultId}-favorites`, legacyFavorites);
            if (legacyWatchlist) window.localStorage.setItem(`parha-${defaultId}-watchlist`, legacyWatchlist);
            if (legacyHistory) window.localStorage.setItem(`parha-${defaultId}-history`, legacyHistory);
            if (legacySettings) window.localStorage.setItem(`parha-${defaultId}-settings`, legacySettings);

            setProfiles([defaultProfile]);
            // Don't auto-login here, let the effect chain handle it or show selection screen
        }
    }, [profiles.length, setProfiles]);

    // --- API Fetching ---
    const fetchContent = useCallback((fetcher: Promise<{ results: any[] }>) => {
        setIsLoading(true);
        setError(null);
        fetcher
            .then(data => setResults(data.results.filter(item => item.media_type !== 'person' && item.poster_path)))
            .catch(err => setError(err.message))
            .finally(() => setIsLoading(false));
    }, []);
    
    // Initial load when profile becomes active
    useEffect(() => {
        if (activeProfileId) {
            fetchContent(tmdbService.getTrending('movie', adBlockerEnabled));
            setActiveTab('trending');
            setTrendingType('movie');
        }
    }, [activeProfileId, fetchContent, adBlockerEnabled]);

    // Theme Application
    useEffect(() => {
        if (!activeProfileId) return; // Don't apply theme until profile selected

        const applyTheme = () => {
            let themeToApply = settings.theme;
            if (settings.autoDarkMode) {
                themeToApply = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            document.body.setAttribute('data-theme', themeToApply);
        };

        applyTheme();
        if (settings.autoDarkMode) {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            const handler = () => applyTheme();
            mediaQuery.addEventListener('change', handler);
            return () => mediaQuery.removeEventListener('change', handler);
        }
    }, [settings.theme, settings.autoDarkMode, activeProfileId]);

    // --- Handlers ---
    const handleProfileSelect = (id: string) => {
        setActiveProfileId(id);
        setIsProfileMenuOpen(false);
    };

    const handleAddProfile = (name: string, avatar: string) => {
        const newProfile: UserProfile = {
            id: Date.now().toString(),
            name,
            avatar,
            created: Date.now()
        };
        setProfiles([...profiles, newProfile]);
    };

    const handleDeleteProfile = (id: string) => {
        const newProfiles = profiles.filter(p => p.id !== id);
        setProfiles(newProfiles);
        
        // Clean up localStorage for this profile
        localStorage.removeItem(`parha-${id}-favorites`);
        localStorage.removeItem(`parha-${id}-watchlist`);
        localStorage.removeItem(`parha-${id}-history`);
        localStorage.removeItem(`parha-${id}-settings`);

        if (activeProfileId === id) {
            setActiveProfileId(null);
        }
    };

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;
        setActiveTab('search');
        fetchContent(tmdbService.searchMulti(searchQuery, searchType, adBlockerEnabled));
    };
    
    const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newType = e.target.value;
        setSearchType(newType);
        if (searchQuery.trim() && activeTab === 'search') {
            fetchContent(tmdbService.searchMulti(searchQuery, newType, adBlockerEnabled));
        }
    };

    const getEmbedUrl = (item: MediaItem, serverKey: string, season?: number, episode?: number): string => {
        const server = SERVERS[serverKey];
        if (!server) return '';
        
        const urlTemplate = item.media_type === 'tv' ? server.tvUrl : server.movieUrl;
        const titleSlug = (item.title || item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        
        const url = urlTemplate
            .replace(/{id}/g, item.id.toString())
            .replace(/{season}/g, season?.toString() || '')
            .replace(/{episode}/g, episode?.toString() || '')
            .replace(/&s={season}/g, season ? `&s=${season}` : '')
            .replace(/&e={episode}/g, episode ? `&e=${episode}` : '')
            .replace(/{title-slug}/g, titleSlug)
            .replace(/{title}/g, encodeURIComponent(item.title || item.name || ''));

        return settings.vpnMode ? `${CORS_PROXY_URL}${encodeURIComponent(url)}` : url;
    };

    const addToHistory = (item: MediaItem) => {
        if (!settings.trackHistory) return;

        setHistory(prev => {
            const existingItem = prev.find(i => i.id === item.id);
            const progress = existingItem ? existingItem.progress : 15;
            const newHistory = prev.filter(i => i.id !== item.id);
            newHistory.unshift({ ...item, watchedAt: Date.now(), progress });
            return newHistory.slice(0, 50);
        });
    };

    const playVideo = async (item: MediaItem, serverKey: string, season?: number, episode?: number) => {
        if (item.media_type === 'tv' && (!season || !episode)) {
            setSelectedShowForSeasons(item);
            setIsSeasonModalOpen(true);
            return;
        }
        
        const embedUrl = getEmbedUrl(item, serverKey, season, episode);
        if (embedUrl) {
            addToHistory(item);
            setCurrentVideoInfo({
                embedUrl, tmdbId: item.id, mediaType: item.media_type as 'movie' | 'tv',
                season: season || null, episode: episode || null, serverKey, itemData: item
            });
        }
        setIsSeasonModalOpen(false);
    };

    const handleCardClick = async (item: MediaItem) => {
        await playVideo(item, currentServerKey);
    };
    
    const handleServerChange = (newServerKey: string) => {
        setCurrentServerKey(newServerKey);
        if (currentVideoInfo) {
            const { itemData, season, episode } = currentVideoInfo;
            playVideo(itemData, newServerKey, season ?? undefined, episode ?? undefined);
        }
    };

    const onFavoriteToggle = useCallback((item: MediaItem) => {
        const index = favorites.findIndex(fav => fav.id === item.id);
        setFavorites(index > -1 ? favorites.filter(f => f.id !== item.id) : [...favorites, item]);
    }, [favorites, setFavorites]);

    const onWatchlistToggle = useCallback((item: MediaItem) => {
        const index = watchlist.findIndex(w => w.id === item.id);
        setWatchlist(index > -1 ? watchlist.filter(w => w.id !== item.id) : [...watchlist, { ...item, addedAt: Date.now() }]);
    }, [watchlist, setWatchlist]);

    const favoritesMap = useMemo(() => new Set(favorites.map(f => f.id)), [favorites]);
    const watchlistMap = useMemo(() => new Set(watchlist.map(w => w.id)), [watchlist]);
    const historyMap = useMemo(() => new Map(history.map(h => [h.id, h.progress])), [history]);

    // --- Render Helpers ---

    const renderContinueWatching = () => {
        if (!settings.trackHistory || history.length === 0 || activeTab === 'search') return null;
        const recentItems = [...history].sort((a, b) => b.watchedAt - a.watchedAt).slice(0, 10);
        if (recentItems.length === 0) return null;

        return (
            <div className="mb-10 animate-fade-in">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <i className="fas fa-history text-blue-500"></i> Continue Watching
                </h2>
                <div className="flex overflow-x-auto gap-4 pb-4 px-1 scrollbar-hide snap-x">
                    {recentItems.map(item => (
                        <div key={`history-${item.id}`} className="min-w-[160px] w-[160px] md:min-w-[200px] md:w-[200px] snap-start">
                            <ResultCard 
                                item={item} isFavorite={favoritesMap.has(item.id)} isInWatchlist={watchlistMap.has(item.id)} 
                                watchProgress={item.progress} onCardClick={handleCardClick} 
                                onFavoriteToggle={onFavoriteToggle} onWatchlistToggle={onWatchlistToggle} 
                                isPrivacyMode={settings.privacyMode}
                            />
                        </div>
                    ))}
                </div>
            </div>
        );
    };
    
    const renderContent = () => {
        if (isLoading) return <div className="text-center py-10"><i className="fas fa-spinner fa-spin text-4xl text-blue-500"></i></div>;
        if (error) return <div className="text-center text-red-400 py-10">Error: {error}</div>;
        
        let itemsToRender: MediaItem[] = [];
        if (activeTab === 'favorites') itemsToRender = favorites;
        else if (activeTab === 'watchlist') itemsToRender = [...watchlist].sort((a, b) => b.addedAt - a.addedAt);
        else itemsToRender = results;
        
        if (itemsToRender.length === 0) {
            return <div className="text-center text-gray-400 py-20 bg-white/5 rounded-lg border border-white/10 mx-auto max-w-2xl">
                <i className="fas fa-film text-4xl mb-4 text-gray-600"></i>
                <p>Nothing to see here yet.</p>
            </div>;
        }

        return (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {itemsToRender.map(item => (
                    <ResultCard key={`${item.id}-${item.media_type}`} item={item} 
                        isFavorite={favoritesMap.has(item.id)} isInWatchlist={watchlistMap.has(item.id)} 
                        watchProgress={historyMap.get(item.id) || 0} onCardClick={handleCardClick} 
                        onFavoriteToggle={onFavoriteToggle} onWatchlistToggle={onWatchlistToggle} 
                        isPrivacyMode={settings.privacyMode}
                    />
                ))}
            </div>
        );
    };
    
    const ActiveButtonClasses = 'bg-blue-600 font-semibold text-white shadow-lg shadow-blue-500/20';
    const InactiveButtonClasses = 'bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white border border-white/5';

    // --- Main Render ---

    if (!activeProfileId) {
        return (
            <ProfileSelection 
                profiles={profiles}
                onSelectProfile={handleProfileSelect}
                onAddProfile={handleAddProfile}
                onDeleteProfile={handleDeleteProfile}
            />
        );
    }

    return (
        <div className="bg-[#0a0a0a] text-white min-h-screen font-sans selection:bg-blue-500 selection:text-white">
            <header className="bg-black/80 backdrop-blur-md sticky top-0 z-40 p-4 shadow-lg border-b border-white/10">
                <div className="container mx-auto flex flex-wrap md:flex-nowrap justify-between items-center gap-4">
                    <div className="flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab('trending')}>
                        <i className="fas fa-play-circle text-blue-500 text-3xl"></i>
                        <h1 className="text-2xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">Parha</h1>
                    </div>
                    
                    {/* Controls: Search + Profile + Settings */}
                    <div className="flex items-center gap-4 w-full md:w-auto order-last md:order-2 flex-1 md:justify-end">
                        <form onSubmit={handleSearch} className="flex-1 max-w-xl relative flex items-center gap-2">
                             <div className="relative shrink-0">
                                <select value={searchType} onChange={handleTypeChange}
                                    className="appearance-none bg-[#1a1a1a] text-white pl-3 pr-8 py-2 rounded-lg border border-white/10 focus:outline-none focus:ring-1 focus:ring-blue-500 text-sm hover:bg-[#252525] transition-colors"
                                >
                                    <option value="">All</option>
                                    <option value="movie">Movies</option>
                                    <option value="tv">TV</option>
                                </select>
                                <i className="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none"></i>
                            </div>
                            <div className="relative flex-1">
                                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search..."
                                    className="w-full pl-10 pr-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all focus:bg-[#252525]"
                                />
                                <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500"></i>
                            </div>
                        </form>

                        <div className="flex items-center gap-2 relative">
                            {/* Profile Dropdown */}
                            <div className="relative">
                                <button 
                                    onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                                    className="flex items-center gap-2 hover:bg-white/10 p-1 pr-3 rounded-full transition-colors"
                                >
                                    <div className={`w-8 h-8 rounded-md ${activeProfile?.avatar} flex items-center justify-center text-sm shadow-md`}>
                                        <i className="fas fa-user text-white"></i>
                                    </div>
                                    <i className="fas fa-caret-down text-gray-400 text-xs"></i>
                                </button>

                                {isProfileMenuOpen && (
                                    <div className="absolute right-0 top-full mt-2 w-48 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-xl overflow-hidden animate-fade-in z-50">
                                        <div className="px-4 py-3 border-b border-white/10">
                                            <p className="text-xs text-gray-400 uppercase">Current Profile</p>
                                            <p className="font-bold truncate">{activeProfile?.name}</p>
                                        </div>
                                        <button 
                                            onClick={() => { setActiveProfileId(null); setIsProfileMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 hover:bg-white/5 flex items-center gap-2 text-sm text-gray-300 hover:text-white"
                                        >
                                            <i className="fas fa-users"></i> Switch Profile
                                        </button>
                                        <button 
                                            onClick={() => { setIsSettingsModalOpen(true); setIsProfileMenuOpen(false); }}
                                            className="w-full text-left px-4 py-3 hover:bg-white/5 flex items-center gap-2 text-sm text-gray-300 hover:text-white"
                                        >
                                            <i className="fas fa-cog"></i> Settings
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            <main className="container mx-auto p-4 sm:p-6 pb-20">
                {/* Navigation Pills */}
                <div className="mb-8 flex flex-wrap gap-2 sm:gap-3 overflow-x-auto pb-2 scrollbar-hide">
                    <button onClick={() => { setActiveTab('trending'); setTrendingType('movie'); fetchContent(tmdbService.getTrending('movie', adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'trending' && trendingType === 'movie' ? ActiveButtonClasses : InactiveButtonClasses}`}>Movies</button>
                    <button onClick={() => { setActiveTab('trending'); setTrendingType('tv'); fetchContent(tmdbService.getTrending('tv', adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'trending' && trendingType === 'tv' ? ActiveButtonClasses : InactiveButtonClasses}`}>TV Shows</button>
                    <div className="w-px h-6 bg-white/10 mx-1 self-center"></div>
                    <button onClick={() => { setActiveTab('indian'); fetchContent(tmdbService.getIndianMovies(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'indian' ? ActiveButtonClasses : InactiveButtonClasses}`}>Indian Movies</button>
                    <button onClick={() => { setActiveTab('indian_series'); fetchContent(tmdbService.getIndianSeries(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'indian_series' ? ActiveButtonClasses : InactiveButtonClasses}`}>Indian Series</button>
                    <button onClick={() => { setActiveTab('anime'); fetchContent(tmdbService.getAnime(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'anime' ? ActiveButtonClasses : InactiveButtonClasses}`}>Anime</button>
                    <button onClick={() => { setActiveTab('animation'); fetchContent(tmdbService.getAnimation(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'animation' ? ActiveButtonClasses : InactiveButtonClasses}`}>Animation</button>
                    <button onClick={() => { setActiveTab('k_drama'); fetchContent(tmdbService.getKDramas(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'k_drama' ? ActiveButtonClasses : InactiveButtonClasses}`}>K-Drama</button>
                    <button onClick={() => { setActiveTab('wrestling'); fetchContent(tmdbService.getWrestling(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'wrestling' ? ActiveButtonClasses : InactiveButtonClasses}`}>Wrestling</button>
                    <button onClick={() => { setActiveTab('sports'); fetchContent(tmdbService.getSports(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'sports' ? ActiveButtonClasses : InactiveButtonClasses}`}>Sports</button>
                    <button onClick={() => { setActiveTab('documentary'); fetchContent(tmdbService.getDocumentaries(adBlockerEnabled)); }} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'documentary' ? ActiveButtonClasses : InactiveButtonClasses}`}>Documentary</button>
                    <div className="w-px h-6 bg-white/10 mx-1 self-center"></div>
                    <button onClick={() => setActiveTab('favorites')} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'favorites' ? ActiveButtonClasses : InactiveButtonClasses}`}><i className="fas fa-heart mr-1"></i> Favorites</button>
                    <button onClick={() => setActiveTab('watchlist')} className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-all duration-200 ${activeTab === 'watchlist' ? ActiveButtonClasses : InactiveButtonClasses}`}><i className="fas fa-bookmark mr-1"></i> Watchlist</button>
                </div>

                {renderContinueWatching()}
                {renderContent()}
            </main>
            
            <SeasonEpisodeModal
                isOpen={isSeasonModalOpen} onClose={() => setIsSeasonModalOpen(false)}
                onPlay={(season, episode) => selectedShowForSeasons && playVideo(selectedShowForSeasons, currentServerKey, season, episode)}
                show={selectedShowForSeasons} adBlockerEnabled={adBlockerEnabled}
            />

            {currentVideoInfo && (
                <VideoPlayer
                    videoInfo={currentVideoInfo} onClose={() => setCurrentVideoInfo(null)}
                    settings={settings} servers={SERVERS} onServerChange={handleServerChange}
                />
            )}

            <SettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)}
                settings={settings} onSettingsChange={setSettings}
            />
             <style>{`
                .scrollbar-hide::-webkit-scrollbar {
                    display: none;
                }
                .scrollbar-hide {
                    -ms-overflow-style: none;
                    scrollbar-width: none;
                }
                @keyframes fade-in {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in {
                    animation: fade-in 0.3s ease-out forwards;
                }
            `}</style>
        </div>
    );
};

export default App;
