import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRightLeft, Check, CircleAlert, Clock3, Copy, ExternalLink, FolderOpen, Globe,
  LoaderCircle, MoreHorizontal, Play, Plus, Radio, RefreshCw, Search, Server, Sparkles,
  Star, Trash2, Tv2, X,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import {
  HardcodedChannels, type HardcodedChannel,
  IptvClient, type IptvCategory, type IptvPortal, type IptvStream, type VerifiedPortal,
  IptvScraper, IptvSourceStore, IptvSources, type IptvSourceEntry, IptvStore,
  M3uParser, type M3uChannel, type M3uPlaylist,
  LiveMatchesScraper, type LiveMatchEvent,
  IptvZapStore, buildIptvPlayback, detectIptvFormat, formatIptvBadge,
} from '../services/iptvService';
import { nativeFetchText, openExternalPlayer, openSafeExternalUrl } from '../services/androidBridge';
import { pickFirstHealthyStream, probeStreamHealth } from '../services/streamHealth';
import { LiveTvPrefs, type CachedHealth, type LastPlayedChannel } from '../services/liveTvPrefs';
import './live-tv.css';

interface LiveTvViewProps {
  onPlayStream: (media: MediaItem, stream: StreamResult) => void;
}

type Tab = 'channels' | 'matches' | 'sources' | 'playlists' | 'portals';

const TABS: Array<{ id: Tab; label: string; icon: React.FC<{ size?: number }> }> = [
  { id: 'channels', label: 'Channels', icon: Tv2 },
  { id: 'matches', label: 'Matches', icon: Radio },
  { id: 'sources', label: 'Sources', icon: Globe },
  { id: 'playlists', label: 'Playlists', icon: FolderOpen },
  { id: 'portals', label: 'Portals', icon: Server },
];

const CATEGORIES = ['All', 'Combat', 'Motorsport', 'Soccer', 'US Sports', 'Cricket', 'News', 'Movies', 'Kids & Docs', 'Music'] as const;

async function fetchWithTimeout(url: string, timeoutMs = 8000) {
  const res = await nativeFetchText(url, { method: 'GET', headers: {}, timeoutMs });
  return { ok: res.ok, status: res.status, text: async () => res.data };
}

/* ── Virtual list: only ~12 rows are ever mounted, regardless of playlist size. ── */
const ROW_HEIGHT = 76;
const OVERSCAN = 5;

const VirtualChannels: React.FC<{
  channels: M3uChannel[];
  render: (ch: M3uChannel) => React.ReactNode;
}> = ({ channels, render }) => {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 18 });
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<number | null>(null);

  // The list used to be sized with a fixed `calc(100dvh - 300px)`, which is
  // wrong on almost every phone: the search box, chips and recent shelf change
  // height depending on content, so the page gained a second (nested) scrollbar
  // and the last rows sat under the bottom navigation. Measure the real
  // remaining space instead — on phones only; the wide layout keeps its own cap.
  const fitToViewport = useCallback(() => {
    const el = scroller.current;
    if (!el || typeof window === 'undefined') return;
    if (window.innerWidth > 680) { setHeight((prev) => (prev === null ? prev : null)); return; }
    const top = el.getBoundingClientRect().top;
    const nav = document.querySelector('.mobile-nav');
    const navHeight = nav ? Math.max(0, window.innerHeight - nav.getBoundingClientRect().top) + 10 : 28;
    // Clamp to the viewport so a scrolled page (negative `top`) cannot ask for a
    // list taller than the screen.
    const next = Math.min(window.innerHeight, Math.max(240, Math.round(window.innerHeight - top - navHeight)));
    // Ignore sub-pixel churn: this runs from a ResizeObserver on the element it
    // resizes, so reacting to every 1px would ping-pong.
    setHeight((prev) => (prev !== null && Math.abs(prev - next) < 8 ? prev : next));
  }, []);

  // `onScroll` fires dozens of times per second on a flick. Reading layout and
  // calling setState for every event is what made the list feel sticky, so the
  // work is coalesced into one update per animation frame.
  const measureNow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const viewport = el.clientHeight || 600;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(channels.length, Math.ceil((el.scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [channels.length]);

  const measure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      measureNow();
    });
  }, [measureNow]);

  useEffect(() => { measureNow(); }, [measureNow]);

  useEffect(() => {
    const refit = () => { fitToViewport(); measure(); };
    refit();
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
    // The header above the list renders asynchronously (recent shelf, health
    // chips), so the first measurement can land before the final layout.
    const timer = window.setTimeout(refit, 150);
    return () => {
      window.removeEventListener('resize', refit);
      window.removeEventListener('orientationchange', refit);
      window.clearTimeout(timer);
    };
  }, [fitToViewport, measure, channels.length]);

  // Rotating, browser chrome collapsing, or a change in the mounted row count
  // all change the usable height; re-measure the virtual window when that
  // happens. Only `measure` runs here — re-fitting the height from inside a
  // ResizeObserver of the same element would loop.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current); }, []);

  return (
    <div
      className="ltv-virtual"
      ref={scroller}
      onScroll={measure}
      style={height ? { height, maxHeight: height } : undefined}
    >
      <div style={{ height: channels.length * ROW_HEIGHT, position: 'relative' }}>
        {channels.slice(range.start, range.end).map((ch, i) => {
          const index = range.start + i;
          return (
            <div key={`${index}-${ch.url}`} className="ltv-virtual-row" style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}>
              {render(ch)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const LiveTvView: React.FC<LiveTvViewProps> = ({ onPlayStream }) => {
  const [tab, setTab] = useState<Tab>('channels');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [group, setGroup] = useState('All');
  const [category, setCategory] = useState<string>('All');

  // Loaded source
  const [channels, setChannels] = useState<M3uChannel[]>(M3uParser.fallbackChannels);
  const [sourceName, setSourceName] = useState('');
  const [preset, setPreset] = useState('Sports');
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [customPlaylists, setCustomPlaylists] = useState<M3uPlaylist[]>(() => IptvStore.loadPlaylists());
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importError, setImportError] = useState('');

  // Channel preferences
  const [healthMap, setHealthMap] = useState<Record<string, CachedHealth>>(() => LiveTvPrefs.getAllHealth());
  const [modeMap, setModeMap] = useState<Record<string, 'internal' | 'external'>>(() => LiveTvPrefs.getAllModes());
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('praha.iptv.favorites.v1');
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch { return []; }
  });
  const [lastPlayed, setLastPlayed] = useState<LastPlayedChannel[]>(() => LiveTvPrefs.getLastPlayed());
  // Favorites are checked twice per mounted row on render. With a list of 5,000
  // channels `favorites.includes()` is O(n) per check, so a Set keeps the row
  // render cheap while scrolling.
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const [actionChannel, setActionChannel] = useState<M3uChannel | null>(null);
  const [checkingUrl, setCheckingUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | null>(null);
  const cursorRef = useRef<Record<string, number>>({});

  // Sources
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [countries, setCountries] = useState(IptvSources.IPTV_ORG_COUNTRIES_FALLBACK);
  const [country, setCountry] = useState(() => IptvSourceStore.loadIptvOrgCountry());
  const [stepDaddyUrl, setStepDaddyUrl] = useState(() => IptvSourceStore.loadStepDaddyUrl());
  const countriesFetched = useRef(false);

  // Matches
  const [matches, setMatches] = useState<LiveMatchEvent[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState('');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Curated scan
  const [scanningChannel, setScanningChannel] = useState<HardcodedChannel | null>(null);
  const [scanning, setScanning] = useState(false);
  const [hits, setHits] = useState<Array<{ name: string; url: string; source: string }>>([]);

  // Portals
  const [portals, setPortals] = useState<VerifiedPortal[]>(() => IptvStore.loadPortals());
  const [scraping, setScraping] = useState(false);
  const [portalStatus, setPortalStatus] = useState('');
  const [showAddPortal, setShowAddPortal] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [portalUser, setPortalUser] = useState('');
  const [portalPass, setPortalPass] = useState('');
  const [portalError, setPortalError] = useState('');
  const [browsing, setBrowsing] = useState<VerifiedPortal | null>(null);
  const [portalCats, setPortalCats] = useState<IptvCategory[]>([]);
  const [portalStreams, setPortalStreams] = useState<IptvStream[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    if (countriesFetched.current) return;
    countriesFetched.current = true;
    IptvSources.listIptvOrgCountries().then(setCountries).catch(() => undefined);
  }, []);

  // ── Source loading ─────────────────────────────────────────────────────
  const applyToken = useRef(0);
  const applySource = useCallback((name: string, list: M3uChannel[]) => {
    applyToken.current += 1;
    setChannels(list);
    setSourceName(name);
    setGroup('All');
  }, []);

  const loadPreset = useCallback(async (name: string) => {
    const url = M3uParser.defaultPlaylists[name];
    if (!url) return;
    const token = applyToken.current;
    setPlaylistLoading(true);
    try {
      const text = await (await fetchWithTimeout(url)).text();
      const parsed = M3uParser.parse(text);
      // A slower preset must never clobber a source the user just selected.
      if (token !== applyToken.current) return;
      if (parsed.length) applySource(name, parsed);
      else setChannels(M3uParser.fallbackChannels);
    } catch {
      if (token === applyToken.current) setChannels(M3uParser.fallbackChannels);
    } finally { setPlaylistLoading(false); }
  }, [applySource]);

  const loadSourceUrl = useCallback(async (source: IptvSourceEntry, url: string) => {
    if (!url || sourceBusy) return;
    setSourceBusy(source.id); setSourceError(''); setSourceStatus(`Loading ${source.name}…`);
    try {
      const list = await IptvSources.loadPlaylist(url);
      setSourceStatus(`${list.length.toLocaleString()} channels loaded.`);
      IptvSourceStore.saveLastSource(source.name, url);
      applySource(source.name, list);
      setTab('channels');
    } catch (err) {
      setSourceStatus('');
      setSourceError(err instanceof Error ? err.message : `Could not load ${source.name}.`);
    } finally { setSourceBusy(null); }
  }, [applySource, sourceBusy]);

  const loadIptvOrg = useCallback(async (kind: 'country' | 'category' | 'all', value?: string) => {
    const url = kind === 'country' ? IptvSources.iptvOrgCountryUrl(value || country)
      : kind === 'category' ? IptvSources.iptvOrgCategoryUrl(value || 'sports')
        : IptvSources.iptvOrgIndexUrl();
    if (kind === 'country' && value) { setCountry(value); IptvSourceStore.saveIptvOrgCountry(value); }
    const label = kind === 'country'
      ? `iptv-org · ${countries.find((c) => c.code === (value || country))?.name || value || country}`
      : `iptv-org · ${value || 'sports'}`;
    await loadSourceUrl({ id: 'iptv-org', name: label, description: '', kind: 'playlist' }, url);
  }, [country, countries, loadSourceUrl]);

  const connectStepDaddy = useCallback(async () => {
    const url = IptvSources.stepDaddyPlaylistUrl(stepDaddyUrl);
    if (!url) { setSourceError('Enter your StepDaddyLiveHD server URL.'); return; }
    IptvSourceStore.saveStepDaddyUrl(stepDaddyUrl);
    await loadSourceUrl({ id: 'stepdaddy', name: 'StepDaddyLiveHD', description: '', kind: 'selfhosted' }, url);
  }, [stepDaddyUrl, loadSourceUrl]);

  // Restore last source once on mount.
  useEffect(() => {
    void loadPreset(preset);
    const last = IptvSourceStore.loadLastSource();
    if (last) void IptvSources.loadPlaylist(last.url)
      .then((list) => { if (list.length) applySource(last.name, list); })
      .catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImport = useCallback(async () => {
    setImportError('');
    try {
      let list: M3uChannel[] = [];
      let url = importUrl.trim();
      if (url) list = M3uParser.parse(await (await fetchWithTimeout(url, 10000)).text());
      else if (importText.trim()) { list = M3uParser.parse(importText); url = 'local://text-import'; }
      else { setImportError('Provide a URL or paste M3U text.'); return; }
      if (!list.length) { setImportError('No valid channels found.'); return; }
      const playlist: M3uPlaylist = { id: `m3u-${Date.now()}`, name: importName.trim() || `Playlist (${list.length})`, sourceUrl: url, channels: list, updatedAt: Date.now() };
      const updated = [playlist, ...customPlaylists];
      setCustomPlaylists(updated); IptvStore.savePlaylists(updated); applySource(playlist.name, list);
      setShowImport(false); setImportUrl(''); setImportText(''); setImportName('');
    } catch (err) { setImportError(err instanceof Error ? err.message : 'Import failed.'); }
  }, [importUrl, importText, importName, customPlaylists, applySource]);

  // ── Playback ───────────────────────────────────────────────────────────
  const playStreamNow = useCallback((title: string, url: string, source: string, poster?: string) => {
    IptvZapStore.set(channels, url);
    const { media, stream } = buildIptvPlayback({ name: title, url, group: source, logo: poster });
    onPlayStream(media, stream);
  }, [channels, onPlayStream]);

  const playChannel = useCallback((ch: M3uChannel, mode?: 'internal' | 'external') => {
    const selected = mode || LiveTvPrefs.getMode(ch.url) || 'internal';
    if (selected === 'external') {
      const { stream } = buildIptvPlayback(ch);
      openExternalPlayer(stream, ch.name, 'chooser');
      flash(`Opened externally · ${ch.name}`);
    } else {
      playStreamNow(ch.name, ch.url, ch.group || sourceName, ch.logo);
    }
    setLastPlayed(LiveTvPrefs.markPlayed(ch));
    setActionChannel(null);
  }, [playStreamNow, sourceName, flash]);

  const toggleFavorite = useCallback((url: string) => {
    setFavorites((current) => {
      const next = current.includes(url) ? current.filter((v) => v !== url) : [url, ...current];
      try { localStorage.setItem('praha.iptv.favorites.v1', JSON.stringify(next.slice(0, 300))); } catch { /* best effort */ }
      return next;
    });
  }, []);

  const checkHealth = useCallback(async (ch: M3uChannel, force = false) => {
    if (checkingUrl && checkingUrl !== ch.url) return;
    const cached = LiveTvPrefs.getHealth(ch.url);
    if (cached && !force) {
      setHealthMap((m) => ({ ...m, [ch.url]: cached }));
      flash(`${ch.name}: ${cached.ok ? 'alive' : 'unreachable'} · ${cached.latencyMs}ms`);
      return;
    }
    setCheckingUrl(ch.url);
    try {
      const result = await probeStreamHealth(ch.url);
      const entry = LiveTvPrefs.setHealth(ch.url, result);
      setHealthMap((m) => ({ ...m, [ch.url]: entry }));
      flash(`${ch.name}: ${result.ok ? 'alive' : 'unreachable'} · ${result.latencyMs}ms`);
    } catch { flash(`${ch.name}: health check failed`); }
    finally { setCheckingUrl(null); }
  }, [checkingUrl, flash]);

  const copyUrl = useCallback(async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(url);
      flash('Stream URL copied');
    } catch {
      try {
        const field = document.createElement('textarea');
        field.value = url; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.appendChild(field); field.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(field);
        flash(copied ? 'Stream URL copied' : 'Copy blocked — long-press the URL below');
      } catch { flash('Copy blocked — long-press the URL below'); }
    }
  }, [flash]);

  const rememberMode = useCallback((ch: M3uChannel, mode: 'internal' | 'external') => {
    LiveTvPrefs.setMode(ch.url, mode);
    setModeMap((m) => ({ ...m, [ch.url]: mode }));
    flash(mode === 'external' ? `External player remembered for ${ch.name}` : `In-app player restored for ${ch.name}`);
  }, [flash]);

  const tryNextSource = useCallback((ch: M3uChannel) => {
    const options = LiveTvPrefs.findAlternates(channels, ch);
    if (!options.length) { flash('No alternate source found'); return; }
    const key = ch.name.toLowerCase();
    const cursor = cursorRef.current[key] || 0;
    const next = options[cursor % options.length];
    cursorRef.current[key] = cursor + 1;
    playChannel(next);
    flash(`Trying ${next.group || next.name} · ${next.name}`);
  }, [channels, playChannel, flash]);

  const alternates = useMemo(
    () => (actionChannel ? LiveTvPrefs.findAlternates(channels, actionChannel) : []),
    [actionChannel, channels],
  );

  // ── Matches ────────────────────────────────────────────────────────────
  const loadMatches = useCallback(async () => {
    setMatchesLoading(true); setMatchesError('');
    try {
      const [nuvio, dami, ppv] = await Promise.all([
        LiveMatchesScraper.fetchNuvioSportsMatches().catch(() => []),
        LiveMatchesScraper.fetchDamiTvMatches().catch(() => []),
        LiveMatchesScraper.fetchPpvMatches().catch(() => []),
      ]);
      const combined = [...nuvio, ...dami, ...ppv];
      setMatches(combined);
      if (!combined.length) setMatchesError('No live sports are listed right now.');
    } catch { setMatches([]); setMatchesError('Could not load the schedule.'); }
    finally { setMatchesLoading(false); }
  }, []);
  useEffect(() => { void loadMatches(); }, [loadMatches]);

  const playMatch = useCallback(async (match: LiveMatchEvent) => {
    if (match.nuvio) {
      setResolvingId(match.id);
      try {
        const url = await LiveMatchesScraper.resolveNuvioStream(match.id);
        if (url) playStreamNow(match.title, url, match.league, match.poster);
        else setMatchesError(`No stream available for "${match.title}" right now.`);
      } catch (err) { setMatchesError(err instanceof Error ? err.message : 'Could not resolve stream.'); }
      finally { setResolvingId(null); }
      return;
    }
    playStreamNow(match.title, match.streamUrl, match.league, match.poster);
  }, [playStreamNow]);

  // ── Curated scan ───────────────────────────────────────────────────────
  const scanCurated = useCallback(async (channel: HardcodedChannel) => {
    setScanningChannel(channel); setScanning(true); setHits([]);
    const found: Array<{ name: string; url: string; source: string }> = [];
    for (const ch of channels) {
      if (HardcodedChannels.matches(ch.name, channel.keywords, channel.exclude)) {
        found.push({ name: ch.name, url: ch.url, source: ch.group || sourceName });
      }
    }
    for (const vp of portals.slice(0, 3)) {
      try {
        const streams = await IptvClient.streams(vp.portal, '', 'live');
        for (const s of streams) {
          if (HardcodedChannels.matches(s.name, channel.keywords, channel.exclude)) {
            found.push({ name: s.name, url: IptvClient.streamUrl(vp.portal, s), source: `Xtream · ${vp.name}` });
          }
        }
      } catch { /* keep scanning */ }
    }
    if (!found.length) {
      if (channel.defaultStreamUrl) found.push({ name: channel.name, url: channel.defaultStreamUrl, source: '24/7 broadcast' });
      const fallback = M3uParser.fallbackChannels.find((fb) => HardcodedChannels.matches(fb.name, channel.keywords, channel.exclude)) || M3uParser.fallbackChannels[0];
      if (fallback) found.push({ name: `${channel.name} · ${fallback.name}`, url: fallback.url, source: fallback.group || 'Live' });
    }
    setHits(found); setScanning(false);
    if (found.length) {
      const healthy = await pickFirstHealthyStream(found.map((hit) => ({ url: hit.url, hit })));
      const chosen = healthy?.hit || found[0];
      playStreamNow(channel.name, chosen.url, chosen.source, channel.logo);
    }
  }, [channels, portals, sourceName, playStreamNow]);

  // ── Portals ────────────────────────────────────────────────────────────
  const scrapePortals = useCallback(async () => {
    setScraping(true); setPortalStatus('Finding portals…');
    try {
      const raw = await IptvScraper.scrapeRedditPortals(30);
      const list = (raw.length ? raw : IptvScraper.getFallbackPortals()).slice(0, 12);
      const verified: VerifiedPortal[] = [];
      const queue = [...list];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          if (!p) return;
          try { const v = await IptvClient.verifyOrNull(p, 4000); if (v) verified.push(v); } catch { /* dead */ }
          setPortalStatus(`Checked ${list.length - queue.length}/${list.length} · ${verified.length} active`);
        }
      };
      await Promise.all(Array.from({ length: 5 }, () => worker()));
      if (verified.length) {
        const updated = [...portals, ...verified.filter((v) => !portals.some((p) => p.portal.url === v.portal.url))];
        setPortals(updated); IptvStore.savePortals(updated);
        setPortalStatus(`Added ${verified.length} active portals.`);
      } else setPortalStatus('No active portals responded. Add your own portal below.');
    } catch { setPortalStatus('Scraping failed. Check your connection.'); }
    finally { setScraping(false); }
  }, [portals]);

  const addPortal = useCallback(async () => {
    if (!portalUrl || !portalUser || !portalPass) { setPortalError('Fill out URL, username and password.'); return; }
    setPortalError('');
    try {
      const portal: IptvPortal = { url: portalUrl.trim(), username: portalUser.trim(), password: portalPass.trim(), source: 'Manual' };
      const verified = await IptvClient.verifyOrNull(portal, 8000);
      if (!verified) { setPortalError('Authentication failed — check the credentials.'); return; }
      const updated = [verified, ...portals.filter((p) => p.portal.url !== verified.portal.url)];
      setPortals(updated); IptvStore.savePortals(updated); setShowAddPortal(false);
      setPortalUrl(''); setPortalUser(''); setPortalPass('');
    } catch (err) { setPortalError(err instanceof Error ? err.message : 'Could not connect.'); }
  }, [portalUrl, portalUser, portalPass, portals]);

  const openBrowser = useCallback(async (vp: VerifiedPortal) => {
    setBrowsing(vp); setPortalLoading(true); setPortalCats([]); setPortalStreams([]);
    try {
      const cats = await IptvClient.categories(vp.portal, 'live');
      setPortalCats(cats);
      setPortalStreams(cats.length ? await IptvClient.streams(vp.portal, cats[0].id, 'live') : await IptvClient.streams(vp.portal, '', 'live'));
    } catch { setPortalStreams([]); }
    finally { setPortalLoading(false); }
  }, []);

  // ── Channel filtering ──────────────────────────────────────────────────
  const sourceGroups = useMemo(() => {
    const counts = new Map<string, number>();
    channels.forEach((ch) => { if (ch.group) counts.set(ch.group, (counts.get(ch.group) || 0) + 1); });
    return ['All', ...Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g]) => g)];
  }, [channels]);

  const visible = useMemo(() => {
    let list = channels;
    if (group === '__favorites') list = list.filter((ch) => favoriteSet.has(ch.url));
    else if (group === '__recent') list = lastPlayed.map((entry) => channels.find((ch) => ch.url === entry.url) || entry);
    else if (group !== 'All') list = list.filter((ch) => ch.group === group);
    const q = deferredQuery.trim().toLowerCase();
    if (q) list = list.filter((ch) => ch.name.toLowerCase().includes(q) || (ch.group || '').toLowerCase().includes(q));
    return list;
  }, [channels, group, favoriteSet, lastPlayed, deferredQuery]);

  const curated = useMemo(() => HardcodedChannels.all.filter((c) => {
    const matchCategory = category === 'All' || c.category === category;
    const q = deferredQuery.trim().toLowerCase();
    return matchCategory && (!q || c.name.toLowerCase().includes(q) || c.shortName.toLowerCase().includes(q));
  }), [category, deferredQuery]);

  // ── Render ─────────────────────────────────────────────────────────────
  const renderChannel = (ch: M3uChannel) => {
    const health = healthMap[ch.url];
    const isFavorite = favoriteSet.has(ch.url);
    return (
      <div className="ltv-channel" role="button" tabIndex={0} onClick={() => playChannel(ch)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playChannel(ch); } }}>
        <div className="ltv-logo">{ch.logo ? <img src={ch.logo} alt="" loading="lazy" decoding="async" /> : <Tv2 size={19} />}</div>
        <div className="ltv-info">
          <div className="ltv-name">{ch.name || 'Unknown channel'}</div>
          <div className="ltv-sub">
            <span>{ch.group || 'Live'}</span>
            <span className="ltv-format">{formatIptvBadge(detectIptvFormat(ch.url))}</span>
            {modeMap[ch.url] === 'external' && <span className="ltv-ext" title="Remembered: external">EXT</span>}
            {health && (
              <span className={`ltv-health ${health.ok ? 'ok' : 'bad'}`} title={health.detail}>
                <i />{health.ok ? `${health.latencyMs}ms` : 'dead'}
              </span>
            )}
          </div>
        </div>
        <div className="ltv-actions">
          <button className={`ltv-icon-btn ${isFavorite ? 'on' : ''}`}
            aria-label={isFavorite ? `Unfavorite ${ch.name}` : `Favorite ${ch.name}`}
            onClick={(e) => { e.stopPropagation(); toggleFavorite(ch.url); }}>
            <Star size={17} fill={isFavorite ? '#f5c518' : 'none'} />
          </button>
          <button className="ltv-icon-btn" aria-label={`Options for ${ch.name}`}
            onClick={(e) => { e.stopPropagation(); setActionChannel(ch); }}>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="ltv">
      {/* App bar */}
      <header className="ltv-bar">
        <div className="ltv-bar-icon"><Tv2 size={23} strokeWidth={2.4} /></div>
        <div>
          <h1 className="ltv-bar-title"><span className="ltv-live-dot" />Live TV</h1>
          <p className="ltv-bar-sub">{sourceName || 'Pick a source to begin'}</p>
        </div>
        <div className="ltv-bar-actions">
          <button className="ltv-icon-btn" aria-label="Refresh" onClick={() => { void loadPreset(preset); void loadMatches(); }}>
            <RefreshCw size={17} className={playlistLoading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="ltv-tabs" aria-label="Live TV sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`ltv-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            <Icon size={15} />{label}
          </button>
        ))}
      </nav>

      {tab === 'channels' && (
        <>
          <div className="ltv-search">
            <Search size={17} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search channels…" aria-label="Search channels" />
            {query && <button className="ltv-search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}
          </div>

          {lastPlayed.length > 0 && group !== '__recent' && (
            <div className="ltv-recent">
              {lastPlayed.slice(0, 10).map((entry) => (
                <button key={entry.url} onClick={() => playChannel(channels.find((ch) => ch.url === entry.url) || entry)}>
                  <Play size={10} fill="currentColor" /><span>{entry.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="ltv-chips">
            <button className={`ltv-chip ${group === '__recent' ? 'active' : ''}`} onClick={() => setGroup('__recent')}><Clock3 size={12} /> Recent</button>
            <button className={`ltv-chip ${group === '__curated' ? 'active' : ''}`} onClick={() => setGroup('__curated')}><Sparkles size={12} /> Curated</button>
            <button className={`ltv-chip ${group === '__favorites' ? 'active' : ''}`} onClick={() => setGroup('__favorites')}><Star size={12} /> Favorites</button>
            {sourceGroups.map((g) => <button key={g} className={`ltv-chip ${group === g ? 'active' : ''}`} onClick={() => setGroup(g)}>{g}</button>)}
          </div>

          <div className="ltv-meta">
            <span>{group === '__curated' ? `${curated.length} curated channels` : `${visible.length.toLocaleString()} channels`}</span>
            {sourceName && <button onClick={() => setTab('sources')}>Change source</button>}
          </div>

          {playlistLoading ? (
            <div className="ltv-empty"><LoaderCircle size={30} className="spin" /><p>Loading playlist…</p></div>
          ) : group === '__curated' ? (
            <div className="ltv-panel">
              <div className="ltv-chips">
                {CATEGORIES.map((c) => <button key={c} className={`ltv-chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}
              </div>
              <div className="ltv-curated">
                {curated.map((ch) => (
                  <div className="ltv-curated-card" key={ch.id}>
                    {ch.logo ? <img src={ch.logo} alt="" loading="lazy" /> : <div className="ltv-curated-photo"><Sparkles size={16} /></div>}
                    <div className="ltv-curated-info"><strong>{ch.shortName}</strong><small>{ch.category}</small></div>
                    <button className="ltv-icon-btn accent" disabled={scanning} aria-label={`Scan ${ch.name}`} onClick={() => void scanCurated(ch)}>
                      {scanning && scanningChannel?.id === ch.id ? <LoaderCircle size={15} className="spin" /> : <Radio size={15} />}
                    </button>
                  </div>
                ))}
              </div>
              {scanningChannel && hits.length > 0 && (
                <div className="ltv-hits">
                  <h4>Sources for {scanningChannel.shortName}</h4>
                  {hits.map((hit, i) => (
                    <div className="ltv-hit" key={`${hit.url}-${i}`}>
                      <span className="ltv-hit-best" style={{ color: i === 0 ? '#4ade80' : undefined }}>{i === 0 ? 'BEST' : `#${i + 1}`}</span>
                      <div className="ltv-hit-info"><strong>{hit.name}</strong><small>{hit.source} · {formatIptvBadge(detectIptvFormat(hit.url))}</small></div>
                      <button className="ltv-icon-btn" aria-label="Copy URL" onClick={() => void copyUrl(hit.url)}><Copy size={15} /></button>
                      <button className="ltv-icon-btn accent" aria-label="Play" onClick={() => playStreamNow(scanningChannel.name, hit.url, hit.source, scanningChannel.logo)}><Play size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : visible.length ? (
            <VirtualChannels key={`${group}-${deferredQuery}-${sourceName}`} channels={visible} render={renderChannel} />
          ) : (
            <div className="ltv-empty">
              <Tv2 size={34} />
              <h3>{sourceName ? 'No channels match' : 'No source loaded'}</h3>
              <p>{sourceName ? 'Try another group or clear your search.' : 'Load iptv-org or your own playlist in Sources.'}</p>
              <button className="ltv-btn primary" onClick={() => setTab('sources')}>Open Sources</button>
            </div>
          )}
        </>
      )}

      {/* ── Matches ────────────────────────────────────────────────────── */}
      {tab === 'matches' && (
        <div className="ltv-panel">
          <div className="ltv-row">
            <p className="ltv-card-desc" style={{ margin: 0 }}>Live sports from Nuvio, Dami-TV and PPV.to.</p>
            <button className="ltv-icon-btn" onClick={() => void loadMatches()}><RefreshCw size={15} className={matchesLoading ? 'spin' : ''} /></button>
          </div>
          {matchesError && <p className="ltv-error">{matchesError}</p>}
          {matchesLoading ? <div className="ltv-empty"><LoaderCircle size={28} className="spin" /><p>Finding live matches…</p></div>
            : matches.length === 0 ? <div className="ltv-empty"><Radio size={30} /><h3>Nothing live right now</h3><p>Check back before kickoff.</p></div>
              : <div className="ltv-grid" style={{ gridTemplateColumns: '1fr' }}>
                {matches.map((m) => (
                  <div className="ltv-card" key={m.id}>
                    <div className="ltv-row">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong className="ltv-card-title">{m.title}</strong>
                        <small style={{ color: 'var(--muted)' }}>{m.league}</small>
                      </div>
                      <button className="ltv-btn primary" disabled={resolvingId === m.id} onClick={() => void playMatch(m)}>
                        {resolvingId === m.id ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} Watch
                      </button>
                    </div>
                  </div>
                ))}
              </div>}
        </div>
      )}

      {/* ── Sources ────────────────────────────────────────────────────── */}
      {tab === 'sources' && (
        <div className="ltv-panel">
          {sourceStatus && <p className="ltv-success"><Check size={14} /> {sourceStatus}</p>}
          {sourceError && <p className="ltv-error"><CircleAlert size={14} /> {sourceError}</p>}

          <div className="ltv-card">
            <h2 className="ltv-card-title">iptv-org <span className="ltv-format">MAIN · FREE</span></h2>
            <p className="ltv-card-desc">Thousands of public channels by country and category.</p>
            <div className="ltv-row">
              <select className="ltv-field" value={country} onChange={(e) => { setCountry(e.target.value); IptvSourceStore.saveIptvOrgCountry(e.target.value); }} aria-label="Country">
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
              <button className="ltv-btn primary" disabled={!!sourceBusy} onClick={() => void loadIptvOrg('country')}>Load</button>
            </div>
            <div className="ltv-btn-row" style={{ marginTop: 10 }}>
              <button className="ltv-btn" disabled={!!sourceBusy} onClick={() => void loadIptvOrg('all')}>All channels</button>
            </div>
            <div className="ltv-grid" style={{ marginTop: 10 }}>
              {IptvSources.IPTV_ORG_CATEGORIES.slice(0, 12).map((c) => (
                <button key={c} disabled={!!sourceBusy} onClick={() => void loadIptvOrg('category', c)}>{c}</button>
              ))}
            </div>
          </div>

          <div className="ltv-card">
            <h2 className="ltv-card-title">StepDaddyLiveHD <span className="ltv-format">FREE · SELF-HOSTED</span></h2>
            <p className="ltv-card-desc">Point this at your own StepDaddyLiveHD server.</p>
            <input className="ltv-field" value={stepDaddyUrl} onChange={(e) => setStepDaddyUrl(e.target.value)} placeholder="http://192.168.1.10:3000" aria-label="Server URL" />
            <button className="ltv-btn primary block" style={{ marginTop: 10 }} disabled={!!sourceBusy} onClick={() => void connectStepDaddy()}>Connect</button>
            {IptvSources.CATALOG.find((s) => s.id === 'stepdaddy')?.homepage && (
              <button className="ltv-btn block" style={{ marginTop: 8 }} onClick={() => void openSafeExternalUrl(IptvSources.CATALOG.find((s) => s.id === 'stepdaddy')!.homepage!)}>
                <ExternalLink size={14} /> Setup guide
              </button>
            )}
          </div>

          <div className="ltv-card">
            <h2 className="ltv-card-title">Community sources</h2>
            <div className="ltv-grid">
              {IptvSources.CATALOG.filter((s) => !s.main && s.url).map((s) => (
                <button key={s.id} disabled={!!sourceBusy} onClick={() => void loadSourceUrl(s, s.url!)}>{s.name}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Playlists ──────────────────────────────────────────────────── */}
      {tab === 'playlists' && (
        <div className="ltv-panel">
          <button className="ltv-btn primary block" onClick={() => setShowImport(true)}><Plus size={16} /> Import M3U playlist</button>
          {customPlaylists.length === 0 ? (
            <div className="ltv-empty"><FolderOpen size={32} /><h3>No saved playlists</h3><p>Import a URL or paste M3U text.</p></div>
          ) : customPlaylists.map((pl) => (
            <div className="ltv-card" key={pl.id}>
              <div className="ltv-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong className="ltv-card-title">{pl.name}</strong>
                  <small style={{ color: 'var(--muted)' }}>{pl.channels.length.toLocaleString()} channels</small>
                </div>
                <button className="ltv-btn" onClick={() => applySource(pl.name, pl.channels)}>Load</button>
                <button className="ltv-icon-btn danger" aria-label={`Delete ${pl.name}`} onClick={() => {
                  const updated = customPlaylists.filter((p) => p.id !== pl.id);
                  setCustomPlaylists(updated); IptvStore.savePlaylists(updated);
                }}><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Portals ────────────────────────────────────────────────────── */}
      {tab === 'portals' && (
        <div className="ltv-panel">
          <div className="ltv-btn-row">
            <button className="ltv-btn primary" disabled={scraping} onClick={() => void scrapePortals()}>
              {scraping ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} Find portals
            </button>
            <button className="ltv-btn" onClick={() => setShowAddPortal(true)}><Plus size={15} /> Add portal</button>
          </div>
          {portalStatus && <p className="ltv-note" role="status">{portalStatus}</p>}
          {portals.length === 0 ? (
            <div className="ltv-empty"><Server size={32} /><h3>No portals saved</h3><p>Find community portals or add your provider's details.</p></div>
          ) : portals.map((vp, i) => (
            <div className="ltv-card" key={`${vp.portal.url}-${i}`}>
              <div className="ltv-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong className="ltv-card-title">{vp.name}</strong>
                  <small style={{ color: 'var(--muted)' }}>{vp.portal.url}</small>
                </div>
                <button className="ltv-btn primary" onClick={() => void openBrowser(vp)}>Browse</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Channel action sheet ───────────────────────────────────────── */}
      {actionChannel && (
        <div className="ltv-sheet-backdrop" onClick={() => setActionChannel(null)}>
          <div className="ltv-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ltv-sheet-grip" />
            <div className="ltv-sheet-head">
              <div>
                <h3>{actionChannel.name}</h3>
                <p>{actionChannel.group || 'Live'} · {formatIptvBadge(detectIptvFormat(actionChannel.url))}</p>
              </div>
              <button className="ltv-icon-btn" aria-label="Close" onClick={() => setActionChannel(null)}><X size={18} /></button>
            </div>

            <div className="ltv-row">
              {healthMap[actionChannel.url] ? (
                <span className={`ltv-health ${healthMap[actionChannel.url].ok ? 'ok' : 'bad'}`} style={{ fontSize: 12 }}>
                  <i />{healthMap[actionChannel.url].ok ? `Alive · ${healthMap[actionChannel.url].latencyMs}ms` : `Unreachable · ${healthMap[actionChannel.url].detail}`}
                </span>
              ) : <span style={{ fontSize: 12, color: 'var(--muted)' }}>Health not checked</span>}
              <button className="ltv-icon-btn" disabled={checkingUrl === actionChannel.url} onClick={() => void checkHealth(actionChannel, true)}>
                {checkingUrl === actionChannel.url ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />} Re-check
              </button>
            </div>

            <input className="ltv-url" readOnly value={actionChannel.url} onFocus={(e) => e.currentTarget.select()} aria-label="Stream URL" />

            <div className="ltv-sheet-actions">
              <button className="ltv-btn primary" onClick={() => playChannel(actionChannel)}><Play size={15} /> Play in-app</button>
              <button className="ltv-btn" onClick={() => playChannel(actionChannel, 'external')}><ExternalLink size={15} /> Open externally</button>
              <button className="ltv-btn" onClick={() => void copyUrl(actionChannel.url)}><Copy size={15} /> Copy URL</button>
              <button className="ltv-btn" onClick={() => void checkHealth(actionChannel)}><Activity size={15} /> Check health</button>
              <button className="ltv-btn" disabled={!alternates.length} onClick={() => tryNextSource(actionChannel)}><ArrowRightLeft size={15} /> Next source</button>
              <button className="ltv-btn" onClick={() => toggleFavorite(actionChannel.url)}>
                <Star size={15} fill={favorites.includes(actionChannel.url) ? '#f5c518' : 'none'} />
                {favorites.includes(actionChannel.url) ? 'Favorited' : 'Favorite'}
              </button>
            </div>

            <p className="ltv-sheet-label">Remember player for this source</p>
            <div className="ltv-btn-row">
              <button className={`ltv-btn ${modeMap[actionChannel.url] !== 'external' ? 'primary' : ''}`} onClick={() => rememberMode(actionChannel, 'internal')}>In-app</button>
              <button className={`ltv-btn ${modeMap[actionChannel.url] === 'external' ? 'primary' : ''}`} onClick={() => rememberMode(actionChannel, 'external')}>External</button>
            </div>

            {alternates.length > 0 && (
              <>
                <p className="ltv-sheet-label">Same channel on other sources ({alternates.length})</p>
                {alternates.slice(0, 5).map((alt, i) => (
                  <div className="ltv-list-item" key={`${alt.url}-${i}`}>
                    <div className="ltv-list-item-info"><strong>{alt.name}</strong><small>{alt.group || 'Live'} · {formatIptvBadge(detectIptvFormat(alt.url))}</small></div>
                    <button className="ltv-icon-btn accent" aria-label={`Play ${alt.name}`} onClick={() => playChannel(alt)}><Play size={15} /></button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Import dialog ──────────────────────────────────────────────── */}
      {showImport && (
        <div className="ltv-sheet-backdrop" onClick={() => setShowImport(false)}>
          <div className="ltv-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ltv-sheet-grip" />
            <div className="ltv-sheet-head"><h3>Import M3U playlist</h3><button className="ltv-icon-btn" onClick={() => setShowImport(false)}><X size={18} /></button></div>
            <input className="ltv-field" value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="Playlist name (optional)" />
            <input className="ltv-field" style={{ marginTop: 8 }} value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://example.com/playlist.m3u8" />
            <textarea className="ltv-field" style={{ height: 90, paddingTop: 10, marginTop: 8 }} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="…or paste raw M3U text" />
            {importError && <p className="ltv-error" style={{ marginTop: 8 }}>{importError}</p>}
            <button className="ltv-btn primary block" style={{ marginTop: 12 }} onClick={() => void handleImport()}>Parse &amp; save</button>
          </div>
        </div>
      )}

      {/* ── Add portal dialog ──────────────────────────────────────────── */}
      {showAddPortal && (
        <div className="ltv-sheet-backdrop" onClick={() => setShowAddPortal(false)}>
          <div className="ltv-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ltv-sheet-grip" />
            <div className="ltv-sheet-head"><h3>Add Xtream portal</h3><button className="ltv-icon-btn" onClick={() => setShowAddPortal(false)}><X size={18} /></button></div>
            <input className="ltv-field" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} placeholder="http://host:8080" />
            <input className="ltv-field" style={{ marginTop: 8 }} value={portalUser} onChange={(e) => setPortalUser(e.target.value)} placeholder="Username" />
            <input className="ltv-field" style={{ marginTop: 8 }} value={portalPass} onChange={(e) => setPortalPass(e.target.value)} placeholder="Password" />
            {portalError && <p className="ltv-error" style={{ marginTop: 8 }}>{portalError}</p>}
            <button className="ltv-btn primary block" style={{ marginTop: 12 }} onClick={() => void addPortal()}>Verify &amp; add</button>
          </div>
        </div>
      )}

      {/* ── Portal stream browser ──────────────────────────────────────── */}
      {browsing && (
        <div className="ltv-sheet-backdrop" onClick={() => setBrowsing(null)}>
          <div className="ltv-sheet" style={{ height: '82dvh' }} onClick={(e) => e.stopPropagation()}>
            <div className="ltv-sheet-grip" />
            <div className="ltv-sheet-head"><div><h3>{browsing.name}</h3><p>Live channels</p></div><button className="ltv-icon-btn" onClick={() => setBrowsing(null)}><X size={18} /></button></div>
            {portalCats.length > 0 && (
              <div className="ltv-chips">
                {portalCats.map((c) => <button key={c.id} className="ltv-chip" onClick={() => {
                  void IptvClient.streams(browsing.portal, c.id, 'live').then(setPortalStreams).catch(() => setPortalStreams([]));
                }}>{c.name}</button>)}
              </div>
            )}
            {portalLoading ? <div className="ltv-empty"><LoaderCircle size={26} className="spin" /><p>Loading channels…</p></div>
              : portalStreams.length === 0 ? <p className="ltv-note">No live streams in this category.</p>
                : portalStreams.map((s) => {
                  const url = IptvClient.streamUrl(browsing.portal, s);
                  return (
                    <div className="ltv-list-item" key={s.streamId}>
                      <div className="ltv-list-item-info"><strong>{s.name}</strong><small>{formatIptvBadge(detectIptvFormat(url))}</small></div>
                      <button className="ltv-icon-btn accent" aria-label={`Play ${s.name}`} onClick={() => { playStreamNow(s.name, url, browsing.name, s.icon); setBrowsing(null); }}><Play size={15} /></button>
                    </div>
                  );
                })}
          </div>
        </div>
      )}

      {notice && <div className="ltv-toast" role="status">{notice}</div>}
    </div>
  );
};

export default LiveTvView;
