// Live TV appearance settings persistence.
//
// Ported from VyseTV `lib/services/iptv/iptv_settings.dart`
// (GPL-3.0-or-later): hero style, card density, portal/browser presentation and
// the ordered category visibility list. PRAHA's global theme is untouched —
// these values only style Live TV cards once a later phase wires them in.

export type HeroStyle = 'immersive' | 'compact' | 'minimalist';
export type CardDensity = 'compact' | 'standard' | 'cinematic';
export type PortalCardStyle = 'rich' | 'compact';
export type PortalBrowserLayout = 'grid' | 'list' | 'compactList';

export interface LiveTvAppearance {
  enableSpotlight: boolean;
  heroStyle: HeroStyle;
  heroAutoRotate: boolean;
  heroRotateSeconds: number;
  cardDensity: CardDensity;
  cardHoverZoom: number;
  showHdBadge: boolean;
  showCategoryTag: boolean;
  enableAmbientLights: boolean;
  visibleCategories: string[];
  portalCardStyle: PortalCardStyle;
  showPortalExpiry: boolean;
  showPortalConnections: boolean;
  defaultPortalTab: number;
  browserLayout: PortalBrowserLayout;
  browserGridColumns: number;
  showStreamLogos: boolean;
  showEpgSnippet: boolean;
  showCategoryCount: boolean;
  sidebarWidth: number;
}

const STORAGE_KEY = 'praha.livetv.appearance.v1';

export const LIVE_TV_DEFAULT_CATEGORIES: readonly string[] = [
  'Premier Live Broadcasts',
  'ESPN & College Basketball (NCAA)',
  'US Major Leagues & Sports',
  'Global Football & Soccer',
  'Combat & Martial Arts',
  'Motorsport & Racing',
  'Movies & Premium Networks',
  '24/7 Global News Networks',
  'Arabic & Regional Hub',
  'Discovery & Documentaries',
  'Kids & Family',
  'US Region',
  'UK Region',
  'Canada Region',
  'Bay Area',
  'International Sports',
];

export const DEFAULT_LIVE_TV_APPEARANCE: Readonly<LiveTvAppearance> = Object.freeze({
  enableSpotlight: true,
  heroStyle: 'immersive',
  heroAutoRotate: true,
  heroRotateSeconds: 7,
  cardDensity: 'standard',
  cardHoverZoom: 1.06,
  showHdBadge: true,
  showCategoryTag: true,
  enableAmbientLights: true,
  visibleCategories: [...LIVE_TV_DEFAULT_CATEGORIES],
  portalCardStyle: 'rich',
  showPortalExpiry: true,
  showPortalConnections: true,
  defaultPortalTab: 0,
  browserLayout: 'grid',
  browserGridColumns: 4,
  showStreamLogos: true,
  showEpgSnippet: true,
  showCategoryCount: true,
  sidebarWidth: 260,
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Sanitise any persisted value: unknown enum strings and bad numbers fall back. */
export function normalizeLiveTvAppearance(value: unknown): LiveTvAppearance {
  const raw = record(value) || {};
  const categories = Array.isArray(raw.visibleCategories)
    ? raw.visibleCategories.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : null;
  // VyseTV merges defaults into a saved list so newly added categories appear.
  const visibleCategories = categories
    ? [...new Set([...categories, ...LIVE_TV_DEFAULT_CATEGORIES])]
    : [...LIVE_TV_DEFAULT_CATEGORIES];
  return {
    enableSpotlight: bool(raw.enableSpotlight, DEFAULT_LIVE_TV_APPEARANCE.enableSpotlight),
    heroStyle: oneOf(raw.heroStyle, ['immersive', 'compact', 'minimalist'] as const, DEFAULT_LIVE_TV_APPEARANCE.heroStyle),
    heroAutoRotate: bool(raw.heroAutoRotate, DEFAULT_LIVE_TV_APPEARANCE.heroAutoRotate),
    heroRotateSeconds: numberIn(raw.heroRotateSeconds, 3, 60, DEFAULT_LIVE_TV_APPEARANCE.heroRotateSeconds),
    cardDensity: oneOf(raw.cardDensity, ['compact', 'standard', 'cinematic'] as const, DEFAULT_LIVE_TV_APPEARANCE.cardDensity),
    cardHoverZoom: numberIn(raw.cardHoverZoom, 1, 1.5, DEFAULT_LIVE_TV_APPEARANCE.cardHoverZoom),
    showHdBadge: bool(raw.showHdBadge, DEFAULT_LIVE_TV_APPEARANCE.showHdBadge),
    showCategoryTag: bool(raw.showCategoryTag, DEFAULT_LIVE_TV_APPEARANCE.showCategoryTag),
    enableAmbientLights: bool(raw.enableAmbientLights, DEFAULT_LIVE_TV_APPEARANCE.enableAmbientLights),
    visibleCategories,
    portalCardStyle: oneOf(raw.portalCardStyle, ['rich', 'compact'] as const, DEFAULT_LIVE_TV_APPEARANCE.portalCardStyle),
    showPortalExpiry: bool(raw.showPortalExpiry, DEFAULT_LIVE_TV_APPEARANCE.showPortalExpiry),
    showPortalConnections: bool(raw.showPortalConnections, DEFAULT_LIVE_TV_APPEARANCE.showPortalConnections),
    defaultPortalTab: numberIn(raw.defaultPortalTab, 0, 3, DEFAULT_LIVE_TV_APPEARANCE.defaultPortalTab),
    browserLayout: oneOf(raw.browserLayout, ['grid', 'list', 'compactList'] as const, DEFAULT_LIVE_TV_APPEARANCE.browserLayout),
    browserGridColumns: Math.round(numberIn(raw.browserGridColumns, 1, 8, DEFAULT_LIVE_TV_APPEARANCE.browserGridColumns)),
    showStreamLogos: bool(raw.showStreamLogos, DEFAULT_LIVE_TV_APPEARANCE.showStreamLogos),
    showEpgSnippet: bool(raw.showEpgSnippet, DEFAULT_LIVE_TV_APPEARANCE.showEpgSnippet),
    showCategoryCount: bool(raw.showCategoryCount, DEFAULT_LIVE_TV_APPEARANCE.showCategoryCount),
    sidebarWidth: numberIn(raw.sidebarWidth, 160, 480, DEFAULT_LIVE_TV_APPEARANCE.sidebarWidth),
  };
}

export function loadLiveTvAppearance(): LiveTvAppearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeLiveTvAppearance(JSON.parse(raw) as unknown) : normalizeLiveTvAppearance(null);
  } catch {
    return normalizeLiveTvAppearance(null);
  }
}

export function saveLiveTvAppearance(value: LiveTvAppearance): LiveTvAppearance {
  const normalised = normalizeLiveTvAppearance(value);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalised));
  } catch {
    // Private browsing / quota: keep the value for the current session only.
  }
  return normalised;
}

export function updateLiveTvAppearance(patch: Partial<LiveTvAppearance>): LiveTvAppearance {
  return saveLiveTvAppearance({ ...loadLiveTvAppearance(), ...patch });
}

export function resetLiveTvAppearance(): LiveTvAppearance {
  return saveLiveTvAppearance(normalizeLiveTvAppearance(null));
}

/** Toggle one category; never remove the last visible one. */
export function toggleVisibleCategory(category: string): string[] {
  const current = loadLiveTvAppearance();
  const next = current.visibleCategories.includes(category)
    ? current.visibleCategories.length > 1
      ? current.visibleCategories.filter((item) => item !== category)
      : [...current.visibleCategories]
    : [...current.visibleCategories, category];
  saveLiveTvAppearance({ ...current, visibleCategories: next });
  return next;
}

/** Reorder a category, honouring Flutter's index adjustment when moving down. */
export function reorderVisibleCategory(from: number, to: number): string[] {
  const current = loadLiveTvAppearance();
  const list = [...current.visibleCategories];
  if (from < 0 || from >= list.length) return list;
  const target = from < to ? to - 1 : to;
  if (target < 0 || target >= list.length) return list;
  const [item] = list.splice(from, 1);
  list.splice(target, 0, item);
  saveLiveTvAppearance({ ...current, visibleCategories: list });
  return list;
}
