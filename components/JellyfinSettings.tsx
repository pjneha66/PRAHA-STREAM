import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Library } from 'lucide-react';
import { listJellyfinItems, normalizeJellyfinUrl, signInJellyfin, signOutJellyfin, type JellyfinSnapshot } from '../services/jellyfinService';

/** The password and session token are held in memory only; never included in backups or URLs. */
const JellyfinSettings: React.FC<{ snapshot: JellyfinSnapshot | null; onSnapshotChange: (snapshot: JellyfinSnapshot | null) => void }> = ({ snapshot, onSnapshotChange }) => {
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    let base: string;
    try { base = normalizeJellyfinUrl(server); } catch { setError('Enter a valid Jellyfin server URL, for example https://your-server.example.'); return; }
    if (!username.trim() || !password) { setError('Enter your Jellyfin username and password.'); return; }
    if (base.startsWith('http:') && !window.confirm('This connection is not encrypted. Your password and session token can be observed on the network. Continue only on a trusted network?')) return;
    const current = ++generation.current;
    setBusy(true); setError(''); onSnapshotChange(null);
    try {
      const auth = await signInJellyfin(base, username.trim(), password);
      let logoutFailed = false;
      let result: JellyfinSnapshot['items'];
      try { result = await listJellyfinItems(base, auth.token, auth.userId); }
      finally { await signOutJellyfin(base, auth.token).catch(() => { logoutFailed = true; }); }

      if (generation.current !== current) return;
      onSnapshotChange({ base, name: auth.name, items: result });
      setPassword('');
      if (logoutFailed) setError('Your library loaded, but the server did not confirm logout. You can revoke the PRAHA session in Jellyfin.');
    } catch (err) {
      if (generation.current === current) setError(err instanceof Error ? err.message : 'Could not connect to Jellyfin.');
    } finally { if (generation.current === current) setBusy(false); }
  };

  return <section className="settings-card">
    <div className="settings-card-heading"><span><Library size={19} /></span><div><h2>Jellyfin library</h2><p>Browse your own Jellyfin library and open titles in Jellyfin.</p></div></div>
    <p className="jellyfin-note">Login is temporary and only used to fetch this list. The first 50 titles appear on Home until you reload, switch profiles, or clear the session; credentials are not stored or included in backups. For playback, Jellyfin opens separately and may ask you to sign in again. On the web, your server must allow this app's origin via CORS.</p>
    <form className="jellyfin-form" onSubmit={connect}>
      <label>Server URL<input type="url" required placeholder="https://your-server.example" value={server} onChange={(event) => setServer(event.target.value)} /></label>
      <label>Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="button button-primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect and browse'}</button>
      {(snapshot || busy) && <button type="button" className="button button-secondary" onClick={() => { generation.current++; onSnapshotChange(null); setPassword(''); setBusy(false); setError(''); }}>Clear session</button>}
    </form>
    {error && <p role="alert" className="jellyfin-note">{error}</p>}
    {snapshot && <div className="jellyfin-results"><strong>{snapshot.name} · {snapshot.items.length} titles (first 50)</strong>
      {snapshot.items.length === 0 && <p>No movies or series found.</p>}
      {snapshot.items.map((item) => <div className="jellyfin-item" key={item.Id}><span>{item.Name} {item.ProductionYear ? `(${item.ProductionYear})` : ''} · {item.Type}</span><a className="text-button" href={`${snapshot.base}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`} target="_blank" rel="noopener noreferrer">Open in Jellyfin <ExternalLink size={13} /></a></div>)}
    </div>}
  </section>;
};

export default JellyfinSettings;
