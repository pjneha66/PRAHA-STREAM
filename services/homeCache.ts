import type { HomeCatalog } from '../types';

export const HOME_CACHE_KEY = 'praha.v2.home-cache';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const KEYS = ['hero', 'trending', 'movies', 'series', 'topRated'] as const;

export function readHomeCache(storage: Pick<Storage, 'getItem'>, now = Date.now()): HomeCatalog | null {
  try {
    const value = JSON.parse(storage.getItem(HOME_CACHE_KEY) || 'null');
    if (!value || !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt > MAX_AGE) return null;
    if (!KEYS.every((key) => Array.isArray(value.catalog?.[key]) && value.catalog[key].every((item: any) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.poster === 'string' && Array.isArray(item.genres)))) return null;
    return value.catalog as HomeCatalog;
  } catch { return null; }
}

export function writeHomeCache(storage: Pick<Storage, 'setItem'>, catalog: HomeCatalog, now = Date.now()): void {
  if (!KEYS.some((key) => catalog[key].length)) return;
  try { storage.setItem(HOME_CACHE_KEY, JSON.stringify({ savedAt: now, catalog })); } catch { /* Cache is optional. */ }
}

export const HOME_ROWS = ['continue', 'trending', 'movies', 'series', 'topRated'] as const;
export type HomeRowId = typeof HOME_ROWS[number];
export type HomeRowSettings = { order: HomeRowId[]; hidden: HomeRowId[] };
export const DEFAULT_HOME_ROWS: HomeRowSettings = { order: [...HOME_ROWS], hidden: [] };
export function normalizeHomeRows(value: unknown): HomeRowSettings {
  const input = value && typeof value === 'object' ? value as Partial<HomeRowSettings> : {};
  const valid = (row: unknown): row is HomeRowId => typeof row === 'string' && HOME_ROWS.includes(row as HomeRowId);
  const order = Array.isArray(input.order) ? input.order.filter(valid) : [];
  return { order: [...new Set([...order, ...HOME_ROWS])], hidden: Array.isArray(input.hidden) ? [...new Set(input.hidden.filter(valid))] : [] };
}
