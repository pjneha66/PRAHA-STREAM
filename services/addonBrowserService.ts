import type { DirectoryAddon, DirectoryAddonPage } from '../types';

/**
 * Client for the public, CORS-enabled directory API of stremio-addons.net.
 * Docs: https://docs.stremio-addons.net/developers/api
 *
 * Attribution: data comes from stremio-addons.net and the UI links back to it.
 */
export const DIRECTORY_SITE = 'https://stremio-addons.net';
const API_BASE = `${DIRECTORY_SITE}/api/v0`;

const timeoutFetch = async (url: string, timeout = 15000) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } finally {
    window.clearTimeout(timer);
  }
};

const networkMessage = (error: unknown) => {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'stremio-addons.net took too long to respond. Try again.';
  }
  if (error instanceof TypeError) {
    return 'The addon directory could not be reached. Check your connection — the request may also be blocked by browser CORS settings.';
  }
  return error instanceof Error ? error.message : 'The addon directory could not be loaded.';
};

interface RawDirectoryAddon {
  uuid?: string;
  slug?: string;
  url?: string;
  manifestUrl?: string;
  stars?: number;
  categories?: Array<{ name?: string; slug?: string }>;
  configureUrl?: string | null;
  updatedAt?: string;
  manifest?: {
    name?: string;
    description?: string;
    logo?: string;
    version?: string;
    types?: string[];
  };
}

const httpImage = (value?: string) => (value && /^https?:\/\//i.test(value) ? value : undefined);

const normalizeAddon = (raw: RawDirectoryAddon): DirectoryAddon => ({
  uuid: String(raw.uuid || raw.slug || ''),
  slug: String(raw.slug || ''),
  name: raw.manifest?.name || raw.slug || 'Unknown addon',
  description: raw.manifest?.description || '',
  logo: httpImage(raw.manifest?.logo),
  version: raw.manifest?.version || '',
  types: Array.isArray(raw.manifest?.types) ? raw.manifest.types : [],
  stars: Number(raw.stars) || 0,
  categories: (raw.categories || [])
    .filter((category) => category && category.name && category.slug)
    .map((category) => ({ name: String(category.name), slug: String(category.slug) })),
  manifestUrl: String(raw.manifestUrl || ''),
  siteUrl: raw.url || `${DIRECTORY_SITE}/addons/${raw.slug || ''}`,
  configureUrl: raw.configureUrl || undefined,
  updatedAt: raw.updatedAt,
});

export interface DirectoryQuery {
  search?: string;
  categories?: string[];
  sortBy?: 'stars' | 'createdAt';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
  nsfw?: 'include' | 'exclude';
}

export async function fetchDirectoryAddons(query: DirectoryQuery = {}): Promise<DirectoryAddonPage> {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  if (search) params.set('search', search);
  (query.categories || []).forEach((category) => params.append('category', category));
  params.set('sort_by', query.sortBy || 'stars');
  params.set('order', query.order || 'desc');
  params.set('page', String(Math.max(1, query.page || 1)));
  params.set('limit', String(Math.min(100, Math.max(1, query.limit || 24))));
  if (query.nsfw) params.set('nsfw', query.nsfw);

  let response: Response;
  try {
    response = await timeoutFetch(`${API_BASE}/addons?${params.toString()}`);
  } catch (error) {
    throw new Error(networkMessage(error));
  }
  if (!response.ok) {
    throw new Error(response.status === 429
      ? 'The addon directory is rate limiting requests. Wait a moment and try again.'
      : `The addon directory returned HTTP ${response.status}.`);
  }
  const data = await response.json() as {
    addons?: RawDirectoryAddon[];
    pagination?: Partial<DirectoryAddonPage['pagination']>;
  };
  const pagination = data.pagination || {};
  return {
    addons: (data.addons || []).map(normalizeAddon).filter((addon) => addon.manifestUrl),
    pagination: {
      page: pagination.page || query.page || 1,
      limit: pagination.limit || query.limit || 24,
      total: pagination.total || 0,
      totalPages: pagination.totalPages || 0,
      hasNextPage: Boolean(pagination.hasNextPage),
      hasPreviousPage: Boolean(pagination.hasPreviousPage),
    },
  };
}

export async function fetchDirectoryCategories(): Promise<Array<{ name: string; slug: string }>> {
  let response: Response;
  try {
    response = await timeoutFetch(`${API_BASE}/categories`);
  } catch (error) {
    throw new Error(networkMessage(error));
  }
  if (!response.ok) throw new Error(`The addon directory returned HTTP ${response.status}.`);
  const data = await response.json() as { categories?: Array<{ name?: string; slug?: string }> };
  return (data.categories || [])
    .filter((category) => category && category.name && category.slug)
    .map((category) => ({ name: String(category.name), slug: String(category.slug) }));
}
