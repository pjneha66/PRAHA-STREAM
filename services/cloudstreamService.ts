import { bridgeRpcAvailable, prahaRpc } from './androidBridge';
import type {
  CloudStreamAvailablePlugin,
  CloudStreamHomeSection,
  CloudStreamLinks,
  CloudStreamLoadResponse,
  CloudStreamPlugin,
  CloudStreamProvider,
  CloudStreamRepository,
  CloudStreamSearchItem,
  CloudStreamSettings,
  StreamResult,
  StreamSubtitle,
} from '../types';

/**
 * CloudStream extensions.
 *
 * A `.cs3` is a zip of Dalvik bytecode: it can only be installed and executed by
 * the Android host, never in the WebView. So unlike Stremio add-ons and Nuvio
 * scrapers, this service is a thin, typed wrapper over the native bridge — the
 * extension state lives on the device and this only reads and drives it.
 *
 * Everything here therefore requires the native bridge. On the web build the
 * availability check reports false and callers show the "Android only" state.
 */

export function cloudStreamAvailable(): boolean {
  return bridgeRpcAvailable();
}

/** Extension calls can take as long as the slowest provider; give them room. */
const EXTENSION_TIMEOUT = 90_000;
/** Installing downloads a package; repository reads may need a redirect chase. */
const NETWORK_TIMEOUT = 60_000;

function rpc<T>(method: string, args: unknown[], timeoutMs = EXTENSION_TIMEOUT): Promise<T> {
  return prahaRpc<T>(method, args, timeoutMs);
}

// ── Repositories ────────────────────────────────────────────────────────────

export async function getRepositories(): Promise<CloudStreamRepository[]> {
  const raw = await rpc<string>('csRepositories', [], NETWORK_TIMEOUT);
  return parseJson<CloudStreamRepository[]>(raw) ?? [];
}

export async function addRepository(input: string): Promise<CloudStreamRepository> {
  const raw = await rpc<string>('csAddRepository', [input], NETWORK_TIMEOUT);
  const repo = parseJson<CloudStreamRepository>(raw);
  if (!repo) throw new Error('The repository could not be read.');
  return repo;
}

export async function removeRepository(url: string): Promise<void> {
  await rpc<null>('csRemoveRepository', [url], NETWORK_TIMEOUT);
}

export async function getRepositoryPlugins(repositoryUrl: string): Promise<CloudStreamAvailablePlugin[]> {
  const raw = await rpc<string>('csRepoPlugins', [repositoryUrl], NETWORK_TIMEOUT);
  return parseJson<CloudStreamAvailablePlugin[]>(raw) ?? [];
}

// ── Installed extensions ────────────────────────────────────────────────────

export async function getInstalledPlugins(): Promise<CloudStreamPlugin[]> {
  const raw = await rpc<string>('csPlugins', [], NETWORK_TIMEOUT);
  return parseJson<CloudStreamPlugin[]>(raw) ?? [];
}

export async function installPlugin(repositoryUrl: string, internalName: string): Promise<boolean> {
  return Boolean(await rpc<boolean>('csInstallPlugin', [repositoryUrl, internalName], NETWORK_TIMEOUT));
}

export async function uninstallPlugin(internalName: string): Promise<void> {
  await rpc<null>('csUninstallPlugin', [internalName], NETWORK_TIMEOUT);
}

/** Returns the internal names that were updated. */
export async function updatePlugins(): Promise<string[]> {
  const raw = await rpc<string>('csUpdatePlugins', [], NETWORK_TIMEOUT * 2);
  return parseJson<string[]>(raw) ?? [];
}

/** Installs missing files, and with `includeNew` every extension the repos offer. */
export async function installMissing(includeNew: boolean, languages: string[] = []): Promise<string[]> {
  const raw = await rpc<string>('csInstallMissing', [includeNew, languages], NETWORK_TIMEOUT * 2);
  return parseJson<string[]>(raw) ?? [];
}

/** Installs a `.cs3` the user picked from storage (a `content://` uri). */
export async function sideload(uri: string): Promise<boolean> {
  return Boolean(await rpc<boolean>('csSideload', [uri], NETWORK_TIMEOUT));
}

/**
 * Opens Android's document picker for a `.cs3`. Returns true when the picker was
 * shown; the install itself finishes later and arrives as an `install` event,
 * because a content:// uri cannot be read from the WebView.
 */
export async function pickPluginFile(): Promise<boolean> {
  return Boolean(await rpc<boolean>('csPickPluginFile', [], NETWORK_TIMEOUT));
}

/** Absolute on-device path of an installed `.cs3`, or null when it is not installed. */
export async function getPluginFile(internalName: string): Promise<string | null> {
  return (await rpc<string | null>('csOpenPluginFile', [internalName], NETWORK_TIMEOUT)) ?? null;
}

// ── Providers ───────────────────────────────────────────────────────────────

export async function getProviders(): Promise<CloudStreamProvider[]> {
  const raw = await rpc<string>('csProviders', [], EXTENSION_TIMEOUT);
  return parseJson<CloudStreamProvider[]>(raw) ?? [];
}

// ── Home ────────────────────────────────────────────────────────────────────

export async function getHome(apiNames?: string[]): Promise<CloudStreamHomeSection[]> {
  const raw = await rpc<string>('csHome', [apiNames ?? null], EXTENSION_TIMEOUT);
  return parseJson<CloudStreamHomeSection[]>(raw) ?? [];
}

export interface CloudStreamCatalogEntry {
  apiName: string;
  name: string;
  enabled: boolean;
  index: number;
}

export async function getCatalogs(apiNames?: string[]): Promise<CloudStreamCatalogEntry[]> {
  const raw = await rpc<string>('csCatalogs', [apiNames ?? null], EXTENSION_TIMEOUT);
  return parseJson<CloudStreamCatalogEntry[]>(raw) ?? [];
}

export async function setCatalogEnabled(apiName: string, section: string, enabled: boolean): Promise<void> {
  await rpc<null>('csSetCatalogEnabled', [apiName, section, enabled], EXTENSION_TIMEOUT);
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface CloudStreamSearchBatch {
  apiName: string;
  error: string | null;
  items: CloudStreamSearchItem[];
}

export async function search(query: string, apiNames?: string[]): Promise<CloudStreamSearchBatch[]> {
  const raw = await rpc<string>('csSearch', [query, apiNames ?? null], EXTENSION_TIMEOUT);
  return parseJson<CloudStreamSearchBatch[]>(raw) ?? [];
}

// ── Title page and sources ──────────────────────────────────────────────────

export async function loadTitle(apiName: string, url: string): Promise<CloudStreamLoadResponse> {
  const raw = await rpc<string>('csLoad', [apiName, url], EXTENSION_TIMEOUT);
  const response = parseJson<CloudStreamLoadResponse>(raw);
  if (!response) throw new Error('The extension could not load that title.');
  return response;
}

export async function getLinks(apiName: string, data: string): Promise<CloudStreamLinks> {
  const raw = await rpc<string>('csLinks', [apiName, data], EXTENSION_TIMEOUT * 2);
  const links = parseJson<CloudStreamLinks>(raw);
  return links ?? { links: [], subtitles: [] };
}

/** Starts finding an episode's sources before the user presses play. */
export function prefetch(apiName: string, data: string): void {
  if (!cloudStreamAvailable()) return;
  rpc<null>('csPrefetch', [apiName, data], 5_000).catch(() => undefined);
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<CloudStreamSettings> {
  const raw = await rpc<string>('csSettings', [], NETWORK_TIMEOUT);
  return parseJson<CloudStreamSettings>(raw) ?? {
    sourcesTimeoutSeconds: 45,
    preferredQuality: 0,
    audioLanguage: '',
    prepareSources: true,
    allowAdult: false,
    jsDelivr: false,
  };
}

export async function setSettings(patch: Partial<CloudStreamSettings>): Promise<void> {
  await rpc<null>('csSetSettings', [patch], NETWORK_TIMEOUT);
}

// ── Extension-initiated events ──────────────────────────────────────────────

export interface CloudStreamDetailsEvent {
  apiName: string;
  url: string;
  name: string;
}

export interface CloudStreamInstallEvent {
  ok: boolean;
  message?: string | null;
}

type DetailsHandler = (event: CloudStreamDetailsEvent) => void;
type InstallHandler = (event: CloudStreamInstallEvent) => void;
const detailsHandlers = new Set<DetailsHandler>();
const installHandlers = new Set<InstallHandler>();
let detailsListenerInstalled = false;

/**
 * Some extensions open a title themselves (a "next episode" button inside their
 * own pages). The host forwards that as a `details` event; this routes it into
 * the web layer so it lands on a real title screen instead of doing nothing.
 */
export function onDetailsRequested(handler: DetailsHandler): () => void {
  detailsHandlers.add(handler);
  installDetailsListener();
  return () => {
    detailsHandlers.delete(handler);
  };
}

/** Reports the outcome of a picker-driven `.cs3` install. */
export function onInstallFinished(handler: InstallHandler): () => void {
  installHandlers.add(handler);
  installDetailsListener();
  return () => {
    installHandlers.delete(handler);
  };
}

function installDetailsListener(): void {
  if (detailsListenerInstalled || typeof window === 'undefined') return;
  detailsListenerInstalled = true;
  const w = window as unknown as {
    __prahaCloudStreamEvent?: (type: string, detail: unknown) => void;
  };
  w.__prahaCloudStreamEvent = (type, detail) => {
    if (!detail || typeof detail !== 'object') return;
    if (type === 'details') {
      const event = detail as CloudStreamDetailsEvent;
      if (!event.apiName || !event.url) return;
      detailsHandlers.forEach((handler) => {
        try { handler(event); } catch { /* one bad handler must not stop the rest */ }
      });
    } else if (type === 'install') {
      const event = detail as CloudStreamInstallEvent;
      installHandlers.forEach((handler) => {
        try { handler(event); } catch { /* as above */ }
      });
    }
  };
}

// ── Conversion to PRAHA's source list ───────────────────────────────────────

const QUALITY_LABELS: Array<[number, string]> = [
  [2160, '4K'],
  [1080, '1080p'],
  [720, '720p'],
  [480, '480p'],
  [360, '360p'],
  [240, '240p'],
];

function qualityLabel(quality: number): string | undefined {
  for (const [value, label] of QUALITY_LABELS) {
    if (quality >= value) return label;
  }
  return quality > 0 ? `${quality}p` : undefined;
}

/**
 * Turns the extension's links into PRAHA's [StreamResult] shape, so the existing
 * source list and player can play them without a CloudStream-specific path.
 */
export function toStreamResults(
  apiName: string,
  links: CloudStreamLinks,
): StreamResult[] {
  const subtitles: StreamSubtitle[] = links.subtitles.map((sub, index) => ({
    id: `cs-sub-${index}`,
    url: sub.url,
    language: sub.lang,
    headers: sub.headers,
  }));

  return links.links.map((link, index) => ({
    id: `cloudstream:${apiName}:${index}`,
    title: link.name || link.source,
    url: link.url,
    sourceName: link.source || apiName,
    sourceType: 'cloudstream' as const,
    quality: qualityLabel(link.quality),
    provider: apiName,
    headers: link.headers,
    referer: link.referer || undefined,
    format: link.type === 'M3U8' ? 'hls' : link.type === 'DASH' ? 'dash' : undefined,
    subtitles: subtitles.length ? subtitles : undefined,
  }));
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
