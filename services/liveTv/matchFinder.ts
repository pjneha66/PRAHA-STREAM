// Works out which exact feed is showing a fixture.
//
// Ported line for line from VyseTV `lib/data/live_tv/match_finder.dart`
// (GPL-3.0-or-later). Each feed's TV guide is read around kick-off and searched
// for the teams, so the match page can say "beIN Sports 2 · AR" instead of just
// "beIN Sports". Feeds are grouped by number + language, so the same feed on ten
// portals costs one guide lookup (a couple more if the first portal has no guide).

import type { ChannelHit } from './models';
import type { EpgProgram } from './guide';
import { toEpochMs } from './guide';
import { hitTagKey, hitTagsOf } from './hitTags';

/** What the match finder needs to know about a fixture. */
export interface FinderMatch {
  id: string;
  start: number;
  name: string;
  league: string;
  home?: { name: string; short?: string };
  away?: { name: string; short?: string };
}

const GENERIC = new Set([
  'united', 'city', 'real', 'club', 'sporting', 'athletic', 'atletico', 'inter', 'state', 'university', 'town',
  'county', 'rovers', 'wanderers', 'olympique', 'racing', 'deportivo', 'sport', 'sports', 'team', 'new', 'saint',
]);

const ACCENTS = 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ';
const PLAIN = 'aaaaaaceeeeiiiinooooouuuuyy';

export function finderFold(text: string): string {
  let out = '';
  for (const char of String(text || '').toLowerCase()) {
    const index = ACCENTS.indexOf(char);
    out += index < 0 ? char : PLAIN[index];
  }
  return out.replace(/[^a-z0-9]+/g, ' ');
}

export function finderTokens(text: string): string[] {
  return finderFold(text).split(' ').filter((token) => token.length >= 4 && !GENERIC.has(token));
}

function mentions(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => (token.length >= 6 ? text.includes(token) : text.includes(` ${token} `)));
}

/** The guide entry that mentions both sides inside the kick-off window. */
export function bestFinderEntry(match: FinderMatch, guide: readonly EpgProgram[]): EpgProgram | null {
  const from = match.start - 30 * 60 * 1000;
  const to = match.start + 150 * 60 * 1000;
  const sides: string[][] = match.home && match.away
    ? [
        [...new Set([...finderTokens(match.home.name), ...finderTokens(match.home.short || '')])],
        [...new Set([...finderTokens(match.away.name), ...finderTokens(match.away.short || '')])],
      ]
    : [finderTokens(match.name), finderTokens(match.league)];

  let best: EpgProgram | null = null;
  let bestScore = 0;
  for (const entry of guide || []) {
    const start = toEpochMs(entry.start);
    const stop = toEpochMs(entry.stop);
    if (start === null || stop === null || start >= to || stop <= from) continue;
    const text = ` ${finderFold(`${entry.title || ''} ${entry.description || ''}`)} `;
    const score = sides.filter((tokens) => tokens.length > 0 && mentions(text, tokens)).length;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

type EpgProvider = (hit: ChannelHit) => Promise<EpgProgram[]>;

/**
 * One fixture × one built-in channel. Call `update()` with the latest hits; the
 * finder keeps five guide lookups in flight and publishes labels to `found`.
 */
export class MatchFinder {
  /**
   * Every exact feed spotted so far, per match and channel:
   * `matchId → channelId → labels`. Cards read this to name the feed.
   */
  static found: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map();

  private static listeners = new Set<() => void>();

  static subscribe(listener: () => void): () => void {
    MatchFinder.listeners.add(listener);
    return () => { MatchFinder.listeners.delete(listener); };
  }

  private static emit(): void {
    for (const listener of [...MatchFinder.listeners]) listener();
  }

  static keyOf(name: string): string {
    return hitTagKey(hitTagsOf(name));
  }

  private readonly groups = new Map<string, ChannelHit[]>();
  private readonly results = new Map<string, EpgProgram | null>();
  private readonly tries = new Map<string, number>();
  private readonly queue: string[] = [];
  private active = 0;
  private disposed = false;

  constructor(
    private readonly match: FinderMatch,
    private readonly channel: { id: string; name: string },
    private readonly epg: EpgProvider,
  ) {}

  get busy(): boolean { return this.active > 0 || this.queue.length > 0; }
  get checked(): number { return this.results.size; }
  get total(): number { return this.groups.size; }

  /** Guide entry showing the match on this feed, if one was found. */
  entryFor(hit: ChannelHit): EpgProgram | null {
    return this.results.get(MatchFinder.keyOf(hit.stream.name)) ?? null;
  }

  /** Groups that show the match, best first. */
  get hits(): { key: string; label: string; entry: EpgProgram }[] {
    const out: { key: string; label: string; entry: EpgProgram }[] = [];
    for (const [key, entry] of this.results) {
      if (entry) out.push({ key, label: this.labelFor(key), entry });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  labelFor(key: string): string {
    const [number, lang] = key.split('|');
    return [
      this.channel.name,
      number ? ` ${number}` : '',
      lang ? `  ·  ${lang}` : '',
    ].join('');
  }

  /** Feed in the latest results. Never notifies synchronously, so it is safe from a listener. */
  update(all: readonly ChannelHit[]): void {
    for (const hit of all) {
      const key = MatchFinder.keyOf(hit.stream.name);
      const group = this.groups.get(key) ?? [];
      if (!group.some((entry) => entry.streamUrl === hit.streamUrl)) group.push(hit);
      this.groups.set(key, group);
      if (!this.results.has(key) && !this.queue.includes(key) && (this.tries.get(key) ?? 0) === 0) {
        this.queue.push(key);
      }
    }
    this.pump();
  }

  private pump(): void {
    while (this.active < 5 && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const attempt = this.tries.get(key) ?? 0;
      const group = this.groups.get(key)!;
      if (attempt >= group.length || attempt >= 3) {
        this.results.set(key, null);
        continue;
      }
      this.tries.set(key, attempt + 1);
      this.active += 1;
      const hit = group[attempt];
      const settle = (list: EpgProgram[] | null) => {
        if (!list || !list.length) {
          this.queue.push(key); // no guide on this portal: try the same feed elsewhere
        } else {
          this.results.set(key, bestFinderEntry(this.match, list));
          if (this.results.get(key)) this.publish();
        }
      };
      const timeout = new Promise<EpgProgram[] | null>((resolve) => {
        setTimeout(() => resolve(null), 15000);
      });
      Promise.race([this.epg(hit).catch(() => null), timeout])
        .then((list) => settle(list))
        .finally(() => {
          this.active -= 1;
          if (this.disposed) return;
          MatchFinder.emit();
          this.pump();
        });
    }
  }

  private publish(): void {
    const all = new Map(MatchFinder.found);
    const forMatch = new Map(all.get(this.match.id) ?? []);
    forMatch.set(this.channel.id, this.hits.map((hit) => hit.label));
    all.set(this.match.id, forMatch);
    MatchFinder.found = all;
    MatchFinder.emit();
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Tests: forget every feed spotted. */
  static debugReset(): void {
    MatchFinder.found = new Map();
    MatchFinder.listeners.clear();
  }
}
