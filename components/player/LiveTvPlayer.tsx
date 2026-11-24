// The Live TV player — a port of VyseTV's `lib/screens/live_tv/live_tv_player_page.dart`
// (GPL-3.0-or-later).
//
// VyseTV keeps two players apart. `PlayerPage` is the film player: audio and
// subtitle menus, an episode list, Next. `LiveTvPlayerPage` is this one — one
// channel from a list, its guide, the volume, and ↑/↓ to change channel. A
// portal's film or episode goes to the film player instead (`iptv_playback.dart`
// hands it to `PlayerPage`), which is why `live === false` still renders
// `PlayerModal` and never reaches this file.
//
// Playback is `useMpvEngine`, the same layer the film player drives, so the
// native path (mpv → Media3 → web) behaves identically in both.
//
// Ported: the channel list and its slide, zapping, the guide strip with its
// progress bar, the LIVE badge, the favourites star, volume and mute, the error
// card with Retry / Next channel, the four-second idle hide, the double tap that
// goes full screen, one-thing-per-press Back, and the key map (Space, ↑/↓, M, C,
// F, Esc, a remote's own keys, ←/→ to seek when the item is not live, ←/→ to
// raise the controls when it is, a controller's A and B through the Gamepad API).
//
// Not ported, and why:
//   · Watch-party sharing (`_share`) — it needs VyseTV's `PartyLive` rooms.
//   · The desktop `WindowBar` and hover tooltips — there is no window manager
//     or pointer-mode tracker here. Controls keep their `aria-label`s, so a
//     screen reader still reads them.
//   · D-pad focus regions (`DpadPicture`, `DpadRegion`) — PRAHA has no focus
//     model to attach to. Every control is a real button, so keyboard and remote
//     focus arrive through the browser and reach the same handlers. The keys
//     themselves are honoured: a controller's A and a numpad Enter raise the
//     controls, its B is Back. Back's one-thing-per-press layering is
//     unconditional here instead of gated on a D-pad (see `backKey`).
//   · `AudioFocus.claim` — Android's audio focus is claimed by the native
//     session inside `startNativePlayback`; there is no bridge to call here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, ListVideo, Maximize, Minimize, Pause, Play, RotateCcw,
  SignalZero, Star, Volume1, Volume2, VolumeX, X,
} from 'lucide-react';
import type { PlayerSettings } from '../../types';
import { buildIptvPlaybackAt, IptvZapStore, type IptvPlayback } from '../../services/liveTv/playback';
import { LiveFavorites } from '../../services/liveTv/liveFavorites';
import { epgProgress, guideTime, nowNext, type EpgProgram } from '../../services/liveTv/guide';
import { isAndroidApp, isAndroidTv, setImmersiveFullscreen } from '../../services/androidBridge';
import { useMpvEngine } from './useMpvEngine';
import './live-player.css';

/** How long the controls stay up after the last interaction (VyseTV: 4 s). */
const CHROME_IDLE_MS = 4_000;
/** The guide's clock: VyseTV rebuilt on every position tick, throttled to 200 ms. */
const CLOCK_TICK_MS = 200;
/** VyseTV's `Layout` breakpoint: under 640 px the layout is a phone's. */
const PHONE_MAX_WIDTH = 640;
/** A channel row in the panel (VyseTV's `Container(height: 52)`). */
const PANEL_ROW_HEIGHT = 52;
/** Rows built either side of the visible ones, so a fast flick does not show gaps. */
const PANEL_OVERSCAN = 6;

/** Whether the window is phone-width, from VyseTV's own breakpoint. */
function usePhoneWidth(): boolean {
  const read = () => (typeof window === 'undefined' ? false : window.innerWidth < PHONE_MAX_WIDTH);
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    const onChange = () => setPhone(read());
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }, []);
  return phone;
}

export interface LiveTvPlayerProps {
  /**
   * What to play: the channel list, where in it to start, and the first
   * channel already built. VyseTV's `openLivePlayer(context, items, index)`.
   */
  playback: IptvPlayback;
  settings: PlayerSettings;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
  autoplay: boolean;
  /** Shown once when the engine chain fell back (mpv → Media3 → web). */
  onNotice?: (message: string) => void;
  onClose: () => void;
}

const LiveTvPlayer: React.FC<LiveTvPlayerProps> = ({
  playback,
  settings,
  onSettingsChange,
  autoplay,
  onNotice,
  onClose,
}) => {
  // ── which channel is on ────────────────────────────────────────────────
  // Zapping moves this index and the engine is handed a new URL; the player
  // never remounts (VyseTV's `_zap` moves `_index` and calls `_open()`), so the
  // chrome, the guide and the volume survive a channel change.
  const items = playback.items;
  const [index, setIndex] = useState(() => Math.min(Math.max(playback.index, 0), Math.max(items.length - 1, 0)));

  const current = useMemo(
    () => (index === playback.index ? playback : buildIptvPlaybackAt(items, index)),
    [index, items, playback],
  );
  const { stream, live: meta } = current;
  const item = items[index] ?? items[0];

  // ── playback ───────────────────────────────────────────────────────────
  const [fatal, setFatal] = useState('');
  const onFatal = useCallback((message: string) => setFatal(message), []);

  const engine = useMpvEngine({
    url: item.url,
    forceWebEngine: false,
    playerEngine: settings.playerEngine,
    // The frozen-stream watchdog and low-latency buffering, for a live channel.
    // An item that is not live (`live: false`) keeps film buffering.
    isLive: meta.live,
    streamFormat: stream.format,
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
    videoRef, playing, waiting, currentTime, duration, volume, muted,
    play, pause, toggle, seekBy, setVolume, toggleMute, retry, nativeActive,
  } = engine;

  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Scroll offset of the channel list: VyseTV's `ListView.builder` builds only
  // the rows on screen, so a 5,000-channel playlist does not make 5,000 buttons.
  const [panelScroll, setPanelScroll] = useState(0);

  // A new channel starts clean: the last one's failure says nothing about this.
  useEffect(() => {
    setFatal('');
  }, [item.url]);

  // ── native surface transparency ────────────────────────────────────────
  // mpv and Media3 draw to a SurfaceView *behind* the WebView. This class is
  // what the CSS keys off, and the native plugin clears the WebView's own
  // background on attach; both are needed, which is what 2.11.24 fixed.
  useEffect(() => {
    if (!nativeActive) return;
    document.documentElement.classList.add('player-vlc-active');
    document.body.classList.add('player-vlc-active');
    document.getElementById('root')?.classList.add('player-vlc-active');
    return () => {
      document.documentElement.classList.remove('player-vlc-active');
      document.body.classList.remove('player-vlc-active');
      document.getElementById('root')?.classList.remove('player-vlc-active');
    };
  }, [nativeActive]);

  // Immersive + landscape lock, exactly as the film player opens.
  useEffect(() => {
    if (!isAndroidApp()) return;
    void setImmersiveFullscreen(true, settings.landscapeLock);
    return () => { void setImmersiveFullscreen(false, false); };
  }, [settings.landscapeLock]);

  // ── idle hide ──────────────────────────────────────────────────────────
  // Both flags are read through refs so `poke` keeps one identity: a new `poke`
  // on every play/pause tick would restart the timer and never let it fire.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const hideTimer = useRef<number | null>(null);
  const poke = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setChrome(true);
    hideTimer.current = window.setTimeout(() => {
      // VyseTV: `if (mounted && _playing && !_list)`. A paused channel keeps its
      // controls, and so does an open channel list.
      if (playingRef.current && !panelRef.current) setChrome(false);
    }, CHROME_IDLE_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [poke]);

  // A pause shows the controls again at once, rather than on the next mousemove.
  useEffect(() => {
    if (playing) return;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setChrome(true);
  }, [playing]);

  // ── zapping ────────────────────────────────────────────────────────────
  const zap = useCallback((direction: 1 | -1) => {
    if (items.length < 2) return;
    setIndex((at) => {
      const next = (at + direction + items.length) % items.length;
      // Keep the persisted list in step, so the bar's arrows carry on from here.
      const channel = items[next];
      if (channel) IptvZapStore.setCurrent(channel.url);
      return next;
    });
    poke();
  }, [items, poke]);

  const playAt = useCallback((at: number) => {
    const channel = items[at];
    if (!channel) return;
    IptvZapStore.setCurrent(channel.url);
    setIndex(at);
    poke();
  }, [items, poke]);

  // ── volume ─────────────────────────────────────────────────────────────
  const onVolume = useCallback((value: number) => {
    setVolume(value);
    poke();
  }, [poke, setVolume]);

  // ── full screen ────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const root = document.getElementById('live-tv-player-root');
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      setFullscreen(false);
      return;
    }
    if (!root?.requestFullscreen) return;
    void root.requestFullscreen()
      .then(() => setFullscreen(true))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /**
   * A second tap on the picture within 300 ms is a double tap — VyseTV works
   * this out by hand (`_isDoubleTap`) so the first tap still lands at once
   * instead of waiting for a possible second.
   *
   * VyseTV's `_toggleFullscreen` returns at once unless `isDesktopNative`: on a
   * phone the window already is the screen, so a double tap there changes
   * nothing at all — it does not even hide the controls. `isAndroidApp` is
   * PRAHA's version of that test; a desktop browser is the desktop case.
   */
  const lastTap = useRef<number | null>(null);
  /** VyseTV's `_toggleFullscreen` itself: a no-op where the window already is the screen. */
  const fullscreenToggle = useCallback(() => {
    if (isAndroidApp()) return;
    toggleFullscreen();
  }, [toggleFullscreen]);

  const onPictureTap = useCallback(() => {
    const now = Date.now();
    const double = lastTap.current !== null && now - lastTap.current < 300;
    lastTap.current = double ? null : now;
    if (double) { fullscreenToggle(); return; }
    // VyseTV's onTap: controls up → hide them; hidden → bring them back.
    if (chrome) setChrome(false);
    else poke();
  }, [chrome, fullscreenToggle, poke]);

  /** VyseTV's `_back()`: leave full screen first, else leave the player. */
  const close = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      setFullscreen(false);
      return;
    }
    onClose();
  }, [onClose]);

  /**
   * Back, one thing per press — VyseTV's `_backKey()`: close the channel list,
   * then hide the controls, then leave.
   *
   * VyseTV gates those first two steps on its D-pad focus model
   * (`_list && DpadPicture.dpad`, then `_picture.backToPicture()`, which needs
   * `dpad && onControls`), so with a mouse or a finger its Back skips straight
   * to leaving. That model is not ported, and a browser has no equivalent that
   * holds on touch (where the hardware Back is the platform's one-level gesture
   * and `:focus-visible` is never set), so the layering here is unconditional:
   * one press always undoes one thing, whatever the input.
   */
  const backKey = useCallback(() => {
    if (panel) { setPanel(false); poke(); return; }
    if (chrome) { setChrome(false); return; }
    close();
  }, [chrome, close, panel, poke]);

  // ── keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field in the chrome.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      // VyseTV: on the picture, ←/→ raise the controls for a live channel (OK's
      // job) and seek for anything else.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (meta.live) {
          if (!chrome) { poke(); event.preventDefault(); return; }
        } else {
          seekBy(event.key === 'ArrowLeft' ? -settings.seekStep : settings.seekStep);
          poke();
          event.preventDefault();
          return;
        }
      }

      switch (event.key) {
        case 'Escape':
        case 'GoBack':
        case 'BrowserBack':
          backKey();
          event.preventDefault();
          return;
        case ' ':
        case 'k':
        case 'K':
          toggle();
          poke();
          event.preventDefault();
          return;
        // VyseTV: ChannelUp → _zap(1), ChannelDown → _zap(-1).
        case 'ChannelUp':
        case 'MediaTrackNext':
          zap(1);
          event.preventDefault();
          return;
        case 'ChannelDown':
        case 'MediaTrackPrevious':
          zap(-1);
          event.preventDefault();
          return;
        // On the picture (controls hidden) ↑/↓ change channel, as in VyseTV; on
        // the controls they move between them, which is the browser's own job.
        case 'ArrowUp':
          if (!chrome) { zap(-1); event.preventDefault(); } else poke();
          return;
        case 'ArrowDown':
          if (!chrome) { zap(1); event.preventDefault(); } else poke();
          return;
        case 'Enter':
        case 'Select':
          // OK on the picture brings the controls up (VyseTV's `_enterControls`).
          // A numpad Enter reports `key: 'Enter'` here, so it lands on this branch
          // too — the same thing VyseTV binds to `numpadEnter`.
          if (!chrome) { poke(); event.preventDefault(); }
          return;
        case 'MediaPlayPause':
          toggle();
          poke();
          event.preventDefault();
          return;
        case 'MediaPlay':
          if (!playing) { play(); poke(); }
          event.preventDefault();
          return;
        case 'MediaPause':
          if (playing) { pause(); poke(); }
          event.preventDefault();
          return;
        case 'm':
        case 'M':
          toggleMute();
          poke();
          event.preventDefault();
          return;
        case 'c':
        case 'C':
          if (items.length > 1) setPanel((open) => !open);
          poke();
          event.preventDefault();
          return;
        case 'f':
        case 'F':
          fullscreenToggle();
          poke();
          event.preventDefault();
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    backKey, chrome, fullscreenToggle, items.length, meta.live, pause, play, playing,
    poke, seekBy, settings.seekStep, toggle, toggleMute, zap,
  ]);

  // A controller never produces a `keydown` in a browser — Flutter's
  // `gameButtonA`/`gameButtonB` arrive through the Gamepad API instead. Poll the
  // pads and fire on the edge, so A raises the controls and B is Back, the same
  // two bindings VyseTV carries. Only the standard-mapping buttons are read:
  // 0 is A/Cross, 1 is B/Circle.
  //
  // Only poll while a pad is attached: a permanent rAF loop would cost every
  // viewer of a live channel something, controller or not.
  //
  // `chrome` and Back are read through refs so the loop subscribes once: Back
  // changes identity whenever the controls do, and re-subscribing would reset
  // the edges and let a held B fire Back twice.
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const backRef = useRef(backKey);
  backRef.current = backKey;

  useEffect(() => {
    const pads = navigator.getGamepads;
    if (!pads) return;
    // `getGamepads` is typed `unknown[]` in this TS lib, so name the shape here.
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
        if (a && !chromeRef.current) poke();
      }
      if (b !== held.b) {
        held.b = b;
        if (b) backRef.current();
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
    // A pad can already be connected when the player opens (a TV remote that
    // presented itself to the page), so check once rather than wait for an event.
    if (attached()) start();

    return () => {
      stop();
      window.removeEventListener('gamepadconnected', onConnected);
      window.removeEventListener('gamepaddisconnected', onDisconnected);
    };
  }, [poke]);

  // ── guide ──────────────────────────────────────────────────────────────
  // One fetch per channel, then a tick so "now" and the bar move without
  // re-requesting. VyseTV reassigns `_epg = _item.epg?.call()` inside `_open()`,
  // which a Retry runs too — hence the `guideAsk` counter: a guide that failed
  // while the stream was failing is asked for again when the viewer retries.
  const [guide, setGuide] = useState<EpgProgram[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const [guideAsk, setGuideAsk] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setGuide([]);
    if (!meta.live || !meta.epg) return;
    meta.epg()
      .then((rows) => { if (!cancelled) setGuide(rows); })
      .catch(() => { if (!cancelled) setGuide([]); });
    return () => { cancelled = true; };
  }, [meta.epg, meta.live, item.url, guideAsk]);

  useEffect(() => {
    if (!meta.live) return;
    const timer = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [meta.live]);

  const { now, next } = useMemo(() => nowNext(guide, clock), [guide, clock]);
  const progress = useMemo(() => epgProgress(now, clock), [now, clock]);

  // ── favourites ─────────────────────────────────────────────────────────
  const favoriteKey = meta.favoriteKey;
  const [starred, setStarred] = useState(() => Boolean(favoriteKey && LiveFavorites.hasKey(favoriteKey)));

  useEffect(() => {
    if (!favoriteKey) { setStarred(false); return; }
    LiveFavorites.load();
    setStarred(LiveFavorites.hasKey(favoriteKey));
    // The star follows the store, so a change made elsewhere is reflected here.
    return LiveFavorites.subscribe(() => setStarred(LiveFavorites.hasKey(favoriteKey)));
  }, [favoriteKey]);

  const toggleStar = useCallback(() => {
    if (!favoriteKey) return;
    LiveFavorites.toggleChannel({
      key: favoriteKey,
      title: item.name,
      url: item.url,
      logo: item.logo,
      from: item.group,
    });
  }, [favoriteKey, item.group, item.logo, item.name, item.url]);

  // ── render ─────────────────────────────────────────────────────────────
  const tv = isAndroidTv();
  const phone = usePhoneWidth();
  const volumePercent = Math.round(volume);
  const silent = muted || volumePercent === 0;
  const VolumeIcon = silent ? VolumeX : volumePercent < 50 ? Volume1 : Volume2;

  // The panel's window. A channel list can be a playlist's 5,000 rows, so only
  // the slice in view is built — Dart's `ListView.builder`. The list scrolls, so
  // the range follows `panelScroll`; the height is a guess from the row count,
  // then corrected by the real box once it is laid out.
  const panelListRef = useRef<HTMLUListElement | null>(null);
  const [panelHeight, setPanelHeight] = useState(480);
  useEffect(() => {
    if (!panel) return;
    const el = panelListRef.current;
    if (!el) return;
    const measure = () => setPanelHeight(el.clientHeight || 480);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [panel]);

  // VyseTV's `autofocus: current`: the list opens on the channel that is on, so
  // the scroll offset is set to its row before the window is worked out — a
  // 3,000th channel cannot be scrolled to if the window starts at row 0.
  //
  // Keyed on the panel and the channel only: `panelHeight` is deliberately left
  // out, or every re-measure would yank the list back to the playing channel
  // while the viewer is scrolling it.
  useEffect(() => {
    if (!panel) return;
    const el = panelListRef.current;
    if (!el) return;
    const top = index * PANEL_ROW_HEIGHT;
    const span = el.clientHeight || 480;
    // Put the row in the middle-ish of the list, as `autofocus` does.
    el.scrollTop = Math.max(0, top - Math.floor(span / 2) + PANEL_ROW_HEIGHT / 2);
    setPanelScroll(el.scrollTop);
  }, [panel, index]);

  const firstRow = Math.max(0, Math.floor(panelScroll / PANEL_ROW_HEIGHT) - PANEL_OVERSCAN);
  const rowsInView = Math.ceil(panelHeight / PANEL_ROW_HEIGHT) + PANEL_OVERSCAN * 2;
  const lastRow = Math.min(items.length, firstRow + rowsInView);

  return (
    <div
      id="live-tv-player-root"
      className={`ltvp-root ${chrome ? 'chrome-on' : 'chrome-off'} ${nativeActive ? 'is-native' : ''}`}
      style={{ background: nativeActive ? 'transparent' : '#000' }}
      onMouseMove={poke}
      onTouchStart={poke}
      onClick={onPictureTap}
    >
      <video
        ref={videoRef}
        playsInline
        className="ltvp-video"
        style={{
          opacity: nativeActive ? 0 : 1,
          pointerEvents: nativeActive ? 'none' : 'auto',
          background: nativeActive ? 'transparent' : '#000',
        }}
      />

      {waiting && !fatal && (
        <div className="ltvp-spinner" role="status" aria-label="Loading channel">
          <span />
        </div>
      )}

      {fatal && (
        <div className="ltvp-error" role="alert" onClick={(event) => event.stopPropagation()}>
          <SignalZero size={32} />
          <h2>This stream isn&apos;t playing</h2>
          <p>The source may be offline or busy.</p>
          <p className="ltvp-error-detail">{fatal}</p>
          <div className="ltvp-error-actions">
            <button type="button" onClick={() => { setFatal(''); setGuideAsk((n) => n + 1); retry(); }}>
              <RotateCcw size={15} /> Retry
            </button>
            {items.length > 1 && (
              <button type="button" onClick={() => { setFatal(''); zap(1); }}>Next channel</button>
            )}
          </div>
        </div>
      )}

      {/* Top: back, logo, title, LIVE, star, channel list. */}
      <div className="ltvp-top" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="ltvp-glass" onClick={close} aria-label="Back (Esc)">
          <ChevronLeft size={20} />
        </button>
        {item.logo && (
          <img
            className="ltvp-logo"
            src={item.logo}
            alt=""
            onError={(event) => { event.currentTarget.style.display = 'none'; }}
          />
        )}
        <div className="ltvp-titles">
          <strong>{item.name}</strong>
          {item.group && <span>{item.group}</span>}
        </div>
        {meta.live && <span className="ltvp-live"><i />LIVE</span>}
        {favoriteKey && (
          <button
            type="button"
            className={`ltvp-glass ${starred ? 'is-on' : ''}`}
            onClick={toggleStar}
            aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={starred}
          >
            <Star size={18} fill={starred ? 'currentColor' : 'none'} />
          </button>
        )}
        {items.length > 1 && (
          <button
            type="button"
            className={`ltvp-glass ${panel ? 'is-on' : ''}`}
            onClick={() => { setPanel((open) => !open); poke(); }}
            aria-label="Channels (C)"
            aria-expanded={panel}
          >
            <ListVideo size={18} />
          </button>
        )}
      </div>

      {/* Bottom: guide (live) or a seek bar (not), then the transport row. */}
      <div className="ltvp-bottom" onClick={(event) => event.stopPropagation()}>
        {meta.live && now && (
          <div className="ltvp-guide">
            <div className="ltvp-guide-row">
              <span className="ltvp-guide-now">NOW</span>
              <span className="ltvp-guide-title">{now.title}</span>
              <span className="ltvp-guide-time">
                {guideTime(now.startMs)} – {guideTime(now.stopMs)}
              </span>
            </div>
            <div className="ltvp-guide-bar">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            {next && (
              <div className="ltvp-guide-next">
                Next&nbsp;&nbsp;{guideTime(next.startMs)}&nbsp;&nbsp;{next.title}
              </div>
            )}
          </div>
        )}

        {!meta.live && duration > 0 && (
          <div className="ltvp-guide">
            <div className="ltvp-guide-bar">
              <span style={{ width: `${Math.round((currentTime / duration) * 100)}%` }} />
            </div>
          </div>
        )}

        <div className="ltvp-transport">
          {items.length > 1 && (
            <button type="button" className="ltvp-key" onClick={() => zap(-1)} aria-label="Previous channel (↑)">
              <ChevronLeft size={20} />
            </button>
          )}
          <button
            type="button"
            className="ltvp-key ltvp-play"
            onClick={() => { toggle(); poke(); }}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>
          {items.length > 1 && (
            <button type="button" className="ltvp-key" onClick={() => zap(1)} aria-label="Next channel (↓)">
              <ChevronRight size={20} />
            </button>
          )}

          {!meta.live && (
            <>
              <button
                type="button"
                className="ltvp-key"
                onClick={() => { seekBy(-settings.seekStep); poke(); }}
                aria-label="Seek back"
              >
                −{settings.seekStep}s
              </button>
              <button
                type="button"
                className="ltvp-key"
                onClick={() => { seekBy(settings.seekStep); poke(); }}
                aria-label="Seek forward"
              >
                +{settings.seekStep}s
              </button>
            </>
          )}

          {/* On a TV the remote sets the volume (VyseTV: `playersHaveVolume`). The
              slider is a mouse's, so VyseTV hides it on a phone and leaves Mute. */}
          {!tv && (
            <>
              <button type="button" className="ltvp-key" onClick={() => { toggleMute(); poke(); }} aria-label="Mute (M)">
                <VolumeIcon size={20} />
              </button>
              {!phone && (
                <input
                  className="ltvp-volume"
                  type="range"
                  min={0}
                  max={100}
                  value={silent ? 0 : volumePercent}
                  onChange={(event) => onVolume(Number(event.target.value))}
                  aria-label="Volume"
                />
              )}
            </>
          )}

          <span className="ltvp-spacer" />
          {/* VyseTV draws this only where a window can be made full screen. */}
          {!isAndroidApp() && (
            <button
              type="button"
              className="ltvp-key"
              onClick={() => { fullscreenToggle(); poke(); }}
              aria-label="Full screen (F)"
            >
              {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          )}
        </div>
      </div>

      {/* Channel list, sliding in from the right (VyseTV's AnimatedPositioned). */}
      <div
        className={`ltvp-panel ${panel ? 'is-open' : ''}`}
        onClick={(event) => event.stopPropagation()}
        aria-hidden={!panel}
      >
        <header>
          <span>Channels</span>
          <button type="button" onClick={() => setPanel(false)} aria-label="Close channel list"><X size={15} /></button>
        </header>
        <ul
          ref={panelListRef}
          onScroll={(event) => setPanelScroll(event.currentTarget.scrollTop)}
        >
          {/* One spacer list item takes the whole list's height, so the scrollbar
              is right for 5,000 rows while only the window is in the DOM. The
              rows sit absolutely inside it at their own offsets. */}
          <li
            className="ltvp-panel-spacer"
            style={{ height: items.length * PANEL_ROW_HEIGHT, position: 'relative' }}
          >
            {items.slice(firstRow, lastRow).map((channel, offset) => {
              const at = firstRow + offset;
              return (
                <button
                  key={`${channel.url}-${at}`}
                  type="button"
                  data-row={at}
                  className={`ltvp-panel-row ${at === index ? 'is-current' : ''}`}
                  style={{ top: at * PANEL_ROW_HEIGHT }}
                  onClick={() => playAt(at)}
                >
                  {channel.logo
                    ? <img src={channel.logo} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                    : <span className="ltvp-panel-blank" />}
                  <span>{channel.name}</span>
                </button>
              );
            })}
          </li>
        </ul>
      </div>
    </div>
  );
};

export default LiveTvPlayer;
