import type { AppSettings, NsfwMode, UserProfile } from '../types';

/**
 * Adult content gate.
 *
 * One saved setting (`AppSettings.nsfw`) drives every surface that can return
 * adult material. It is deliberately boring: no network, no storage of its own,
 * just a pure function of the saved setting plus the active profile. That keeps
 * it testable, and it means a Kids profile cannot be talked into adult results
 * by a stale flag somewhere in storage.
 *
 * The three modes mirror VyseTV's `AdultFilter { hide, include, only }`
 * (lib/data/anime/anilist.dart:164) so both sets of sources behave the same way.
 */

/** True when adult results may be requested at all. */
export function allowsAdult(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): boolean {
  // A Kids profile overrides the saved setting, always. This is the one rule that
  // must not depend on anything else being correct.
  if (profile?.isKids) return false;
  return (settings.nsfw || 'off') !== 'off';
}

/** True when ONLY adult results should come back (the "only" mode). */
export function adultOnly(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): boolean {
  if (profile?.isKids) return false;
  return settings.nsfw === 'only';
}

/** The active mode, with the Kids-profile override applied. */
export function effectiveNsfwMode(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): NsfwMode {
  if (profile?.isKids) return 'off';
  const mode = settings.nsfw;
  return mode === 'on' || mode === 'only' ? mode : 'off';
}

/**
 * The value WeebCentral's `adult` query parameter takes.
 *
 * The capitalised spelling is load-bearing: the site rejects the lowercase
 * `adult=false` with a 307 to /400, which looks exactly like a bot block. See
 * VyseTV's manga_service.dart:53 (`allowAdult ? 'Any' : 'False'`).
 */
export function weebCentralAdultParam(mode: NsfwMode): 'False' | 'Any' | 'Only' {
  if (mode === 'only') return 'Only';
  if (mode === 'on') return 'Any';
  return 'False';
}

/** TMDB's `include_adult` flag. TMDB only has a boolean, so "only" behaves like "on". */
export function tmdbIncludeAdult(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): boolean {
  return allowsAdult(settings, profile);
}

/**
 * AniList's `isAdult` filter, matching their own enum names.
 * `only` means "adult titles and nothing else", which AniList has no direct
 * filter for — callers pair `isAdult: true` with the adult-genre exclusion list.
 */
export function anilistAdultFilter(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): 'hide' | 'include' | 'only' {
  const mode = effectiveNsfwMode(settings, profile);
  if (mode === 'only') return 'only';
  if (mode === 'on') return 'include';
  return 'hide';
}

/**
 * Live TV channels are matched by name/group rather than by a provider flag, so
 * this is a text heuristic — the same one PRAHA already used for iptv-org
 * community playlists (services/iptvService.ts:1676).
 *
 * Note the `18+` branch has no trailing `\b`: `+` is not a word character, so a
 * boundary can never follow it and the old `\b18\+\b` never matched anything.
 */
const ADULT_CHANNEL_RE = /(xxx|porn|adult|\b18\+|erotic|\bsex\b)/i;

export function isAdultChannelName(group: string | undefined, name: string): boolean {
  return ADULT_CHANNEL_RE.test(`${group || ''} ${name}`);
}

/** Filter a channel list according to the current mode. */
export function filterChannelsForNsfw<T extends { group?: string; name: string }>(
  channels: T[],
  settings: Pick<AppSettings, 'nsfw'>,
  profile?: Pick<UserProfile, 'isKids'> | null,
): T[] {
  const mode = effectiveNsfwMode(settings, profile);
  if (mode === 'on') return channels; // mixed in: nothing to strip
  if (mode === 'only') return channels.filter((c) => isAdultChannelName(c.group, c.name));
  return channels.filter((c) => !isAdultChannelName(c.group, c.name));
}

/**
 * Runtime holder for the active mode.
 *
 * Services (manga, TMDB, IPTV) are static classes deep in the call tree, so
 * threading `settings` down to each of them would touch dozens of signatures for
 * no benefit. App.tsx pushes the current values in whenever they change; every
 * reader falls back to `'off'` until it does, which is the safe default.
 */
let activeMode: NsfwMode = 'off';

export function setNsfwContext(settings: Pick<AppSettings, 'nsfw'>, profile?: Pick<UserProfile, 'isKids'> | null): NsfwMode {
  activeMode = effectiveNsfwMode(settings, profile);
  return activeMode;
}

/** The mode every service should honour right now. */
export function currentNsfwMode(): NsfwMode {
  return activeMode;
}

/** True when adult results may be requested right now. */
export function currentAllowsAdult(): boolean {
  return activeMode !== 'off';
}

/** The WeebCentral `adult` value for the active mode. */
export function currentWeebCentralAdultParam(): 'False' | 'Any' | 'Only' {
  return weebCentralAdultParam(activeMode);
}

/** Copy for the settings card, kept here so the UI and the tests agree. */
export const NSFW_COPY = {
  title: 'Adult content',
  blurb: 'Manga, comics, anime, Live TV and titles marked adult. Off by default.',
  modes: [
    { id: 'off', label: 'Off', hint: 'Nothing adult, anywhere.' },
    { id: 'on', label: 'On', hint: 'Adult results mixed in with everything else.' },
    { id: 'only', label: 'Only adult', hint: 'Adult results only.' },
  ] as const,
  kidsNote: 'Not available on a Kids profile.',
  confirmTitle: 'Adult content (18+)',
  confirmBody:
    'This shows hentai and other titles marked adult, including explicit cover art. Only turn it on if you are 18 or older.',
  confirmAccept: "I'm 18 or older",
  confirmCancel: 'Cancel',
} as const;
