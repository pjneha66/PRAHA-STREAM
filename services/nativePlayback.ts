import type { NativeEngineHandle, NativeEngineId, NativeSnapshot } from './nativePlayerAdapter';
import { createNativeEngine } from './nativePlayerAdapter';
import { fallbackNotice, nextEngineInChain } from './playerSelection';
import type { PlayerEngineId } from '../types';
import { formatAudioCodec, formatSubtitleCodec, resolveLanguageName } from './subtitleService';

/**
 * Starts playback on a native engine (mpv or Media3) and handles the fallback
 * to the next engine in the chain.
 *
 * The player hook owns the React state, so this module stays a plain controller:
 * it attaches the surface, loads the URL, mirrors the engine's snapshot into
 * callbacks, and reports a failure exactly once through `onFallback`. Nothing
 * here renders, and nothing here swallows an error into a dead click — every
 * failure path ends in either the next engine or `onFatal`.
 */

export interface NativePlaybackTrack {
  id: string;
  label: string;
  language?: string;
  languageName?: string | null;
  codec?: string | null;
  codecLabel?: string | null;
  isExternal?: boolean;
}

export interface NativePlaybackHandlers {
  onState(state: NativeSnapshot): void;
  onTracks(audio: NativePlaybackTrack[], text: NativePlaybackTrack[], currentAudio: string, currentText: string): void;
  onEnd(): void;
  /** Called once when this engine cannot play the source. */
  onFallback(message: string, nextId: PlayerEngineId | null): void;
}

export interface NativePlaybackOptions {
  engine: NativeEngineId;
  chain: readonly PlayerEngineId[];
  surface: HTMLElement;
  url: string;
  /** Raw URL to retry once when `url` is the local header proxy and fails. */
  fallbackUrl?: string;
  headers?: Record<string, string>;
  startSeconds?: number;
  autoplay: boolean;
  isLive?: boolean;
  volume: number;
  rate: number;
  handlers: NativePlaybackHandlers;
}

export interface NativePlaybackSession {
  handle: NativeEngineHandle;
  stop(): void;
}

/** How long a normal stream may take to produce output before we move on. */
const START_GUARD_MS = 12_000;
/** Consecutive 2 s ticks without forward progress that count as a deep freeze. */
const LIVE_STALL_TICKS = 6;

/**
 * The session most recently started, if any. libmpv owns one global context and
 * Media3 one audio focus session, so a second session must always replace the
 * first — including one the player component no longer references because the
 * modal closed before its effect cleanup ran.
 */
let activeSession: NativePlaybackSession | null = null;

/**
 * Stop whatever native engine is currently running. Safe to call when nothing
 * is playing (the player modal calls it on close, which can happen after the
 * hook already tore its own session down).
 */
export function stopNativePlayback(): void {
  const session = activeSession;
  activeSession = null;
  session?.stop();
}

/**
 * Attaches and starts the engine. Returns synchronously with the session so the
 * caller can wire a teardown into its effect cleanup; the async start runs in
 * the background and reports problems through `handlers`.
 */
export function startNativePlayback(options: NativePlaybackOptions): NativePlaybackSession {
  const {
    engine, chain, surface, url, fallbackUrl, headers, startSeconds, autoplay, isLive, volume, rate, handlers,
  } = options;

  const handle = createNativeEngine(engine);  let stopped = false;
  let reported = false;
  let detach: (() => void) | null = null;
  let guard: number | null = null;
  let unsubscribers: Array<() => void> = [];

  let targetUrl = url;
  let retriedDirect = false;
  let sawOutput = false;
  let lastPosition = startSeconds ?? 0;
  let guardAttempt = 0;
  let guardDeadline = Date.now() + START_GUARD_MS;
  let liveLastPosition = 0;
  let liveStallTicks = 0;

  const rearm = () => {
    guardAttempt += 1;
    guardDeadline = Date.now() + START_GUARD_MS;
  };

  const fail = (message: string) => {
    if (stopped || reported) return;
    reported = true;
    const next = nextEngineInChain(chain, engine);
    if (next) handlers.onFallback(fallbackNotice(engine, next), next);
    else handlers.onFallback(message, null);
  };

  const subscribe = () => {
    unsubscribers = [
      handle.onState((state) => {
        if (stopped) return;
        if (state.currentTime > lastPosition + 0.05) sawOutput = true;
        if (state.currentTime > 0) lastPosition = state.currentTime;
        handlers.onState(state);
      }),
      handle.onTracks((tracks) => {
        if (stopped) return;
        const audio = tracks.filter((track) => track.type === 'audio');
        const text = tracks.filter((track) => track.type === 'sub');
        const audioTracks = audio.map((track, index) => ({
          id: `native-audio:${track.id}`,
          label: track.label || `Audio ${index + 1}`,
          language: track.language || undefined,
          languageName: resolveLanguageName(track.language),
          codec: track.codec || undefined,
          codecLabel: formatAudioCodec(track.codec),
        }));
        const textTracks = text.map((track, index) => ({
          id: `native-spu:${track.id}`,
          label: track.label || `Subtitle ${index + 1}`,
          language: track.language || undefined,
          languageName: resolveLanguageName(track.language),
          codec: track.codec || undefined,
          codecLabel: formatSubtitleCodec(track.codec),
          isExternal: track.external,
        }));
        const selectedAudio = audio.find((track) => track.selected);
        const selectedText = text.find((track) => track.selected);
        handlers.onTracks(
          audioTracks,
          textTracks,
          selectedAudio ? `native-audio:${selectedAudio.id}` : '',
          selectedText ? `native-spu:${selectedText.id}` : '',
        );
      }),
      handle.onEnd((reason, error) => {
        if (stopped) return;
        if (reason === 'Eof' || reason === 'EndFile' || reason === 'Stop') {
          handlers.onEnd();
          return;
        }
        fail(error || `Playback stopped (${reason}).`);
      }),
      handle.onError((message) => {
        if (stopped) return;
        // A transient error that playback recovers from is not a fallback: only
        // fail once nothing has been produced, or the engine has already told
        // us it stopped. The start guard covers the "never produced output" case.
        if (!sawOutput) fail(message || 'The native player could not open this stream.');
      }),
    ];
  };

  const startGuard = window.setInterval(() => {
    if (stopped) return;
    if (!sawOutput) {
      if (Date.now() < guardDeadline) return;
      if (!retriedDirect && fallbackUrl && fallbackUrl !== targetUrl && !fallbackUrl.startsWith('magnet:')) {
        retriedDirect = true;
        targetUrl = fallbackUrl;
        rearm();
        void handle.load(targetUrl, { headers, startSeconds: 0, autoplay, isLive }).catch(() => {
          fail('This stream could not be opened.');
        });
        return;
      }
      if (guardAttempt === 0) {
        rearm();
        void handle.load(targetUrl, { headers, startSeconds, autoplay, isLive }).catch(() => {
          fail('This stream could not be opened.');
        });
        return;
      }
      window.clearInterval(startGuard);
      fail('This stream did not start.');
      return;
    }
    // Output has been produced: only live streams get the freeze watchdog.
    if (!isLive) return;
    if (lastPosition > liveLastPosition + 0.5) {
      liveLastPosition = lastPosition;
      liveStallTicks = 0;
      return;
    }
    liveStallTicks += 1;
    if (liveStallTicks < LIVE_STALL_TICKS) return;
    liveStallTicks = 0;
    // One silent reconnect at the same position, then hand off to the next engine.
    if (guardAttempt === 0) {
      rearm();
      void handle.load(targetUrl, { headers, startSeconds: lastPosition, autoplay, isLive }).catch(() => {
        fail('This live stream froze.');
      });
      return;
    }
    window.clearInterval(startGuard);
    fail('This live stream froze.');
  }, 2000);
  guard = startGuard;

  void (async () => {
    try {
      detach = await handle.attach(surface);
      if (stopped) {
        detach?.();
        detach = null;
        return;
      }
      subscribe();
      await handle.load(targetUrl, { headers, startSeconds, autoplay, isLive });
      if (stopped) return;
      await handle.setVolume(volume);
      await handle.setRate(rate);
      if (!autoplay) await handle.pause();
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The native player could not start.');
    }
  })();

  const session: NativePlaybackSession = {
    handle,
    stop() {
      if (stopped) return;
      stopped = true;
      if (activeSession === session) activeSession = null;
      if (guard !== null) window.clearInterval(guard);
      guard = null;
      unsubscribers.forEach((off) => { try { off(); } catch { /* already detached */ } });
      unsubscribers = [];
      detach?.();
      detach = null;
      void handle.destroy();
    },
  };

  // Never leave a previous engine running underneath this one.
  const previous = activeSession;
  activeSession = session;
  previous?.stop();

  return session;
}
