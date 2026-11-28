import { useEffect, useState } from 'react';
import { prahaRpc } from '../services/androidBridge';

interface AccountState {
  state: string;
  busy?: boolean;
  error?: string;
  chats?: { id: string; title: string; kind: string }[];
}

interface AccountVideo {
  chat: string;
  message: string;
  title: string;
  duration: number;
  poster?: string;
}

export default function TelegramAccount({ profileId }: { profileId: string }) {
  const [account, setAccount] = useState<AccountState>({ state: 'starting' });
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [input, setInput] = useState('');
  const [chat, setChat] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [videos, setVideos] = useState<AccountVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number;
    const refresh = async () => {
      try {
        const state = await prahaRpc<AccountState>('telegramAccountStatus', [profileId]);
        if (active) setAccount(state);
      } catch {
        if (active) setAccount({ state: 'unsupported' });
      } finally {
        if (active) timer = window.setTimeout(refresh, 1300);
      }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [profileId]);

  async function action(method: string, args: string[]) {
    setError('');
    setLoading(true);
    try {
      const next = await prahaRpc<AccountState>(method, [profileId, ...args]);
      setAccount(next);
      setInput('');
      setApiHash('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Telegram could not complete this request.');
    } finally {
      setLoading(false);
    }
  }

  async function browse(target: string, term = '', before = '') {
    if (loading || !target) return;
    setError('');
    setLoading(true);
    try {
      const page = await prahaRpc<{ videos: AccountVideo[]; before: string }>('telegramAccountVideos',
        [profileId, target.trim(), before, term], 30000);
      setChat(target.trim());
      setQuery(term);
      setCursor(page.before !== '0' && page.before !== before ? page.before : '');
      setVideos((old) => before ? [...old, ...page.videos.filter((next) => !old.some((item) => item.message === next.message))] : page.videos);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load videos for this chat.');
    } finally {
      setLoading(false);
    }
  }

  const state = account.state;
  const authField = { phone: 'Phone number with country code', code: 'Telegram login code', password: 'Two-step verification password' }[state];
  return <section className="install-panel">
    <h2>Telegram account</h2>
    {(error || account.error) && <p role="alert">{error || account.error}</p>}
    {state === 'unsupported' && <p>Telegram account streaming is available on ARM Android devices.</p>}
    {state === 'otherProfile' && <p>This device’s Telegram session belongs to another PRAHA profile.</p>}
    {state === 'starting' && <p role="status">Connecting to Telegram…</p>}
    {state === 'idle' && <form className="directory-actions" onSubmit={(event) => {
      event.preventDefault();
      void action('telegramAccountCredentials', [apiId.trim(), apiHash.trim()]);
    }}>
      <p>Enter your Telegram API credentials from <a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a>.</p>
      <label>API ID <input required inputMode="numeric" value={apiId} onChange={(event) => setApiId(event.target.value)} /></label>
      <label>API hash <input required type="password" autoComplete="off" value={apiHash} onChange={(event) => setApiHash(event.target.value)} /></label>
      <button className="button button-primary" disabled={loading}>Connect</button>
    </form>}
    {authField && <form className="directory-actions" onSubmit={(event) => {
      event.preventDefault();
      void action('telegramAccountAuth', [state, input.trim()]);
    }}>
      <label>{authField} <input required type={state === 'password' ? 'password' : state === 'phone' ? 'tel' : 'text'}
        autoComplete={state === 'code' ? 'one-time-code' : 'off'} value={input} onChange={(event) => setInput(event.target.value)} /></label>
      <button className="button button-primary" disabled={loading || account.busy}>Continue</button>
    </form>}
    {(state === 'closed' || state === 'unsupportedLogin') && <button type="button" className="button button-secondary"
      onClick={() => void action('telegramAccountAuth', ['restart'])}>Start phone sign-in again</button>}
    {state === 'ready' && <>
      <div className="directory-actions">
        <button type="button" className="button button-secondary" disabled={loading} onClick={() => void action('telegramAccountAuth', ['refresh'])}>Refresh chats</button>
        <button type="button" className="button button-secondary" disabled={loading} onClick={() => {
          if (window.confirm('Sign out of Telegram on this device?')) {
            setChat(''); setVideos([]); setCursor('');
            void action('telegramAccountAuth', ['signOut']);
          }
        }}>Sign out</button>
      </div>
      <form className="install-form" onSubmit={(event) => {
        event.preventDefault();
        const target = new FormData(event.currentTarget).get('username')?.toString().trim();
        if (target && /^@?[a-z\d_]{3,64}$/i.test(target)) void browse(target);
      }}>
        <div><input name="username" aria-label="Telegram public username" placeholder="@channel" required /></div>
        <button className="button button-primary" disabled={loading}>Open channel</button>
      </form>
      <div className="directory-actions" aria-label="Telegram chats">
        {account.chats?.map(({ id, title, kind }) => <button key={id} type="button" className="button button-secondary"
          disabled={loading} aria-pressed={chat === id} onClick={() => void browse(id)}>{title || kind}</button>)}
      </div>
      {chat && <form className="install-form" onSubmit={(event) => { event.preventDefault(); void browse(chat, search.trim()); }}>
        <div><input aria-label="Search chat videos" placeholder="Search captions and filenames" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <button className="button button-secondary" disabled={loading}>Search</button>
      </form>}
      {chat && !videos.length && !loading && <p>No videos on this page.</p>}
      <div className="directory-grid">
        {videos.map((video) => <article className="directory-card" key={video.message}>
          {video.poster?.startsWith('data:image/') && <img src={video.poster} alt="" loading="lazy" />}
          <h3>{video.title}</h3>
          {!!video.duration && <p>{Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, '0')}</p>}
          <button type="button" className="button button-primary" onClick={() => {
            setError('');
            void prahaRpc('telegramAccountPlay', [profileId, video.chat, video.message], 20000)
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not open this video.'));
          }}>Play video</button>
        </article>)}
      </div>
      {cursor && <button type="button" className="button button-secondary" disabled={loading} onClick={() => void browse(chat, query, cursor)}>Older videos</button>}
    </>}
  </section>;
}
