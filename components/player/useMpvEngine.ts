import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';
import type { MediaInfo } from 'dashjs';
import type { MediaItem, PlayerEngineId, PlayerSettings, StreamSubtitle } from '../../types';
import {
  enterNativeAndroidPip, isAndroidApp, setImmersiveFullscreen,
} from '../../services/androidBridge';
import { mpvAvailable } from '../../services/mpvBridge';
import { media3Available } from '../../services/media3Bridge';
import {
  createNativeEngine, type NativeEngineHandle, type NativeEngineId, type NativeSnapshot,
} from '../../services/nativePlayerAdapter';
import { startNativePlayback, type NativePlaybackSession } from '../../services/nativePlayback';
import {
  fallbackNotice, resolveEngineChain,
} from '../../services/playerSelection';
import { formatAudioCodec, formatSubtitleCodec, resolveLanguageName } from '../../services/subtitleService';
import { clamp } from './format';
import { formatSupportHint, MAX_STALL_RETRIES, STABLE_PLAYBACK_SECONDS, stallAction, vlcBufferingToWaiting } from './recovery';

export interface LevelOption {
  id: number;
  label: string;
  bitrate?: number;
}

export interface TrackOption {
  id: string;
  label: string;
  trackNumber?: number;
  language?: string;
  languageName?: string | null;
  codec?: string | null;
  codecLabel?: string | null;
  channels?: number;
  bitrate?: number;
  isExternal?: boolean;
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
  /** Live P2P loader counters (only when the web engine used a P2P loader). */
  p2p: {
    enabled: boolean;
    peers: number;
    fromPeersBytes: number;
    fromHttpBytes: number;
    errors: number;
  };
}

interface NativeAudioTrack { label?: string; language?: string; enabled: boolean }
interface NativeAudioTrackList extends EventTarget { readonly length: number; [index: number]: NativeAudioTrack }
type VideoWithAudioTracks = HTMLVideoElement & { audioTracks?: NativeAudioTrackList };

interface EngineOptions {
  url: string;
  /** The raw stream URL; used as a one-shot fallback when `url` is a proxy URL that fails. */
  fallbackUrl?: string;
  /** Skip the native engines and use the web engine (in-app P2P blob: streams). */
  forceWebEngine?: boolean;
  /** Preferred native engine on Android (mpv, media3). Falls back automatically. */
  playerEngine?: PlayerEngineId;
  /** Live source (IPTV): enables the frozen-stream watchdog. */
  isLive?: boolean;
  /** Stream format hint (hls, dash, mpegts, direct, torrent-http) from source metadata. */
  streamFormat?: string;
  streamHeaders?: Record<string, string>;
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
  /** Transient notice shown when playback fell back to another engine. */
  onEngineFallback?: (message: string) => void;
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
  fallbackUrl,
  forceWebEngine = false,
  playerEngine = 'mpv',
  isLive = false,
  streamFormat,
  streamHeaders,
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
  onEngineFallback,
}: EngineOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hlsP2pRef = useRef<{ destroy: () => void } | null>(null);
  const p2pStatsRef = useRef({ enabled: false, peers: 0, fromPeersBytes: 0, fromHttpBytes: 0, errors: 0 });
  const dashRef = useRef<{ reset: () => void; setQualityFor?: (type: string, index: number, force?: boolean) => void; setAutoSwitchQualityFor?: (type: string, enable: boolean) => void; getTracksFor: (type: 'audio') => MediaInfo[]; getCurrentTrackFor: (type: 'audio') => MediaInfo | null; setCurrentTrack: (track: MediaInfo) => void } | null>(null);
  const mpegtsRef = useRef<{ destroy: () => void } | null>(null);
  const recoveredRef = useRef({ network: 0, media: 0 });
  const resumeRef = useRef<number | null>(null);
  /**
   * Which engine in the preferred chain is being tried for the current URL, and
   * the live native session driving it. The index only ever moves forward and
   * resets when the URL changes, so a dead stream cannot ping-pong between mpv
   * and Media3 — the same reason the old VLC escalation budget existed.
   */
  const nativeChainRef = useRef<{ url: string; index: number }>({ url: '', index: 0 });
  const nativeSessionRef = useRef<NativePlaybackSession | null>(null);
  /**
   * Last position the native engine reported. Kept apart from `currentTime`
   * state so a fallback can resume where the previous engine stopped without
   * waiting for a render.
   */
  const lastNativeTimeRef = useRef(0);
  const [nativeActive, setNativeActive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [recoveryAttempts, setRecoveryAttempts] = useState(0);
  const attemptsRef = useRef(0);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const frameTimesRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const initialSeekDoneRef = useRef(false);
  const lastProgressSentRef = useRef(0);
  const engineNameRef = useRef('HTML5');
  // Mirrored as state so the player chrome can show the active engine chip
  // (refs do not re-render).
  const [engineLabel, setEngineLabel] = useState('HTML5');

  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  // Subtitle tracks appear a moment after mount. Reading the count through a
  // ref keeps the attach effect from re-running (and restarting the stream)
  // every time the track list fills in — which is exactly what happened on
  // open before, doubling the time from tap to video.
  const subtitlesCountRef = useRef(subtitles.length);
  subtitlesCountRef.current = subtitles.length;

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
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /**
   * Attach the source. On Android the order is the user's preferred engine
   * first — mpv by default — then the next installed engine, ending at the web
   * player (hls.js / dash.js / mpegts.js / plain <video>), which every build has.
   *
   * The web path is unchanged: it is the `else` branch, reached when the chain
   * selects `web` or a native engine failed and the fallback advanced past it.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let disposed = false;

    // A new source restarts the chain. Engine reloads of the same URL (a
    // fallback, or a user retry) keep the position already reached.
    if (nativeChainRef.current.url !== url) {
      nativeChainRef.current = { url, index: 0 };
      lastNativeTimeRef.current = 0;
    }

    const chain = resolveEngineChain({
      preferred: playerEngine,
      forceWeb: forceWebEngine,
      availability: { mpv: mpvAvailable(), media3: media3Available() },
      host: isAndroidApp() ? 'android' : 'web',
    });
    const chainIndex = Math.min(nativeChainRef.current.index, chain.length - 1);
    const selected = chain[chainIndex] ?? 'web';

    setReady(false);
    setLevels([]);
    setAudioTracks([]);
    setCurrentAudio('');
    setCurrentLevel(-1);
    recoveredRef.current = { network: 0, media: 0 };
    frameTimesRef.current = [];
    initialSeekDoneRef.current = false;
    p2pStatsRef.current = { enabled: false, peers: 0, fromPeersBytes: 0, fromHttpBytes: 0, errors: 0 };
    engineNameRef.current = 'HTML5';
    setEngineLabel('HTML5');
    const shouldAutoplay = autoplay || resumeRef.current !== null;

    /**
     * Watches the first metadata event after the element is pointed straight at
     * a URL — the last resort for containers the WebView can decode natively,
     * and the fallback when the engine for the declared format is missing.
     *
     * This path used to be a bare `video.src = url` with `play().catch(noop)`.
     * When the source was dead the promise rejected into nothing, the element
     * stayed paused and no metadata ever arrived, so `ready` never became true
     * and the player sat on "Loading stream…" with no way out. `<video onError>`
     * did not save it either: it was gated on `nativeActive`, which flips after
     * this effect runs, and the stall watchdog ignores a paused element. The
     * watchdog is declared out here so the effect's cleanup can always disarm
     * it, whichever branch was taken.
     */
    let directWatchdog: number | null = null;
    let onDirectLoaded: (() => void) | null = null;
    const clearDirectWatchdog = () => {
      if (directWatchdog !== null) {
        window.clearTimeout(directWatchdog);
        directWatchdog = null;
      }
      if (onDirectLoaded) {
        video.removeEventListener('loadedmetadata', onDirectLoaded);
        onDirectLoaded = null;
      }
    };
    const armDirectWatchdog = (hint: string) => {
      clearDirectWatchdog();
      // Armed even without autoplay: assigning `src` starts the metadata fetch
      // on its own, so a dead URL stalls with the poster up and the loading
      // chip showing — the state in the bug report.
      onDirectLoaded = () => clearDirectWatchdog();
      video.addEventListener('loadedmetadata', onDirectLoaded, { once: true });
      directWatchdog = window.setTimeout(() => {
        if (disposed || video.readyState >= 1 || video.error) return;
        clearDirectWatchdog();
        onFatalError(
          `This stream did not start playing — the file may be offline or in a format this device cannot decode. Try another source or an external player.${hint ? ` ${hint}` : ''}`,
        );
      }, 15_000);
    };

    if (selected !== 'web') {
      const engineId = selected as NativeEngineId;
      engineNameRef.current = engineId === 'mpv' ? 'mpv (native)' : 'Media3 (native)';
      setEngineLabel(engineId === 'mpv' ? 'mpv' : 'Media3');
      setNativeActive(true);
      setRecoveryStatus('');
      // The SurfaceView draws behind the WebView, so the element only provides
      // geometry and captures pointer events for the React chrome on top.
      video.style.opacity = '0';

      const resumeSeconds = resumeRef.current ?? (lastNativeTimeRef.current || initialTime);

      nativeSessionRef.current?.stop();
      const session = startNativePlayback({
        engine: engineId,
        chain,
        surface: video,
        url,
        fallbackUrl: fallbackUrl && fallbackUrl !== url ? fallbackUrl : undefined,
        headers: streamHeaders,
        startSeconds: resumeSeconds > 1 ? resumeSeconds : undefined,
        autoplay: shouldAutoplay,
        isLive,
        volume,
        rate: speed,
        handlers: {
          onState(state) {
            if (disposed) return;
            lastNativeTimeRef.current = state.currentTime;
            setPlaying(!state.paused && !state.eofReached);
            setWaiting(state.buffering && !state.eofReached);
            if (Number.isFinite(state.currentTime)) setCurrentTime(state.currentTime);
            if (state.duration > 0) {
              setDuration(state.duration);
              setReady(true);
            }
            onProgressRef.current?.(state.currentTime, state.duration);
          },
          onTracks(audio, text, currentAudioId, currentTextId) {
            if (disposed) return;
            setAudioTracks(audio.map((track, index) => ({ ...track, trackNumber: index + 1 })));
            setTextTracks(text.map((track, index) => ({ ...track, trackNumber: index + 1 })));
            setCurrentAudio(currentAudioId);
            setCurrentText(currentTextId);
          },
          onEnd() {
            if (disposed) return;
            setPlaying(false);
            setWaiting(false);
            onEndedRef.current?.();
          },
          onFallback(message, nextId) {
            if (disposed) return;
            if (!nextId) {
              setNativeActive(false);
              onFatalError(message);
              return;
            }
            // Advance the chain and reload the effect onto the next engine. The
            // chain always ends at `web`, so this never loops.
            nativeChainRef.current = { url, index: chain.indexOf(nextId) };
            resumeRef.current = lastNativeTimeRef.current || null;
            setWaiting(false);
            setRecoveryStatus(message);
            // A toast, not just an inline status: the user did not ask for this
            // swap and needs to know why the picture changed.
            onEngineFallback?.(message);
            setReloadKey((key) => key + 1);
          },
        },
      });
      nativeSessionRef.current = session;

      return () => {
        disposed = true;
        // Never keep the previous engine alive while another one starts: libmpv
        // owns one global context and Media3 one audio focus session.
        session.stop();
        if (nativeSessionRef.current === session) nativeSessionRef.current = null;
        setNativeActive(false);
        video.style.opacity = '1';
      };
    }

    setNativeActive(false);
    // Everything below is the unchanged web path.
    {
      const fmt = (streamFormat || '').toLowerCase();
      const formatHint = formatSupportHint(url, streamFormat);
      const preferHls = fmt === 'hls' || isHlsUrl(url);
      const preferDash = fmt === 'dash' || fmt === 'mpd' || isDashUrl(url);
      const preferMpegTs = fmt === 'mpegts' || fmt === 'ts' || fmt === 'flv' || isMpegTsUrl(url);

      // `onPlayFailure` is for the one caller that has a better message than the
      // generic watchdog one: a live channel whose container turned out not to
      // be MPEG-TS. It disarms the watchdog first so the same dead source is not
      // reported twice. Without a handler a rejected `play()` is expected —
      // autoplay-blocked is not a dead stream — and the watchdog stays armed.
      const attachDirect = (onPlayFailure?: () => void) => {
        engineNameRef.current = 'HTML5';
        setEngineLabel('HTML5');
        video.src = url;
        if (shouldAutoplay) {
          video.play().catch(() => {
            if (disposed || !onPlayFailure) return;
            clearDirectWatchdog();
            onPlayFailure();
          });
        }
        armDirectWatchdog(formatHint);
      };

      if (preferHls && Hls.isSupported()) {
        engineNameRef.current = 'hls.js';
        setEngineLabel('hls.js');
        let p2pLoaders: Record<string, unknown> = {};
        let p2pEngine: HlsJsP2PEngine | null = null;
        try {
          p2pEngine = new HlsJsP2PEngine();
          hlsP2pRef.current = p2pEngine;
          p2pLoaders = p2pEngine.getConfigForHlsJs() as Record<string, unknown>;
        } catch {
          hlsP2pRef.current = null;
          p2pEngine = null;
        }
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: Boolean(isLive),
          backBufferLength: isLive ? 30 : 90,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          maxBufferLength: isLive ? 20 : 30,
          maxMaxBufferLength: isLive ? 60 : 60,
          ...(p2pLoaders as any),
        });
        hlsRef.current = hls;
        if (p2pEngine) {
          p2pStatsRef.current.enabled = true;
          try {
            p2pEngine.addEventListener('onChunkDownloaded', (bytesLength, downloadSource) => {
              if (downloadSource === 'p2p') p2pStatsRef.current.fromPeersBytes += bytesLength;
              else p2pStatsRef.current.fromHttpBytes += bytesLength;
            });
            p2pEngine.addEventListener('onPeerConnect', () => { p2pStatsRef.current.peers += 1; });
            p2pEngine.addEventListener('onPeerClose', () => {
              p2pStatsRef.current.peers = Math.max(0, p2pStatsRef.current.peers - 1);
            });
            p2pEngine.addEventListener('onSegmentError', () => { p2pStatsRef.current.errors += 1; });
          } catch {
            // Older core builds may not expose every event — stats stay optional.
          }
        }
        try { p2pEngine?.bindHls(hls); } catch {}
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
          setAudioTracks(data.audioTracks.map((track, index) => {
            const lang = track.lang || undefined;
            const langName = resolveLanguageName(lang);
            const label = langName ? `${langName}${track.name && track.name !== langName ? ` (${track.name})` : ''}` : track.name || (data.audioTracks.length > 1 ? `Audio ${index + 1}` : 'Audio Track');
            const codec = (track as unknown as { audioCodec?: string }).audioCodec || undefined;
            return {
              id: `audio:${index}`,
              label,
              trackNumber: index + 1,
              language: lang,
              languageName: langName,
              codec,
              codecLabel: formatAudioCodec(codec),
            };
          }));
          if (data.audioTracks.length) setCurrentAudio(`audio:${hls.audioTrack >= 0 ? hls.audioTrack : 0}`);
        });
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => setCurrentAudio(`audio:${data.id}`));
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || disposed) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveredRef.current.network < 2) {
            recoveredRef.current.network += 1;
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveredRef.current.media < 2) {
            recoveredRef.current.media += 1;
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          onFatalError(`This HLS source could not be loaded. Try another stream or open it in an external player.${formatHint ? ` ${formatHint}` : ''}`);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (preferDash) {
        engineNameRef.current = 'dash.js';
        setEngineLabel('dash.js');
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
            setAudioTracks(tracks.map((track, index) => {
              const lang = track.lang || undefined;
              const langName = resolveLanguageName(lang);
              const rawLabel = track.labels?.[0]?.text || track.lang;
              const label = langName ? `${langName}${rawLabel && rawLabel !== langName ? ` (${rawLabel})` : ''}` : rawLabel || (tracks.length > 1 ? `Audio ${index + 1}` : 'Audio Track');
              const codec = (track as unknown as { codec?: string }).codec || undefined;
              return {
                id: `dash:${index}`,
                label,
                trackNumber: index + 1,
                language: lang,
                languageName: langName,
                codec,
                codecLabel: formatAudioCodec(codec),
              };
            }));
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
            if (!disposed) onFatalError(`This DASH (.mpd) stream could not be loaded.${formatHint ? ` ${formatHint}` : ''}`);
          });
        }).catch(() => {
          if (!disposed) attachDirect();
        });
      } else if (preferMpegTs) {
        engineNameRef.current = 'mpegts.js';
        setEngineLabel('mpegts.js');
        import('mpegts.js').then((mpegtsModule) => {
          if (disposed) return;
          const mpegts = mpegtsModule.default;
          if (mpegts.isSupported()) {
            const type = /\.flv($|\?)/i.test(url) || fmt === 'flv' ? 'flv' : 'mpegts';
            const player = mpegts.createPlayer(
              { type, url, isLive: Boolean(isLive) },
              { enableWorker: true, stashInitialSize: 128, lazyLoad: false },
            );
            player.on(mpegts.Events.ERROR, () => {
              if (disposed) return;
              try { player.destroy(); } catch {}
              mpegtsRef.current = null;
              // On failure, try native/HLS fallback for live streams that might actually be HLS
              if (isLive) {
                attachDirect(() => onFatalError('This live stream could not be played. Try another channel or open in an external player.'));
              } else {
                onFatalError(`This MPEG-TS/FLV source could not be loaded. Try another source or an external player.${formatHint ? ` ${formatHint}` : ''}`);
              }
            });
            player.attachMediaElement(video);
            player.load();
            if (shouldAutoplay) Promise.resolve(player.play()).catch(() => undefined);
            mpegtsRef.current = player;
          } else {
            attachDirect();
          }
        }).catch(() => {
          if (!disposed) attachDirect();
        });
      } else {
        // Direct/native playback (mp4, mkv where supported, etc.)
        attachDirect();
      }
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
      clearDirectWatchdog();
      if (video.currentTime > 1 && Number.isFinite(video.duration) && video.duration > 0) {
        onProgressRef.current?.(video.currentTime, video.duration);
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      try { hlsP2pRef.current?.destroy(); } catch {}
      hlsP2pRef.current = null;
      dashRef.current?.reset();
      dashRef.current = null;
      mpegtsRef.current?.destroy();
      mpegtsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, forceWebEngine, playerEngine, autoplay, onFatalError, onEngineFallback, reloadKey, streamFormat, isLive, fallbackUrl, streamHeaders, initialTime]);

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
      // Native (mpv/Media3) subtitle tracks arrive through the session's
      // onTracks callback, not the <video> element, so this stays web-only.
      const list = video.textTracks;
      const options: TrackOption[] = [];
      let active = '';
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        const hlsIndex = index - subtitlesCountRef.current;
        const isHls = hlsIndex >= 0 && hlsRef.current?.subtitleTracks.length ? hlsIndex : undefined;
        const lang = track.language || undefined;
        const langName = resolveLanguageName(lang);
        const label = langName ? `${langName}${track.label && track.label !== langName ? ` (${track.label})` : ''}` : track.label || (list.length > 1 ? `Subtitles ${index + 1}` : 'Subtitles');
        options.push({
          id: isHls !== undefined ? `hls:${hlsIndex}` : `text:${index}`,
          label,
          trackNumber: index + 1,
          language: lang,
          languageName: langName,
          hlsIndex: isHls,
          isExternal: index < subtitlesCountRef.current,
        });
        if (track.mode === 'showing') active = options[options.length - 1].id;
      }
      setTextTracks(options);
      setCurrentText(active);
    };
    const nativeTracks = (video as VideoWithAudioTracks).audioTracks;
    const syncNativeAudio = () => {
      // Native audio tracks come from the session's onTracks callback. This
      // listener only serves the MediaStream/audioTracks web path.
      if (hlsRef.current || dashRef.current || !nativeTracks) return;
      const options: TrackOption[] = [];
      let selected = '';
      for (let index = 0; index < nativeTracks.length; index++) {
        const track = nativeTracks[index];
        const lang = track.language || undefined;
        const langName = resolveLanguageName(lang);
        const label = langName || track.label || (nativeTracks.length > 1 ? `Audio ${index + 1}` : 'Audio Track');
        options.push({
          id: `native:${index}`,
          label,
          trackNumber: index + 1,
          language: lang,
          languageName: langName,
        });
        if (track.enabled) selected = `native:${index}`;
      }
      setAudioTracks(options);
      setCurrentAudio(selected);
    };

    const onVlcTracks = (e: Event) => {
      // The old LibVLC shim in MainActivity is a stub, so this event never fires
      // in a shipped build. Kept as a passive listener only: if a legacy bridge
      // still emits it, surface the tracks rather than dropping them.
      const custom = e as CustomEvent;
      const detail = custom.detail;
      if (!detail) return;
      if (Array.isArray(detail.audioTracks)) {
        setAudioTracks(detail.audioTracks.map((t: any, idx: number) => ({
          id: `native-audio:${t.id}`,
          trackNumber: t.trackNumber || (idx + 1),
          label: t.name || (detail.audioTracks.length > 1 ? `Audio Track ${idx + 1}` : 'Audio Track'),
          language: t.language || undefined,
          languageName: t.languageName || resolveLanguageName(t.language),
          codec: t.codec || undefined,
          codecLabel: t.codecLabel || formatAudioCodec(t.codec, t.channels),
          channels: t.channels,
          bitrate: t.bitrate,
        })));
        if (detail.selectedAudio !== undefined) {
          setCurrentAudio(detail.selectedAudio >= 0 ? `native-audio:${detail.selectedAudio}` : (detail.selectedAudio === -1 ? 'audio:off' : ''));
        }
      }
      if (Array.isArray(detail.spuTracks)) {
        setTextTracks(detail.spuTracks.map((t: any, idx: number) => ({
          id: `native-spu:${t.id}`,
          trackNumber: t.trackNumber || (idx + 1),
          label: t.name || `Subtitle ${idx + 1}`,
          language: t.language || undefined,
          languageName: t.languageName || resolveLanguageName(t.language),
          codec: t.codec || undefined,
          codecLabel: t.codecLabel || formatSubtitleCodec(t.codec),
          isExternal: Boolean(t.isExternal),
        })));
        if (detail.selectedSpu !== undefined) {
          setCurrentText(detail.selectedSpu >= 0 ? `native-spu:${detail.selectedSpu}` : '');
        }
      }
    };
    window.addEventListener('praha:vlc-tracks', onVlcTracks);
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
      window.removeEventListener('praha:vlc-tracks', onVlcTracks);
    };
  }, [initialTime]);

  const retry = useCallback(() => {
    const video = videoRef.current;
    // Native engines report through the session, not the element, so the
    // element's currentTime is 0 there and would restart the stream from the top.
    resumeRef.current = nativeSessionRef.current
      ? (lastNativeTimeRef.current || null)
      : (video && Number.isFinite(video.currentTime) ? video.currentTime : 0);
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
          p2p: { ...p2pStatsRef.current },
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [currentLevel]);

  const play = useCallback(() => {
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.play().catch(() => undefined);
      setPlaying(true);
      return;
    }
    videoRef.current?.play().catch(() => undefined);
  }, []);

  const pause = useCallback(() => {
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.pause().catch(() => undefined);
      setPlaying(false);
      return;
    }
    videoRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    const native = nativeSessionRef.current;
    if (native) {
      if (playing) {
        void native.handle.pause().catch(() => undefined);
        setPlaying(false);
      } else {
        void native.handle.play().catch(() => undefined);
        setPlaying(true);
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  }, [playing]);

  const seekTo = useCallback((seconds: number) => {
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.seekTo(seconds).catch(() => undefined);
      lastNativeTimeRef.current = seconds;
      setCurrentTime(seconds);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clamp(seconds, 0, Number.isFinite(video.duration) ? video.duration : seconds);
    setCurrentTime(video.currentTime);
  }, []);

  const seekBy = useCallback((delta: number) => {
    if (nativeSessionRef.current) {
      seekTo(currentTime + delta);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    seekTo(video.currentTime + delta);
  }, [currentTime, seekTo]);

  const seekToPercent = useCallback((percent: number) => {
    if (nativeSessionRef.current) {
      if (duration > 0) seekTo(duration * (percent / 100));
      return;
    }
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    seekTo(video.duration * (percent / 100));
  }, [duration, seekTo]);

  /** mpv-style single-frame stepping. */
  const stepFrame = useCallback((direction: 1 | -1) => {
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.pause().catch(() => undefined);
      void native.handle.seekBy(direction * (1 / 30)).catch(() => undefined);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = clamp(video.currentTime + direction * (1 / 30), 0, video.duration || 0);
  }, []);

  const setVolume = useCallback((percent: number) => {
    const next = clamp(Math.round(percent), 0, 100);
    if (next > 0) lastAudibleVolumeRef.current = next;
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.setVolume(next).catch(() => undefined);
      void native.handle.setMuted(next === 0).catch(() => undefined);
      setCurrentVolume(next);
      setMuted(next === 0);
      onSettingsChange({ volume: next });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.volume = next / 100;
    video.muted = next === 0;
    setCurrentVolume(next);
    setMuted(next === 0);
    onSettingsChange({ volume: next });
  }, [onSettingsChange]);

  const toggleMute = useCallback(() => {
    // Native engines own audio on Android; the <video> element is only a
    // transparent surface there, so muting it has no audible effect.
    if (nativeSessionRef.current) {
      if (currentVolume === 0) setVolume(lastAudibleVolumeRef.current);
      else {
        if (currentVolume > 0) lastAudibleVolumeRef.current = currentVolume;
        setVolume(0);
      }
      return;
    }
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
  }, [currentVolume, onSettingsChange, setVolume]);

  const setSpeed = useCallback((next: number) => {
    const value = clamp(Number(next.toFixed(2)), 0.25, 4);
    const native = nativeSessionRef.current;
    if (native) {
      void native.handle.setRate(value).catch(() => undefined);
    } else {
      const video = videoRef.current;
      if (video) video.playbackRate = value;
    }
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
    if (id === 'audio:off' || id === 'off' || id === '-1') {
      const native = nativeSessionRef.current;
      if (native) {
        // The engine's own track id is 0 = auto, so it has no "off"; muting is
        // the honest equivalent here and matches what the web path does below.
        void native.handle.setMuted(true).catch(() => undefined);
      }
      // hls.js/dash.js do not expose audioTracks on the <video> element, so
      // disabling those alone leaves audio playing on the primary web paths.
      if (hlsRef.current) hlsRef.current.audioTrack = -1;
      if (videoRef.current) videoRef.current.muted = true;
      const tracks = (videoRef.current as VideoWithAudioTracks | null)?.audioTracks;
      if (tracks) {
        for (let i = 0; i < tracks.length; i++) tracks[i].enabled = false;
      }
      setCurrentAudio('audio:off');
      return;
    }

    if (id.startsWith('native-audio:')) {
      const trackId = Number(id.slice(13));
      const native = nativeSessionRef.current;
      if (native && Number.isInteger(trackId)) {
        void native.handle.selectAudio(trackId).catch(() => undefined);
        setCurrentAudio(id);
      }
      return;
    }

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
    if (currentAudio === 'audio:off' && videoRef.current) videoRef.current.muted = false;
    setCurrentAudio(id);
  }, [currentAudio]);

  const cycleAudio = useCallback(() => {
    if (!audioTracks.length) return;
    const index = audioTracks.findIndex((track) => track.id === currentAudio);
    selectAudio(audioTracks[(index + 1) % audioTracks.length].id);
  }, [audioTracks, currentAudio, selectAudio]);

  const selectText = useCallback((id: string) => {
    if (id === '' || id === 'off') {
      const native = nativeSessionRef.current;
      if (native) {
        void native.handle.disableSubtitles().catch(() => undefined);
      }
      const video = videoRef.current;
      if (video) {
        const list = video.textTracks;
        for (let i = 0; i < list.length; i++) list[i].mode = 'disabled';
      }
      if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
      setCurrentText('');
      return;
    }

    if (id.startsWith('native-spu:')) {
      const trackId = Number(id.slice(11));
      const native = nativeSessionRef.current;
      if (native && Number.isInteger(trackId)) {
        void native.handle.selectSubtitle(trackId).catch(() => undefined);
        setCurrentText(id);
      }
      return;
    }

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
    if (await enterNativeAndroidPip()) return;
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
    engineLabel,
    /** True while mpv/Media3 draws the picture; the <video> is then a surface. */
    nativeActive,
    setVolume, toggleMute, setSpeed, setLevel,
    selectAudio, cycleAudio, selectText, cycleText,
    toggleFullscreen, togglePip, promptCast, saveFrame, toggleLoop, retry, recoveryAttempts, recoveryStatus,
  };
}
