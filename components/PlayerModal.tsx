import React, { useEffect, useState } from 'react';
import { Check, CircleAlert, Copy, ExternalLink, Link, Magnet, X } from 'lucide-react';
import type { MediaItem, PlayerSettings, StreamResult } from '../types';
import MpvPlayer from './player/MpvPlayer';

/**
 * Player shell. Direct video and HLS streams are handed to the mpvRx-style
 * player; YouTube and embed sources keep their iframes, and magnets are handed
 * to an external application because the web platform has no torrent engine.
 */
const PlayerModal: React.FC<{
  media: MediaItem;
  stream: StreamResult;
  autoplay: boolean;
  playerSettings: PlayerSettings;
  onPlayerSettingsChange: (patch: Partial<PlayerSettings>) => void;
  onClose: () => void;
}> = ({ media, stream, autoplay, playerSettings, onPlayerSettingsChange, onClose }) => {
  const [copied, setCopied] = useState(false);
  const isMagnet = stream.url.startsWith('magnet:') || (!stream.url && Boolean(stream.infoHash));
  const isYoutube = Boolean(stream.ytId);
  const isEmbed = stream.format === 'embed' || /vidsrc\.to\/embed|\/embed\//i.test(stream.url || '');
  const isNative = !isMagnet && !isYoutube && !isEmbed;

  useEffect(() => {
    // The mpvRx-style player owns Escape for native playback; this covers the rest.
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && !isNative && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose, isNative]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(stream.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="player-backdrop">
      <section className="player-modal" role="dialog" aria-modal="true" aria-label={`Playing ${media.title}`}>
        <header className="player-header">
          <div><span>NOW PLAYING</span><h2>{media.title}</h2></div>
          <div className="player-source-label">{stream.sourceType === 'nuvio' ? 'NUVIO' : 'STREMIO'} · {stream.sourceName}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close player"><X size={21} /></button>
        </header>
        <div className="player-stage">
          {isYoutube ? (
            <iframe src={`https://www.youtube.com/embed/${stream.ytId}?autoplay=${autoplay ? 1 : 0}`} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : isEmbed ? (
            <iframe src={stream.url} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : isMagnet ? (
            <div className="player-message"><span><Magnet size={30} /></span><h2>This stream needs an external player</h2><p>Torrent and magnet playback is not built into the web player. Copy the link or open it with a compatible app on your device.</p><div><button className="button button-secondary" onClick={copyLink}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy magnet link'}</button><a className="button button-primary" href={stream.url}>Open external player <ExternalLink size={16} /></a></div></div>
          ) : (
            <MpvPlayer stream={stream} autoplay={autoplay} settings={playerSettings} onSettingsChange={onPlayerSettingsChange} onRequestClose={onClose} />
          )}
        </div>
        <footer className="player-footer">
          <div><strong>{stream.title}</strong><span>{stream.provider || stream.sourceName}{stream.quality ? ` · ${stream.quality}` : ''}</span></div>
          {isNative && <span className="player-engine">mpvRx-style player · press <kbd>?</kbd> for shortcuts</span>}
          {stream.headers && <span className="player-warning"><CircleAlert size={13} /> Custom headers may not be supported by browser playback.</span>}
          <button className="icon-button" onClick={copyLink} aria-label="Copy stream link">{copied ? <Check size={17} /> : <Link size={17} />}</button>
        </footer>
      </section>
    </div>
  );
};

export default PlayerModal;
