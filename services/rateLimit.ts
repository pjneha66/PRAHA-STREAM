/**
 * Global rate-limit coordinator (port of Nuvio's BackendRateLimit plugin):
 * when a host answers 429, every request to that host short-circuits until
 * the Retry-After window passes (jittered, capped), so hammering a struggling
 * addon/mirror never makes things worse.
 */

const DEFAULT_COOLDOWN_MS = 1000;
const MAX_COOLDOWN_MS = 30_000;

const hostCooldowns = new Map<string, number>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Called by the fetch layer when a host answers 429. */
export function noteRateLimited(url: string, retryAfterHeader?: string): void {
  const host = hostOf(url);
  let cooldown = DEFAULT_COOLDOWN_MS;
  const parsed = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
  if (Number.isFinite(parsed)) cooldown = Math.min(parsed * 1000, MAX_COOLDOWN_MS);
  // Jitter ±20% so parallel callers don't stampede on the same wake-up.
  cooldown = Math.round(cooldown * (0.8 + Math.random() * 0.4));
  const until = Date.now() + Math.min(cooldown, MAX_COOLDOWN_MS);
  const existing = hostCooldowns.get(host) || 0;
  if (until > existing) hostCooldowns.set(host, until);
}

/** True when the host is still inside a 429 cooldown window. */
export function isRateLimited(url: string): boolean {
  const host = hostOf(url);
  const until = hostCooldowns.get(host);
  if (!until) return false;
  if (Date.now() >= until) {
    hostCooldowns.delete(host);
    return false;
  }
  return true;
}

/** Seconds remaining in cooldown (for UI hints). */
export function cooldownSecondsRemaining(url: string): number {
  const until = hostCooldowns.get(hostOf(url)) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
