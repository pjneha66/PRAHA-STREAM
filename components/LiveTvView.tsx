// Live TV hub — the VyseTV Live TV tab, in TypeScript.
//
// Ported line for line from VyseTV `lib/screens/live_tv/live_tv_page.dart`
// (GPL-3.0-or-later). The five sections are VyseTV's, in VyseTV's order —
// Favorites · Matches · Channels · Portals · Playlists — and it opens on
// Favorites when something is starred, else on Matches.
//
// The public contract is unchanged: default-export a view that reports a
// playable stream through `onPlayStream`. PRAHA keeps one addition VyseTV's
// Flutter lists get for free: the playlist channel list is windowed, so a
// 5,000-channel playlist never mounts more than a few dozen rows.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './live-tv.css';
import {
  ClipboardPaste,
  Copy,
  FileUp,
  Link,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  Tv,
  CirclePlay,
  ListVideo,
  Server,
  Sparkles,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import { currentNsfwMode, filterChannelsForNsfw } from '../services/nsfwGate';
import {
  buildGroupTree,
  buildIptvPlayback,
  CatalogSource,
  detectIptvFormat,
  flattenGroups,
  formatIptvBadge,
  guideTime,
  HardcodedChannels,
  IptvController,
  IptvStore,
  IptvZapStore,
  LiveFavorites,
  LiveTvPrefs,
  nowNext,
  epgProgress,
  PortalNames,
  portalKey,
  portalKeyOf,
  portalLabel,
  probeUrl,
  type FavoriteChannel,
  type HardcodedChannel,
  type IptvSection,
  type IptvStream,
  type LiveItem,
  type M3uChannel,
  type M3uPlaylist,
  type ScheduleMatch,
  type VerifiedPortal,
} from '../services/iptvService';
import {
  counted,
  EmptyState,
  FieldsDialog,
  FilterChipPill,
  InfoTile,
  SectionHeader,
  ShelfHeader,
  StatusLine,
  StreamCard,
  ToolButton,
  useIptvController,
  useLiveFavorites,
  useToast,
} from './liveTv/widgets';
import { LiveChannelPage, M3uPlaylistPage, PortalBrowserPage, SeriesPage } from './liveTv/pages';
import { MatchesView } from './liveTv/matches';

export interface LiveTvViewProps {
  onPlayStream: (media: MediaItem, stream: StreamResult) => void;
}

type Tab = 'favorites' | 'matches' | 'channels' | 'portals' | 'playlists';

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 520;
const OVERSCAN = 5;

/** Where a tap inside a section leads. */
type Page =
  | { kind: 'channel'; channelId: string; match?: ScheduleMatch }
  | { kind: 'playlist'; id: string }
  | { kind: 'browser'; portal: VerifiedPortal; section: IptvSection }
  | { kind: 'series'; portal: VerifiedPortal; series: IptvStream };

interface SheetTarget {
  channel: M3uChannel;
  mode: 'main' | 'alternates';
  alternates?: M3uChannel[];
}

/** VyseTV's rows always have a "now / next" line, even with no guide yet. */
function fallbackGuide(channel: M3uChannel) {
  const now = Date.now();
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  return [
    { title: `${channel.name} — Live`, start: hour, stop: hour + 3_600_000 },
    { title: 'Up next on this channel', start: hour + 3_600_000, stop: hour + 7_200_000 },
  ];
}

type PortalDialog = 'add' | 'import' | { kind: 'rename'; portal: VerifiedPortal } | null;
type PlaylistDialog = 'url' | 'paste' | null;

export default function LiveTvView({ onPlayStream }: LiveTvViewProps) {
  const controller = useIptvController();
  const favorites = useLiveFavorites();
  const toast = useToast();

  // VyseTV opens on Favorites when something is starred and on Matches
  // otherwise — `_tab = _lastTab ?? (LiveFavorites.saved.isNotEmpty ? 4 : 3)`.
  // Kept identical here: the fixture board is the landing screen, and the
  // Channels tab is one tap away.
  const [tab, setTab] = useState<Tab>(() => (LiveFavorites.saved.length ? 'favorites' : 'matches'));
  const [page, setPage] = useState<Page | null>(null);
  const [playlists, setPlaylists] = useState<M3uPlaylist[]>(() => IptvStore.loadPlaylists());
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [portalDialog, setPortalDialog] = useState<PortalDialog>(null);
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialog>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refreshPlaylists = useCallback(() => setPlaylists(IptvStore.loadPlaylists()), []);

  const channels: M3uChannel[] = useMemo(
    () => playlists.flatMap((playlist) => playlist.channels),
    [playlists],
  );

  useEffect(() => {
    if (channels.length) IptvZapStore.set(channels, channels[0].url);
  }, [channels]);

  /* ── playback ─────────────────────────────────────────────────────────── */

  const playChannel = useCallback(
    (channel: M3uChannel) => {
      IptvZapStore.set(channels, channel.url);
      LiveTvPrefs.markPlayed(channel);
      const { media, stream } = buildIptvPlayback(channel);
      onPlayStream(media, stream);
    },
    [channels, onPlayStream],
  );

  /** Everything the sub-pages hand back is played through the same builder. */
  const playItem = useCallback(
    (item: LiveItem) => {
      IptvZapStore.setCurrent(item.url);
      const { media, stream } = buildIptvPlayback({
        name: item.title,
        url: item.url,
        group: item.subtitle,
        logo: item.logo,
      });
      onPlayStream(media, stream);
    },
    [onPlayStream],
  );

  const playFavorite = useCallback(
    (favorite: FavoriteChannel) => {
      IptvZapStore.setCurrent(favorite.url);
      const { media, stream } = buildIptvPlayback({
        name: favorite.title,
        url: favorite.url,
        group: favorite.from,
        logo: favorite.logo,
      });
      onPlayStream(media, stream);
    },
    [onPlayStream],
  );

  /* ── channels ─────────────────────────────────────────────────────────── */

  const visibleChannels = useMemo(() => {
    const mode = currentNsfwMode();
    const query = search.trim().toLowerCase();
    const list = filterChannelsForNsfw(channels, { nsfw: mode });
    return list.filter((channel) => {
      if (group && !(channel.group || '').toLowerCase().includes(group.toLowerCase())) return false;
      if (!query) return true;
      return `${channel.name} ${channel.group || ''}`.toLowerCase().includes(query);
    });
  }, [channels, search, group]);

  const groupChips = useMemo(() => {
    const tree = buildGroupTree(channels, (channel) => channel.group);
    return flattenGroups(tree).filter((node) => node.name !== 'All').slice(0, 12);
  }, [channels]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visibleChannels.length, start + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2);
  const windowed = visibleChannels.slice(start, end);

  /** VyseTV's Channels tab: the curated catalogue, grouped by category. */
  const catalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    const byCategory = new Map<string, HardcodedChannel[]>();
    for (const channel of HardcodedChannels.all) {
      if (query && !`${channel.name} ${channel.shortName} ${channel.category} ${channel.keywords.join(' ')}`.toLowerCase().includes(query)) {
        continue;
      }
      const list = byCategory.get(channel.category) || [];
      list.push(channel);
      byCategory.set(channel.category, list);
    }
    return [...byCategory.entries()];
  }, [search]);

  // One store for favourites, the one the Favorites tab reads: `LiveFavorites`
  // already keeps the key, the title, the picture and the address, so there is
  // nothing to mirror into the older key-only list.
  const toggleFavorite = useCallback((channel: M3uChannel) => {
    LiveFavorites.toggleChannel({
      key: LiveFavorites.keyOfM3u(channel.url),
      title: channel.name,
      url: channel.url,
      logo: channel.logo,
      from: channel.group,
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
    toast.show(`${channel.name}: ${result.ok ? 'alive' : 'offline'} (${result.latencyMs} ms)`);
  }, [toast]);

  /* ── the action sheet ─────────────────────────────────────────────────── */

  const openExternally = useCallback((channel: M3uChannel) => {
    LiveTvPrefs.setMode(channel.url, 'external');
    window.open(channel.url, '_blank', 'noopener,noreferrer');
    setSheet(null);
  }, []);

  const copyUrl = useCallback(async (channel: M3uChannel) => {
    try {
      await navigator.clipboard?.writeText(channel.url);
      toast.show('Stream URL copied');
    } catch {
      toast.show(channel.url);
    }
    setSheet(null);
  }, [toast]);

  const nextSource = useCallback((channel: M3uChannel) => {
    const alternates = LiveTvPrefs.findAlternates(channels, channel);
    if (!alternates.length) {
      toast.show('No alternate source found');
      setSheet(null);
      return;
    }
    setSheet({ channel: alternates[0], mode: 'alternates', alternates });
  }, [channels, toast]);

  /* ── portals ──────────────────────────────────────────────────────────── */

  const addPortal = useCallback(
    async (values: Record<string, string>) => {
      const ok = await controller.addManual(values.url || '', values.username || '', values.password || '');
      if (ok) {
        setPortalDialog(null);
        toast.show('Portal added');
      }
    },
    [controller, toast],
  );

  const importPortals = useCallback(
    async (values: Record<string, string>) => {
      const result = await controller.importFromJsonString(values.json || '');
      setPortalDialog(null);
      toast.show(
        result.error || `Added ${result.added}, skipped ${result.skipped}, failed ${result.failed}`,
      );
    },
    [controller, toast],
  );

  const renamePortal = useCallback(
    (portal: VerifiedPortal, name: string) => {
      PortalNames.set(portalKeyOf(portal), name);
      setPortalDialog(null);
    },
    [],
  );

  const copyLogin = useCallback(
    async (portal: VerifiedPortal) => {
      const login = `${portal.portal.url}:${portal.portal.username}:${portal.portal.password}`;
      try {
        await navigator.clipboard?.writeText(login);
        toast.show('Portal login copied');
      } catch {
        toast.show(login);
      }
    },
    [toast],
  );

  /* ── playlists ────────────────────────────────────────────────────────── */

  const addPlaylist = useCallback(
    async (values: Record<string, string>, source: 'url' | 'paste') => {
      try {
        if (source === 'url') await controller.addM3uFromUrl(values.name || '', values.url || '');
        else await controller.addM3uFromContent(values.name || '', values.content || '');
        refreshPlaylists();
        setPlaylistDialog(null);
        toast.show('Playlist added');
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error));
      }
    },
    [controller, refreshPlaylists, toast],
  );

  /* ── the tab bar ──────────────────────────────────────────────────────── */

  const TABS = useMemo(
    () => [
      { id: 'favorites' as const, label: `Favorites${favorites.length ? ` · ${favorites.length}` : ''}` },
      { id: 'matches' as const, label: 'Matches' },
      { id: 'channels' as const, label: 'Channels' },
      { id: 'portals' as const, label: `Portals${controller.verified.length ? ` ${controller.verified.length}` : ''}` },
      { id: 'playlists' as const, label: `Playlists${playlists.length ? ` ${playlists.length}` : ''}` },
    ],
    [favorites.length, controller.verified.length, playlists.length],
  );

  const openPage = useCallback((next: Page) => {
    setPage(next);
    window.scrollTo?.({ top: 0 });
  }, []);

  /* ── sub-pages ────────────────────────────────────────────────────────── */

  // A page can outlive the thing it points at — a playlist deleted in another
  // tab, a channel removed from the catalogue. Clear it after the render
  // rather than during it, and fall through to the tab view meanwhile.
  const channelPage = page?.kind === 'channel' ? HardcodedChannels.byId(page.channelId) : undefined;
  const playlistPage = page?.kind === 'playlist' ? playlists.find((entry) => entry.id === page.id) : undefined;
  const stale = Boolean(page) && ((page!.kind === 'channel' && !channelPage) || (page!.kind === 'playlist' && !playlistPage));

  useEffect(() => {
    if (stale) setPage(null);
  }, [stale]);

  if (page && !stale) {
    if (page.kind === 'channel' && channelPage) {
      return (
        <div className="ltv-root">
          <LiveChannelPage
            channel={channelPage}
            match={page.match}
            onPlay={playItem}
            onBack={() => setPage(null)}
          />
        </div>
      );
    }
    if (page.kind === 'playlist' && playlistPage) {
      return (
        <div className="ltv-root">
          <M3uPlaylistPage playlist={playlistPage} onPlay={playChannel} onBack={() => setPage(null)} />
        </div>
      );
    }
    if (page.kind === 'browser') {
      return (
        <div className="ltv-root">
          <PortalBrowserPage
            portal={page.portal}
            section={page.section}
            onSection={(section) => setPage({ kind: 'browser', portal: page.portal, section })}
            onPlay={playItem}
            onOpenSeries={(series) => setPage({ kind: 'series', portal: page.portal, series })}
            onBack={() => setPage(null)}
          />
        </div>
      );
    }
    if (page.kind === 'series') {
      return (
        <div className="ltv-root">
          <SeriesPage
            portal={page.portal}
            series={page.series}
            onPlay={playItem}
            onBack={() => setPage({ kind: 'browser', portal: page.portal, section: 'series' })}
          />
        </div>
      );
    }
  }

  return (
    <div className="ltv-root">
      <header className="ltv-header">
        <div>
          <h1>Live TV</h1>
          <p className="ltv-subtitle">
            {counted(visibleChannels.length, 'channel')} · {counted(playlists.length, 'playlist')} ·{' '}
            {counted(controller.verified.length, 'portal')}
          </p>
        </div>
        <span className="ltv-badge">LIVE</span>
      </header>

      <nav className="ltv-tabs" aria-label="Live TV sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`ltv-tab${tab === item.id ? ' active' : ''}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {toast.message ? <div className="ltv-notice" role="status">{toast.message}</div> : null}

      {/* ── Favorites ───────────────────────────────────────────────────── */}
      {tab === 'favorites' ? (
        <section>
          <SectionHeader
            title="Favorites"
            subtitle="Channels you starred, ready to play without opening their portal."
          />
          {favorites.length === 0 ? (
            <EmptyState
              icon={Star}
              title="No favorites yet"
              body="Star a channel in a portal, or on one of your playlists, and it lands here."
            />
          ) : (
            <div>
              {favorites.map((favorite) => (
                <div className="ltv-row" key={favorite.key}>
                  <span className="ltv-row-logo">
                    {favorite.logo ? <img src={favorite.logo} alt="" loading="lazy" /> : <Tv size={18} />}
                  </span>
                  <button
                    type="button"
                    className="ltv-row-body"
                    style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => playFavorite(favorite)}
                  >
                    <span className="ltv-row-title">{favorite.title}</span>
                    {favorite.from ? <span className="ltv-row-sub">{favorite.from}</span> : null}
                  </button>
                  <div className="ltv-row-actions">
                    <button
                      type="button"
                      className="on"
                      aria-label="Remove from favourites"
                      onClick={() => LiveFavorites.toggleChannel(favorite)}
                    >
                      <Star size={18} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="ltv-row-play"
                    aria-label={`Play ${favorite.title}`}
                    onClick={() => playFavorite(favorite)}
                  >
                    <CirclePlay size={20} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* ── Matches ─────────────────────────────────────────────────────── */}
      {tab === 'matches' ? (
        <MatchesView
          onOpenChannel={(channelId, match) => openPage({ kind: 'channel', channelId, match })}
        />
      ) : null}

      {/* ── Channels ────────────────────────────────────────────────────── */}
      {tab === 'channels' ? (
        <section>
          <SectionHeader
            title="Channels"
            subtitle="Search the built-in catalogue, then search your portals for a working feed."
          />

          <div className="ltv-toolbar-row">
            <input
              className="ltv-search"
              value={search}
              placeholder="Search channels"
              aria-label="Search channels"
              onChange={(event) => {
                setSearch(event.target.value);
                setScrollTop(0);
              }}
            />
          </div>

          {channels.length === 0 && controller.verified.length === 0 ? (
            <StatusLine text="Channels are found by searching your IPTV portals. Add or find portals in the Portals tab first." />
          ) : null}

          {catalog.length === 0 && search.trim() ? (
            <EmptyState
              icon={Search}
              title={`No channels match "${search.trim()}"`}
              body='Try a shorter name, like "sky" or "espn".'
            />
          ) : null}

          {catalog.map(([category, list]) => (
            <React.Fragment key={category}>
              <ShelfHeader>{category}</ShelfHeader>
              <div className="ltv-tile-grid">
                {list.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    className="ltv-tile"
                    onClick={() => openPage({ kind: 'channel', channelId: channel.id })}
                  >
                    <span
                      className="ltv-tile-art"
                      style={{
                        ['--ltv-tile-a' as string]: channel.gradient[0],
                        ['--ltv-tile-b' as string]: channel.gradient[1],
                      } as React.CSSProperties}
                    >
                      {channel.logo || channel.iconUrl ? (
                        <img src={channel.logo || channel.iconUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="ltv-tile-name">{channel.shortName || channel.name}</span>
                      )}
                    </span>
                    <span className="ltv-tile-caption">
                      <strong>{channel.name}</strong>
                      <small>{channel.category}</small>
                    </span>
                  </button>
                ))}
              </div>
            </React.Fragment>
          ))}

          {channels.length ? (
            <>
              <ShelfHeader>Playlist channels</ShelfHeader>
              {groupChips.length ? (
                <div className="ltv-chips">
                  <FilterChipPill label="All" selected={!group} onClick={() => { setGroup(''); setScrollTop(0); }} />
                  {groupChips.map((node) => (
                    <FilterChipPill
                      key={node.id}
                      label={node.name}
                      selected={group === node.name}
                      onClick={() => { setGroup(node.name); setScrollTop(0); }}
                    />
                  ))}
                </div>
              ) : null}

              <div
                className="ltv-virtual"
                ref={scrollRef}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              >
                {visibleChannels.length === 0 ? (
                  <div className="ltv-empty">No channels match this filter.</div>
                ) : (
                  <div className="ltv-spacer" style={{ height: visibleChannels.length * ROW_HEIGHT }}>
                    {windowed.map((channel, index) => {
                      const guide = fallbackGuide(channel);
                      const { now, next } = nowNext(guide, Date.now());
                      const progress = epgProgress(now, Date.now());
                      const format = detectIptvFormat(channel.url);
                      const health = LiveTvPrefs.getHealth(channel.url);
                      const starred = favorites.some((entry) => entry.key === LiveFavorites.keyOfM3u(channel.url));
                      return (
                        <article
                          className="ltv-channel"
                          key={`${channel.url}-${start + index}`}
                          style={{ top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
                        >
                          <button className="ltv-card-main" onClick={() => playChannel(channel)}>
                            <span className="ltv-logo">
                              {channel.logo ? (
                                <img src={channel.logo} alt="" loading="lazy" />
                              ) : (
                                channel.name.slice(0, 2).toUpperCase()
                              )}
                            </span>
                            <span className="ltv-meta">
                              <strong>{channel.name}</strong>
                              <small>
                                {now ? `${guideTime(now.start)} · ${now.title}` : 'Live now'}
                                {next ? ` · next ${guideTime(next.start)}` : ''}
                              </small>
                              <span className="ltv-progress">
                                <i style={{ width: `${Math.round(progress * 100)}%` }} />
                              </span>
                            </span>
                          </button>
                          <span className="ltv-format">{formatIptvBadge(format)}</span>
                          {health ? (
                            <span className={`ltv-health ${health.ok ? 'ok' : 'bad'}`}>
                              {health.ok ? '●' : '○'}
                            </span>
                          ) : null}
                          <div className="ltv-actions">
                            <button onClick={() => playChannel(channel)} aria-label={`Play ${channel.name}`}>
                              ▶
                            </button>
                            <button
                              className={starred ? 'fav' : ''}
                              onClick={() => toggleFavorite(channel)}
                              aria-label="Toggle favourite"
                            >
                              ★
                            </button>
                            <button onClick={() => void checkHealth(channel)} aria-label="Check stream health">
                              ⌁
                            </button>
                            <button onClick={() => setSheet({ channel, mode: 'main' })} aria-label="More actions">
                              ⋯
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
              <p className="ltv-hint">
                Windowed list: {windowed.length} of {counted(visibleChannels.length, 'row')} mounted.
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── Portals ─────────────────────────────────────────────────────── */}
      {tab === 'portals' ? (
        <section>
          <SectionHeader
            title="Portals"
            subtitle="An Xtream account is a URL, a user name and a password. VyseTV can also find some."
          />

          <div className="ltv-toolbar-row">
            <ToolButton icon={Plus} label="Add portal" onClick={() => setPortalDialog('add')} />
            <ToolButton
              icon={Sparkles}
              label={`Source: ${controller.scrapeSource.label}`}
              onClick={() =>
                controller.setScrapeSource(
                  controller.scrapeSource.id === CatalogSource.cloudVault.id
                    ? CatalogSource.reddit
                    : CatalogSource.cloudVault,
                )
              }
            />
            <ToolButton
              icon={Search}
              label="Find portals"
              disabled={controller.isScraping}
              onClick={() => void controller.scrape()}
            />
            <ToolButton
              icon={Server}
              label="Re-verify"
              disabled={!controller.verified.length}
              onClick={() => void controller.runVerification()}
            />
            <ToolButton icon={FileUp} label="Import JSON" onClick={() => setPortalDialog('import')} />
            <ToolButton
              icon={Pencil}
              label={controller.editMode ? 'Done' : 'Edit'}
              disabled={!controller.verified.length}
              onClick={() => controller.toggleEditMode()}
            />
          </div>

          {controller.editMode ? (
            <div className="ltv-toolbar-row">
              <ToolButton icon={Tv} label="Select all" onClick={() => controller.selectAllPortals()} />
              <ToolButton icon={Tv} label="Select none" onClick={() => controller.deselectAllPortals()} />
              <ToolButton
                icon={Trash2}
                label={`Delete ${controller.selected.size}`}
                danger
                disabled={!controller.selected.size}
                onClick={() => controller.deletePortalsByKeys(controller.selected)}
              />
            </div>
          ) : null}

          {controller.isScraping ? (
            <StatusLine text={controller.statusText || 'Working…'} busy />
          ) : controller.statusText ? (
            <StatusLine text={controller.statusText} />
          ) : null}

          {controller.verified.length === 0 ? (
            <EmptyState
              icon={Server}
              title="No portals yet"
              body="Add one with its URL and login, import a JSON list, or let VyseTV find some."
            />
          ) : (
            <div className="ltv-info-grid">
              {controller.verified.map((portal) => {
                const key = portalKey(portal.portal);
                const selected = controller.selected.has(key);
                return (
                  <InfoTile
                    key={key}
                    title={portalLabel(portal)}
                    selected={controller.editMode && selected}
                    lines={[
                      portal.portal.url,
                      [portal.expiry ? `Expires ${portal.expiry}` : '', `${portal.activeConnections}/${portal.maxConnections} connections`]
                        .filter(Boolean)
                        .join('  ·  '),
                    ]}
                    onClick={() =>
                      controller.editMode
                        ? controller.toggleSelect(key)
                        : openPage({ kind: 'browser', portal, section: 'live' })
                    }
                    trailing={
                      controller.editMode ? null : (
                        <>
                          <button
                            type="button"
                            aria-label={`Rename ${portalLabel(portal)}`}
                            onClick={() => setPortalDialog({ kind: 'rename', portal })}
                          >
                            <Pencil size={18} />
                          </button>
                          <button
                            type="button"
                            aria-label="Copy login"
                            onClick={() => void copyLogin(portal)}
                          >
                            <Copy size={18} />
                          </button>
                          <button
                            type="button"
                            className={controller.isFavoritePortal(key) ? 'on' : ''}
                            aria-label="Favourite portal"
                            onClick={() => void controller.toggleFavoritePortal(key)}
                          >
                            <Star size={18} />
                          </button>
                        </>
                      )
                    }
                  />
                );
              })}
            </div>
          )}

          {controller.canGetMore ? (
            <div className="ltv-toolbar-row" style={{ marginTop: 12 }}>
              <ToolButton
                icon={Search}
                label="Find more"
                disabled={controller.isScraping}
                onClick={() => void controller.getMore()}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── Playlists ───────────────────────────────────────────────────── */}
      {tab === 'playlists' ? (
        <section>
          <SectionHeader
            title="Playlists"
            subtitle="An M3U or M3U8 list of channels, by address or pasted in."
          />

          <div className="ltv-toolbar-row">
            <ToolButton icon={Link} label="Add from URL" onClick={() => setPlaylistDialog('url')} />
            <ToolButton icon={ClipboardPaste} label="Paste M3U" onClick={() => setPlaylistDialog('paste')} />
            <ToolButton
              icon={Trash2}
              label="Delete all"
              danger
              disabled={!playlists.length}
              onClick={() => {
                controller.deleteAllM3uPlaylists();
                refreshPlaylists();
                toast.show('Playlists deleted');
              }}
            />
          </div>

          {playlists.length === 0 ? (
            <EmptyState
              icon={ListVideo}
              title="No playlists"
              body="Add an M3U / M3U8 playlist by URL, or paste its contents."
            />
          ) : (
            <div className="ltv-info-grid">
              {playlists.map((playlist) => (
                <InfoTile
                  key={playlist.id}
                  title={playlist.name}
                  lines={[playlist.sourceUrl || 'Pasted playlist', counted(playlist.channels.length, 'channel')]}
                  onClick={() => openPage({ kind: 'playlist', id: playlist.id })}
                  trailing={
                    <button
                      type="button"
                      aria-label={`Delete ${playlist.name}`}
                      onClick={() => {
                        controller.deleteM3uPlaylist(playlist.id);
                        refreshPlaylists();
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* ── the channel action sheet ────────────────────────────────────── */}
      {sheet ? (
        <div className="ltv-sheet" role="dialog" aria-label="Channel actions">
          <h3>{sheet.channel.name}</h3>
          <button onClick={() => { playChannel(sheet.channel); setSheet(null); }}>Play now</button>
          <button onClick={() => openExternally(sheet.channel)}>Open externally</button>
          <button onClick={() => void copyUrl(sheet.channel)}>Copy URL</button>
          <button onClick={() => nextSource(sheet.channel)}>Next source</button>
          {sheet.mode === 'alternates'
            ? sheet.alternates?.map((alternate) => (
                <button key={alternate.url} onClick={() => { playChannel(alternate); setSheet(null); }}>
                  {alternate.name}
                </button>
              ))
            : null}
          <button onClick={() => setSheet(null)}>Close</button>
        </div>
      ) : null}

      {/* ── dialogs ─────────────────────────────────────────────────────── */}
      {portalDialog === 'add' ? (
        <FieldsDialog
          title="Add a portal"
          description="VyseTV signs in once to check the account works before saving it."
          fields={[
            { key: 'url', label: 'Server URL', hint: 'http://panel.example.com:8080' },
            { key: 'username', label: 'Username' },
            { key: 'password', label: 'Password', obscure: true },
          ]}
          confirmLabel="Add"
          busy={controller.isAdding}
          error={controller.addError}
          onSubmit={(values) => void addPortal(values)}
          onClose={() => setPortalDialog(null)}
        />
      ) : null}

      {portalDialog === 'import' ? (
        <FieldsDialog
          title="Import portals"
          description="Paste a JSON list of portals."
          fields={[
            {
              key: 'json',
              label: 'JSON',
              hint: '[{"url":"http://host:8080","username":"u","password":"p"}]',
              multiline: true,
            },
          ]}
          confirmLabel="Import"
          busy={controller.isImporting}
          onSubmit={(values) => void importPortals(values)}
          onClose={() => setPortalDialog(null)}
        />
      ) : null}

      {portalDialog && typeof portalDialog === 'object' && portalDialog.kind === 'rename' ? (
        <FieldsDialog
          title="Name this portal"
          description="Shown instead of the account name its provider gave it."
          fields={[
            {
              key: 'name',
              label: 'Name',
              hint: portalLabel(portalDialog.portal),
            },
          ]}
          confirmLabel="Save"
          onSubmit={(values) => renamePortal(portalDialog.portal, values.name || '')}
          onClose={() => setPortalDialog(null)}
        />
      ) : null}

      {playlistDialog === 'url' ? (
        <FieldsDialog
          title="Add from URL"
          fields={[
            { key: 'name', label: 'Name', hint: 'My playlist' },
            { key: 'url', label: 'Playlist URL', hint: 'https://host.example/list.m3u8' },
          ]}
          confirmLabel="Add"
          onSubmit={(values) => void addPlaylist(values, 'url')}
          onClose={() => setPlaylistDialog(null)}
        />
      ) : null}

      {playlistDialog === 'paste' ? (
        <FieldsDialog
          title="Paste M3U"
          fields={[
            { key: 'name', label: 'Name', hint: 'Pasted playlist' },
            { key: 'content', label: 'Playlist', hint: '#EXTM3U…', multiline: true },
          ]}
          confirmLabel="Add"
          onSubmit={(values) => void addPlaylist(values, 'paste')}
          onClose={() => setPlaylistDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** Kept for the port's public surface: the same helper the sheet uses. */
export { StreamCard };
