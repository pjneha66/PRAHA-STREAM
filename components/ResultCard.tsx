
import React from 'react';
import { type MediaItem } from '../types';

interface ResultCardProps {
    item: MediaItem;
    isFavorite: boolean;
    isInWatchlist: boolean;
    watchProgress: number;
    onCardClick: (item: MediaItem) => void;
    onFavoriteToggle: (item: MediaItem) => void;
    onWatchlistToggle: (item: MediaItem) => void;
    isPrivacyMode: boolean;
}

const ResultCard: React.FC<ResultCardProps> = ({ 
    item, 
    isFavorite, 
    isInWatchlist, 
    watchProgress,
    onCardClick, 
    onFavoriteToggle, 
    onWatchlistToggle,
    isPrivacyMode,
}) => {
    const title = item.title || item.name || 'No Title';
    const releaseDate = item.release_date || item.first_air_date;
    const year = releaseDate ? new Date(releaseDate).getFullYear() : 'N/A';
    const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : 'https://picsum.photos/500/750';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : 'N/A';

    const handleActionClick = (e: React.MouseEvent, action: 'favorite' | 'watchlist') => {
        e.stopPropagation();
        if (action === 'favorite') onFavoriteToggle(item);
        if (action === 'watchlist') onWatchlistToggle(item);
    };

    const cardClasses = `
        result-card-glass-bg relative overflow-hidden cursor-pointer group transition-all duration-300 ease-in-out
        hover:-translate-y-2 hover:shadow-2xl hover:border-white/20
        ${isPrivacyMode ? 'blur-md hover:blur-none' : ''}
    `;

    return (
        <div className={cardClasses} onClick={() => onCardClick(item)}>
            <div className="absolute top-4 left-4 z-10 result-card-glass-bg-sm px-2 py-1 text-xs font-bold">{rating}</div>
            <img 
                src={posterUrl} 
                alt={`${title} Poster`} 
                className="w-full h-[400px] object-cover transition-transform duration-300 group-hover:scale-105" 
                loading="lazy" 
            />
            <div className="p-4">
                <h3 className="text-base font-bold truncate text-white">{title}</h3>
                <p className="text-sm text-gray-400">{year} • {item.media_type}</p>
            </div>
            <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                    className={`result-card-action-btn ${isFavorite ? 'text-red-500 bg-red-500/10 border-red-500/30' : ''}`}
                    onClick={(e) => handleActionClick(e, 'favorite')} 
                    title="Add to Favorites"
                >
                    <i className="fas fa-heart"></i>
                </button>
                <button 
                     className={`result-card-action-btn ${isInWatchlist ? 'text-blue-500 bg-blue-500/10 border-blue-500/30' : ''}`}
                    onClick={(e) => handleActionClick(e, 'watchlist')} 
                    title="Add to Watchlist"
                >
                    <i className="fas fa-bookmark"></i>
                </button>
            </div>
            {watchProgress > 0 && (
                <div className="absolute bottom-0 left-0 w-full h-1 bg-white/10">
                    <div className="h-full result-card-bg-accent-primary" style={{ width: `${watchProgress}%` }}></div>
                </div>
            )}
            {/* FIX: Removed unsupported `jsx` prop from style tag and prefixed class names to avoid global conflicts. */}
            <style>{`
                .result-card-glass-bg {
                    background: rgba(255, 255, 255, 0.02);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                }
                 .result-card-glass-bg-sm {
                    background: rgba(255, 255, 255, 0.02);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                }
                .result-card-action-btn {
                    background: rgba(26, 26, 26, 0.5);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 50%;
                    width: 36px;
                    height: 36px;
                    color: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    transition: all 0.2s ease-in-out;
                }
                .result-card-action-btn:hover {
                    transform: scale(1.1);
                    background: rgba(255, 255, 255, 0.1);
                }
                .result-card-bg-accent-primary {
                    background: linear-gradient(135deg, #ffffff, #e0e0e0);
                }
                body[data-theme='blue'] .result-card-bg-accent-primary {
                    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
                }
                body[data-theme='purple'] .result-card-bg-accent-primary {
                    background: linear-gradient(135deg, #8b5cf6, #7c3aed);
                }
            `}</style>
        </div>
    );
};

export default ResultCard;