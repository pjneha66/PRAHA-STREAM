import { useState } from 'react';
import TelegramAccount from './TelegramAccount';
import { bridgeRpcAvailable } from '../services/androidBridge';
import type { MediaItem, StreamResult } from '../types';
import { loadTelegramVideos, telegramLink, type TelegramLink, type TelegramVideo } from '../services/telegramStreams';

const CHANNELS_KEY = 'praha.telegram.channels.v1';

function getSavedChannels(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHANNELS_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export default function TelegramView({ onPlay, profileId }: { profileId: string; onPlay: (media: MediaItem, stream: StreamResult) => void }) {
  const [input, setInput] = useState('');
  const [showAccount, setShowAccount] = useState(false);
  const [saved, setSaved] = useState(getSavedChannels);
  const [link, setLink] = useState<TelegramLink>();
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState<TelegramVideo[]>([]);
  const [before, setBefore] = useState(0);
  const [withheld, setWithheld] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(target?: TelegramLink, options: { before?: number; query?: string } = {}) {
    if (busy) return;
    if (!target) {
      setError('Enter a public Telegram channel or post link.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const page = await loadTelegramVideos(target, options.before, options.query);
      setTitle(page.title);
      setLink(target);
      setQuery(options.query || '');
      setBefore(page.before >= (options.before ?? Infinity) ? 0 : page.before);
      setWithheld((current) => options.before ? current + page.withheld : page.withheld);
      setVideos((current) => options.before
        ? [...current, ...page.videos.filter((next) => !current.some((item) => item.id === next.id))]
        : page.videos);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this channel.');
    } finally {
      setBusy(false);
    }
  }

  const currentSaved = saved.find((name) => name.toLowerCase() === link?.channel.toLowerCase());
  function toggleSaved() {
    if (!link) return;
    const next = currentSaved ? saved.filter((name) => name !== currentSaved) : [...saved, link.channel];
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
    setSaved(next);
  }

  return <section className="standard-page">
    <h1>Telegram</h1>
    {bridgeRpcAvailable() && <div className="directory-actions">
      <button type="button" className="button button-secondary" aria-pressed={!showAccount} onClick={() => setShowAccount(false)}>Public channels</button>
      <button type="button" className="button button-secondary" aria-pressed={showAccount} onClick={() => setShowAccount(true)}>My Telegram</button>
    </div>}
    {showAccount ? <TelegramAccount key={profileId} profileId={profileId} /> : <>
    <form className="install-form" onSubmit={(event) => {
      event.preventDefault();
      setSearch('');
      void load(telegramLink(input));
    }}>
      <div><input aria-label="Telegram channel" placeholder="@channel or Telegram post link" value={input} onChange={(event) => setInput(event.target.value)} /></div>
      <button className="button button-primary" disabled={busy}>{busy ? 'Loading…' : 'Browse videos'}</button>
    </form>
    {saved.length > 0 && <div className="directory-actions" aria-label="Saved Telegram channels">
      {saved.map((channel) => <button type="button" className="button button-secondary" key={channel} disabled={busy}
        onClick={() => { setSearch(''); setInput(`@${channel}`); void load({ channel }); }}>@{channel}</button>)}
    </div>}
    {error && <p role="alert">{error}</p>}
    {link && <>
      <h2>{title}</h2>
      <div className="directory-actions">
        <button type="button" className="button button-secondary" onClick={toggleSaved}>{currentSaved ? 'Unsave channel' : 'Save channel'}</button>
        {link.post && <button type="button" className="button button-secondary" disabled={busy}
          onClick={() => void load({ channel: link.channel })}>Browse channel</button>}
      </div>
      {!link.post && <form className="install-form" onSubmit={(event) => {
        event.preventDefault();
        void load(link, { query: search.trim() });
      }}>
        <div><input aria-label="Search Telegram channel" placeholder="Search this channel" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <button className="button button-secondary" disabled={busy}>Search</button>
      </form>}
      {withheld > 0 && <p>{withheld} {withheld === 1 ? 'video is' : 'videos are'} unavailable in Telegram’s public preview.</p>}
      {!videos.length && <p>No playable videos were available in this public preview.</p>}
      <div className="directory-grid">
        {videos.map((entry) => {
          const id = `telegram:${link.channel}:${entry.id}`;
          const title = entry.title.slice(0, 180);
          return <article className="directory-card" key={id}>
            {entry.poster && <img src={entry.poster} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: '100%', maxHeight: '12rem', objectFit: 'cover' }} />}
            <h3>{title}</h3>
            {entry.duration && <p>{entry.duration}</p>}
            <button className="button button-primary" onClick={() => onPlay(
              { id, title, overview: '', poster: entry.poster ?? '', genres: [], source: 'telegram', type: 'movie' },
              { id, title, url: entry.url, sourceName: 'Telegram', sourceType: 'telegram', headers: { Referer: 'https://t.me/' } },
            )}>Play video</button>
          </article>;
        })}
      </div>
      {before > 0 && <button className="button button-secondary" disabled={busy} onClick={() => void load(link, { before, query })}>Older posts</button>}
    </>}
    </>}
  </section>;
}
