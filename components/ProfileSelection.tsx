
import React, { useState } from 'react';
import { UserProfile } from '../types';

interface ProfileSelectionProps {
    profiles: UserProfile[];
    onSelectProfile: (profileId: string) => void;
    onAddProfile: (name: string, avatar: string) => void;
    onDeleteProfile: (profileId: string) => void;
}

const AVATAR_COLORS = [
    // Classic Colors
    'bg-blue-500', 'bg-red-500', 'bg-green-500', 'bg-yellow-500', 
    'bg-purple-500', 'bg-pink-500', 'bg-indigo-500', 'bg-teal-500',
    
    // Extended Palette
    'bg-orange-500', 'bg-cyan-500', 'bg-lime-500', 'bg-emerald-500',
    'bg-sky-500', 'bg-violet-500', 'bg-fuchsia-500', 'bg-rose-500',
    'bg-slate-600', 'bg-stone-500', 'bg-zinc-600', 'bg-neutral-600',
    
    // Light / Pastel
    'bg-blue-300', 'bg-green-300', 'bg-purple-300', 'bg-pink-300', 
    'bg-orange-300', 'bg-teal-300',

    // Vivid Two-Tone Gradients
    'bg-gradient-to-r from-cyan-500 to-blue-500',
    'bg-gradient-to-r from-purple-500 to-pink-500',
    'bg-gradient-to-r from-amber-500 to-orange-500',
    'bg-gradient-to-r from-emerald-500 to-teal-500',
    'bg-gradient-to-r from-indigo-500 to-purple-500',
    'bg-gradient-to-r from-rose-500 to-red-500',
    'bg-gradient-to-r from-fuchsia-600 to-purple-600',
    'bg-gradient-to-r from-blue-400 to-emerald-400',
    'bg-gradient-to-r from-orange-400 to-rose-400',
    'bg-gradient-to-r from-indigo-400 to-cyan-400',
    'bg-gradient-to-r from-gray-700 to-gray-900',
    'bg-gradient-to-r from-slate-900 to-slate-700',

    // Complex / Creative Gradients
    'bg-gradient-to-bl from-gray-900 via-purple-900 to-violet-600', // Cosmic
    'bg-gradient-to-br from-pink-500 via-red-500 to-yellow-500', // Sunset
    'bg-gradient-to-tr from-green-300 via-blue-500 to-purple-600', // Aurora
    'bg-gradient-to-tl from-red-500 via-orange-500 to-yellow-500', // Fire
    'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500', // Twilight
    'bg-gradient-to-bl from-teal-400 via-blue-500 to-indigo-600', // Ocean Depth
    'bg-gradient-to-tr from-yellow-200 via-yellow-400 to-yellow-700', // Gold
    'bg-gradient-to-br from-gray-200 via-gray-400 to-gray-600', // Silver
    'bg-gradient-to-r from-slate-900 via-purple-900 to-slate-900', // Void
];

const ProfileSelection: React.FC<ProfileSelectionProps> = ({ profiles, onSelectProfile, onAddProfile, onDeleteProfile }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [showAddForm, setShowAddForm] = useState(false);
    const [newProfileName, setNewProfileName] = useState('');
    const [selectedAvatar, setSelectedAvatar] = useState(AVATAR_COLORS[0]);

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        if (newProfileName.trim()) {
            onAddProfile(newProfileName.trim(), selectedAvatar);
            setNewProfileName('');
            setShowAddForm(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[60] bg-[#0a0a0a] flex flex-col items-center justify-center animate-fade-in font-sans">
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-12 tracking-tight">Who's watching?</h1>
            
            {!showAddForm ? (
                <>
                    <div className="flex flex-wrap justify-center gap-6 md:gap-8 max-w-4xl px-4">
                        {profiles.map(profile => (
                            <div key={profile.id} className="flex flex-col items-center group relative">
                                <button 
                                    onClick={() => !isEditing && onSelectProfile(profile.id)}
                                    className={`w-24 h-24 md:w-32 md:h-32 rounded-md ${profile.avatar} flex items-center justify-center text-4xl text-white shadow-lg transition-all duration-300 transform group-hover:scale-105 group-hover:ring-4 ring-white/20 relative overflow-hidden`}
                                >
                                    <i className="fas fa-user drop-shadow-md"></i>
                                    {isEditing && (
                                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                            <i className="fas fa-pencil-alt text-xl"></i>
                                        </div>
                                    )}
                                </button>
                                <span className="mt-4 text-gray-400 text-lg group-hover:text-white transition-colors">{profile.name}</span>
                                
                                {isEditing && (
                                    <button 
                                        onClick={() => window.confirm('Delete this profile?') && onDeleteProfile(profile.id)}
                                        className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-8 h-8 flex items-center justify-center hover:bg-red-700 shadow-md z-10"
                                    >
                                        <i className="fas fa-times"></i>
                                    </button>
                                )}
                            </div>
                        ))}

                        {profiles.length < 5 && (
                            <div className="flex flex-col items-center group">
                                <button 
                                    onClick={() => setShowAddForm(true)}
                                    className="w-24 h-24 md:w-32 md:h-32 rounded-md bg-transparent border-2 border-gray-600 flex items-center justify-center text-4xl text-gray-400 group-hover:border-white group-hover:text-white transition-all duration-300"
                                >
                                    <i className="fas fa-plus"></i>
                                </button>
                                <span className="mt-4 text-gray-400 text-lg group-hover:text-white transition-colors">Add Profile</span>
                            </div>
                        )}
                    </div>

                    <button 
                        onClick={() => setIsEditing(!isEditing)}
                        className="mt-16 px-8 py-2 border border-gray-500 text-gray-500 uppercase tracking-widest text-sm font-semibold hover:border-white hover:text-white transition-colors"
                    >
                        {isEditing ? 'Done' : 'Manage Profiles'}
                    </button>
                </>
            ) : (
                <div className="w-full max-w-md p-6 bg-[#1a1a1a] rounded-lg border border-white/10 animate-fade-in">
                    <h2 className="text-2xl font-bold text-white mb-6">Add Profile</h2>
                    <form onSubmit={handleAdd}>
                        <div className="mb-6 flex flex-col items-center">
                            <div className={`w-24 h-24 rounded-md ${selectedAvatar} flex items-center justify-center text-4xl text-white mb-4 shadow-lg ring-2 ring-white/20`}>
                                <i className="fas fa-user drop-shadow-md"></i>
                            </div>
                            <div className="flex gap-2 justify-center flex-wrap max-h-64 overflow-y-auto p-2 scrollbar-hide">
                                {AVATAR_COLORS.map(color => (
                                    <button
                                        key={color}
                                        type="button"
                                        onClick={() => setSelectedAvatar(color)}
                                        className={`w-8 h-8 rounded-full ${color} ${selectedAvatar === color ? 'ring-2 ring-white scale-110 shadow-lg' : 'opacity-70 hover:opacity-100'} transition-all`}
                                    />
                                ))}
                            </div>
                        </div>
                        
                        <div className="mb-6">
                            <input
                                type="text"
                                value={newProfileName}
                                onChange={(e) => setNewProfileName(e.target.value)}
                                placeholder="Name"
                                className="w-full bg-[#2a2a2a] text-white px-4 py-3 rounded-md border border-gray-700 focus:border-blue-500 focus:outline-none"
                                autoFocus
                            />
                        </div>

                        <div className="flex gap-4">
                            <button 
                                type="submit" 
                                disabled={!newProfileName.trim()}
                                className="flex-1 bg-white text-black font-bold py-3 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Save
                            </button>
                            <button 
                                type="button" 
                                onClick={() => setShowAddForm(false)}
                                className="flex-1 border border-gray-500 text-gray-400 font-bold py-3 rounded-md hover:border-white hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </div>
            )}
             <style>{`
                @keyframes fade-in {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
                .animate-fade-in {
                    animation: fade-in 0.3s ease-out forwards;
                }
                .scrollbar-hide::-webkit-scrollbar {
                    display: none;
                }
                .scrollbar-hide {
                    -ms-overflow-style: none;
                    scrollbar-width: none;
                }
            `}</style>
        </div>
    );
};

export default ProfileSelection;
