
import React from 'react';
import { Settings } from '../../types';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: Settings;
    onSettingsChange: (newSettings: Settings) => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, onSettingsChange }) => {
    if (!isOpen) return null;

    const handleChange = (key: keyof Settings, value: any) => {
        onSettingsChange({ ...settings, [key]: value });
    };

    const renderToggle = (key: keyof Settings, label: string, description: string) => (
        <div className="flex justify-between items-center p-2 rounded-md hover:bg-white/5 transition-colors">
            <div>
                <label htmlFor={key} className="text-gray-200">{label}</label>
                <p className="text-xs text-gray-400">{description}</p>
            </div>
            <button
                id={key}
                onClick={() => handleChange(key, !settings[key])}
                className={`w-14 h-8 rounded-full p-1 transition-colors ${settings[key] ? 'bg-blue-600' : 'bg-gray-600'}`}
            >
                <span className={`block w-6 h-6 rounded-full bg-white transform transition-transform ${settings[key] ? 'translate-x-6' : ''}`}></span>
            </button>
        </div>
    );

    const renderSelect = (key: keyof Settings, label: string, options: {value: string, label: string}[], disabled: boolean = false) => (
        <div className={`flex justify-between items-center p-2 rounded-md ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
            <label htmlFor={key} className="text-gray-200">{label}</label>
            <select
                id={key}
                value={settings[key] as string}
                onChange={(e) => handleChange(key, e.target.value)}
                disabled={disabled}
                className="bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed"
            >
                {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
        </div>
    );


    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex justify-center items-center z-50 p-4 animate-fade-in">
            <div className="bg-[#1a1a1a] w-full max-w-lg p-6 rounded-lg shadow-2xl border border-white/10">
                <div className="flex justify-between items-center border-b border-white/10 pb-4 mb-6">
                    <h2 className="text-xl font-bold text-white"><i className="fas fa-cog mr-2"></i>Settings</h2>
                    <button onClick={onClose} className="text-2xl hover:text-gray-300 transition-colors"><i className="fas fa-times"></i></button>
                </div>
                
                <div className="space-y-4">
                    {renderToggle('autoDarkMode', 'Auto Dark Mode', 'Automatically switch theme based on system settings.')}
                    {renderSelect('theme', 'Theme', [
                        { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' },
                        { value: 'blue', label: 'Blue' }, { value: 'purple', label: 'Purple' },
                    ], settings.autoDarkMode)}
                    {renderToggle('adBlocker', 'Ad Blocker', 'Blocks requests to known ad domains.')}
                    {renderToggle('vpnMode', 'VPN Mode (Proxy)', 'Routes player via a proxy to bypass region locks.')}
                    {renderToggle('trackHistory', 'Track Watch History', 'Saves your watched movies and shows.')}
                    {renderToggle('privacyMode', 'Privacy Mode', 'Blurs content cards for privacy.')}
                </div>

                <div className="mt-8 text-right">
                    <button onClick={onClose} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-6 rounded-lg transition-colors">
                        Done
                    </button>
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

export default SettingsModal;
