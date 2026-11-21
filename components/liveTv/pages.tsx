// Live TV sub-pages.
//
// Line-for-line transcription of VyseTV's
// `lib/screens/live_tv/live_tv_pages.dart` and
// `lib/screens/live_tv/portal_browser_page.dart` (GPL-3.0-or-later):
// LiveChannelPage, M3uPlaylistPage, SeriesPage and PortalBrowserPage, with the
// same copy, the same filters and the same empty states.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePlay, Info, ListVideo, Search, Star, Tv, X } from 'lucide-react';
import {
  fetchSeriesEpisodes,
  hitTagsOf,
  IptvAliveStore,
  IptvClient,
  liveGuide,
  liveItemFromEpisode,
  LiveFavorites,
  MatchFinder,
  nowNext,
  PortalNames,
  portalKey,
  portalLabel,
  toEpochMs,
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
  onPlay: (item: LiveItem) => void;
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
          onClick={() => visible[0] && onPlay({ title: channel.name, url: visible[0].streamUrl, live: true })}
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
          {visible.map((hit) => (
            <HitRow
              key={hit.streamUrl}
              channel={channel}
              hit={hit}
              guide={playing?.entryFor(hit) ?? null}
              favorite={controller.isFavoriteHit(channel.id, hit)}
              onToggleFavorite={() => void controller.toggleFavoriteHit(channel.id, hit)}
              onPlay={() =>
                onPlay({
                  title: channel.name,
                  url: hit.streamUrl,
                  subtitle: [portalLabel(hit.portal), hit.stream.name].filter(Boolean).join('  ·  '),
                  logo: hit.stream.icon || channel.logo,
                  live: true,
                })
              }
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
  onPlay: (channel: M3uChannel) => void;
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
          {visible.map((channel) => (
            <StreamCard
              key={`${channel.url}-${channel.name}`}
              name={channel.name}
              logo={channel.logo}
              onClick={() => onPlay(channel)}
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
  onPlay: (item: LiveItem) => void;
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
        ? visible.map((episode) => (
            <div className="ltv-row" key={episode.id}>
              <span className="ltv-episode-art">
                {episode.image ? <img src={episode.image} alt="" loading="lazy" /> : <ListVideo size={22} />}
              </span>
              <button
                type="button"
                className="ltv-row-body"
                style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => onPlay(liveItemFromEpisode(portal, series, episode))}
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
  onPlay: (item: LiveItem) => void;
  onOpenSeries: (series: IptvStream) => void;
  onBack: () => void;
}

/**
 * One portal, browsed the way its own app lists it: categories on the left,
 * what is in the chosen one on the right.
 */
export function PortalBrowserPage({
  portal,
  section,
  onSection,
  onPlay,
  onOpenSeries,
  onBack,
}: PortalBrowserPageProps) {
  const controller = useIptvController();
  const key = portalKey(portal.portal);
  const [sort, setSort] = useState<SortMode>('portal');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(() => IptvAliveStore.loadLiveOnly(key));

  useEffect(() => {
    setFavoritesOnly(false);
    setSort('portal');
    setLiveOnly(IptvAliveStore.loadLiveOnly(key));
    void controller.openSection(portal, section);
  }, [controller, portal, section, key]);

  const [noun, nouns] = SECTION_NOUN[section];
  const title = PortalNames.of(key) ?? (portal.name || 'Portal');
  const meta = `${portal.expiry ? `Expires ${portal.expiry}  ·  ` : ''}${counted(controller.browserAllStreams.length, noun, nouns)}`;

  const search = controller.browserSearch;
  const query = search.trim().toLowerCase();
  const categoryId = controller.browserSelectedCategoryId;

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

  const favoriteCount = useMemo(
    () => controller.browserAllStreams.filter((stream) => LiveFavorites.has(portal, stream)).length,
    [controller.browserAllStreams, portal],
  );

  const visible = useMemo(() => {
    let list = controller.browserAllStreams.filter((stream) => {
      if (favoritesOnly) {
        if (!LiveFavorites.has(portal, stream)) return false;
      } else if (categoryId && stream.categoryId !== categoryId) {
        return false;
      }
      if (query && !stream.name.toLowerCase().includes(query)) return false;
      if (liveOnly && section === 'live' && controller.aliveStreamIds.size && !controller.aliveStreamIds.has(stream.streamId)) {
        return false;
      }
      return true;
    });
    if (sort === 'az') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'za') list = [...list].sort((a, b) => b.name.localeCompare(a.name));
    return list;
  }, [controller.browserAllStreams, controller.aliveStreamIds, portal, favoritesOnly, categoryId, query, liveOnly, section, sort]);

  const currentTitle = favoritesOnly
    ? 'Favorites'
    : categories.find((category) => category.id === categoryId)?.name ?? `All ${nouns}`;

  const toggleLiveOnly = useCallback(() => {
    setLiveOnly((value) => {
      const next = !value;
      IptvAliveStore.saveLiveOnly(key, next);
      return next;
    });
  }, [key]);

  const playStream = useCallback(
    (stream: IptvStream) => {
      const url = IptvClient.streamUrl(portal.portal, stream);
      onPlay({
        title: stream.name,
        subtitle: portalLabel(portal),
        logo: stream.icon || undefined,
        url,
        live: section === 'live',
      });
    },
    [onPlay, portal, section],
  );

  const emptyNote = (() => {
    if (controller.isLoading) return null;
    if (controller.error) {
      return { icon: Info, title: 'Nothing in this section', body: `This portal has no ${nouns}, or it did not answer.` };
    }
    if (favoritesOnly && !favoriteCount) {
      return { icon: Star, title: 'No favorites yet', body: `Star a ${noun} to keep it here.` };
    }
    if (!visible.length) {
      return { icon: Search, title: 'Nothing matches', body: 'Try another category, or clear the search.' };
    }
    return null;
  })();

  return (
    <SubPage title={title} subtitle={meta} onBack={onBack}>
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
        <button
          type="button"
          className={`ltv-tool${controller.isFavoritePortal(key) ? ' on' : ''}`}
          style={controller.isFavoritePortal(key) ? { color: 'var(--ltv-star)' } : undefined}
          onClick={() => void controller.toggleFavoritePortal(key)}
        >
          <Star size={15} />
          {controller.isFavoritePortal(key) ? 'Favorited' : 'Favorite'}
        </button>
      </div>

      <div className="ltv-browser-panes">
        <div className="ltv-pane">
          <div className="ltv-pane-head">
            <span>Categories</span>
            <small>{counted(categories.length, 'category').replace('categorys', 'categories')}</small>
          </div>
          <div className="ltv-cat-list">
            <button
              type="button"
              className={`ltv-cat-item${favoritesOnly ? ' active' : ''}`}
              onClick={() => {
                setFavoritesOnly(true);
                controller.selectBrowserCategory('');
              }}
            >
              <Star size={14} />
              <span>Favorites</span>
              <em>{favoriteCount}</em>
            </button>
            <button
              type="button"
              className={`ltv-cat-item${!favoritesOnly && !categoryId ? ' active' : ''}`}
              onClick={() => {
                setFavoritesOnly(false);
                controller.selectBrowserCategory('');
              }}
            >
              <span>{`All ${nouns}`}</span>
              <em>{controller.browserAllStreams.length}</em>
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={`ltv-cat-item${!favoritesOnly && categoryId === category.id ? ' active' : ''}`}
                onClick={() => {
                  setFavoritesOnly(false);
                  controller.selectBrowserCategory(category.id);
                }}
              >
                <span>{category.name}</span>
                <em>{counts.get(category.id) || 0}</em>
              </button>
            ))}
          </div>
        </div>

        <div className="ltv-pane">
          <div className="ltv-pane-head">
            <span>{currentTitle}</span>
            <small>{counted(visible.length, noun, nouns)}</small>
          </div>

          <div className="ltv-toolbar-row">
            <input
              className="ltv-search"
              value={search}
              placeholder={favoritesOnly || !categoryId ? `Search all ${nouns}` : `Search in ${currentTitle}`}
              aria-label="Search this portal"
              onChange={(event) => controller.setBrowserSearch(event.target.value)}
            />
            {section === 'live' ? (
              <>
                <FilterChipPill
                  label={controller.isVerifyingAlive ? 'Checking…' : liveOnly ? 'Working only' : 'Working only'}
                  selected={liveOnly}
                  onClick={toggleLiveOnly}
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
              {visible.map((stream) => (
                <BrowserChannelRow
                  key={stream.streamId}
                  portal={portal}
                  stream={stream}
                  alive={controller.aliveStreamIds.has(stream.streamId)}
                  checked={controller.aliveCheckedAt !== null}
                  onPlay={() => playStream(stream)}
                />
              ))}
            </div>
          ) : (
            <div className="ltv-poster-grid">
              {visible.map((stream) => (
                <StreamCard
                  key={stream.streamId}
                  name={stream.name}
                  logo={stream.icon || undefined}
                  poster
                  onClick={() => (section === 'series' ? onOpenSeries(stream) : playStream(stream))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </SubPage>
  );
}

/** `_ChannelRow` — a portal's live channel with its dot, star and guide line. */
function BrowserChannelRow({
  portal,
  stream,
  alive,
  checked,
  onPlay,
}: {
  portal: VerifiedPortal;
  stream: IptvStream;
  alive: boolean;
  checked: boolean;
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
    <div className="ltv-row" data-version={version}>
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
