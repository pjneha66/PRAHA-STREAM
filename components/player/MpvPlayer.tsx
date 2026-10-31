import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AudioLines, Captions, CaptionsOff, Cast, Check, ChevronLeft, ChevronRight,
  CirclePlay, CircleX, FastForward, Gauge, Keyboard, Maximize, Minimize, Pause,
  PictureInPicture2, Play, Repeat, Repeat1, RotateCcw, Scissors, Settings2,
  SkipBack, SkipForward, SlidersHorizontal, Sun, Upload, Volume1, Volume2, VolumeX, X,
} from 'lucide-react';
import type { IntroSegment, MediaItem, PlayerSettings, StreamResult, StreamSubtitle } from '../../types';
import { parseLocalSubtitleFile, prepareSubtitleUrl } from '../../services/subtitleService';
import { setImmersiveFullscreen } from '../../services/androidBridge';
import { clamp, formatBitrate, formatSpeed, formatTime, streamHost } from './format';
import { SHORTCUTS, SHORTCUT_GROUPS } from './shortcuts';
import { getTheme, PLAYBACK_SPEEDS } from './themes';
import { useMpvEngine } from './useMpvEngine';
import './mpv-player.css';

type MenuId = 'speed' | 'quality' | 'audio' | 'subs' | 'settings' | 'help' | null;

interface MpvPlayerProps {
  stream: StreamResult;
  effectiveUrl: string;
  externalSubtitles?: StreamSubtitle[];
  introSegments?: IntroSegment[];
  initialTime?: number;
  media?: MediaItem;
  season?: number;
  episode?: number;
  nextEpisodeLabel?: string;
  onNextEpisode?: () => void;
  onProgress?: (currentTime: number, duration: number) => void;
  autoplay: boolean;
  settings: PlayerSettings;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
  onRequestClose: () => void;
}

const MpvPlayer: React.FC<MpvPlayerProps> = ({
  stream,
  effectiveUrl,
  externalSubtitles = [],
  introSegments = [],
  initialTime = 0,
  media,
  season,
  episode,
  nextEpisodeLabel,
  onNextEpisode,
  onProgress,
  autoplay,
  settings,
  onSettingsChange,
  onRequestClose,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const seekRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [localSubs, setLocalSubs] = useState<StreamSubtitle[]>([]);
  const [preparedSubtitles, setPreparedSubtitles] = useState<StreamSubtitle[]>([]);
  const [resumeBanner, setResumeBanner] = useState(initialTime > 5);
  const [upNextDismissed, setUpNextDismissed] = useState(false);

  const rawSubtitles = useMemo(() => {
    const merged: StreamSubtitle[] = [];
    const seen = new Set<string>();
    [...(stream.subtitles || []), ...externalSubtitles, ...localSubs].forEach((sub) => {
      if (!sub?.url || seen.has(sub.url)) return;
      seen.add(sub.url);
      merged.push(sub);
    });
    return merged;
  }, [stream.subtitles, externalSubtitles, localSubs]);

  // Convert SRT/ASS tracks to WebVTT and apply user timing offset (`subtitleOffset`)
  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];
    (async () => {
      const converted = await Promise.all(rawSubtitles.slice(0, 30).map(async (sub) => {
        try {
          const vttUrl = await prepareSubtitleUrl(sub, settings.subtitleOffset || 0);
          if (vttUrl.startsWith('blob:') && vttUrl !== sub.url) createdUrls.push(vttUrl);
          return { ...sub, url: vttUrl };
        } catch {
          return sub;
        }
      }));
      if (active) setPreparedSubtitles(converted.filter((s) => Boolean(s.url)));
    })();
    return () => {
      active = false;
      createdUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [rawSubtitles, settings.subtitleOffset]);

  useEffect(() => {
    setResumeBanner(initialTime > 5);
    if (initialTime <= 5) return;
    const timer = window.setTimeout(() => setResumeBanner(false), 7500);
    return () => window.clearTimeout(timer);
  }, [initialTime, effectiveUrl]);

  useEffect(() => {
    setUpNextDismissed(false);
  }, [effectiveUrl, season, episode]);

  const flash = useCallback((message: string) => {
    setOsd(message);
    if (osdTimer.current) window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(''), 1200);
  }, []);

  const onFatalError = useCallback((message: string) => setFatal(message), []);

  const handleEnded = useCallback(() => {
    if (settings.autoNextEpisode && onNextEpisode) {
      onNextEpisode();
    }
  }, [settings.autoNextEpisode, onNextEpisode]);

  const mediaMeta = useMemo(() => (media ? { media, season, episode } : undefined), [media, season, episode]);

  const engine = useMpvEngine({
    url: effectiveUrl,
    subtitles: preparedSubtitles,
    autoplay,
    volume: settings.volume,
    speed: settings.speed,
    landscapeLock: settings.landscapeLock,
    initialTime,
    mediaMeta,
    onProgress,
    onEnded: handleEnded,
    onNextEpisode,
    onFatalError,
    onSettingsChange,
  });
  const {
    videoRef, ready, waiting, playing, currentTime, duration, buffered, volume, muted, rate,
    levels, currentLevel, audioTracks, currentAudio, textTracks, currentText, stats, loop, canCast,
  } = engine;

  const theme = getTheme(settings.theme);
  const themeVars = useMemo(() => theme.vars as React.CSSProperties, [theme]);

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
    const onChange = () => {
      const full = Boolean(document.fullscreenElement);
      setIsFullscreen(full);
      if (!full) setImmersiveFullscreen(false, settings.landscapeLock);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      setImmersiveFullscreen(false, false);
    };
  }, [settings.landscapeLock]);

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

  const shiftSubtitleDelay = useCallback((delta: number) => {
    const next = clamp(Number(((settings.subtitleOffset || 0) + delta).toFixed(2)), -10, 10);
    onSettingsChange({ subtitleOffset: next });
    flash(`Sub delay ${next > 0 ? '+' : ''}${next}s`);
  }, [settings.subtitleOffset, onSettingsChange, flash]);

  const jumpRatio = useCallback((ratio: number) => {
    if (!duration) return;
    engine.seekTo(duration * ratio);
    flash(formatTime(duration * ratio));
  }, [duration, engine, flash]);

  /** Keyboard map, mirroring mpv bindings + Z/X subtitle sync & N next episode. */
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
        case 'n': case 'N': if (onNextEpisode) onNextEpisode(); break;
        case ',': engine.stepFrame(-1); flash('Frame −'); break;
        case '.': engine.stepFrame(1); flash('Frame +'); break;
        case '[': changeSpeed(rate - 0.1); break;
        case ']': changeSpeed(rate + 0.1); break;
        case '{': changeSpeed(rate / 2); break;
        case '}': changeSpeed(rate * 2); break;
        case 'Backspace': changeSpeed(1); break;
        case 'm': case 'M': engine.toggleMute(); flash(muted ? 'Unmute' : 'Mute'); break;
        case 'j': case 'J': engine.cycleText(key === 'J' ? -1 : 1); flash('Subtitle track'); break;
        case 'z': case 'Z': shiftSubtitleDelay(-0.25); break;
        case 'x': case 'X': shiftSubtitleDelay(0.25); break;
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
  }, [engine, flash, jumpRatio, loop, menu, muted, currentText, textTracks, onRequestClose, onNextEpisode, playing, rate, settings.seekStep, settings.subtitleSize, onSettingsChange, changeSpeed, changeVolume, shiftSubtitleDelay, seek, volume, wakeControls]);

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

  const onUploadSubtitles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = await parseLocalSubtitleFile(file);
      setLocalSubs((current) => [parsed, ...current]);
      flash(`Loaded ${file.name}`);
    } catch {
      flash('Could not parse subtitle file');
    }
  };

  const activeIntroSegment = useMemo(() => {
    if (!settings.skipIntro) return null;
    return introSegments.find((seg) => currentTime >= seg.start && currentTime < seg.end - 1) || null;
  }, [introSegments, currentTime, settings.skipIntro]);

  const showUpNext = Boolean(
    settings.autoNextEpisode &&
    onNextEpisode &&
    nextEpisodeLabel &&
    !upNextDismissed &&
    duration > 180 &&
    duration - currentTime <= 28 &&
    duration - currentTime > 0,
  );

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
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip"
        hidden
        onChange={onUploadSubtitles}
      />

      <video
        ref={videoRef}
        playsInline
        style={{ filter: settings.brightness === 100 ? undefined : `brightness(${settings.brightness}%)` }}
        onError={() => setFatal('This source could not be played directly. Try another stream or open it in VLC / mpv-android below.')}
      >
        {preparedSubtitles.map((subtitle, index) => (
          <track
            key={`${subtitle.id || subtitle.name || index}-${subtitle.url}`}
            kind="subtitles"
            src={subtitle.url}
            label={subtitle.name || subtitle.language}
            srcLang={(subtitle.language || 'und').slice(0, 2).toLowerCase()}
            default={index === 0}
          />
        ))}
      </video>

      <style>{`
        .mpv-stage video::cue {
          font-size: ${settings.subtitleSize}%;
          color: ${settings.subtitleColor};
          background: rgba(0,0,0,${((settings.subtitleBgOpacity ?? 55) / 100).toFixed(2)});
          text-shadow: 0 1px 3px rgba(0,0,0,.9);
        }
      `}</style>

      {waiting && <div className="mpv-spinner" aria-hidden="true"><span /></div>}

      <button className="mpv-center-toggle" onClick={() => { engine.toggle(); flash(playing ? 'Pause' : 'Play'); }} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={30} /> : <Play size={30} fill="currentColor" />}
      </button>

      {resumeBanner && initialTime > 5 && (
        <div className="mpv-floating-pill mpv-resume-pill" onClick={(e) => e.stopPropagation()}>
          <span>Resumed at <strong>{formatTime(initialTime)}</strong></span>
          <button onClick={() => { engine.seekTo(0); setResumeBanner(false); flash('Restarted'); }}>
            <RotateCcw size={13} /> Start over
          </button>
        </div>
      )}

      {activeIntroSegment && (
        <button
          className="mpv-floating-pill mpv-skip-intro"
          onClick={(e) => {
            e.stopPropagation();
            engine.seekTo(activeIntroSegment.end);
            flash('Skipped intro');
          }}
        >
          <FastForward size={15} /> {activeIntroSegment.label}
        </button>
      )}

      {showUpNext && onNextEpisode && (
        <div className="mpv-floating-pill mpv-upnext-card" onClick={(e) => e.stopPropagation()}>
          <div>
            <small>UP NEXT IN {Math.max(1, Math.ceil(duration - currentTime))}s</small>
            <strong>{nextEpisodeLabel}</strong>
          </div>
          <button className="mpv-upnext-play" onClick={onNextEpisode}>
            <Play size={14} fill="currentColor" /> Play now
          </button>
          <button className="mpv-upnext-dismiss" onClick={() => setUpNextDismissed(true)} aria-label="Dismiss Up Next">
            <X size={13} />
          </button>
        </div>
      )}

      {ripple && <div className={`mpv-ripple ${ripple.side}`}><b>{ripple.label}</b></div>}
      {gestureLabel && <div className="mpv-gesture-label">{gestureLabel}</div>}
      {osd && <div className="mpv-osd" role="status">{osd}</div>}

      {statsOpen && stats && (
        <div className="mpv-stats">
          <h4><Activity size={13} /> Statistics</h4>
          <dl>
            <div><dt>Engine</dt><dd>{stats.engineName}</dd></div>
            <div><dt>Video</dt><dd>{stats.width && stats.height ? `${stats.width}×${stats.height}` : '—'}</dd></div>
            <div><dt>FPS</dt><dd>{stats.fps ? `${stats.fps}` : '—'}</dd></div>
            <div><dt>Frames</dt><dd>{stats.totalFrames} total · {stats.droppedFrames} dropped</dd></div>
            <div><dt>Quality</dt><dd>{activeLevelLabel}</dd></div>
            <div><dt>Bitrate</dt><dd>{formatBitrate(stats.bitrate)}</dd></div>
            <div><dt>Buffer</dt><dd>{formatTime(stats.buffered)} ahead</dd></div>
            <div><dt>Host</dt><dd>{streamHost(stream.url)}</dd></div>
            <div><dt>Subtitles</dt><dd>{activeSubtitle ? activeSubtitle.label : 'off'}{settings.subtitleOffset ? ` (${settings.subtitleOffset > 0 ? '+' : ''}${settings.subtitleOffset}s)` : ''}</dd></div>
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
            {media?.type === 'series' && (
              <button className="mpv-chip" onClick={() => seek(85, '+85s Intro')} title="Skip 85s opening">
                <FastForward size={14} /> <span>+85s</span>
              </button>
            )}
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
            {onNextEpisode && nextEpisodeLabel && (
              <button className="mpv-chip" onClick={onNextEpisode} title={`Next: ${nextEpisodeLabel}`}>
                <FastForward size={15} /> <span>{nextEpisodeLabel}</span>
              </button>
            )}
            <button className={`mpv-chip ${loop.a !== null ? 'active' : ''}`} onClick={engine.toggleLoop} aria-label="A-B loop">
              {loop.b !== null ? <Repeat1 size={15} /> : <Repeat size={15} />}
            </button>
            <button className={`mpv-chip ${menu === 'speed' ? 'active' : ''}`} onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>
              <Gauge size={15} /> <span>{formatSpeed(rate)}</span>
            </button>
            {levels.length > 1 && (
              <button className={`mpv-chip ${menu === 'quality' ? 'active' : ''}`} onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
                <SlidersHorizontal size={15} /> <span>{activeLevelLabel}</span>
              </button>
            )}
            {audioTracks.length > 1 && (
              <button className={`mpv-chip ${menu === 'audio' ? 'active' : ''}`} onClick={() => setMenu(menu === 'audio' ? null : 'audio')}>
                <AudioLines size={15} /> <span>{activeAudio?.label || 'Audio'}</span>
              </button>
            )}
            <button className={`mpv-chip ${menu === 'subs' ? 'active' : ''}`} onClick={() => setMenu(menu === 'subs' ? null : 'subs')}>
              {currentText ? <Captions size={15} /> : <CaptionsOff size={15} />} <span>{activeSubtitle?.label || (preparedSubtitles.length ? `${preparedSubtitles.length} Subs` : 'Off')}</span>
            </button>
            {canCast && (
              <button className="mpv-chip" onClick={engine.promptCast} aria-label="Cast to device"><Cast size={15} /></button>
            )}
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
          <div className="mpv-sub-upload-row">
            <button className="mpv-upload-btn" onClick={() => fileInputRef.current?.click()}>
              <Upload size={13} /> Load .srt / .vtt / .ass file
            </button>
          </div>
          <div className="mpv-list">
            <button className={!currentText ? 'active' : ''} onClick={() => { engine.selectText(''); setMenu(null); }}>Off{!currentText && <Check size={14} />}</button>
            {textTracks.map((track) => (
              <button key={track.id} className={currentText === track.id ? 'active' : ''} onClick={() => { engine.selectText(track.id); setMenu(null); }}>
                {track.label}{track.language ? ` (${track.language})` : ''}{currentText === track.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="mpv-menu-extra">
            <div className="mpv-delay-row">
              <span>Sync offset: <strong>{settings.subtitleOffset > 0 ? `+${settings.subtitleOffset}` : settings.subtitleOffset || 0}s</strong></span>
              <div>
                <button onClick={() => shiftSubtitleDelay(-0.25)}>−0.25s</button>
                <button onClick={() => onSettingsChange({ subtitleOffset: 0 })}>0s</button>
                <button onClick={() => shiftSubtitleDelay(0.25)}>+0.25s</button>
              </div>
            </div>
            <label>
              <span>Size {settings.subtitleSize}%</span>
              <input type="range" min={50} max={300} step={10} value={settings.subtitleSize}
                onChange={(event) => onSettingsChange({ subtitleSize: Number(event.target.value) })} />
            </label>
            <label>
              <span>Background opacity {settings.subtitleBgOpacity ?? 55}%</span>
              <input type="range" min={0} max={100} step={5} value={settings.subtitleBgOpacity ?? 55}
                onChange={(event) => onSettingsChange({ subtitleBgOpacity: Number(event.target.value) })} />
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
              <span>Auto-play next episode</span>
              <button role="switch" aria-checked={settings.autoNextEpisode} onClick={() => onSettingsChange({ autoNextEpisode: !settings.autoNextEpisode })}>
                {settings.autoNextEpisode ? <Check size={13} /> : null}
              </button>
            </label>
            <label className="mpv-toggle">
              <span>Auto-landscape fullscreen</span>
              <button role="switch" aria-checked={settings.landscapeLock} onClick={() => onSettingsChange({ landscapeLock: !settings.landscapeLock })}>
                {settings.landscapeLock ? <Check size={13} /> : null}
              </button>
            </label>
            <label className="mpv-toggle">
              <span>Skip Intro prompts</span>
              <button role="switch" aria-checked={settings.skipIntro} onClick={() => onSettingsChange({ skipIntro: !settings.skipIntro })}>
                {settings.skipIntro ? <Check size={13} /> : null}
              </button>
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
