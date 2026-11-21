import { registerPlugin } from '@capacitor/core';

/**
 * Native lifecycle bridge for the TorrServer executable bundled in jniLibs.
 *
 * The REST API is deliberately *not* here — it goes through the existing
 * `nativeFetchText` bridge so all requests share the app's CORS bypass and
 * rate-limit handling. This plugin only starts/stops the process and reports
 * where the extracted binary lives.
 */
export interface TorrServerStatus {
  running: boolean;
  port: number;
  pid: number;
  binaryPath?: string | null;
  logs: string[];
}

export interface TorrServerStartResult {
  port: number;
  pid: number;
  binaryPath: string;
  dataDir: string;
  alreadyRunning?: boolean;
}

interface PrahaTorrServerPlugin {
  getNativeLibraryDir(): Promise<{ path: string }>;
  start(options?: { port?: number }): Promise<TorrServerStartResult>;
  stop(): Promise<void>;
  status(): Promise<TorrServerStatus>;
  getLogs(): Promise<{ logs: string[] }>;
}

export const PrahaTorrServer = registerPlugin<PrahaTorrServerPlugin>('PrahaTorrServer');

/** True only in an APK that registered PrahaTorrServerPlugin in MainActivity. */
export function torrServerNativeAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins;
  return Boolean(plugins?.PrahaTorrServer);
}
