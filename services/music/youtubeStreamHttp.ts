// Stream HTTP helpers: the User-Agent a googlevideo CDN URL expects, and the
// headers it must be fetched with.
//
// Ported from VyseTV `lib/services/music/youtube_stream_http.dart`
// (GPL-3.0-or-later). Behaviour is kept identical, including the `c` query
// parameter → client mapping: a googlevideo URL carries the client it was
// minted for, and requesting it with any other User-Agent gets a 403.

import { nativeFetchText } from '../androidBridge';

export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export const ANDROID_USER_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

export const ANDROID_VR_USER_AGENT =
  'com.google.android.apps.youtube.vr.oculus/1.60.19 '
  + '(Linux; U; Android 14; en_US; Quest 3; Build/UQ1A.240105.004) gzip';

export const IOS_USER_AGENT = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

export const MOBILE_WEB_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36';

export const TV_USER_AGENT = DESKTOP_USER_AGENT;

export const TV_EMBEDDED_USER_AGENT =
  'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

/** True for youtube.com and every googlevideo.com subdomain. */
export function isYoutubeCdnUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return (
    host === 'googlevideo.com'
    || host.endsWith('.googlevideo.com')
    || host === 'youtube.com'
    || host.endsWith('.youtube.com')
  );
}

/**
 * The `c` query parameter names the client the URL was signed for. An explicit
 * preferred agent always wins, exactly as the Dart does.
 */
export function userAgentForUrl(url: string, preferredUserAgent?: string | null): string {
  if (preferredUserAgent) return preferredUserAgent;

  let client = '';
  try {
    client = (new URL(url).searchParams.get('c') ?? '').toUpperCase();
  } catch {
    client = '';
  }

  switch (client) {
    case 'ANDROID_VR':
      return ANDROID_VR_USER_AGENT;
    case 'ANDROID':
    case 'ANDROID_MUSIC':
      return ANDROID_USER_AGENT;
    case 'IOS':
      return IOS_USER_AGENT;
    case 'MWEB':
      return MOBILE_WEB_USER_AGENT;
    case 'TVHTML5_SIMPLY_EMBEDDED_PLAYER':
      return TV_EMBEDDED_USER_AGENT;
    case 'TVHTML5':
      return TV_USER_AGENT;
    default:
      return DESKTOP_USER_AGENT;
  }
}

/**
 * Headers a googlevideo request needs. `WEB`-client URLs additionally require
 * an Origin/Referer pair or the CDN answers 403.
 */
export function streamHeaders(url: string, options: { userAgent?: string | null; range?: string } = {}): Record<string, string> {
  const resolvedUserAgent = userAgentForUrl(url, options.userAgent);
  const headers: Record<string, string> = {
    'User-Agent': resolvedUserAgent,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (options.range) headers.Range = options.range;

  let client = '';
  try {
    client = (new URL(url).searchParams.get('c') ?? '').toUpperCase();
  } catch {
    client = '';
  }
  if (client === 'WEB') {
    headers.Origin = 'https://www.youtube.com';
    headers.Referer = 'https://www.youtube.com/';
  }
  return headers;
}

/** Range-GETs the first kilobyte. Port of `YoutubeStreamHttp.probe`. */
export async function probeStream(
  url: string,
  options: { userAgent?: string | null; timeoutMs?: number } = {},
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.protocol || !parsed.hostname) return false;

  try {
    const response = await nativeFetchText(url, {
      method: 'GET',
      headers: streamHeaders(url, { userAgent: options.userAgent, range: 'bytes=0-1023' }),
      timeoutMs: options.timeoutMs ?? 8000,
    });
    const status = response.status;
    return (status >= 200 && status < 300) || status === 302 || status === 307;
  } catch {
    return false;
  }
}
