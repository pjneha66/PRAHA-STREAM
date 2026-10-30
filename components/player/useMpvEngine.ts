import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { PlayerSettings, StreamSubtitle } from '../../types';
import { clamp } from './format';

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
}

interface EngineOptions {
  url: string;
  subtitles: StreamSubtitle[];
  autoplay: boolean;
  volume: number;
  speed: number;
  onFatalError: (message: string) => void;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
}

const isHlsUrl = (url: string) => /\.m3u8($|\?)/i.test(url);

/**
 * Wires a stream URL to a <video> element the way mpv does: quality variants,
 * audio tracks, subtitle tracks, statistics, and A-B looping all live here so
 * the UI layer only has to render state and call controls.
 */
export function useMpvEngine({ url, subtitles, autoplay, volume, speed, onFatalError, onSettingsChange }: EngineOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoveredRef = useRef<'network' | 'media' | null>(null);
  const frameTimesRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [currentVolume, setCurrentVolume] = useState(volume);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(speed);
  const [levels, setLevels] = useState<LevelOption[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([]);
  const [currentAudio, setCurrentAudio] = useState('');
  const [textTracks, setTextTracks] = useState<TrackOption[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loop, setLoop] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const loopRef = useRef(loop);
  loopRef.current = loop;

  /** Attach the source: hls.js for HLS playlists, the media element for the rest. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setReady(false);
    setLevels([]);
    setAudioTracks([]);
    setCurrentLevel(-1);
    recoveredRef.current = null;
    frameTimesRef.current = [];

    if (isHlsUrl(url) && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 60 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls.levels.map((level, index) => ({
          id: index,
          label: level.height ? `${level.height}p` : level.width ? `${level.width}px` : `Variant ${index + 1}`,
          bitrate: level.bitrate || undefined,
        })));
        if (autoplay) video.play().catch(() => undefined);
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
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveredRef.current !== 'network') {
          recoveredRef.current = 'network';
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveredRef.current !== 'media') {
          recoveredRef.current = 'media';
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        onFatalError('This HLS source could not be loaded. It may require custom headers, or it blocks browser playback.');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
      if (autoplay) video.play().catch(() => undefined);
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, autoplay, onFatalError]);

  /** Keep volume, speed, and brightness in sync with saved settings. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = clamp(volume / 100, 0, 1);
    setCurrentVolume(volume);
  }, [volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setRate(speed);
  }, [speed]);

  /** Mirror the element's playback state into React. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

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
    const syncTime = () => setCurrentTime(video.currentTime);
    const syncDuration = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setReady(true);
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
          id: isHls !== undefined ? `hls:${isHls}` : `text:${index}`,
          label: track.label || track.language || `Subtitles ${index + 1}`,
          language: track.language || undefined,
          hlsIndex: isHls,
        });
        if (track.mode === 'showing') active = options[options.length - 1].id;
      }
      setTextTracks(options);
      setCurrentText(active);
    };
    const syncVolume = () => {
      setCurrentVolume(Math.round(video.volume * 100));
      setMuted(video.muted);
    };
    const syncRate = () => setRate(video.playbackRate);

    syncDuration();
    syncTextTracks();
    // Autoplay can start before these listeners are attached, so mirror the
    // element's current state instead of waiting for an event we already missed.
    setPlaying(!video.paused);
    setWaiting(video.readyState < 3);

    video.addEventListener('loadedmetadata', syncDuration);
    video.addEventListener('durationchange', syncDuration);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('progress', syncBuffered);
    video.addEventListener('play', () => setPlaying(true));
    video.addEventListener('playing', () => { setPlaying(true); setWaiting(false); });
    video.addEventListener('pause', () => setPlaying(false));
    video.addEventListener('waiting', () => setWaiting(true));
    video.addEventListener('canplay', () => { setReady(true); setWaiting(false); });
    video.addEventListener('ended', () => setPlaying(false));
    video.addEventListener('volumechange', syncVolume);
    video.addEventListener('ratechange', syncRate);
    video.textTracks.addEventListener('addtrack', syncTextTracks);
    video.textTracks.addEventListener('removetrack', syncTextTracks);
    video.textTracks.addEventListener('change', syncTextTracks);

    return () => {
      video.removeEventListener('loadedmetadata', syncDuration);
      video.removeEventListener('durationchange', syncDuration);
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('progress', syncBuffered);
      video.removeEventListener('volumechange', syncVolume);
      video.removeEventListener('ratechange', syncRate);
      video.textTracks.removeEventListener('addtrack', syncTextTracks);
      video.textTracks.removeEventListener('removetrack', syncTextTracks);
      video.textTracks.removeEventListener('change', syncTextTracks);
    };
  }, [subtitles.length]);

  // A-B loop and frame-rate sampling run on the same animation frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let lastFrameTime = 0;
    let statsAt = 0;

    const tick = (timestamp: number) => {
      const { a, b } = loopRef.current;
      if (a !== null && b !== null && b > a && video.currentTime >= b) video.currentTime = a;

      if (lastFrameTime) {
        frameTimesRef.current.push(timestamp - lastFrameTime);
        if (frameTimesRef.current.length > 30) frameTimesRef.current.shift();
      }
      lastFrameTime = timestamp;

      if (timestamp - statsAt > 500) {
        statsAt = timestamp;
        const quality = video.getVideoPlaybackQuality?.();
        const deltas = frameTimesRef.current;
        const avg = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
        const hls = hlsRef.current;
        const level = hls && currentLevel >= 0 ? hls.levels[currentLevel] : undefined;
        setStats({
          width: video.videoWidth,
          height: video.videoHeight,
          fps: avg > 0 ? Math.round(1000 / avg) : null,
          droppedFrames: quality?.droppedVideoFrames ?? 0,
          totalFrames: quality?.totalVideoFrames ?? 0,
          buffered: video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0,
          bitrate: level?.bitrate || undefined,
          levelLabel: level ? (level.height ? `${level.height}p` : 'variant') : 'source',
          readyState: video.readyState,
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
    video.volume = next / 100;
    video.muted = next === 0;
    setCurrentVolume(next);
    setMuted(next === 0);
    onSettingsChange({ volume: next });
  }, [onSettingsChange]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const setSpeed = useCallback((next: number) => {
    const video = videoRef.current;
    const value = clamp(Number(next.toFixed(2)), 0.25, 4);
    if (video) video.playbackRate = value;
    setRate(value);
    onSettingsChange({ speed: value });
  }, [onSettingsChange]);

  const setLevel = useCallback((id: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = id;
    setCurrentLevel(id);
  }, []);

  const selectAudio = useCallback((id: string) => {
    const hls = hlsRef.current;
    if (!hls || !id.startsWith('audio:')) return;
    hls.audioTrack = Number(id.slice(6));
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
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else stage.requestFullscreen().catch(() => undefined);
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      onFatalError('Picture-in-picture is not available for this stream in this browser.');
    }
  }, [onFatalError]);

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
    audioTracks, currentAudio, textTracks, currentText, stats, loop,
    play, pause, toggle, seekTo, seekBy, seekToPercent, stepFrame,
    setVolume, toggleMute, setSpeed, setLevel,
    selectAudio, cycleAudio, selectText, cycleText,
    toggleFullscreen, togglePip, saveFrame, toggleLoop,
  };
}
