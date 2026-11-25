// The channel playing inside the portal browser — a port of VyseTV's
// `lib/screens/live_tv/portal_browser_player.dart` (GPL-3.0-or-later).
//
// This is not the same player as `LiveTvPlayer`. That one is
// `LiveTvPlayerPage`: it takes the whole window, is opened from a list and
// closed again. This one lives inside the portal browser's watch pane. It has
// no open/close of its own — picking another channel reopens the stream in
// place, and `expanded` only moves the widget (pane ↔ full window), so
// expanding never reconnects the stream. VyseTV holds it under a GlobalKey for
// exactly that reason.
//
// Ported: the pane/full-screen model, opening a channel and reopening when the
// address changes, play/pause, stepping through the list with ↑ ↓ and a
// remote's channel keys, mute and the volume slider, the four-second idle hide
// (only while it is actually playing), the mouse leaving the pane hiding the
// controls, the double tap / double click that expands, the `roomy` breakpoint
// at 470 px, the top bar that exists only in full screen, the now/next strip
// slot, the error card with Retry / Next channel, and the key map (Space, K, M,
// F, Esc/Back, MediaPlayPause, ChannelUp/Down, and in full screen ←/→/Enter to
// raise the controls).
//
// Not ported, and why:
//   · Watch-party sharing (`_share`, the room handoff) — it needs VyseTV's
//     `PartyLive` rooms, which PRAHA has no equivalent of.
//   · `DpadPicture` / `FocusableWrapper` focus regions — PRAHA has no D-pad
//     focus model to attach to. Every control is a real button, so a keyboard
//     or a remote reaches them through the browser. Consequence: `_held` (the
//     pane staying lit while focus sits on one of its buttons) is always false,
//     so in the pane the idle timer hides the controls as it would for a mouse.
//   · `AudioFocus.claim` — the native session inside `startNativePlayback`
//     claims Android's audio focus.
//   · `didChangeDependencies`'s stop-when-covered — here the browser page
//     unmounts when another page opens, which tears the engine down the same
//     way. `_stopped` survives only for the sharing handoff, which is not
//     ported, so the player has no stopped state to re-enter.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Maximize, Minimize, Pause, Play, SkipBack, SkipForward,
  SignalZero, VolumeX, Volume2,
} from 'lucide-react';
import type { PlayerSettings } from '../../types';
import type { LiveItem } from '../../services/liveTv/liveItems';
import { detectIptvFormat } from '../../services/liveTv/playback';
import { isAndroidTv } from '../../services/androidBridge';
import { useMpvEngine } from './useMpvEngine';
import './live-player.css';

/** How long the controls stay up after the last interaction (VyseTV: 4 s). */
const CHROME_IDLE_MS = 4_000;
/** VyseTV's `LayoutBuilder`: wider than this and the pane is "roomy". */
const ROOMY_MIN_WIDTH = 470;

/** Whether the element is at least `ROOMY_MIN_WIDTH` wide, followed as it resizes. */
function useWidthAtLeast(minWidth: number): [(el: HTMLElement | null) => void, boolean] {
  const [wide, setWide] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= minWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, [minWidth]);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [attach, wide];
}

export interface BrowserLivePlayerProps {
  /** The channel. A change of `url` reopens the stream, as VyseTV's `didUpdateWidget`. */
  item: LiveItem;
  /** Pane, or the whole window. Moving between them never reconnects the stream. */
  expanded: boolean;
  /** Pane: take the whole window. Full screen: back to the browser. */
  onExpand: () => void;
  /** Previous (-1) or next (1) channel in the list; absent when there is only one. */
  onStep?: (direction: 1 | -1) => void;
  /** Now / next over the picture. VyseTV draws it in full screen only. */
  guide?: React.ReactNode;
  settings: PlayerSettings;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
  autoplay?: boolean;
  onNotice?: (message: string) => void;
}

const BrowserLivePlayer: React.FC<BrowserLivePlayerProps> = ({
  item,
  expanded,
  onExpand,
  onStep,
  guide,
  settings,
  onSettingsChange,
  autoplay = true,
  onNotice,
}) => {
  // ── playback ───────────────────────────────────────────────────────────
  const [fatal, setFatal] = useState('');
  const onFatal = useCallback((message: string) => setFatal(message), []);

  const engine = useMpvEngine({
    url: item.url,
    forceWebEngine: false,
    playerEngine: settings.playerEngine,
    // A channel in the browser is live: the frozen-stream watchdog and
    // low-latency buffering apply here exactly as they do in the full player.
    isLive: true,
    streamFormat: detectIptvFormat(item.url),
    subtitles: [],
    autoplay,
    volume: settings.volume,
    speed: 1,
    landscapeLock: settings.landscapeLock,
    initialTime: 0,
    onFatalError: onFatal,
    onSettingsChange,
    onEngineFallback: (message) => onNotice?.(message),
  });
  const {
    videoRef, playing, waiting, volume, muted,
    play, pause, toggle, setVolume, toggleMute, retry, nativeActive,
  } = engine;

  // A new channel starts clean: the last one's failure says nothing about this.
  useEffect(() => {
    setFatal('');
  }, [item.url]);

  // ── native surface transparency ────────────────────────────────────────
  // mpv and Media3 draw to a SurfaceView *behind* the WebView, so every element
  // between the page root and this player has to stop painting or the picture
  // is covered. The full player does that by hiding the app shell outright;
  // an inline pane cannot, so this class only clears the backgrounds of the
  // chain above it (see `.player-pane-active` in live-player.css) while leaving
  // the sibling panes opaque.
  useEffect(() => {
    if (!nativeActive) return;
    const classes = ['player-pane-active'];
    document.documentElement.classList.add(...classes);
    document.body.classList.add(...classes);
    document.getElementById('root')?.classList.add(...classes);
    return () => {
      document.documentElement.classList.remove(...classes);
      document.body.classList.remove(...classes);
      document.getElementById('root')?.classList.remove(...classes);
    };
  }, [nativeActive]);

  // ── idle hide ──────────────────────────────────────────────────────────
  const [chrome, setChrome] = useState(true);
  // Read through refs so `poke` keeps one identity: a new `poke` on every
  // play/pause tick would restart the timer and it would never fire.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const fatalRef = useRef(fatal);
  fatalRef.current = fatal;

  const hideTimer = useRef<number | null>(null);
  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  /** VyseTV's `_poke`: show the controls and restart the idle timer. */
  const poke = useCallback(() => {
    clearHide();
    setChrome(true);
    hideTimer.current = window.setTimeout(() => {
      // VyseTV: `if (mounted && _playing && !_stopped && _error == null && !_held)`.
      // A paused or failed channel keeps its controls.
      if (playingRef.current && !fatalRef.current) setChrome(false);
    }, CHROME_IDLE_MS);
  }, [clearHide]);

  useEffect(() => {
    poke();
    return clearHide;
  }, [clearHide, poke]);

  // A pause shows the controls again at once, rather than on the next mousemove.
  useEffect(() => {
    if (playing) return;
    clearHide();
    setChrome(true);
  }, [clearHide, playing]);

  // ── back ───────────────────────────────────────────────────────────────
  /**
   * VyseTV's `_backKey`: in full screen, with the controls up, Back hides them
   * and returns to the picture; otherwise it returns to the list.
   *
   * VyseTV only hides them when its D-pad focus model says focus is on a
   * control (`_picture.backToPicture()`); that model is not ported, so the
   * first press always hides the controls in full screen. The second press —
   * with them hidden — goes back, which is the same two-step a D-pad gets.
   */
  const backKey = useCallback(() => {
    if (expanded && chrome) {
      clearHide();
      setChrome(false);
      return;
    }
    onExpand();
  }, [chrome, clearHide, expanded, onExpand]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const onHardwareBack = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      backKey();
    };
    window.addEventListener('praha:hardware-back', onHardwareBack, true);
    return () => window.removeEventListener('praha:hardware-back', onHardwareBack, true);
  }, [backKey, expanded]);

  // ── expand / step ──────────────────────────────────────────────────────
  /** VyseTV's `_step`: hand the direction to the page, then restart the timer. */
  const step = useCallback((direction: 1 | -1) => {
    onStep?.(direction);
    poke();
  }, [onStep, poke]);

  /** A double tap / double click on the picture expands, in either direction. */
  const lastTap = useRef<number | null>(null);
  const isDoubleTap = useCallback(() => {
    const now = Date.now();
    const hit = lastTap.current !== null && now - lastTap.current < 300;
    lastTap.current = hit ? null : now;
    return hit;
  }, []);

  const onPictureTap = useCallback(() => {
    if (isDoubleTap()) {
      poke();
      onExpand();
      return;
    }
    // VyseTV's onTap: controls up while playing → hide them; otherwise show them.
    if (chrome && playing) setChrome(false);
    else poke();
  }, [chrome, isDoubleTap, onExpand, playing, poke]);

  // ── keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      // A slider is a real input: its own arrow keys must win.
      if (target && target.tagName === 'SELECT') return;

      // Back is bound only where there is a full screen to leave (VyseTV gates
      // its whole Back group on `full`); in the pane Esc belongs to the page.
      if (expanded) {
        if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
          backKey();
          event.preventDefault();
          return;
        }
      }

      switch (event.key) {
        case 'f':
        case 'F':
          onExpand();
          poke();
          event.preventDefault();
          return;
        case ' ':
          if (target instanceof HTMLElement && target.closest('button, a[href], [role="button"]')) return;
          // Fall through for the picture and other playback shortcuts.
        case 'k':
        case 'K':
          toggle();
          poke();
          event.preventDefault();
          return;
        case 'm':
        case 'M':
          toggleMute();
          poke();
          event.preventDefault();
          return;
        case 'MediaPlayPause':
          toggle();
          poke();
          event.preventDefault();
          return;
        case 'ChannelUp':
          step(1);
          event.preventDefault();
          return;
        case 'ChannelDown':
          step(-1);
          event.preventDefault();
          return;
        case 'ArrowUp':
          // On the picture ↑ steps back a channel; on the controls it belongs
          // to the browser's own focus movement.
          if (expanded && !chrome && onStep) { step(-1); event.preventDefault(); }
          return;
        case 'ArrowDown':
          if (expanded && !chrome && onStep) { step(1); event.preventDefault(); }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Enter':
        case 'Select':
          // VyseTV's `_enterControls`, full screen only: OK (or a sideways
          // press) on the picture brings the controls up.
          if (expanded && !chrome) { poke(); event.preventDefault(); }
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [backKey, chrome, expanded, onExpand, onStep, poke, step, toggle, toggleMute]);

  // A controller never produces a `keydown` in a browser. VyseTV binds a pad's
  // B to Back (full screen only) and A to raising the controls, so poll the
  // pads on the edge — only while one is attached, since a permanent rAF loop
  // would cost every viewer of a channel something.
  const backRef = useRef(backKey);
  backRef.current = backKey;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useEffect(() => {
    const pads = navigator.getGamepads;
    if (!pads) return;
    const read = () => Array.from(pads.call(navigator) ?? []) as readonly (Gamepad | null)[];
    const attached = () => read().some(Boolean);
    const held = { a: false, b: false };
    let frame = 0;

    const tick = () => {
      const list = read();
      const a = list.some((pad) => pad?.buttons[0]?.pressed);
      const b = list.some((pad) => pad?.buttons[1]?.pressed);
      if (a !== held.a) {
        held.a = a;
        if (a && expandedRef.current && !chromeRef.current) poke();
      }
      if (b !== held.b) {
        held.b = b;
        if (b && expandedRef.current) backRef.current();
      }
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => { if (!frame) frame = window.requestAnimationFrame(tick); };
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      held.a = false;
      held.b = false;
    };
    const onConnected = () => start();
    const onDisconnected = () => { if (!attached()) stop(); };

    window.addEventListener('gamepadconnected', onConnected);
    window.addEventListener('gamepaddisconnected', onDisconnected);
    if (attached()) start();

    return () => {
      stop();
      window.removeEventListener('gamepadconnected', onConnected);
      window.removeEventListener('gamepaddisconnected', onDisconnected);
    };
  }, [poke]);

  // VyseTV pokes when it comes into or out of full screen.
  useEffect(() => {
    poke();
  }, [expanded, poke]);

  // ── render ─────────────────────────────────────────────────────────────
  const [attachWidth, roomy] = useWidthAtLeast(ROOMY_MIN_WIDTH);
  const tv = isAndroidTv();
  const full = expanded;
  const stepping = Boolean(onStep);
  const volumePercent = Math.round(volume);
  const silent = muted || volumePercent === 0;
  // VyseTV: `_touch` is a phone's big targets. PRAHA drives the same choice
  // from the pointer, which is what a touchscreen reports.
  const touch = useMemo(
    () => (typeof window === 'undefined' ? false : window.matchMedia?.('(pointer: coarse)').matches ?? false),
    [],
  );
  const buttonSize = touch ? 44 : 36;
  const VolumeIcon = silent ? VolumeX : Volume2;

  return (
    <div
      ref={attachWidth}
      className={`blp-root ${full ? 'is-full' : 'is-pane'} ${chrome ? 'chrome-on' : 'chrome-off'} ${nativeActive ? 'is-native' : ''}`}
      role={full ? 'dialog' : undefined}
      aria-modal={full || undefined}
      aria-label={full ? item.title : undefined}
      onMouseMove={poke}
      onTouchStart={poke}
      onClick={onPictureTap}
      onMouseLeave={() => {
        // In the pane the controls leave with the mouse (VyseTV's
        // `MouseRegion.onExit`); full screen they stay until the timer says so.
        if (!full && playing && chrome && !fatal) setChrome(false);
      }}
    >
      <video
        ref={videoRef}
        playsInline
        className="blp-video"
        style={{
          opacity: nativeActive ? 0 : 1,
          pointerEvents: nativeActive ? 'none' : 'auto',
          background: nativeActive ? 'transparent' : '#000',
        }}
      />

      {waiting && !fatal && (
        <div className="blp-spinner" role="status" aria-label="Loading channel" data-size={full ? 'full' : 'pane'}>
          <span />
        </div>
      )}

      {fatal && (
        <div className="blp-error" role="alert" onClick={(event) => event.stopPropagation()}>
          <SignalZero size={28} />
          <h2>This stream isn&apos;t playing</h2>
          <p>The source may be offline or busy.</p>
          <p className="blp-error-detail">{fatal}</p>
          <div className="blp-error-actions">
            <button type="button" onClick={() => { setFatal(''); retry(); poke(); }}>Retry</button>
            {stepping && (
              <button type="button" onClick={() => { setFatal(''); step(1); }}>Next channel</button>
            )}
          </div>
        </div>
      )}

      <div className="blp-chrome" inert={!chrome} onClick={(event) => event.stopPropagation()}>
        {full && (
          <div className="blp-top">
            <button type="button" className="blp-glass" onClick={onExpand} aria-label="Back to the list (Esc)">
              <ArrowLeft size={20} />
            </button>
            {item.logo && (
              <img
                className="blp-logo"
                src={item.logo}
                alt=""
                onError={(event) => { event.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="blp-titles">
              <strong>{item.title}</strong>
              {item.subtitle && <span>{item.subtitle}</span>}
            </div>
            <span className="blp-live"><i />LIVE</span>
          </div>
        )}

        <div className="blp-bottom">
          {full && guide ? <div className="blp-guide-slot">{guide}</div> : null}
          <div className="blp-transport">
            {stepping && (full || roomy) && (
              <button
                type="button"
                className="blp-btn"
                style={{ width: buttonSize, height: buttonSize }}
                onClick={() => step(-1)}
                aria-label="Previous channel (↑)"
              >
                <SkipBack size={buttonSize * 0.52} fill="currentColor" />
              </button>
            )}
            <button
              type="button"
              className="blp-btn is-play"
              style={{ width: buttonSize, height: buttonSize }}
              onClick={() => { toggle(); poke(); }}
              aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playing
                ? <Pause size={buttonSize * 0.52} fill="currentColor" />
                : <Play size={buttonSize * 0.52} fill="currentColor" />}
            </button>
            {stepping && (
              <button
                type="button"
                className="blp-btn"
                style={{ width: buttonSize, height: buttonSize }}
                onClick={() => step(1)}
                aria-label="Next channel (↓)"
              >
                <SkipForward size={buttonSize * 0.52} fill="currentColor" />
              </button>
            )}

            {/* On a TV the remote sets the volume (VyseTV: `playersHaveVolume`). */}
            {!tv && (
              <button
                type="button"
                className="blp-btn"
                style={{ width: buttonSize, height: buttonSize }}
                onClick={() => { toggleMute(); poke(); }}
                aria-label="Mute (M)"
              >
                <VolumeIcon size={buttonSize * 0.52} />
              </button>
            )}
            {/* VyseTV: a mouse's slider, so it is shown only where the pane is
                roomy and the input is not a touchscreen. */}
            {roomy && !touch && !tv && (
              <input
                className="blp-volume"
                style={{ width: full ? 130 : 96 }}
                type="range"
                min={0}
                max={100}
                value={silent ? 0 : volumePercent}
                onChange={(event) => { setVolume(Number(event.target.value)); poke(); }}
                aria-label="Volume"
              />
            )}

            <span className="blp-spacer" />
            <button
              type="button"
              className="blp-btn"
              style={{ width: buttonSize, height: buttonSize }}
              onClick={() => { onExpand(); poke(); }}
              aria-label={full ? 'Back to the list (Esc)' : 'Full screen (F)'}
            >
              {full
                ? <Minimize size={buttonSize * 0.52} />
                : <Maximize size={buttonSize * 0.52} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BrowserLivePlayer;
