import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { StreamResult } from '../types';
import { isRateLimited, noteRateLimited } from './rateLimit';

export interface NativeAudioTrackInfo {
  id: number;
  trackNumber: number;
  name: string;
  language?: string | null;
  languageName?: string | null;
  codec?: string | null;
  codecLabel?: string | null;
  channels?: number;
  bitrate?: number;
  selected: boolean;
}

export interface NativeSpuTrackInfo {
  id: number;
  trackNumber: number;
  name: string;
  language?: string | null;
  languageName?: string | null;
  codec?: string | null;
  codecLabel?: string | null;
  isExternal?: boolean;
  selected: boolean;
}

export interface PrahaNativeInterface {
  isAndroid(): boolean;
  isTelevision(): boolean;
  openBrowser?(url: string): boolean;
  openProtectedEmbed?(url: string): boolean;
  openPrivateDnsSettings?(): boolean;
  getProxyPort(): number;
  proxyStreamUrl(url: string, headersJson: string): string;
  httpRequest?(url: string, method: string, headersJson: string, body: string): string;
  httpRequestAsync?(requestId: string, url: string, method: string, headersJson: string, body: string, timeoutMs: number): void;
  setImmersiveMode(immersive: boolean, lockLandscape: boolean): void;
  enterPip(): boolean;
  openExternalPlayer(url: string, title: string, packageName: string, headersJson: string): boolean;
  shareText(filename: string, content: string): boolean;
  downloadAndInstallUpdate?(apkUrl: string, versionName: string): boolean;
  getAppVersionName?(): string;
  exitApp(): void;

  // LibVLC Player APIs
  getAllAudioTracks?(): string;
  getSelectedAudioTrack?(): number;
  setAudioTrack?(id: number): boolean;
  getAllSpuTracks?(): string;
  getSelectedSpuTrack?(): number;
  setSpuTrack?(id: number): boolean;
  addSlave?(type: number, uri: string, select: boolean): boolean;
  setSpuDelay?(delayMicros: number): boolean;
  getSpuDelay?(): number;
  setAudioDelay?(delayMicros: number): boolean;
  getAudioDelay?(): number;
  openSubtitlePicker?(): boolean;
  vlcPlay?(url: string, headersJson: string, resumeMs: number): boolean;
  vlcPause?(): void;
  vlcResume?(): void;
  vlcStop?(): void;
  vlcSeek?(timeMs: number): void;
  vlcSetVolume?(volume: number): void;
  vlcSetRate?(rate: number): void;
  vlcSetAspectRatio?(aspect: string): boolean;
  isVlcAvailable?(): boolean;
  isVlcPlaying?(): boolean;
}

declare global {
  interface Window {
    PrahaNative?: PrahaNativeInterface;
    prahaNativeBridge?: PrahaBridgeRpcObject;
    __prahaNativeHttpCallback?: (requestId: string, rawResult: string | object) => void;
  }
}

interface PendingHttpRequest {
  resolve: (value: NativeHttpResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingHttpRequests = new Map<string, PendingHttpRequest>();
let httpReqCounter = 0;

export function registerNativeHttpCallback(): void {
  if (typeof window !== 'undefined') {
    window.__prahaNativeHttpCallback = (requestId: string, rawResult: string | object) => {
      const pending = pendingHttpRequests.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingHttpRequests.delete(requestId);
      try {
        const parsed = (typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult) as {
          ok?: boolean;
          status?: number;
          body?: string;
          error?: string;
        };
        if (parsed.error && !parsed.status) {
          pending.reject(new Error(parsed.error));
        } else {
          const status = Number(parsed.status || 0);
          pending.resolve({
            ok: Boolean(parsed.ok ?? (status >= 200 && status < 300)),
            status,
            data: parsed.body ?? '',
          });
        }
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
  }
}

registerNativeHttpCallback();

// ---------------------------------------------------------------------------
// Origin-gated async bridge (audit C-01)
// ---------------------------------------------------------------------------
// On WebViews that support WebViewCompat.addWebMessageListener, the actuator
// half of the native bridge (network, intents, APK install, player control)
// is no longer exposed through addJavascriptInterface, which injects into
// EVERY frame with no origin check. The app's main frame instead receives a
// `prahaNativeBridge` object and talks to native code via request/reply
// messages. Sandboxed embed iframes (opaque origins) never receive the
// object and cannot reach the native actuator even by calling it directly.

interface BridgeRpcReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PrahaBridgeRpcObject {
  postMessage(message: string): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
}

const rpcPending = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let rpcSeq = 0;
let rpcListenerAttached = false;

function getBridgeRpc(): PrahaBridgeRpcObject | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { prahaNativeBridge?: PrahaBridgeRpcObject }).prahaNativeBridge;
  return bridge && typeof bridge.postMessage === 'function' ? bridge : null;
}

/** True when the origin-gated async native bridge is available. */
export function bridgeRpcAvailable(): boolean {
  return Boolean(getBridgeRpc());
}

function ensureRpcListener(): void {
  if (rpcListenerAttached) return;
  const bridge = getBridgeRpc();
  if (!bridge || typeof bridge.addEventListener !== 'function') return;
  bridge.addEventListener('message', (event: { data: unknown }) => {
    let reply: BridgeRpcReply;
    try {
      reply = (typeof event?.data === 'string' ? JSON.parse(event.data) : event?.data) as BridgeRpcReply;
    } catch {
      return;
    }
    if (!reply || typeof reply.id !== 'string') return;
    const pending = rpcPending.get(reply.id);
    if (!pending) return;
    rpcPending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error || 'Native bridge call failed.'));
  });
  rpcListenerAttached = true;
}

function prahaRpc<T>(method: string, args: unknown[], timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const bridge = getBridgeRpc();
    if (!bridge) {
      reject(new Error('The origin-gated native bridge is not available.'));
      return;
    }
    ensureRpcListener();
    const id = `rpc_${++rpcSeq}_${Date.now()}`;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`Native bridge call '${method}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    rpcPending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    try {
      bridge.postMessage(JSON.stringify({ id, method, args }));
    } catch (err) {
      clearTimeout(timer);
      rpcPending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Fire-and-forget RPC for void-native operations (player controls, UI mode). */
function prahaRpcFire(method: string, args: unknown[], timeoutMs = 15000): void {
  prahaRpc(method, args, timeoutMs).catch(() => undefined);
}

export type ExternalPlayerTarget = 'chooser' | 'vlc' | 'mpv' | 'mx' | 'justplayer';

const PLAYER_PACKAGES: Record<Exclude<ExternalPlayerTarget, 'chooser'>, string> = {
  vlc: 'org.videolan.vlc',
  mpv: 'is.xyz.mpv',
  mx: 'com.mxtech.videoplayer.ad',
  justplayer: 'com.brouken.player',
};

export function isAndroidApp(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.PrahaNative) return true;
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

/** Opens Android settings without changing device-wide DNS automatically. */
export async function openPrivateDnsSettings(): Promise<boolean> {
  try {
    if (bridgeRpcAvailable()) {
      return Boolean(await prahaRpc<boolean>('openPrivateDnsSettings', [], 8000));
    }
    return Boolean(window.PrahaNative?.openPrivateDnsSettings?.());
  } catch {
    return false;
  }
}

export function getNativeAppVersion(): string | null {
  try {
    if (typeof window !== 'undefined' && window.PrahaNative && typeof window.PrahaNative.getAppVersionName === 'function') {
      const v = window.PrahaNative.getAppVersionName();
      if (v && typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {}
  return null;
}

/** The Android player uses a dedicated WebView with no privileged JavaScript bridge. */
export async function openProtectedEmbed(url: string): Promise<boolean> {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) return false;
    if (bridgeRpcAvailable()) {
      return Boolean(await prahaRpc<boolean>('openProtectedEmbed', [target.href], 8000));
    }
    return Boolean(window.PrahaNative?.openProtectedEmbed?.(target.href));
  } catch { return false; }
}

export async function openSafeExternalUrl(url: string): Promise<boolean> {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) return false;
    if (isAndroidApp()) {
      if (bridgeRpcAvailable()) {
        return Boolean(await prahaRpc<boolean>('openBrowser', [target.href], 8000));
      }
      return Boolean(window.PrahaNative?.openBrowser?.(target.href));
    }
    // noreferrer also prevents the destination from controlling the opener.
    window.open(target.href, '_blank', 'noopener,noreferrer');
    return true;
  } catch { return false; }
}

/**
 * Validates a URL before it crosses the JS → native bridge. Stream, addon and
 * scraper URLs are attacker-controlled, so only absolute http(s) URLs without
 * embedded credentials may be handed to native code. Returning `null` means
 * "do not call the native method".
 */
export function safeRemoteUrl(
  raw: string,
  options: { allowHttp?: boolean; allowedHosts?: string[] } = {},
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let target: URL;
  try {
    target = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowedProtocols = options.allowHttp === false ? ['https:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(target.protocol)) return null;
  if (target.username || target.password) return null;
  if (!target.hostname) return null;
  const allow = options.allowedHosts;
  if (allow && allow.length) {
    const host = target.hostname.toLowerCase();
    const matches = allow.some((entry) => {
      const rule = entry.toLowerCase();
      return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule;
    });
    if (!matches) return null;
  }
  return target.toString();
}

export function isAndroidTv(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.PrahaNative?.isTelevision?.()) return true;
  } catch {
    // Ignore bridge lookup errors.
  }
  const ua = navigator.userAgent || '';
  return /\b(AFT[A-Z0-9]*|BRAVIA|Android TV|GoogleTV|MIBOX|SHIELD Android TV|Leanback)\b/i.test(ua);
}

let cachedProxyPort = -1;
let lastProxyPortCheck = 0;

export function getCachedProxyPort(): number {
  if (typeof window === 'undefined') return -1;
  const now = Date.now();
  if (cachedProxyPort >= 0 && now - lastProxyPortCheck < 60000) {
    return cachedProxyPort;
  }
  try {
    if (window.PrahaNative?.getProxyPort) {
      cachedProxyPort = window.PrahaNative.getProxyPort();
      lastProxyPortCheck = now;
      return cachedProxyPort;
    }
  } catch {
    cachedProxyPort = -1;
  }
  return cachedProxyPort;
}

export function hasNativeHeaderProxy(): boolean {
  return getCachedProxyPort() > 0;
}

export function extractStreamHeaders(stream: Pick<StreamResult, 'headers' | 'referer' | 'behaviorHints'>): Record<string, string> {
  const merged: Record<string, string> = {};
  const proxyHeaders = (stream.behaviorHints as { proxyHeaders?: { request?: Record<string, string> } } | undefined)?.proxyHeaders?.request;
  if (proxyHeaders && typeof proxyHeaders === 'object') {
    Object.entries(proxyHeaders).forEach(([k, v]) => {
      if (v) merged[k] = String(v);
    });
  }
  if (stream.headers && typeof stream.headers === 'object') {
    Object.entries(stream.headers).forEach(([k, v]) => {
      if (v) merged[k] = String(v);
    });
  }
  if (stream.referer && !merged.Referer && !merged.referer) {
    merged.Referer = stream.referer;
  }
  return merged;
}

/**
 * Rewrites a stream URL through the embedded Android local HTTP proxy when
 * running inside the APK and the stream carries custom headers (Referer,
 * Origin, User-Agent, Authorization) or CORS restrictions.
 */
export function resolvePlayableStreamUrl(stream: StreamResult, preferNativeProxy = true): string {
  if (!stream.url || !preferNativeProxy) return stream.url;
  if (stream.url.startsWith('magnet:') || stream.ytId) return stream.url;
  const headers = extractStreamHeaders(stream);
  if (!Object.keys(headers).length) return stream.url;
  // Never hand an unvalidated addon URL to the native proxy.
  const safeUrl = safeRemoteUrl(stream.url);
  if (!safeUrl) return stream.url;
  try {
    if (window.PrahaNative?.proxyStreamUrl) {
      const proxied = window.PrahaNative.proxyStreamUrl(safeUrl, JSON.stringify(headers));
      if (proxied) return proxied;
    }
  } catch (error) {
    console.warn('Native stream proxy unavailable, falling back to direct URL', error);
  }
  return stream.url;
}

const WP_MEDIA_HOST_RE = /(otakudesu|komikstation|bacakomik|komikindo|komikcast|kiryuu|westmanga|samehadaku|anoboy|kuramanime|komiku|mangakita|softkomik)/i;
const GLOBAL_CDN_HOST_RE = /(^|\.)((i[0-3]\.wp\.com)|(media\.kitsu\.(io|app))|(s4\.anilist\.co)|(cdn\.myanimelist\.net)|(uploads\.mangadex\.org)|(wsrv\.nl)|(duckduckgo\.com))$/i;

/**
 * Ordered list of candidate URLs for external anime/manga cover & chapter images.
 * Handles:
 *  - Hosting HTTP `Referrer-Policy` headers overriding `<img referrerPolicy="no-referrer">`
 *  - Hotlink-protected WordPress & manga chapter CDNs
 *  - Regional ISP DNS/SNI blocks on `.best` / `.org` / `.my` / `.cloud` domains
 */
export function buildImageCandidates(url?: string): string[] {
  if (!url) return [];
  const trimmed = url.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('/sanka-img?')) {
    return [trimmed];
  }

  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
  if (env.MODE === 'test') {
    return [trimmed];
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return [trimmed];
  } catch {
    return [trimmed];
  }

  if (GLOBAL_CDN_HOST_RE.test(parsed.hostname)) {
    return [trimmed, `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(trimmed)}&f=1`];
  }

  const candidates: string[] = [];
  const push = (candidate?: string | null) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  const proxyPort = getCachedProxyPort();
  if (proxyPort > 0) {
    try {
      const headersJson = JSON.stringify({
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      });
      const proxied = `http://127.0.0.1:${proxyPort}/stream?url=${encodeURIComponent(trimmed)}&headers=${encodeURIComponent(headersJson)}`;
      push(proxied);
    } catch {
      // Ignore proxy error and continue with web candidates.
    }
  }

  if (env.VITE_API_PROXY === '1' && !isAndroidApp()) {
    push(`/sanka-img?url=${encodeURIComponent(trimmed)}`);
  }

  const photonUrl = parsed.protocol === 'https:'
    ? `https://i0.wp.com/${parsed.host}${parsed.pathname}`
    : `https://i0.wp.com/${parsed.host}${parsed.pathname}`;
  const ddgProxyUrl = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(trimmed)}&f=1`;
  const wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(trimmed)}&n=-1`;

  const isWordPressMedia = parsed.pathname.includes('/wp-content/') || WP_MEDIA_HOST_RE.test(parsed.hostname);

  if (isWordPressMedia) {
    push(photonUrl);
    push(ddgProxyUrl);
    push(trimmed);
    push(wsrvUrl);
  } else {
    push(trimmed);
    push(ddgProxyUrl);
    push(photonUrl);
    push(wsrvUrl);
  }

  return candidates;
}

/**
 * Fallback URL for hotlink-protected external comic/manga images when a direct
 * `<img referrerPolicy="no-referrer">` request fails.
 */
export function buildFallbackImageUrl(url: string): string | null {
  const candidates = buildImageCandidates(url);
  const next = candidates.find((item) => item !== url);
  return next || null;
}

export interface NativeHttpResult {
  ok: boolean;
  status: number;
  data: string;
  headers?: Record<string, string>;
}

/**
 * Performs an HTTP request that bypasses browser CORS and forbidden-header
 * restrictions when running inside the Android APK. Falls back cleanly to
 * standard `fetch` on the web.
 */
export async function nativeFetchText(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<NativeHttpResult> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const timeoutMs = options.timeoutMs ?? 20000;
  // Native HTTP is a CORS bypass, so it is also an SSRF surface: only absolute
  // http(s) URLs may reach it. Invalid URLs fall through to browser `fetch`.
  const nativeUrl = safeRemoteUrl(url);

  // Global 429 cooldown (port of Nuvio's BackendRateLimit): a rate-limited
  // host gets short-circuited with a fast local 429 instead of more traffic.
  if (nativeUrl && isRateLimited(nativeUrl)) {
    return { ok: false, status: 429, data: '' };
  }

  // 1. Origin-gated async native bridge (WebView >= 116): full CORS bypass
  // with correct redirect/header handling and gzip/deflate decoding. Tried
  // FIRST because CapacitorHttp mangles JSON re-parsing and drops custom
  // headers on redirects, which silently breaks Stremio addons and Nuvio
  // scrapers. Reachable only from the app frame.
  if (bridgeRpcAvailable() && nativeUrl) {
    // Two attempts: a transport-level miss (bridge thread busy, slow first
    // connect) must NEVER fall through to browser fetch — that is CORS-blocked
    // in the app WebView, which is exactly the "Stremio addon error" failure.
    for (const attempt of [1, 2]) {
      const attemptTimeout = attempt === 1 ? timeoutMs : timeoutMs * 2;
      const raw = await prahaRpc<string>(
        'httpRequest',
        [nativeUrl, method, JSON.stringify(headers), options.body || '', timeoutMs],
        attemptTimeout + 5000,
      ).catch(() => null);
      if (raw !== null && raw !== undefined) {
        // The native side always answers with a JSON envelope — but a malformed
        // reply must degrade to a transport miss, not throw out of
        // nativeFetchText and kill every caller that routes through here.
        let parsed: { ok?: boolean; status?: number; body?: string; error?: string } | null = null;
        try {
          parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as typeof parsed;
        } catch {
          parsed = null;
        }
        if (parsed) {
          if (parsed.error && !parsed.status) throw new Error(parsed.error);
          const status = Number(parsed.status || 0);
          if (status === 429) noteRateLimited(nativeUrl);
          return {
            ok: Boolean(parsed.ok ?? (status >= 200 && status < 300)),
            status,
            data: parsed.body ?? '',
          };
        }
        // Unparseable native reply: treat as a transport miss and retry / fall through.
      }
    }
    // Both RPC attempts failed at transport level: fall through to the older
    // paths below.
  }

  // 2. CapacitorHttp (older WebViews without WebMessageListener): bypasses CORS, handles gzip/redirects/forbidden headers off the main thread.
  if (Capacitor.isNativePlatform() && nativeUrl) {
    try {
      const response = await CapacitorHttp.request({
        url: nativeUrl,
        method,
        headers,
        data: options.body,
        responseType: 'text',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        data: text,
      };
    } catch {
      // Fall through to custom native bridge or fetch
    }
  }

  // 3. Legacy Android Java bridge (supports all custom headers & redirects asynchronously).
  if (typeof window !== 'undefined' && window.PrahaNative && nativeUrl) {
    if (window.PrahaNative.httpRequestAsync) {
      if (!window.__prahaNativeHttpCallback) registerNativeHttpCallback();
      return new Promise<NativeHttpResult>((resolve, reject) => {
        const requestId = `req_${++httpReqCounter}_${Date.now()}`;
        const timer = setTimeout(() => {
          pendingHttpRequests.delete(requestId);
          reject(new Error(`Native HTTP request timed out after ${timeoutMs}ms`));
        }, timeoutMs + 3000);

        pendingHttpRequests.set(requestId, { resolve, reject, timer });

        try {
          window.PrahaNative!.httpRequestAsync!(
            requestId,
            nativeUrl,
            method,
            JSON.stringify(headers),
            options.body || '',
            timeoutMs,
          );
        } catch (callError) {
          clearTimeout(timer);
          pendingHttpRequests.delete(requestId);
          reject(callError instanceof Error ? callError : new Error(String(callError)));
        }
      });
    }

    if (window.PrahaNative.httpRequest) {
      const raw = window.PrahaNative.httpRequest(nativeUrl, method, JSON.stringify(headers), options.body || '');
      const parsed = JSON.parse(raw) as { ok?: boolean; status?: number; body?: string; error?: string };
      if (parsed.error && !parsed.status) throw new Error(parsed.error);
      const status = Number(parsed.status || 0);
      return {
        ok: Boolean(parsed.ok ?? (status >= 200 && status < 300)),
        status,
        data: parsed.body ?? '',
      };
    }
  }

  // 4. Browser / standard web fetch
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const data = await response.text();
    return { ok: response.ok, status: response.status, data };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function setImmersiveFullscreen(enabled: boolean, lockLandscape = true): Promise<void> {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('setImmersiveMode', [enabled, lockLandscape]);
  } else {
    try {
      window.PrahaNative?.setImmersiveMode?.(enabled, lockLandscape);
    } catch {
      // Ignore native bridge failure.
    }
  }
  try {
    const orientation = (screen as Screen & { orientation?: { lock?: (mode: string) => Promise<void>; unlock?: () => void } }).orientation;
    if (enabled && lockLandscape) {
      await orientation?.lock?.('landscape');
    } else {
      orientation?.unlock?.();
    }
  } catch {
    // Orientation lock is optional on desktop browsers.
  }
}

export async function enterNativeAndroidPip(): Promise<boolean> {
  try {
    if (bridgeRpcAvailable()) {
      return Boolean(await prahaRpc<boolean>('enterPip', [], 5000));
    }
    if (window.PrahaNative?.enterPip) {
      return Boolean(window.PrahaNative.enterPip());
    }
  } catch {
    // Fall back to standard Web PiP.
  }
  return false;
}

export function buildAndroidIntentUrl(
  streamUrl: string,
  title: string,
  target: ExternalPlayerTarget = 'chooser',
): string {
  if (streamUrl.startsWith('magnet:')) return streamUrl;
  try {
    const parsed = new URL(streamUrl);
    const scheme = parsed.protocol.replace(':', '');
    const pathPart = streamUrl.slice(parsed.protocol.length + 2);
    const pkg = target === 'chooser' ? '' : `package=${PLAYER_PACKAGES[target]};`;
    const safeTitle = encodeURIComponent(title || 'PRAHA Stream');
    return `intent://${pathPart}#Intent;scheme=${scheme};type=video/*;${pkg}S.title=${safeTitle};end`;
  } catch {
    return streamUrl;
  }
}

export function openExternalPlayer(
  stream: StreamResult,
  title: string,
  target: ExternalPlayerTarget = 'chooser',
): void {
  const url = stream.url;
  if (!url) return;
  // `magnet:` is a legitimate hand-off; everything else must be http(s) with no
  // embedded credentials before it reaches a native intent / ACTION_VIEW.
  const safeUrl = url.startsWith('magnet:') ? url : safeRemoteUrl(url);
  if (!safeUrl) return;
  const headers = extractStreamHeaders(stream);
  const pkg = target === 'chooser' ? '' : PLAYER_PACKAGES[target];

  const intentHref = isAndroidApp() && !safeUrl.startsWith('magnet:')
    ? buildAndroidIntentUrl(safeUrl, title, target)
    : safeUrl;
  // On the web this must run synchronously to keep the user-gesture context.
  const openFallback = () => window.open(intentHref, '_blank', 'noopener,noreferrer');

  const rpc = bridgeRpcAvailable()
    ? prahaRpc<boolean>('openExternalPlayer', [safeUrl, title, pkg, JSON.stringify(headers)], 8000)
    : null;

  if (!rpc) {
    if (window.PrahaNative?.openExternalPlayer) {
      try {
        if (window.PrahaNative.openExternalPlayer(safeUrl, title, pkg, JSON.stringify(headers))) return;
      } catch {
        // Fall back to intent:// or direct href.
      }
    }
    openFallback();
    return;
  }

  void rpc.then((handled) => {
    if (!handled) openFallback();
  }).catch(() => {
    openFallback();
  });
}

export async function exportBackupFile(filename: string, jsonText: string): Promise<'shared' | 'downloaded'> {
  try {
    if (bridgeRpcAvailable()) {
      if (await prahaRpc<boolean>('shareText', [filename, jsonText], 10000)) return 'shared';
    } else if (window.PrahaNative?.shareText && window.PrahaNative.shareText(filename, jsonText)) {
      return 'shared';
    }
  } catch {
    // Fall back to navigator.share / download.
  }

  if (typeof navigator !== 'undefined' && navigator.share && isAndroidApp()) {
    try {
      const file = new File([jsonText], filename, { type: 'application/json' });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'PRAHA STREAM Backup', files: [file] });
        return 'shared';
      }
    } catch {
      // Fall back to standard download.
    }
  }

  const blob = new Blob([jsonText], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  return 'downloaded';
}

export async function downloadAndInstallUpdate(apkUrl: string, versionName: string): Promise<boolean> {
  // Installing an APK is the highest-impact native sink in the app. Pin it to
  // the release feed: HTTPS only, GitHub-hosted, and an .apk path.
  const safeUrl = safeRemoteUrl(apkUrl, {
    allowHttp: false,
    allowedHosts: ['github.com', '*.githubusercontent.com'],
  });
  if (!safeUrl || !/\.apk($|\?)/i.test(new URL(safeUrl).pathname + new URL(safeUrl).search)) return false;
  try {
    if (bridgeRpcAvailable()) {
      return Boolean(await prahaRpc<boolean>('downloadAndInstallUpdate', [safeUrl, versionName], 10000));
    }
    if (window.PrahaNative?.downloadAndInstallUpdate) {
      return window.PrahaNative.downloadAndInstallUpdate(safeUrl, versionName);
    }
  } catch {
    // Fall back to opening URL in browser
  }
  // Reject javascript:/data:/file: URLs and never hand the new tab an opener.
  return openSafeExternalUrl(safeUrl);
}

export function exitAndroidApp(): void {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('exitApp', []);
    return;
  }
  try {
    window.PrahaNative?.exitApp?.();
  } catch {
    // No-op on web.
  }
}

export function isNativeVlcAvailable(): boolean {
  try {
    return Boolean(window.PrahaNative?.isVlcAvailable?.());
  } catch {
    return false;
  }
}

export function isNativeVlcPlaying(): boolean {
  try {
    return Boolean(window.PrahaNative?.isVlcPlaying?.());
  } catch {
    return false;
  }
}

export function getNativeAudioTracks(): NativeAudioTrackInfo[] {
  try {
    const raw = window.PrahaNative?.getAllAudioTracks?.();
    if (!raw) return [];
    return JSON.parse(raw) as NativeAudioTrackInfo[];
  } catch {
    return [];
  }
}

export function getSelectedNativeAudioTrack(): number {
  try {
    return window.PrahaNative?.getSelectedAudioTrack?.() ?? -1;
  } catch {
    return -1;
  }
}

export function setNativeAudioTrack(id: number): boolean {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('setAudioTrack', [id]);
    return true;
  }
  try {
    return Boolean(window.PrahaNative?.setAudioTrack?.(id));
  } catch {
    return false;
  }
}

export function getNativeSpuTracks(): NativeSpuTrackInfo[] {
  try {
    const raw = window.PrahaNative?.getAllSpuTracks?.();
    if (!raw) return [];
    return JSON.parse(raw) as NativeSpuTrackInfo[];
  } catch {
    return [];
  }
}

export function getSelectedNativeSpuTrack(): number {
  try {
    return window.PrahaNative?.getSelectedSpuTrack?.() ?? -1;
  } catch {
    return -1;
  }
}

export function setNativeSpuTrack(id: number): boolean {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('setSpuTrack', [id]);
    return true;
  }
  try {
    return Boolean(window.PrahaNative?.setSpuTrack?.(id));
  } catch {
    return false;
  }
}

export function addNativeSubtitleSlave(uri: string, select = true): boolean {
  // Subtitles picked through the system file picker arrive as content:// URIs
  // (permission-granted by the OS); remote subtitle tracks must be http(s).
  const safeUri = uri.startsWith('content://') && !/[\r\n\0]/.test(uri)
    ? uri
    : safeRemoteUrl(uri);
  if (!safeUri) return false;
  if (bridgeRpcAvailable()) {
    prahaRpcFire('addSlave', [0, safeUri, select]);
    return true;
  }
  try {
    return Boolean(window.PrahaNative?.addSlave?.(0, safeUri, select));
  } catch {
    return false;
  }
}

export function openNativeSubtitlePicker(): boolean {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('openSubtitlePicker', []);
    return true;
  }
  try {
    return Boolean(window.PrahaNative?.openSubtitlePicker?.());
  } catch {
    return false;
  }
}

export function setNativeSubtitleDelay(delaySeconds: number): boolean {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('setSpuDelay', [Math.round(delaySeconds * 1000000)]);
    return true;
  }
  try {
    const micros = Math.round(delaySeconds * 1000000);
    return Boolean(window.PrahaNative?.setSpuDelay?.(micros));
  } catch {
    return false;
  }
}

export const setNativeSpuDelay = setNativeSubtitleDelay;

export function setNativeAudioDelay(delaySeconds: number): boolean {
  if (bridgeRpcAvailable()) {
    prahaRpcFire('setAudioDelay', [Math.round(delaySeconds * 1000000)]);
    return true;
  }
  try {
    const micros = Math.round(delaySeconds * 1000000);
    return Boolean(window.PrahaNative?.setAudioDelay?.(micros));
  } catch {
    return false;
  }
}

export function nativeVlcPlay(url: string, headers: Record<string, string> = {}, resumeMs = 0): void {
  const safeUrl = safeRemoteUrl(url);
  if (!safeUrl) return;
  if (bridgeRpcAvailable()) {
    prahaRpcFire('vlcPlay', [safeUrl, JSON.stringify(headers), resumeMs], 10000);
    return;
  }
  try {
    window.PrahaNative?.vlcPlay?.(safeUrl, JSON.stringify(headers), resumeMs);
  } catch {}
}

export function nativeVlcPause(): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcPause', []);
  try {
    window.PrahaNative?.vlcPause?.();
  } catch {}
}

export function nativeVlcResume(): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcResume', []);
  try {
    window.PrahaNative?.vlcResume?.();
  } catch {}
}

export function nativeVlcStop(): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcStop', []);
  try {
    window.PrahaNative?.vlcStop?.();
  } catch {}
}

export function nativeVlcSeek(timeMs: number): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcSeek', [Math.round(timeMs)]);
  try {
    window.PrahaNative?.vlcSeek?.(timeMs);
  } catch {}
}

export function nativeVlcSetVolume(volumePercent: number): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcSetVolume', [Math.round(volumePercent)]);
  try {
    window.PrahaNative?.vlcSetVolume?.(volumePercent);
  } catch {}
}

export function nativeVlcSetRate(rate: number): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcSetRate', [rate]);
  try {
    window.PrahaNative?.vlcSetRate?.(rate);
  } catch {}
}

export function nativeVlcSetAspectRatio(aspect: string): void {
  if (bridgeRpcAvailable()) return prahaRpcFire('vlcSetAspectRatio', [aspect]);
  try {
    window.PrahaNative?.vlcSetAspectRatio?.(aspect);
  } catch {}
}

