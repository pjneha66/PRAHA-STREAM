import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Check, CircleAlert, Copy, ExternalLink, Globe, ListFilter, LoaderCircle,
  Play, Plus, Radio, RefreshCw, Search, ShieldCheck, Sparkles, Star,
  Tv, Tv2, Users, Volume2, X,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import {
  HardcodedChannels, type HardcodedChannel,
  IptvClient, type IptvCategory, type IptvPortal, type IptvStream, type VerifiedPortal,
  IptvScraper, IptvSourceStore, IptvSources, type IptvSourceEntry, IptvStore,
  M3uParser, type M3uChannel, type M3uPlaylist,
  LiveMatchesScraper, type LiveMatchEvent,
  IptvZapStore, buildIptvPlayback,
} from '../services/iptvService';
import { nativeFetchText, openSafeExternalUrl } from '../services/androidBridge';
import SkeletonGrid from './SkeletonGrid';
import { pickFirstHealthyStream } from '../services/streamHealth';

interface LiveTvViewProps {
  onPlayStream: (media: MediaItem, stream: StreamResult) => void;
}

type LiveTvTab = 'channels' | 'sources' | 'matches' | 'playlists' | 'portals';

const CATEGORY_FILTERS = [
  'All',
  'Combat',
  'Motorsport',
  'Soccer',
  'US Sports',
  'Cricket',
  'News',
  'Movies',
  'Kids & Docs',
  'Music',
] as const;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  const headers = (init?.headers as Record<string, string>) || {};
  const method = init?.method || 'GET';
  const body = typeof init?.body === 'string' ? init.body : undefined;
  const res = await nativeFetchText(url, {
    method,
    headers,
    body,
    timeoutMs,
  });
  return {
    ok: res.ok,
    status: res.status,
    text: async () => res.data,
    json: async () => JSON.parse(res.data),
  };
}

export const LiveTvView: React.FC<LiveTvViewProps> = ({ onPlayStream }) => {
  const [activeTab, setActiveTab] = useState<LiveTvTab>('channels');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');

  // ── Channels Hub State ──
  const [scanningChannel, setScanningChannel] = useState<HardcodedChannel | null>(null);
  const [channelHits, setChannelHits] = useState<{ name: string; url: string; source: string }[]>([]);
  const [scanningBusy, setScanningBusy] = useState(false);

  // ── Live Matches State ──
  const [matches, setMatches] = useState<LiveMatchEvent[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState('');
  const [resolvingMatchId, setResolvingMatchId] = useState<string | null>(null);

  // ── M3U Playlists State ──
  const [activePreset, setActivePreset] = useState<string>('Sports');
  const [playlistChannels, setPlaylistChannels] = useState<M3uChannel[]>(M3uParser.fallbackChannels);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [customPlaylists, setCustomPlaylists] = useState<M3uPlaylist[]>(() => IptvStore.loadPlaylists());
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importError, setImportError] = useState('');

  // ── Xtream Portals State ──
  const [portals, setPortals] = useState<VerifiedPortal[]>(() => IptvStore.loadPortals());
  const [scrapingPortals, setScrapingPortals] = useState(false);
  const [portalStatus, setPortalStatus] = useState('');
  const [showAddPortalDialog, setShowAddPortalDialog] = useState(false);
  const [newPortalUrl, setNewPortalUrl] = useState('');
  const [newPortalUser, setNewPortalUser] = useState('');
  const [newPortalPass, setNewPortalPass] = useState('');
  const [addPortalBusy, setAddPortalBusy] = useState(false);
  const [addPortalError, setAddPortalError] = useState('');

  // Portal stream browser
  const [browsingPortal, setBrowsingPortal] = useState<VerifiedPortal | null>(null);
  const [portalCategories, setPortalCategories] = useState<IptvCategory[]>([]);
  const [selectedPortalCategory, setSelectedPortalCategory] = useState<string>('');
  const [portalStreams, setPortalStreams] = useState<IptvStream[]>([]);
  const [portalStreamsLoading, setPortalStreamsLoading] = useState(false);

  // ── Public Sources State ──
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [activeSourceName, setActiveSourceName] = useState('');
  const [sourceGroup, setSourceGroup] = useState('All');
  const [hubLimit, setHubLimit] = useState(250);
  // Hub appearance (port of PT's IPTV settings): compact cards + hide logos.
  const [hubCompact, setHubCompact] = useState(() => localStorage.getItem('praha.iptv.hubCompact') === '1');
  const [hubHideLogos, setHubHideLogos] = useState(() => localStorage.getItem('praha.iptv.hubHideLogos') === '1');
  const setIptvPref = (key: string, value: boolean, setter: (v: boolean) => void) => {
    setter(value);
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* best effort */ }
  };
  // Favorite channels (port of PlayTorrio's channel favorites): persisted URL set.
  const [favChannels, setFavChannels] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('praha.iptv.favorites.v1');
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleFavorite = (url: string) => {
    setFavChannels((current) => {
      const next = current.includes(url) ? current.filter((entry) => entry !== url) : [url, ...current];
      try { localStorage.setItem('praha.iptv.favorites.v1', JSON.stringify(next.slice(0, 300))); } catch { /* best effort */ }
      return next;
    });
  };
  const [iptvOrgCountries, setIptvOrgCountries] = useState<Array<{ code: string; name: string }>>(IptvSources.IPTV_ORG_COUNTRIES_FALLBACK);
  const [iptvOrgCountry, setIptvOrgCountry] = useState<string>(() => IptvSourceStore.loadIptvOrgCountry());
  const [stepDaddyUrl, setStepDaddyUrl] = useState<string>(() => IptvSourceStore.loadStepDaddyUrl());
  const countriesFetchedRef = useRef(false);

  useEffect(() => {
    if (countriesFetchedRef.current) return;
    countriesFetchedRef.current = true;
    IptvSources.listIptvOrgCountries().then((list) => setIptvOrgCountries(list)).catch(() => undefined);
  }, []);

  const applySourceChannels = (sourceName: string, channels: M3uChannel[]) => {
    setPlaylistChannels(channels);
    setActiveSourceName(sourceName);
    setSourceGroup('All');
    setHubLimit(250);
    setActiveTab('channels');
  };

  const loadSourceUrl = async (source: IptvSourceEntry, url: string) => {
    if (sourceBusy || !url) return;
    setSourceBusy(source.id);
    setSourceError('');
    setSourceStatus(`Loading ${source.name}…`);
    try {
      const channels = await IptvSources.loadPlaylist(url);
      setSourceStatus(`${channels.length.toLocaleString()} channels loaded from ${source.name}.`);
      IptvSourceStore.saveLastSource(source.name, url);
      applySourceChannels(source.name, channels);
    } catch (err) {
      setSourceStatus('');
      setSourceError(err instanceof Error ? err.message : `Could not load ${source.name}.`);
    } finally {
      setSourceBusy(null);
    }
  };

  const loadIptvOrg = async (kind: 'country' | 'category' | 'all', value?: string) => {
    if (sourceBusy) return;
    const url = kind === 'country'
      ? IptvSources.iptvOrgCountryUrl(value || iptvOrgCountry)
      : kind === 'category'
        ? IptvSources.iptvOrgCategoryUrl(value || 'sports')
        : IptvSources.iptvOrgIndexUrl();
    if (kind === 'country' && value) {
      setIptvOrgCountry(value);
      IptvSourceStore.saveIptvOrgCountry(value);
    }
    const label = kind === 'country'
      ? `iptv-org · ${iptvOrgCountries.find((c) => c.code === (value || iptvOrgCountry))?.name || value || iptvOrgCountry}`
      : kind === 'category'
        ? `iptv-org · ${value || 'sports'}`
        : 'iptv-org · All channels';
    await loadSourceUrl({ id: 'iptv-org', name: label, description: '', kind: 'playlist' }, url);
  };

  const connectStepDaddy = async () => {
    const url = IptvSources.stepDaddyPlaylistUrl(stepDaddyUrl);
    if (!url) {
      setSourceError('Enter your StepDaddyLiveHD server URL (e.g. http://192.168.1.10:3000).');
      return;
    }
    IptvSourceStore.saveStepDaddyUrl(stepDaddyUrl);
    await loadSourceUrl({ id: 'stepdaddy', name: 'StepDaddyLiveHD', description: '', kind: 'playlist' }, url);
  };

  // ── Load Initial Data ──
  useEffect(() => {
    (async () => {
      await loadPresetPlaylist(activePreset);
      // Restore the last loaded source so the Channels Hub survives restarts
      // (runs after the preset fetch so it wins the setPlaylistChannels race).
      const last = IptvSourceStore.loadLastSource();
      if (last) {
        try {
          const channels = await IptvSources.loadPlaylist(last.url);
          if (channels.length > 0) {
            setPlaylistChannels(channels);
            setActiveSourceName(last.name);
            setSourceGroup('All');
            setHubLimit(250);
          }
        } catch {
          // Source is unreachable right now — keep whatever the preset loaded.
        }
      }
    })();
    loadLiveMatches();
  }, []);

  // ── M3U Loader ──
  const loadPresetPlaylist = async (presetName: string) => {
    const url = M3uParser.defaultPlaylists[presetName];
    if (!url) return;
    setPlaylistLoading(true);
    try {
      const resp = await fetchWithTimeout(url, undefined, 8000);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = M3uParser.parse(text);
      setPlaylistChannels(parsed);
    } catch {
      // Fallback: try proxy
      try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const resp2 = await fetchWithTimeout(proxyUrl, undefined, 8000);
        const text2 = await resp2.text();
        const parsed2 = M3uParser.parse(text2);
        setPlaylistChannels(parsed2.length > 0 ? parsed2 : M3uParser.fallbackChannels);
      } catch {
        setPlaylistChannels(M3uParser.fallbackChannels);
      }
    } finally {
      setPlaylistLoading(false);
    }
  };

  // ── Live Matches Loader ──
  const loadLiveMatches = async () => {
    setMatchesLoading(true);
    setMatchesError('');
    try {
      // Nuvio Live Sports first (real matches, real per-match streams); the
      // Dami-TV / PPV.to scrapers are secondary coverage. No fake fallback —
      // an empty state beats five identical placeholder streams.
      const [nuvio, dami, ppv] = await Promise.all([
        LiveMatchesScraper.fetchNuvioSportsMatches().catch(() => []),
        LiveMatchesScraper.fetchDamiTvMatches().catch(() => []),
        LiveMatchesScraper.fetchPpvMatches().catch(() => []),
      ]);
      const combined = [...nuvio, ...dami, ...ppv];
      setMatches(combined);
      if (!combined.length) setMatchesError('No live sports are listed right now.');
    } catch {
      setMatches([]);
      setMatchesError('Could not load the live sports schedule.');
    } finally {
      setMatchesLoading(false);
    }
  };

  // Nuvio matches resolve their stream URL on demand (per-match manifest).
  const playMatch = async (match: LiveMatchEvent) => {
    if (match.nuvio) {
      setResolvingMatchId(match.id);
      try {
        const url = await LiveMatchesScraper.resolveNuvioStream(match.id);
        if (url) playStreamNow(match.title, url, match.league, match.poster);
        else setMatchesError(`No stream available for "${match.title}" right now — try another match.`);
      } finally {
        setResolvingMatchId(null);
      }
      return;
    }
    playStreamNow(match.title, match.streamUrl, match.league, match.poster);
  };

  // ── Portal Scraper ──
  const runPortalScraper = async () => {
    setScrapingPortals(true);
    setPortalStatus('Scraping Xtream-Codes portals from community catalog...');
    try {
      const rawPortals = await IptvScraper.scrapeRedditPortals(30);
      const candidates = rawPortals.length > 0 ? rawPortals : IptvScraper.getFallbackPortals();
      const list = candidates.slice(0, 12);
      setPortalStatus(`Found ${list.length} candidate portals. Verifying authentication...`);

      // Verify concurrently: sequential 4s logins made the button look hung
      // for over a minute on dead portals.
      const verifiedList: VerifiedPortal[] = [];
      let done = 0;
      const queue = [...list];
      const verifyNext = async () => {
        while (queue.length) {
          const p = queue.shift();
          if (!p) return;
          try {
            const v = await IptvClient.verifyOrNull(p, 4000);
            if (v) verifiedList.push(v);
          } catch {
            // ignore dead portal
          }
          done += 1;
          setPortalStatus(`Verifying portals… ${done}/${list.length} checked, ${verifiedList.length} active.`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, list.length) }, () => verifyNext()));

      if (verifiedList.length > 0) {
        const updated = [...portals, ...verifiedList.filter(v => !portals.some(p => p.portal.url === v.portal.url))];
        setPortals(updated);
        IptvStore.savePortals(updated);
        setPortalStatus(`Added ${verifiedList.length} verified active portals.`);
      } else {
        setPortalStatus('No active portals responded. Reddit blocks automated scraping from many networks — add your own portal with credentials from your IPTV provider, or load an M3U source in the Sources tab.');
      }
    } catch {
      setPortalStatus('Scraping error. Check network connection.');
    } finally {
      setScrapingPortals(false);
    }
  };

  // ── Manual Portal Add ──
  const handleAddPortal = async () => {
    if (!newPortalUrl || !newPortalUser || !newPortalPass) {
      setAddPortalError('Please fill out URL, Username, and Password.');
      return;
    }
    setAddPortalBusy(true);
    setAddPortalError('');
    try {
      const p: IptvPortal = {
        url: newPortalUrl.trim(),
        username: newPortalUser.trim(),
        password: newPortalPass.trim(),
        source: 'Manual',
      };
      const verified = await IptvClient.verifyOrNull(p, 8000);
      if (!verified) {
        setAddPortalError('Authentication failed: Portal returned invalid credentials or status.');
        return;
      }
      const updated = [verified, ...portals.filter(x => x.portal.url !== verified.portal.url)];
      setPortals(updated);
      IptvStore.savePortals(updated);
      setShowAddPortalDialog(false);
      setNewPortalUrl('');
      setNewPortalUser('');
      setNewPortalPass('');
    } catch (err: any) {
      setAddPortalError(err?.message || 'Could not connect to portal.');
    } finally {
      setAddPortalBusy(false);
    }
  };

  // ── Browse Portal Streams ──
  const openPortalBrowser = async (vp: VerifiedPortal) => {
    setBrowsingPortal(vp);
    setPortalStreamsLoading(true);
    setPortalCategories([]);
    setPortalStreams([]);
    try {
      const cats = await IptvClient.categories(vp.portal, 'live');
      setPortalCategories(cats);
      if (cats.length > 0) {
        setSelectedPortalCategory(cats[0].id);
        const streams = await IptvClient.streams(vp.portal, cats[0].id, 'live');
        setPortalStreams(streams);
      } else {
        const streams = await IptvClient.streams(vp.portal, '', 'live');
        setPortalStreams(streams);
      }
    } catch {
      // ignore
    } finally {
      setPortalStreamsLoading(false);
    }
  };

  const selectPortalCategory = async (catId: string) => {
    if (!browsingPortal) return;
    setSelectedPortalCategory(catId);
    setPortalStreamsLoading(true);
    try {
      const streams = await IptvClient.streams(browsingPortal.portal, catId, 'live');
      setPortalStreams(streams);
    } catch {
      setPortalStreams([]);
    } finally {
      setPortalStreamsLoading(false);
    }
  };

  // ── Channel Scanner (Match Curated Channel) ──
  const scanCuratedChannel = async (channel: HardcodedChannel) => {
    setScanningChannel(channel);
    setScanningBusy(true);
    setChannelHits([]);

    const hits: { name: string; url: string; source: string }[] = [];

    // 1. Search in current loaded M3U channels
    for (const ch of playlistChannels) {
      if (HardcodedChannels.matches(ch.name, channel.keywords, channel.exclude)) {
        hits.push({ name: ch.name, url: ch.url, source: `M3U (${ch.group || activePreset})` });
      }
    }

    // 2. Search in active verified portals
    for (const vp of portals.slice(0, 3)) {
      try {
        const streams = await IptvClient.streams(vp.portal, '', 'live');
        for (const s of streams) {
          if (HardcodedChannels.matches(s.name, channel.keywords, channel.exclude)) {
            const streamUrl = IptvClient.streamUrl(vp.portal, s);
            hits.push({ name: s.name, url: streamUrl, source: `Xtream (${vp.name})` });
          }
        }
      } catch {
        // continue
      }
    }

    if (hits.length === 0) {
      if (channel.defaultStreamUrl) {
        hits.push({ name: channel.name, url: channel.defaultStreamUrl, source: '24/7 Verified Broadcast' });
      } else {
        const fallbackMatch = M3uParser.fallbackChannels.find(fb => 
          fb.group?.toLowerCase() === channel.category.toLowerCase() ||
          HardcodedChannels.matches(fb.name, channel.keywords, channel.exclude)
        ) || M3uParser.fallbackChannels[0];
        if (fallbackMatch) {
          hits.push({ name: `${channel.name} (${fallbackMatch.name})`, url: fallbackMatch.url, source: `Live (${fallbackMatch.group || 'HD'})` });
        }
      }
    }

    setChannelHits(hits);
    setScanningBusy(false);

    // If hits found, auto-play the first HEALTHY stream (ranged-GET probe,
    // port of PlayTorrio's alive-checker) instead of a possibly dead one.
    if (hits.length > 0) {
      void (async () => {
        const healthy = await pickFirstHealthyStream(hits.map((hit) => ({ url: hit.url, hit })));
        const chosen = healthy?.hit || hits[0];
        playStreamNow(channel.name, chosen.url, chosen.source, channel.logo);
      })();
    }
  };

  // ── Player Bridge ──
  const playStreamNow = (title: string, streamUrl: string, groupOrSource: string, poster?: string) => {
    // Persist the zap list so the in-player ▲▼ bar can switch channels.
    IptvZapStore.set(
      playlistChannels.map((ch) => ({ name: ch.name, url: ch.url, group: ch.group, logo: ch.logo })),
      streamUrl,
    );
    const { media, stream } = buildIptvPlayback({ name: title, url: streamUrl, group: groupOrSource, logo: poster });
    onPlayStream(media, stream);
  };

  // ── Import Custom M3U ──
  const handleImportPlaylist = async () => {
    setImportError('');
    try {
      let channels: M3uChannel[] = [];
      let sourceUrl = importUrl.trim();

      if (sourceUrl) {
        const resp = await fetchWithTimeout(sourceUrl, undefined, 10000);
        const text = await resp.text();
        channels = M3uParser.parse(text);
      } else if (importText.trim()) {
        channels = M3uParser.parse(importText);
        sourceUrl = 'local://text-import';
      } else {
        setImportError('Provide an M3U URL or paste M3U playlist text.');
        return;
      }

      if (channels.length === 0) {
        setImportError('No valid channels found in the provided M3U content.');
        return;
      }

      const newPlaylist: M3uPlaylist = {
        id: `m3u-${Date.now()}`,
        name: importName.trim() || `Playlist (${channels.length} channels)`,
        sourceUrl,
        channels,
        updatedAt: Date.now(),
      };

      const updated = [newPlaylist, ...customPlaylists];
      setCustomPlaylists(updated);
      IptvStore.savePlaylists(updated);
      setPlaylistChannels(channels);
      setShowImportDialog(false);
      setImportUrl('');
      setImportText('');
      setImportName('');
    } catch (err: any) {
      setImportError(err?.message || 'Failed to import playlist.');
    }
  };

  // ── Filtered Channels ──
  const filteredHardcoded = useMemo(() => {
    return HardcodedChannels.all.filter((c) => {
      const matchesCategory = selectedCategory === 'All' || c.category === selectedCategory;
      const matchesSearch = !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.shortName.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesCategory && matchesSearch;
    });
  }, [selectedCategory, searchQuery]);

  // Group pills for the loaded source playlist.
  const sourceGroups = useMemo(() => {
    const counts = new Map<string, number>();
    playlistChannels.forEach((ch) => {
      if (ch.group) counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
    });
    return ['All', ...Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([g]) => g)];
  }, [playlistChannels]);

  const filteredPlaylistChannels = useMemo(() => {
    let list = playlistChannels;
    if (sourceGroup === '__favorites') list = list.filter((c) => favChannels.includes(c.url));
    else if (sourceGroup !== 'All') list = list.filter((c) => c.group === sourceGroup);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || (c.group && c.group.toLowerCase().includes(q)));
    }
    return list;
  }, [playlistChannels, searchQuery, sourceGroup, favChannels]);

  return (
    <div style={{ padding: '24px 20px', maxWidth: '1400px', margin: '0 auto', color: '#e6edf3' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '42px', height: '42px', borderRadius: '12px',
            background: 'linear-gradient(135deg, #ef4444, #f97316)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(239, 68, 68, 0.3)'
          }}>
            <Tv2 size={22} color="#ffffff" strokeWidth={2.4} />
          </div>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>Live TV & Sports</h1>
            <p style={{ fontSize: '13px', color: '#8b949e', margin: '2px 0 0 0' }}>
              PlayTorrio IPTV Engine · 50+ Curated Channels · Live Matches & PPV · Xtream & M3U
            </p>
          </div>
        </div>

        {/* ── Sub-tabs ── */}
        <div style={{ display: 'flex', background: '#161b22', borderRadius: '10px', padding: '4px', border: '1px solid #30363d' }}>
          {(['channels', 'sources', 'matches', 'playlists', 'portals'] as LiveTvTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: 'none',
                background: activeTab === tab ? '#ef4444' : 'transparent',
                color: activeTab === tab ? '#ffffff' : '#8b949e',
                fontWeight: activeTab === tab ? 600 : 500,
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'background 0.15s ease, color 0.15s ease',
                textTransform: 'capitalize',
              }}
            >
              {tab === 'channels' ? 'Channels Hub' : tab === 'sources' ? 'Sources' : tab === 'matches' ? 'Live Matches' : tab === 'playlists' ? 'M3U Playlists' : 'Xtream Portals'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Search Bar ── */}
      <div style={{ position: 'relative', marginBottom: '20px' }}>
        <Search size={18} color="#8b949e" style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={activeTab === 'channels' ? 'Search 50+ channels (UFC, F1, Sky Sports, beIN, ESPN, HBO)...' : 'Search streams or channels...'}
          style={{
            width: '100%',
            padding: '12px 14px 12px 42px',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '10px',
            color: '#c9d1d9',
            fontSize: '14px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 1: CHANNELS HUB (source-driven — loaded source channels only)
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'channels' && (
        <div>
          {activeSourceName ? (
            <>
              {/* Group Pills */}
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '14px', marginBottom: '16px' }}>
                <button
                  key="__favorites"
                  onClick={() => { setSourceGroup('__favorites'); setHubLimit(250); }}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '20px',
                    border: '1px solid',
                    borderColor: sourceGroup === '__favorites' ? '#f5c518' : '#30363d',
                    background: sourceGroup === '__favorites' ? 'rgba(245, 197, 24, 0.15)' : '#161b22',
                    color: sourceGroup === '__favorites' ? '#f5c518' : '#c9d1d9',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  ★ Favorites
                </button>
                {sourceGroups.map((group) => (
                  <button
                    key={group}
                    onClick={() => { setSourceGroup(group); setHubLimit(250); }}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '20px',
                      border: '1px solid',
                      borderColor: sourceGroup === group ? '#ef4444' : '#30363d',
                      background: sourceGroup === group ? 'rgba(239, 68, 68, 0.15)' : '#161b22',
                      color: sourceGroup === group ? '#f87171' : '#c9d1d9',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {group}
                  </button>
                ))}
              </div>

              <div style={{ margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <p style={{ margin: 0, fontSize: '13px', color: '#8b949e', flex: 1 }}>
                  {activeSourceName} · {filteredPlaylistChannels.length.toLocaleString()} channels{sourceGroup !== 'All' ? ` in ${sourceGroup}` : ''}
                </p>
                <button
                  onClick={() => setIptvPref('praha.iptv.hubCompact', !hubCompact, setHubCompact)}
                  style={{ padding: '4px 10px', borderRadius: '7px', border: '1px solid #30363d', background: hubCompact ? 'rgba(88,166,255,.12)' : '#161b22', color: hubCompact ? '#58a6ff' : '#8b949e', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                >
                  Compact
                </button>
                <button
                  onClick={() => setIptvPref('praha.iptv.hubHideLogos', !hubHideLogos, setHubHideLogos)}
                  style={{ padding: '4px 10px', borderRadius: '7px', border: '1px solid #30363d', background: hubHideLogos ? 'rgba(88,166,255,.12)' : '#161b22', color: hubHideLogos ? '#58a6ff' : '#8b949e', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                >
                  No logos
                </button>
              </div>

              {/* Source Channels Grid — capped per chunk to keep the page snappy */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '10px' }}>
                {filteredPlaylistChannels.slice(0, hubLimit).map((ch, i) => (
                  <div
                    key={`${i}-${ch.url}-${ch.name || 'unknown'}`}
                    onClick={() => playStreamNow(ch.name, ch.url, ch.group || activeSourceName, ch.logo)}
                    style={{
                      background: '#161b22',
                      borderRadius: '12px',
                      border: '1px solid #30363d',
                      padding: hubCompact ? '8px 10px' : '14px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      minHeight: hubCompact ? '56px' : '84px',
                    }}
                  >
                    {ch.logo && !hubHideLogos ? (
                      <img src={ch.logo} alt="" loading="lazy" style={{ width: hubCompact ? '32px' : '46px', height: hubCompact ? '32px' : '46px', borderRadius: '8px', objectFit: 'contain', background: '#0d1117', flexShrink: 0 }}
                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                    ) : hubHideLogos ? null : (
                      <div style={{ width: '46px', height: '46px', borderRadius: '8px', background: '#0d1117', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Tv2 size={18} color="#8b949e" />
                      </div>
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <h3 title={ch.name} style={{ fontSize: '13.5px', fontWeight: 600, margin: '0 0 3px 0', color: '#f0f6fc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name || 'Unknown channel'}</h3>
                      <p style={{ fontSize: '12px', color: '#8b949e', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.group || 'Live'}</p>
                    </div>
                    <button
                      onClick={(event) => { event.stopPropagation(); toggleFavorite(ch.url); }}
                      aria-label={favChannels.includes(ch.url) ? `Unfavorite ${ch.name}` : `Favorite ${ch.name}`}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0, color: favChannels.includes(ch.url) ? '#f5c518' : '#30363d' }}
                    >
                      <Star size={15} fill={favChannels.includes(ch.url) ? '#f5c518' : 'none'} />
                    </button>
                    <Play size={14} fill="#58a6ff" color="#58a6ff" style={{ flexShrink: 0 }} />
                  </div>
                ))}
              </div>

              {filteredPlaylistChannels.length > hubLimit && (
                <div style={{ textAlign: 'center', marginTop: '16px' }}>
                  <button
                    onClick={() => setHubLimit((v) => v + 250)}
                    style={{ padding: '9px 22px', borderRadius: '10px', border: '1px solid #30363d', background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Show more ({(filteredPlaylistChannels.length - hubLimit).toLocaleString()} remaining)
                  </button>
                </div>
              )}
            </>
          ) : (
            <div style={{ background: '#161b22', border: '1px dashed #30363d', borderRadius: '12px', padding: '40px 24px', textAlign: 'center' }}>
              <Tv2 size={34} color="#8b949e" style={{ margin: '0 auto 12px' }} />
              <h3 style={{ margin: '0 0 8px', fontSize: '16px', color: '#f0f6fc' }}>No source loaded</h3>
              <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#8b949e' }}>
                Load iptv-org, StepDaddyLiveHD or any community source — its channels fill this hub.
              </p>
              <button
                onClick={() => setActiveTab('sources')}
                style={{ padding: '9px 20px', borderRadius: '10px', border: 'none', background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                Open Sources
              </button>
            </div>
          )}
        </div>
      )}


      {/* ════════════════════════════════════════════════════════════════════════
          TAB 2: LIVE MATCHES & PPV
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'matches' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
              Live matches powered by <strong style={{ color: 'var(--text)' }}>Nuvio Live Sports</strong> + Dami-TV / PPV.to
            </span>
            <button
              onClick={loadLiveMatches}
              disabled={matchesLoading}
              className="button button-secondary button-small"
            >
              <RefreshCw size={13} className={matchesLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {matchesError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: '#f87171', fontSize: '12px' }}>
              <CircleAlert size={14} /> {matchesError}
            </div>
          )}

          {matchesLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
              <LoaderCircle size={36} color="var(--accent)" className="animate-spin" />
              <p style={{ marginTop: '16px', color: 'var(--muted)', fontSize: '14px' }}>Querying live sports and PPV schedule...</p>
            </div>
          ) : matches.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', background: 'var(--surface)', borderRadius: '12px', border: '1px solid var(--line)' }}>
              <Radio size={40} color="var(--muted)" style={{ margin: '0 auto 12px' }} />
              <p style={{ fontSize: '15px', color: 'var(--text)', margin: '0 0 6px' }}>{matchesError || 'No live sports currently listed'}</p>
              <p style={{ fontSize: '13px', color: 'var(--muted)', margin: 0 }}>
                Check back shortly before match kickoff times or explore 24/7 channels in Channels Hub.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '14px' }}>
              {matches.map((m) => (
                <div
                  key={m.id}
                  style={{
                    overflow: 'hidden', background: 'var(--surface)', borderRadius: '14px', border: '1px solid var(--line)',
                    display: 'flex', flexDirection: 'column',
                  }}
                >
                  {/* Poster banner with league + LIVE chips */}
                  <div style={{ position: 'relative', aspectRatio: '16 / 9', background: 'var(--surface-2)', flexShrink: 0 }}>
                    {m.poster ? (
                      <img src={m.poster} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted-2)' }}>
                        <Radio size={34} />
                      </div>
                    )}
                    <div style={{ position: 'absolute', inset: 'auto 0 0', height: '55%', background: 'linear-gradient(0deg, rgba(5,6,8,.85), rgba(5,6,8,0))' }} />
                    <span style={{ position: 'absolute', left: '9px', top: '9px', padding: '3px 9px', borderRadius: '999px', background: 'rgba(5,6,8,.82)', color: '#f87171', fontSize: '10px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      {m.isLive && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#7ee787' }} />}
                      {m.timeLabel}
                    </span>
                    <span style={{ position: 'absolute', right: '9px', top: '9px', padding: '3px 9px', borderRadius: '999px', background: 'rgba(5,6,8,.82)', color: 'var(--text)', fontSize: '10px', fontWeight: 700 }}>{m.league}</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, padding: '12px 14px 14px' }}>
                    <h4 style={{ fontSize: '14px', fontWeight: 650, margin: 0, color: 'var(--text)', lineHeight: 1.35 }}>{m.title}</h4>
                    {m.viewers !== undefined && m.viewers > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--muted)' }}>
                        <Users size={12} />
                        <span>{m.viewers.toLocaleString()} watching</span>
                      </div>
                    )}
                    <button
                      onClick={() => void playMatch(m)}
                      disabled={resolvingMatchId === m.id}
                      style={{
                        marginTop: 'auto',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                        width: '100%', minHeight: '38px', padding: '8px 0', borderRadius: '9px', border: 'none',
                        background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      {resolvingMatchId === m.id ? (
                        <>
                          <LoaderCircle size={14} className="animate-spin" /> Finding stream…
                        </>
                      ) : (
                        <>
                          <Play size={14} fill="currentColor" />
                          Watch Stream
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 3: M3U PLAYLISTS
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'playlists' && (
        <div>
          {/* Preset Buttons & Import */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto' }}>
              {Object.keys(M3uParser.defaultPlaylists).map((pName) => (
                <button
                  key={pName}
                  onClick={() => {
                    setActivePreset(pName);
                    loadPresetPlaylist(pName);
                  }}
                  style={{
                    padding: '6px 14px', borderRadius: '20px', border: '1px solid',
                    borderColor: activePreset === pName ? '#ef4444' : '#30363d',
                    background: activePreset === pName ? 'rgba(239, 68, 68, 0.15)' : '#161b22',
                    color: activePreset === pName ? '#f87171' : '#c9d1d9',
                    fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                  }}
                >
                  {pName}
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowImportDialog(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '7px 14px', borderRadius: '8px', border: '1px solid #30363d',
                background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              <Plus size={15} />
              Import M3U Playlist
            </button>
          </div>

          {customPlaylists.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', color: '#8b949e' }}>MY PLAYLISTS</p>
              <div style={{ display: 'grid', gap: '8px' }}>
                {customPlaylists.map((playlist) => (
                  <div key={playlist.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', border: '1px solid #30363d', borderRadius: '10px', background: '#161b22' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ display: 'block', fontSize: '13px', color: '#f0f6fc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlist.name}</strong>
                      <small style={{ fontSize: '11px', color: '#8b949e' }}>{playlist.channels.length.toLocaleString()} channels · {(() => { try { return new URL(playlist.sourceUrl).hostname; } catch { return playlist.sourceUrl; } })()}</small>
                    </div>
                    <button
                      onClick={() => { setPlaylistChannels(playlist.channels); setActiveSourceName(playlist.name); setSourceGroup('All'); setHubLimit(250); setActiveTab('channels'); }}
                      style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid #58a6ff', background: 'rgba(88,166,255,.1)', color: '#58a6ff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Load
                    </button>
                    <button
                      onClick={() => {
                        const updated = customPlaylists.filter((entry) => entry.id !== playlist.id);
                        setCustomPlaylists(updated);
                        IptvStore.savePlaylists(updated);
                      }}
                      aria-label={`Delete ${playlist.name}`}
                      style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#f87171', fontSize: '12px', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Public sources — every source loads directly from this tab */}
          <div style={{ marginBottom: '16px' }}>
            <p style={{ margin: '0 0 8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', color: '#8b949e' }}>PUBLIC SOURCES</p>
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', flexWrap: 'wrap' }}>
              {IptvSources.CATALOG.filter((s) => s.kind === 'playlist' && s.url).map((source) => (
                <button
                  key={source.id}
                  onClick={() => void loadSourceUrl(source, source.url!)}
                  disabled={Boolean(sourceBusy)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '6px 14px', borderRadius: '20px', border: '1px solid',
                    borderColor: activeSourceName === source.name ? '#d6f77a' : 'rgba(214, 247, 122, 0.4)',
                    background: activeSourceName === source.name ? 'rgba(214, 247, 122, 0.15)' : 'transparent',
                    color: activeSourceName === source.name ? '#d6f77a' : '#c9d1d9',
                    fontSize: '13px', fontWeight: 500, cursor: 'pointer',
                  }}
                >
                  {sourceBusy === source.id ? <LoaderCircle size={13} className="spin" /> : <Radio size={13} />}
                  {source.name}
                </button>
              ))}
            </div>
            {sourceStatus && <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#8b949e' }}>{sourceStatus}</p>}
          </div>

          {playlistLoading ? (
            <SkeletonGrid count={12} variant="row" minColumnWidth={260} label={`Loading ${activePreset} playlist channels…`} />
          ) : filteredPlaylistChannels.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', background: '#161b22', borderRadius: '12px', border: '1px solid #30363d' }}>
              <CircleAlert size={36} color="#8b949e" style={{ margin: '0 auto 12px' }} />
              <p style={{ fontSize: '15px', color: '#f0f6fc', margin: 0 }}>No channels found in this playlist</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
              {filteredPlaylistChannels.map((ch, idx) => (
                <div
                  key={`${ch.url}-${idx}`}
                  onClick={() => playStreamNow(ch.name, ch.url, ch.group || activePreset, ch.logo)}
                  style={{
                    background: '#161b22', borderRadius: '10px', border: '1px solid #30363d',
                    padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = '#ef4444';
                    e.currentTarget.style.background = '#1c2128';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#30363d';
                    e.currentTarget.style.background = '#161b22';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden' }}>
                    {ch.logo ? (
                      <img
                        src={ch.logo}
                        alt=""
                        style={{ width: '32px', height: '32px', objectFit: 'contain', borderRadius: '6px', flexShrink: 0 }}
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{
                        width: '32px', height: '32px', borderRadius: '6px',
                        background: '#21262d', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#8b949e', flexShrink: 0
                      }}>
                        <Tv size={16} />
                      </div>
                    )}
                    <div style={{ overflow: 'hidden' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#f0f6fc', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                        {ch.name}
                      </div>
                      <div style={{ fontSize: '12px', color: '#8b949e' }}>
                        {ch.group || activePreset}
                      </div>
                    </div>
                  </div>

                  <div style={{
                    width: '30px', height: '30px', borderRadius: '50%',
                    background: 'rgba(239, 68, 68, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#ef4444', flexShrink: 0, marginLeft: '8px'
                  }}>
                    <Play size={13} fill="#ef4444" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Import M3U Dialog */}
          {showImportDialog && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
            }}>
              <div style={{
                background: '#161b22', border: '1px solid #30363d', borderRadius: '16px',
                width: '100%', maxWidth: '480px', padding: '24px', position: 'relative',
              }}>
                <button
                  onClick={() => setShowImportDialog(false)}
                  style={{ position: 'absolute', right: '16px', top: '16px', background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                >
                  <X size={20} />
                </button>
                <h3 style={{ margin: '0 0 16px', fontSize: '17px', color: '#f0f6fc' }}>Import M3U Playlist</h3>

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Playlist Name (Optional)</label>
                  <input
                    type="text"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="My Sports Channels"
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Playlist URL (.m3u / .m3u8)</label>
                  <input
                    type="text"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder="https://example.com/playlist.m3u"
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Or Paste Raw M3U Content</label>
                  <textarea
                    rows={4}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="#EXTM3U&#10;#EXTINF:-1,Channel 1&#10;http://..."
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box', resize: 'vertical' }}
                  />
                </div>

                {importError && (
                  <p style={{ color: '#f87171', fontSize: '12px', margin: '0 0 12px' }}>{importError}</p>
                )}

                <button
                  onClick={handleImportPlaylist}
                  style={{
                    width: '100%', padding: '10px 0', borderRadius: '8px', border: 'none',
                    background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Parse & Save Playlist
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 2: PUBLIC SOURCES (iptv-org + StepDaddyLiveHD are the mains)
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'sources' && (
        <div>
          <p style={{ color: '#8b949e', fontSize: '13px', margin: '0 0 14px' }}>
            Pick any source you need. The two main sources lead the list; community sources, XMLTV EPG guides and
            Xtream portal scraping all stay available.
          </p>

          {sourceStatus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.3)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', color: '#4ade80', fontSize: '13px' }}>
              <Check size={15} /> {sourceStatus}
            </div>
          )}
          {sourceError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(248, 113, 113, 0.1)', border: '1px solid rgba(248, 113, 113, 0.3)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', color: '#f87171', fontSize: '13px' }}>
              <CircleAlert size={15} /> {sourceError}
            </div>
          )}

          {/* ── MAIN: iptv-org ── */}
          <div style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.03))', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '12px', padding: '16px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Globe size={18} color="#ef4444" />
                <strong style={{ color: '#f0f6fc', fontSize: '15px' }}>iptv-org</strong>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: '#ef4444', background: 'rgba(239, 68, 68, 0.15)', borderRadius: '4px', padding: '2px 6px' }}>MAIN</span>
              </div>
              <button
                onClick={() => openSafeExternalUrl('https://iptv-org.github.io/')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'transparent', border: 'none', color: '#8b949e', fontSize: '12px', cursor: 'pointer' }}
              >
                <ExternalLink size={12} /> iptv-org.github.io
              </button>
            </div>
            <p style={{ color: '#8b949e', fontSize: '12.5px', margin: '0 0 12px' }}>{IptvSources.CATALOG.find((s) => s.id === 'iptv-org')?.description}</p>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
              <select
                value={iptvOrgCountry}
                onChange={(e) => { setIptvOrgCountry(e.target.value); IptvSourceStore.saveIptvOrgCountry(e.target.value); }}
                style={{ padding: '8px 10px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', flex: 1, minWidth: '180px' }}
                aria-label="iptv-org country"
              >
                {iptvOrgCountries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={() => void loadIptvOrg('country')}
                disabled={Boolean(sourceBusy)}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                {sourceBusy === 'iptv-org' ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}
                Load country
              </button>
              <button
                onClick={() => void loadIptvOrg('all')}
                disabled={Boolean(sourceBusy)}
                style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                All channels
              </button>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {IptvSources.IPTV_ORG_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => void loadIptvOrg('category', cat)}
                  disabled={Boolean(sourceBusy)}
                  style={{
                    padding: '5px 12px', borderRadius: '999px', border: '1px solid #30363d',
                    background: '#161b22', color: '#c9d1d9', fontSize: '12px', cursor: 'pointer', textTransform: 'capitalize',
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* ── MAIN: StepDaddyLiveHD (self-hosted) ── */}
          <div style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.03))', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: '12px', padding: '16px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Radio size={18} color="#ef4444" />
                <strong style={{ color: '#f0f6fc', fontSize: '15px' }}>StepDaddyLiveHD</strong>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: '#ef4444', background: 'rgba(239, 68, 68, 0.15)', borderRadius: '4px', padding: '2px 6px' }}>MAIN</span>
              </div>
              <button
                onClick={() => openSafeExternalUrl('https://github.com/gookie-dev/StepDaddyLiveHD')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'transparent', border: 'none', color: '#8b949e', fontSize: '12px', cursor: 'pointer' }}
              >
                <ExternalLink size={12} /> Setup guide
              </button>
            </div>
            <p style={{ color: '#8b949e', fontSize: '12.5px', margin: '0 0 12px' }}>{IptvSources.CATALOG.find((s) => s.id === 'stepdaddy')?.description}</p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={stepDaddyUrl}
                onChange={(e) => setStepDaddyUrl(e.target.value)}
                placeholder="http://192.168.1.10:3000"
                style={{ flex: 1, minWidth: '220px', padding: '8px 10px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px' }}
                aria-label="StepDaddyLiveHD server URL"
              />
              <button
                onClick={() => void connectStepDaddy()}
                disabled={Boolean(sourceBusy)}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px', border: 'none', background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                {sourceBusy === 'stepdaddy' ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}
                Connect
              </button>
            </div>
          </div>

          {/* ── Community sources ── */}
          <h3 style={{ color: '#f0f6fc', fontSize: '14px', margin: '4px 0 10px' }}>Community sources</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px', marginBottom: '16px' }}>
            {IptvSources.CATALOG.filter((s) => !s.main).map((source) => (
              <div key={source.id} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <strong style={{ color: '#f0f6fc', fontSize: '13.5px' }}>{source.name}</strong>
                  {source.homepage && (
                    <button
                      onClick={() => openSafeExternalUrl(source.homepage!)}
                      style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'transparent', border: 'none', color: '#8b949e', fontSize: '11.5px', cursor: 'pointer' }}
                    >
                      <ExternalLink size={11} /> link
                    </button>
                  )}
                </div>
                <p style={{ color: '#8b949e', fontSize: '12px', margin: 0, flex: 1 }}>{source.description}</p>
                {source.kind === 'playlist' && source.url && (
                  <button
                    onClick={() => void loadSourceUrl(source, source.url!)}
                    disabled={Boolean(sourceBusy)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px 0', borderRadius: '8px', border: 'none', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {sourceBusy === source.id ? <LoaderCircle size={14} className="spin" /> : <Tv size={13} />}
                    Load channels
                  </button>
                )}
                {source.kind === 'web' && (
                  <button
                    onClick={() => openSafeExternalUrl(source.homepage || 'https://iptvcat.net/home_7')}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px 0', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#f0f6fc', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    <ExternalLink size={13} /> Open website
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* ── EPG guides ── */}
          <h3 style={{ color: '#f0f6fc', fontSize: '14px', margin: '0 0 10px' }}>EPG guides (XMLTV)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
            {IptvSources.EPG_GUIDES.map((guide) => (
              <div key={guide.id} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <strong style={{ color: '#f0f6fc', fontSize: '13px' }}>{guide.name}</strong>
                <p style={{ color: '#8b949e', fontSize: '12px', margin: 0 }}>{guide.description}</p>
                <button
                  onClick={() => {
                    if (guide.epgUrl) void navigator.clipboard.writeText(guide.epgUrl).then(() => setSourceStatus(`EPG URL copied: ${guide.epgUrl}`)).catch(() => undefined);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 0', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                >
                  <Copy size={12} /> Copy guide URL
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 4: XTREAM PORTALS
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'portals' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button
                onClick={runPortalScraper}
                disabled={scrapingPortals}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '8px 16px', borderRadius: '8px', border: 'none',
                  background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                <Sparkles size={15} />
                {scrapingPortals ? 'Scraping Portals...' : 'Scrape Active Portals'}
              </button>

              <button
                onClick={() => setShowAddPortalDialog(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '8px 16px', borderRadius: '8px', border: '1px solid #30363d',
                  background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                <Plus size={15} />
                Add Xtream Portal
              </button>
            </div>

            {portalStatus && (
              <span style={{ fontSize: '12px', color: '#7ee787' }}>{portalStatus}</span>
            )}
          </div>

          {portals.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', background: '#161b22', borderRadius: '12px', border: '1px solid #30363d' }}>
              <Globe size={40} color="#8b949e" style={{ margin: '0 auto 12px' }} />
              <p style={{ fontSize: '15px', color: '#f0f6fc', margin: '0 0 6px' }}>No Xtream-Codes Portals Saved</p>
              <p style={{ fontSize: '13px', color: '#8b949e', margin: '0 0 16px' }}>
                Click 'Scrape Active Portals' to pull verified community portals or enter your own Xtream server.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '14px' }}>
              {portals.map((vp, idx) => (
                <div
                  key={`${vp.portal.url}-${idx}`}
                  style={{
                    background: '#161b22', borderRadius: '12px', border: '1px solid #30363d',
                    padding: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#7ee787', background: 'rgba(126, 231, 135, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                        ACTIVE
                      </span>
                      <span style={{ fontSize: '12px', color: '#8b949e' }}>Expires: {vp.expiry}</span>
                    </div>

                    <h4 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 4px', color: '#f0f6fc' }}>
                      {vp.name}
                    </h4>
                    <p style={{ fontSize: '12px', color: '#8b949e', margin: '0 0 12px', wordBreak: 'break-all' }}>
                      {vp.portal.url}
                    </p>

                    <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#8b949e' }}>
                      <span>Max Cons: {vp.maxConnections}</span>
                      <span>Active: {vp.activeConnections}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => openPortalBrowser(vp)}
                    style={{
                      marginTop: '14px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      width: '100%', padding: '8px 0', borderRadius: '8px', border: '1px solid #30363d',
                      background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <ListFilter size={14} />
                    Browse Channels
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add Portal Dialog */}
          {showAddPortalDialog && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
            }}>
              <div style={{
                background: '#161b22', border: '1px solid #30363d', borderRadius: '16px',
                width: '100%', maxWidth: '440px', padding: '24px', position: 'relative',
              }}>
                <button
                  onClick={() => setShowAddPortalDialog(false)}
                  style={{ position: 'absolute', right: '16px', top: '16px', background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                >
                  <X size={20} />
                </button>
                <h3 style={{ margin: '0 0 16px', fontSize: '17px', color: '#f0f6fc' }}>Add Xtream-Codes Portal</h3>

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Server URL (Host:Port)</label>
                  <input
                    type="text"
                    value={newPortalUrl}
                    onChange={(e) => setNewPortalUrl(e.target.value)}
                    placeholder="http://iptv-server.com:8080"
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Username</label>
                  <input
                    type="text"
                    value={newPortalUser}
                    onChange={(e) => setNewPortalUser(e.target.value)}
                    placeholder="user123"
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>Password</label>
                  <input
                    type="text"
                    value={newPortalPass}
                    onChange={(e) => setNewPortalPass(e.target.value)}
                    placeholder="pass123"
                    style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', color: '#c9d1d9', fontSize: '13px', boxSizing: 'border-box' }}
                  />
                </div>

                {addPortalError && (
                  <p style={{ color: '#f87171', fontSize: '12px', margin: '0 0 12px' }}>{addPortalError}</p>
                )}

                <button
                  onClick={handleAddPortal}
                  disabled={addPortalBusy}
                  style={{
                    width: '100%', padding: '10px 0', borderRadius: '8px', border: 'none',
                    background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {addPortalBusy ? 'Verifying Credentials...' : 'Verify & Add Portal'}
                </button>
              </div>
            </div>
          )}

          {/* Portal Streams Browser Modal */}
          {browsingPortal && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
            }}>
              <div style={{
                background: '#161b22', border: '1px solid #30363d', borderRadius: '16px',
                width: '100%', maxWidth: '720px', height: '80vh', display: 'flex', flexDirection: 'column',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{ padding: '20px', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '16px', color: '#f0f6fc' }}>{browsingPortal.name} · Live Channels</h3>
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#8b949e' }}>{browsingPortal.portal.url}</p>
                  </div>
                  <button
                    onClick={() => setBrowsingPortal(null)}
                    style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                  >
                    <X size={20} />
                  </button>
                </div>

                {/* Categories */}
                {portalCategories.length > 0 && (
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', padding: '12px 20px', borderBottom: '1px solid #21262d' }}>
                    {portalCategories.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => selectPortalCategory(c.id)}
                        style={{
                          padding: '4px 12px', borderRadius: '14px', border: '1px solid',
                          borderColor: selectedPortalCategory === c.id ? '#ef4444' : '#30363d',
                          background: selectedPortalCategory === c.id ? 'rgba(239, 68, 68, 0.15)' : '#0d1117',
                          color: selectedPortalCategory === c.id ? '#f87171' : '#c9d1d9',
                          fontSize: '12px', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}

                {/* Streams List */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
                  {portalStreamsLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                      <LoaderCircle size={32} color="#ef4444" className="animate-spin" />
                      <p style={{ marginTop: '12px', fontSize: '13px', color: '#8b949e' }}>Loading channels...</p>
                    </div>
                  ) : portalStreams.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#8b949e', fontSize: '14px', marginTop: '40px' }}>No live streams in this category.</p>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
                      {portalStreams.map((s) => {
                        const streamUrl = IptvClient.streamUrl(browsingPortal.portal, s);
                        return (
                          <div
                            key={s.streamId}
                            onClick={() => {
                              playStreamNow(s.name, streamUrl, browsingPortal.name, s.icon);
                              setBrowsingPortal(null);
                            }}
                            style={{
                              background: '#0d1117', borderRadius: '8px', border: '1px solid #30363d',
                              padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ overflow: 'hidden', paddingRight: '10px' }}>
                              <div style={{ fontSize: '13px', fontWeight: 600, color: '#f0f6fc', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                                {s.name}
                              </div>
                              <div style={{ fontSize: '12px', color: '#8b949e' }}>Xtream Live Feed</div>
                            </div>
                            <Play size={14} fill="#ef4444" color="#ef4444" style={{ flexShrink: 0 }} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
export default LiveTvView;

