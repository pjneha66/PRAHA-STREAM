import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Check, CircleAlert, Copy, ExternalLink, Link, Magnet, X } from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';

const PlayerModal: React.FC<{
  media: MediaItem;
  stream: StreamResult;
  autoplay: boolean;
  onClose: () => void;
}> = ({ media, stream, autoplay, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const isMagnet = stream.url.startsWith('magnet:') || (!stream.url && Boolean(stream.infoHash));
  const isYoutube = Boolean(stream.ytId);
  const isEmbed = stream.format === 'embed' || /vidsrc\.to\/embed|\/embed\//i.test(stream.url || '');

  useEffect(() => {
    const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream.url || isMagnet) return;
    setError('');
    let hls: Hls | null = null;
    if (stream.url.includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) setError('This HLS source could not be loaded. It may require custom headers or block browser playback.'); });
      hls.loadSource(stream.url);
      hls.attachMedia(video);
    } else {
      video.src = stream.url;
    }
    if (autoplay) video.play().catch(() => undefined);
    return () => { hls?.destroy(); video.pause(); video.removeAttribute('src'); video.load(); };
  }, [stream.url, autoplay, isMagnet]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(stream.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="player-backdrop">
      <section className="player-modal" role="dialog" aria-modal="true" aria-label={`Playing ${media.title}`}>
        <header className="player-header"><div><span>NOW PLAYING</span><h2>{media.title}</h2></div><div className="player-source-label">{stream.sourceType === 'nuvio' ? 'NUVIO' : stream.sourceType === 'cloudstream' ? 'CLOUDSTREAM' : 'STREMIO'} · {stream.sourceName}</div><button className="modal-close" onClick={onClose} aria-label="Close player"><X size={21} /></button></header>
        <div className="player-stage">
          {isYoutube ? <iframe src={`https://www.youtube.com/embed/${stream.ytId}?autoplay=${autoplay ? 1 : 0}`} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /> : isEmbed ? (
            <iframe src={stream.url} title={media.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          ) : isMagnet ? (
            <div className="player-message"><span><Magnet size={30} /></span><h2>This stream needs an external player</h2><p>Torrent and magnet playback is not built into the web player. Copy the link or open it with a compatible app on your device.</p><div><button className="button button-secondary" onClick={copyLink}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy magnet link'}</button><a className="button button-primary" href={stream.url}>Open external player <ExternalLink size={16} /></a></div></div>
          ) : (
            <>
              <video ref={videoRef} controls playsInline onError={() => setError('This source could not be played in the browser. Try another stream or open it externally.')}>
                {stream.subtitles?.map((subtitle, index) => <track key={subtitle.url} kind="subtitles" src={subtitle.url} label={subtitle.name || subtitle.language} srcLang={subtitle.language.slice(0, 2).toLowerCase()} default={index === 0} />)}
              </video>
              {error && <div className="player-error"><CircleAlert size={25} /><h3>Playback unavailable</h3><p>{error}</p><div><button className="button button-secondary" onClick={copyLink}><Link size={16} /> Copy stream link</button><a className="button button-primary" href={stream.externalUrl || stream.url} target="_blank" rel="noreferrer">Open externally <ExternalLink size={16} /></a></div></div>}
            </>
          )}
        </div>
        <footer className="player-footer"><div><strong>{stream.title}</strong><span>{stream.provider || stream.sourceName}{stream.quality ? ` · ${stream.quality}` : ''}</span></div>{stream.headers && <span className="player-warning"><CircleAlert size={13} /> Custom headers may not be supported by browser playback.</span>}<button className="icon-button" onClick={copyLink} aria-label="Copy stream link">{copied ? <Check size={17} /> : <Copy size={17} />}</button></footer>
      </section>
    </div>
  );
};

export default PlayerModal;
