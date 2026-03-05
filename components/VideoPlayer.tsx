
import React, { useState } from 'react';
import { CurrentVideoInfo, Servers, Settings } from '../types';

interface VideoPlayerProps {
    videoInfo: CurrentVideoInfo;
    onClose: () => void;
    settings: Settings;
    servers: Servers;
    onServerChange: (serverKey: string) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ videoInfo, onClose, settings, servers, onServerChange }) => {
    const item = videoInfo.itemData;
    const title = item.title || item.name;
    const subtitle = item.media_type === 'tv' 
        ? `Season ${videoInfo.season}, Episode ${videoInfo.episode}`
        : `${new Date(item.release_date || item.first_air_date || '').getFullYear()}`;
        
    const currentServer = servers[videoInfo.serverKey];
    const [playbackSpeed, setPlaybackSpeed] = useState(1);

    const handleDownload = () => {
        window.open(videoInfo.embedUrl, '_blank');
    };

    const handleSkipIntro = () => {
        // NOTE: Since we are using third-party iframes, we cannot programmatically seek 
        // within the iframe due to Cross-Origin Resource Sharing (CORS) policies.
        // This button is a UI placeholder as requested, but functional control 
        // depends on the specific server's player API which is rarely exposed.
        console.log("Programmatic seeking within iframes is restricted by CORS and may not be functional.");
        
        // As a fallback/hack, we can try to reload the iframe with a timestamp if supported,
        // but most standard embeds don't support standard 't=' parameters.
        // For now, we just show a toast or feedback by focusing the element.
        const iframe = document.getElementById('video-iframe') as HTMLIFrameElement;
        if(iframe) {
            // Some players might capture focus on click
            iframe.focus();
        }
    };

    return (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-4 animate-fade-in">
            <div className="w-full max-w-6xl bg-gray-900/50 backdrop-blur-md rounded-lg border border-white/10 shadow-2xl flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="p-3 sm:p-4 flex flex-wrap gap-2 justify-between items-center border-b border-white/10 shrink-0">
                    <div className="min-w-0 max-w-[40%]">
                        <h3 className="text-base sm:text-lg font-bold text-white truncate">{title}</h3>
                        <p className="text-xs sm:text-sm text-gray-400 truncate">{subtitle}</p>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end flex-1">
                        
                        {/* Playback Speed Control */}
                        <div className="hidden sm:flex items-center gap-2 bg-gray-800 rounded-md px-2 py-1 border border-white/5">
                            <i className="fas fa-tachometer-alt text-gray-400 text-xs"></i>
                            <select 
                                value={playbackSpeed}
                                onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                                className="bg-transparent text-white text-xs focus:outline-none cursor-pointer"
                                title="Playback Speed (May not work on all servers)"
                            >
                                <option value="0.5">0.5x</option>
                                <option value="1">1.0x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2.0x</option>
                            </select>
                        </div>

                        {/* Skip Intro Button */}
                        <button
                            onClick={handleSkipIntro}
                            className="bg-gray-800 hover:bg-gray-700 text-white text-xs sm:text-sm px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 border border-white/5"
                            title="Skip Intro (Attempts to seek forward)"
                        >
                            <i className="fas fa-forward"></i>
                            <span className="hidden sm:inline">Skip Intro</span>
                        </button>

                        {/* Enhanced Server Selector */}
                        <div className="relative flex items-center">
                            <div className="absolute left-3 pointer-events-none text-blue-400">
                                <i className="fas fa-server text-xs"></i>
                            </div>
                            <select
                                value={videoInfo.serverKey}
                                onChange={(e) => onServerChange(e.target.value)}
                                className="bg-blue-900/40 hover:bg-blue-900/60 border border-blue-500/30 rounded-md pl-8 pr-8 py-1.5 text-xs sm:text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[180px] truncate appearance-none transition-colors cursor-pointer"
                                aria-label="Select Server"
                            >
                                {Object.keys(servers).map((key) => (
                                    <option key={key} value={key} className="bg-gray-900 text-white py-1">
                                        {servers[key].name}
                                    </option>
                                ))}
                            </select>
                             <div className="absolute right-3 pointer-events-none text-gray-400">
                                <i className="fas fa-chevron-down text-xs"></i>
                            </div>
                        </div>
                        
                        {/* Download Button */}
                        {currentServer?.downloadSupport && (
                             <button
                                onClick={handleDownload}
                                className="bg-gray-800 text-white rounded-full h-8 w-8 flex items-center justify-center text-sm hover:bg-green-600 transition-colors border border-white/5"
                                title="Download"
                            >
                                <i className="fas fa-download"></i>
                            </button>
                        )}
                        
                        <button
                            onClick={onClose}
                            className="bg-gray-800 text-white rounded-full h-8 w-8 flex items-center justify-center text-lg hover:bg-red-600 transition-colors border border-white/5"
                            title="Close Player"
                        >
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                </div>

                {/* Video Player */}
                <div className="w-full aspect-video relative bg-black flex-1">
                    <iframe
                        id="video-iframe"
                        key={videoInfo.embedUrl} 
                        src={videoInfo.embedUrl}
                        title="Video Player"
                        className="w-full h-full border-0"
                        allowFullScreen
                        referrerPolicy="no-referrer"
                        allow="autoplay; encrypted-media; fullscreen"
                        sandbox="allow-forms allow-pointer-lock allow-same-origin allow-scripts allow-top-navigation-by-user-activation"
                    ></iframe>
                    
                    {/* Status Indicators */}
                    <div className="absolute bottom-4 left-4 flex gap-2 pointer-events-none">
                        {settings.adBlocker && (
                            <div className="bg-green-600/90 backdrop-blur text-white text-[10px] px-2 py-1 rounded-full flex items-center gap-1 shadow-lg">
                                <i className="fas fa-shield-alt"></i>
                                <span>AdBlock</span>
                            </div>
                        )}
                        {settings.vpnMode && (
                             <div className="bg-blue-600/90 backdrop-blur text-white text-[10px] px-2 py-1 rounded-full flex items-center gap-1 shadow-lg">
                                <i className="fas fa-server"></i>
                                <span>VPN</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <style>{`
                @keyframes fade-in {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
                .animate-fade-in {
                    animation: fade-in 0.2s ease-out forwards;
                }
            `}</style>
        </div>
    );
};

export default VideoPlayer;
