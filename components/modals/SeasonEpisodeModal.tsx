import React, { useState, useEffect } from 'react';
import { type MediaItem } from '../../types';
import { tmdbService } from '../../services/tmdbService';

interface SeasonEpisodeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onPlay: (season: number, episode: number) => void;
    show: MediaItem | null;
    adBlockerEnabled: boolean;
}

interface Season {
    season_number: number;
    episode_count: number;
}

interface Episode {
    episode_number: number;
    name: string;
}

const SeasonEpisodeModal: React.FC<SeasonEpisodeModalProps> = ({ isOpen, onClose, onPlay, show, adBlockerEnabled }) => {
    const [seasons, setSeasons] = useState<Season[]>([]);
    const [episodes, setEpisodes] = useState<Episode[]>([]);
    const [selectedSeason, setSelectedSeason] = useState<string>('');
    const [selectedEpisode, setSelectedEpisode] = useState<string>('');
    const [isLoadingSeasons, setIsLoadingSeasons] = useState(false);
    const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false);

    useEffect(() => {
        if (isOpen && show) {
            setIsLoadingSeasons(true);
            tmdbService.getTvShowDetails(show.id, adBlockerEnabled)
                .then(data => {
                    setSeasons(data.seasons.filter((s: Season) => s.season_number > 0));
                    setIsLoadingSeasons(false);
                })
                .catch(err => {
                    console.error("Failed to fetch seasons", err);
                    setIsLoadingSeasons(false);
                });
        } else {
            setSeasons([]);
            setEpisodes([]);
            setSelectedSeason('');
            setSelectedEpisode('');
        }
    }, [isOpen, show, adBlockerEnabled]);

    useEffect(() => {
        if (selectedSeason && show) {
            setIsLoadingEpisodes(true);
            setEpisodes([]);
            tmdbService.getTvSeasonDetails(show.id, parseInt(selectedSeason), adBlockerEnabled)
                .then(data => {
                    setEpisodes(data.episodes);
                    setIsLoadingEpisodes(false);
                })
                .catch(err => {
                    console.error("Failed to fetch episodes", err);
                    setIsLoadingEpisodes(false);
                });
        }
    }, [selectedSeason, show, adBlockerEnabled]);

    if (!isOpen) return null;

    const handlePlay = () => {
        if (selectedSeason && selectedEpisode) {
            onPlay(parseInt(selectedSeason), parseInt(selectedEpisode));
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex justify-center items-center z-50 p-4">
            <div className="season-episode-modal-glass-bg w-full max-w-md p-6">
                <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-4">
                    <h2 className="text-xl font-bold text-white">Select Season & Episode</h2>
                    <button onClick={onClose} className="text-2xl hover:text-gray-300 transition-colors"><i className="fas fa-times"></i></button>
                </div>
                <p className="mb-4 text-gray-300">{show?.title || show?.name}</p>
                <div className="space-y-4">
                    <select
                        className="season-episode-modal-glass-select w-full"
                        value={selectedSeason}
                        onChange={(e) => setSelectedSeason(e.target.value)}
                        disabled={isLoadingSeasons}
                    >
                        <option value="">{isLoadingSeasons ? 'Loading Seasons...' : 'Select a Season'}</option>
                        {seasons.map(s => <option key={s.season_number} value={s.season_number}>Season {s.season_number} ({s.episode_count} episodes)</option>)}
                    </select>
                    <select
                        className="season-episode-modal-glass-select w-full"
                        value={selectedEpisode}
                        onChange={(e) => setSelectedEpisode(e.target.value)}
                        disabled={!selectedSeason || isLoadingEpisodes}
                    >
                        <option value="">{isLoadingEpisodes ? 'Loading Episodes...' : 'Select an Episode'}</option>
                        {episodes.map(e => <option key={e.episode_number} value={e.episode_number}>E{e.episode_number} - {e.name}</option>)}
                    </select>
                </div>
                <div className="mt-6 flex gap-4">
                    <button onClick={handlePlay} disabled={!selectedSeason || !selectedEpisode} className="flex-1 season-episode-modal-accent-btn">
                        <i className="fas fa-play mr-2"></i> Play Episode
                    </button>
                    <button onClick={onClose} className="flex-1 season-episode-modal-secondary-btn">
                        Cancel
                    </button>
                </div>
            </div>
            {/* FIX: Removed unsupported `jsx` prop from style tag and prefixed class names to avoid global conflicts. */}
            <style>{`
               .season-episode-modal-glass-bg {
                    background: rgba(26, 26, 26, 0.7);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                }
                .season-episode-modal-glass-select {
                    padding: 12px;
                    background: rgba(255, 255, 255, 0.02);
                    backdrop-filter: blur(10px);
                    color: white;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                    font-size: 14px;
                }
                .season-episode-modal-glass-select:disabled { opacity: 0.5; }
                .season-episode-modal-glass-select option { background-color: #1a1a1a; }
                .season-episode-modal-accent-btn {
                    padding: 12px 24px;
                    background: linear-gradient(135deg, #ffffff, #e0e0e0);
                    color: #0a0a0a;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-weight: 600;
                    transition: all 0.3s;
                }
                .season-episode-modal-accent-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
                .season-episode-modal-accent-btn:disabled { background: #555; color: #888; cursor: not-allowed; }
                .season-episode-modal-secondary-btn {
                    padding: 12px 24px;
                    background: rgba(255, 255, 255, 0.05);
                    color: white;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                    cursor: pointer;
                    font-weight: 600;
                    transition: background 0.3s;
                }
                .season-episode-modal-secondary-btn:hover { background: rgba(255, 255, 255, 0.1); }
            `}</style>
        </div>
    );
};

export default SeasonEpisodeModal;
