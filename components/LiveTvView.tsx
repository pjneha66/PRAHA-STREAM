import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, Check, CircleAlert, Globe, ListFilter, LoaderCircle,
  Play, Plus, Radio, RefreshCw, Search, ShieldCheck, Sparkles,
  Tv, Tv2, Users, Volume2, X,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import {
  HardcodedChannels, type HardcodedChannel,
  IptvClient, type IptvCategory, type IptvPortal, type IptvStream, type VerifiedPortal,
  IptvScraper, IptvStore, M3uParser, type M3uChannel, type M3uPlaylist,
  LiveMatchesScraper, type LiveMatchEvent,
} from '../services/iptvService';

interface LiveTvViewProps {
  onPlayStream: (media: MediaItem, stream: StreamResult) => void;
}

type LiveTvTab = 'channels' | 'matches' | 'playlists' | 'portals';

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

  // ── M3U Playlists State ──
  const [activePreset, setActivePreset] = useState<string>('Sports');
  const [playlistChannels, setPlaylistChannels] = useState<M3uChannel[]>([]);
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

  // ── Load Initial Data ──
  useEffect(() => {
    loadPresetPlaylist(activePreset);
    loadLiveMatches();
  }, []);

  // ── M3U Loader ──
  const loadPresetPlaylist = async (presetName: string) => {
    const url = M3uParser.defaultPlaylists[presetName];
    if (!url) return;
    setPlaylistLoading(true);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const parsed = M3uParser.parse(text);
      setPlaylistChannels(parsed);
    } catch {
      // Fallback: try proxy
      try {
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const resp2 = await fetch(proxyUrl);
        const text2 = await resp2.text();
        setPlaylistChannels(M3uParser.parse(text2));
      } catch {
        setPlaylistChannels([]);
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
      const [dami, ppv] = await Promise.all([
        LiveMatchesScraper.fetchDamiTvMatches().catch(() => []),
        LiveMatchesScraper.fetchPpvMatches().catch(() => []),
      ]);
      const combined = [...dami, ...ppv];
      setMatches(combined);
      if (combined.length === 0) {
        setMatchesError('No live sports events currently scheduled or endpoints uncontactable.');
      }
    } catch {
      setMatchesError('Failed to load live sports schedule.');
    } finally {
      setMatchesLoading(false);
    }
  };

  // ── Portal Scraper ──
  const runPortalScraper = async () => {
    setScrapingPortals(true);
    setPortalStatus('Scraping Xtream-Codes portals from community catalog...');
    try {
      const rawPortals = await IptvScraper.scrapeRedditPortals(30);
      const candidates = rawPortals.length > 0 ? rawPortals : IptvScraper.getFallbackPortals();
      setPortalStatus(`Found ${candidates.length} candidate portals. Verifying authentication...`);

      const verifiedList: VerifiedPortal[] = [];
      for (const p of candidates.slice(0, 10)) {
        try {
          const v = await IptvClient.verifyOrNull(p, 4000);
          if (v) verifiedList.push(v);
        } catch {
          // ignore dead portal
        }
      }

      if (verifiedList.length > 0) {
        const updated = [...portals, ...verifiedList.filter(v => !portals.some(p => p.portal.url === v.portal.url))];
        setPortals(updated);
        IptvStore.savePortals(updated);
        setPortalStatus(`Added ${verifiedList.length} verified active portals.`);
      } else {
        setPortalStatus('No new active portals responded to login checks.');
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

    setChannelHits(hits);
    setScanningBusy(false);

    // If exact hits found, auto-play first stream immediately
    if (hits.length === 1) {
      playStreamNow(channel.name, hits[0].url, hits[0].source, channel.logo);
    }
  };

  // ── Player Bridge ──
  const playStreamNow = (title: string, streamUrl: string, groupOrSource: string, poster?: string) => {
    const media: MediaItem = {
      id: `livetv-${Date.now()}`,
      title,
      type: 'movie',
      source: 'iptv',
      poster: poster || 'https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=600&q=80',
      overview: `Live TV Stream · Broadcast via ${groupOrSource}`,
      genres: ['Live TV', groupOrSource],
    };

    const stream: StreamResult = {
      id: `livetv-stream-${Date.now()}`,
      title,
      url: streamUrl,
      sourceName: groupOrSource || 'Live TV',
      sourceType: 'iptv',
      quality: '1080p',
      format: streamUrl.includes('.m3u8') ? 'hls' : 'direct',
    };

    onPlayStream(media, stream);
  };

  // ── Import Custom M3U ──
  const handleImportPlaylist = async () => {
    setImportError('');
    try {
      let channels: M3uChannel[] = [];
      let sourceUrl = importUrl.trim();

      if (sourceUrl) {
        const resp = await fetch(sourceUrl);
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

  const filteredPlaylistChannels = useMemo(() => {
    if (!searchQuery) return playlistChannels.slice(0, 150);
    const q = searchQuery.toLowerCase();
    return playlistChannels.filter(c => c.name.toLowerCase().includes(q) || (c.group && c.group.toLowerCase().includes(q))).slice(0, 150);
  }, [playlistChannels, searchQuery]);

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
          {(['channels', 'matches', 'playlists', 'portals'] as LiveTvTab[]).map((tab) => (
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
                transition: 'all 0.15s ease',
                textTransform: 'capitalize',
              }}
            >
              {tab === 'channels' ? 'Channels Hub' : tab === 'matches' ? 'Live Matches' : tab === 'playlists' ? 'M3U Playlists' : 'Xtream Portals'}
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
          TAB 1: CHANNELS HUB
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'channels' && (
        <div>
          {/* Category Pills */}
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '14px', marginBottom: '16px' }}>
            {CATEGORY_FILTERS.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '20px',
                  border: '1px solid',
                  borderColor: selectedCategory === cat ? '#ef4444' : '#30363d',
                  background: selectedCategory === cat ? 'rgba(239, 68, 68, 0.15)' : '#161b22',
                  color: selectedCategory === cat ? '#f87171' : '#c9d1d9',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Channels Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px' }}>
            {filteredHardcoded.map((channel) => (
              <div
                key={channel.id}
                onClick={() => scanCuratedChannel(channel)}
                style={{
                  background: '#161b22',
                  borderRadius: '12px',
                  border: '1px solid #30363d',
                  padding: '16px',
                  cursor: 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                  transition: 'transform 0.2s, border-color 0.2s',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  minHeight: '130px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-3px)';
                  e.currentTarget.style.borderColor = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.borderColor = '#30363d';
                }}
              >
                {/* Background accent gradient badge */}
                <div style={{
                  position: 'absolute', top: 0, right: 0, width: '70px', height: '70px',
                  background: `linear-gradient(135deg, transparent, ${channel.gradient[0]}22)`,
                  borderBottomLeftRadius: '40px',
                }} />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    padding: '3px 8px',
                    borderRadius: '6px',
                    background: channel.gradient[0],
                    color: '#ffffff',
                    letterSpacing: '0.04em',
                  }}>
                    {channel.shortName}
                  </span>
                  <span style={{ fontSize: '11px', color: '#8b949e' }}>{channel.category}</span>
                </div>

                <div style={{ marginTop: '12px' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 4px 0', color: '#f0f6fc' }}>{channel.name}</h3>
                  <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
                    1-Click Stream Finder
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '12px', fontSize: '12px', color: '#58a6ff' }}>
                  <Play size={13} fill="#58a6ff" />
                  <span>Scan & Play</span>
                </div>
              </div>
            ))}
          </div>

          {/* Channel Scanner Modal */}
          {scanningChannel && (
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
              padding: '20px',
            }}>
              <div style={{
                background: '#161b22', border: '1px solid #30363d', borderRadius: '16px',
                width: '100%', maxWidth: '520px', padding: '24px', position: 'relative',
              }}>
                <button
                  onClick={() => setScanningChannel(null)}
                  style={{ position: 'absolute', right: '16px', top: '16px', background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                >
                  <X size={20} />
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                  <div style={{
                    width: '36px', height: '36px', borderRadius: '8px',
                    background: scanningChannel.gradient[0], display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#ffffff', fontWeight: 700, fontSize: '12px'
                  }}>
                    {scanningChannel.shortName}
                  </div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '17px', color: '#f0f6fc' }}>{scanningChannel.name}</h3>
                    <p style={{ margin: 0, fontSize: '12px', color: '#8b949e' }}>Live Multi-Source Scanner</p>
                  </div>
                </div>

                {scanningBusy ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 0' }}>
                    <LoaderCircle size={32} color="#ef4444" className="animate-spin" />
                    <p style={{ marginTop: '14px', fontSize: '13px', color: '#c9d1d9' }}>
                      Querying default M3U feeds & active Xtream portals...
                    </p>
                  </div>
                ) : channelHits.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center' }}>
                    <CircleAlert size={36} color="#f87171" style={{ margin: '0 auto 12px' }} />
                    <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#f0f6fc' }}>No Active Feeds Found in Initial Pool</p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#8b949e' }}>
                      Add a custom playlist in M3U Playlists or scrape additional Xtream Portals in the Portals tab.
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontSize: '13px', color: '#7ee787', marginBottom: '12px' }}>
                      Found {channelHits.length} live stream source(s):
                    </p>
                    <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {channelHits.map((hit, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '10px 14px', background: '#0d1117', borderRadius: '8px', border: '1px solid #30363d',
                          }}
                        >
                          <div style={{ overflow: 'hidden', paddingRight: '12px' }}>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: '#f0f6fc', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                              {hit.name}
                            </div>
                            <div style={{ fontSize: '11px', color: '#8b949e' }}>{hit.source}</div>
                          </div>
                          <button
                            onClick={() => {
                              playStreamNow(scanningChannel.name, hit.url, hit.source, scanningChannel.logo);
                              setScanningChannel(null);
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '6px',
                              padding: '6px 12px', borderRadius: '6px', border: 'none',
                              background: '#ef4444', color: '#ffffff', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            <Play size={12} fill="#ffffff" />
                            Play
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 2: LIVE MATCHES & PPV
          ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'matches' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <span style={{ fontSize: '13px', color: '#8b949e' }}>
              Real-time Sports Schedule (Dami-TV & PPV.to)
            </span>
            <button
              onClick={loadLiveMatches}
              disabled={matchesLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 12px', borderRadius: '6px', border: '1px solid #30363d',
                background: '#161b22', color: '#c9d1d9', fontSize: '12px', cursor: 'pointer',
              }}
            >
              <RefreshCw size={13} className={matchesLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {matchesLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
              <LoaderCircle size={36} color="#ef4444" className="animate-spin" />
              <p style={{ marginTop: '16px', color: '#8b949e', fontSize: '14px' }}>Querying live sports and PPV schedule...</p>
            </div>
          ) : matches.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', background: '#161b22', borderRadius: '12px', border: '1px solid #30363d' }}>
              <Radio size={40} color="#8b949e" style={{ margin: '0 auto 12px' }} />
              <p style={{ fontSize: '15px', color: '#f0f6fc', margin: '0 0 6px' }}>{matchesError || 'No live sports currently listed'}</p>
              <p style={{ fontSize: '13px', color: '#8b949e', margin: 0 }}>
                Check back shortly before match kickoff times or explore 24/7 channels in Channels Hub.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '14px' }}>
              {matches.map((m) => (
                <div
                  key={m.id}
                  style={{
                    background: '#161b22', borderRadius: '12px', border: '1px solid #30363d',
                    padding: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#f87171', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                        {m.league}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: 600,
                        color: m.isLive ? '#7ee787' : '#8b949e',
                        display: 'flex', alignItems: 'center', gap: '4px',
                      }}>
                        {m.isLive && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#7ee787' }} />}
                        {m.timeLabel}
                      </span>
                    </div>

                    <h4 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 8px 0', color: '#f0f6fc' }}>{m.title}</h4>
                    {m.viewers !== undefined && m.viewers > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#8b949e' }}>
                        <Users size={12} />
                        <span>{m.viewers.toLocaleString()} watching</span>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => playStreamNow(m.title, m.streamUrl, m.league, m.poster)}
                    style={{
                      marginTop: '14px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                      width: '100%', padding: '9px 0', borderRadius: '8px', border: 'none',
                      background: '#ef4444', color: '#ffffff', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <Play size={14} fill="#ffffff" />
                    Watch Stream
                  </button>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
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

          {playlistLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
              <LoaderCircle size={36} color="#ef4444" className="animate-spin" />
              <p style={{ marginTop: '16px', color: '#8b949e', fontSize: '14px' }}>Loading {activePreset} playlist channels...</p>
            </div>
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
                      <div style={{ fontSize: '11px', color: '#8b949e' }}>
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
                      <span style={{ fontSize: '11px', fontWeight: 700, color: '#7ee787', background: 'rgba(126, 231, 135, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                        ACTIVE
                      </span>
                      <span style={{ fontSize: '11px', color: '#8b949e' }}>Expires: {vp.expiry}</span>
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
                              <div style={{ fontSize: '11px', color: '#8b949e' }}>Xtream Live Feed</div>
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

