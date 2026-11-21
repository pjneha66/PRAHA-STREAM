// Live TV hub — TypeScript port of VyseTV's Flutter Live TV screens.
//
// The public contract is unchanged: default-export a view that reports a
// playable stream through `onPlayStream`. All data comes from the ported
// services under `services/liveTv/`; the list is windowed so a 5,000-channel
// playlist never mounts more than a few dozen cards on a phone.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './live-tv.css';
import type { MediaItem, StreamResult } from '../types';
import { currentNsfwMode, filterChannelsForNsfw } from '../services/nsfwGate';
import {
  buildGroupTree,
  buildIptvPlayback,
  detectIptvFormat,
  fetchEspnSchedule,
  flattenGroups,
  formatIptvBadge,
  HardcodedChannels,
  IptvController,
  IptvStore,
  IptvZapStore,
  LiveTvPrefs,
  loadFavoriteState,
  m3uFavoriteKey,
  nowNext,
  epgProgress,
  guideTime,
  dedupeLiveMatches,
  mergeMatchSources,
  decryptPasteSh,
  fetchPlaylist,
  isPasteShEncryptedUrl,
  pasteRawUrl,
  probeUrl,
  saveFavoriteState,
  type ChannelHit,
  type HardcodedChannel,
  type LiveMatchEvent,
  type M3uChannel,
  type ScheduleMatch,
} from '../services/iptvService';

export interface LiveTvViewProps {
  onPlayStream: (media: MediaItem, stream: StreamResult) => void;
}

type Tab = 'channels' | 'discover' | 'matches' | 'portals' | 'playlists';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'discover', label: 'Discover' },
  { id: 'matches', label: 'Matches' },
  { id: 'portals', label: 'Portals' },
  { id: 'playlists', label: 'Playlists' },
];

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 520;
const OVERSCAN = 5;

interface SheetTarget {
  channel: M3uChannel;
  mode: 'main' | 'alternates';
  alternates?: M3uChannel[];
}

function fallbackGuide(channel: M3uChannel) {
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  return [
    { title: `${channel.name} — Live`, start: hour, stop: hour + 3_600_000 },
    { title: 'Up next on this channel', start: hour + 3_600_000, stop: hour + 7_200_000 },
  ];
}

export default function LiveTvView({ onPlayStream }: LiveTvViewProps) {
  const controller = IptvController.instance;
  const [, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>('channels');
  const [playlists, setPlaylists] = useState(() => IptvStore.loadPlaylists());
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteKeys, setFavoriteKeys] = useState<string[]>(() => loadFavoriteState().keys);
  const [scrollTop, setScrollTop] = useState(0);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [selectedHardcoded, setSelectedHardcoded] = useState<HardcodedChannel | null>(null);
  const [matches, setMatches] = useState<LiveMatchEvent[]>([]);
  const [portalUrl, setPortalUrl] = useState('');
  const [portalUser, setPortalUser] = useState('');
  const [portalPass, setPortalPass] = useState('');
  const [portalJson, setPortalJson] = useState('');
  const [playlistName, setPlaylistName] = useState('');
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlistText, setPlaylistText] = useState('');
  const [notice, setNotice] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setTick((value) => value + 1));
    void controller.init();
    return unsubscribe;
  }, [controller]);

  const channels: M3uChannel[] = useMemo(() => playlists.flatMap((playlist) => playlist.channels), [playlists]);

  useEffect(() => {
    if (channels.length) IptvZapStore.set(channels, channels[0].url);
  }, [channels]);

  const groupChips = useMemo(() => {
    const tree = buildGroupTree(channels, (channel) => channel.group);
    return flattenGroups(tree).filter((node) => node.name !== 'All').slice(0, 12);
  }, [channels]);

  const visibleChannels = useMemo(() => {
    const mode = currentNsfwMode();
    const query = search.trim().toLowerCase();
    const list = filterChannelsForNsfw(channels, { nsfw: mode });
    return list.filter((channel) => {
      if (group && !(channel.group || '').toLowerCase().includes(group.toLowerCase())) return false;
      if (favoritesOnly && !favoriteKeys.includes(m3uFavoriteKey(channel.url))) return false;
      if (!query) return true;
      return `${channel.name} ${channel.group || ''}`.toLowerCase().includes(query);
    });
  }, [channels, search, group, favoritesOnly, favoriteKeys]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visibleChannels.length, start + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2);
  const windowed = visibleChannels.slice(start, end);

  const refreshPlaylists = useCallback(() => {
    setPlaylists(IptvStore.loadPlaylists());
    setFavoriteKeys(loadFavoriteState().keys);
  }, []);

  const play = useCallback((channel: M3uChannel) => {
    IptvZapStore.set(channels, channel.url);
    LiveTvPrefs.markPlayed(channel);
    const { media, stream } = buildIptvPlayback(channel);
    onPlayStream(media, stream);
  }, [channels, onPlayStream]);

  const toggleFavorite = useCallback((channel: M3uChannel) => {
    setFavoriteKeys((keys) => {
      const key = m3uFavoriteKey(channel.url);
      const next = keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
      saveFavoriteState(next, loadFavoriteState().entries);
      return next;
    });
  }, []);

  const checkHealth = useCallback(async (channel: M3uChannel) => {
    const result = await probeUrl(channel.url, 6000);
    LiveTvPrefs.setHealth(channel.url, {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      detail: result.ok ? 'Stream responds' : 'Unreachable',
    });
    setNotice(`${channel.name}: ${result.ok ? 'alive' : 'offline'} (${result.latencyMs} ms)`);
  }, []);

  useEffect(() => {
    if (tab !== 'matches' || matches.length) return;
    let active = true;
    void fetchEspnSchedule().then((schedule: ScheduleMatch[]) => {
      if (!active) return;
      setMatches(dedupeLiveMatches(mergeMatchSources([], schedule)));
    });
    return () => { active = false; };
  }, [tab, matches.length]);

  const selectHardcoded = useCallback((channel: HardcodedChannel) => {
    setSelectedHardcoded(channel);
    void controller.openHardcodedChannel(channel);
  }, [controller]);

  const playHit = useCallback((hit: ChannelHit) => {
    const channel: M3uChannel = {
      name: hit.stream.name || selectedHardcoded?.name || 'Live TV',
      url: hit.streamUrl,
      group: selectedHardcoded?.category,
      logo: hit.stream.icon || selectedHardcoded?.logo,
    };
    IptvZapStore.set(channels.length ? channels : [channel], channel.url);
    const { media, stream } = buildIptvPlayback(channel);
    onPlayStream(media, stream);
  }, [channels, onPlayStream, selectedHardcoded]);

  const catalog = useMemo(() => {
    const byCategory = new Map<string, HardcodedChannel[]>();
    for (const channel of HardcodedChannels.all) {
      const list = byCategory.get(channel.category) || [];
      list.push(channel);
      byCategory.set(channel.category, list);
    }
    return [...byCategory.entries()];
  }, []);

  const addPortal = useCallback(async () => {
    const ok = await controller.addManual(portalUrl, portalUser, portalPass);
    setNotice(ok ? 'Portal verified and saved.' : controller.addError || 'Could not verify portal.');
    if (ok) { setPortalUrl(''); setPortalUser(''); setPortalPass(''); }
  }, [controller, portalUrl, portalUser, portalPass]);

  const importPortalJson = useCallback(async () => {
    const result = await controller.importFromJsonString(portalJson);
    setNotice(result.error || `Imported ${result.added}, skipped ${result.skipped}, failed ${result.failed}.`);
  }, [controller, portalJson]);

  const addPlaylist = useCallback(async (source: 'url' | 'text') => {
    try {
      if (source === 'url') {
        if (!playlistUrl.trim()) return;
        await controller.addM3uFromUrl(playlistName, playlistUrl.trim());
      } else {
        if (!playlistText.trim()) return;
        await controller.addM3uFromContent(playlistName, playlistText);
      }
      refreshPlaylists();
      setNotice('Playlist added.');
      setPlaylistName(''); setPlaylistUrl(''); setPlaylistText('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [controller, playlistName, playlistText, playlistUrl, refreshPlaylists]);

  const importPastedPlaylist = useCallback(async () => {
    try {
      const url = playlistUrl.trim();
      if (!url) return;
      const raw = pasteRawUrl(url) || url;
      const text = isPasteShEncryptedUrl(url) ? await decryptPasteSh(url) : await fetchPlaylist(raw);
      if (isPasteShEncryptedUrl(url) || !/^https?:\/\//i.test(text)) {
        await controller.addM3uFromContent(playlistName || 'Pasted playlist', text);
      } else {
        await controller.addM3uFromUrl(playlistName || 'Pasted playlist', text);
      }
      refreshPlaylists();
      setNotice('Pasted playlist imported.');
      setPlaylistUrl('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [controller, playlistName, playlistUrl, refreshPlaylists]);

  const openExternally = useCallback((channel: M3uChannel) => {
    LiveTvPrefs.setMode(channel.url, 'external');
    window.open(channel.url, '_blank', 'noopener,noreferrer');
    setSheet(null);
  }, []);

  const copyUrl = useCallback(async (channel: M3uChannel) => {
    try { await navigator.clipboard?.writeText(channel.url); setNotice('Stream URL copied.'); }
    catch { setNotice(channel.url); }
    setSheet(null);
  }, []);

  const nextSource = useCallback((channel: M3uChannel) => {
    const alternates = LiveTvPrefs.findAlternates(channels, channel);
    if (!alternates.length) { setNotice('No alternate source found.'); setSheet(null); return; }
    setSheet({ channel: alternates[0], mode: 'alternates', alternates });
  }, [channels]);

  return (
    <div className="ltv-root">
      <header className="ltv-header">
        <div>
          <h1>Live TV</h1>
          <p className="ltv-subtitle">{visibleChannels.length.toLocaleString()} channels · {playlists.length} playlists · {controller.verified.length} portals</p>
        </div>
        <span className="ltv-badge">LIVE</span>
      </header>

      <nav className="ltv-tabs" aria-label="Live TV sections">
        {TABS.map((item) => (
          <button key={item.id} className={`ltv-tab${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {notice && <div className="ltv-notice" role="status">{notice}</div>}

      {tab === 'channels' && (
        <section className="ltv-panel">
          <div className="ltv-toolbar">
            <input
              className="ltv-search"
              value={search}
              placeholder="Search channels or groups"
              onChange={(event) => { setSearch(event.target.value); setScrollTop(0); }}
            />
            <button className={`ltv-chip${favoritesOnly ? ' active' : ''}`} onClick={() => setFavoritesOnly((value) => !value)}>
              Favourites
            </button>
          </div>
          <div className="ltv-chips">
            <button className={`ltv-chip${!group ? ' active' : ''}`} onClick={() => { setGroup(''); setScrollTop(0); }}>All</button>
            {groupChips.map((node) => (
              <button key={node.id} className={`ltv-chip${group === node.name ? ' active' : ''}`} onClick={() => { setGroup(node.name); setScrollTop(0); }}>
                {node.name}
              </button>
            ))}
          </div>

          <div className="ltv-virtual" ref={scrollRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
            {visibleChannels.length === 0 ? (
              <div className="ltv-empty">No channels match this filter. Add a playlist, or import a portal below.</div>
            ) : (
              <div className="ltv-spacer" style={{ height: visibleChannels.length * ROW_HEIGHT }}>
                {windowed.map((channel, index) => {
                  const guide = fallbackGuide(channel);
                  const { now, next } = nowNext(guide, Date.now());
                  const progress = epgProgress(now, Date.now());
                  const format = detectIptvFormat(channel.url);
                  const key = m3uFavoriteKey(channel.url);
                  const health = LiveTvPrefs.getHealth(channel.url);
                  return (
                    <article
                      className="ltv-channel"
                      key={`${channel.url}-${start + index}`}
                      style={{ top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
                    >
                      <button className="ltv-card-main" onClick={() => play(channel)}>
                        <span className="ltv-logo">{channel.logo ? <img src={channel.logo} alt="" loading="lazy" /> : channel.name.slice(0, 2).toUpperCase()}</span>
                        <span className="ltv-meta">
                          <strong>{channel.name}</strong>
                          <small>
                            {now ? `${guideTime(now.start)} · ${now.title}` : 'Live now'}
                            {next ? ` · next ${guideTime(next.start)}` : ''}
                          </small>
                          <span className="ltv-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
                        </span>
                      </button>
                      <span className="ltv-format">{formatIptvBadge(format)}</span>
                      {health && <span className={`ltv-health ${health.ok ? 'ok' : 'bad'}`}>{health.ok ? '●' : '○'}</span>}
                      <div className="ltv-actions">
                        <button onClick={() => play(channel)} aria-label={`Play ${channel.name}`}>▶</button>
                        <button className={favoriteKeys.includes(key) ? 'fav' : ''} onClick={() => toggleFavorite(channel)} aria-label="Toggle favourite">★</button>
                        <button onClick={() => void checkHealth(channel)} aria-label="Check stream health">⌁</button>
                        <button onClick={() => setSheet({ channel, mode: 'main' })} aria-label="More actions">⋯</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
          <p className="ltv-hint">Windowed list: {windowed.length} of {visibleChannels.length.toLocaleString()} rows mounted.</p>
        </section>
      )}

      {tab === 'discover' && (
        <section className="ltv-panel">
          <h2>Built-in channel catalogue</h2>
          {catalog.map(([category, list]) => (
            <div className="ltv-group" key={category}>
              <h3>{category}</h3>
              <div className="ltv-card-grid">
                {list.slice(0, 8).map((channel) => (
                  <button key={channel.id} className="ltv-catalog-card" onClick={() => selectHardcoded(channel)}>
                    <span className="ltv-catalog-art" style={{ background: `linear-gradient(135deg, ${channel.gradient[0]}, ${channel.gradient[1]})` }}>
                      {channel.shortName}
                    </span>
                    <span>{channel.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {selectedHardcoded && (
            <div className="ltv-results">
              <h3>{selectedHardcoded.name} streams</h3>
              <p>{controller.channelStatus || 'Searching live portals…'}</p>
              {controller.channelResults.map((hit) => (
                <div className="ltv-result" key={hit.streamUrl}>
                  <span>{hit.stream.name}</span>
                  <button onClick={() => playHit(hit)}>Play</button>
                </div>
              ))}
              <button className="ltv-secondary" onClick={() => void controller.getMoreChannels()}>Scan more</button>
            </div>
          )}
        </section>
      )}

      {tab === 'matches' && (
        <section className="ltv-panel">
          <h2>Live matches</h2>
          {matches.length === 0 ? <p className="ltv-empty">No fixtures available right now.</p> : (
            <div className="ltv-match-list">
              {matches.map((match) => (
                <div className="ltv-match" key={match.id}>
                  <span className="ltv-match-league">{match.league}</span>
                  <strong>{match.title}</strong>
                  <span>{match.isLive ? 'LIVE' : match.timeLabel}</span>
                  {match.streamUrl && <button onClick={() => play({ name: match.title, url: match.streamUrl, group: match.league })}>Watch</button>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'portals' && (
        <section className="ltv-panel">
          <h2>Xtream portals</h2>
          <div className="ltv-form">
            <input value={portalUrl} placeholder="http://panel.example.com:8080" onChange={(event) => setPortalUrl(event.target.value)} />
            <input value={portalUser} placeholder="Username" onChange={(event) => setPortalUser(event.target.value)} />
            <input value={portalPass} placeholder="Password" type="password" onChange={(event) => setPortalPass(event.target.value)} />
            <button onClick={() => void addPortal()}>{controller.isAdding ? 'Checking…' : 'Add portal'}</button>
          </div>
          <div className="ltv-form">
            <textarea value={portalJson} placeholder='[{"url":"http://host","username":"u","password":"p"}]' onChange={(event) => setPortalJson(event.target.value)} />
            <button onClick={() => void importPortalJson()}>Import JSON</button>
            <button onClick={() => void controller.scrape()}>Find portals</button>
            <button disabled={!controller.canGetMore} onClick={() => void controller.getMore()}>More</button>
          </div>
          <div className="ltv-portal-list">
            {controller.verified.map((portal) => (
              <div className="ltv-result" key={`${portal.portal.url}|${portal.portal.username}`}>
                <span>{portal.name} · {portal.portal.url}</span>
                <small>{portal.expiry}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'playlists' && (
        <section className="ltv-panel">
          <h2>M3U playlists</h2>
          <div className="ltv-form">
            <input value={playlistName} placeholder="Playlist name" onChange={(event) => setPlaylistName(event.target.value)} />
            <input value={playlistUrl} placeholder="Playlist URL or paste link" onChange={(event) => setPlaylistUrl(event.target.value)} />
            <textarea value={playlistText} placeholder="#EXTM3U… paste raw playlist text" onChange={(event) => setPlaylistText(event.target.value)} />
            <button onClick={() => void addPlaylist('url')}>Add URL</button>
            <button onClick={() => void addPlaylist('text')}>Add pasted text</button>
            <button onClick={() => void importPastedPlaylist()}>Import paste link</button>
          </div>
          <div className="ltv-portal-list">
            {playlists.map((playlist) => (
              <div className="ltv-result" key={playlist.id}>
                <span>{playlist.name} · {playlist.channels.length.toLocaleString()} channels</span>
                <button onClick={() => { controller.deleteM3uPlaylist(playlist.id); refreshPlaylists(); }}>Delete</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {sheet && (
        <div className="ltv-sheet" role="dialog" aria-label="Channel actions">
          <h3>{sheet.channel.name}</h3>
          <button onClick={() => { play(sheet.channel); setSheet(null); }}>Play now</button>
          <button onClick={() => openExternally(sheet.channel)}>Open externally</button>
          <button onClick={() => void copyUrl(sheet.channel)}>Copy URL</button>
          <button onClick={() => nextSource(sheet.channel)}>Next source</button>
          {sheet.mode === 'alternates' && sheet.alternates?.map((alternate) => (
            <button key={alternate.url} onClick={() => { play(alternate); setSheet(null); }}>{alternate.name}</button>
          ))}
          <button onClick={() => setSheet(null)}>Close</button>
        </div>
      )}
    </div>
  );
}
