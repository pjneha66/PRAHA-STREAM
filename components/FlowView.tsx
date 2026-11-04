import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, BellRing, Captions, Check, ChevronDown, ChevronRight, CircleAlert, Clock, ExternalLink,
  Film, Gauge, Globe, Heart, Languages, ListMusic, LoaderCircle, Maximize2, Music, Play, Plus, Radio,
  RefreshCw, Search, Settings, Share2, SkipBack, SkipForward, Sparkles, ThumbsDown, ThumbsUp,
  Trash2, TrendingUp, UserCircle2, Video, X,
} from 'lucide-react';
import { usePersistentState } from '../hooks/usePersistentState';
import { isAndroidApp, openSafeExternalUrl } from '../services/androidBridge';
import {
  FLOW_RADIO, FLOW_SEARCH_SUGGESTIONS, parseVideoId, resolveChannelId,
  youtubeChannelUrl, youtubeEmbedUrl, youtubeWatchUrl,
  type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult, type YtShelf, type YtVideo,
} from '../services/youtubeService';
import {
  DEFAULT_MIRRORS, flowChannel, flowDetail, flowHome, flowHomeViaMirror, flowMusicHome, flowMusicSearch,
  flowMusicViaMirror, flowSearch, isMusicVideo, lastProbeLog, normalizeMirrorUrl, probeMirrors,
  proxiedImage, resetDirectState, resetFlowCache, youtubeMedia, youtubeStream,
  type FlowVideoRef, type YtBackend,
} from '../services/flowService';

/**
 * Flow tab — YouTube and YouTube Music inside PRAHA, modelled after
 * https://github.com/Flow-Tube/Flow. Two modes: an ordinary YouTube-style browse
 * view, and a YouTube Music view. Videos play direct, YouTube's embed is the
 * fallback, and subscriptions stay on the device.
 */

type FlowMode = 'youtube' | 'music';
type FlowSection = 'home' | 'subscriptions' | 'search' | 'channel';
type FlowVideo = FlowVideoRef;

interface FlowSubscription {
  id: string;
  name: string;
  avatar?: string;
  addedAt: number;
}

interface PlayerPrefs {
  language: string;
  captions: boolean;
  captionLanguage: string;
  quality: 'auto' | 'highest' | 'data-saver';
  autoplayNext: boolean;
  noCookie: boolean;
  /** Remembered caption size for the direct player; applied straight to <track>. */
  captionSize: 'small' | 'medium' | 'large';
  /** Direct player speed. */
  speed: number;
}

const FLOW_RELEASES = 'https://github.com/Flow-Tube/Flow/releases/latest';
const FLOW_REPO = 'https://github.com/Flow-Tube/Flow';
const SUBS_KEY = 'praha.v2.flow-subscriptions';
const LEGACY_CHANNELS_KEY = 'praha.v2.flow-channels';
const PREFS_KEY = 'praha.v2.flow-player-prefs';
const RECENT_KEY = 'praha.v2.flow-recent';

const DEFAULT_PREFS: PlayerPrefs = {
  language: 'en',
  captions: false,
  captionLanguage: 'en',
  quality: 'auto',
  autoplayNext: true,
  noCookie: true,
  captionSize: 'medium',
  speed: 1,
};

const LANGUAGES: Array<{ id: string; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी · Hindi' },
  { id: 'mr', label: 'मराठी · Marathi' },
  { id: 'bn', label: 'বাংলা · Bengali' },
  { id: 'ta', label: 'தமிழ் · Tamil' },
  { id: 'te', label: 'తెలుగు · Telugu' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'pt', label: 'Português' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'ar', label: 'العربية' },
  { id: 'id', label: 'Bahasa Indonesia' },
];

const MUSIC_MOODS = ['Lo-fi beats', 'Jazz playlist', 'Synthwave mix', 'Live sessions', 'Music videos 4K'];
const YT_CHIPS = FLOW_SEARCH_SUGGESTIONS;

/** Local and preview hosts are rejected by YouTube's embed; suggest a safe one. */
export function embedReferrerFor(hostname: string): string {
  const host = hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /(^|\.)e2b\.app$/.test(host) || /^\w+-\d+\./.test(host);
  return isLocal ? 'https://www.youtube.com/' : `https://${hostname}/`;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

const compactViews = (views?: string) => (views || '').replace(' views', '');

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

const Thumb: React.FC<{ src?: string; alt?: string; className?: string; width?: number }> = ({ src, alt = '', className, width }) => {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  useEffect(() => { setStage(0); }, [src]);
  const candidate = stage === 0 ? src : stage === 1 ? proxiedImage(src, width) : undefined;
  if (!candidate) return <span className={`yt-thumb-fallback ${className || ''}`}><Video size={16} /></span>;
  return (
    <img
      src={candidate}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setStage((current) => (current === 0 ? 1 : 2))}
    />
  );
};

const VideoCard: React.FC<{ video: FlowVideo; onOpen: () => void; compact?: boolean }> = ({ video, onOpen, compact }) => {
  const meta = [compactViews(video.views), video.published].filter(Boolean).join(' · ');
  return (
    <article className={`yt-card ${compact ? 'yt-card-compact' : ''}`}>
      <button className="yt-card-art" onClick={onOpen} aria-label={`Play ${video.title}`}>
        <Thumb src={video.thumbnail} width={480} className="yt-card-thumb" />
        {video.live
          ? <span className="yt-live-badge">LIVE</span>
          : video.duration && <span className="yt-time-badge">{video.duration}</span>}
        <span className="yt-card-hover"><Play size={20} fill="currentColor" /></span>
      </button>
      <div className="yt-card-body">
        <button className="yt-card-avatar" aria-hidden tabIndex={-1} onClick={onOpen}>
          {video.channel ? video.channel.charAt(0).toUpperCase() : <UserCircle2 size={18} />}
        </button>
        <button className="yt-card-copy" onClick={onOpen}>
          <strong title={video.title}>{video.title}</strong>
          <small>{video.channel || 'YouTube'}</small>
          {meta && <small className="yt-card-meta">{meta}</small>}
        </button>
      </div>
    </article>
  );
};

const Shelf: React.FC<{ title: string; videos: YtVideo[]; onOpen: (video: YtVideo) => void; note?: string; layout?: 'row' | 'grid' }> = ({
  title, videos, onOpen, note, layout = 'row',
}) => (
  <section className="yt-shelf">
    <div className="yt-shelf-head">
      <h2>{title}</h2>
      {note && <p>{note}</p>}
    </div>
    <div className={layout === 'row' ? 'yt-row' : 'yt-grid'}>
      {videos.slice(0, layout === 'row' ? 18 : 24).map((video) => (
        <VideoCard key={`${title}-${video.id}`} video={video} onOpen={() => onOpen(video)} />
      ))}
    </div>
  </section>
);

/* ------------------------------------------------------------------ *
 * Main view
 * ------------------------------------------------------------------ */

interface FlowViewProps {
  onPlay: (media: ReturnType<typeof youtubeMedia>, stream: ReturnType<typeof youtubeStream>) => void;
  onEmbed: (media: ReturnType<typeof youtubeMedia>) => void;
  compact?: boolean;
}

const FlowView: React.FC<FlowViewProps> = ({ onPlay, onEmbed }) => {
  const [mode, setMode] = useState<FlowMode>('youtube');
  const [section, setSection] = useState<FlowSection>('home');
  const [backend, setBackend] = useState<YtBackend | null>(null);

  /* browse data */
  const [home, setHome] = useState<YtHome | null>(null);
  const [homeState, setHomeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [homeError, setHomeError] = useState('');
  const [musicHome, setMusicHome] = useState<YtHome | null>(null);
  const [musicState, setMusicState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [musicError, setMusicError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  /* search (shared by both modes) */
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<YtSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  /* subscriptions */
  const [subs, setSubs] = usePersistentState<FlowSubscription[]>(SUBS_KEY, []);
  const [recent, setRecent] = usePersistentState<FlowVideo[]>(RECENT_KEY, []);
  const [channelDraft, setChannelDraft] = useState('');
  const [channelError, setChannelError] = useState('');
  const [feed, setFeed] = useState<YtChannelFeed | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [feedError, setFeedError] = useState('');

  /* watch */
  const [detail, setDetail] = useState<YtDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [detailError, setDetailError] = useState('');
  const [playerMode, setPlayerMode] = useState<'stream' | 'embed'>('stream');
  const [quality, setQuality] = useState<'auto' | number>('auto');
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [silentWarning, setSilentWarning] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [copied, setCopied] = useState(false);
  const [embedReferrer, setEmbedReferrer] = useState(() => embedReferrerFor(window.location.hostname));
  const [described, setDescribed] = useState(false);
  const [liked, setLiked] = useState<'up' | 'down' | null>(null);

  const [prefs, setPrefs] = usePersistentState<PlayerPrefs>(PREFS_KEY, DEFAULT_PREFS);
  const [mirrors, setMirrors] = usePersistentState<string[]>('praha.v2.flow-mirrors', DEFAULT_MIRRORS);
  const [mirrorDraft, setMirrorDraft] = useState('');
  const [mirrorError, setMirrorError] = useState('');
  const [showMirrors, setShowMirrors] = useState(false);
  const [mirrorChecking, setMirrorChecking] = useState(false);
  const [radioPlaying, setRadioPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const android = isAndroidApp();

  const isSubscribed = useCallback((id?: string) => Boolean(id && subs.some((entry) => entry.id === id)), [subs]);

  const toggleSubscribe = (channel: { id?: string; name?: string; avatar?: string }) => {
    if (!channel.id) return;
    const id = channel.id;
    setSubs((current) => (current.some((entry) => entry.id === id)
      ? current.filter((entry) => entry.id !== id)
      : [{ id, name: channel.name || id, avatar: channel.avatar, addedAt: Date.now() }, ...current]));
  };

  /* legacy followed channels → subscriptions */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LEGACY_CHANNELS_KEY);
      if (!raw) return;
      const legacy = JSON.parse(raw) as unknown;
      if (!Array.isArray(legacy)) return;
      setSubs((current) => {
        const known = new Set(current.map((entry) => entry.id));
        const additions = legacy
          .filter((id): id is string => typeof id === 'string' && !known.has(id))
          .map((id) => ({ id, name: id, addedAt: Date.now() }));
        return additions.length ? [...additions, ...current] : current;
      });
    } catch { /* ignore unreadable legacy storage */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- loaders ---------------- */
  useEffect(() => {
    if (section !== 'home') return;
    let active = true;
    setHomeState((state) => (state === 'ready' ? state : 'loading'));
    setHomeError('');
    (backend === 'mirror' ? flowHomeViaMirror : flowHome)()
      .then(({ data, backend: source }) => {
        if (!active) return;
        setHome(data);
        setBackend(source);
        setHomeState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHomeState('error');
        setHomeError(error instanceof Error ? error.message : 'Could not reach YouTube.');
      });
    return () => { active = false; };
  }, [section, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== 'music') return;
    let active = true;
    setMusicState((state) => (state === 'ready' ? state : 'loading'));
    setMusicError('');
    (backend === 'mirror' ? flowMusicViaMirror : flowMusicHome)()
      .then(({ data, backend: source }) => {
        if (!active) return;
        setMusicHome(data);
        setBackend(source);
        setMusicState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMusicState('error');
        setMusicError(error instanceof Error ? error.message : 'Could not load music.');
      });
    return () => { active = false; };
  }, [mode, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!submitted) return;
    let active = true;
    setSearching(true);
    setSearchError('');
    (mode === 'music' ? flowMusicSearch(submitted) : flowSearch(submitted))
      .then(({ data, backend: source }) => {
        if (!active) return;
        setResults(mode === 'music' ? { ...data, videos: data.videos.filter(isMusicVideo) } : data);
        setBackend(source);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setResults(null);
        setSearchError(error instanceof Error ? error.message : 'Search failed.');
      })
      .finally(() => { if (active) setSearching(false); });
    return () => { active = false; };
  }, [submitted, mode]);

  const loadChannel = useCallback((id: string) => {
    setSection('channel');
    setFeedId(id);
    setFeedState('loading');
    setFeedError('');
    flowChannel(id)
      .then(({ data, backend: source }) => { setFeed(data); setBackend(source); setFeedState('ready'); })
      .catch((error: unknown) => {
        setFeed(null);
        setFeedState('error');
        setFeedError(error instanceof Error ? error.message : 'Could not load that channel.');
      });
  }, []);

  const openVideo = useCallback((video: FlowVideo | string) => {
    const id = typeof video === 'string' ? video : video.id;
    const stub = typeof video === 'string' ? null : video;
    setDetailId(id);
    setDetailState('loading');
    setDetailError('');
    setDetail(null);
    setCopied(false);
    setPlayerMode('stream');
    setQuality('auto');
    setAudioOnly(false);
    setQualityMenuOpen(false);
    setSettingsOpen(false);
    setSilentWarning(false);
    setPlayerError('');
    setDescribed(false);
    setLiked(null);
    if (stub) {
      setRecent((current) => [stub, ...current.filter((entry) => entry.id !== stub.id)].slice(0, 12));
    }
    flowDetail(id)
      .then(({ data, backend: source }) => { setDetail(data); setBackend(source); setDetailState('idle'); })
      .catch((error: unknown) => {
        setDetailState('error');
        setDetailError(error instanceof Error ? error.message : 'Could not load that video.');
      });
  }, [setRecent]);

  const closeWatch = () => {
    setDetailId(null);
    setDetail(null);
    setDetailState('idle');
    setDetailError('');
    setPlayerError('');
  };

  /* ---------------- derived player state ---------------- */
  const qualities = useMemo(() => {
    const tracks = detail?.videoTracks ?? [];
    const seen = new Set<string>();
    return tracks.filter((track) => {
      const key = track.height ? `${track.height}` : track.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [detail]);

  // The saved default quality was only ever read for `auto`; switching the
  // preference in settings never reached the <video>. Follow the preference
  // unless the viewer picked an explicit height for this video.
  useEffect(() => {
    if (quality === 'auto') return;
    setQuality('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.quality]);

  const preferredQualityIndex = useMemo(() => {
    if (!qualities.length) return 0;
    if (prefs.quality === 'highest') return 0;
    if (prefs.quality === 'data-saver') return qualities.length - 1;
    const auto = qualities.findIndex((track) => track.hasAudio !== false && (track.height || 0) <= 720);
    return auto >= 0 ? auto : 0;
  }, [qualities, prefs.quality]);

  const audioTrack = detail?.audioTracks?.[0];
  const activeTrack = quality === 'auto' ? qualities[preferredQualityIndex] : qualities[quality];
  const activeSource = audioOnly ? audioTrack?.url : activeTrack?.url || detail?.playbackUrl;
  const duplicateAudio = !audioOnly && activeTrack?.hasAudio === false && Boolean(audioTrack);
  const activeIsSilent = !audioOnly && activeTrack?.hasAudio === false && !audioTrack;
  const activeQualityLabel = audioOnly
    ? 'Audio only'
    : quality === 'auto'
      ? (activeTrack?.height ? `Auto · ${activeTrack.height}p` : 'Auto')
      : (activeTrack?.height ? `${activeTrack.height}p` : activeTrack?.label || 'Auto');

  const syncAudio = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.4) audio.currentTime = video.currentTime;
    audio.volume = video.muted ? 0 : video.volume;
  }, []);

  useEffect(() => {
    if (!duplicateAudio) return;
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) return;
    const start = () => { void audio.play().catch(() => setSilentWarning(true)); };
    if (!video.paused) start();
    video.addEventListener('play', start);
    return () => {
      video.removeEventListener('play', start);
      audio.pause();
    };
  }, [duplicateAudio, activeSource]);

  /* ---------------- actions ---------------- */
  const retryFetch = () => {
    resetDirectState();
    resetFlowCache();
    setReloadToken((token) => token + 1);
  };

  const checkMirrors = async () => {
    setShowMirrors(true);
    setMirrorChecking(true);
    await probeMirrors();
    setMirrorChecking(false);
    setReloadToken((token) => token + 1);
  };

  const submitSearch = (event?: FormEvent, override?: string) => {
    event?.preventDefault();
    const cleaned = (override ?? term).trim();
    if (!cleaned) return;
    setSection('search');
    setSubmitted(cleaned);
  };

  const searchVideoId = () => {
    try { return parseVideoId(term); } catch { return null; }
  };

  const addChannel = async (event: FormEvent) => {
    event.preventDefault();
    setChannelError('');
    try {
      const id = await resolveChannelId(channelDraft || '');
      if (!isSubscribed(id)) {
        setSubs((current) => [{ id, name: channelDraft.replace(/^.*\/channel\//, '') || id, addedAt: Date.now() }, ...current]);
      }
      setChannelDraft('');
      setFeed(null);
      loadChannel(id);
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : 'Could not add that channel.');
    }
  };

  const playInPraha = (video: YtDetail | FlowVideo) => {
    const detailVideo = video as YtDetail;
    const audio = detailVideo.audioTracks?.[0];
    const direct = detailVideo.playbackUrl;
    const media = youtubeMedia(video as FlowVideo, 'youtube');
    const stream = youtubeStream(
      video as FlowVideo,
      audio ? { url: audio.url, format: 'audio' } : direct ? { url: direct, format: 'video' } : undefined,
    );
    if (audio) stream.title = `${video.title} · audio only`;
    onPlay(media, stream);
  };

  const shareVideo = async (id: string) => {
    const url = youtubeWatchUrl(id);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      openSafeExternalUrl(url);
    }
  };

  const embedSrc = detail
    ? youtubeEmbedUrl(detail.id, {
      language: prefs.language,
      captions: prefs.captions,
      captionLanguage: prefs.captionLanguage,
      noCookie: prefs.noCookie,
    })
    : '';

  const nextUp = detail?.related.slice(0, 14) ?? [];

  const navItems: Array<{ id: FlowSection; label: string; icon: typeof Video }> = [
    { id: 'home', label: 'Home', icon: mode === 'music' ? Sparkles : Video },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'subscriptions', label: mode === 'music' ? 'Music channels' : 'Channels', icon: ListMusic },
  ];

  /* ------------------------------------------------------------------ *
   * Watch page
   * ------------------------------------------------------------------ */
  if (detailId) {
    return (
      <div className={`standard-page flow-page yt-watch-page page-enter ${mode === 'music' ? 'music-mode' : ''}`}>
        <button className="yt-back" onClick={closeWatch}><ChevronRight size={15} className="flip" /> Back to {mode === 'music' ? 'YouTube Music' : 'YouTube'}</button>

        <div className="yt-watch-layout">
          <div className="yt-watch-main">
            <div className="yt-player-shell">
              {detailState === 'loading' && (
                <div className="yt-player-loading"><LoaderCircle size={22} className="spin" /> Preparing player…</div>
              )}
              {detailState === 'error' && (
                <>
                  <iframe src={embedSrc} title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
                  <div className="yt-player-error">
                    <CircleAlert size={14} />
                    <span>Details unavailable — the player still works.</span>
                    <button onClick={() => openVideo(detailId)}>Retry</button>
                    <button onClick={() => openSafeExternalUrl(youtubeWatchUrl(detailId))}>YouTube</button>
                  </div>
                </>
              )}
              {detailState === 'idle' && detail && (
                playerMode === 'embed' ? (
                  <iframe
                    key={`${embedSrc}-${embedReferrer}`}
                    src={embedSrc}
                    title={detail.title}
                    referrerPolicy="origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
                    allowFullScreen
                  />
                ) : activeSource ? (
                  <>
                    <video
                      key={`${detail.id}-${quality}-${audioOnly}-${prefs.quality}-${prefs.speed}`}
                      ref={videoRef}
                      className="yt-video"
                      src={activeSource}
                      poster={detail.thumbnail}
                      controls
                      autoPlay
                      playsInline
                      preload="metadata"
                      onTimeUpdate={() => { if (duplicateAudio) syncAudio(); }}
                      onSeeking={() => { if (duplicateAudio) syncAudio(); }}
                      onPlay={() => { if (duplicateAudio) void audioRef.current?.play().catch(() => undefined); }}
                      onPause={() => audioRef.current?.pause()}
                    onLoadedMetadata={(event) => { event.currentTarget.playbackRate = prefs.speed; }}
                      onError={() => setPlayerError('This stream refused to load. Try the embed or another quality.')}
                      onEnded={() => {
                        if (prefs.autoplayNext && nextUp[0]) openVideo(nextUp[0]);
                      }}
                    />
                    {duplicateAudio && audioTrack && (
                      <audio ref={audioRef} src={audioTrack.url} preload="auto" onError={() => setSilentWarning(true)} />
                    )}
                  </>
                ) : (
                  <div className="yt-player-loading">
                    <CircleAlert size={22} />
                    <p>No direct stream for this video.</p>
                    <button className="yt-btn primary" onClick={() => setPlayerMode('embed')}>Use the embed</button>
                  </div>
                )
              )}

              {prefs.captions && detail && playerMode === 'embed' && (
                <div className="yt-cc-badge"><Captions size={12} /> {prefs.captionLanguage.toUpperCase()}</div>
              )}
            </div>

            {/* player toolbar: quality + settings, never covering the picture */}
            {detailState === 'idle' && detail && (
              <div className="yt-player-bar">
                <span className="yt-player-bar-state">
                  <Settings size={12} /> {playerMode === 'embed' ? 'YouTube embed' : activeQualityLabel}
                  {activeIsSilent && <em>video-only</em>}
                  {prefs.captions && <em><Captions size={11} /> cc</em>}
                </span>
                <div className="yt-player-bar-actions">
                  {playerMode === 'stream' && (
                    <button onClick={() => setQualityMenuOpen((open) => !open)} aria-expanded={qualityMenuOpen}>
                      Quality <ChevronDown size={12} className={qualityMenuOpen ? 'flip' : undefined} />
                    </button>
                  )}
                  <button onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
                    <Settings size={12} /> Player settings
                  </button>
                  <button onClick={() => setPlayerMode(playerMode === 'embed' ? 'stream' : 'embed')}>
                    {playerMode === 'embed' ? <><Play size={12} /> Direct player</> : <><Film size={12} /> Embed</>}
                  </button>
                </div>

                {qualityMenuOpen && playerMode === 'stream' && (
                  <div className="yt-menu" role="menu">
                    <p className="yt-menu-title">Quality</p>
                    <button
                      role="menuitemradio"
                      aria-checked={!audioOnly && quality === 'auto'}
                      className={!audioOnly && quality === 'auto' ? 'active' : ''}
                      onClick={() => { setQuality('auto'); setAudioOnly(false); setQualityMenuOpen(false); }}
                    >
                      <span>Auto</span>
                      <small>{qualities[preferredQualityIndex]?.height ? `${qualities[preferredQualityIndex].height}p` : 'best for connection'}</small>
                      {!audioOnly && quality === 'auto' && <Check size={13} />}
                    </button>
                    {qualities.map((track, index) => (
                      <button
                        key={`${track.height}-${index}`}
                        role="menuitemradio"
                        aria-checked={!audioOnly && quality === index}
                        className={!audioOnly && quality === index ? 'active' : ''}
                        onClick={() => { setQuality(index); setAudioOnly(false); setQualityMenuOpen(false); }}
                      >
                        <span>{track.height ? `${track.height}p` : track.label}</span>
                        <small>{track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : track.mime.split(';')[0]}{track.hasAudio === false ? ' · silent' : ''}</small>
                        {!audioOnly && quality === index && <Check size={13} />}
                      </button>
                    ))}
                    {audioTrack && (
                      <button
                        role="menuitemradio"
                        aria-checked={audioOnly}
                        className={audioOnly ? 'active' : ''}
                        onClick={() => { setAudioOnly(true); setQualityMenuOpen(false); }}
                      >
                        <span>Audio only</span>
                        <small>{audioTrack.label}</small>
                        {audioOnly && <Check size={13} />}
                      </button>
                    )}
                    <div className="yt-menu-foot">
                      <button onClick={() => { setPlayerMode('embed'); setQualityMenuOpen(false); }}><Film size={11} /> Use YouTube embed</button>
                      <button onClick={() => openSafeExternalUrl(youtubeWatchUrl(detail.id))}><ExternalLink size={11} /> Up to 4K on YouTube</button>
                    </div>
                  </div>
                )}

                {settingsOpen && (
                  <div className="yt-menu wide" role="dialog" aria-label="Player settings">
                    <p className="yt-menu-title">Player settings</p>
                    <label className="yt-menu-field">
                      <span><Globe size={12} /> Player language</span>
                      <select
                        value={prefs.language}
                        onChange={(event) => setPrefs((current) => ({ ...current, language: event.target.value }))}
                      >
                        {LANGUAGES.map((language) => (
                          <option key={language.id} value={language.id}>{language.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="yt-menu-field">
                      <span><Captions size={12} /> Captions</span>
                      <button
                        className={`yt-switch ${prefs.captions ? 'on' : ''}`}
                        role="switch"
                        aria-checked={prefs.captions}
                        onClick={() => setPrefs((current) => ({ ...current, captions: !current.captions }))}
                      >
                        <span />
                        {prefs.captions ? 'On' : 'Off'}
                      </button>
                    </label>
                    {prefs.captions && (
                      <label className="yt-menu-field">
                        <span><Languages size={12} /> Caption language</span>
                        <select
                          value={prefs.captionLanguage}
                          onChange={(event) => setPrefs((current) => ({ ...current, captionLanguage: event.target.value }))}
                        >
                          {LANGUAGES.map((language) => (
                            <option key={language.id} value={language.id}>{language.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="yt-menu-field">
                      <span><Sparkles size={12} /> Default quality</span>
                      <select
                        value={prefs.quality}
                        onChange={(event) => setPrefs((current) => ({ ...current, quality: event.target.value as PlayerPrefs['quality'] }))}
                      >
                        <option value="auto">Auto (up to 720p)</option>
                        <option value="highest">Highest available</option>
                        <option value="data-saver">Data saver (lowest)</option>
                      </select>
                    </label>
                    <label className="yt-menu-field">
                      <span><Film size={12} /> Embed host</span>
                      <select
                        value={prefs.noCookie ? 'nocookie' : 'youtube'}
                        onChange={(event) => setPrefs((current) => ({ ...current, noCookie: event.target.value === 'nocookie' }))}
                      >
                        <option value="nocookie">youtube-nocookie.com (private)</option>
                        <option value="youtube">youtube.com</option>
                      </select>
                    </label>
                    <label className="yt-menu-field">
                      <span><Gauge size={12} /> Playback speed</span>
                      <select
                        value={String(prefs.speed)}
                        onChange={(event) => setPrefs((current) => ({ ...current, speed: Number(event.target.value) }))}
                      >
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                          <option key={rate} value={rate}>{rate === 1 ? 'Normal' : `${rate}×`}</option>
                        ))}
                      </select>
                    </label>
                    {prefs.captions && (
                      <label className="yt-menu-field">
                        <span><Captions size={12} /> Caption size</span>
                        <select
                          value={prefs.captionSize}
                          onChange={(event) => setPrefs((current) => ({ ...current, captionSize: event.target.value as PlayerPrefs['captionSize'] }))}
                        >
                          <option value="small">Small</option>
                          <option value="medium">Medium</option>
                          <option value="large">Large</option>
                        </select>
                      </label>
                    )}
                    <label className="yt-menu-field">
                      <span><SkipForward size={12} /> Autoplay next</span>
                      <button
                        className={`yt-switch ${prefs.autoplayNext ? 'on' : ''}`}
                        role="switch"
                        aria-checked={prefs.autoplayNext}
                        onClick={() => setPrefs((current) => ({ ...current, autoplayNext: !current.autoplayNext }))}
                      >
                        <span />
                        {prefs.autoplayNext ? 'On' : 'Off'}
                      </button>
                    </label>
                    <div className="yt-menu-foot">
                      <button onClick={() => { setPlayerMode('stream'); setSettingsOpen(false); }}><Play size={11} /> Direct player</button>
                      <button onClick={() => setEmbedReferrer('')}><X size={11} /> Clear embed referrer</button>
                    </div>
                    <p className="yt-menu-note">
                      Language, captions and caption language apply to the YouTube embed. Speed and default quality apply to both players. Nothing is stored anywhere except this device.
                    </p>
                  </div>
                )}
              </div>
            )}

            {(activeIsSilent || silentWarning || playerError) && detail && (
              <div className="yt-inline-warn" role="status">
                <CircleAlert size={14} />
                <span>{playerError || (activeIsSilent ? 'This quality is video-only on this source.' : 'This stream is muted or silent.')}</span>
                <button onClick={() => setPlayerMode('embed')}>Embed</button>
                <button onClick={() => openSafeExternalUrl(youtubeWatchUrl(detail.id))}>YouTube</button>
              </div>
            )}

            {/* title + meta, YouTube layout */}
            <div className="yt-watch-head">
              <h1>{detail?.title || 'Loading…'}</h1>
              <div className="yt-watch-meta">
                {detail?.channel && (
                  <span className="yt-watch-channel">
                    <Thumb src={detail.channelAvatar} width={80} className="yt-avatar" />
                    <span>
                      <strong>{detail.channel}</strong>
                      <small>{detail.channelSubscribers || 'YouTube channel'}</small>
                    </span>
                  </span>
                )}
                {detail?.channelId && (
                  <button
                    className={`yt-subscribe-pill ${isSubscribed(detail.channelId) ? 'subscribed' : ''}`}
                    onClick={() => toggleSubscribe({ id: detail.channelId, name: detail.channel, avatar: detail.channelAvatar })}
                  >
                    {isSubscribed(detail.channelId) ? <><BellRing size={13} /> Subscribed</> : <><Bell size={13} /> Subscribe</>}
                  </button>
                )}
                <div className="yt-action-pills">
                  <button className={liked === 'up' ? 'active' : ''} onClick={() => setLiked((current) => (current === 'up' ? null : 'up'))}>
                    <ThumbsUp size={14} /> {detail?.likes || 'Like'}
                  </button>
                  <button className={liked === 'down' ? 'active' : ''} onClick={() => setLiked((current) => (current === 'down' ? null : 'down'))}>
                    <ThumbsDown size={14} />
                  </button>
                  <button onClick={() => { if (detail) void shareVideo(detail.id); }}>
                    {copied ? <><Check size={14} /> Copied</> : <><Share2 size={14} /> Share</>}
                  </button>
                  <button onClick={() => detail && playInPraha(detail)}><Play size={14} /> Play in PRAHA</button>
                  <button onClick={() => detail && onEmbed(youtubeMedia(detail, detail.id))}><Film size={14} /> Embedded players</button>
                </div>
              </div>
            </div>

            {/* description card */}
            {detail && (
              <div className={`yt-desc ${described ? 'open' : ''}`} onClick={() => setDescribed((open) => !open)}>
                <div className="yt-desc-stats">
                  <strong>{detail.views || '—'}</strong>
                  <span>{detail.published || ''}</span>
                  {detail.keywords?.slice(0, 4).map((keyword) => <em key={keyword}>#{keyword.replace(/\s+/g, '')}</em>)}
                </div>
                <p>{described ? detail.description || 'No description.' : `${(detail.description || 'No description.').slice(0, 190)}${(detail.description || '').length > 190 ? '…' : ''}`}</p>
                <button className="yt-desc-toggle">{described ? 'Show less' : 'Show more'}</button>
              </div>
            )}

            {/* chapters */}
            {detail && detail.chapters.length > 0 && (
              <div className="yt-chapters">
                <p className="yt-label">Chapters</p>
                <div className="yt-chapter-list">
                  {detail.chapters.map((chapter) => (
                    <button key={`${chapter.start}-${chapter.title}`} onClick={() => { if (videoRef.current) videoRef.current.currentTime = chapter.start; }}>
                      <b>{formatClock(chapter.start)}</b> {chapter.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* comments */}
            {detail && (
              <div className="yt-comments">
                <p className="yt-label">Comments {detail.comments.length ? `· ${detail.comments.length}` : ''}</p>
                {detail.comments.length === 0 && (
                  <p className="yt-muted">This data source does not return comments. Open the video on YouTube to read them.</p>
                )}
                {detail.comments.map((comment) => (
                  <div key={comment.id} className="yt-comment">
                    <span className="yt-comment-avatar">{comment.author.charAt(0).toUpperCase()}</span>
                    <div>
                      <strong>{comment.author} <small>{comment.published}</small></strong>
                      <p>{comment.text}</p>
                      <small>{comment.likes ? `${comment.likes} likes` : ''}{comment.replies ? ` · ${comment.replies} replies` : ''}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* right column: up next, YouTube style */}
          <aside className="yt-watch-side">
            <div className="yt-side-head">
              <h2>Up next</h2>
              <button
                className={`yt-autoplay ${prefs.autoplayNext ? 'on' : ''}`}
                onClick={() => setPrefs((current) => ({ ...current, autoplayNext: !current.autoplayNext }))}
              >
                <span /> Autoplay
              </button>
            </div>
            {nextUp.map((video) => (
              <button key={video.id} className="yt-side-card" onClick={() => openVideo(video)}>
                <span className="yt-side-art">
                  <Thumb src={video.thumbnail} width={320} className="yt-side-thumb" />
                  {video.duration && <small>{video.duration}</small>}
                </span>
                <span className="yt-side-copy">
                  <strong>{video.title}</strong>
                  <small>{video.channel}</small>
                  <small>{[compactViews(video.views), video.published].filter(Boolean).join(' · ')}</small>
                </span>
              </button>
            ))}
            {nextUp.length === 0 && <p className="yt-muted">No related videos returned.</p>}
          </aside>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ *
   * Browse
   * ------------------------------------------------------------------ */
  const errorCard = (message: string, onRetry: () => void) => (
    <div className="yt-empty">
      <span><CircleAlert size={26} /></span>
      <h2>Could not load {mode === 'music' ? 'music' : 'YouTube'}</h2>
      <p>YouTube refused the request and no mirror took over. Often this is the network, not PRAHA.</p>
      <pre className="yt-error-detail">{message.replace(/ · /g, '\n')}</pre>
      <div className="yt-empty-actions">
        <button className="yt-btn primary" onClick={onRetry}><RefreshCw size={14} /> Try again</button>
        <button className="yt-btn" onClick={() => { void checkMirrors(); }}>{mirrorChecking ? 'Checking…' : 'Check mirrors'}</button>
      </div>
    </div>
  );

  return (
    <div className={`flow-page yt-app page-enter ${mode === 'music' ? 'music-mode' : ''}`}>
      {/* mode switch: YouTube / YouTube Music */}
      <header className="yt-topbar">
        <div className="yt-brand">
          <span className={`yt-logo ${mode === 'music' ? 'music' : ''}`}>
            {mode === 'music' ? <Music size={16} /> : <Play size={15} fill="currentColor" />}
          </span>
          <div>
            <strong>{mode === 'music' ? 'YouTube Music' : 'YouTube'}</strong>
            <small>{backend === 'youtube' ? 'direct' : backend === 'mirror' ? 'via mirror' : 'flow'}</small>
          </div>
        </div>

        <form className="yt-search" onSubmit={submitSearch}>
          <Search size={15} />
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={mode === 'music' ? 'Songs, artists, albums, mixes…' : 'Search YouTube or paste a link…'}
            aria-label={mode === 'music' ? 'Search music' : 'Search YouTube'}
          />
          {term && <button type="button" className="yt-search-clear" onClick={() => { setTerm(''); setResults(null); setSubmitted(''); }} aria-label="Clear">×</button>}
          <button type="submit" className="yt-search-go" aria-label="Search"><Search size={14} /></button>
        </form>

        <div className="yt-mode-switch" role="tablist" aria-label="Flow mode">
          <button role="tab" aria-selected={mode === 'youtube'} className={mode === 'youtube' ? 'active' : ''} onClick={() => { setMode('youtube'); setSection('home'); setResults(null); setSubmitted(''); }}>
            <Video size={13} /> YouTube
          </button>
          <button role="tab" aria-selected={mode === 'music'} className={mode === 'music' ? 'active' : ''} onClick={() => { setMode('music'); setSection('home'); setResults(null); setSubmitted(''); }}>
            <Music size={13} /> Music
          </button>
          <button
            className="yt-icon-btn"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Player settings"
            aria-expanded={settingsOpen}
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* mini settings drawer for the browse screen */}
      {settingsOpen && !detailId && (
        <div className="yt-settings-sheet">
          <p className="yt-menu-title">Flow settings</p>
          <div className="yt-settings-grid">
            <label className="yt-menu-field">
              <span><Globe size={12} /> Player language</span>
              <select value={prefs.language} onChange={(event) => setPrefs((current) => ({ ...current, language: event.target.value }))}>
                {LANGUAGES.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
              </select>
            </label>
            <label className="yt-menu-field">
              <span><Sparkles size={12} /> Default quality</span>
              <select value={prefs.quality} onChange={(event) => setPrefs((current) => ({ ...current, quality: event.target.value as PlayerPrefs['quality'] }))}>
                <option value="auto">Auto (up to 720p)</option>
                <option value="highest">Highest available</option>
                <option value="data-saver">Data saver</option>
              </select>
            </label>
            <label className="yt-menu-field">
              <span><Captions size={12} /> Captions</span>
              <button className={`yt-switch ${prefs.captions ? 'on' : ''}`} role="switch" aria-checked={prefs.captions} onClick={() => setPrefs((current) => ({ ...current, captions: !current.captions }))}>
                <span /> {prefs.captions ? 'On' : 'Off'}
              </button>
            </label>
            {prefs.captions && (
              <label className="yt-menu-field">
                <span><Languages size={12} /> Caption language</span>
                <select value={prefs.captionLanguage} onChange={(event) => setPrefs((current) => ({ ...current, captionLanguage: event.target.value }))}>
                  {LANGUAGES.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
                </select>
              </label>
            )}
            <label className="yt-menu-field">
              <span><Gauge size={12} /> Playback speed</span>
              <select value={String(prefs.speed)} onChange={(event) => setPrefs((current) => ({ ...current, speed: Number(event.target.value) }))}>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <option key={rate} value={rate}>{rate === 1 ? 'Normal' : `${rate}×`}</option>
                ))}
              </select>
            </label>
            <label className="yt-menu-field">
              <span><Radio size={12} /> Flow radio</span>
              <button className={`yt-switch ${radioPlaying ? 'on' : ''}`} role="switch" aria-checked={radioPlaying} onClick={() => setRadioPlaying((on) => !on)}>
                <span /> {radioPlaying ? 'Playing' : 'Off'}
              </button>
            </label>
          </div>
          {radioPlaying && (
            <div className="yt-radio">
              <span className="status-dot" />
              <div><strong>{FLOW_RADIO.name}</strong><p>{FLOW_RADIO.description}</p></div>
              <audio src={FLOW_RADIO.url} controls autoPlay preload="none" />
            </div>
          )}
          <div className="yt-settings-foot">
            <a className="yt-btn" href={FLOW_RELEASES} target="_blank" rel="noreferrer noopener">Get Flow for Android <ExternalLink size={12} /></a>
            <a className="yt-btn" href={FLOW_REPO} target="_blank" rel="noreferrer noopener">Source on GitHub</a>
            <button className="yt-btn" onClick={() => { setShowMirrors((open) => !open); }}>Mirrors</button>
            {android && <button className="yt-btn" onClick={() => openSafeExternalUrl(FLOW_RELEASES)}>Flow app</button>}
          </div>
          {showMirrors && (
            <div className="yt-mirrors">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setMirrorError('');
                  try {
                    const url = normalizeMirrorUrl(mirrorDraft);
                    setMirrors((current) => (current.includes(url) ? current : [url, ...current]));
                    setMirrorDraft('');
                    setReloadToken((token) => token + 1);
                  } catch (error) {
                    setMirrorError(error instanceof Error ? error.message : 'Invalid mirror URL.');
                  }
                }}
              >
                <input value={mirrorDraft} onChange={(event) => setMirrorDraft(event.target.value)} placeholder="https://pipedapi.example.com" aria-label="Add a mirror" />
                <button type="submit" className="yt-btn"><Plus size={13} /></button>
              </form>
              {mirrorError && <p className="yt-muted error">{mirrorError}</p>}
              <button className="yt-btn small" onClick={() => { void checkMirrors(); }}>{mirrorChecking ? 'Testing…' : 'Test all mirrors'}</button>
              {lastProbeLog.slice(0, 8).map((probe) => (
                <div key={`${probe.base}-${probe.kind}-${probe.detail}`} className={`yt-probe ${probe.ok ? 'ok' : 'bad'}`}>
                  <span>{probe.base.replace(/^https:\/\//, '')} <small>{probe.kind}</small></span>
                  <b>{probe.ok ? `${probe.videos ?? 0} videos` : probe.detail}</b>
                </div>
              ))}
              {mirrors.map((mirror) => (
                <div key={mirror} className="yt-mirror-row">
                  <span>{mirror.replace(/^https:\/\//, '')}</span>
                  <button onClick={() => setMirrors((current) => current.filter((entry) => entry !== mirror))} aria-label={`Remove ${mirror}`}><Trash2 size={12} /></button>
                </div>
              ))}
              <button className="yt-btn small" onClick={() => { setMirrors(DEFAULT_MIRRORS); retryFetch(); }}>Reset mirrors</button>
            </div>
          )}
        </div>
      )}

      <div className="yt-body">
        {/* left rail */}
        <nav className="yt-rail" aria-label="Flow sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`yt-rail-item ${section === item.id ? 'active' : ''}`}
                onClick={() => { setSection(item.id); if (item.id !== 'search') { setResults(null); } }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.id === 'subscriptions' && subs.length > 0 && <b>{subs.length}</b>}
              </button>
            );
          })}
          {subs.length > 0 && (
            <>
              <p className="yt-rail-label">Subscriptions</p>
              {subs.slice(0, 6).map((entry) => (
                <button key={entry.id} className="yt-rail-channel" onClick={() => loadChannel(entry.id)}>
                  <span className="yt-rail-avatar">{(entry.name || '?').charAt(0).toUpperCase()}</span>
                  <span>{entry.name.length > 15 ? `${entry.name.slice(0, 15)}…` : entry.name}</span>
                </button>
              ))}
            </>
          )}
          <p className="yt-rail-label">More from Flow</p>
          <button className="yt-rail-item" onClick={() => setShowMirrors((open) => !open)}><Radio size={16} /><span>Mirrors</span></button>
        </nav>

        {/* main column */}
        <main className="yt-main">
          {section === 'home' && mode === 'youtube' && (
            <>
              <div className="yt-chipbar">
                {YT_CHIPS.map((chip) => (
                  <button key={chip} className="yt-chip" onClick={() => submitSearch(undefined, chip)}>{chip}</button>
                ))}
              </div>
              {homeState === 'loading' && <div className="yt-loading"><LoaderCircle size={18} className="spin" /> Loading YouTube…</div>}
              {homeState === 'error' && errorCard(homeError, retryFetch)}
              {homeState === 'ready' && home?.shelves.map((shelf) => (
                <Shelf key={shelf.id} title={shelf.title} videos={shelf.videos} onOpen={openVideo} note={`${shelf.videos.length} videos`} />
              ))}
              {recent.length > 0 && (
                <Shelf title="Recently watched" videos={recent as YtVideo[]} onOpen={openVideo} note="on this device" />
              )}
            </>
          )}

          {section === 'home' && mode === 'music' && (
            <>
              <div className="yt-chipbar">
                {MUSIC_MOODS.map((mood) => (
                  <button key={mood} className="yt-chip" onClick={() => submitSearch(undefined, mood)}>{mood}</button>
                ))}
              </div>
              {musicState === 'loading' && <div className="yt-loading"><LoaderCircle size={18} className="spin" /> Loading music…</div>}
              {musicState === 'error' && errorCard(musicError, retryFetch)}
              {musicState === 'ready' && musicHome?.shelves.map((shelf) => (
                <Shelf key={shelf.id} title={shelf.title} videos={shelf.videos} onOpen={openVideo} note="songs only" />
              ))}
            </>
          )}

          {section === 'search' && (
            <>
              <div className="yt-search-head">
                <h2>{mode === 'music' ? 'Music results' : 'Results'} for “{submitted}”</h2>
                <button className="yt-btn small" onClick={() => { setSection('home'); setResults(null); setSubmitted(''); }}>Clear</button>
              </div>
              {searching && <div className="yt-loading"><LoaderCircle size={18} className="spin" /> Searching…</div>}
              {searchError && <div className="yt-inline-warn"><CircleAlert size={14} /><span>{searchError}</span></div>}

              {searchVideoId() && (
                <button className="yt-open-link" onClick={() => openVideo(searchVideoId() as string)}>
                  <Play size={14} /> Open the pasted video
                </button>
              )}

              {results && results.channels.length > 0 && mode === 'youtube' && (
                <section className="yt-shelf">
                  <div className="yt-shelf-head"><h2>Channels</h2></div>
                  <div className="yt-channel-grid">
                    {results.channels.slice(0, 6).map((channel) => (
                      <div key={channel.id} className="yt-channel-card">
                        <button className="yt-channel-open" onClick={() => loadChannel(channel.id)}>
                          <Thumb src={channel.thumbnail} width={96} className="yt-avatar large" />
                          <span>
                            <strong>{channel.name}</strong>
                            <small>{channel.subscribers || channel.handle || 'Channel'}</small>
                          </span>
                        </button>
                        <button
                          className={`yt-subscribe-pill small ${isSubscribed(channel.id) ? 'subscribed' : ''}`}
                          onClick={() => toggleSubscribe({ id: channel.id, name: channel.name, avatar: channel.thumbnail })}
                        >
                          {isSubscribed(channel.id) ? <><Check size={12} /> Subscribed</> : <><Plus size={12} /> Subscribe</>}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {results && results.videos.length > 0 && (
                <section className="yt-shelf">
                  <div className="yt-shelf-head"><h2>{results.videos.length} videos</h2></div>
                  <div className="yt-grid">
                    {results.videos.map((video) => <VideoCard key={video.id} video={video} onOpen={() => openVideo(video)} />)}
                  </div>
                </section>
              )}

              {results && !results.videos.length && !searching && (
                <div className="yt-empty small"><span><Search size={22} /></span><h2>Nothing matched</h2><p>Try different words or paste a direct YouTube link.</p></div>
              )}
            </>
          )}

          {section === 'subscriptions' && (
            <div className="yt-subs-layout">
              <aside className="yt-subs-list">
                <p className="yt-label">Subscriptions</p>
                <form className="yt-add-channel" onSubmit={addChannel}>
                  <input value={channelDraft} onChange={(event) => setChannelDraft(event.target.value)} placeholder="@handle or /channel/ link" aria-label="Add a channel" />
                  <button type="submit" className="yt-btn primary"><Plus size={13} /></button>
                </form>
                {channelError && <p className="yt-muted error">{channelError}</p>}
                {subs.length === 0 && <p className="yt-muted">No subscriptions yet. Everything stays on this device.</p>}
                {subs.map((entry) => (
                  <div key={entry.id} className={`yt-sub-row ${feedId === entry.id ? 'active' : ''}`}>
                    <button className="yt-sub-open" onClick={() => loadChannel(entry.id)}>
                      <span className="yt-rail-avatar">{(entry.name || '?').charAt(0).toUpperCase()}</span>
                      <span>{entry.name.length > 12 ? `${entry.name.slice(0, 12)}…` : entry.name}</span>
                    </button>
                    <button className="yt-sub-remove" onClick={() => setSubs((current) => current.filter((item) => item.id !== entry.id))} aria-label={`Unsubscribe from ${entry.name}`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </aside>
              <div className="yt-subs-feed">
                {subs.length === 0 && (
                  <div className="yt-empty"><span><BellRing size={24} /></span><h2>Follow channels your way</h2><p>Add a channel here or press Subscribe on any video. No account is created.</p></div>
                )}
                {subs.length > 0 && !feed && feedState !== 'loading' && (
                  <button className="yt-open-link" onClick={() => loadChannel(subs[0].id)}>
                    <ChevronRight size={14} /> Open {subs[0].name || 'your first channel'}
                  </button>
                )}
                {feedState === 'loading' && <div className="yt-loading"><LoaderCircle size={18} className="spin" /> Loading channel…</div>}
                {feedState === 'error' && <div className="yt-inline-warn"><CircleAlert size={14} /><span>{feedError}</span></div>}
                {feedState === 'ready' && feed && (
                  <>
                    <div className="yt-channel-banner">
                      <Thumb src={feed.avatar} width={128} className="yt-avatar xl" />
                      <div>
                        <h2>{feed.title}</h2>
                        <p>{feed.subscribers || `${feed.videos.length} uploads`}</p>
                      </div>
                      <button
                        className={`yt-subscribe-pill ${isSubscribed(feed.channelId) ? 'subscribed' : ''}`}
                        onClick={() => toggleSubscribe({ id: feed.channelId, name: feed.title, avatar: feed.avatar })}
                      >
                        {isSubscribed(feed.channelId) ? <><Check size={13} /> Subscribed</> : <><Bell size={13} /> Subscribe</>}
                      </button>
                      <button className="yt-btn small" onClick={() => openSafeExternalUrl(youtubeChannelUrl(feed.channelId))}>
                        YouTube <ExternalLink size={12} />
                      </button>
                    </div>
                    <div className="yt-grid">
                      {feed.videos.map((video) => <VideoCard key={video.id} video={video} onOpen={() => openVideo(video)} />)}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {section === 'channel' && (
            <>
              {feedState === 'loading' && <div className="yt-loading"><LoaderCircle size={18} className="spin" /> Loading channel…</div>}
              {feedState === 'error' && <div className="yt-inline-warn"><CircleAlert size={14} /><span>{feedError}</span></div>}
              {feedState === 'ready' && feed && (
                <>
                  <div className="yt-channel-banner">
                    <Thumb src={feed.avatar} width={128} className="yt-avatar xl" />
                    <div>
                      <h2>{feed.title}</h2>
                      <p>{feed.subscribers || `${feed.videos.length} uploads`}</p>
                      {feed.description && <p className="yt-muted clamp">{feed.description}</p>}
                    </div>
                    <button
                      className={`yt-subscribe-pill ${isSubscribed(feed.channelId) ? 'subscribed' : ''}`}
                      onClick={() => toggleSubscribe({ id: feed.channelId, name: feed.title, avatar: feed.avatar })}
                    >
                      {isSubscribed(feed.channelId) ? <><Check size={13} /> Subscribed</> : <><Bell size={13} /> Subscribe</>}
                    </button>
                  </div>
                  <div className="yt-grid">
                    {feed.videos.map((video) => <VideoCard key={video.id} video={video} onOpen={() => openVideo(video)} />)}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default FlowView;
