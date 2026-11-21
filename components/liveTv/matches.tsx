// Live TV matches.
//
// Line-for-line transcription of VyseTV's
// `lib/screens/live_tv/matches_view.dart` (GPL-3.0-or-later): a day picker
// running from yesterday to six days out, sport pills, shelves that put what
// is live now first, then one shelf per league, and the fixture page with its
// "Where to watch" grid.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePlay, Radio, RefreshCw, Shield, Tv, WifiOff } from 'lucide-react';
import {
  fetchEspnSchedule,
  HardcodedChannels,
  MatchFinder,
  type ScheduleMatch,
  type SportKind,
} from '../../services/iptvService';
import {
  ChannelTile,
  EmptyState,
  FilterChipPill,
  hhmm,
  LivePill,
  SectionHeader,
  ShelfHeader,
  StatusLine,
  SubPage,
  TeamBadge,
  ToolButton,
  type IconType,
} from './widgets';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SPORT_ICON: Record<SportKind, IconType> = {
  football: CirclePlay,
  basketball: CirclePlay,
  americanFootball: CirclePlay,
  hockey: CirclePlay,
  mma: CirclePlay,
  motorsport: CirclePlay,
};

const SPORT_LABEL: Record<SportKind, string> = {
  football: 'Football',
  basketball: 'Basketball',
  americanFootball: 'NFL',
  hockey: 'Hockey',
  mma: 'MMA',
  motorsport: 'Motorsport',
};

function startOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

function addDays(day: Date, days: number): Date {
  const next = new Date(day);
  next.setDate(next.getDate() + days);
  return next;
}

/** `_dayLabel` — Yesterday / Today / Tomorrow, then "Mon 24". */
function dayLabel(offset: number, day: Date): string {
  if (offset === -1) return 'Yesterday';
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return `${WEEKDAYS[day.getDay()]} ${day.getDate()}`;
}

export interface MatchesViewProps {
  /** Open the feed picker for a curated channel, scoped to this fixture. */
  onOpenChannel: (channelId: string, match: ScheduleMatch) => void;
}

/** The Matches tab: a day of fixtures, grouped the way the guides list them. */
export function MatchesView({ onOpenChannel }: MatchesViewProps) {
  const [dayOffset, setDayOffset] = useState(0);
  const [sport, setSport] = useState<SportKind | null>(null);
  const [matches, setMatches] = useState<ScheduleMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ScheduleMatch | null>(null);

  const today = useMemo(() => startOfDay(new Date()), []);
  const day = useMemo(() => addDays(today, dayOffset), [today, dayOffset]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void fetchEspnSchedule(day)
      .then((list) => {
        if (!active) return;
        setMatches(list);
        setFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setMatches([]);
        setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [day, attempt]);

  const anyLive = matches.some((match) => match.state === 'live');

  // Refresh once a minute, but only while something is actually being played.
  useEffect(() => {
    if (!anyLive) return;
    const timer = window.setInterval(() => setAttempt((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [anyLive]);

  const sports = useMemo(() => {
    const found = new Set<SportKind>();
    for (const match of matches) found.add(match.sport);
    return [...found].sort((a, b) => SPORT_LABEL[a].localeCompare(SPORT_LABEL[b]));
  }, [matches]);

  const visible = useMemo(
    () => matches.filter((match) => sport === null || match.sport === sport),
    [matches, sport],
  );

  const live = useMemo(() => visible.filter((match) => match.state === 'live'), [visible]);

  const shelves = useMemo(() => {
    const byLeague = new Map<string, ScheduleMatch[]>();
    for (const match of visible) {
      if (match.state === 'live') continue;
      const list = byLeague.get(match.league) ?? [];
      list.push(match);
      byLeague.set(match.league, list);
    }
    return [...byLeague.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  if (open) {
    return (
      <MatchPage
        match={open}
        onBack={() => setOpen(null)}
        onOpenChannel={(channelId) => onOpenChannel(channelId, open)}
      />
    );
  }

  return (
    <div>
      <SectionHeader
        title="Matches"
        subtitle="Fixtures from ESPN, with the international channels that carry them."
      />

      <div className="ltv-chips">
        {Array.from({ length: 8 }, (_, index) => index - 1).map((offset) => {
          const target = addDays(today, offset);
          return (
            <FilterChipPill
              key={offset}
              label={dayLabel(offset, target)}
              selected={dayOffset === offset}
              onClick={() => setDayOffset(offset)}
            />
          );
        })}
      </div>

      {sports.length > 1 ? (
        <div className="ltv-chips">
          <FilterChipPill label="All sports" selected={sport === null} onClick={() => setSport(null)} />
          {sports.map((kind) => {
            const Icon = SPORT_ICON[kind];
            return (
              <FilterChipPill
                key={kind}
                icon={Icon}
                label={SPORT_LABEL[kind]}
                selected={sport === kind}
                onClick={() => setSport(kind)}
              />
            );
          })}
        </div>
      ) : null}

      {loading ? <StatusLine text="Reading the fixtures…" busy /> : null}

      {!loading && (failed || !visible.length) ? (
        <EmptyState
          icon={failed ? WifiOff : Radio}
          title={failed ? "Couldn't load fixtures" : `No matches ${dayLabel(dayOffset, day).toLowerCase()}`}
          body={
            <>
              {failed ? 'Check your connection and try again.' : 'Try another day or sport.'}
              <br />
              <button
                type="button"
                className="ltv-secondary"
                style={{ marginTop: 10 }}
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={13} /> Retry
              </button>
            </>
          }
        />
      ) : null}

      {live.length ? (
        <>
          <ShelfHeader>Live now</ShelfHeader>
          <div className="ltv-match-shelf">
            {live.map((match) => (
              <MatchCard key={match.id} match={match} onOpen={() => setOpen(match)} />
            ))}
          </div>
        </>
      ) : null}

      {shelves.map(([league, list]) => (
        <React.Fragment key={league}>
          <ShelfHeader>{league}</ShelfHeader>
          <div className="ltv-match-shelf">
            {list.map((match) => (
              <MatchCard key={match.id} match={match} onOpen={() => setOpen(match)} />
            ))}
          </div>
        </React.Fragment>
      ))}

      <p style={{ margin: '18px 0 0', fontSize: 11.5, color: 'var(--ltv-faint)' }}>
        Fixtures and US listings from ESPN. International channels added by VyseTV.
      </p>
    </div>
  );
}

/** `MatchCard` — one fixture: league, kick-off or score, and where it is on. */
function MatchCard({ match, onOpen }: { match: ScheduleMatch; onOpen: () => void }) {
  const live = match.state === 'live';
  const kick = hhmm(match.start);
  return (
    <button type="button" className="ltv-match-card" onClick={onOpen}>
      <span className="ltv-match-top">
        {match.leagueLogo ? <img src={match.leagueLogo} alt="" width={14} height={14} style={{ objectFit: 'contain' }} /> : null}
        <span className="ltv-match-league">{match.league}</span>
        {live ? <LivePill /> : <span className="ltv-match-kick">{kick}</span>}
      </span>
      <span className="ltv-match-body">
        <span className="ltv-match-side">
          <TeamBadge name={match.home?.name || match.name} logo={match.home?.logo} size={30} ShieldIcon={Shield} />
          <span>{match.home?.short || match.home?.name || match.name}</span>
        </span>
        {live || match.state === 'finished' ? (
          <span className="ltv-match-score">
            {`${match.home?.score ?? '-'}  –  ${match.away?.score ?? '-'}`}
          </span>
        ) : (
          <span className="ltv-match-score upcoming">{kick}</span>
        )}
        <span className="ltv-match-side">
          <TeamBadge name={match.away?.name || ''} logo={match.away?.logo} size={30} ShieldIcon={Shield} />
          <span>{match.away?.short || match.away?.name || ''}</span>
        </span>
      </span>
      <span className="ltv-match-where">
        <Tv size={13} />
        <span>{match.broadcasts.slice(0, 3).join('  ·  ') || 'Channels below'}</span>
      </span>
    </button>
  );
}

/** `MatchPage` — the fixture itself, then every channel that might carry it. */
function MatchPage({
  match,
  onBack,
  onOpenChannel,
}: {
  match: ScheduleMatch;
  onBack: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const live = match.state === 'live';
  const start = new Date(match.start);
  const when = `${WEEKDAYS[start.getDay()]} ${start.getDate()} ${MONTHS[start.getMonth()]}  ·  ${hhmm(match.start)}`;
  const [, bump] = useState(0);
  const finder = useRef<MatchFinder | null>(null);

  useEffect(() => MatchFinder.subscribe(() => bump((value) => value + 1)), []);

  /** The channels the guide says are carrying it, by curated channel id. */
  const found = MatchFinder.found.get(match.id);

  const catalog = useMemo(() => {
    const keywords = new Set<string>();
    for (const broadcast of match.broadcasts) {
      for (const word of broadcast.toLowerCase().split(/[^a-z0-9]+/)) if (word) keywords.add(word);
    }
    const league = match.league.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return HardcodedChannels.all
      .map((channel) => {
        const haystack = `${channel.name} ${channel.keywords.join(' ')}`.toLowerCase();
        let score = 0;
        for (const word of keywords) if (word.length > 2 && haystack.includes(word)) score += 2;
        for (const word of league) if (word.length > 2 && haystack.includes(word)) score += 1;
        return { channel, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map((entry) => entry.channel);
  }, [match.broadcasts, match.league]);

  return (
    <SubPage title={match.name} subtitle={match.league} onBack={onBack}>
      <div className="ltv-match-guide" style={{ padding: '18px 16px' }}>
        <div className="ltv-match-guide-head">
          {match.leagueLogo ? (
            <img src={match.leagueLogo} alt="" width={18} height={18} style={{ objectFit: 'contain' }} />
          ) : (
            <Tv size={18} />
          )}
          <span>{match.league}</span>
          {live ? <LivePill text={match.status} /> : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <span className="ltv-match-side">
            <TeamBadge name={match.home?.name || match.name} logo={match.home?.logo} size={64} ShieldIcon={Shield} />
            <span style={{ fontSize: 14 }}>{match.home?.name || match.name}</span>
          </span>
          {live || match.state === 'finished' ? (
            <span className="ltv-match-score" style={{ fontSize: 32, flex: '0 0 auto' }}>
              {`${match.home?.score ?? '-'}  –  ${match.away?.score ?? '-'}`}
            </span>
          ) : (
            <span style={{ flex: '0 0 auto', textAlign: 'center' }}>
              <span style={{ display: 'block', fontSize: 30, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                {hhmm(match.start)}
              </span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--ltv-faint)' }}>Kick-off</span>
            </span>
          )}
          <span className="ltv-match-side">
            <TeamBadge name={match.away?.name || ''} logo={match.away?.logo} size={64} ShieldIcon={Shield} />
            <span style={{ fontSize: 14 }}>{match.away?.name || ''}</span>
          </span>
        </div>

        <div style={{ marginTop: 14, fontSize: 12, color: 'var(--ltv-muted)' }}>
          {when}
          {match.venue ? `  ·  ${match.venue}` : ''}
        </div>
      </div>

      <ShelfHeader>Where to watch</ShelfHeader>
      {catalog.length === 0 ? (
        <EmptyState
          icon={Tv}
          title="No channels listed"
          body="Add a portal in the Portals tab, then come back to this fixture."
        />
      ) : (
        <div className="ltv-tile-grid">
          {catalog.map((channel) => (
            <ChannelTile
              key={channel.id}
              name={channel.name}
              shortName={channel.shortName}
              gradient={channel.gradient}
              logo={channel.logo || channel.iconUrl}
              chips={found?.get(channel.id)}
              onClick={() => onOpenChannel(channel.id)}
            />
          ))}
        </div>
      )}

      <p style={{ margin: '18px 0 0', fontSize: 11.5, color: 'var(--ltv-faint)' }}>
        Pick a channel and VyseTV searches your portals, then reads their TV guides to find the exact
        feed (beIN Sports 2, AR…).
      </p>

      <div style={{ marginTop: 12 }}>
        <ToolButton icon={RefreshCw} label="Back to fixtures" onClick={onBack} />
      </div>
    </SubPage>
  );
}
