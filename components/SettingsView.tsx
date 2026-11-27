import React, { useEffect, useRef, useState } from 'react';
import { readBadgeRules, saveBadgeRules, type BadgeRule } from '../services/badgeRules';
import { hashPin } from '../services/profilePin';
import {
  Blocks, Check, CircleAlert, Database, Download, ExternalLink, Eye, EyeOff, Gauge, Globe,
  KeyRound, Keyboard, LoaderCircle, Magnet, MonitorPlay, Package, RefreshCw, RotateCcw, Server,
  Settings, ShieldCheck, Smartphone, Sparkles, Trash2, Tv, Upload, UserPlus, Users, Wifi,
} from 'lucide-react';
import { tmdbService } from '../services/tmdbService';
import { IMDX_DOCS_URL, imdxService, normalizeImdxBaseUrl } from '../services/imdxService';
import { checkAppDns, isAndroidApp, isAndroidTv, openPrivateDnsSettings, setVpnEnabled, getVpnStatus } from '../services/androidBridge';
import { NETWORK_CONDITION_COPY, probeNetworkCondition, type NetworkCondition } from '../services/networkCondition';
import { confirmAdultMode, NSFW_COPY } from '../services/nsfwGate';
import { TorrentStreamingEngine } from '../services/torrentStreamingService';
import { torrServerController } from '../services/p2p/torrServerController';
import type { TorrServerStatus } from '../services/p2p/torrServerBridge';
import { PLAYER_THEMES } from './player/themes';
import JellyfinSettings from './JellyfinSettings';
import type { JellyfinSnapshot } from '../services/jellyfinService';
import { PROFILE_PALETTE, ProfileAvatar } from './ProfilePicker';
import {
  APP_VERSION,
  AppSettings, AppThemeAccent, DebridProvider, InstalledAddon, NsfwMode, NuvioRepository,
  PlayerEngineId, PlayerSettings, UserProfile,
} from '../types';

export const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
);

type ApiStatus = 'idle' | 'checking' | 'success' | 'error';

const AVATAR_COLORS = PROFILE_PALETTE;

const THEME_ACCENTS: Array<{ id: AppThemeAccent; label: string; color: string }> = [
  { id: 'gold', label: 'Gold', color: '#FFD45C' },
  { id: 'jade', label: 'Jade', color: '#7BF08D' },
  { id: 'rosegold', label: 'Rose Gold', color: '#FFB37A' },
  { id: 'arcticblue', label: 'Arctic Blue', color: '#4DE3FF' },
  { id: 'graphite', label: 'Graphite', color: '#F3F5F7' },
  { id: 'crimson', label: 'Crimson', color: '#FF5252' },
  { id: 'ocean', label: 'Ocean', color: '#42A5F5' },
  { id: 'violet', label: 'Violet', color: '#AB47BC' },
  { id: 'emerald', label: 'Emerald', color: '#66BB6A' },
  { id: 'amber', label: 'Amber', color: '#FFA726' },
  { id: 'rose', label: 'Rose', color: '#EC407A' },
  { id: 'white', label: 'White', color: '#F5F5F5' },
  { id: 'lime', label: 'Lime', color: '#a2f244' },
];


/** Group jump-chips (port of Nuvio's categorized settings tree, light-touch):
    quick anchors to each settings card group. */
const SETTINGS_GROUPS: Array<[string, string]> = [
  ['Profiles', 'Profiles'],
  ['TMDB API', 'TMDB'],
  ['IMDx · Tiffara (optional)', 'IMDx'],
  ['Backup, Restore & Sync', 'Backup'],
  ['Android & TV Experience', 'Android/TV'],
  ['Private DNS', 'Device DNS'],
  ['DNS over HTTPS', 'App DNS'],
  ['VPN', 'VPN'],
  ['Network & Torrent Engine', 'Torrent · free'],
  ['Debrid & Magnet Streaming', 'Debrid · paid'],
  ['Playback & browsing', 'Playback'],
  ['Player', 'Player'],
  ['Appearance & Palette', 'Appearance'],
  ['Navigation', 'Navigation'],
];

/** Clear paid-vs-self-hosted labelling for source/network settings. */
const SourceKindBadge: React.FC<{ kind: 'paid' | 'free' }> = ({ kind }) => (
  <span className={`source-kind-badge ${kind}`}>{kind === 'paid' ? 'PAID' : 'FREE · SELF-HOSTED'}</span>
);

const SettingsJumpChips: React.FC = () => {
  const jump = (heading: string) => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.settings-card'));
    // Headings may contain a trailing paid/free badge, so match the prefix.
    const target = cards.find((card) => {
      const text = card.querySelector('h2')?.textContent || '';
      return text === heading || text.startsWith(`${heading} `);
    });
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="filter-pills settings-jump-chips" style={{ marginBottom: '16px' }}>
      {SETTINGS_GROUPS.map(([heading, label]) => (
        <button key={heading} onClick={() => jump(heading)}>{label}</button>
      ))}
    </div>
  );
};

/** Settings search (port of Nuvio's SettingsSearch): filters settings cards by keyword. */
const hiddenNavDefaults = (): string[] => {
  try {
    const raw = localStorage.getItem('praha.nav.hidden.v1');
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

const SettingsSearchBox: React.FC = () => {
  const [term, setTerm] = React.useState('');
  React.useEffect(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.settings-card'));
    const q = term.trim().toLowerCase();
    cards.forEach((card) => {
      if (!q) { card.style.display = ''; return; }
      const text = (card.textContent || '').toLowerCase();
      card.style.display = text.includes(q) ? '' : 'none';
    });
    return () => { cards.forEach((card) => { card.style.display = ''; }); };
  }, [term]);
  return (
    <div style={{ position: 'relative', marginBottom: '16px' }}>
      <input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search settings…"
        aria-label="Search settings"
        style={{ width: '100%', padding: '10px 40px 10px 14px', borderRadius: '10px', border: term ? '1px solid #58a6ff' : '1px solid var(--line-strong, #30363d)', background: 'var(--surface, #161b22)', color: 'var(--text, #f0f6fc)', fontSize: '13px', outline: 'none' }}
      />
      {term && (
        <button onClick={() => setTerm('')} aria-label="Clear settings search" style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '12px' }}>
          Clear
        </button>
      )}
    </div>
  );
};

/** Stream badge rules editor (port of Nuvio's badge packs): one rule per line —
    /regex/ | Label | #color. Rules show as colored badges in the source list. */
const BadgeRulesEditor: React.FC = () => {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [rules, setRules] = React.useState<BadgeRule[]>(() => readBadgeRules());

  const openEditor = () => {
    setDraft(rules.map((rule) => `${rule.pattern} | ${rule.label} | ${rule.color}`).join('\n'));
    setOpen(true);
  };

  const save = () => {
    const parsed: BadgeRule[] = [];
    draft.split('\n').forEach((line) => {
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length >= 2 && parts[0] && parts[1]) {
        parsed.push({ pattern: parts[0], label: parts[1], color: parts[2] || '#58a6ff' });
      }
    });
    saveBadgeRules(parsed);
    setRules(parsed);
    setOpen(false);
  };

  return (
    <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div><strong>Stream badge rules</strong><p>Color-tag streams in the source list — one rule per line: <code>pattern | Label | #color</code>. {rules.length ? `(${rules.length} active)` : ''}</p></div>
        <button className="button button-secondary button-small" onClick={open ? save : openEditor}>{open ? 'Save rules' : 'Edit rules'}</button>
      </div>
      {open && (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={'4k|4K UHD|#f5c518\nhevc|HEVC|#3fb950'}
          style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--line-strong, #30363d)', background: 'var(--surface, #161b22)', color: 'var(--text, #f0f6fc)', fontSize: '12px', fontFamily: 'monospace', resize: 'vertical' }}
        />
      )}
    </div>
  );
};


const SettingsView: React.FC<{
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onReset: () => void;
  addons: InstalledAddon[];
  repositories: NuvioRepository[];
  profiles: UserProfile[];
  activeProfile: UserProfile;
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (name: string, avatarColor: string, isKids: boolean) => void;
  onUpdateProfile: (profileId: string, patch: Partial<Pick<UserProfile, 'name' | 'avatarColor' | 'isKids' | 'avatarIcon' | 'avatarImage' | 'pinHash'>>) => void;
  onDeleteProfile: (profileId: string) => void;
  onOpenProfilePicker?: () => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  jellyfinSnapshot: JellyfinSnapshot | null;
  onJellyfinSnapshotChange: (snapshot: JellyfinSnapshot | null) => void;
  onCheckUpdates?: () => void;
}> = ({
  settings, onChange, onReset, addons, repositories,
  profiles, activeProfile, onSelectProfile, onCreateProfile, onDeleteProfile, onOpenProfilePicker, onUpdateProfile,
  onExportBackup, onImportBackup, jellyfinSnapshot, onJellyfinSnapshotChange,
  onCheckUpdates,
}) => {
  const [hiddenNav, setHiddenNav] = useState<string[]>(hiddenNavDefaults);
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const [apiDraft, setApiDraft] = useState(settings.tmdbApiKey || '');
  const [showApiKey, setShowApiKey] = useState(false);
  const [imdxBaseDraft, setImdxBaseDraft] = useState(settings.imdx.baseUrl);
  const [imdxKeyDraft, setImdxKeyDraft] = useState(settings.imdx.apiKey || '');
  const [showImdxKey, setShowImdxKey] = useState(false);
  const [imdxStatus, setImdxStatus] = useState<ApiStatus>('idle');
  const [imdxMessage, setImdxMessage] = useState('');
  const [dnsOpenError, setDnsOpenError] = useState(false);
  const [dnsCopied, setDnsCopied] = useState(false);
  const [dnsTest, setDnsTest] = useState<{ provider: string; result: 'checking' | 'ok' | 'error' } | null>(null);
  const testDns = async () => {
    const provider = settings.dnsProvider || 'system';
    setDnsTest({ provider, result: 'checking' });
    const ok = await checkAppDns(provider).catch(() => false);
    setDnsTest({ provider, result: ok ? 'ok' : 'error' });
  };
  const [vpnBusy, setVpnBusy] = useState(false);
  const [vpnRunning, setVpnRunning] = useState(false);
  const [vpnError, setVpnError] = useState('');
  const [networkCondition, setNetworkCondition] = useState<NetworkCondition | null>(null);
  const [networkChecking, setNetworkChecking] = useState(false);
  const [torrentHostDraft, setTorrentHostDraft] = useState(() => TorrentStreamingEngine.getHost());
  const [torrSupported] = useState(() => torrServerController.isSupported());
  const [torrStatus, setTorrStatus] = useState<TorrServerStatus | null>(null);
  const [torrBusy, setTorrBusy] = useState(false);
  const [torrentHostStatus, setTorrentHostStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [torrentHostMessage, setTorrentHostMessage] = useState('');
  const [apiStatus, setApiStatus] = useState<ApiStatus>('idle');
  const [apiMessage, setApiMessage] = useState('');

  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileColor, setNewProfileColor] = useState(AVATAR_COLORS[1]);
  const [newProfileKids, setNewProfileKids] = useState(false);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => onChange({ ...settings, [key]: value });
  const updatePlayer = (patch: Partial<PlayerSettings>) => onChange({ ...settings, player: { ...settings.player, ...patch } });

  /** Kids profiles can never see adult content, whatever is saved. */
  const kidsProfile = Boolean(activeProfile?.isKids);

  const requestNsfwMode = (mode: NsfwMode) => {
    if (confirmAdultMode(mode)) update('nsfw', mode);
  };

  /**
   * The toggle reflects the real tunnel, not just the saved preference: the
   * user can turn the VPN off from Android's own settings, and a stale "on"
   * would be a lie. Consent is a one-time system dialog, so the first flip
   * lands on "not running yet" and we poll briefly for the user's answer.
   */
  const toggleVpn = async (next: boolean, resolver?: string) => {
    setVpnError('');
    if (!isAndroidApp()) {
      setVpnError('The VPN tunnel needs the Android app.');
      return;
    }
    setVpnBusy(true);
    try {
      update('vpnEnabled', next);
      // The service restarts itself when the resolver differs, so a single
      // call is enough — sending STOP then START separately would race.
      await setVpnEnabled(next, resolver || settings.vpnDnsServer || '1.1.1.1');
      let running = await getVpnStatus();
      // The consent dialog is the user's to read; 30s is generous enough that a
      // timeout means a real refusal rather than someone taking their time.
      for (let attempt = 0; next && !running && attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        running = await getVpnStatus();
      }
      setVpnRunning(running);
      if (next && !running) {
        update('vpnEnabled', false);
        setVpnError('The tunnel did not start. Allow the VPN request when Android asks, then switch it on again.');
      }
    } finally {
      setVpnBusy(false);
    }
  };

  // Reflect a tunnel the user started or stopped outside the app.
  useEffect(() => {
    if (!isAndroidApp()) return;
    let cancelled = false;
    const sync = () => {
      void getVpnStatus().then((on) => {
        if (cancelled) return;
        setVpnRunning(on);
        // The tunnel can come up after a slow consent tap; a stale "did not
        // start" error would then contradict the toggle.
        if (on) setVpnError('');
      });
    };
    sync();
    const timer = window.setInterval(sync, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);


  useEffect(() => setApiDraft(settings.tmdbApiKey || ''), [settings.tmdbApiKey]);
  useEffect(() => { setImdxBaseDraft(settings.imdx.baseUrl); setImdxKeyDraft(settings.imdx.apiKey || ''); }, [settings.imdx.baseUrl, settings.imdx.apiKey]);

  // The bundled engine outlives this screen — it can be started by a playback,
  // or by "Save & test" — so the status has to be read when the screen opens
  // rather than assumed to be "Stopped" from a null initial value.
  useEffect(() => {
    if (!torrSupported) return;
    let cancelled = false;
    void torrServerController.status().then((status) => {
      if (!cancelled) setTorrStatus(status);
    });
    return () => { cancelled = true; };
  }, [torrSupported]);

  const updateImdx = (patch: Partial<AppSettings['imdx']>) => onChange({ ...settings, imdx: { ...settings.imdx, ...patch } });

  const checkNetworkCondition = async () => {
    setNetworkChecking(true);
    setNetworkCondition(null);
    try {
      const condition = await probeNetworkCondition({ fresh: true });
      setNetworkCondition(condition);
    } finally {
      setNetworkChecking(false);
    }
  };

  const saveTorrentHost = async (testAfterSave = false) => {
    const host = (torrentHostDraft || '').trim().replace(/\/$/, '') || 'http://127.0.0.1:8090';
    setTorrentHostDraft(host);
    TorrentStreamingEngine.setHost(host);
    setTorrentHostStatus('idle');
    setTorrentHostMessage(testAfterSave ? '' : 'Saved torrent engine host.');
    if (!testAfterSave) {
      window.setTimeout(() => setTorrentHostMessage(''), 2500);
      return;
    }
    setTorrentHostStatus('checking');
    setTorrentHostMessage('');
    const ok = await TorrentStreamingEngine.checkEngineAvailable(host);
    setTorrentHostStatus(ok ? 'ok' : 'error');
    setTorrentHostMessage(ok ? 'Torrent engine reachable.' : 'Could not reach a TorrServer-compatible engine at this host. Make sure it is running and accessible from this device.');
    // The test may just have started the bundled engine, so re-read its status.
    // Without this the badge kept saying "Stopped" beside a green "reachable"
    // message, which reads as a contradiction.
    if (ok && torrSupported) setTorrStatus(await torrServerController.status());
  };

  const toggleBundledTorrServer = async () => {
    setTorrBusy(true);
    try {
      if (torrStatus?.running) {
        await torrServerController.stop();
      } else {
        await torrServerController.ensureStarted();
      }
      setTorrStatus(await torrServerController.status());
    } finally {
      setTorrBusy(false);
    }
  };

  const verifyImdx = async (event: React.FormEvent) => {
    event.preventDefault();
    setImdxStatus('checking');
    setImdxMessage('');
    try {
      const baseUrl = normalizeImdxBaseUrl(imdxBaseDraft);
      await imdxService.verify({ enabled: true, baseUrl, apiKey: imdxKeyDraft.trim() });
      updateImdx({ enabled: true, baseUrl, apiKey: imdxKeyDraft.trim() });
      setImdxStatus('success');
      setImdxMessage('IMDx answered. IMDb-style metadata is now available alongside TMDB.');
    } catch (error) {
      setImdxStatus('error');
      setImdxMessage(error instanceof Error ? error.message : 'IMDx could not verify this endpoint.');
    }
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
          <SettingsSearchBox />
          <SettingsJumpChips />
          {/* Household Profiles */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><Users size={19} /></span>
              <div>
                <h2>Profiles</h2>
                <p>Each profile keeps its own watchlist, statuses, and Continue Watching history.</p>
              </div>
              {onOpenProfilePicker && (
                <button type="button" className="button button-secondary button-small settings-heading-action" onClick={onOpenProfilePicker}>
                  <Users size={14} /> Who’s watching?
                </button>
              )}
            </div>
            <div className="setting-row">
              <div>
                <strong>Ask “Who’s watching?” on launch</strong>
                <p>Show the Netflix-style profile selection screen whenever you open PRAHA STREAM.</p>
              </div>
              <Toggle
                checked={settings.askProfileOnStartup !== false}
                onChange={(checked) => update('askProfileOnStartup', checked)}
                label="Ask Who's watching on launch"
              />
            </div>
            <div className="profiles-list">
              {profiles.map((prof, idx) => (
                <div key={prof.id} className={`profile-row-card ${prof.id === activeProfile.id ? 'active' : ''}`}>
                  <button className="profile-row-select" onClick={() => onSelectProfile(prof.id)}>
                    <ProfileAvatar profile={prof} size="sm" index={idx} />
                    <div>
                      <strong>{prof.name}</strong>
                      <small>{prof.isKids ? 'Kids profile' : 'Standard profile'}{prof.id === activeProfile.id ? ' · Active' : ''}</small>
                    </div>
                  </button>
                  {prof.id !== 'default' && onUpdateProfile && (
                    <button
                      className="icon-button"
                      title={prof.pinHash ? 'Change or remove PIN' : 'Set a PIN'}
                      aria-label={prof.pinHash ? `Change PIN for ${prof.name}` : `Set PIN for ${prof.name}`}
                      onClick={async () => {
                        if (prof.pinHash) {
                          if (window.confirm(`Remove the PIN from ${prof.name}?`)) onUpdateProfile(prof.id, { pinHash: undefined });
                          return;
                        }
                        const pin = window.prompt(`Set a numeric PIN for ${prof.name} (4-8 digits):`);
                        if (!pin) return;
                        if (!/^\d{4,8}$/.test(pin)) { window.alert('PIN must be 4-8 digits.'); return; }
                        const confirmPin = window.prompt('Repeat the PIN:');
                        if (pin !== confirmPin) { window.alert('PINs did not match.'); return; }
                        onUpdateProfile(prof.id, { pinHash: await hashPin(pin) });
                      }}
                    >
                      <ShieldCheck size={15} color={prof.pinHash ? '#3fb950' : undefined} />
                    </button>
                  )}
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

          {/* Adult content — three modes, per profile, age-gated */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><ShieldCheck size={19} /></span>
              <div>
                <h2>Adult content</h2>
                <p>{NSFW_COPY.blurb}</p>
              </div>
            </div>
            {kidsProfile ? (
              <div className="setting-row">
                <div>
                  <strong>Off on this profile</strong>
                  <p>{NSFW_COPY.kidsNote} Switch to a standard profile to change this.</p>
                </div>
                <span className="source-kind-badge free">KIDS</span>
              </div>
            ) : (
              <>
                <div className="setting-row">
                  <div>
                    <strong>{NSFW_COPY.title}</strong>
                    <p>{NSFW_COPY.modes.find((mode) => mode.id === settings.nsfw)?.hint}</p>
                  </div>
                  <div className="filter-pills" role="group" aria-label="Adult content">
                    {NSFW_COPY.modes.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={settings.nsfw === mode.id ? 'active' : ''}
                        aria-pressed={settings.nsfw === mode.id}
                        onClick={() => requestNsfwMode(mode.id)}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <p>
                      Applies to Manga, Comics, Anime, Live TV and the TMDB catalog. Turning it on asks
                      you to confirm you are 18 or older, and it stays off for Kids profiles.
                    </p>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* TMDB API */}
          <section className="settings-card tmdb-settings-card">
            <div className="settings-card-heading"><span><KeyRound size={19} /></span><div><h2>TMDB API</h2><p>Use your own key for trending titles, search, trailers, cast, episode guides, and ID resolution.</p></div></div>
            <div className="tmdb-intro"><div><strong>Your key. Your metadata.</strong><p>PRAHA does not include a shared API key. Both v3 API keys and v4 read access tokens are supported.</p></div><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a free key <ExternalLink size={13} /></a></div>
            <div className="tmdb-enrichment-options">
              {([
                ['enabled', 'Enable TMDB enrichment', 'Enhance title details with TMDB metadata.'],
                ['trailers', 'Trailers', 'Use trailer candidates from TMDB.'],
                ['artwork', 'Artwork', 'Use TMDB posters and backdrops.'],
                ['basicInfo', 'Basic info', 'Use TMDB descriptions, genres and ratings.'],
                ['details', 'Details', 'Use runtime and content ratings from TMDB.'],
                ['credits', 'Credits', 'Use cast and director information from TMDB.'],
                ['episodes', 'Episodes', 'Load TMDB episode guides for series.'],
                ['seasonPosters', 'Season posters', 'Use TMDB season artwork.'],
                ['recommendations', 'More like this', 'Use TMDB recommendations.'],
              ] as const).map(([key, label, description]) => <div className="tmdb-enrichment-row" key={key}>
                <div><strong>{label}</strong><p>{description}</p></div>
                <Toggle checked={settings.tmdbEnrichment[key]} onChange={(checked) => update('tmdbEnrichment', { ...settings.tmdbEnrichment, [key]: checked })} label={label} />
              </div>)}
              <p className="api-privacy">These controls apply to detail enrichment; TMDB browsing and search still require your key.</p>
            </div>
            <form className="api-key-form" onSubmit={verifyAndSave}>
              <label htmlFor="tmdb-api-key">TMDB API key or read access token</label>
              <div className="api-key-input"><KeyRound size={16} /><input id="tmdb-api-key" type={showApiKey ? 'text' : 'password'} value={apiDraft} onChange={(event) => { setApiDraft(event.target.value); setApiStatus('idle'); setApiMessage(''); }} placeholder="Paste your personal TMDB key here" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={apiStatus === 'checking'} /><button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? 'Hide TMDB API key' : 'Show TMDB API key'}>{showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <div className="api-key-actions"><button className="button button-primary" type="submit" disabled={apiStatus === 'checking'}>{apiStatus === 'checking' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{apiStatus === 'checking' ? 'Verifying…' : 'Verify & save'}</button>{(settings.tmdbApiKey || apiDraft) && <button className="button button-secondary" type="button" onClick={clearApiKey} disabled={apiStatus === 'checking'}><Trash2 size={15} /> Clear</button>}<span className={`api-saved-state ${settings.tmdbApiKey ? 'active' : ''}`}><i />{settings.tmdbApiKey ? 'Personal key active' : 'No personal key added'}</span></div>
            </form>
            {apiMessage && <p className={`api-key-message ${apiStatus}`} role="status">{apiStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />}{apiMessage}</p>}
            <p className="api-privacy"><ShieldCheck size={14} /><span>Your key is stored only on this device and sent directly to TMDB.</span></p>
          </section>

          {/* IMDx / Tiffara metadata */}
          <section className="settings-card imdx-settings-card">
            <div className="settings-card-heading">
              <span><Sparkles size={19} /></span>
              <div>
                <h2>IMDx · Tiffara (optional)</h2>
                <p>An extra IMDb-style metadata source. TMDB stays your primary catalog — this only adds results, plots, ratings and episode stills.</p>
              </div>
            </div>

            <div className="setting-row">
              <div><strong>Enable IMDx metadata</strong><p>Adds IMDb ratings, plots, cast and episode data from api.tiffara.com to search, details and the anime index.</p></div>
              <Toggle checked={settings.imdx.enabled} onChange={(checked) => updateImdx({ enabled: checked })} label="Enable IMDx metadata" />
            </div>

            <form className="api-key-form" onSubmit={verifyImdx}>
              <label htmlFor="imdx-base-url">API base URL</label>
              <div className="api-key-input">
                <ExternalLink size={16} />
                <input
                  id="imdx-base-url"
                  type="url"
                  value={imdxBaseDraft}
                  onChange={(event) => { setImdxBaseDraft(event.target.value); setImdxStatus('idle'); setImdxMessage(''); }}
                  placeholder="https://api.tiffara.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={imdxStatus === 'checking'}
                />
              </div>
              <label htmlFor="imdx-api-key">API key (optional — public endpoints need none)</label>
              <div className="api-key-input">
                <KeyRound size={16} />
                <input
                  id="imdx-api-key"
                  type={showImdxKey ? 'text' : 'password'}
                  value={imdxKeyDraft}
                  onChange={(event) => { setImdxKeyDraft(event.target.value); setImdxStatus('idle'); setImdxMessage(''); }}
                  placeholder="Leave empty unless your IMDx host requires a key"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={imdxStatus === 'checking'}
                />
                <button type="button" onClick={() => setShowImdxKey((visible) => !visible)} aria-label={showImdxKey ? 'Hide IMDx API key' : 'Show IMDx API key'}>{showImdxKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
              <div className="api-key-actions">
                <button className="button button-primary" type="submit" disabled={imdxStatus === 'checking'}>
                  {imdxStatus === 'checking' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
                  {imdxStatus === 'checking' ? 'Verifying…' : 'Verify & save'}
                </button>
                {(settings.imdx.apiKey || settings.imdx.enabled) && (
                  <button className="button button-secondary" type="button" onClick={() => { updateImdx({ enabled: false, apiKey: '' }); setImdxKeyDraft(''); setImdxStatus('idle'); setImdxMessage(''); }}>
                    <Trash2 size={15} /> Disable
                  </button>
                )}
                <a className="text-button" href={IMDX_DOCS_URL} target="_blank" rel="noreferrer noopener">API docs <ExternalLink size={12} /></a>
                <span className={`api-saved-state ${settings.imdx.enabled ? 'active' : ''}`}><i />{settings.imdx.enabled ? 'IMDx active' : 'IMDx off'}</span>
              </div>
            </form>
            {imdxMessage && <p className={`api-key-message ${imdxStatus}`} role="status">{imdxStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />}{imdxMessage}</p>}
            <p className="api-privacy"><ShieldCheck size={14} /><span>Requests go straight from this device to your IMDx endpoint. TMDB is never replaced or disabled by this setting.</span></p>
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

          <JellyfinSettings snapshot={jellyfinSnapshot} onSnapshotChange={onJellyfinSnapshotChange} />

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

          {/* ── Network · DNS · Torrent · Debrid cluster ── */}
          <h3 className="settings-group-label">Network · DNS · Torrent · Debrid</h3>

          {/* DNS is configured by Android, not silently changed by the app. */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><ShieldCheck size={19} /></span><div><h2>Private DNS</h2><p>Encrypted DNS may help if your network's DNS cannot resolve a service.</p></div></div>
            <div className="setting-row">
              <div>
                <strong>Use AdGuard DNS</strong>
                <p>Blocks ads and trackers device-wide over encrypted DNS. Tap “Use AdGuard DNS” to copy the hostname and open Android's Private DNS screen: choose “Private DNS provider hostname”, paste <b>dns.adguard-dns.com</b>, and save. Menu names vary on TV and other devices.</p>
                <p>Prefer Google or Cloudflare instead? Enter <b>dns.google</b> or <b>one.one.one.one</b> on the same screen.</p>
                <p>This applies to the whole device and sends DNS queries to your chosen provider. It is not a VPN and cannot bypass IP, geographic, or service-level blocks. If your connection stops working, switch Private DNS back to Automatic.</p>
                {!isAndroidApp() && <p>On the web, configure secure DNS in your browser or device settings instead.</p>}
                {dnsOpenError && <p role="alert">Could not open settings. Open Android Settings and search for Private DNS.</p>}
                {dnsCopied && <p role="status" style={{ color: '#4ade80' }}>Hostname copied — paste it into Private DNS provider hostname.</p>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
                {isAndroidApp() && (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => {
                      void navigator.clipboard.writeText('dns.adguard-dns.com')
                        .then(() => setDnsCopied(true))
                        .catch(() => undefined);
                      window.setTimeout(() => setDnsCopied(false), 6000);
                      void openPrivateDnsSettings().then((ok) => setDnsOpenError(!ok));
                    }}
                  >
                    Use AdGuard DNS
                  </button>
                )}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => { void navigator.clipboard.writeText('dns.adguard-dns.com').then(() => setDnsCopied(true)).catch(() => undefined); window.setTimeout(() => setDnsCopied(false), 6000); }}
                >
                  Copy dns.adguard-dns.com
                </button>
                {isAndroidApp() && <button type="button" className="button button-secondary" onClick={() => { void openPrivateDnsSettings().then((ok) => setDnsOpenError(!ok)); }}>Open Android settings <ExternalLink size={15} /></button>}
              </div>
            </div>
          </section>

          {/* DNS over HTTPS — grouped next to device DNS and the torrent engine */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><Globe size={19} /></span>
              <div>
                <h2>DNS over HTTPS <SourceKindBadge kind="free" /></h2>
                <p>Choose a resolver for PRAHA’s Android catalog and API requests.</p>
              </div>
            </div>
            <div className="setting-row">
              <div><strong>Quick presets</strong><p>One tap to apply a resolver pair, then fine-tune below.</p></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {([
                  ['System', 'system', true],
                  ['Cloudflare', 'cloudflare', true],
                  ['AdGuard', 'adguard', false],
                ] as const).map(([label, provider, fallback]) => (
                  <button
                    key={provider}
                    type="button"
                    className="button button-secondary"
                    onClick={() => { update('dnsProvider', provider); update('dnsFallback', fallback); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div><strong>DNS provider</strong><p>Encrypted providers resolve public hostnames over HTTPS.</p></div>
              <select
                className="settings-select"
                aria-label="DNS provider"
                value={settings.dnsProvider || 'system'}
                onChange={(e) => update('dnsProvider', e.target.value)}
              >
                <option value="system">System default</option>
                <option value="cloudflare">Cloudflare (1.1.1.1)</option>
                <option value="google">Google (8.8.8.8)</option>
                <option value="adguard">AdGuard</option>
                <option value="quad9">Quad9</option>
              </select>
            </div>
            <div className="setting-row">
              <div><strong>Fall back to system DNS</strong><p>When the resolver is slow or blocked, fall back to system DNS automatically.</p></div>
              <Toggle checked={settings.dnsFallback !== false} onChange={(val) => update('dnsFallback', val)} label="Fall back to system DNS" />
            </div>
            <p className="settings-tv-help">Android TV / remote: press <kbd>Tab</kbd> to move between controls, <kbd>Enter</kbd> to select, then scroll down with the D-pad.</p>
            {isAndroidApp() && <div className="setting-row">
              <div>
                <strong>Test resolver</strong>
                <p>Resolve example.com through the selected provider. This test runs with fallback disabled.</p>
                {dnsTest?.provider === (settings.dnsProvider || 'system') && <p role="status">
                  {dnsTest.result === 'checking' ? 'Checking resolver…' : dnsTest.result === 'ok' ? 'Resolver responded.' : 'Resolver test failed.'}
                </p>}
              </div>
              <button type="button" className="button button-secondary" onClick={() => void testDns()} disabled={dnsTest?.result === 'checking'}>Test DNS</button>
            </div>}
            <p className="api-privacy"><ShieldCheck size={14} /><span>Changes apply immediately in the Android app. WebView browsing and playback engines use the device connection.</span></p>
          </section>

          {/* VPN — some sources only resolve through an unfiltered DNS server */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><ShieldCheck size={19} /></span>
              <div>
                <h2>VPN</h2>
                <p>Some sources are blocked by your network's DNS. Turn this on to resolve their hostnames through a different DNS server.</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>DNS tunnel</strong>
                <p>
                  {vpnRunning
                    ? 'Running. DNS lookups go through the resolver below.'
                    : 'Off. Blocked sources will fail to resolve until this is on.'}
                </p>
              </div>
              {vpnBusy
                ? <LoaderCircle size={18} className="spin" />
                : <Toggle checked={vpnRunning} onChange={(val) => { void toggleVpn(val); }} label="VPN tunnel" />}
            </div>
            <div className="setting-row">
              <div><strong>Resolver</strong><p>The DNS server the tunnel forwards queries to.</p></div>
              <select
                className="settings-select"
                value={settings.vpnDnsServer || '1.1.1.1'}
                disabled={vpnBusy}
                onChange={(e) => {
                  const nextServer = e.target.value;
                  update('vpnDnsServer', nextServer);
                  // The service reads the resolver at startup, so changing it
                  // while running has to restart the tunnel to take effect.
                  if (vpnRunning) void toggleVpn(true, nextServer);
                }}
              >
                <option value="1.1.1.1">Cloudflare (1.1.1.1)</option>
                <option value="8.8.8.8">Google (8.8.8.8)</option>
                <option value="9.9.9.9">Quad9 (9.9.9.9)</option>
                <option value="94.140.14.14">AdGuard (94.140.14.14)</option>
                <option value="1.0.0.1">Cloudflare secondary (1.0.0.1)</option>
              </select>
            </div>
            {vpnError && <p role="alert">{vpnError}</p>}
            <p className="settings-tv-help">Android asks for permission the first time you switch this on. Android TV / remote: press <kbd>Tab</kbd> to reach the toggle, then <kbd>Enter</kbd>.</p>
            <p className="api-privacy"><ShieldCheck size={14} /><span>Only DNS is captured — video and torrent traffic keep using your normal connection, so streaming speed is unaffected. Android shows a VPN key in the status bar while this is on. Changing the resolver restarts the tunnel.</span></p>
          </section>

          {/* Network & Torrent Engine */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><Globe size={19} /></span><div><h2>Network & Torrent Engine <SourceKindBadge kind="free" /></h2><p>Check connectivity, tune torrent streaming, and configure a local/self-hosted torrent engine.</p></div></div>
            <div className="setting-row">
              <div>
                <strong>Network status</strong>
                <p>Diagnose whether the device is offline or catalog sources are unreachable (DNS/network filters can affect this).</p>
                {networkCondition && (
                  <p role="status" style={{ marginTop: '8px', color: networkCondition === 'online' ? '#4ade80' : '#f5c518' }}>
                    {NETWORK_CONDITION_COPY[networkCondition].title}: {NETWORK_CONDITION_COPY[networkCondition].message}
                  </p>
                )}
              </div>
              <button type="button" className="button button-secondary" onClick={() => { void checkNetworkCondition(); }} disabled={networkChecking}>
                {networkChecking ? <LoaderCircle size={15} className="spin" /> : <Wifi size={15} />} {networkChecking ? 'Checking…' : 'Check network'}
              </button>
            </div>
            <div className="setting-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <strong>Torrent engine host (TorrServer)</strong>
                <p>
                  {torrSupported
                    ? 'Android uses the TorrServer engine bundled in this APK by default — no setup or LAN host needed. The URL below is only a fallback for an external engine.'
                    : 'Used for magnet/torrent streaming when a compatible local or LAN TorrServer engine is available. Web/PWA uses in-app WebTorrent P2P for magnet streams (WebRTC peers required).'}
                </p>
              </div>
            </div>
            {torrSupported && (
              <div className="api-key-form" style={{ marginTop: '4px' }}>
                <label>Bundled TorrServer engine</label>
                <p className="api-privacy" style={{ marginTop: 0 }}>
                  <Server size={14} />
                  <span>
                    {torrStatus?.running
                      ? `Running on 127.0.0.1:${torrStatus.port}${torrStatus.pid > 0 ? ` (pid ${torrStatus.pid})` : ''}, tuned for streaming.`
                      : 'Stopped. It starts automatically the first time you play a torrent after accepting the P2P notice.'}
                  </span>
                </p>
                <div className="api-key-actions">
                  <button type="button" className="button button-secondary" onClick={() => { void torrServerController.status().then(setTorrStatus); }} disabled={torrBusy}>
                    <RefreshCw size={15} /> Refresh
                  </button>
                  <button type="button" className={torrStatus?.running ? 'button button-secondary' : 'button button-primary'} onClick={() => { void toggleBundledTorrServer(); }} disabled={torrBusy}>
                    {torrBusy ? <LoaderCircle size={15} className="spin" /> : <Magnet size={15} />} {torrStatus?.running ? 'Stop engine' : 'Start engine'}
                  </button>
                </div>
                {!!torrStatus?.logs?.length && (
                  <p className="settings-tv-help" role="log">{torrStatus.logs.slice(-3).join(' · ')}</p>
                )}
              </div>
            )}
            <div className="api-key-form" style={{ marginTop: '4px' }}>
              <label htmlFor="torrent-host">TorrServer URL</label>
              <div className="api-key-input">
                <Server size={16} />
                <input
                  id="torrent-host"
                  type="text"
                  value={torrentHostDraft}
                  onChange={(e) => { setTorrentHostDraft(e.target.value); setTorrentHostStatus('idle'); setTorrentHostMessage(''); }}
                  placeholder="http://127.0.0.1:8090"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="api-key-actions">
                <button type="button" className="button button-secondary" onClick={() => { void saveTorrentHost(false); }}>Save</button>
                <button type="button" className="button button-primary" onClick={() => { void saveTorrentHost(true); }} disabled={torrentHostStatus === 'checking'}>
                  {torrentHostStatus === 'checking' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} {torrentHostStatus === 'checking' ? 'Testing…' : 'Save & test'}
                </button>
              </div>
              {torrentHostMessage && (
                <p className={`api-key-message ${torrentHostStatus === 'error' ? 'error' : 'success'}`} role="status">
                  {torrentHostStatus === 'error' ? <CircleAlert size={14} /> : <Check size={14} />} {torrentHostMessage}
                </p>
              )}
              <p className="settings-tv-help">TV tip: use <kbd>Save &amp; test</kbd> to confirm the host is reachable before playing a magnet.</p>
              <p className="api-privacy"><ShieldCheck size={14} /><span><b>Free / self-hosted:</b> TorrServer and in-app WebTorrent P2P need no paid account. <b>Paid:</b> cached instant playback is in the Debrid card below. In-app P2P depends on torrent swarm WebRTC availability.</span></p>
            </div>
          </section>

          {/* Debrid Magnet Streaming — grouped with network/source settings */}
          <section className="settings-card">
            <div className="settings-card-heading">
              <span><Magnet size={19} /></span>
              <div>
                <h2>Debrid & Magnet Streaming <SourceKindBadge kind="paid" /></h2>
                <p>Convert torrent & magnet streams into instant 4K direct HTTP streams inside the built-in player.</p>
              </div>
            </div>
            <div className="setting-row">
              <div><strong>Debrid provider</strong><p>Automatically unrestricts cached magnets when pressing play. Requires your own paid account.</p></div>
              <select
                className="settings-select"
                value={settings.debrid.provider}
                onChange={(e) => update('debrid', { ...settings.debrid, provider: e.target.value as DebridProvider })}
              >
                <option value="none">Disabled (use free TorrServer / P2P)</option>
                <option value="realdebrid">Real-Debrid · paid</option>
                <option value="alldebrid">AllDebrid · paid</option>
                <option value="torbox">TorBox · paid</option>
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
            <p className="settings-tv-help">TV tip: enter the token once here; it stays on this device and appears in backups.</p>
            <p className="api-privacy"><ShieldCheck size={14} /><span><b>Paid:</b> Real-Debrid, AllDebrid and TorBox require your own API token. <b>Free / self-hosted:</b> use a local <b>TorrServer</b> in Network &amp; Torrent Engine, or projects like <b>WebTor</b>, <b>Torrin</b> and <b>StremThru</b>. PRAHA does not bundle a free public cached-debrid service.</span></p>
          </section>

          {/* Playback & Browsing */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Playback & browsing</h2><p>Choose how PRAHA feels as you move through it.</p></div></div>
            <div className="setting-row"><div><strong>Autoplay streams</strong><p>Start playback as soon as a compatible source opens.</p></div><Toggle checked={settings.autoplay} onChange={(value) => update('autoplay', value)} label="Autoplay streams" /></div>
            <div className="setting-row"><div><strong>Compact posters</strong><p>Fit more titles on screen while browsing.</p></div><Toggle checked={settings.compactCards} onChange={(value) => update('compactCards', value)} label="Compact posters" /></div>
            <div className="setting-row"><div><strong>Reduce motion</strong><p>Minimize transitions and animated effects.</p></div><Toggle checked={settings.reduceMotion} onChange={(value) => update('reduceMotion', value)} label="Reduce motion" /></div>
            <div className="setting-row"><div><strong>Preferred audio language</strong><p>Used to prioritize matching streams when available.</p></div><select className="settings-select" value={settings.preferredLanguage} onChange={(event) => update('preferredLanguage', event.target.value)}><option value="en">English</option><option value="hi">Hindi</option><option value="ja">Japanese</option><option value="ko">Korean</option><option value="es">Spanish</option><option value="other">Other</option></select></div>
            <BadgeRulesEditor />
          </section>

          {/* Navigation visibility (port of PT's dock settings) */}
          <section className="settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Navigation</h2><p>Show or hide sections of the sidebar. Extensions and Settings always stay.</p></div></div>
            <div className="setting-row" style={{ flexWrap: 'wrap', gap: '8px' }}>
              {[['home', 'Home'], ['livetv', 'Live TV'], ['anime', 'Anime'], ['reading', 'Reading'], ['music', 'Music'], ['audiobooks', 'Audiobooks'], ['discover', 'Discover'], ['flow', 'Flow · YouTube'], ['explore', 'Explore'], ['library', 'My Library']].map(([id, label]) => {
                const visible = !hiddenNav.includes(id);
                return (
                  <button
                    key={id}
                    className={visible ? 'active' : ''}
                    onClick={() => {
                      const next = visible ? [...hiddenNav, id] : hiddenNav.filter((entry) => entry !== id);
                      setHiddenNav(next);
                      try { localStorage.setItem('praha.nav.hidden.v1', JSON.stringify(next)); } catch { /* best effort */ }
                      window.dispatchEvent(new Event('praha:nav-changed'));
                    }}
                    style={{ padding: '6px 12px', borderRadius: '999px', border: '1px solid', borderColor: visible ? 'rgba(88,166,255,.5)' : 'var(--line-strong, #30363d)', background: visible ? 'rgba(88,166,255,.08)' : 'transparent', color: visible ? '#58a6ff' : 'var(--muted, #8b949e)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {label} {visible ? 'shown' : 'hidden'}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Player */}
          <section className="settings-card player-settings-card">
            <div className="settings-card-heading"><span><MonitorPlay size={19} /></span><div><h2>Player</h2><p>Built-in HLS, DASH (.mpd), and MPEG-TS player modelled on mpvRx.</p></div></div>
            <div className="setting-row">
              <div>
                <strong>Playback engine</strong>
                <p>
                  Android plays through this engine first and falls back automatically
                  (mpv → Media3 → web). Browser builds always use the web player.
                </p>
              </div>
              <select
                className="settings-select"
                value={settings.player.playerEngine || 'mpv'}
                onChange={(event) => updatePlayer({ playerEngine: event.target.value as PlayerEngineId })}
              >
                <option value="mpv">mpv (recommended)</option>
                <option value="media3">Media3 / ExoPlayer</option>
                <option value="web">Web player</option>
              </select>
            </div>
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
            <div className="settings-card-heading"><span><Gauge size={19} /></span><div><h2>Appearance & Palette</h2><p>Choose your theme accent palette from Nuvio colors.</p></div></div>
            <div className="setting-row">
              <div><strong>Theme Palette</strong><p>Accent colors for buttons, hero highlights, active tabs, and sliders.</p></div>
              <div className="accent-grid">
                {THEME_ACCENTS.map((accent) => {
                  const isSelected = settings.accent === accent.id;
                  return (
                    <button
                      key={accent.id}
                      type="button"
                      className={`accent-badge ${isSelected ? 'active' : ''}`}
                      onClick={() => update('accent', accent.id)}
                      aria-label={`${accent.label} theme`}
                    >
                      <span className="accent-circle" style={{ backgroundColor: accent.color }} />
                      <span className="accent-name">{accent.label}</span>
                      {isSelected && <Check size={14} className="accent-check" />}
                    </button>
                  );
                })}
              </div>
            </div>
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
            <div className="setup-stat"><span>Debrid</span><strong>{settings.debrid.provider === 'none' ? 'Off' : settings.debrid.provider}</strong></div>
            <div className="setup-stat"><span>TMDB API</span><strong>{settings.tmdbApiKey ? 'Own key' : 'Not set'}</strong></div>
            <div className="setup-stat"><span>IMDx · Tiffara</span><strong>{settings.imdx.enabled ? 'Enabled' : 'Optional'}</strong></div>
            <div className="setup-stat"><span>Anime index</span><strong>AniCore + Anikura</strong></div>
            <p><Blocks size={14} /> Export a JSON backup anytime to mirror this setup across devices.</p>
          </section>
          <section className="settings-card privacy-card"><span className="settings-side-icon"><ShieldCheck size={21} /></span><h2>Private by design</h2><p>Your library, profiles, history, API keys, and extension settings stay local on your device.</p></section>
          <button className="reset-button" onClick={onReset}><RotateCcw size={15} /> Reset preferences</button>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '12px' }}>
            <span className="version-label">PRAHA STREAM · {APP_VERSION}</span>
            {onCheckUpdates && (
              <button
                type="button"
                className="button button-secondary compact-btn"
                onClick={onCheckUpdates}
                style={{ fontSize: '10px', padding: '0 8px', height: '26px', borderRadius: '6px' }}
                title="Check for updates on GitHub"
              >
                <RefreshCw size={11} /> Check update
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default SettingsView;
