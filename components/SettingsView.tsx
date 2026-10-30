import React, { useEffect, useState } from 'react';
import {
  Blocks, Check, CircleAlert, Database, ExternalLink, Eye, EyeOff, Gauge,
  KeyRound, Keyboard, LoaderCircle, MonitorPlay, Package, RotateCcw, Settings, ShieldCheck, Trash2,
} from 'lucide-react';
import { tmdbService } from '../services/tmdbService';
import { PLAYER_THEMES } from './player/themes';
import type { AppSettings, CloudStreamRepository, InstalledAddon, NuvioRepository, PlayerSettings } from '../types';

export const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
);

type ApiStatus = 'idle' | 'checking' | 'success' | 'error';

const SettingsView: React.FC<{
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onReset: () => void;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  cloudstreamRepositories: CloudStreamRepository[];
}> = ({ settings, onChange, onReset, addons, repositories, cloudstreamRepositories }) => {
  const [apiDraft, setApiDraft] = useState(settings.tmdbApiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>('idle');
  const [apiMessage, setApiMessage] = useState('');
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => onChange({ ...settings, [key]: value });
  const updatePlayer = (patch: Partial<PlayerSettings>) => onChange({ ...settings, player: { ...settings.player, ...patch } });

  useEffect(() => setApiDraft(settings.tmdbApiKey || ''), [settings.tmdbApiKey]);

  const verifyAndSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const apiKey = apiDraft.trim();
    if (!apiKey) {
      setApiStatus('error');
      setApiMessage('Paste your TMDB API key or read access token first.');
      return;
    }
    setApiStatus('checking');
    setApiMessage('');
    try {
      await tmdbService.validateApiKey(apiKey);
      onChange({ ...settings, tmdbApiKey: apiKey });
      setApiStatus('success');
      setApiMessage('Your personal TMDB key is verified and active.');
    } catch (error) {
      setApiStatus('error');
      setApiMessage(error instanceof Error ? error.message : 'TMDB could not verify this key. Check it and try again.');
    }
  };

  const clearApiKey = () => {
    setApiDraft('');
    setShowApiKey(false);
    setApiStatus('idle');
    setApiMessage('');
    update('tmdbApiKey', '');
  };

  return (
    <div className="standard-page settings-page page-enter">
      <div className="page-heading"><div><span className="page-kicker"><Settings size={14} /> MAKE IT YOURS</span><h1>Settings</h1><p>A few small tweaks for a better night in. Everything is saved on this device.</p></div></div>
      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card tmdb-settings-card">
            <div className="settings-card-heading"><span><KeyRound size={19} /></span><div><h2>TMDB API</h2><p>Use your own key for trending titles, search, metadata, and ID resolution.</p></div></div>
            <div className="tmdb-intro"><div><strong>Your key. Your metadata.</strong><p>PRAHA does not include a shared API key. Both v3 API keys and v4 read access tokens are supported.</p></div><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a free key <ExternalLink size={13} /></a></div>
            <form className="api-key-form" onSubmit={verifyAndSave}>
              <label htmlFor="tmdb-api-key">TMDB API key or read access token</label>
              <div className="api-key-input"><KeyRound size={16} /><input id="tmdb-api-key" type={showApiKey ? 'text' : 'password'} value={apiDraft} onChange={(event) => { setApiDraft(event.target.value); setApiStatus('idle'); setApiMessage(''); }} placeholder="Paste your personal TMDB key here" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={apiStatus === 'checking'} /><button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? 'Hide TMDB API key' : 'Show TMDB API key'}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <div className="api-key-actions"><button className="button button-primary" type="submit" disabled={apiStatus === 'checking'}>{apiStatus === 'checking' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{apiStatus === 'checking' ? 'Verifying…' : 'Verify & save'}</button>{(settings.tmdbApiKey || apiDraft) && <button className="button button-secondary" type="button" onClick={clearApiKey} disabled={apiStatus === 'checking'}><Trash2 size={15} /> Clear</button>}<span className={`api-saved-state ${settings.tmdbApiKey ? 'active' : ''}`}><i />{settings.tmdbApiKey ? 'Personal key active' : 'No personal key added'}</span></div>
            </form>
            {apiMessage && <p className={`api-key-message ${apiStatus}`} role="status">{apiStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />}{apiMessage}</p>}
            <p className="api-privacy"><ShieldCheck size={14} /><span>Your key is stored only in this browser and sent directly to TMDB. Installed Nuvio providers can also access it through their standard <code>TMDB_API_KEY</code> runtime binding, so only install providers you trust.</span></p>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Playback & browsing</h2><p>Choose how PRAHA feels as you move through it.</p></div></div>
            <div className="setting-row"><div><strong>Autoplay streams</strong><p>Start playback as soon as a compatible source opens.</p></div><Toggle checked={settings.autoplay} onChange={(value) => update('autoplay', value)} label="Autoplay streams" /></div>
            <div className="setting-row"><div><strong>Compact posters</strong><p>Fit more titles on screen while browsing.</p></div><Toggle checked={settings.compactCards} onChange={(value) => update('compactCards', value)} label="Compact posters" /></div>
            <div className="setting-row"><div><strong>Reduce motion</strong><p>Minimize transitions and animated effects.</p></div><Toggle checked={settings.reduceMotion} onChange={(value) => update('reduceMotion', value)} label="Reduce motion" /></div>
            <div className="setting-row"><div><strong>Preferred audio language</strong><p>Used to prioritize matching streams when available.</p></div><select className="settings-select" value={settings.preferredLanguage} onChange={(event) => update('preferredLanguage', event.target.value)}><option value="en">English</option><option value="hi">Hindi</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="other">Other</option></select></div>
          </section>

          <section className="settings-card player-settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Player</h2><p>The built-in player follows mpvRx: on-screen controller, mpv key bindings, gesture zones, and themes.</p></div></div>
            <div className="setting-row"><div><strong>Controller theme</strong><p>Colors the on-screen controller, menus, and statistics overlay.</p></div></div>
            <div className="player-theme-grid">
              {PLAYER_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  className={`player-theme-swatch ${settings.player.theme === theme.id ? 'active' : ''}`}
                  style={{ ['--swatch-bg' as string]: theme.vars['--osc-solid'], ['--swatch-accent' as string]: theme.vars['--osc-accent'], ['--swatch-fg' as string]: theme.vars['--osc-fg'] }}
                  onClick={() => updatePlayer({ theme: theme.id })}
                  aria-label={`${theme.name} player theme`}
                >
                  <span className="player-theme-bar" />
                  <em>{theme.name}</em>
                  {settings.player.theme === theme.id && <Check size={13} />}
                </button>
              ))}
            </div>
            <div className="setting-row"><div><strong>Seek step</strong><p>Seconds used by the back/forward buttons and the ← / → keys.</p></div><select className="settings-select" value={settings.player.seekStep} onChange={(event) => updatePlayer({ seekStep: Number(event.target.value) })}>{[5, 10, 15, 30, 60].map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></div>
            <div className="setting-row"><div><strong>Controller auto-hide</strong><p>How long the on-screen controller stays after you move the pointer.</p></div><select className="settings-select" value={settings.player.oscTimeout} onChange={(event) => updatePlayer({ oscTimeout: Number(event.target.value) })}>{[[1500, '1.5 seconds'], [2600, '2.5 seconds'], [4000, '4 seconds'], [0, 'Always visible']].map(([value, label]) => <option key={String(value)} value={value}>{label}</option>)}</select></div>
            <div className="setting-row"><div><strong>Subtitle size</strong><p>Applied to every subtitle track while playing.</p></div><select className="settings-select" value={settings.player.subtitleSize} onChange={(event) => updatePlayer({ subtitleSize: Number(event.target.value) })}>{[75, 100, 125, 150, 200].map((value) => <option key={value} value={value}>{value}%</option>)}</select></div>
            <div className="setting-row"><div><strong>Touch gestures</strong><p>Double-tap zones to seek, swipe for volume and brightness, long-press for 2× speed.</p></div><Toggle checked={settings.player.gestures} onChange={(value) => updatePlayer({ gestures: value })} label="Touch gestures" /></div>
            <div className="setting-row"><div><strong>Statistics overlay</strong><p>Start playback with the mpv-style stats panel open.</p></div><Toggle checked={settings.player.stats} onChange={(value) => updatePlayer({ stats: value })} label="Statistics overlay" /></div>
            <p className="player-shortcut-note"><Keyboard size={14} /><span>Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> seek · <kbd>↑</kbd><kbd>↓</kbd> volume · <kbd>F</kbd> fullscreen · <kbd>J</kbd> subtitles · <kbd>#</kbd> audio · <kbd>I</kbd> stats · <kbd>?</kbd> full list.</span></p>
          </section>
          <section className="settings-card">
            <div className="settings-card-heading"><span><Gauge size={19} /></span><div><h2>Appearance</h2><p>A cinematic canvas with your own accent.</p></div></div>
            <div className="setting-row"><div><strong>Accent color</strong><p>Used for actions, progress, and active navigation.</p></div><div className="accent-options">{(['lime', 'violet', 'blue'] as const).map((accent) => <button key={accent} className={`accent-${accent} ${settings.accent === accent ? 'active' : ''}`} onClick={() => update('accent', accent)} aria-label={`${accent} accent`}>{settings.accent === accent && <Check size={15} />}</button>)}</div></div>
          </section>
        </div>
        <aside className="settings-side">
          <section className="settings-card source-summary-card"><span className="settings-side-icon"><Database size={21} /></span><h2>Your setup</h2><div className="setup-stat"><span>Stremio addons</span><strong>{addons.length}</strong></div><div className="setup-stat"><span>Nuvio repositories</span><strong>{repositories.length}</strong></div><div className="setup-stat"><span>Nuvio providers</span><strong>{repositories.reduce((sum, repo) => sum + repo.scrapers.length, 0)}</strong></div><div className="setup-stat"><span>CloudStream extensions</span><strong>{cloudstreamRepositories.reduce((sum, repo) => sum + repo.providers.length, 0)}</strong></div><div className="setup-stat"><span>TMDB API</span><strong>{settings.tmdbApiKey ? 'Own key' : 'Not set'}</strong></div><p><Blocks size={14} /> Sources sync with this local profile.</p></section>
          <section className="settings-card privacy-card"><span className="settings-side-icon"><ShieldCheck size={21} /></span><h2>Private by design</h2><p>Your library, history, API key, and extension settings stay in this browser. PRAHA does not operate a tracking account.</p></section>
          <button className="reset-button" onClick={onReset}><RotateCcw size={15} /> Reset preferences</button>
          <span className="version-label">PRAHA STREAM · 2.0.0</span>
        </aside>
      </div>
    </div>
  );
};

export default SettingsView;
