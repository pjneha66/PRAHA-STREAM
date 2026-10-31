import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { StreamResult } from '../types';

export interface PrahaNativeInterface {
  isAndroid(): boolean;
  isTelevision(): boolean;
  getProxyPort(): number;
  proxyStreamUrl(url: string, headersJson: string): string;
  httpRequest(url: string, method: string, headersJson: string, body: string): string;
  setImmersiveMode(immersive: boolean, lockLandscape: boolean): void;
  enterPip(): boolean;
  openExternalPlayer(url: string, title: string, packageName: string, headersJson: string): boolean;
  shareText(filename: string, content: string): boolean;
  exitApp(): void;
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
      return { ok: response.ok, status: response.status, data };
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

export function exitAndroidApp(): void {
  try {
    window.PrahaNative?.exitApp?.();
  } catch {
    // No-op on web.
  }
}
