import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { StreamResult } from '../types';

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
  httpRequest(url: string, method: string, headersJson: string, body: string): string;
  setImmersiveMode(immersive: boolean, lockLandscape: boolean): void;
  enterPip(): boolean;
  openExternalPlayer(url: string, title: string, packageName: string, headersJson: string): boolean;
  shareText(filename: string, content: string): boolean;
  downloadAndInstallUpdate?(apkUrl: string, versionName: string): boolean;
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
  isVlcAvailable?(): boolean;
  isVlcPlaying?(): boolean;
}

declare global {
  interface Window {
    PrahaNative?: PrahaNativeInterface;
  }
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
export function openPrivateDnsSettings(): boolean {
  try {
    return Boolean(window.PrahaNative?.openPrivateDnsSettings?.());
  } catch {
    return false;
  }
}

/** The Android player uses a dedicated WebView with no privileged JavaScript bridge. */
export function openProtectedEmbed(url: string): boolean {
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && !target.username && !target.password && Boolean(window.PrahaNative?.openProtectedEmbed?.(target.href));
  } catch { return false; }
}

export function openSafeExternalUrl(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) return false;
    if (isAndroidApp()) return Boolean(window.PrahaNative?.openBrowser?.(target.href));
    // noreferrer also prevents the destination from controlling the opener.
    window.open(target.href, '_blank', 'noopener,noreferrer');
    return true;
  } catch { return false; }
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

export function hasNativeHeaderProxy(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(window.PrahaNative && window.PrahaNative.getProxyPort() > 0);
  } catch {
    return false;
  }
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
  try {
    if (window.PrahaNative?.proxyStreamUrl) {
      const proxied = window.PrahaNative.proxyStreamUrl(stream.url, JSON.stringify(headers));
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

  if (typeof window !== 'undefined' && window.PrahaNative?.proxyStreamUrl && hasNativeHeaderProxy()) {
    try {
      const proxied = window.PrahaNative.proxyStreamUrl(
        trimmed,
        JSON.stringify({
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        }),
      );
      if (proxied && proxied !== trimmed) push(proxied);
    } catch {
      // Ignore native bridge error and continue with web candidates.
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

  const hasForbiddenBrowserHeader = Object.keys(headers).some((key) =>
    /^(referer|origin|user-agent|cookie|host)$/i.test(key),
  );

  // 1. Try browser fetch first when on web or no forbidden headers are needed.
  if (!isAndroidApp() || !hasForbiddenBrowserHeader) {
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
      if (isAndroidApp() && !response.ok && (response.status === 403 || response.status === 0)) {
        // Fall through to native HTTP when WebView's Origin or wv User-Agent is challenged.
      } else {
        return { ok: response.ok, status: response.status, data };
      }
    } catch (fetchError) {
      if (!isAndroidApp()) throw fetchError;
      // On Android, fall through to native HTTP if WebView fetch hit CORS.
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  // 2. Native Android Java bridge (supports all custom headers & redirects).
  if (typeof window !== 'undefined' && window.PrahaNative?.httpRequest) {
    const raw = window.PrahaNative.httpRequest(url, method, JSON.stringify(headers), options.body || '');
    const parsed = JSON.parse(raw) as { ok?: boolean; status?: number; body?: string; error?: string };
    if (parsed.error && !parsed.status) throw new Error(parsed.error);
    const status = Number(parsed.status || 0);
    return {
      ok: Boolean(parsed.ok ?? (status >= 200 && status < 300)),
      status,
      data: parsed.body ?? '',
    };
  }

  // 3. CapacitorHttp fallback when running on native Capacitor without custom bridge.
  if (isAndroidApp()) {
    const response = await CapacitorHttp.request({
      url,
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
  }

  throw new Error('Network request failed.');
}

export async function setImmersiveFullscreen(enabled: boolean, lockLandscape = true): Promise<void> {
  try {
    window.PrahaNative?.setImmersiveMode?.(enabled, lockLandscape);
  } catch {
    // Ignore native bridge failure.
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

export function enterNativeAndroidPip(): boolean {
  try {
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
  const headers = extractStreamHeaders(stream);
  const pkg = target === 'chooser' ? '' : PLAYER_PACKAGES[target];

  try {
    if (window.PrahaNative?.openExternalPlayer) {
      const handled = window.PrahaNative.openExternalPlayer(url, title, pkg, JSON.stringify(headers));
      if (handled) return;
    }
  } catch {
    // Fall back to intent:// or direct href.
  }

  const href = isAndroidApp() && !url.startsWith('magnet:')
    ? buildAndroidIntentUrl(url, title, target)
    : url;
  window.open(href, '_blank', 'noopener,noreferrer');
}

export async function exportBackupFile(filename: string, jsonText: string): Promise<'shared' | 'downloaded'> {
  try {
    if (window.PrahaNative?.shareText && window.PrahaNative.shareText(filename, jsonText)) {
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

export function downloadAndInstallUpdate(apkUrl: string, versionName: string): boolean {
  try {
    if (window.PrahaNative?.downloadAndInstallUpdate) {
      return window.PrahaNative.downloadAndInstallUpdate(apkUrl, versionName);
    }
  } catch {
    // Fall back to opening URL in browser
  }
  window.open(apkUrl, '_blank');
  return true;
}

export function exitAndroidApp(): void {
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
  try {
    return Boolean(window.PrahaNative?.setSpuTrack?.(id));
  } catch {
    return false;
  }
}

export function addNativeSubtitleSlave(uri: string, select = true): boolean {
  try {
    return Boolean(window.PrahaNative?.addSlave?.(0, uri, select));
  } catch {
    return false;
  }
}

export function openNativeSubtitlePicker(): boolean {
  try {
    return Boolean(window.PrahaNative?.openSubtitlePicker?.());
  } catch {
    return false;
  }
}

export function setNativeSubtitleDelay(delaySeconds: number): boolean {
  try {
    const micros = Math.round(delaySeconds * 1000000);
    return Boolean(window.PrahaNative?.setSpuDelay?.(micros));
  } catch {
    return false;
  }
}

export const setNativeSpuDelay = setNativeSubtitleDelay;

export function setNativeAudioDelay(delaySeconds: number): boolean {
  try {
    const micros = Math.round(delaySeconds * 1000000);
    return Boolean(window.PrahaNative?.setAudioDelay?.(micros));
  } catch {
    return false;
  }
}

