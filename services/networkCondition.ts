import { nativeFetchText } from './androidBridge';

/**
 * Network condition probe (port of Nuvio's NetworkStatusRepository):
 * distinguishes "no internet at all" from "internet fine but our servers are
 * unreachable", so empty states can tell the truth instead of a generic error.
 */

export type NetworkCondition = 'online' | 'no-internet' | 'servers-unreachable' | 'network-unverified';

const KNOWN_SERVERS = [
  'https://www.gstatic.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
];

let cachedCondition: { condition: NetworkCondition; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function probeNetworkCondition({ fresh = false } = {}): Promise<NetworkCondition> {
  if (!fresh && cachedCondition && Date.now() - cachedCondition.ts < CACHE_TTL_MS) return cachedCondition.condition;
  const condition = await probeUncached();
  cachedCondition = { condition, ts: Date.now() };
  return condition;
}

async function probeUncached(): Promise<NetworkCondition> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'no-internet';

  const catalogChecks = [
    { url: 'https://v3-cinemeta.strem.io/manifest.json', matches: (body: Record<string, unknown>, status: number) => status === 200 && body.id === 'com.linvo.cinemeta' },
    // TMDB returns its invalid-key JSON when probed without an API key.
    { url: 'https://api.tmdb.org/3/configuration', matches: (body: Record<string, unknown>, status: number) => status === 401 && body.status_code === 7 },
  ];
  const catalogResults = await Promise.all(catalogChecks.map(async ({ url, matches }) => {
    try {
      const response = await nativeFetchText(url, { timeoutMs: 4500 });
      return matches(JSON.parse(response.data), response.status);
    } catch {
      return false;
    }
  }));
  if (catalogResults.some(Boolean)) return 'online';

  const internetResults = await Promise.all(KNOWN_SERVERS.map(async (url) => {
    try {
      const response = await nativeFetchText(url, { timeoutMs: 4500 });
      return url.endsWith('/generate_204') ? response.status === 204 : response.ok && /^fl=/m.test(response.data);
    } catch {
      return false;
    }
  }));
  if (internetResults.some(Boolean)) return 'servers-unreachable';
  return 'network-unverified';
}

export const NETWORK_CONDITION_COPY: Record<NetworkCondition, { title: string; message: string }> = {
  online: { title: 'Catalog service reachable', message: 'At least one catalog service responded.' },
  'no-internet': { title: 'You are offline', message: 'The device has no internet connection. Reconnect and try again.' },
  'servers-unreachable': {
    title: 'Cannot reach PRAHA sources',
    message: 'The internet check passed, but neither catalog service answered as expected.',
  },
  'network-unverified': {
    title: 'Connection could not be verified',
    message: 'The catalog and internet checks did not pass. Check your connection and try again.',
  },
};
