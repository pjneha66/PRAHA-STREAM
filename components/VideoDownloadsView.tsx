import { useEffect, useState } from 'react';
import { bridgeRpcAvailable } from '../services/androidBridge';
import {
  allVideoDownloads, canDownloadVideo, DOWNLOADS_CHANGED, getVideoDownloadStatus, planVideoDownload,
  queueVideoDownloads, useVideoDownload, videoDownloads, type VideoDownloadStatus,
} from '../services/videoDownloads';
import type { StreamResult } from '../types';

export default function VideoDownloadsView() {
  const [items, setItems] = useState(videoDownloads);
  const [status, setStatus] = useState<Record<string, VideoDownloadStatus>>({});
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [queueing, setQueueing] = useState(false);
  const [exportCopy, setExportCopy] = useState(false);

  useEffect(() => {
    if (!bridgeRpcAvailable()) return;
    let active = true;
    let timer: number;
    let updating = false;
    const update = async () => {
      if (updating) return;
      updating = true;
      try {
        const downloads = await allVideoDownloads();
        const values = await Promise.all(downloads.map(async ({ id }) => [
          id, await getVideoDownloadStatus(id).catch(() => ({ state: 'missing' as const, bytes: 0, total: 0 })),
        ] as const));
        if (active) {
          setItems(downloads);
          setStatus(Object.fromEntries(values));
        }
      } finally {
        updating = false;
        if (active) {
          window.clearTimeout(timer);
          timer = window.setTimeout(update, 1000);
        }
      }
    };
    void update();
    window.addEventListener(DOWNLOADS_CHANGED, update);
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener(DOWNLOADS_CHANGED, update); };
  }, []);

  const act = async (id: string, action: 'play' | 'share' | 'remove' | 'pause' | 'resume' | 'export') => {
    setMessage('');
    if (!await useVideoDownload(id, action).catch(() => false)) {
      setMessage('Android could not open this download.');
    }
  };

  const addLink = async () => {
    const stream: StreamResult = { id: url, title: 'Video', sourceName: 'Direct link', sourceType: 'scraper', url: url.trim() };
    if (!canDownloadVideo(stream)) {
      setMessage('Enter a direct video or HLS playlist link.');
      return;
    }
    setMessage('');
    setQueueing(true);
    try {
      const filename = new URL(stream.url).pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Video';
      const plan = planVideoDownload({ id: stream.id, title: filename, type: 'movie', overview: '', poster: '', genres: [], source: 'stremio' }, stream);
      const remaining = await queueVideoDownloads([{ ...plan, export: exportCopy }]);
      if (remaining.length) setMessage('Android could not queue this link.');
      else setUrl('');
    } catch {
      setMessage('Could not save this download.');
    } finally {
      setQueueing(false);
    }
  };

  return <section className="standard-page">
    <h1>Video Downloads</h1>
    <p>Queue video files and HLS streams. Watch offline in PRAHA or save a copy to Downloads.</p>
    {bridgeRpcAvailable() ? <form className="install-form" onSubmit={(event) => { event.preventDefault(); void addLink(); }}>
      <div><input type="url" aria-label="Video or HLS link" placeholder="https://…/video.m3u8" value={url}
        required onChange={(event) => setUrl(event.target.value)} /></div>
      <label><input type="checkbox" checked={exportCopy} onChange={(event) => setExportCopy(event.target.checked)} /> Save to Downloads</label>
      <button className="button button-primary" disabled={queueing}>Queue video</button>
    </form> : <p>Video downloads are available in the Android app.</p>}
    {!items.length && <p>No video downloads yet.</p>}
    {message && <p role="alert">{message}</p>}
    <div className="extension-list">
      {items.map(({ id, title }) => {
        const progress = status[id];
        const total = progress?.duration || progress?.total || 0;
        const done = progress?.duration ? progress.downloadedDuration : progress?.bytes;
        return <article className="extension-card" key={id}>
          <h3>{title}</h3>
          <p>{progress?.state ?? 'Checking…'}</p>
          {progress?.state === 'downloading' && <progress aria-label="Download progress" value={total > 0 ? done : undefined} max={total > 0 ? total : undefined} />}
          {progress?.error && <p>{progress.error}</p>}
          <div className="directory-actions">
            {id.startsWith('hikari-') && (progress?.state === 'queued' || progress?.state === 'downloading') &&
              <button className="button button-secondary" onClick={() => void act(id, 'pause')}>Pause</button>}
            {id.startsWith('hikari-') && (progress?.state === 'paused' || progress?.state === 'failed') &&
              <button className="button button-primary" onClick={() => void act(id, 'resume')}>{progress.state === 'paused' ? 'Resume' : 'Retry'}</button>}
            {progress?.state === 'complete' && <>
              <button className="button button-primary" onClick={() => void act(id, 'play')}>Play offline</button>
              {progress.shareable !== false && <button className="button button-secondary" onClick={() => void act(id, 'share')}>Share video</button>}
              {progress.canExport && <button className="button button-secondary" onClick={() => void act(id, 'export')}>Download an export copy</button>}
            </>}
            <button className="button button-secondary" disabled={progress?.state === 'converting'} onClick={() => {
              if (window.confirm(`Remove ${title} and its downloaded file?`)) void act(id, 'remove');
            }}>Remove</button>
          </div>
        </article>;
      })}
    </div>
  </section>;
}
