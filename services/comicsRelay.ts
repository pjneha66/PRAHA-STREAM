const DEFAULT_RELAY = 'https://praha-stream-relay.vercel.app';

export const usesHostedComicsRelay = !import.meta.env.DEV && import.meta.env.MODE !== 'test';

export function comicsRelayUrl(path: string, forceHosted = false): string {
  if (!usesHostedComicsRelay && !forceHosted) return path;
  const request = new URL(path, DEFAULT_RELAY);
  const relay = new URL('/api/relay', import.meta.env.VITE_COMICS_RELAY_URL || DEFAULT_RELAY);
  relay.search = request.search;
  relay.searchParams.set('route', request.pathname);
  return relay.href;
}
