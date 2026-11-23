import type { PlayerEngineId } from '../types';

/**
 * Which playback engine the player tries first, and in what order it falls back.
 *
 * Android has three ways to draw a video:
 *
 *   mpv     — libmpv on a SurfaceView behind the WebView (best format coverage)
 *   media3  — AndroidX Media3 / ExoPlayer, also on a SurfaceView
 *   web     — hls.js / dash.js / mpegts.js / WebTorrent inside the WebView
 *
 * The preference is stored as a single id, but a real playback attempt needs a
 * *chain*: the preferred engine first, then every engine after it that this
 * build can actually run. That keeps the fallback order fixed and inspectable
 * instead of being scattered through the player effect.
 *
 * mpv and media3 are Android-only. In a browser or PWA neither plugin is
 * registered, so `resolveEngineChain` collapses to `['web']` and the web player
 * keeps working exactly as before — the web path is never removed.
 */

export const PLAYER_ENGINE_ORDER: readonly PlayerEngineId[] = ['mpv', 'media3', 'web'];

/** The engine every install starts on. mpv first, per the player contract. */
export const DEFAULT_PLAYER_ENGINE: PlayerEngineId = 'mpv';

/**
 * Coerces a stored preference to a known engine.
 *
 * Settings are user-editable files (backups, sync, a hand-edited localStorage
 * entry), so the value arriving here is a claim. Anything unrecognised becomes
 * mpv rather than undefined — that is what gives existing installs the new
 * default without a migration, while an explicit `media3` or `web` survives.
 */
export function normalizePlayerEngine(raw: unknown): PlayerEngineId {
  return raw === 'mpv' || raw === 'media3' || raw === 'web' ? raw : DEFAULT_PLAYER_ENGINE;
}

export interface EngineAvailability {
  /** `mpvAvailable()` — false in a browser, false on an APK without the plugin. */
  mpv: boolean;
  /** `media3Available()` */
  media3: boolean;
}

export interface EngineChainOptions {
  /** The saved preference, already normalised or not. */
  preferred: unknown;
  /** blob: P2P streams and anything else libmpv cannot open skip native entirely. */
  forceWeb?: boolean;
  availability: EngineAvailability;
  /**
   * The host this playback runs on. `web` disables the native engines even if a
   * stale `Capacitor.Plugins` object is still present, which happens on a page
   * hot-reloaded inside the Capacitor shell.
   */
  host?: 'android' | 'web';
}

/**
 * The ordered list of engines to attempt for this source.
 *
 * Only the preference and what is actually installed decide membership: the
 * preference says where to start, and playback always ends at `web`, which
 * needs no plugin and cannot fail to initialise. An empty chain is impossible.
 */
export function resolveEngineChain({
  preferred,
  forceWeb = false,
  availability,
  host = 'android',
}: EngineChainOptions): PlayerEngineId[] {
  if (forceWeb || host === 'web') return ['web'];

  const start = normalizePlayerEngine(preferred);
  const usable: Record<PlayerEngineId, boolean> = {
    mpv: availability.mpv,
    media3: availability.media3,
    web: true,
  };

  // Everything from the preferred engine onwards, minus what is not installed.
  // Choosing mpv therefore yields mpv → media3 → web, choosing media3 yields
  // media3 → web, and choosing web yields web alone.
  const fromIndex = PLAYER_ENGINE_ORDER.indexOf(start);
  const chain = PLAYER_ENGINE_ORDER.slice(fromIndex).filter((engine) => usable[engine]);
  return chain.length ? chain : ['web'];
}

/** The engine to try after `current` failed, or null when the chain is spent. */
export function nextEngineInChain(
  chain: readonly PlayerEngineId[],
  current: PlayerEngineId,
): PlayerEngineId | null {
  const index = chain.indexOf(current);
  if (index === -1) return null;
  return chain[index + 1] ?? null;
}

/** Human label for the fallback message and the settings dropdown. */
export function playerEngineLabel(engine: PlayerEngineId): string {
  switch (engine) {
    case 'mpv': return 'mpv';
    case 'media3': return 'Media3 (ExoPlayer)';
    case 'web': return 'Web player';
  }
}

/**
 * The one-line notice shown when a source did not play on the preferred engine.
 *
 * Worded so the user knows playback continued rather than wondering why the
 * picture looked different: the toast is the only feedback for a swap they did
 * not ask for.
 */
export function fallbackNotice(from: PlayerEngineId, to: PlayerEngineId): string {
  return `${playerEngineLabel(from)} could not play this stream — switched to ${playerEngineLabel(to)}.`;
}
