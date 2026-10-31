import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, CircleAlert, Copy, ExternalLink, FastForward, Link, LoaderCircle,
  Magnet, ShieldCheck, Smartphone, Sparkles, X,
} from 'lucide-react';
import type {
  DebridSettings, InstalledAddon, IntroSegment, MediaItem, PlayerSettings,
  StreamResult, StreamSubtitle,
} from '../types';
import { findStremioSubtitles } from '../services/stremioService';
import { fetchIntroSegments } from '../services/introService';
import { buildMagnetUri, isMagnetOrTorrent, resolveDebridStream } from '../services/debridService';
import {
  extractStreamHeaders, hasNativeHeaderProxy, isAndroidApp, openExternalPlayer,
  resolvePlayableStreamUrl,
} from '../services/androidBridge';
import MpvPlayer from './player/MpvPlayer';

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
  onNextEpisode,
  nextEpisodeLoading = false,
  onOpenSettings,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const [activeStream, setActiveStream] = useState<StreamResult>(stream);
  const [debridBusy, setDebridBusy] = useState(false);
  const [debridError, setDebridError] = useState('');
  const [addonSubtitles, setAddonSubtitles] = useState<StreamSubtitle[]>([]);
  const [introSegments, setIntroSegments] = useState<IntroSegment[]>([]);

  useEffect(() => {
    setActiveStream(stream);
    setDebridError('');
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

  const fullTitle = media.type === 'series' && season
    ? `${media.title} · S${season} E${episode || 1}${episodeTitle ? ` — ${episodeTitle}` : ''}`
    : media.title;

  return (
    <div className="player-backdrop">
      <section className="player-modal" role="dialog" aria-modal="true" aria-label={`Playing ${fullTitle}`}>
        <header className="player-header">
          <div>
            <span>NOW PLAYING</span>
            <h2>{fullTitle}</h2>
          </div>
          <div className="player-header-actions">
            {onNextEpisode && nextEpisodeLabel && (
              <button className="button button-secondary compact-btn" onClick={onNextEpisode} disabled={nextEpisodeLoading}>
                {nextEpisodeLoading ? <LoaderCircle size={15} className="spin" /> : <FastForward size={15} />}
                {nextEpisodeLoading ? 'Finding stream…' : `Next (${nextEpisodeLabel})`}
              </button>
            )}
            <div className="player-source-label">
              {activeStream.sourceType === 'nuvio' ? 'NUVIO' : activeStream.sourceType === 'cloudstream' ? 'CLOUDSTREAM' : 'STREMIO'} · {activeStream.sourceName}
            </div>
            <button className="modal-close" onClick={onClose} aria-label="Close player"><X size={21} /></button>
          </div>
        </header>
        <div className="player-stage">
          {isYoutube ? (
            <iframe src={`https://www.youtube.com/embed/${activeStream.ytId}?autoplay=${autoplay ? 1 : 0}`} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : isEmbed ? (
            <iframe src={activeStream.url} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : isMagnet ? (
            <div className="player-message">
              <span>{debridBusy ? <LoaderCircle size={30} className="spin" /> : <Magnet size={30} />}</span>
              <h2>{debridBusy ? 'Unrestricting stream via Debrid…' : 'Torrent / Magnet stream'}</h2>
              <p>
                {debridBusy
                  ? 'Converting magnet infoHash into a direct high-speed HTTP stream…'
                  : 'Connect Real-Debrid, AllDebrid, or TorBox in Settings to play magnets directly in PRAHA, or open in an external torrent/video app.'}
              </p>
              {debridError && <p className="debrid-inline-error"><CircleAlert size={14} /> {debridError}</p>}
              <div>
                {debrid.provider !== 'none' && debrid.apiKey ? (
                  <button className="button button-primary" onClick={manualResolveDebrid} disabled={debridBusy}>
                    <Sparkles size={16} /> Retry Debrid stream
                  </button>
                ) : onOpenSettings ? (
                  <button className="button button-secondary" onClick={() => { onClose(); onOpenSettings(); }}>
                    <Sparkles size={16} /> Setup Debrid in Settings
                  </button>
                ) : null}
                <button className="button button-secondary" onClick={copyLink}>
                  {copied ? <Check size={17} /> : <Copy size={17} />}
                  {copied ? 'Copied' : 'Copy magnet'}
                </button>
                <a className="button button-primary" href={buildMagnetUri(activeStream)}>
                  Open external app <ExternalLink size={16} />
                </a>
              </div>
            </div>
          ) : (
            <MpvPlayer
              stream={activeStream}
              effectiveUrl={effectiveUrl}
              externalSubtitles={addonSubtitles}
              introSegments={introSegments}
              initialTime={initialTime}
              media={media}
              season={season}
              episode={episode}
              nextEpisodeLabel={nextEpisodeLabel}
              onNextEpisode={onNextEpisode}
              onProgress={onProgress}
              autoplay={autoplay}
              settings={playerSettings}
              onSettingsChange={onPlayerSettingsChange}
              onRequestClose={onClose}
            />
          )}
        </div>
        <footer className="player-footer">
          <div>
            <strong>{activeStream.title}</strong>
            <span>
              {activeStream.provider || activeStream.sourceName}
              {activeStream.quality ? ` · ${activeStream.quality}` : ''}
              {addonSubtitles.length ? ` · +${addonSubtitles.length} addon subs` : ''}
            </span>
          </div>

          <div className="external-player-bar">
            <button className="ext-player-chip" onClick={() => openExternalPlayer(activeStream, fullTitle, 'vlc')} title="Open in VLC">
              <Smartphone size={13} /> VLC
            </button>
            <button className="ext-player-chip" onClick={() => openExternalPlayer(activeStream, fullTitle, 'mpv')} title="Open in mpv-android">
              mpv
            </button>
            {isAndroidApp() && (
              <button className="ext-player-chip" onClick={() => openExternalPlayer(activeStream, fullTitle, 'mx')} title="Open in MX Player">
                MX
              </button>
            )}
            <button className="ext-player-chip" onClick={() => openExternalPlayer(activeStream, fullTitle, 'chooser')} title="Open in external player">
              External <ExternalLink size={12} />
            </button>
          </div>

          {nativeProxyActive ? (
            <span className="player-proxy-ok"><ShieldCheck size={13} /> Android native header proxy active</span>
          ) : hasCustomHeaders ? (
            <span className="player-warning"><CircleAlert size={13} /> Custom headers work natively in the Android APK or external player.</span>
          ) : isNative ? (
            <span className="player-engine">mpvRx player · <kbd>?</kbd> shortcuts</span>
          ) : null}

          <button className="icon-button" onClick={copyLink} aria-label="Copy stream link">
            {copied ? <Check size={17} /> : <Link size={17} />}
          </button>
        </footer>
      </section>
    </div>
  );
};

export default PlayerModal;
