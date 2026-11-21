// Match finder + ESPN scoreboard schedule.
//
// Ported from VyseTV `lib/data/live_tv/sports_schedule.dart` and
// `lib/data/live_tv/match_finder.dart` (GPL-3.0-or-later), adapted to PRAHA's
// existing `LiveMatchEvent` model and virtualised Live TV list. All network
// calls go through `nativeFetchText`; the parsing/dedupe helpers are pure.

import type { LiveMatchEvent } from '../iptvService';
import { toEpochMs, type EpgProgram } from './epg';

export type SportKind = 'football' | 'basketball' | 'americanFootball' | 'hockey' | 'mma' | 'motorsport';

export interface ScheduleLeague {
  /** ESPN scoreboard path, e.g. `soccer/eng.1`. */
  path: string;
  name: string;
  sport: SportKind;
  /** International rights holders as Live TV channel ids. */
  channels: string[];
  /** Races and fight cards: one event, not two teams. */
  eventMode?: boolean;
}

export const ESPN_LEAGUES: readonly ScheduleLeague[] = [
  { path: 'soccer/uefa.champions', name: 'Champions League', sport: 'football', channels: ['bein_sports', 'tnt_sports', 'cbs_sports', 'canal_plus_sport'] },
  { path: 'soccer/eng.1', name: 'Premier League', sport: 'football', channels: ['sky_sports', 'tnt_sports', 'bein_sports', 'nbc_sports'] },
  { path: 'soccer/esp.1', name: 'LaLiga', sport: 'football', channels: ['bein_sports', 'movistar_laliga', 'la_liga', 'espn_deportes'] },
  { path: 'soccer/ita.1', name: 'Serie A', sport: 'football', channels: ['sky_sport_italia', 'dazn', 'serie_a'] },
  { path: 'soccer/ger.1', name: 'Bundesliga', sport: 'football', channels: ['sky_sport_de', 'dazn', 'bundesliga'] },
  { path: 'soccer/fra.1', name: 'Ligue 1', sport: 'football', channels: ['bein_sports', 'ligue_1', 'canal_plus_sport'] },
  { path: 'soccer/uefa.europa', name: 'Europa League', sport: 'football', channels: ['bein_sports', 'tnt_sports'] },
  { path: 'soccer/ksa.1', name: 'Saudi Pro League', sport: 'football', channels: ['ssc_sports', 'tnt_sports'] },
  { path: 'soccer/usa.1', name: 'MLS', sport: 'football', channels: ['mls'] },
  { path: 'basketball/nba', name: 'NBA', sport: 'basketball', channels: ['nba', 'nba_league_pass', 'espn'] },
  { path: 'football/nfl', name: 'NFL', sport: 'americanFootball', channels: ['nfl', 'nfl_redzone', 'dazn'] },
  { path: 'football/college-football', name: 'College Football', sport: 'americanFootball', channels: ['espn', 'sec_network', 'big_ten_network'] },
  { path: 'hockey/nhl', name: 'NHL', sport: 'hockey', channels: ['nhl', 'espn', 'tnt_sports'] },
  { path: 'mma/ufc', name: 'UFC', sport: 'mma', channels: ['ufc', 'tnt_sports'], eventMode: true },
  { path: 'racing/f1', name: 'Formula 1', sport: 'motorsport', channels: ['f1', 'sky_sports'], eventMode: true },
];

export type MatchState = 'upcoming' | 'live' | 'finished';

export interface ScheduleTeam {
  name: string;
  short: string;
  logo?: string;
  score?: string;
}

export interface ScheduleMatch {
  id: string;
  league: string;
  leaguePath: string;
  sport: SportKind;
  name: string;
  /** Epoch millis, local kick-off converted by ESPN's ISO date. */
  start: number;
  state: MatchState;
  status: string;
  home?: ScheduleTeam;
  away?: ScheduleTeam;
  broadcasts: string[];
  venue?: string;
  leagueLogo?: string;
  eventMode: boolean;
}

/** Minimal channel shape used for broadcaster-name resolution. */
export interface ChannelLike {
  id: string;
  name: string;
  keywords?: string[];
}

const BROADCAST_ALIASES: Record<string, string> = {
  nbcsn: 'nbc_sports', peacock: 'nbc_sports', nbc: 'nbc_sports', 'usa net': 'nbc_sports',
  'nhl net': 'nhl', 'nhl network': 'nhl', 'nfl net': 'nfl', 'nfl network': 'nfl', 'nba tv': 'nba',
  'espn+': 'espn_plus', 'espn plus': 'espn_plus', 'espn deportes': 'espn_deportes', espn2: 'espn2', espnu: 'espnu',
  abc: 'espn', espn: 'espn', cbs: 'cbs_sports', cbssn: 'cbs_sports', 'paramount+': 'cbs_sports',
  fox: 'fox_sports', fs1: 'fox_sports', fs2: 'fox_sports', 'fox deportes': 'fox_deportes',
  tnt: 'tnt_sports', trutv: 'tnt_sports', tele: 'telemundo', telemundo: 'telemundo', univision: 'univision',
  tudn: 'tudn', 'apple tv': 'mls', 'mls season pass': 'mls', 'nba league pass': 'nba_league_pass', dazn: 'dazn',
  'f1 tv': 'f1', 'ufc fight pass': 'ufc', 'sec network': 'sec_network', 'acc network': 'acc_network', btn: 'big_ten_network',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function normalizeBroadcastName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ESPN broadcast name → Live TV channel. Unknown names become a one-off
 * channel that still searches portals for the exact name.
 */
export function resolveBroadcast(name: string, catalog: readonly ChannelLike[] = []): ChannelLike {
  const normalised = normalizeBroadcastName(name);
  const alias = BROADCAST_ALIASES[normalised];
  if (alias) {
    const hit = catalog.find((channel) => channel.id === alias);
    if (hit) return hit;
    return { id: alias, name: alias.replace(/_/g, ' ').toUpperCase(), keywords: [alias] };
  }
  let best: ChannelLike | null = null;
  let bestLength = 0;
  for (const channel of catalog) {
    const names = [channel.name, ...(channel.keywords || [])].map(normalizeBroadcastName);
    if (names.includes(normalised)) return channel;
    for (const candidate of names) {
      if (candidate.length >= 4 && candidate.length > bestLength && (normalised.includes(candidate) || candidate.includes(normalised))) {
        best = channel;
        bestLength = candidate.length;
      }
    }
  }
  return best || {
    id: `bc_${normalised}`,
    name,
    keywords: [normalised],
  };
}

/** Every place to watch: ESPN's listings first, then the league's rights holders. */
export function channelsForMatch(match: ScheduleMatch, catalog: readonly ChannelLike[] = []): ChannelLike[] {
  const seen = new Set<string>();
  const out: ChannelLike[] = [];
  for (const broadcast of match.broadcasts) {
    const channel = resolveBroadcast(broadcast, catalog);
    if (channel.id && seen.add(channel.id)) out.push(channel);
  }
  const league = ESPN_LEAGUES.find((item) => item.path === match.leaguePath);
  for (const id of league?.channels || []) {
    if (seen.add(id)) out.push(catalog.find((channel) => channel.id === id) || { id, name: id.replace(/_/g, ' '), keywords: [id] });
  }
  return out;
}

/** Parse one ESPN scoreboard response. Malformed events are skipped, not thrown. */
export function parseEspnScoreboard(raw: unknown, league: ScheduleLeague): ScheduleMatch[] {
  const root = asRecord(raw);
  const events = root && Array.isArray(root.events) ? root.events : [];
  const logos = root && Array.isArray(root.leagues) ? asRecord(root.leagues[0])?.logos : null;
  const leagueLogo = Array.isArray(logos) ? asRecord(logos[0])?.href : undefined;
  const out: ScheduleMatch[] = [];

  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (!event) continue;
    try {
      const competitions = Array.isArray(event.competitions) ? event.competitions.map(asRecord) : [];
      const comp = competitions.find((item): item is Record<string, unknown> => Boolean(item)) || null;
      const statusRaw = asRecord(event.status) || (comp ? asRecord(comp.status) : null);
      const type = asRecord(statusRaw?.type) || {};
      const state: MatchState = type.state === 'in' ? 'live' : type.state === 'post' ? 'finished' : 'upcoming';
      const start = toEpochMs(String(event.date ?? ''));
      const id = String(event.id ?? '').trim();
      if (!id || start === null) continue;

      const parseTeam = (rawCompetitor: unknown): ScheduleTeam | null => {
        const competitor = asRecord(rawCompetitor);
        if (!competitor) return null;
        const team = asRecord(competitor.team) || asRecord(competitor.athlete);
        if (!team) return null;
        const teamLogos = Array.isArray(team.logos) ? asRecord(team.logos[0]) : null;
        const flag = asRecord(team.flag);
        const logo = team.logo || teamLogos?.href || flag?.href;
        return {
          name: String(team.shortDisplayName ?? team.displayName ?? team.name ?? ''),
          short: String(team.abbreviation ?? team.shortDisplayName ?? ''),
          logo: logo ? String(logo) : undefined,
          score: state === 'upcoming' ? undefined : competitor.score == null ? undefined : String(competitor.score),
        };
      };

      const competitors = (Array.isArray(comp?.competitors) ? comp?.competitors : []) as unknown[];
      const home = league.eventMode ? null : competitors.map(parseTeam).find((_, idx) => {
        const c = asRecord(competitors[idx]);
        return c?.homeAway === 'home';
      });
      const away = league.eventMode ? null : competitors.map(parseTeam).find((_, idx) => {
        const c = asRecord(competitors[idx]);
        return c?.homeAway === 'away';
      });

      const broadcasts = new Set<string>();
      for (const rawBroadcast of Array.isArray(comp?.broadcasts) ? comp!.broadcasts : []) {
        const names = asRecord(rawBroadcast)?.names;
        if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name) broadcasts.add(name);
      }
      for (const rawGeo of Array.isArray(comp?.geoBroadcasts) ? comp!.geoBroadcasts : []) {
        const media = asRecord(asRecord(rawGeo)?.media);
        if (typeof media?.shortName === 'string' && media.shortName) broadcasts.add(media.shortName);
      }

      out.push({
        id: `${league.path}/${id}`,
        league: league.name,
        leaguePath: league.path,
        sport: league.sport,
        name: String(event.name ?? event.shortName ?? ''),
        start,
        state,
        status: String(type.shortDetail ?? type.detail ?? ''),
        home: home || undefined,
        away: away || undefined,
        broadcasts: [...broadcasts],
        venue: asRecord(comp?.venue)?.fullName ? String(asRecord(comp!.venue)!.fullName) : undefined,
        eventMode: Boolean(league.eventMode),
        leagueLogo: leagueLogo ? String(leagueLogo) : undefined,
      });
    } catch {
      // One bad event must not lose the rest of the scoreboard.
      continue;
    }
  }
  return dedupeByKey(out, (match) => match.id);
}

/** Keep the first item for each key (first source wins), preserving order. */
export function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items || []) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** A fixture is the same event across sources when name, league and kick-off match. */
export function liveMatchKey(match: Pick<LiveMatchEvent, 'title' | 'league'> & { startsAt?: number }): string {
  const start = Math.round((match.startsAt || 0) / 300) * 300;
  return `${normalizeBroadcastName(match.title)}|${normalizeBroadcastName(match.league)}|${start}`;
}

/** De-dupe the existing LiveMatchesScraper results against one another. */
export function dedupeLiveMatches(matches: readonly LiveMatchEvent[]): LiveMatchEvent[] {
  return dedupeByKey(matches, (match) => liveMatchKey(match) || match.id);
}

export function scheduleMatchToLiveEvent(match: ScheduleMatch): LiveMatchEvent {
  return {
    id: `espn-${match.id}`,
    title: match.name || `${match.home?.name || 'Home'} vs ${match.away?.name || 'Away'}`,
    league: match.league,
    category: match.sport,
    startsAt: Math.floor(match.start / 1000),
    timeLabel: match.state === 'live' ? (match.status || 'LIVE NOW') : match.state === 'finished' ? 'FT' : guideClock(match.start),
    isLive: match.state === 'live',
    homeTeam: match.home ? { name: match.home.name, badge: match.home.logo } : undefined,
    awayTeam: match.away ? { name: match.away.name, badge: match.away.logo } : undefined,
    streamUrl: '',
    poster: match.leagueLogo,
  };
}

function guideClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * ESPN fixtures are merged AFTER the existing LiveMatchesScraper results:
 * Nuvio / Dami / PPV entries keep their playable streams when both carry the
 * same fixture. Uses the 5-minute kick-off bucket to tolerate source jitter.
 */
export function mergeMatchSources(
  existing: readonly LiveMatchEvent[],
  schedule: readonly ScheduleMatch[],
): LiveMatchEvent[] {
  return dedupeLiveMatches([...existing, ...schedule.map(scheduleMatchToLiveEvent)]);
}

// ── Match finder: pick the exact feed from each channel's EPG ─────────────────

const GENERIC_TOKENS = new Set([
  'united', 'city', 'real', 'club', 'sporting', 'athletic', 'atletico', 'inter', 'state', 'university', 'town',
  'county', 'rovers', 'wanderers', 'olympique', 'racing', 'deportivo', 'sport', 'sports', 'team', 'new', 'saint',
]);

/** Accent-insensitive lower-case fold used by VyseTV's match finder. */
export function foldText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function matchTokens(text: string): string[] {
  return foldText(text).split(/\s+/).filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token));
}

function mentionsTeam(text: string, tokens: readonly string[]): boolean {
  const padded = ` ${text} `;
  return tokens.some((token) => (token.length >= 6 ? padded.includes(token) : padded.includes(` ${token} `)));
}

/**
 * Of the guide rows around kick-off, find the one mentioning both sides (or
 * the event name). Window: 30 min before to 2 h 30 after, as in VyseTV.
 */
export function bestEpgMatch(
  match: Pick<ScheduleMatch, 'start' | 'name' | 'league' | 'home' | 'away'>,
  guide: readonly EpgProgram[],
): EpgProgram | null {
  const from = match.start - 30 * 60 * 1000;
  const to = match.start + 2.5 * 60 * 60 * 1000;
  const sides: string[][] = match.home && match.away
    ? [
        [...matchTokens(`${match.home.name} ${match.home.short}`)],
        [...matchTokens(`${match.away.name} ${match.away.short}`)],
      ]
    : [matchTokens(match.name), matchTokens(match.league)];

  let best: EpgProgram | null = null;
  let bestScore = 0;
  for (const entry of guide || []) {
    const start = toEpochMs(entry.start);
    const stop = toEpochMs(entry.stop);
    if (start === null || stop === null || start >= to || stop <= from) continue;
    const text = ` ${foldText(`${entry.title || ''} ${entry.description || ''}`)} `;
    const score = sides.filter((tokens) => tokens.length && mentionsTeam(text, tokens)).length;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/** "beIN SPORTS 2 AR" and "BEIN 2 AR" are the same feed across portals. */
export function hitGroupKey(streamName: string): string {
  const tokens = foldText(streamName).split(/\s+/).filter(Boolean);
  const languages = new Set(['ar', 'uk', 'us', 'ca', 'au', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'br', 'in', 'en', 'tr', 'hi']);
  let number = '';
  let lang = '';
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (!number && /^\d{1,2}$/.test(tokens[i])) number = tokens[i];
    if (!lang && languages.has(tokens[i])) lang = tokens[i].toUpperCase();
    if (number && lang) break;
  }
  return `${number}|${lang}`;
}

/** Group channel hits by feed so one guide lookup covers every portal copy. */
export function groupHits<T>(hits: readonly T[], nameOf: (hit: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const hit of hits || []) {
    const key = hitGroupKey(nameOf(hit));
    const list = groups.get(key);
    if (list) list.push(hit);
    else groups.set(key, [hit]);
  }
  return groups;
}

// ── ESPN network access (nativeFetchText only) ────────────────────────────────

const ESPN_ORIGIN = 'https://site.api.espn.com/apis/site/v2/sports';
const CACHE_TTL_MS = 2 * 60 * 1000;
const scheduleCache = new Map<string, { at: number; matches: ScheduleMatch[] }>();

function ymd(day: Date): string {
  return `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  // Dynamic import keeps the pure helpers free of the native bridge graph.
  const { nativeFetchText } = await import('../androidBridge');
  const response = await nativeFetchText(url, {
    headers: { Accept: 'application/json' },
    timeoutMs,
  });
  if (!response.ok || !response.data) return null;
  try {
    return JSON.parse(response.data) as unknown;
  } catch {
    return null;
  }
}

async function fetchLeague(league: ScheduleLeague, dates: string, timeoutMs: number): Promise<ScheduleMatch[]> {
  const url = `${ESPN_ORIGIN}/${league.path}/scoreboard?dates=${dates}`;
  try {
    let bodies = [await getJson(url, timeoutMs)];
    if (!bodies[0]) {
      // Some leagues only accept a single day: retry the three days separately.
      const [from, to] = dates.split('-');
      const middle = ymd(new Date(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)) + 1));
      bodies = await Promise.all([getJson(`${ESPN_ORIGIN}/${league.path}/scoreboard?dates=${from}`, timeoutMs),
        getJson(`${ESPN_ORIGIN}/${league.path}/scoreboard?dates=${middle}`, timeoutMs),
        getJson(`${ESPN_ORIGIN}/${league.path}/scoreboard?dates=${to}`, timeoutMs)]);
    }
    return bodies.flatMap((body) => (body ? parseEspnScoreboard(body, league) : []));
  } catch {
    return [];
  }
}

/** All leagues' fixtures on `day` (local), soonest first. Cached for two minutes. */
export async function fetchEspnSchedule(
  day: Date = new Date(),
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<ScheduleMatch[]> {
  const key = ymd(day);
  const hit = scheduleCache.get(key);
  if (!options.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.matches;

  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const from = ymd(new Date(start - 24 * 60 * 60 * 1000));
  const to = ymd(new Date(end + 24 * 60 * 60 * 1000));
  const timeoutMs = options.timeoutMs || 15000;
  const results = await Promise.all(ESPN_LEAGUES.map((league) => fetchLeague(league, `${from}-${to}`, timeoutMs)));
  const seen = new Set<string>();
  const matches = results.flat().filter((match) => {
    if (seen.has(match.id)) return false;
    seen.add(match.id);
    // ESPN days are US-centred; include the days either side and filter locally.
    if (match.eventMode) return match.start < end && match.start + 3 * 24 * 60 * 60 * 1000 > start;
    return match.start >= start && match.start < end;
  }).sort((a, b) => a.start - b.start);

  if (matches.length || hit) scheduleCache.set(key, { at: Date.now(), matches });
  // Fallback: a failed/empty API answer keeps the last successful schedule (or
  // an empty list) instead of throwing into the Live TV render path.
  return matches.length ? matches : hit?.matches || [];
}

export function clearEspnScheduleCache(): void {
  scheduleCache.clear();
}
