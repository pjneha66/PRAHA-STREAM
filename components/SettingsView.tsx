import React, { useEffect, useRef, useState } from 'react';
import {
  Blocks, Check, CircleAlert, Database, Download, ExternalLink, Eye, EyeOff, Gauge,
  KeyRound, Keyboard, LoaderCircle, Magnet, MonitorPlay, Package, RefreshCw, RotateCcw,
  Settings, ShieldCheck, Smartphone, Trash2, Tv, Upload, UserPlus, Users,
} from 'lucide-react';
import { tmdbService } from '../services/tmdbService';
import { normalizeCloudStreamServerUrl, testCloudStreamServer } from '../services/cloudstreamServerService';
import { isAndroidApp, isAndroidTv } from '../services/androidBridge';
import { PLAYER_THEMES } from './player/themes';
import type {
  AppSettings, CloudStreamRepository, DebridProvider, InstalledAddon, NuvioRepository,
  PlayerSettings, UserProfile,
} from '../types';

export const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
);

type ApiStatus = 'idle' | 'checking' | 'success' | 'error';

const AVATAR_COLORS = ['#d6f77a', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24', '#34d399'];

const SettingsView: React.FC<{
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onReset: () => void;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  cloudstreamRepositories: CloudStreamRepository[];
  profiles: UserProfile[];
  activeProfile: UserProfile;
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (name: string, avatarColor: string, isKids: boolean) => void;
  onDeleteProfile: (profileId: string) => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
}> = ({
  settings, onChange, onReset, addons, repositories, cloudstreamRepositories,
  profiles, activeProfile, onSelectProfile, onCreateProfile, onDeleteProfile,
  onExportBackup, onImportBackup,
}) => {
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const [apiDraft, setApiDraft] = useState(settings.tmdbApiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiStatus, setApiStatus] = useState<ApiStatus>('idle');
  const [apiMessage, setApiMessage] = useState('');

  const [serverDraft, setServerDraft] = useState(settings.cloudstreamServerUrl || '');
  const [serverStatus, setServerStatus] = useState<ApiStatus>('idle');
  const [serverMessage, setServerMessage] = useState('');

  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileColor, setNewProfileColor] = useState(AVATAR_COLORS[1]);
  const [newProfileKids, setNewProfileKids] = useState(false);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => onChange({ ...settings, [key]: value });
  const updatePlayer = (patch: Partial<PlayerSettings>) => onChange({ ...settings, player: { ...settings.player, ...patch } });

  useEffect(() => setApiDraft(settings.tmdbApiKey || ''), [settings.tmdbApiKey]);
  useEffect(() => setServerDraft(settings.cloudstreamServerUrl || ''), [settings.cloudstreamServerUrl]);

  const testAndSaveServer = async (event: React.FormEvent) => {
    event.preventDefault();
    const serverUrl = normalizeCloudStreamServerUrl(serverDraft);
    if (!serverUrl) {
      setServerStatus('error');
      setServerMessage('Paste your CloudStream plugin server URL first, e.g. http://192.168.1.20:8080.');
      return;
    }
    setServerStatus('checking');
    setServerMessage('');
    try {
      const providers = await testCloudStreamServer(serverUrl);
      update('cloudstreamServerUrl', serverUrl);
      setServerDraft(serverUrl);
      setServerStatus('success');
      setServerMessage(`Connected. The server is running ${providers.length} CloudStream provider${providers.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setServerStatus('error');
      setServerMessage(error instanceof Error ? error.message : 'Could not reach the CloudStream server.');
    }
  };

  const clearServer = () => {
    setServerDraft('');
    setServerStatus('idle');
    setServerMessage('');
    update('cloudstreamServerUrl', '');
  };

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

  const handleAddProfile = (event: React.FormEvent) => {
    event.preventDefault();
    if (!newProfileName.trim()) return;
    onCreateProfile(newProfileName.trim(), newProfileColor, newProfileKids);
    setNewProfileName('');
    setNewProfileKids(false);
  };

  return (
    <div className="standard-page settings-page page-enter">
      <div className="page-heading">
        <div>
          <span className="page-kicker"><Settings size={14} /> MAKE IT YOURS</span>
          <h1>Settings</h1>
          <p>Profiles, Android native playback, Debrid, backups, and your personal TMDB catalog key.</p>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-main">
          {/* Household Profiles */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><Users size={19} /></span>
              <div>
                <h2>Profiles</h2>
                <p>Each profile keeps its own watchlist, statuses, and Continue Watching history.</p>
              </div>
            </div>
            <div className="profiles-list">
              {profiles.map((prof) => (
                <div key={prof.id} className={`profile-row-card ${prof.id === activeProfile.id ? 'active' : ''}`}>
                  <button className="profile-row-select" onClick={() => onSelectProfile(prof.id)}>
                    <span className="avatar" style={{ background: prof.avatarColor, color: '#11150c' }}>
                      {prof.name.charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <strong>{prof.name}</strong>
                      <small>{prof.isKids ? 'Kids profile' : 'Standard profile'}{prof.id === activeProfile.id ? ' · Active' : ''}</small>
                    </div>
                  </button>
                  {prof.id !== 'default' && (
                    <button className="icon-button danger" onClick={() => onDeleteProfile(prof.id)} aria-label={`Delete ${prof.name}`}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <form className="profile-create-form" onSubmit={handleAddProfile}>
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="New profile name (e.g. Living Room, Kids)"
                maxLength={24}
              />
              <div className="profile-color-picks">
                {AVATAR_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={newProfileColor === color ? 'active' : ''}
                    style={{ background: color }}
                    onClick={() => setNewProfileColor(color)}
                    aria-label={`Avatar color ${color}`}
                  />
                ))}
              </div>
              <label className="kids-check">
                <input type="checkbox" checked={newProfileKids} onChange={(e) => setNewProfileKids(e.target.checked)} />
                <span>Kids</span>
              </label>
              <button className="button button-secondary button-small" type="submit">
                <UserPlus size={14} /> Add profile
              </button>
            </form>
          </section>

          {/* TMDB API */}
          <section className="settings-card tmdb-settings-card">
            <div className="settings-card-heading"><span><KeyRound size={19} /></span><div><h2>TMDB API</h2><p>Use your own key for trending titles, search, trailers, cast, episode guides, and ID resolution.</p></div></div>
            <div className="tmdb-intro"><div><strong>Your key. Your metadata.</strong><p>PRAHA does not include a shared API key. Both v3 API keys and v4 read access tokens are supported.</p></div><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a free key <ExternalLink size={13} /></a></div>
            <form className="api-key-form" onSubmit={verifyAndSave}>
              <label htmlFor="tmdb-api-key">TMDB API key or read access token</label>
              <div className="api-key-input"><KeyRound size={16} /><input id="tmdb-api-key" type={showApiKey ? 'text' : 'password'} value={apiDraft} onChange={(event) => { setApiDraft(event.target.value); setApiStatus('idle'); setApiMessage(''); }} placeholder="Paste your personal TMDB key here" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={apiStatus === 'checking'} /><button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? 'Hide TMDB API key' : 'Show TMDB API key'}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <div className="api-key-actions"><button className="button button-primary" type="submit" disabled={apiStatus === 'checking'}>{apiStatus === 'checking' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{apiStatus === 'checking' ? 'Verifying…' : 'Verify & save'}</button>{(settings.tmdbApiKey || apiDraft) && <button className="button button-secondary" type="button" onClick={clearApiKey} disabled={apiStatus === 'checking'}><Trash2 size={15} /> Clear</button>}<span className={`api-saved-state ${settings.tmdbApiKey ? 'active' : ''}`}><i />{settings.tmdbApiKey ? 'Personal key active' : 'No personal key added'}</span></div>
            </form>
            {apiMessage && <p className={`api-key-message ${apiStatus}`} role="status">{apiStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />}{apiMessage}</p>}
            <p className="api-privacy"><ShieldCheck size={14} /><span>Your key is stored only on this device and sent directly to TMDB.</span></p>
          </section>

          {/* Debrid Magnet Streaming */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><Magnet size={19} /></span>
              <div>
                <h2>Debrid & Magnet Streaming</h2>
                <p>Convert torrent & magnet streams into instant 4K direct HTTP streams inside the built-in player.</p>
              </div>
            </div>
            <div className="setting-row">
              <div><strong>Debrid provider</strong><p>Automatically unrestricts cached magnets when pressing play.</p></div>
              <select
                className="settings-select"
                value={settings.debrid.provider}
                onChange={(e) => update('debrid', { ...settings.debrid, provider: e.target.value as DebridProvider })}
              >
                <option value="none">Disabled</option>
                <option value="realdebrid">Real-Debrid</option>
                <option value="alldebrid">AllDebrid</option>
                <option value="torbox">TorBox</option>
              </select>
            </div>
            {settings.debrid.provider !== 'none' && (
              <div className="api-key-form">
                <label htmlFor="debrid-key">Personal {settings.debrid.provider} API token</label>
                <div className="api-key-input">
                  <KeyRound size={16} />
                  <input
                    id="debrid-key"
                    type="password"
                    value={settings.debrid.apiKey}
                    onChange={(e) => update('debrid', { ...settings.debrid, apiKey: e.target.value })}
                    placeholder="Paste your Debrid API token"
                    autoComplete="off"
                  />
                </div>
              </div>
            )}
          </section>

          {/* CloudStream Server */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><Package size={19} /></span><div><h2>CloudStream Server</h2><p>Run native .cs3 providers from a plugin server on your local network or device.</p></div></div>
            <div className="tmdb-intro"><div><strong>Your providers. Executed for real.</strong><p>Connect a CloudStream Web JVM server to execute Kotlin .cs3 plugins directly inside PRAHA.</p></div><a href="https://github.com/SusyBegula/cloudstream-web-unofficial" target="_blank" rel="noreferrer">Get the server <ExternalLink size={13} /></a></div>
            <form className="api-key-form" onSubmit={testAndSaveServer}>
              <label htmlFor="cs-server-url">Plugin server URL</label>
              <div className="api-key-input"><Package size={16} /><input id="cs-server-url" type="text" value={serverDraft} onChange={(event) => { setServerDraft(event.target.value); setServerStatus('idle'); setServerMessage(''); }} placeholder="http://192.168.1.20:8080" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={serverStatus === 'checking'} /></div>
              <div className="api-key-actions"><button className="button button-primary" type="submit" disabled={serverStatus === 'checking'}>{serverStatus === 'checking' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{serverStatus === 'checking' ? 'Testing…' : 'Test & save'}</button>{(settings.cloudstreamServerUrl || serverDraft) && <button className="button button-secondary" type="button" onClick={clearServer} disabled={serverStatus === 'checking'}><Trash2 size={15} /> Clear</button>}<span className={`api-saved-state ${settings.cloudstreamServerUrl ? 'active' : ''}`}><i />{settings.cloudstreamServerUrl ? 'Server connected' : 'No server configured'}</span></div>
            </form>
            {serverMessage && <p className={`api-key-message ${serverStatus}`} role="status">{serverStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />}{serverMessage}</p>}
          </section>

          {/* Backup, Restore & Scrobble Sync */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><RefreshCw size={19} /></span>
              <div>
                <h2>Backup, Restore & Sync</h2>
                <p>Move your entire setup between Web and the PRAHA Android APK, or scrobble to Trakt & Simkl.</p>
              </div>
            </div>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onImportBackup(file);
              }}
            />
            <div className="backup-actions-row">
              <button className="button button-primary" type="button" onClick={onExportBackup}>
                <Download size={16} /> Export full backup (.json)
              </button>
              <button className="button button-secondary" type="button" onClick={() => importFileRef.current?.click()}>
                <Upload size={16} /> Import backup (.json)
              </button>
            </div>
            <div className="sync-grid">
              <label>
                <span>Trakt.tv Client ID (optional)</span>
                <input
                  type="text"
                  value={settings.sync.traktClientId || ''}
                  placeholder="Trakt API client_id"
                  onChange={(e) => update('sync', { ...settings.sync, traktClientId: e.target.value })}
                />
              </label>
              <label>
                <span>Trakt.tv Access Token</span>
                <input
                  type="password"
                  value={settings.sync.traktToken || ''}
                  placeholder="Bearer access token"
                  onChange={(e) => update('sync', { ...settings.sync, traktToken: e.target.value })}
                />
              </label>
              <label>
                <span>Simkl Client ID (optional)</span>
                <input
                  type="text"
                  value={settings.sync.simklClientId || ''}
                  placeholder="Simkl client_id"
                  onChange={(e) => update('sync', { ...settings.sync, simklClientId: e.target.value })}
                />
              </label>
              <label>
                <span>Simkl Access Token</span>
                <input
                  type="password"
                  value={settings.sync.simklToken || ''}
                  placeholder="Simkl access token"
                  onChange={(e) => update('sync', { ...settings.sync, simklToken: e.target.value })}
                />
              </label>
            </div>
          </section>

          {/* Android & TV Experience */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span>{isAndroidTv() ? <Tv size={19} /> : <Smartphone size={19} />}</span>
              <div>
                <h2>Android & TV Experience</h2>
                <p>Native Android stream header proxy, D-Pad TV remote navigation, and fullscreen behavior.</p>
              </div>
            </div>
            <div className="setting-row">
              <div><strong>Android native stream proxy</strong><p>Injects Referer, Origin, and User-Agent headers locally inside the Android APK.</p></div>
              <Toggle checked={settings.preferNativeProxy} onChange={(val) => update('preferNativeProxy', val)} label="Android native stream proxy" />
            </div>
            <div className="setting-row">
              <div><strong>Android TV / D-Pad remote navigation</strong><p>Spatial 2D arrow-key focus movement and high-contrast focus rings for TV remotes.</p></div>
              <Toggle checked={settings.dpadNavigation} onChange={(val) => update('dpadNavigation', val)} label="D-Pad navigation" />
            </div>
            <div className="setting-row">
              <div><strong>Auto-landscape in fullscreen</strong><p>Locks landscape orientation and hides Android status/navigation bars during video playback.</p></div>
              <Toggle checked={settings.player.landscapeLock} onChange={(val) => updatePlayer({ landscapeLock: val })} label="Auto-landscape in fullscreen" />
            </div>
            <div className="setting-row">
              <div><strong>Auto-play next episode</strong><p>Shows Up Next countdown and automatically advances to the next episode of a series.</p></div>
              <Toggle checked={settings.player.autoNextEpisode} onChange={(val) => updatePlayer({ autoNextEpisode: val })} label="Auto-play next episode" />
            </div>
            <div className="setting-row">
              <div><strong>Skip Intro button</strong><p>Queries IntroDB timestamps for series episodes and displays a Skip Intro prompt.</p></div>
              <Toggle checked={settings.player.skipIntro} onChange={(val) => updatePlayer({ skipIntro: val })} label="Skip Intro button" />
            </div>
          </section>

          {/* Playback & Browsing */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Playback & browsing</h2><p>Choose how PRAHA feels as you move through it.</p></div></div>
            <div className="setting-row"><div><strong>Autoplay streams</strong><p>Start playback as soon as a compatible source opens.</p></div><Toggle checked={settings.autoplay} onChange={(value) => update('autoplay', value)} label="Autoplay streams" /></div>
            <div className="setting-row"><div><strong>Compact posters</strong><p>Fit more titles on screen while browsing.</p></div><Toggle checked={settings.compactCards} onChange={(value) => update('compactCards', value)} label="Compact posters" /></div>
            <div className="setting-row"><div><strong>Reduce motion</strong><p>Minimize transitions and animated effects.</p></div><Toggle checked={settings.reduceMotion} onChange={(value) => update('reduceMotion', value)} label="Reduce motion" /></div>
            <div className="setting-row"><div><strong>Preferred audio language</strong><p>Used to prioritize matching streams when available.</p></div><select className="settings-select" value={settings.preferredLanguage} onChange={(event) => update('preferredLanguage', event.target.value)}><option value="en">English</option><option value="hi">Hindi</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="other">Other</option></select></div>
          </section>

          {/* Player */}
          <section className="settings-card player-settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Player</h2><p>Built-in HLS, DASH (.mpd), and MPEG-TS player modelled on mpvRx.</p></div></div>
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
            <div className="setting-row"><div><strong>Seek step</strong><p>Seconds used by the back/forward buttons and ← / → keys.</p></div><select className="settings-select" value={settings.player.seekStep} onChange={(event) => updatePlayer({ seekStep: Number(event.target.value) })}>{[5, 10, 15, 30, 60].map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></div>
            <div className="setting-row"><div><strong>Controller auto-hide</strong><p>How long the on-screen controller stays visible.</p></div><select className="settings-select" value={settings.player.oscTimeout} onChange={(event) => updatePlayer({ oscTimeout: Number(event.target.value) })}>{[[1500, '1.5 seconds'], [2600, '2.5 seconds'], [4000, '4 seconds'], [0, 'Always visible']].map(([value, label]) => <option key={String(value)} value={value}>{label}</option>)}</select></div>
            <div className="setting-row"><div><strong>Subtitle size</strong><p>Applied to every subtitle track while playing.</p></div><select className="settings-select" value={settings.player.subtitleSize} onChange={(event) => updatePlayer({ subtitleSize: Number(event.target.value) })}>{[75, 100, 125, 150, 200].map((value) => <option key={value} value={value}>{value}%</option>)}</select></div>
            <div className="setting-row"><div><strong>Touch gestures</strong><p>Double-tap zones to seek, swipe for volume and brightness, long-press for 2× speed.</p></div><Toggle checked={settings.player.gestures} onChange={(value) => updatePlayer({ gestures: value })} label="Touch gestures" /></div>
            <div className="setting-row"><div><strong>Statistics overlay</strong><p>Start playback with the mpv-style stats panel open.</p></div><Toggle checked={settings.player.stats} onChange={(value) => updatePlayer({ stats: value })} label="Statistics overlay" /></div>
            <p className="player-shortcut-note"><Keyboard size={14} /><span>Shortcuts: <kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> seek · <kbd>Z</kbd><kbd>X</kbd> sub delay · <kbd>N</kbd> next ep · <kbd>F</kbd> fullscreen · <kbd>?</kbd> full list.</span></p>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><span><Gauge size={19} /></span><div><h2>Appearance</h2><p>A cinematic canvas with your own accent.</p></div></div>
            <div className="setting-row"><div><strong>Accent color</strong><p>Used for actions, progress, and active navigation.</p></div><div className="accent-options">{(['lime', 'violet', 'blue'] as const).map((accent) => <button key={accent} className={`accent-${accent} ${settings.accent === accent ? 'active' : ''}`} onClick={() => update('accent', accent)} aria-label={`${accent} accent`}>{settings.accent === accent && <Check size={15} />}</button>)}</div></div>
          </section>
        </div>

        <aside className="settings-side">
          <section className="settings-card source-summary-card">
            <span className="settings-side-icon"><Database size={21} /></span>
            <h2>Your setup</h2>
            <div className="setup-stat"><span>Platform</span><strong>{isAndroidTv() ? 'Android TV' : isAndroidApp() ? 'Android APK' : 'Web / PWA'}</strong></div>
            <div className="setup-stat"><span>Active profile</span><strong>{activeProfile.name}</strong></div>
            <div className="setup-stat"><span>Stremio addons</span><strong>{addons.length}</strong></div>
            <div className="setup-stat"><span>Nuvio providers</span><strong>{repositories.reduce((sum, repo) => sum + repo.scrapers.length, 0)}</strong></div>
            <div className="setup-stat"><span>CloudStream extensions</span><strong>{cloudstreamRepositories.reduce((sum, repo) => sum + repo.providers.length, 0)}</strong></div>
            <div className="setup-stat"><span>Debrid</span><strong>{settings.debrid.provider === 'none' ? 'Off' : settings.debrid.provider}</strong></div>
            <div className="setup-stat"><span>TMDB API</span><strong>{settings.tmdbApiKey ? 'Own key' : 'Not set'}</strong></div>
            <p><Blocks size={14} /> Export a JSON backup anytime to mirror this setup across devices.</p>
          </section>
          <section className="settings-card privacy-card"><span className="settings-side-icon"><ShieldCheck size={21} /></span><h2>Private by design</h2><p>Your library, profiles, history, API keys, and extension settings stay local on your device.</p></section>
          <button className="reset-button" onClick={onReset}><RotateCcw size={15} /> Reset preferences</button>
          <span className="version-label">PRAHA STREAM · 2.1.0</span>
        </aside>
      </div>
    </div>
  );
};

export default SettingsView;
