import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { MediaInfo } from 'dashjs';
import type { MediaItem, PlayerSettings, StreamSubtitle } from '../../types';
import { enterNativeAndroidPip, setImmersiveFullscreen } from '../../services/androidBridge';
import { clamp } from './format';
import { MAX_STALL_RETRIES, STABLE_PLAYBACK_SECONDS, stallAction } from './recovery';

export interface LevelOption {
  id: number;
  label: string;
  bitrate?: number;
}

export interface TrackOption {
  id: string;
  label: string;
  language?: string;
  /** Set for subtitle tracks that hls.js owns (switched via `hls.subtitleTrack`). */
  hlsIndex?: number;
}

export interface PlayerStats {
  width: number;
  height: number;
  fps: number | null;
  droppedFrames: number;
  totalFrames: number;
  buffered: number;
  bitrate?: number;
  levelLabel: string;
  readyState: number;
  engineName: string;
}

interface NativeAudioTrack { label?: string; language?: string; enabled: boolean }
interface NativeAudioTrackList extends EventTarget { readonly length: number; [index: number]: NativeAudioTrack }
type VideoWithAudioTracks = HTMLVideoElement & { audioTracks?: NativeAudioTrackList };

interface EngineOptions {
  url: string;
  subtitles: StreamSubtitle[];
  autoplay: boolean;
  hasFatalError?: boolean;
  volume: number;
  speed: number;
  landscapeLock?: boolean;
  initialTime?: number;
  mediaMeta?: {
    media: MediaItem;
    season?: number;
    episode?: number;
  };
  onProgress?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onNextEpisode?: () => void;
  onFatalError: (message: string) => void;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
}

const isHlsUrl = (url: string) => /\.m3u8($|\?)/i.test(url) || /[?&]format=m3u8\b/i.test(url);
const isDashUrl = (url: string) => /\.mpd($|\?)/i.test(url) || /[?&]format=mpd\b/i.test(url);
const isMpegTsUrl = (url: string) => /\.(ts|flv)($|\?)/i.test(url);

/**
 * Wires a stream URL to a <video> element the way mpv does: HLS (`hls.js`),
 * DASH (`dashjs`), MPEG-TS (`mpegts.js`), native HTML5 video, MediaSession OS
 * lock-screen controls, RemotePlayback Cast, resume-from-timestamp, quality
 * variants, audio/subtitle tracks, statistics, and A-B looping.
 */
export function useMpvEngine({
  url,
  subtitles,
  autoplay,
  hasFatalError = false,
  volume,
  speed,
  landscapeLock = true,
  initialTime = 0,
  mediaMeta,
  onProgress,
  onEnded,
  onNextEpisode,
  onFatalError,
  onSettingsChange,
}: EngineOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef = useRef<{ reset: () => void; setQualityFor?: (type: string, index: number, force?: boolean) => void; setAutoSwitchQualityFor?: (type: string, enable: boolean) => void; getTracksFor: (type: 'audio') => MediaInfo[]; getCurrentTrackFor: (type: 'audio') => MediaInfo | null; setCurrentTrack: (track: MediaInfo) => void } | null>(null);
  const mpegtsRef = useRef<{ destroy: () => void } | null>(null);
  const recoveredRef = useRef({ network: 0, media: 0 });
  const resumeRef = useRef<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [recoveryAttempts, setRecoveryAttempts] = useState(0);
  const attemptsRef = useRef(0);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const frameTimesRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const initialSeekDoneRef = useRef(false);
  const lastProgressSentRef = useRef(0);
  const engineNameRef = useRef('HTML5');

  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [currentVolume, setCurrentVolume] = useState(volume);
  const [muted, setMuted] = useState(volume <= 0);
  const lastAudibleVolumeRef = useRef(volume > 0 ? clamp(volume, 1, 100) : 100);
  const [rate, setRate] = useState(speed);
  const [levels, setLevels] = useState<LevelOption[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [currentAudio, setCurrentAudio] = useState('');
  const [textTracks, setTextTracks] = useState<TrackOption[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [canCast, setCanCast] = useState(false);
  const [loop, setLoop] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const loopRef = useRef(loop);
  loopRef.current = loop;

  /** Attach the source: hls.js for HLS, dashjs for MPD, mpegts.js for TS/FLV, or native <video>. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let disposed = false;

    setReady(false);
    setLevels([]);
    setAudioTracks([]);
    setCurrentAudio('');
    setCurrentLevel(-1);
    recoveredRef.current = { network: 0, media: 0 };
    frameTimesRef.current = [];
    initialSeekDoneRef.current = false;
    engineNameRef.current = 'HTML5';
    const shouldAutoplay = autoplay || resumeRef.current !== null;

    if (isHlsUrl(url) && Hls.isSupported()) {
      engineNameRef.current = 'hls.js';
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 60 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (disposed) return;
        setLevels(hls.levels.map((level, index) => ({
          id: index,
          label: level.height ? `${level.height}p` : level.width ? `${level.width}px` : `Variant ${index + 1}`,
          bitrate: level.bitrate || undefined,
        })));
        if (shouldAutoplay) video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => setCurrentLevel(data.level));
      hls.on(Hls.Events.LEVELS_UPDATED, (_, data) => setLevels(data.levels.map((level, index) => ({
        id: index,
        label: level.height ? `${level.height}p` : level.width ? `${level.width}px` : `Variant ${index + 1}`,
        bitrate: level.bitrate || undefined,
      }))));
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => {
        setAudioTracks(data.audioTracks.map((track, index) => ({
          id: `audio:${index}`,
          label: track.name || track.lang || `Audio ${index + 1}`,
          language: track.lang,
        })));
        if (data.audioTracks.length) setCurrentAudio(`audio:${hls.audioTrack >= 0 ? hls.audioTrack : 0}`);
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => setCurrentAudio(`audio:${data.id}`));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || disposed) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveredRef.current.network < 1) {
          recoveredRef.current.network += 1;
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveredRef.current.media < 1) {
          recoveredRef.current.media += 1;
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        onFatalError('This HLS source could not be loaded. Try another stream or open it in an external player.');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (isDashUrl(url)) {
      engineNameRef.current = 'dash.js';
      import('dashjs').then((dashModule) => {
        if (disposed) return;
        const dash = dashModule.MediaPlayer().create();
        dash.initialize(video, url, shouldAutoplay);
        dashRef.current = dash as unknown as typeof dashRef.current;
        dash.on('streamInitialized', () => {
          if (disposed) return;
          const dashAny = dash as unknown as { getBitrateInfoListFor?: (type: string) => Array<{ qualityIndex: number; height?: number; bitrate?: number }> };
          const tracks = dash.getTracksFor('audio');
          const selected = dash.getCurrentTrackFor('audio');
          setAudioTracks(tracks.map((track, index) => ({ id: `dash:${index}`, label: track.labels?.[0]?.text || track.lang || `Audio ${index + 1}`, language: track.lang || undefined })));
          const selectedIndex = tracks.findIndex((track) => track === selected || (track.id != null && track.id === selected?.id));
          setCurrentAudio(selectedIndex >= 0 ? `dash:${selectedIndex}` : '');
          const bitrates = dashAny.getBitrateInfoListFor?.('video') || [];
          setLevels(bitrates.map((info, idx) => ({
            id: info.qualityIndex ?? idx,
            label: info.height ? `${info.height}p` : `Variant ${idx + 1}`,
            bitrate: info.bitrate,
          })));
        });
        dash.on('error', () => {
          if (!disposed) onFatalError('This DASH (.mpd) stream could not be loaded.');
        });
      }).catch(() => {
        if (!disposed) {
          video.src = url;
          if (shouldAutoplay) video.play().catch(() => undefined);
        }
      });
    } else if (isMpegTsUrl(url)) {
      engineNameRef.current = 'mpegts.js';
      import('mpegts.js').then((mpegtsModule) => {
        if (disposed) return;
        const mpegts = mpegtsModule.default;
        if (mpegts.isSupported()) {
          const type = /\.flv($|\?)/i.test(url) ? 'flv' : 'mpegts';
          const player = mpegts.createPlayer({ type, url, isLive: false });
          player.on(mpegts.Events.ERROR, () => {
            if (!disposed) onFatalError('This MPEG-TS/FLV source could not be loaded. Try another source or an external player.');
          });
          player.attachMediaElement(video);
          player.load();
          if (shouldAutoplay) Promise.resolve(player.play()).catch(() => undefined);
          mpegtsRef.current = player;
        } else {
          video.src = url;
          if (shouldAutoplay) video.play().catch(() => undefined);
        }
      }).catch(() => {
        if (!disposed) {
          video.src = url;
          if (shouldAutoplay) video.play().catch(() => undefined);
        }
      });
    } else {
      video.src = url;
      if (shouldAutoplay) video.play().catch(() => undefined);
    }

    // Detect RemotePlayback (Chromecast / AirPlay) support
    const remote = (video as HTMLVideoElement & { remote?: { watchAvailability?: (cb: (avail: boolean) => void) => Promise<number> } }).remote;
    if (remote?.watchAvailability) {
      remote.watchAvailability((available) => {
        if (!disposed) setCanCast(available);
      }).catch(() => {
        if (!disposed) setCanCast(true);
      });
    }

    return () => {
      disposed = true;
      if (video.currentTime > 1 && Number.isFinite(video.duration) && video.duration > 0) {
        onProgressRef.current?.(video.currentTime, video.duration);
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      dashRef.current?.reset();
      dashRef.current = null;
      mpegtsRef.current?.destroy();
      mpegtsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, autoplay, onFatalError, reloadKey]);

  /** Keep volume and speed in sync with saved settings. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = clamp(volume / 100, 0, 1);
    if (volume > 0) lastAudibleVolumeRef.current = clamp(volume, 1, 100);
    setCurrentVolume(volume);
    setMuted(video.muted || video.volume === 0);
  }, [volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setRate(speed);
  }, [speed]);

  /** Mirror the element's playback state, resume timestamp, and progress callbacks. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressSentRef.current < 3000) return;
      if (video.currentTime > 1 && Number.isFinite(video.duration) && video.duration > 0) {
        lastProgressSentRef.current = now;
        onProgressRef.current?.(video.currentTime, video.duration);
      }
    };

    const syncBuffered = () => {
      const ranges = video.buffered;
      if (!ranges.length || !video.duration) return;
      for (let index = ranges.length - 1; index >= 0; index -= 1) {
        if (ranges.start(index) <= video.currentTime + 0.5) {
          setBuffered(Math.min(ranges.end(index), video.duration));
          return;
        }
      }
    };
    const syncTime = () => {
      setCurrentTime(video.currentTime);
      emitProgress(false);
    };
    const syncDuration = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(dur);
      setReady(true);
      const resumeTime = resumeRef.current ?? initialTime;
      if (!initialSeekDoneRef.current && dur > 0) {
        initialSeekDoneRef.current = true;
        resumeRef.current = null;
        if (resumeTime > 3 && resumeTime < dur - 1) {
          video.currentTime = resumeTime;
          setCurrentTime(resumeTime);
        }
      }
    };
    const syncTextTracks = () => {
      const list = video.textTracks;
      const options: TrackOption[] = [];
      let active = '';
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        const hlsIndex = index - subtitles.length;
        const isHls = hlsIndex >= 0 && hlsRef.current?.subtitleTracks.length ? hlsIndex : undefined;
        options.push({
          id: isHls !== undefined ? `hls:${hlsIndex}` : `text:${index}`,
          label: track.label || track.language || `Subtitles ${index + 1}`,
          language: track.language || undefined,
          hlsIndex: isHls,
        });
        if (track.mode === 'showing') active = options[options.length - 1].id;
      }
      setTextTracks(options);
      setCurrentText(active);
    };
    const nativeTracks = (video as VideoWithAudioTracks).audioTracks;
    const syncNativeAudio = () => {
      if (hlsRef.current || dashRef.current || !nativeTracks) return;
      const options: TrackOption[] = [];
      let selected = '';
      for (let index = 0; index < nativeTracks.length; index++) {
        const track = nativeTracks[index];
        options.push({ id: `native:${index}`, label: track.label || track.language || `Audio ${index + 1}`, language: track.language || undefined });
        if (track.enabled) selected = `native:${index}`;
      }
      setAudioTracks(options);
      setCurrentAudio(selected);
    };
    nativeTracks?.addEventListener('addtrack', syncNativeAudio);
    nativeTracks?.addEventListener('removetrack', syncNativeAudio);
    nativeTracks?.addEventListener('change', syncNativeAudio);
    video.addEventListener('loadedmetadata', syncNativeAudio);
    syncNativeAudio();
    const syncVolume = () => {
      setCurrentVolume(Math.round(video.volume * 100));
      setMuted(video.muted || video.volume === 0);
    };
    const syncRate = () => setRate(video.playbackRate);
    const handlePlay = () => setPlaying(true);
    const handlePlaying = () => { setPlaying(true); setWaiting(false); setRecoveryStatus(''); };
    const handlePause = () => { setPlaying(false); emitProgress(true); };
    const handleWaiting = () => setWaiting(true);
    const handleCanPlay = () => { setReady(true); setWaiting(false); };
    const handleEnded = () => {
      setPlaying(false);
      emitProgress(true);
      onEndedRef.current?.();
    };

    syncDuration();
    syncTextTracks();
    setPlaying(!video.paused);
    setWaiting(video.readyState < 3);

    video.addEventListener('loadedmetadata', syncDuration);
    video.addEventListener('durationchange', syncDuration);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('progress', syncBuffered);
    video.addEventListener('play', handlePlay);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('volumechange', syncVolume);
    video.addEventListener('ratechange', syncRate);
    video.textTracks.addEventListener('addtrack', syncTextTracks);
    video.textTracks.addEventListener('removetrack', syncTextTracks);
    video.textTracks.addEventListener('change', syncTextTracks);

    return () => {
      video.removeEventListener('loadedmetadata', syncNativeAudio);
      nativeTracks?.removeEventListener('addtrack', syncNativeAudio);
      nativeTracks?.removeEventListener('removetrack', syncNativeAudio);
      nativeTracks?.removeEventListener('change', syncNativeAudio);
      video.removeEventListener('loadedmetadata', syncDuration);
      video.removeEventListener('durationchange', syncDuration);
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('progress', syncBuffered);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('volumechange', syncVolume);
      video.removeEventListener('ratechange', syncRate);
      video.textTracks.removeEventListener('addtrack', syncTextTracks);
      video.textTracks.removeEventListener('removetrack', syncTextTracks);
      video.textTracks.removeEventListener('change', syncTextTracks);
    };
  }, [subtitles.length, initialTime]);

  const retry = useCallback(() => {
    const video = videoRef.current;
    resumeRef.current = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    attemptsRef.current = 0;
    setRecoveryAttempts(0);
    setRecoveryStatus('Retrying source…');
    setReloadKey((key) => key + 1);
  }, []);

  // Detect prolonged buffering, but never restart a paused, seeking or
  // backgrounded player. Two attempts are allowed until 20 seconds of
  // playback progress reset the budget.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stalledSince: number | null = null;
    let lastTime = video.currentTime;
    let stableProgress = 0;
    let stopped = false;
    const interval = window.setInterval(() => {
      if (stopped) return;
      const eligible = !hasFatalError && !video.paused && !video.ended && !video.seeking && !document.hidden && !video.error;
      const advanced = video.currentTime - lastTime;
      if (eligible && advanced > 0 && advanced < 3) {
        stableProgress += advanced;
        if (stableProgress >= STABLE_PLAYBACK_SECONDS && attemptsRef.current) {
          attemptsRef.current = 0;
          setRecoveryAttempts(0);
          setRecoveryStatus('');
        }
      } else stableProgress = 0;
      lastTime = video.currentTime;
      if (!eligible || advanced > 0.05) { stalledSince = null; return; }
      stalledSince ??= Date.now();
      const action = stallAction(Date.now() - stalledSince, attemptsRef.current, eligible);
      if (action === 'retry') {
        attemptsRef.current += 1;
        setRecoveryAttempts(attemptsRef.current);
        setRecoveryStatus(`Buffering too long. Reconnecting (${attemptsRef.current}/${MAX_STALL_RETRIES})…`);
        resumeRef.current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        stopped = true;
        setReloadKey((key) => key + 1);
      } else if (action === 'fail') {
        stopped = true;
        setRecoveryStatus('Recovery attempts exhausted');
        onFatalError('Playback is still buffering after reconnecting. Check your connection or try another source.');
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [url, reloadKey, onFatalError, hasFatalError]);

  /** MediaSession API for Android notification shade, lock screen, headsets & TV remotes. */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !mediaMeta) return;
    const { media, season, episode } = mediaMeta;
    const subtitle = media.type === 'series' && season
      ? `Season ${season} · Episode ${episode || 1}`
      : media.year || 'PRAHA STREAM';

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: media.title,
        artist: subtitle,
        album: 'PRAHA STREAM',
        artwork: media.poster ? [{ src: media.poster, sizes: '512x512', type: 'image/jpeg' }] : [],
      });

      navigator.mediaSession.setActionHandler('play', () => videoRef.current?.play().catch(() => undefined));
      navigator.mediaSession.setActionHandler('pause', () => videoRef.current?.pause());
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - (details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        if (videoRef.current) videoRef.current.currentTime += details.seekOffset || 10;
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (videoRef.current && typeof details.seekTime === 'number') videoRef.current.currentTime = details.seekTime;
      });
      navigator.mediaSession.setActionHandler('nexttrack', onNextEpisode || null);
    } catch {
      // Ignore partial MediaSession implementations.
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler('nexttrack', null);
      } catch { /* ignore */ }
    };
  }, [mediaMeta, onNextEpisode]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !duration) return;
    try {
      navigator.mediaSession.setPositionState?.({
        duration,
        playbackRate: rate || 1,
        position: clamp(currentTime, 0, duration),
      });
    } catch { /* ignore */ }
  }, [currentTime, duration, rate]);

  // A-B loop and frame-rate sampling run on the same animation frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let lastFrameTime = 0;
    let statsAt = 0;
    let lastVideoFrames = 0;

    const tick = (timestamp: number) => {
      const { a, b } = loopRef.current;
      if (a !== null && b !== null && b > a && video.currentTime >= b) video.currentTime = a;

      if (lastFrameTime) {
        frameTimesRef.current.push(timestamp - lastFrameTime);
        if (frameTimesRef.current.length > 30) frameTimesRef.current.shift();
      }
      lastFrameTime = timestamp;

      if (timestamp - statsAt > 500) {
        const quality = video.getVideoPlaybackQuality?.();
        const elapsed = timestamp - statsAt;
        const hls = hlsRef.current;
        const level = hls && currentLevel >= 0 ? hls.levels[currentLevel] : undefined;
        const fps = quality && statsAt && elapsed > 0 && quality.totalVideoFrames >= lastVideoFrames ? Math.round((quality.totalVideoFrames - lastVideoFrames) * 1000 / elapsed) : null;
        lastVideoFrames = quality?.totalVideoFrames ?? 0;
        statsAt = timestamp;
        setStats({
          width: video.videoWidth,
          height: video.videoHeight,
          fps,
          droppedFrames: quality?.droppedVideoFrames ?? 0,
          totalFrames: quality?.totalVideoFrames ?? 0,
          buffered: (() => {
            for (let i = 0; i < video.buffered.length; i++) {
              if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) return video.buffered.end(i) - video.currentTime;
            }
            return 0;
          })(),
          bitrate: level?.bitrate || undefined,
          levelLabel: level ? (level.height ? `${level.height}p` : 'variant') : 'source',
          readyState: video.readyState,
          engineName: engineNameRef.current,
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [currentLevel]);

  const play = useCallback(() => videoRef.current?.play().catch(() => undefined), []);
  const pause = useCallback(() => videoRef.current?.pause(), []);
  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clamp(seconds, 0, Number.isFinite(video.duration) ? video.duration : seconds);
    setCurrentTime(video.currentTime);
  }, []);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    seekTo(video.currentTime + delta);
  }, [seekTo]);

  const seekToPercent = useCallback((percent: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    seekTo(video.duration * (percent / 100));
  }, [seekTo]);

  /** mpv-style single-frame stepping. */
  const stepFrame = useCallback((direction: 1 | -1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = clamp(video.currentTime + direction * (1 / 30), 0, video.duration || 0);
  }, []);

  const setVolume = useCallback((percent: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = clamp(Math.round(percent), 0, 100);
    if (next > 0) lastAudibleVolumeRef.current = next;
    video.volume = next / 100;
    video.muted = next === 0;
    setCurrentVolume(next);
    setMuted(next === 0);
    onSettingsChange({ volume: next });
  }, [onSettingsChange]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.volume === 0) {
      const restored = lastAudibleVolumeRef.current;
      video.volume = restored / 100;
      video.muted = false;
      setCurrentVolume(restored);
      setMuted(false);
      onSettingsChange({ volume: restored });
    } else {
      video.muted = !video.muted;
      setMuted(video.muted);
    }
  }, [onSettingsChange]);

  const setSpeed = useCallback((next: number) => {
    const video = videoRef.current;
    const value = clamp(Number(next.toFixed(2)), 0.25, 4);
    if (video) video.playbackRate = value;
    setRate(value);
    onSettingsChange({ speed: value });
  }, [onSettingsChange]);

  const setLevel = useCallback((id: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = id;
      setCurrentLevel(id);
      return;
    }
    if (dashRef.current) {
      if (id === -1) {
        dashRef.current.setAutoSwitchQualityFor?.('video', true);
      } else {
        dashRef.current.setAutoSwitchQualityFor?.('video', false);
        dashRef.current.setQualityFor?.('video', id, true);
      }
      setCurrentLevel(id);
    }
  }, []);

  const selectAudio = useCallback((id: string) => {
    if (id.startsWith('audio:') && hlsRef.current) {
      const index = Number(id.slice(6));
      if (!Number.isInteger(index) || index < 0 || index >= hlsRef.current.audioTracks.length) return;
      hlsRef.current.audioTrack = index;
    } else if (id.startsWith('dash:') && dashRef.current) {
      const track = dashRef.current.getTracksFor('audio')[Number(id.slice(5))];
      if (!track) return;
      dashRef.current.setCurrentTrack(track);
    } else if (id.startsWith('native:')) {
      const tracks = (videoRef.current as VideoWithAudioTracks | null)?.audioTracks;
      const index = Number(id.slice(7));
      if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return;
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
    } else return;
    setCurrentAudio(id);
  }, []);

  const cycleAudio = useCallback(() => {
    if (!audioTracks.length) return;
    const index = audioTracks.findIndex((track) => track.id === currentAudio);
    selectAudio(audioTracks[(index + 1) % audioTracks.length].id);
  }, [audioTracks, currentAudio, selectAudio]);

  const selectText = useCallback((id: string) => {
    const video = videoRef.current;
    if (!video) return;
    const list = video.textTracks;
    let nextActive = '';
    for (let index = 0; index < list.length; index += 1) {
      const hlsIndex = index - subtitles.length;
      const trackId = hlsIndex >= 0 && hlsRef.current?.subtitleTracks.length ? `hls:${hlsIndex}` : `text:${index}`;
      list[index].mode = trackId === id ? 'showing' : 'disabled';
      if (trackId === id) nextActive = trackId;
    }
    if (hlsRef.current) hlsRef.current.subtitleTrack = nextActive.startsWith('hls:') ? Number(nextActive.slice(4)) : -1;
    setCurrentText(nextActive);
  }, [subtitles.length]);

  const cycleText = useCallback((direction: 1 | -1) => {
    const options = textTracks;
    if (!options.length) return;
    const index = options.findIndex((track) => track.id === currentText);
    if (index === -1 && direction === 1) { selectText(options[0].id); return; }
    if (direction === -1 && index === 0) { selectText(''); return; }
    const next = (index + direction + options.length) % options.length;
    selectText(index === -1 ? options[0].id : options[next].id);
  }, [textTracks, currentText, selectText]);

  const toggleFullscreen = useCallback(() => {
    const stage = videoRef.current?.parentElement;
    if (!stage) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
      setImmersiveFullscreen(false, landscapeLock);
    } else {
      stage.requestFullscreen().catch(() => undefined);
      setImmersiveFullscreen(true, landscapeLock);
    }
  }, [landscapeLock]);

  const togglePip = useCallback(async () => {
    if (enterNativeAndroidPip()) return;
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      onFatalError('Picture-in-picture is not available for this stream.');
    }
  }, [onFatalError]);

  const promptCast = useCallback(async () => {
    const remote = (videoRef.current as (HTMLVideoElement & { remote?: { prompt?: () => Promise<void> } }) | null)?.remote;
    if (!remote?.prompt) return;
    try {
      await remote.prompt();
    } catch {
      // User dismissed Cast picker.
    }
  }, []);

  /** Save the current frame. Blocked by the browser when the source has no CORS headers. */
  const saveFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `praha-${Math.floor(video.currentTime)}s.png`;
        link.click();
        URL.revokeObjectURL(link.href);
      }, 'image/png');
    } catch {
      onFatalError('Screenshot blocked: this source does not allow cross-origin frame capture.');
    }
  }, [onFatalError]);

  /** First press sets A, second sets B, third clears — like mpv's `l`. */
  const toggleLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setLoop((current) => {
      if (current.a === null) return { a: video.currentTime, b: null };
      if (current.b === null) return { a: current.a, b: Math.max(video.currentTime, current.a + 0.5) };
      return { a: null, b: null };
    });
  }, []);

  return {
    videoRef, ready, waiting, playing, currentTime, duration, buffered,
    volume: currentVolume, muted, rate, levels, currentLevel,
    audioTracks, currentAudio, textTracks, currentText, stats, loop, canCast,
    play, pause, toggle, seekTo, seekBy, seekToPercent, stepFrame,
    setVolume, toggleMute, setSpeed, setLevel,
    selectAudio, cycleAudio, selectText, cycleText,
    toggleFullscreen, togglePip, promptCast, saveFrame, toggleLoop, retry, recoveryAttempts, recoveryStatus,
  };
}
