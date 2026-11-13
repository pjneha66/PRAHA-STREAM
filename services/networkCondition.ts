import { nativeFetchText } from './androidBridge';

/**
 * Network condition probe (port of Nuvio's NetworkStatusRepository):
 * distinguishes "no internet at all" from "internet fine but our servers are
 * unreachable", so empty states can tell the truth instead of a generic error.
 */

export type NetworkCondition = 'online' | 'no-internet' | 'servers-unreachable';

const KNOWN_SERVERS = [
  'https://www.gstatic.com/generate_204',
  'https://cloudflare.com/cdn-cgi/trace',
];

let cachedCondition: { condition: NetworkCondition; ts: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function probeNetworkCondition(): Promise<NetworkCondition> {
  if (cachedCondition && Date.now() - cachedCondition.ts < CACHE_TTL_MS) return cachedCondition.condition;
  const condition = await probeUncached();
  cachedCondition = { condition, ts: Date.now() };
  return condition;
}

async function probeUncached(): Promise<NetworkCondition> {
  // 1. General internet reachability.
  for (const probeUrl of KNOWN_SERVERS) {
    try {
      const response = await nativeFetchText(probeUrl, { method: 'GET', timeoutMs: 4500 });
      if (response.status > 0) return 'online';
    } catch {
      // try next probe host
    }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'no-internet';

  // 2. Internet is up (or unknown) — is it specifically our sources that are down?
  const targets = ['https://api.tmdb.org', 'https://v3-cinemeta.strem.io/manifest.json'];
  for (const target of targets) {
    try {
      const response = await nativeFetchText(target, { method: 'GET', timeoutMs: 5000 });
      if (response.status > 0) return 'servers-unreachable';
    } catch {
      // keep probing
    }
  }
  return navigator.onLine === false ? 'no-internet' : 'servers-unreachable';
}

export const NETWORK_CONDITION_COPY: Record<NetworkCondition, { title: string; message: string }> = {
  online: { title: 'Sources did not answer', message: 'The sources are not responding right now. Retry in a moment.' },
  'no-internet': { title: 'You are offline', message: 'The device has no internet connection. Reconnect and try again.' },
  'servers-unreachable': {
    title: 'Cannot reach PRAHA sources',
    message: 'Internet looks fine, but the catalog sources are unreachable — a network filter or DNS block may be in the way. The AdGuard DNS toggle in Settings can help.',
  },
};
