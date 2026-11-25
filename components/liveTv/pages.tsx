// Live TV sub-pages.
//
// Line-for-line transcription of VyseTV's
// `lib/screens/live_tv/live_tv_pages.dart` and
// `lib/screens/live_tv/portal_browser_page.dart` (GPL-3.0-or-later):
// LiveChannelPage, M3uPlaylistPage, SeriesPage and PortalBrowserPage, with the
// same copy, the same filters and the same empty states.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownAZ, CirclePlay, Info, ListVideo, Search, Star, Tv, X } from 'lucide-react';
import {
  epgProgress,
  fetchSeriesEpisodes,
  guideTime,
  hitTagsOf,
  IptvAliveStore,
  IptvClient,
  liveGuide,
  liveItemFromEpisode,
  liveItemFromHit,
  liveItemFromStream,
  LiveFavorites,
  MatchFinder,
  nowNext,
  PortalNames,
  portalKey,
  portalLabel,
  toEpochMs,
  upcomingGuide,
  type ChannelHit,
  type EpgEntry,
  type HardcodedChannel,
  type IptvEpisode,
  type IptvSection,
  type IptvStream,
  type LiveItem,
  type M3uChannel,
  type M3uPlaylist,
  type ScheduleMatch,
  type VerifiedPortal,
} from '../../services/iptvService';
import type { PlayerSettings } from '../../types';

// The pane player pulls in the engine layer (hls.js, p2p-media-loader), which
// is only needed once a channel is picked — the same reason App.tsx lazy-loads
// `LiveTvPlayer`. A static import here would load it for anyone browsing Live TV.
const BrowserLivePlayer = React.lazy(() => import('../player/BrowserLivePlayer'));
import {
  counted,
  EmptyState,
  FilterChipPill,
  hhmm,
  InfoTile,
  LivePill,
  SectionHeader,
  ShelfHeader,
  StatusLine,
  StreamCard,
  SubPage,
  TagFilterRow,
  ToolButton,
  useIptvController,
  useLiveFavorites,
  type IconType,
} from './widgets';

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/* ── LiveChannelPage ─────────────────────────────────────────────────────── */

export interface LiveChannelPageProps {
  channel: HardcodedChannel;
  /** The fixture whose feed you are looking for, when you arrived from a match. */
  match?: ScheduleMatch | null;
  /**
   * Play one of the sources. `items` is every source under the current
   * filters, in the order they are shown, and `index` is the row that was
   * tapped — VyseTV's `openLivePlayer(context, items, i)`.
   */
  onPlay: (item: LiveItem, items: LiveItem[], index: number) => void;
  onBack: () => void;
}

/**
 * One curated channel and every working source found for it.
 *
 * CHANNEL / LANGUAGE / QUALITY narrow the list — the same feed on ten portals
 * is one row per language — and the match panel names the exact feed showing
 * tonight's fixture.
 */
export function LiveChannelPage({ channel, match, onPlay, onBack }: LiveChannelPageProps) {
  const controller = useIptvController();
  const [num, setNum] = useState<string | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const [quality, setQuality] = useState<string | null>(null);
  const finderRef = useRef<MatchFinder | null>(null);
  const [, bumpFinder] = useState(0);

  useEffect(() => {
    setNum(null);
    setLang(null);
    setQuality(null);
    void controller.openHardcodedChannel(channel);
    return () => controller.stopChannelSearch();
  }, [controller, channel]);

  const results = controller.channelResults;

  useEffect(() => {
    if (!match) {
      finderRef.current?.dispose();
      finderRef.current = null;
      return;
    }
    const finder = new MatchFinder(
      {
        id: match.id,
        start: match.start,
        name: match.name,
        league: match.league,
        home: match.home,
        away: match.away,
      },
      { id: channel.id, name: channel.name },
      (hit: ChannelHit) => controller.epgForHit(hit),
    );
    finderRef.current = finder;
    const unsubscribe = MatchFinder.subscribe(() => bumpFinder((value) => value + 1));
    return () => {
      unsubscribe();
      finder.dispose();
      if (finderRef.current === finder) finderRef.current = null;
    };
  }, [controller, channel.id, channel.name, match]);

  useEffect(() => {
    finderRef.current?.update(results);
  }, [results]);

  const tagged = useMemo(
    () => results.map((hit) => ({ hit, tags: hitTagsOf(hit.stream.name) })),
    [results],
  );

  const numbers = useMemo(() => unique(tagged.map((entry) => entry.tags.number)), [tagged]);
  const langs = useMemo(() => unique(tagged.map((entry) => entry.tags.lang)), [tagged]);
  const qualities = useMemo(() => unique(tagged.map((entry) => entry.tags.quality)), [tagged]);

  const visible = useMemo(() => {
    const finder = finderRef.current;
    const list = tagged
      .filter((entry) => (num === null || entry.tags.number === num))
      .filter((entry) => (lang === null || entry.tags.lang === lang))
      .filter((entry) => (quality === null || entry.tags.quality === quality))
      .map((entry) => entry.hit);
    if (!finder) return list;
    // Feeds the guide says are showing this match come first.
    return [...list].sort((a, b) => {
      const left = finder.entryFor(a) ? 0 : 1;
      const right = finder.entryFor(b) ? 0 : 1;
      return left - right;
    });
  }, [tagged, num, lang, quality, results]);

  const playing = match ? finderRef.current : null;
  const hitCount = results.length;
  const hasFilters = num !== null || lang !== null || quality !== null;

  // VyseTV: `final items = [for (final h in hits) LiveItem.hit(h, channelName: ch.name)]`.
  // Built from the filtered, guide-ordered list, so zapping walks what the page
  // is showing and each source carries its own guide loader and star.
  const items = useMemo(
    () => visible.map((hit) => liveItemFromHit(hit, channel.name)),
    [visible, channel.name],
  );

  const subtitle = `${channel.category}  ·  ${
    hitCount ? `${results.length.toLocaleString()} sources found` : 'Search your portals for this channel'
  }`;

  return (
    <SubPage title={channel.name} subtitle={subtitle} onBack={onBack}>
      <div className="ltv-toolbar-row">
        <ToolButton
          icon={CirclePlay}
          label="Watch"
          disabled={!visible.length}
          onClick={() => items[0] && onPlay(items[0], items, 0)}
        />
        <ToolButton
          icon={Search}
          label="Search portals"
          disabled={controller.channelIsRunning}
          onClick={() => void controller.runChannelScan(channel)}
        />
        <ToolButton
          icon={Search}
          label="Search deeper"
          disabled={controller.channelIsRunning}
          onClick={() => void controller.getMoreChannels()}
        />
        <ToolButton
          icon={X}
          label="Clear"
          danger
          disabled={!hitCount}
          onClick={() => {
            controller.removeAllChannelHits(channel.id);
            setNum(null);
            setLang(null);
            setQuality(null);
          }}
        />
      </div>

      {controller.channelStatus ? (
        <StatusLine text={controller.channelStatus} busy={controller.channelIsRunning} />
      ) : null}

      {match ? <MatchGuide match={match} channel={channel} finder={playing} onPick={(key) => {
        const [nextNum, nextLang] = key.split('|');
        setNum(nextNum || null);
        setLang(nextLang || null);
      }} /> : null}

      <TagFilterRow label="Channel" values={numbers} value={num} onPick={setNum} />
      <TagFilterRow label="Language" values={langs} value={lang} onPick={setLang} />
      <TagFilterRow label="Quality" values={qualities} value={quality} onPick={setQuality} />

      {visible.length === 0 ? (
        <EmptyState
          icon={Tv}
          title={hitCount === 0 ? 'No sources yet' : 'Nothing matches these filters'}
          body={
            controller.verified.length === 0
              ? 'Add a portal in the Portals tab, then search again.'
              : hasFilters
                ? `Clear a filter to see the other ${counted(hitCount, 'source')}.`
                : `Search your portals to find a stream for ${channel.name}.`
          }
        />
      ) : (
        <div>
          {visible.map((hit, index) => (
            <HitRow
              key={hit.streamUrl}
              channel={channel}
              hit={hit}
              guide={playing?.entryFor(hit) ?? null}
              favorite={controller.isFavoriteHit(channel.id, hit)}
              onToggleFavorite={() => void controller.toggleFavoriteHit(channel.id, hit)}
              onPlay={() => onPlay(items[index] ?? liveItemFromHit(hit, channel.name), items, index)}
            />
          ))}
        </div>
      )}
    </SubPage>
  );
}

/** `_MatchGuide` — what the TV guides say about tonight's fixture. */
function MatchGuide({
  match,
  channel,
  finder,
  onPick,
}: {
  match: ScheduleMatch;
  channel: HardcodedChannel;
  finder: MatchFinder | null;
  onPick: (key: string) => void;
}) {
  const found = finder?.hits ?? [];
  const busy = finder?.busy ?? false;
  const checked = finder?.checked ?? 0;
  const total = finder?.total ?? 0;

  let status: string;
  if (found.length) status = 'Showing this match';
  else if (busy) status = total ? `Reading TV guides  ${checked}/${total}` : 'Finding feeds…';
  else if (total === 0) status = 'Search your portals to find feeds for this match';
  else status = "Couldn't spot it in the TV guides. It's usually on one of the feeds below.";

  return (
    <div className="ltv-match-guide">
      <div className="ltv-match-guide-head">
        {match.leagueLogo ? (
          <img src={match.leagueLogo} alt="" width={18} height={18} style={{ objectFit: 'contain' }} />
        ) : (
          <Tv size={18} />
        )}
        <span>{match.name}</span>
        {match.state === 'live' ? <LivePill text={match.status} /> : <span className="ltv-match-kick">{hhmm(match.start)}</span>}
      </div>
      <div className="ltv-match-guide-status">
        {busy ? <span className="ltv-spin" /> : null}
        {status}
      </div>
      {found.length ? (
        <div className="ltv-match-guide-found">
          {found.map((entry) => {
            const start = toEpochMs(entry.entry.start);
            const stop = toEpochMs(entry.entry.stop);
            return (
              <FilterChipPill
                key={entry.key}
                label={entry.label}
                onClick={() => onPick(entry.key)}
                title={`${entry.entry.title}  ·  ${start === null ? '' : hhmm(start)}–${stop === null ? '' : hhmm(stop)}`}
              />
            );
          })}
        </div>
      ) : null}
      <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--ltv-faint)' }}>
        Reading {channel.name} feeds against the guide.
      </p>
    </div>
  );
}

/** `_HitRow` — one working source for a curated channel. */
function HitRow({
  hit,
  guide,
  favorite,
  onToggleFavorite,
  onPlay,
}: {
  channel: HardcodedChannel;
  hit: ChannelHit;
  guide: EpgEntry | null;
  favorite: boolean;
  onToggleFavorite: () => void;
  onPlay: () => void;
}) {
  const start = guide ? toEpochMs(guide.start) : null;
  return (
    <div className="ltv-row">
      <span className="ltv-row-logo">
        {hit.stream.icon ? <img src={hit.stream.icon} alt="" loading="lazy" /> : <Tv size={18} />}
      </span>
      <button type="button" className="ltv-row-body" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={onPlay}>
        <span className="ltv-row-title">{hit.stream.name}</span>
        <span className="ltv-row-sub">{portalLabel(hit.portal)}</span>
        {guide ? (
          <span className="ltv-row-showing">
            Showing  {guide.title}
            {start === null ? '' : `  ·  ${hhmm(start)}`}
          </span>
        ) : null}
      </button>
      <div className="ltv-row-actions">
        <button
          type="button"
          className={favorite ? 'on' : ''}
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={onToggleFavorite}
        >
          <Star size={18} />
        </button>
      </div>
      <button type="button" className="ltv-row-play" aria-label={`Play ${hit.stream.name}`} onClick={onPlay}>
        <CirclePlay size={20} />
      </button>
    </div>
  );
}

/* ── M3uPlaylistPage ─────────────────────────────────────────────────────── */

export interface M3uPlaylistPageProps {
  playlist: M3uPlaylist;
  /** `items` is the filtered channel list as shown, `index` the tapped card. */
  onPlay: (channel: M3uChannel, items: M3uChannel[], index: number) => void;
  onBack: () => void;
}

/** A playlist's channels: a filter, its groups as pills, then a poster grid. */
export function M3uPlaylistPage({ playlist, onPlay, onBack }: M3uPlaylistPageProps) {
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState<string | null>(null);

  const groups = useMemo(() => {
    const names = new Set<string>();
    for (const channel of playlist.channels) if (channel.group) names.add(channel.group);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [playlist.channels]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return playlist.channels.filter((channel) => {
      if (group && channel.group !== group) return false;
      if (!query) return true;
      return `${channel.name} ${channel.group || ''}`.toLowerCase().includes(query);
    });
  }, [playlist.channels, filter, group]);

  return (
    <SubPage
      title={playlist.name}
      subtitle={`${counted(playlist.channels.length, 'channel')}  ·  ${counted(groups.length, 'group')}`}
      onBack={onBack}
    >
      <div className="ltv-toolbar-row">
        <input
          className="ltv-search"
          value={filter}
          placeholder="Filter channels"
          aria-label="Filter channels"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {groups.length > 1 ? (
        <div className="ltv-chips">
          <FilterChipPill label="All" selected={group === null} onClick={() => setGroup(null)} />
          {groups.map((name) => (
            <FilterChipPill key={name} label={name} selected={group === name} onClick={() => setGroup(name)} />
          ))}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <EmptyState icon={Search} title="No matches" body="Try another group or filter." />
      ) : (
        <div className="ltv-stream-grid">
          {visible.map((channel, index) => (
            <StreamCard
              key={`${channel.url}-${channel.name}`}
              name={channel.name}
              logo={channel.logo}
              onClick={() => onPlay(channel, visible, index)}
            />
          ))}
        </div>
      )}
    </SubPage>
  );
}

/* ── SeriesPage ───────────────────────────────────────────────────────────── */

export interface SeriesPageProps {
  portal: VerifiedPortal;
  series: IptvStream;
  /** Episodes are VOD (`live: false`), so the film player opens, not the channel player. */
  onPlay: (item: LiveItem, items: LiveItem[], index: number) => void;
  onBack: () => void;
}

/** One series: its seasons as pills, then every episode with its picture. */
export function SeriesPage({ portal, series, onPlay, onBack }: SeriesPageProps) {
  const [episodes, setEpisodes] = useState<IptvEpisode[]>([]);
  const [season, setSeason] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchSeriesEpisodes(portal, series)
      .then((list) => {
        if (!active) return;
        setEpisodes(list);
        const seasons = [...new Set(list.map((episode) => episode.season))].sort((a, b) => a - b);
        setSeason(seasons.length === 1 ? seasons[0] : null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setEpisodes([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [portal, series, attempt]);

  // `Set` is given its element type explicitly: without `@types/react`,
  // `useState` is untyped JS, so `episodes` widens to `any` and an inferred
  // `Set` would become `Set<unknown>`, which cannot be sorted numerically.
  const seasons = useMemo(
    () => [...new Set<number>(episodes.map((episode: IptvEpisode) => episode.season))].sort((a, b) => a - b),
    [episodes],
  );

  const visible = useMemo(
    () => episodes.filter((episode) => season === null || episode.season === season),
    [episodes, season],
  );

  // Every episode of the chosen season, as the player's list: `PlayerModal`
  // gets the one that was tapped, and `items` would drive a Next button if the
  // film player used it.
  const items = useMemo(
    () => visible.map((episode) => liveItemFromEpisode(portal, series, episode)),
    [visible, portal, series],
  );

  return (
    <SubPage
      title={series.name}
      subtitle={`${counted(seasons.length, 'season')}  ·  ${counted(episodes.length, 'episode')}`}
      onBack={onBack}
    >
      {loading ? <StatusLine text="Loading episodes…" busy /> : null}

      {error ? (
        <EmptyState
          icon={ListVideo}
          title="Couldn't load episodes"
          body={
            <>
              {error}
              <br />
              <button type="button" className="ltv-secondary" style={{ marginTop: 10 }} onClick={() => setAttempt((value) => value + 1)}>
                Retry
              </button>
            </>
          }
        />
      ) : null}

      {!loading && !error && seasons.length > 1 ? (
        <div className="ltv-chips">
          {seasons.map((value) => (
            <FilterChipPill
              key={value}
              label={`Season ${value}`}
              selected={season === value}
              onClick={() => setSeason(value)}
            />
          ))}
        </div>
      ) : null}

      {!loading && !error
        ? visible.map((episode, index) => (
            <div className="ltv-row" key={episode.id}>
              <span className="ltv-episode-art">
                {episode.image ? <img src={episode.image} alt="" loading="lazy" /> : <ListVideo size={22} />}
              </span>
              <button
                type="button"
                className="ltv-row-body"
                style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => onPlay(items[index] ?? liveItemFromEpisode(portal, series, episode), items, index)}
              >
                <span className="ltv-row-title">
                  {`E${episode.episode}  ${episode.title}`.trim()}
                </span>
                {episode.plot ? (
                  <span className="ltv-row-sub" style={{ whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {episode.plot}
                  </span>
                ) : null}
              </button>
              <span className="ltv-row-play"><CirclePlay size={20} /></span>
            </div>
          ))
        : null}
    </SubPage>
  );
}

/* ── PortalBrowserPage ───────────────────────────────────────────────────── */

/** VyseTV's `_noun` / `_counted`: the word each section is counted in. */
const SECTION_NOUN: Record<IptvSection, [string, string]> = {
  live: ['channel', 'channels'],
  vod: ['movie', 'movies'],
  series: ['series', 'series'],
};

const SECTION_LABEL: Record<IptvSection, string> = {
  live: 'Live',
  vod: 'Movies',
  series: 'Series',
};

type SortMode = 'portal' | 'az' | 'za';

export interface PortalBrowserPageProps {
  portal: VerifiedPortal;
  section: IptvSection;
  onSection: (section: IptvSection) => void;
  /**
   * A live channel: `items` is the filtered list on screen and `index` the row
   * that was tapped. A film is VOD and only its own item is used.
   */
  onPlay: (item: LiveItem, items: LiveItem[], index: number) => void;
  onOpenSeries: (series: IptvStream) => void;
  onBack: () => void;
  /** The watch pane's player preferences — the same ones the full player gets. */
  playerSettings: PlayerSettings;
  onPlayerSettingsChange: (patch: Partial<PlayerSettings>) => void;
}

/**
 * VyseTV decides between the three-pane browser and the stepped layouts by
 * measuring, not by a media query: the picture needs a pane worth watching
 * (`_panes`: `cw - catW - listW - gap * 2 >= 340 && size.height >= 420`).
 * The widths below are VyseTV's clamps.
 */
const PANE_GAP = 14;
/** `_stepped`: `w < 640 || w - inset - right < 560`. */
const STEPPED_MAX_WIDTH = 640;
/** `_panes`: `size.height < 520` is "a phone on its side". */
const SHORT_HEIGHT = 520;
const MIN_VIDEO_PANE = 340;
/** `_panes`: the picture needs this much height to be worth a pane. */
const MIN_THREE_PANE_HEIGHT = 420;

/**
 * One portal, browsed the way its own app lists it: categories on the left,
 * what is in the chosen one in the middle, and — where there is room — the
 * channel playing in a pane of its own.
 */
export function PortalBrowserPage({
  portal,
  section,
  onSection,
  onPlay,
  onOpenSeries,
  onBack,
  playerSettings,
  onPlayerSettingsChange,
}: PortalBrowserPageProps) {
  const controller = useIptvController();
  const favorites = useLiveFavorites();
  const key = portalKey(portal.portal);
  const [sort, setSort] = useState<SortMode>('portal');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(() => IptvAliveStore.loadLiveOnly(key));
  // The categories pane keeps its own search and its own A→Z toggle, separate
  // from the list's — VyseTV's `_catText` and `_catAz`.
  const [catSearch, setCatSearch] = useState('');
  const [catAz, setCatAz] = useState(false);
  /** The compact layout hides each search behind an icon until it is asked for. */
  const [catSearchOpen, setCatSearchOpen] = useState(false);
  const [listSearchOpen, setListSearchOpen] = useState(false);
  /** The channel in the watch pane, and whether it has been taken full screen. */
  const [watching, setWatching] = useState<IptvStream | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panesRef = useRef<HTMLDivElement | null>(null);

  // VyseTV's `LayoutBuilder`: the pane rules come from the pane row's own box,
  // not the window, because the rails take a slice of the width. The height
  // that matters is what is left on screen below the bar, not the row's
  // content height — the row grows with the channel list.
  useEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: el.clientWidth,
        height: Math.max(0, (window.innerHeight || 0) - Math.max(0, rect.top)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    setFavoritesOnly(false);
    setSort('portal');
    setLiveOnly(IptvAliveStore.loadLiveOnly(key));
    // VyseTV's `_open`: leaving Live forgets the channel — there is nothing to
    // watch in a grid of films.
    if (section !== 'live') {
      setWatching(null);
      setExpanded(false);
    }
    void controller.openSection(portal, section);
  }, [controller, portal, section, key]);

  const [noun, nouns] = SECTION_NOUN[section];
  const title = PortalNames.of(key) ?? (portal.name || 'Portal');
  const meta = `${portal.expiry ? `Expires ${portal.expiry}  ·  ` : ''}${counted(controller.browserAllStreams.length, noun, nouns)}`;

  const search = controller.browserSearch;
  const query = search.trim().toLowerCase();
  const categoryId = controller.browserSelectedCategoryId;
  const workingChecked = controller.aliveCheckedAt !== null;

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const stream of controller.browserAllStreams) {
      map.set(stream.categoryId, (map.get(stream.categoryId) || 0) + 1);
    }
    return map;
  }, [controller.browserAllStreams]);

  const categories = useMemo(() => {
    const all = controller.categories.filter((category) => category.id !== '');
    const filtered = all.filter((category) => (counts.get(category.id) || 0) > 0);
    return filtered.length ? filtered : all;
  }, [controller.categories, counts]);

  // `_cats()`: the portal's own categories narrowed by the pane's search and
  // ordered the pane's way — "Favorites" and "All" follow below, in the render.
  const shownCategories = useMemo(() => {
    const needle = catSearch.trim().toLowerCase();
    const list = categories.filter((category) => !needle || category.name.toLowerCase().includes(needle));
    // VyseTV compares lower-cased names, so "aBc" and "ABC" sort together.
    if (catAz) list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return list;
  }, [categories, catSearch, catAz]);
  /** `_catHit` for the two rows built in the render. */
  const catHit = (name: string) => {
    const needle = catSearch.trim().toLowerCase();
    return !needle || name.toLowerCase().includes(needle);
  };

  const favoriteKeys = useMemo(() => new Set(favorites.map((favorite) => favorite.key)), [favorites]);
  const favoriteCount = useMemo(
    () => controller.browserAllStreams.filter((stream) => favoriteKeys.has(LiveFavorites.keyOf(portal, stream))).length,
    [controller.browserAllStreams, favoriteKeys, portal],
  );

  useEffect(() => {
    if (section === 'live') {
      LiveFavorites.adopt(portal, controller.browserAllStreams, (stream) => IptvClient.streamUrl(portal.portal, stream));
    }
  }, [controller.browserAllStreams, portal, section]);

  const visible = useMemo(() => {
    let list = controller.browserAllStreams.filter((stream) => {
      if (favoritesOnly) {
        if (!favoriteKeys.has(LiveFavorites.keyOf(portal, stream))) return false;
      } else if (categoryId && stream.categoryId !== categoryId) {
        return false;
      }
      if (query && !stream.name.toLowerCase().includes(query)) return false;
      if (liveOnly && section === 'live' && workingChecked && !controller.aliveStreamIds.has(stream.streamId)) {
        return false;
      }
      return true;
    });
    if (sort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'za') list = [...list].sort((a, b) => b.name.localeCompare(a.name));
    return list;
  }, [controller.browserAllStreams, controller.aliveStreamIds, portal, favoriteKeys, favoritesOnly, categoryId, query, liveOnly, workingChecked, section, sort]);

  const currentTitle = favoritesOnly
    ? 'Favorites'
    : categories.find((category) => category.id === categoryId)?.name ?? `All ${nouns}`;

  const toggleLiveOnly = useCallback(() => {
    const next = !liveOnly;
    setLiveOnly(next);
    IptvAliveStore.saveLiveOnly(key, next);
    if (next) void controller.startAliveCheck();
  }, [controller, key, liveOnly]);

  /** `_resetList`: picking a category starts the list over, with no search. */
  const resetList = useCallback(() => {
    setListSearchOpen(false);
    controller.setBrowserSearch('');
  }, [controller]);

  const pickCategory = useCallback((id: string) => {
    resetList();
    setFavoritesOnly(false);
    controller.selectBrowserCategory(id);
  }, [controller, resetList]);

  // ── the three-pane rule ────────────────────────────────────────────────
  // VyseTV's `_panes`, measured: the categories take at most 300 px, the list
  // up to 440, and the picture gets what is left — which must be a pane worth
  // watching, on a screen with the height for one.
  const narrow = size !== null && size.width < STEPPED_MAX_WIDTH;
  /** "A phone on its side": the bar loses its subtitle and both searches fold into icons. */
  const short = size !== null && size.height < SHORT_HEIGHT;
  const paneWidth = size?.width ?? 0;
  const categoryWidth = Math.max(210, Math.min(paneWidth > 1900 ? 340 : 300, paneWidth * 0.24));
  const listWidth = Math.max(340, Math.min(paneWidth > 1900 ? 520 : 440, paneWidth * 0.3));
  const three = Boolean(
    size
    && section === 'live'
    && !narrow
    && size.height >= MIN_THREE_PANE_HEIGHT
    && paneWidth - categoryWidth - listWidth - PANE_GAP * 2 >= MIN_VIDEO_PANE,
  );

  // No pane to play in: forget the channel, exactly as VyseTV does when its
  // `three` test fails.
  useEffect(() => {
    if (three) return;
    setWatching(null);
    setExpanded(false);
  }, [three]);

  const categoryName = categories.find((category) => category.id === watching?.categoryId)?.name ?? '';

  const playStream = useCallback(
    (stream: IptvStream, list: readonly IptvStream[], index: number) => {
      // VyseTV's `_tapStream(list, i, embedded: three)`: in the three-pane
      // browser a live channel plays *here*; a film still hands over to the
      // film player (`openIptvVideo`). With no pane to play in — a phone, a
      // narrow window — the channel opens the full player as before.
      if (three && section === 'live') {
        setWatching(stream);
        return;
      }
      const items = list.map((entry) => liveItemFromStream(portal, entry, section));
      onPlay(
        items[index] ?? {
          title: stream.name,
          subtitle: portalLabel(portal),
          logo: stream.icon || undefined,
          url: IptvClient.streamUrl(portal.portal, stream),
          live: section === 'live',
        },
        items,
        index,
      );
    },
    [onPlay, portal, section, three],
  );

  /** VyseTV's `_stepChannel`: wrap around the list on screen, keeping its row visible. */
  const stepChannel = useCallback(
    (direction: 1 | -1) => {
      const list = visible;
      if (!list.length) return;
      const at = list.findIndex((entry) => entry.streamId === watching?.streamId);
      const next = at < 0 ? 0 : (at + direction + list.length) % list.length;
      setWatching(list[next]);
      const rows: NodeListOf<HTMLElement> | undefined = panesRef.current?.querySelectorAll('[data-stream-id]');
      const row = Array.from(rows ?? []).find((entry) => entry.dataset.streamId === list[next].streamId);
      row?.scrollIntoView?.({ block: 'nearest' });
    },
    [visible, watching],
  );

  const emptyNote = (() => {
    if (controller.isLoading) return null;
    if (controller.error) {
      return { icon: Info, title: `Couldn't load ${nouns}`, body: controller.error };
    }
    if (favoritesOnly && !favoriteCount) {
      return { icon: Star, title: 'No favorites yet', body: `Star a ${noun} to keep it here.` };
    }
    if (liveOnly && workingChecked && !controller.aliveStreamIds.size && section === 'live') {
      return { icon: Tv, title: 'No working channels found', body: 'Check again or turn off Working only to see all channels.' };
    }
    if (!visible.length) {
      return { icon: Search, title: 'Nothing matches', body: 'Try another category, or clear the search.' };
    }
    return null;
  })();

  return (
    <SubPage
      title={title}
      // `_topBar`: a "phone on its side" keeps the name and drops the line under it.
      subtitle={short ? undefined : meta}
      compact={short}
      onBack={onBack}
      actions={
        <button
          type="button"
          className={`ltv-tool${controller.isFavoritePortal(key) ? ' on' : ''}`}
          style={controller.isFavoritePortal(key) ? { color: 'var(--ltv-star)' } : undefined}
          onClick={() => void controller.toggleFavoritePortal(key)}
        >
          <Star size={15} />
          {controller.isFavoritePortal(key) ? 'Favorited' : 'Favorite'}
        </button>
      }
    >
      <div className="ltv-browser-bar">
        <div className="ltv-chips" style={{ padding: 0 }}>
          {(['live', 'vod', 'series'] as const).map((value) => (
            <FilterChipPill
              key={value}
              label={SECTION_LABEL[value]}
              selected={section === value}
              onClick={() => onSection(value)}
            />
          ))}
        </div>
      </div>

      {/* VyseTV holds the player under a GlobalKey and returns it *instead of*
          the panes, so full screen only moves the widget: the stream never
          reconnects. In React, rendering it under a different branch would
          remount it and tear the stream down — so the pane keeps the one
          element and full screen is a class on it. */}

      <div
        ref={panesRef}
        className={`ltv-browser-panes${three ? ' has-watch' : ''}`}
        style={three ? { gridTemplateColumns: `${categoryWidth}px ${listWidth}px minmax(0, 1fr)` } : undefined}
      >
        <div className="ltv-pane" inert={expanded}>
          {/* `_catHeader`: compact and searching, the bar *is* the field; otherwise
              the heading with its two icons, and the field sits under it. */}
          {short && (catSearchOpen || catSearch.trim()) ? (
            <div className="ltv-pane-head">
              <input
                className="ltv-search ltv-pane-search"
                value={catSearch}
                placeholder="Search categories"
                aria-label="Search categories"
                autoFocus
                onChange={(event) => setCatSearch(event.target.value)}
              />
              <button
                type="button"
                className="ltv-pane-icon"
                aria-label="Close category search"
                onClick={() => { setCatSearch(''); setCatSearchOpen(false); }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="ltv-pane-head">
              <span>Categories</span>
              <small>{counted(categories.length, 'category').replace('categorys', 'categories')}</small>
              {short ? (
                <button
                  type="button"
                  className="ltv-pane-icon"
                  aria-label="Search categories"
                  onClick={() => setCatSearchOpen(true)}
                >
                  <Search size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className={`ltv-pane-icon${catAz ? ' on' : ''}`}
                aria-label={catAz ? 'Back to portal order' : 'Sort A to Z'}
                aria-pressed={catAz}
                onClick={() => setCatAz((value) => !value)}
              >
                <ArrowDownAZ size={14} />
              </button>
            </div>
          )}
          {!short ? (
            <input
              className="ltv-search ltv-pane-search"
              value={catSearch}
              placeholder="Search categories"
              aria-label="Search categories"
              onChange={(event) => setCatSearch(event.target.value)}
            />
          ) : null}
          <div className="ltv-cat-list">
            {catHit('Favorites') ? (
              <button
                type="button"
                className={`ltv-cat-item${favoritesOnly ? ' active' : ''}`}
                onClick={() => {
                  resetList();
                  setFavoritesOnly(true);
                  controller.selectBrowserCategory('');
                }}
              >
                <Star size={14} />
                <span>Favorites</span>
                <em>{favoriteCount}</em>
              </button>
            ) : null}
            {catHit(`All ${nouns}`) ? (
              <button
                type="button"
                className={`ltv-cat-item${!favoritesOnly && !categoryId ? ' active' : ''}`}
                onClick={() => pickCategory('')}
              >
                <span>{`All ${nouns}`}</span>
                <em>{controller.browserAllStreams.length}</em>
              </button>
            ) : null}
            {shownCategories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={`ltv-cat-item${!favoritesOnly && categoryId === category.id ? ' active' : ''}`}
                onClick={() => pickCategory(category.id)}
              >
                <span>{category.name}</span>
                <em>{counts.get(category.id) || 0}</em>
              </button>
            ))}
            {!shownCategories.length && !(section === 'live' && catHit('Favorites')) && !catHit(`All ${nouns}`) ? (
              <p className="ltv-pane-quiet">No category matches</p>
            ) : null}
          </div>
        </div>

        <div className="ltv-pane" inert={expanded}>
          {/* `_listHeader`: same shape as the categories header — compact folds
              the search into an icon, roomy draws it under the heading. */}
          {short && (listSearchOpen || search) ? (
            <div className="ltv-pane-head">
              <input
                className="ltv-search ltv-pane-search"
                value={search}
                placeholder={favoritesOnly || !categoryId ? `Search all ${nouns}` : `Search in ${currentTitle}`}
                aria-label="Search this portal"
                autoFocus
                onChange={(event) => controller.setBrowserSearch(event.target.value)}
              />
              <button
                type="button"
                className="ltv-pane-icon"
                aria-label="Close search"
                onClick={() => { controller.setBrowserSearch(''); setListSearchOpen(false); }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="ltv-pane-head">
              <span>{currentTitle}</span>
              <small>{counted(visible.length, noun, nouns)}</small>
              {short ? (
                <button
                  type="button"
                  className="ltv-pane-icon"
                  aria-label="Search this portal"
                  onClick={() => setListSearchOpen(true)}
                >
                  <Search size={14} />
                </button>
              ) : null}
            </div>
          )}
          {!short ? (
            <input
              className="ltv-search ltv-pane-search"
              value={search}
              placeholder={favoritesOnly || !categoryId ? `Search all ${nouns}` : `Search in ${currentTitle}`}
              aria-label="Search this portal"
              onChange={(event) => controller.setBrowserSearch(event.target.value)}
            />
          ) : null}

          <div className="ltv-toolbar-row">
            {section === 'live' ? (
              <>
                <FilterChipPill
                  label="Working only"
                  selected={liveOnly}
                  onClick={toggleLiveOnly}
                  disabled={controller.isLoading}
                />
                {controller.aliveChecked > 0 ? (
                  <span className="ltv-status" style={{ margin: 0 }}>
                    <p>{`Checked ${controller.aliveChecked} of ${controller.aliveTotal}`}</p>
                  </span>
                ) : null}
                <ToolButton
                  icon={Tv}
                  label={controller.isVerifyingAlive ? 'Stop checking' : 'Check which work'}
                  onClick={() =>
                    controller.isVerifyingAlive
                      ? controller.stopAliveCheck()
                      : void controller.startAliveCheck(true)
                  }
                />
              </>
            ) : null}
            <ToolButton
              icon={ListVideo}
              label={
                sort === 'portal' ? 'Portal order' : sort === 'az' ? 'A to Z' : 'Z to A'
              }
              onClick={() => setSort((value) => (value === 'portal' ? 'az' : value === 'az' ? 'za' : 'portal'))}
            />
          </div>

          {controller.isLoading ? <StatusLine text={`Opening ${title}…`} busy /> : null}

          {emptyNote ? (
            <EmptyState
              icon={emptyNote.icon as IconType}
              title={emptyNote.title}
              body={
                <>
                  {emptyNote.body}
                  {controller.error ? (
                    <>
                      <br />
                      <button
                        type="button"
                        className="ltv-secondary"
                        style={{ marginTop: 10 }}
                        onClick={() => void controller.openSection(portal, section)}
                      >
                        Retry
                      </button>
                    </>
                  ) : null}
                </>
              }
            />
          ) : section === 'live' ? (
            <div>
              {visible.map((stream, index) => (
                <BrowserChannelRow
                  key={stream.streamId}
                  portal={portal}
                  stream={stream}
                  alive={controller.aliveStreamIds.has(stream.streamId)}
                  checked={controller.aliveCheckedAt !== null}
                  selected={three && watching?.streamId === stream.streamId}
                  onPlay={() => playStream(stream, visible, index)}
                />
              ))}
            </div>
          ) : (
            <div className="ltv-poster-grid">
              {visible.map((stream, index) => (
                <StreamCard
                  key={stream.streamId}
                  name={stream.name}
                  logo={stream.icon || undefined}
                  poster
                  onClick={() => (section === 'series' ? onOpenSeries(stream) : playStream(stream, visible, index))}
                />
              ))}
            </div>
          )}
        </div>

        {three ? <WatchPane
          portal={portal}
          stream={watching}
          category={categoryName}
          expanded={expanded}
          onExpand={() => setExpanded((value) => !value)}
          onStep={visible.length > 1 ? stepChannel : undefined}
          playerSettings={playerSettings}
          onPlayerSettingsChange={onPlayerSettingsChange}
        /> : null}
      </div>
    </SubPage>
  );
}

/**
 * VyseTV's `_watchPane`: the picture, then the channel's guide underneath.
 * The pane's size is taken from the pane, and the picture gives height back to
 * the details when the pane is short (`maxH = max(120, height - 210)`).
 */
function WatchPane({
  portal,
  stream,
  category,
  expanded,
  onExpand,
  onStep,
  playerSettings,
  onPlayerSettingsChange,
}: {
  portal: VerifiedPortal;
  stream: IptvStream | null;
  category: string;
  expanded: boolean;
  onExpand: () => void;
  onStep?: (direction: 1 | -1) => void;
  playerSettings: PlayerSettings;
  onPlayerSettingsChange: (patch: Partial<PlayerSettings>) => void;
}) {
  if (!stream) {
    return (
      <div className={`ltv-watch-pane is-empty${expanded ? ' is-expanded' : ''}`}>
        <div className="ltv-pane-note">
          <Tv size={30} />
          <strong>Pick a channel</strong>
          <p>It plays here. Double-click the picture for full screen.</p>
        </div>
      </div>
    );
  }

  const item = liveItemFromStream(portal, stream, 'live');
  return (
    <div className={`ltv-watch-pane${expanded ? ' is-expanded' : ''}`}>
      <div className="ltv-watch-frame">
        {/* Kept mounted across pane ↔ full screen: `expanded` is a layout
            switch inside the player, never a remount, so the stream holds. */}
        <React.Suspense fallback={<div className="ltv-watch-loading">Tuning in…</div>}>
          <BrowserLivePlayer
            item={item}
            expanded={expanded}
            onExpand={onExpand}
            onStep={onStep}
            guide={expanded ? <NowNextStrip portal={portal} stream={stream} /> : undefined}
            settings={playerSettings}
            onSettingsChange={onPlayerSettingsChange}
          />
        </React.Suspense>
      </div>
      {!expanded && (
        <div className="ltv-watch-details">
          <ChannelDetails portal={portal} stream={stream} category={category} />
        </div>
      )}
    </div>
  );
}

/**
 * `_ChannelDetails`: the channel's logo, name and place, its star, then what is
 * on now with its progress, and what follows. Asks for the longer schedule once.
 */
function ChannelDetails({
  portal,
  stream,
  category,
}: {
  portal: VerifiedPortal;
  stream: IptvStream;
  category: string;
}) {
  const guide = liveGuide();
  const [version, setVersion] = useState(0);
  const [favorite, setFavorite] = useState(() => LiveFavorites.has(portal, stream));

  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    guide.clockListeners.add(listener);
    // The loader keeps it to one request per channel every ten minutes.
    guide.wantSchedule(portal, stream);
    return () => { guide.clockListeners.delete(listener); };
  }, [guide, portal, stream]);

  useEffect(() => {
    setFavorite(LiveFavorites.has(portal, stream));
    return LiveFavorites.subscribe(() => setFavorite(LiveFavorites.has(portal, stream)));
  }, [portal, stream]);

  const entries = guide.guideOf(portal, stream);
  const now = nowNext(entries || []).now;
  const later = upcomingGuide(entries || []).slice(0, 6);
  const sub = [category, portal.name].filter(Boolean).join('  ·  ');

  return (
    <div className="ltv-watch-info" data-version={version}>
      <div className="ltv-watch-head">
        <span className="ltv-watch-logo">
          {stream.icon ? <img src={stream.icon} alt="" loading="lazy" /> : <Tv size={24} />}
        </span>
        <div className="ltv-watch-names">
          <strong>{stream.name}</strong>
          {sub ? <span>{sub}</span> : null}
        </div>
        <button
          type="button"
          className={`ltv-watch-star${favorite ? ' on' : ''}`}
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={() => LiveFavorites.toggle(portal, stream, IptvClient.streamUrl(portal.portal, stream))}
        >
          <Star size={19} />
        </button>
      </div>

      {entries === null ? <p className="ltv-watch-quiet">Loading the guide</p>
        : !now && !later.length ? <p className="ltv-watch-quiet">No guide for this channel</p>
          : (
            <>
              {now ? (
                <>
                  <p className="ltv-watch-label">ON NOW</p>
                  <p className="ltv-watch-title">{now.title || 'Untitled'}</p>
                  <p className="ltv-watch-time">
                    {`${guideTime(now.start)} – ${guideTime(now.stop)}  ·  ${leftOf(now.stopMs)}`}
                  </p>
                  <Progress value={epgProgress(now)} />
                  {now.description?.trim() ? (
                    <p className="ltv-watch-blurb">{now.description.trim()}</p>
                  ) : null}
                </>
              ) : null}

              {later.length ? (
                <>
                  <p className="ltv-watch-label">UP NEXT</p>
                  <ul className="ltv-watch-upnext">
                    {later.map((entry) => (
                      <li key={`${entry.startMs}-${entry.title}`}>
                        <em>{guideTime(entry.startMs)}</em>
                        <span>{entry.title || 'Untitled'}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
    </div>
  );
}

/** VyseTV's `_left`: how long the programme still has to run. */
function leftOf(stopMs: number): string {
  const minutes = Math.floor((stopMs - Date.now()) / 60_000);
  if (minutes < 1) return 'ending now';
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/**
 * `_NowNextStrip`: now / next over the picture in full screen, like the full
 * player's strip. Watches the guide while it is on screen.
 */
function NowNextStrip({ portal, stream }: { portal: VerifiedPortal; stream: IptvStream }) {
  const guide = liveGuide();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    guide.addWatcher();
    const listener = () => {
      guide.refresh(portal, stream);
      setVersion((value) => value + 1);
    };
    guide.clockListeners.add(listener);
    guide.want(portal, stream);
    return () => {
      guide.clockListeners.delete(listener);
      guide.unwant(portal, stream);
      guide.removeWatcher();
    };
  }, [guide, portal, stream]);

  const entries = guide.guideOf(portal, stream) || [];
  const { now, next } = nowNext(entries);
  if (!now) return null;

  return (
    <div className="ltv-nownext" data-version={version}>
      <div className="ltv-nownext-top">
        <em>NOW</em>
        <strong>{now.title}</strong>
        <span>{`${guideTime(now.start)} – ${guideTime(now.stop)}`}</span>
      </div>
      <Progress value={epgProgress(now)} />
      {next ? (
        <p className="ltv-nownext-next">{`Next  ${guideTime(next.start)}  ${next.title}`}</p>
      ) : null}
    </div>
  );
}

/** `_Progress`: the thin accent bar under now/next. */
function Progress({ value }: { value: number }) {
  return (
    <div className="ltv-progress" role="presentation">
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

/** `_ChannelRow` — a portal's live channel with its dot, star and guide line. */
function BrowserChannelRow({
  portal,
  stream,
  alive,
  checked,
  selected,
  onPlay,
}: {
  portal: VerifiedPortal;
  stream: IptvStream;
  alive: boolean;
  checked: boolean;
  /** Playing in the watch pane (`_ChannelRow(selected: embedded && ...)`). */
  selected?: boolean;
  onPlay: () => void;
}) {
  const guide = liveGuide();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    guide.addWatcher();
    const listener = () => setVersion((value) => value + 1);
    guide.clockListeners.add(listener);
    guide.want(portal, stream);
    return () => {
      guide.clockListeners.delete(listener);
      guide.unwant(portal, stream);
      guide.removeWatcher();
    };
  }, [guide, portal, stream]);

  const entries = guide.guideOf(portal, stream);
  const { now } = nowNext(entries || []);
  const favorite = LiveFavorites.has(portal, stream);

  return (
    <div
      className={`ltv-row${selected ? ' is-watching' : ''}`}
      data-version={version}
      data-stream-id={stream.streamId}
    >
      {checked ? <i className={`ltv-alive-dot${alive ? ' on' : ''}`} /> : null}
      <span className="ltv-row-logo">
        {stream.icon ? <img src={stream.icon} alt="" loading="lazy" /> : <Tv size={18} />}
      </span>
      <button
        type="button"
        className="ltv-row-body"
        style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
        onClick={onPlay}
      >
        <span className="ltv-row-title">{stream.name}</span>
        <span className="ltv-row-sub">
          {now ? `${hhmm(now.startMs)}  ·  ${now.title}` : 'Live now'}
        </span>
      </button>
      <div className="ltv-row-actions">
        <button
          type="button"
          className={favorite ? 'on' : ''}
          aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={() => LiveFavorites.toggle(portal, stream, IptvClient.streamUrl(portal.portal, stream))}
        >
          <Star size={18} />
        </button>
      </div>
      <button type="button" className="ltv-row-play" aria-label={`Play ${stream.name}`} onClick={onPlay}>
        <CirclePlay size={20} />
      </button>
    </div>
  );
}

export { SectionHeader, ShelfHeader, InfoTile };
