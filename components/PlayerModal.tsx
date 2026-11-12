import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, CircleAlert, Copy, ExternalLink, FastForward, Link, LoaderCircle,
  Magnet, Play, ShieldCheck, Smartphone, Sparkles, X,
} from 'lucide-react';
import type {
  DebridSettings, InstalledAddon, IntroSegment, MediaItem, PlayerSettings,
  StreamResult, StreamSubtitle,
} from '../types';
import { findStremioSubtitles } from '../services/stremioService';
import { fetchIntroSegments } from '../services/introService';
import { buildMagnetUri, isMagnetOrTorrent, resolveDebridStream } from '../services/debridService';
import { TorrentStreamingEngine, type TorrentStreamStats } from '../services/torrentStreamingService';
import {
  extractStreamHeaders, hasNativeHeaderProxy, isAndroidApp, isNativeVlcAvailable, nativeVlcStop, openExternalPlayer,
  resolvePlayableStreamUrl, setImmersiveFullscreen,
} from '../services/androidBridge';
import MpvPlayer from './player/MpvPlayer';

/** Stream URLs come from untrusted addons/Nuvio plugins. Only http(s) may be framed. */
function safeFrameUrl(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const PlayerModal: React.FC<{
  media: MediaItem;
  stream: StreamResult;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  initialTime?: number;
  addons: InstalledAddon[];
  debrid: DebridSettings;
  preferNativeProxy: boolean;
  autoplay: boolean;
  playerSettings: PlayerSettings;
  onPlayerSettingsChange: (patch: Partial<PlayerSettings>) => void;
  onProgress: (currentTime: number, duration: number) => void;
  onTryAnother?: () => void;
  onFindSources?: () => void;
  onNextEpisode?: () => void;
  nextEpisodeLoading?: boolean;
  onOpenSettings?: () => void;
  onClose: () => void;
}> = ({
  media,
  stream,
  season,
  episode,
  episodeTitle,
  initialTime = 0,
  addons,
  debrid,
  preferNativeProxy,
  autoplay,
  playerSettings,
  onPlayerSettingsChange,
  onProgress,
  onTryAnother,
  onFindSources,
  onNextEpisode,
  nextEpisodeLoading = false,
  onOpenSettings,
  onClose,
}) => {
  // The Android player is already a full-screen modal. Lock the activity as
  // soon as it opens rather than requiring a second fullscreen tap.
  useEffect(() => {
    if (!isAndroidApp()) return;
    void setImmersiveFullscreen(true, true);
    return () => { void setImmersiveFullscreen(false, false); };
  }, []);

  const [copied, setCopied] = useState(false);
  const [activeStream, setActiveStream] = useState<StreamResult>(stream);
  const [debridBusy, setDebridBusy] = useState(false);
  const [debridError, setDebridError] = useState('');
  const [torrentBusy, setTorrentBusy] = useState(false);
  const [torrentError, setTorrentError] = useState('');
  const [torrentStats, setTorrentStats] = useState<TorrentStreamStats | null>(null);
  const [addonSubtitles, setAddonSubtitles] = useState<StreamSubtitle[]>([]);
  const [introSegments, setIntroSegments] = useState<IntroSegment[]>([]);

  useEffect(() => {
    setActiveStream(stream);
    setDebridError('');
    setTorrentError('');
  }, [stream]);

  // Auto-resolve magnet/torrent via Debrid if configured
  useEffect(() => {
    if (!isMagnetOrTorrent(stream)) return;
    if (debrid.provider === 'none' || !debrid.apiKey.trim()) return;
    let cancelled = false;
    setDebridBusy(true);
    setDebridError('');
    resolveDebridStream(stream, debrid)
      .then((resolved) => {
        if (!cancelled) setActiveStream(resolved);
      })
      .catch((err) => {
        if (!cancelled) setDebridError(err instanceof Error ? err.message : 'Debrid resolution failed.');
      })
      .finally(() => {
        if (!cancelled) setDebridBusy(false);
      });
    return () => { cancelled = true; };
  }, [stream, debrid]);

  // Load Stremio subtitle addons + IntroDB segment timestamps
  useEffect(() => {
    let cancelled = false;
    findStremioSubtitles(addons, media, season, episode, activeStream)
      .then((subs) => { if (!cancelled) setAddonSubtitles(subs); })
      .catch(() => { if (!cancelled) setAddonSubtitles([]); });

    if (media.type === 'series' && season && episode) {
      fetchIntroSegments(media.imdbId || (media.id.startsWith('tt') ? media.id : undefined), season, episode)
        .then((segs) => { if (!cancelled) setIntroSegments(segs); })
        .catch(() => { if (!cancelled) setIntroSegments([]); });
    } else {
      setIntroSegments([]);
    }
    return () => { cancelled = true; };
  }, [addons, media, season, episode, activeStream]);

  const isMagnet = isMagnetOrTorrent(activeStream) && activeStream.url.startsWith('magnet:');
  const isYoutube = Boolean(activeStream.ytId);
  const isEmbed = activeStream.format === 'embed' || /vidsrc\.to\/embed|\/embed\//i.test(activeStream.url || '');
  const isNative = !isMagnet && !isYoutube && !isEmbed;

  const customHeaders = useMemo(() => extractStreamHeaders(activeStream), [activeStream]);
  const hasCustomHeaders = Object.keys(customHeaders).length > 0;
  const nativeProxyActive = hasCustomHeaders && preferNativeProxy && hasNativeHeaderProxy();
  const effectiveUrl = useMemo(
    () => resolvePlayableStreamUrl(activeStream, preferNativeProxy),
    [activeStream, preferNativeProxy],
  );

  const nextEpisodeLabel = media.type === 'series' && season && episode
    ? `S${season} E${episode + 1}`
    : undefined;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && !isNative && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose, isNative]);

  const copyLink = async () => {
    const targetUrl = isMagnet ? buildMagnetUri(activeStream) : activeStream.url;
    await navigator.clipboard.writeText(targetUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const manualResolveDebrid = async () => {
    setDebridBusy(true);
    setDebridError('');
    try {
      const resolved = await resolveDebridStream(stream, debrid);
      setActiveStream(resolved);
    } catch (err) {
      setDebridError(err instanceof Error ? err.message : 'Unable to resolve magnet via Debrid.');
    } finally {
      setDebridBusy(false);
    }
  };

  const manualStreamTorrent = async () => {
    setTorrentBusy(true);
    setTorrentError('');
    try {
      const isAvail = await TorrentStreamingEngine.checkEngineAvailable();
      if (!isAvail) {
        throw new Error('Torrent Engine (TorrServer) is offline on port 8090. Configure Debrid in Settings or open in an external torrent app.');
      }
      const { streamUrl, infoHash } = await TorrentStreamingEngine.streamTorrent(activeStream.url, {
        title: activeStream.title || media.title,
        fileIdx: activeStream.fileIdx,
      });
      setActiveStream({
        ...activeStream,
        url: streamUrl,
        format: 'torrent-http',
        provider: `${activeStream.provider || 'Torrent'} (Torrent Engine)`,
      });
      TorrentStreamingEngine.subscribeStats(infoHash, (stats) => setTorrentStats(stats));
    } catch (err) {
      setTorrentError(err instanceof Error ? err.message : 'Unable to connect to Torrent Streaming Engine.');
    } finally {
      setTorrentBusy(false);
    }
  };

  const fullTitle = media.type === 'series' && season
    ? `${media.title} · S${season} E${episode || 1}${episodeTitle ? ` — ${episodeTitle}` : ''}`
    : media.title;

  const handleClose = () => {
    try {
      nativeVlcStop();
      document.documentElement.classList.remove('player-vlc-active');
      document.body.classList.remove('player-vlc-active');
      document.getElementById('root')?.classList.remove('player-vlc-active');
    } catch {}
    onClose();
  };

  useEffect(() => {
    if (isNativeVlcAvailable() && isNative) {
      document.documentElement.classList.add('player-vlc-active');
      document.body.classList.add('player-vlc-active');
      document.getElementById('root')?.classList.add('player-vlc-active');
      return () => {
        document.documentElement.classList.remove('player-vlc-active');
        document.body.classList.remove('player-vlc-active');
        document.getElementById('root')?.classList.remove('player-vlc-active');
        nativeVlcStop();
      };
    } else {
      return () => {
        nativeVlcStop();
      };
    }
  }, [isNative]);

  if (isNative) {
    return (
      <div
        className={`player-fullscreen-root ${isNativeVlcAvailable() ? 'vlc-transparent' : ''}`}
        style={{ background: isNativeVlcAvailable() ? 'transparent' : '#000' }}
      >
        <MpvPlayer
          stream={activeStream}
          effectiveUrl={effectiveUrl}
          externalSubtitles={addonSubtitles}
          introSegments={introSegments}
          initialTime={initialTime}
          media={media}
          season={season}
          episode={episode}
          episodeTitle={episodeTitle}
          nextEpisodeLabel={nextEpisodeLabel}
          onNextEpisode={onNextEpisode}
          nextEpisodeLoading={nextEpisodeLoading}
          onProgress={onProgress}
          autoplay={autoplay}
          settings={playerSettings}
          onSettingsChange={onPlayerSettingsChange}
          onRequestClose={handleClose}
          onTryAnother={onTryAnother}
          onFindSources={onFindSources}
        />
      </div>
    );
  }

  if (isYoutube || isEmbed) {
    const embedSrc = isYoutube
      ? `https://www.youtube.com/embed/${encodeURIComponent(activeStream.ytId || '')}?autoplay=${autoplay ? 1 : 0}`
      : safeFrameUrl(activeStream.url || '');
    return (
      <div className="player-fullscreen-root player-embed-root">
        <div className="player-embed-header">
          <button className="mpv-back-btn" onClick={handleClose} aria-label="Exit player">
            <X size={22} />
          </button>
          <div className="mpv-title-meta">
            <span className="mpv-title-main">{fullTitle}</span>
            <span className="mpv-title-sub">{isYoutube ? 'YouTube · Flow' : activeStream.sourceName || 'Web Player'}</span>
          </div>
          <div className="player-embed-actions">
            <button className="ext-player-chip" onClick={() => openExternalPlayer(activeStream, fullTitle, 'chooser')}>
              External <ExternalLink size={12} />
            </button>
          </div>
        </div>
        <div className="player-embed-body">
          {embedSrc ? (
            <iframe
              src={embedSrc}
              title={media.title}
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-forms allow-presentation"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <div className="player-message" role="alert">
              <span><CircleAlert size={30} /></span>
              <h2>Unsafe embed URL</h2>
              <p>This source returned a non-HTTP URL and was blocked. Open it in an external player instead.</p>
              <button className="button button-secondary" onClick={() => openExternalPlayer(activeStream, fullTitle, 'chooser')}>
                External <ExternalLink size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="player-backdrop">
      <section className="player-modal" role="dialog" aria-modal="true" aria-label={`Playing ${fullTitle}`}>
        <header className="player-header">
          <div>
            <span>NOW PLAYING</span>
            <h2>{fullTitle}</h2>
          </div>
          <div className="player-header-actions">
            <div className="player-source-label">
              {activeStream.sourceType === 'nuvio' ? 'NUVIO' : 'STREMIO'} · {activeStream.sourceName}
            </div>
            <button className="modal-close" onClick={handleClose} aria-label="Close player"><X size={21} /></button>
          </div>
        </header>
        <div className="player-stage">
          <div className="player-message">
            <span>{debridBusy ? <LoaderCircle size={30} className="spin" /> : <Magnet size={30} />}</span>
            <h2>{debridBusy ? 'Unrestricting stream via Debrid…' : 'Torrent / Magnet stream'}</h2>
            <p>
              {debridBusy
                ? 'Converting magnet infoHash into a direct high-speed HTTP stream…'
                : 'Connect Real-Debrid, AllDebrid, or TorBox in Settings to play magnets directly in PRAHA, or open in an external torrent/video app.'}
            </p>
            {debridError && <p className="debrid-inline-error"><CircleAlert size={14} /> {debridError}</p>}
            {torrentError && <p className="debrid-inline-error"><CircleAlert size={14} /> {torrentError}</p>}
            <div>
              <button className="button button-primary" onClick={manualStreamTorrent} disabled={torrentBusy}>
                {torrentBusy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} fill="currentColor" />} Stream with Torrent Engine
              </button>
              {debrid.provider !== 'none' && debrid.apiKey ? (
                <button className="button button-secondary" onClick={manualResolveDebrid} disabled={debridBusy}>
                  <Sparkles size={16} /> Retry Debrid stream
                </button>
              ) : onOpenSettings ? (
                <button className="button button-secondary" onClick={() => { onClose(); onOpenSettings(); }}>
                  <Sparkles size={16} /> Setup Debrid in Settings
                </button>
              ) : null}
              {!debridBusy && onTryAnother && <button className="button button-secondary" onClick={onTryAnother}>Try another source</button>}
              {onFindSources && <button className="button button-secondary" onClick={onFindSources}>Find sources</button>}
              <button className="button button-secondary" onClick={copyLink}>
                {copied ? <Check size={17} /> : <Copy size={17} />}
                {copied ? 'Copied' : 'Copy magnet'}
              </button>
              <a className="button button-primary" href={buildMagnetUri(activeStream)}>
                Open external app <ExternalLink size={16} />
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default PlayerModal;
