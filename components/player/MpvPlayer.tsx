import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AudioLines, Captions, CaptionsOff, Check, ChevronLeft, ChevronRight, CirclePlay, CircleX,
  Gauge, Keyboard, Maximize, Minimize, Pause, PictureInPicture2, Play, Repeat, Repeat1, Scissors,
  Settings2, SkipBack, SkipForward, SlidersHorizontal, Sun, Volume1, Volume2, VolumeX, X,
} from 'lucide-react';
import type { PlayerSettings, StreamResult } from '../../types';
import { clamp, formatBitrate, formatSpeed, formatTime, streamHost } from './format';
import { SHORTCUTS, SHORTCUT_GROUPS } from './shortcuts';
import { getTheme, PLAYBACK_SPEEDS } from './themes';
import { useMpvEngine } from './useMpvEngine';
import './mpv-player.css';

type MenuId = 'speed' | 'quality' | 'audio' | 'subs' | 'settings' | 'help' | null;

interface MpvPlayerProps {
  stream: StreamResult;
  autoplay: boolean;
  settings: PlayerSettings;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
  onRequestClose: () => void;
}

/**
 * In-browser player modelled on mpvRx: an auto-hiding on-screen controller,
 * mpv key bindings, an OSD for transient state, quality/audio/subtitle menus,
 * a statistics overlay, and touch gestures (double-tap seek, swipe
 * volume/brightness, long-press speed boost).
 */
const MpvPlayer: React.FC<MpvPlayerProps> = ({ stream, autoplay, settings, onSettingsChange, onRequestClose }) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const seekRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const speedBoostRef = useRef<number | null>(null);
  const gestureRef = useRef<{ x: number; y: number; mode: 'none' | 'seek' | 'volume' | 'brightness'; base: number } | null>(null);
  const tapRef = useRef<{ time: number; zone: 'left' | 'center' | 'right' } | null>(null);
  const osdTimer = useRef<number | null>(null);

  const [fatal, setFatal] = useState('');
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState<MenuId>(null);
  const [osd, setOsd] = useState('');
  const [scrub, setScrub] = useState<{ ratio: number; seconds: number } | null>(null);
  const [gestureLabel, setGestureLabel] = useState('');
  const [ripple, setRipple] = useState<{ id: number; side: 'left' | 'right'; label: string } | null>(null);
  const [statsOpen, setStatsOpen] = useState(settings.stats);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const subtitles = useMemo(() => stream.subtitles || [], [stream.subtitles]);

  const flash = useCallback((message: string) => {
    setOsd(message);
    if (osdTimer.current) window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(''), 1200);
  }, []);

  const onFatalError = useCallback((message: string) => setFatal(message), []);

  const engine = useMpvEngine({
    url: stream.url,
    subtitles,
    autoplay,
    volume: settings.volume,
    speed: settings.speed,
    onFatalError,
    onSettingsChange,
  });
  const {
    videoRef, ready, waiting, playing, currentTime, duration, buffered, volume, muted, rate,
    levels, currentLevel, audioTracks, currentAudio, textTracks, currentText, stats, loop,
  } = engine;

  const theme = getTheme(settings.theme);
  const themeVars = useMemo(() => theme.vars as React.CSSProperties, [theme]);

  /** Auto-hide the controller like mpv's OSC. */
  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (settings.oscTimeout > 0) {
      hideTimer.current = window.setTimeout(() => {
        if (!menu) setControlsVisible(false);
      }, settings.oscTimeout);
    }
  }, [settings.oscTimeout, menu]);

  useEffect(() => {
    wakeControls();
    return () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); };
  }, [wakeControls]);

  useEffect(() => {
    if (menu) setControlsVisible(true);
  }, [menu]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const seek = useCallback((seconds: number, label?: string) => {
    engine.seekBy(seconds);
    flash(label ?? `${seconds > 0 ? '+' : ''}${Math.round(seconds)}s`);
    wakeControls();
  }, [engine, flash, wakeControls]);

  const changeVolume = useCallback((percent: number, showOsd = true) => {
    engine.setVolume(percent);
    if (showOsd) flash(`Volume ${clamp(Math.round(percent), 0, 100)}%`);
  }, [engine, flash]);

  const changeSpeed = useCallback((next: number) => {
    engine.setSpeed(next);
    flash(`Speed ${formatSpeed(clamp(Number(next.toFixed(2)), 0.25, 4))}`);
  }, [engine, flash]);

  const jumpRatio = useCallback((ratio: number) => {
    if (!duration) return;
    engine.seekTo(duration * ratio);
    flash(formatTime(duration * ratio));
  }, [duration, engine, flash]);

  /** Keyboard map, mirroring the most useful mpv bindings. */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      const key = event.key;
      const step = settings.seekStep;

      if (key === 'Escape') {
        if (menu) { setMenu(null); return; }
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => undefined); return; }
        onRequestClose();
        return;
      }
      if (key === ' ' || key.toLowerCase() === 'k') {
        event.preventDefault();
        engine.toggle();
        flash(playing ? 'Pause' : 'Play');
        return;
      }
      switch (key) {
        case 'ArrowLeft': seek(event.shiftKey ? -60 : -step); break;
        case 'ArrowRight': seek(event.shiftKey ? 60 : step); break;
        case 'ArrowUp': event.preventDefault(); changeVolume(volume + 5); break;
        case 'ArrowDown': event.preventDefault(); changeVolume(volume - 5); break;
        case ',': engine.stepFrame(-1); flash('Frame −'); break;
        case '.': engine.stepFrame(1); flash('Frame +'); break;
        case '[': changeSpeed(rate - 0.1); break;
        case ']': changeSpeed(rate + 0.1); break;
        case '{': changeSpeed(rate / 2); break;
        case '}': changeSpeed(rate * 2); break;
        case 'Backspace': changeSpeed(1); break;
        case 'm': case 'M': engine.toggleMute(); flash(muted ? 'Unmute' : 'Mute'); break;
        case 'j': case 'J': engine.cycleText(key === 'J' ? -1 : 1); flash('Subtitle track'); break;
        case '#': engine.cycleAudio(); flash('Audio track'); break;
        case 'c': case 'C':
          engine.selectText(currentText ? '' : (textTracks[0]?.id || ''));
          flash(currentText ? 'Subtitles off' : 'Subtitles on');
          break;
        case 'q': case 'Q': onSettingsChange({ subtitleSize: clamp(settings.subtitleSize - 10, 50, 300) }); flash('Subtitles smaller'); break;
        case 'w': case 'W': onSettingsChange({ subtitleSize: clamp(settings.subtitleSize + 10, 50, 300) }); flash('Subtitles larger'); break;
        case 'f': case 'F': engine.toggleFullscreen(); break;
        case 'p': case 'P': engine.togglePip(); break;
        case 'i': case 'I': setStatsOpen((open) => !open); break;
        case 'l': case 'L': engine.toggleLoop(); flash(loop.b !== null ? 'Loop cleared' : loop.a !== null ? 'Loop B set' : 'Loop A set'); break;
        case 's': case 'S': engine.saveFrame(); break;
        case '?': case 'h': case 'H': setMenu((current) => (current === 'help' ? null : 'help')); break;
        default:
          if (/^[0-9]$/.test(key)) jumpRatio(Number(key) * 10);
      }
      wakeControls();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [engine, flash, jumpRatio, loop, menu, muted, currentText, textTracks, onRequestClose, playing, rate, settings.seekStep, settings.subtitleSize, onSettingsChange, changeSpeed, changeVolume, seek, volume, wakeControls]);

  /** Seek bar interaction (click, drag, hover preview). */
  const ratioFromEvent = (clientX: number) => {
    const bar = seekRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const onScrubMove = (event: React.PointerEvent) => {
    if (!duration) return;
    const ratio = ratioFromEvent(event.clientX);
    setScrub({ ratio, seconds: ratio * duration });
    if (event.buttons === 1) { engine.seekTo(ratio * duration); wakeControls(); }
  };

  const onScrubCommit = (event: React.PointerEvent) => {
    if (!duration) return;
    engine.seekTo(ratioFromEvent(event.clientX) * duration);
    setScrub(null);
    wakeControls();
  };

  /** Touch gestures, mirroring mpvRx's tap zones and swipe controls. */
  const zoneOf = (clientX: number): 'left' | 'center' | 'right' => {
    const stage = stageRef.current;
    if (!stage) return 'center';
    const rect = stage.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return ratio < 0.33 ? 'left' : ratio > 0.67 ? 'right' : 'center';
  };

  const showRipple = (side: 'left' | 'right', label: string) => {
    setRipple({ id: Date.now(), side, label });
    window.setTimeout(() => setRipple(null), 600);
  };

  const onTouchStart = (event: React.TouchEvent) => {
    if (!settings.gestures || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const zone = zoneOf(touch.clientX);
    tapRef.current = { time: Date.now(), zone };
    gestureRef.current = { x: touch.clientX, y: touch.clientY, mode: 'none', base: 0 };
    longPressTimer.current = window.setTimeout(() => {
      if (gestureRef.current && gestureRef.current.mode === 'none' && playing) {
        speedBoostRef.current = rate;
        engine.setSpeed(2);
        flash('Speed 2x (hold)');
      }
    }, 500);
  };

  const onTouchMove = (event: React.TouchEvent) => {
    if (!settings.gestures || !gestureRef.current || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const gesture = gestureRef.current;
    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;

    if (gesture.mode === 'none') {
      if (Math.abs(deltaX) > 24 && Math.abs(deltaX) > Math.abs(deltaY)) gesture.mode = 'seek';
      else if (Math.abs(deltaY) > 24) {
        gesture.mode = zoneOf(gesture.x) === 'left' ? 'brightness' : 'volume';
        gesture.base = gesture.mode === 'volume' ? volume : settings.brightness;
      } else return;
      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    }

    if (gesture.mode === 'seek' && duration) {
      const delta = (deltaX / 320) * 90;
      engine.seekTo(clamp(currentTime + delta, 0, duration));
      setGestureLabel(`${delta > 0 ? '+' : '−'}${formatTime(Math.abs(delta))}`);
    } else if (gesture.mode === 'volume') {
      const next = clamp(gesture.base - (deltaY / 220) * 100, 0, 100);
      engine.setVolume(next);
      setGestureLabel(`Volume ${Math.round(next)}%`);
    } else if (gesture.mode === 'brightness') {
      const next = clamp(gesture.base - (deltaY / 220) * 100, 20, 150);
      onSettingsChange({ brightness: next });
      setGestureLabel(`Brightness ${Math.round(next)}%`);
    }
  };

  const onTouchEnd = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    if (speedBoostRef.current !== null) {
      engine.setSpeed(speedBoostRef.current);
      speedBoostRef.current = null;
      flash(`Speed ${formatSpeed(rate)}`);
    }
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setGestureLabel('');
    if (gesture && gesture.mode !== 'none') { wakeControls(); return; }

    const tap = tapRef.current;
    tapRef.current = null;
    if (!tap || !settings.gestures) return;
    const isDoubleTap = Date.now() - tap.time < 300;
    if (tap.zone === 'center') { engine.toggle(); flash(playing ? 'Pause' : 'Play'); return; }
    if (!isDoubleTap) return;
    const delta = tap.zone === 'left' ? -settings.seekStep : settings.seekStep;
    engine.seekBy(delta);
    showRipple(tap.zone === 'left' ? 'left' : 'right', `${delta > 0 ? '+' : '−'}${settings.seekStep}s`);
  };

  const progressRatio = duration ? currentTime / duration : 0;
  const bufferedRatio = duration ? buffered / duration : 0;
  const activeLevelLabel = currentLevel === -1
    ? `Auto${levels.length && stats?.bitrate ? ` · ${formatBitrate(stats.bitrate)}` : ''}`
    : (levels.find((level) => level.id === currentLevel)?.label || 'Custom');
  const activeSubtitle = textTracks.find((track) => track.id === currentText);
  const activeAudio = audioTracks.find((track) => track.id === currentAudio);

  const Menu: React.FC<{ id: Exclude<MenuId, null>; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
    <div className={`mpv-menu ${menu === id ? 'open' : ''}`} role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <header><span>{title}</span><button onClick={() => setMenu(null)} aria-label="Close menu"><X size={14} /></button></header>
      <div className="mpv-menu-body">{children}</div>
    </div>
  );

  return (
    <div
      ref={stageRef}
      className={`mpv-stage ${controlsVisible ? 'controls-on' : 'controls-off'} ${waiting ? 'is-buffering' : ''}`}
      style={themeVars}
      onMouseMove={wakeControls}
      onMouseLeave={() => { if (!menu && settings.oscTimeout > 0) setControlsVisible(false); }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <video
        ref={videoRef}
        playsInline
        style={{ filter: settings.brightness === 100 ? undefined : `brightness(${settings.brightness}%)` }}
        onError={() => setFatal('This source could not be played in the browser. Try another stream or open it externally.')}
      >
        {subtitles.map((subtitle, index) => (
          <track
            key={`${subtitle.url}-${index}`}
            kind="subtitles"
            src={subtitle.url}
            label={subtitle.name || subtitle.language}
            srcLang={(subtitle.language || 'und').slice(0, 2).toLowerCase()}
            default={index === 0}
          />
        ))}
      </video>

      {/* Subtitle styling follows mpvRx's subtitle size and color controls. */}
      <style>{`
        .mpv-stage video::cue {
          font-size: ${settings.subtitleSize}%;
          color: ${settings.subtitleColor};
          background: rgba(0,0,0,.55);
          text-shadow: 0 1px 3px rgba(0,0,0,.9);
        }
      `}</style>

      {waiting && <div className="mpv-spinner" aria-hidden="true"><span /></div>}

      <button className="mpv-center-toggle" onClick={() => { engine.toggle(); flash(playing ? 'Pause' : 'Play'); }} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={30} /> : <Play size={30} fill="currentColor" />}
      </button>

      {ripple && <div className={`mpv-ripple ${ripple.side}`}><b>{ripple.label}</b></div>}
      {gestureLabel && <div className="mpv-gesture-label">{gestureLabel}</div>}

      {osd && <div className="mpv-osd" role="status">{osd}</div>}

      {statsOpen && stats && (
        <div className="mpv-stats">
          <h4><Activity size={13} /> Statistics</h4>
          <dl>
            <div><dt>Video</dt><dd>{stats.width && stats.height ? `${stats.width}×${stats.height}` : '—'}</dd></div>
            <div><dt>FPS</dt><dd>{stats.fps ? `${stats.fps}` : '—'}</dd></div>
            <div><dt>Frames</dt><dd>{stats.totalFrames} total · {stats.droppedFrames} dropped</dd></div>
            <div><dt>Quality</dt><dd>{activeLevelLabel}</dd></div>
            <div><dt>Bitrate</dt><dd>{formatBitrate(stats.bitrate)}</dd></div>
            <div><dt>Buffer</dt><dd>{formatTime(stats.buffered)} ahead</dd></div>
            <div><dt>Host</dt><dd>{streamHost(stream.url)}</dd></div>
            <div><dt>Subtitles</dt><dd>{activeSubtitle ? activeSubtitle.label : 'off'}</dd></div>
            <div><dt>Audio</dt><dd>{activeAudio ? activeAudio.label : 'default'}{muted ? ' (muted)' : ''}</dd></div>
            <div><dt>Speed</dt><dd>{formatSpeed(rate)}</dd></div>
          </dl>
        </div>
      )}

      {menu === 'help' && (
        <div className="mpv-help" role="dialog" aria-label="Keyboard shortcuts" onClick={(event) => event.stopPropagation()}>
          <header><span><Keyboard size={15} /> Keyboard & gestures</span><button onClick={() => setMenu(null)} aria-label="Close help"><X size={15} /></button></header>
          <div className="mpv-help-body">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group}>
                <h5>{group}</h5>
                {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                  <div key={shortcut.action}><span>{shortcut.action}</span><kbd>{shortcut.keys.join(' + ')}</kbd></div>
                ))}
              </section>
            ))}
            <section>
              <h5>Touch gestures</h5>
              <div><span>Double-tap left / right</span><kbd>seek {settings.seekStep}s</kbd></div>
              <div><span>Double-tap center</span><kbd>play / pause</kbd></div>
              <div><span>Swipe horizontally</span><kbd>seek</kbd></div>
              <div><span>Swipe up/down (right side)</span><kbd>volume</kbd></div>
              <div><span>Swipe up/down (left side)</span><kbd>brightness</kbd></div>
              <div><span>Long press while playing</span><kbd>2x speed</kbd></div>
            </section>
          </div>
        </div>
      )}

      {fatal && (
        <div className="mpv-fatal">
          <CircleX size={26} />
          <h3>Playback unavailable</h3>
          <p>{fatal}</p>
          <button className="mpv-chip" onClick={() => { setFatal(''); engine.play(); }}>Try again</button>
        </div>
      )}

      <div className="mpv-osc" onClick={(event) => event.stopPropagation()}>
        <div
          ref={seekRef}
          className="mpv-seek"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          tabIndex={0}
          onPointerMove={onScrubMove}
          onPointerLeave={() => setScrub(null)}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onScrubCommit(event); }}
        >
          <div className="mpv-seek-track"><span className="buffered" style={{ width: `${bufferedRatio * 100}%` }} /><span className="played" style={{ width: `${progressRatio * 100}%` }} /></div>
          <span className="mpv-seek-handle" style={{ left: `${progressRatio * 100}%` }} />
          {scrub && <span className="mpv-seek-preview" style={{ left: `${scrub.ratio * 100}%` }}>{formatTime(scrub.seconds)}</span>}
          {loop.a !== null && duration > 0 && <span className="mpv-loop-a" style={{ left: `${(loop.a / duration) * 100}%` }} />}
          {loop.b !== null && duration > 0 && <span className="mpv-loop-b" style={{ left: `${(loop.b / duration) * 100}%` }} />}
        </div>

        <div className="mpv-controls">
          <div className="mpv-left">
            <button onClick={engine.toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={19} /> : <Play size={19} fill="currentColor" />}</button>
            <button onClick={() => seek(-settings.seekStep)} aria-label={`Back ${settings.seekStep} seconds`}><SkipBack size={17} /></button>
            <button onClick={() => seek(settings.seekStep)} aria-label={`Forward ${settings.seekStep} seconds`}><SkipForward size={17} /></button>
            <div className="mpv-volume">
              <button onClick={engine.toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? <VolumeX size={17} /> : volume < 55 ? <Volume1 size={17} /> : <Volume2 size={17} />}
              </button>
              <input
                type="range" min={0} max={100} step={1} value={muted ? 0 : volume}
                onChange={(event) => changeVolume(Number(event.target.value), false)}
                aria-label="Volume"
              />
              <span className="mpv-volume-value">{muted ? 0 : volume}</span>
            </div>
            <span className="mpv-time">{formatTime(currentTime)} <i>/</i> {formatTime(duration)}</span>
          </div>

          <div className="mpv-right">
            <button className={`mpv-chip ${loop.a !== null ? 'active' : ''}`} onClick={engine.toggleLoop} aria-label="A-B loop">
              {loop.b !== null ? <Repeat1 size={15} /> : <Repeat size={15} />}
            </button>
            <button className={`mpv-chip ${menu === 'speed' ? 'active' : ''}`} onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>
              <Gauge size={15} /> {formatSpeed(rate)}
            </button>
            {levels.length > 1 && (
              <button className={`mpv-chip ${menu === 'quality' ? 'active' : ''}`} onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
                <SlidersHorizontal size={15} /> {activeLevelLabel}
              </button>
            )}
            {audioTracks.length > 1 && (
              <button className={`mpv-chip ${menu === 'audio' ? 'active' : ''}`} onClick={() => setMenu(menu === 'audio' ? null : 'audio')}>
                <AudioLines size={15} /> {activeAudio?.label || 'Audio'}
              </button>
            )}
            <button className={`mpv-chip ${menu === 'subs' ? 'active' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')}>
              {currentText ? <Captions size={15} /> : <CaptionsOff size={15} />} {activeSubtitle?.label || 'Off'}
            </button>
            <button className={`mpv-chip ${menu === 'settings' ? 'active' : ''}`} onClick={() => setMenu(menu === 'settings' ? null : 'settings')} aria-label="Player settings"><Settings2 size={15} /></button>
            <button className={`mpv-chip ${statsOpen ? 'active' : ''}`} onClick={() => setStatsOpen((open) => !open)} aria-label="Statistics"><Activity size={15} /></button>
            <button className="mpv-chip" onClick={engine.saveFrame} aria-label="Save frame"><Scissors size={15} /></button>
            <button className="mpv-chip" onClick={engine.togglePip} aria-label="Picture in picture"><PictureInPicture2 size={15} /></button>
            <button className="mpv-chip" onClick={() => setMenu(menu === 'help' ? null : 'help')} aria-label="Keyboard shortcuts"><Keyboard size={15} /></button>
            <button className="mpv-chip" onClick={engine.toggleFullscreen} aria-label="Fullscreen">{isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}</button>
          </div>
        </div>

        <Menu id="speed" title="Playback speed">
          <div className="mpv-list">
            {PLAYBACK_SPEEDS.map((value) => (
              <button key={value} className={Math.abs(rate - value) < 0.01 ? 'active' : ''} onClick={() => { changeSpeed(value); setMenu(null); }}>
                {formatSpeed(value)}{Math.abs(rate - value) < 0.01 && <Check size={14} />}
              </button>
            ))}
          </div>
        </Menu>

        <Menu id="quality" title="Quality">
          <div className="mpv-list">
            <button className={currentLevel === -1 ? 'active' : ''} onClick={() => { engine.setLevel(-1); setMenu(null); }}>Auto{currentLevel === -1 && <Check size={14} />}</button>
            {[...levels].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)).map((level) => (
              <button key={level.id} className={currentLevel === level.id ? 'active' : ''} onClick={() => { engine.setLevel(level.id); setMenu(null); }}>
                {level.label}{level.bitrate ? ` · ${formatBitrate(level.bitrate)}` : ''}{currentLevel === level.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </Menu>

        <Menu id="audio" title="Audio track">
          <div className="mpv-list">
            {audioTracks.map((track) => (
              <button key={track.id} className={currentAudio === track.id ? 'active' : ''} onClick={() => { engine.selectAudio(track.id); setMenu(null); }}>
                {track.label}{track.language ? ` (${track.language})` : ''}{currentAudio === track.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </Menu>

        <Menu id="subs" title="Subtitles">
          <div className="mpv-list">
            <button className={!currentText ? 'active' : ''} onClick={() => { engine.selectText(''); setMenu(null); }}>Off{!currentText && <Check size={14} />}</button>
            {textTracks.map((track) => (
              <button key={track.id} className={currentText === track.id ? 'active' : ''} onClick={() => { engine.selectText(track.id); setMenu(null); }}>
                {track.label}{track.language ? ` (${track.language})` : ''}{currentText === track.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="mpv-menu-extra">
            <label>
              <span>Size {settings.subtitleSize}%</span>
              <input type="range" min={50} max={300} step={10} value={settings.subtitleSize}
                onChange={(event) => onSettingsChange({ subtitleSize: Number(event.target.value) })} />
            </label>
            <label>
              <span>Color</span>
              <input type="color" value={settings.subtitleColor} onChange={(event) => onSettingsChange({ subtitleColor: event.target.value })} />
            </label>
          </div>
        </Menu>

        <Menu id="settings" title="Player">
          <div className="mpv-menu-extra">
            <label>
              <span><Sun size={13} /> Brightness {Math.round(settings.brightness)}%</span>
              <input type="range" min={20} max={150} step={5} value={settings.brightness}
                onChange={(event) => onSettingsChange({ brightness: Number(event.target.value) })} />
            </label>
            <label>
              <span>Seek step {settings.seekStep}s</span>
              <input type="range" min={5} max={60} step={5} value={settings.seekStep}
                onChange={(event) => onSettingsChange({ seekStep: Number(event.target.value) })} />
            </label>
            <label className="mpv-toggle">
              <span>Touch gestures</span>
              <button role="switch" aria-checked={settings.gestures} onClick={() => onSettingsChange({ gestures: !settings.gestures })}>
                {settings.gestures ? <Check size={13} /> : null}
              </button>
            </label>
            <label className="mpv-toggle">
              <span>Statistics</span>
              <button role="switch" aria-checked={statsOpen} onClick={() => setStatsOpen((open) => !open)}>
                {statsOpen ? <Check size={13} /> : null}
              </button>
            </label>
          </div>
        </Menu>
      </div>

      {!ready && !fatal && <div className="mpv-loading-hint"><CirclePlay size={16} /> Loading stream…</div>}
      <button className="mpv-collapse" onClick={() => setControlsVisible((visible) => !visible)} aria-label="Toggle controls">
        {controlsVisible ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </div>
  );
};

export default MpvPlayer;
