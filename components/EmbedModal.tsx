import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, LoaderCircle, Play, RefreshCw, Trash2, X } from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import { usePersistentState } from '../hooks/usePersistentState';
import { isAndroidApp, openProtectedEmbed, openSafeExternalUrl } from '../services/androidBridge';
import { EMBED_PRESETS, applyEmbedOverrides, buildEmbedUrl, validateEmbedTemplate, type EmbedProvider } from '../services/embedProviders';
import { tmdbService } from '../services/tmdbService';
import { DEFAULT_EMBED_UPDATE_URL, EMBED_UPDATE_INTERVAL, fetchEmbedUpdate, validateUpdateUrl, type TemplateOverrides } from '../services/embedUpdates';
import { filmQueryFromMedia, scrapeFilmSources } from '../services/sourceOrchestrator';
import { FILM_SOURCES } from '../services/filmSources';

interface EmbedModalProps {
  media: MediaItem;
  initialSeason?: number;
  initialEpisode?: number;
  onClose: () => void;
  /** Hands a VyseTV scraper result to the real player instead of an iframe. */
  onPlay?: (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string, alternatives?: StreamResult[]) => void;
}

/** One source's results, so the list reads as "who found what" instead of a flat dump. */
interface SourceGroup {
  sourceName: string;
  streams: StreamResult[];
}

const EmbedModal: React.FC<EmbedModalProps> = ({ media, initialSeason = 1, initialEpisode = 1, onClose, onPlay }) => {
  const [custom, setCustom] = usePersistentState<EmbedProvider[]>('praha.v2.embed-providers', []);
  const [overrides, setOverrides] = usePersistentState<Record<string, { movie: string; series: string }>>('praha.v2.embed-overrides', {});
  const [updateConfig, setUpdateConfig] = usePersistentState<{ enabled: boolean; url: string }>('praha.v2.embed-update-config', { enabled: true, url: DEFAULT_EMBED_UPDATE_URL });
  const [updateCache, setUpdateCache] = usePersistentState<{ url: string; checkedAt: number; providers: TemplateOverrides }>('praha.v2.embed-update-cache', { url: '', checkedAt: 0, providers: {} });
  const [feedDraft, setFeedDraft] = useState(updateConfig.url || '');
  const [refreshKey, setRefreshKey] = useState(0);
  const [updateStatus, setUpdateStatus] = useState('');

  const [editing, setEditing] = useState<EmbedProvider | null>(null);
  const [editMovie, setEditMovie] = useState('');
  const [editSeries, setEditSeries] = useState('');
  const [season, setSeason] = useState(initialSeason);
  const [episode, setEpisode] = useState(initialEpisode);
  const [resolved, setResolved] = useState(media);
  const [frame, setFrame] = useState<{ url: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [pendingExternal, setPendingExternal] = useState<{ url: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [movie, setMovie] = useState('');
  const [series, setSeries] = useState('');
  const [query, setQuery] = useState('');

  // VyseTV's sources — Movy and Knaben included — are the preferred ones. Their
  // results are shown here too, so this screen only falls through to an embed
  // site when nothing direct was found.
  const [vyseStreams, setVyseStreams] = useState<StreamResult[]>([]);
  const [vyseLoading, setVyseLoading] = useState(false);
  const [vyseFailures, setVyseFailures] = useState(0);
  const [vyseKey, setVyseKey] = useState(0);

  useEffect(() => {
    let active = true;
    setVyseLoading(true);
    setVyseStreams([]);
    setVyseFailures(0);
    const filmQuery = filmQueryFromMedia(media, media.type === 'series' ? season : undefined, media.type === 'series' ? episode : undefined);
    scrapeFilmSources(filmQuery)
      .then((result) => {
        if (!active) return;
        setVyseStreams(result.streams);
        setVyseFailures(result.failures.length);
      })
      .catch(() => { if (active) setVyseFailures(1); })
      .finally(() => { if (active) setVyseLoading(false); });
    return () => { active = false; };
  }, [media, season, episode, vyseKey]);

  useEffect(() => { setFeedDraft(updateConfig.url || ''); }, [updateConfig.url]);
  useEffect(() => {
    if (!updateConfig.enabled || !updateConfig.url) return;
    const cached = updateCache.url === updateConfig.url && updateCache.checkedAt > 0 && Date.now() - updateCache.checkedAt < EMBED_UPDATE_INTERVAL && updateCache.checkedAt <= Date.now();
    if (cached && refreshKey === 0) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    let active = true;
    setUpdateStatus('Checking update feed…');
    fetchEmbedUpdate(updateConfig.url, controller.signal).then((providers) => {
      if (!active) return;
      setUpdateCache({ url: updateConfig.url, checkedAt: Date.now(), providers });
      setUpdateStatus('Update feed checked. Playback is not verified.');
    }).catch((err) => {
      if (active) setUpdateStatus(`Update failed: ${err instanceof Error ? err.message : 'Network error'}. Keeping last successful update.`);
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
    // Cache is deliberately not a dependency: a successful update must not retrigger a request.
  }, [updateConfig.enabled, updateConfig.url, refreshKey, setUpdateCache]);

  const saveFeed = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const url = validateUpdateUrl(feedDraft);
      if (!window.confirm('This feed can change the websites opened for built-in players. Anyone controlling it could redirect you to an unsafe site. Only continue if you control and trust the feed. No title information is sent to the feed. Enable automatic updates?')) return;
      setUpdateConfig({ enabled: true, url });
      setRefreshKey(0);
      setUpdateStatus('');
    } catch (err) { setUpdateStatus(err instanceof Error ? err.message : 'Invalid feed URL.'); }
  };

  useEffect(() => {
    let active = true;
    if (!media.tmdbId && !media.imdbId && !media.id.startsWith('tmdb:') && !media.id.startsWith('tt')) {
      tmdbService.resolveIds(media).then((ids) => { if (active) setResolved({ ...media, tmdbId: ids.tmdbId ? Number(ids.tmdbId) : undefined, imdbId: ids.imdbId }); }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [media]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (frame) setFrame(null); else onClose(); } };
    window.addEventListener('keydown', handle);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handle); document.body.classList.remove('modal-open'); };
  }, [frame, onClose]);

  const remote = updateConfig.enabled && updateCache.url === updateConfig.url ? updateCache.providers : {};
  const remotePresets = applyEmbedOverrides(EMBED_PRESETS, remote);
  const providers = [...applyEmbedOverrides(remotePresets, overrides), ...(Array.isArray(custom) ? custom.filter((p) => p && typeof p.name === 'string' && typeof p.id === 'string') : [])].filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  /** Results grouped by source, keeping the order `scrapeFilmSources` returned. */
  const groups = useMemo<SourceGroup[]>(() => {
    const out: SourceGroup[] = [];
    const index = new Map<string, number>();
    for (const stream of vyseStreams) {
      const key = stream.provider || stream.sourceName;
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, out.length);
        out.push({ sourceName: key, streams: [stream] });
      } else {
        out[at].streams.push(stream);
      }
    }
    return out;
  }, [vyseStreams]);

  const torrentCount = vyseStreams.filter((stream) => Boolean(stream.infoHash)).length;

  const start = async (provider: EmbedProvider, external: boolean) => {
    setError('');
    setPendingExternal(null);
    let item = resolved;
    let resolvedAsync = false;
    const template = media.type === 'series' ? provider.series : provider.movie;
    if (template?.includes('{tmdb}') && !item.tmdbId && !item.id.startsWith('tmdb:') && (item.imdbId || item.id.startsWith('tt'))) {
      try {
        resolvedAsync = true;
        const ids = await tmdbService.resolveIds(item);
        item = { ...item, tmdbId: ids.tmdbId ? Number(ids.tmdbId) : undefined, imdbId: ids.imdbId || item.imdbId };
        setResolved(item);
      } catch { /* URL builder gives a useful error. */ }
    }
    try {
      const url = buildEmbedUrl(provider, item, season, episode);
      if (external) {
        // A browser popup after an asynchronous ID lookup may be blocked;
        // ask for a fresh click instead of silently losing the request.
        if (resolvedAsync && !isAndroidApp()) { setPendingExternal({ url, name: provider.name }); return; }
        if (!(await openSafeExternalUrl(url))) setError('Could not open your browser. Check that a browser is installed.');
      } else if (isAndroidApp()) {
        if (!(await openProtectedEmbed(url))) setError('Could not open the protected player. Update the Android app or use Browser.');
      } else setFrame({ url, name: provider.name });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not build the player URL.'); }
  };
  const edit = (provider: EmbedProvider) => {
    setEditing(provider); setEditMovie(provider.movie); setEditSeries(provider.series); setError('');
  };
  const saveEdit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    try {
      const nextMovie = editMovie.trim(); const nextSeries = editSeries.trim();
      validateEmbedTemplate(nextMovie, 'movie'); validateEmbedTemplate(nextSeries, 'series');
      if (editing.id.startsWith('custom-')) {
        setCustom((current) => current.map((item) => item.id === editing.id ? { ...item, movie: nextMovie, series: nextSeries } : item));
      } else {
        setOverrides((current) => ({ ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}), [editing.id]: { movie: nextMovie, series: nextSeries } }));
      }
      setEditing(null); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Invalid provider template.'); }
  };
  const resetPreset = (id: string) => {
    setOverrides((current) => {
      const next = { ...current }; delete next[id]; return next;
    });
    setEditing(null); setError('');
  };
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      if (!name.trim() || name.trim().length > 80) throw new Error('Enter a provider name (up to 80 characters).');
      validateEmbedTemplate(movie.trim(), 'movie'); validateEmbedTemplate(series.trim(), 'series');
      setCustom((current) => [...(Array.isArray(current) ? current : []), { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: name.trim(), movie: movie.trim(), series: series.trim() }]);
      setName(''); setMovie(''); setSeries(''); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Invalid provider.'); }
  };

  const playStream = (stream: StreamResult, alternatives: StreamResult[]) => {
    if (!onPlay) { setError('Playback is not available from this screen. Close it and use the source list instead.'); return; }
    onPlay(stream, media.type === 'series' ? season : undefined, media.type === 'series' ? episode : undefined, undefined, alternatives);
  };

  return <div className="modal-backdrop source-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="source-modal embed-modal" role="dialog" aria-modal="true" aria-label={`Sources and embedded players for ${media.title}`}>
      <header className="source-header">
        <div>
          <span className="page-kicker">SOURCES · {FILM_SOURCES.length} BUILT IN</span>
          <h2>{media.title}</h2>
          <p>VyseTV's built-in sources, found streams, and embed sites — in that order.</p>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close sources"><X size={20} /></button>
      </header>

      {frame ? <div className="embed-frame-wrap">
        <div className="embed-frame-toolbar">
          <strong>{frame.name}</strong>
          <button className="button button-secondary button-small" onClick={() => setFrame(null)}>Choose another</button>
          <button className="button button-secondary button-small" onClick={() => { void openSafeExternalUrl(frame.url).then((ok) => { if (!ok) setError('Could not open the browser.'); }); }}>Open in browser <ExternalLink size={14} /></button>
        </div>
        <iframe src={frame.url} title={`${frame.name} player`} sandbox="allow-scripts allow-forms allow-presentation" referrerPolicy="no-referrer" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
        <p>Some sites block embedding or need cookies. If it does not load, use “Open in browser”. PRAHA cannot verify iframe playback or save its progress.</p>
      </div> : <>
        {media.type === 'series' && <div className="embed-episode">
          <label>Season <input type="number" min="1" value={season} onChange={(e) => setSeason(Number(e.target.value))} /></label>
          <label>Episode <input type="number" min="1" value={episode} onChange={(e) => setEpisode(Number(e.target.value))} /></label>
        </div>}

        <section className="source-stage" aria-label="VyseTV built-in sources">
          <div className="source-stage-head">
            <div>
              <span className="page-kicker">PREFERRED</span>
              <h3>Built-in sources</h3>
              <p>Movy and Knaben first, then {FILM_SOURCES.length - 2} ported scrapers. Direct streams play in the app; torrents need P2P streaming or a debrid service.</p>
            </div>
            <button type="button" className="button button-secondary button-small" onClick={() => setVyseKey((key) => key + 1)} disabled={vyseLoading} aria-label="Search the sources again">
              <RefreshCw size={14} className={vyseLoading ? 'spin' : undefined} /> Retry
            </button>
          </div>

          {vyseLoading && <p className="source-stage-status"><LoaderCircle size={15} className="spin" /> Searching {FILM_SOURCES.length} sources…</p>}
          {!vyseLoading && !vyseStreams.length && <p className="source-stage-status">Nothing found{vyseFailures ? ` · ${vyseFailures} sources failed` : ''}. Try an embed site below.</p>}

          {Boolean(vyseStreams.length) && <div className="source-groups">
            {groups.map((group) => <div className="source-group" key={group.sourceName}>
              <div className="source-group-head">
                <strong>{group.sourceName}</strong>
                <small>{group.streams.length} {group.streams.length === 1 ? 'stream' : 'streams'}</small>
              </div>
              <div className="source-group-list">
                {group.streams.slice(0, 12).map((stream, index) => {
                  const torrent = Boolean(stream.infoHash);
                  return <div className="source-row" key={`${stream.id}-${index}`}>
                    <div className="source-row-info">
                      <strong>{stream.title}</strong>
                      <small>
                        {[stream.quality, stream.language, stream.size, stream.seeders !== undefined ? `${stream.seeders} seeders` : undefined, torrent ? 'torrent' : stream.format].filter(Boolean).join(' · ') || 'Stream'}
                      </small>
                    </div>
                    <button type="button" className="button button-primary button-small" onClick={() => playStream(stream, vyseStreams.slice(vyseStreams.indexOf(stream) + 1))}>
                      <Play size={14} /> Play
                    </button>
                  </div>;
                })}
              </div>
            </div>)}
          </div>}
          {torrentCount > 0 && <p className="source-stage-note">{torrentCount} torrent {torrentCount === 1 ? 'result needs' : 'results need'} P2P streaming or a debrid service to play.</p>}
        </section>

        <section className="source-stage" aria-label="Embed sites">
          <div className="source-stage-head">
            <div>
              <span className="page-kicker">FALLBACK</span>
              <h3>Embed sites</h3>
              <p>Third-party websites, not verified streams. 4KHDHub is no longer included; your own players are kept at the end of the list.</p>
            </div>
          </div>
          <div className="embed-search"><label>Filter players <input type="search" placeholder="Provider name" value={query} onChange={(e) => setQuery(e.target.value)} /></label></div>
          {error && <p className="embed-error" role="alert">{error}</p>}
          {pendingExternal && <p className="embed-warning" role="status">ID resolved. <a href={pendingExternal.url} target="_blank" rel="noopener noreferrer">Open {pendingExternal.name} in browser</a>.</p>}
          <div className="embed-grid">
            {providers.map((provider) => {
              const custom = provider.id.startsWith('custom-');
              const edited = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, provider.id));
              const fromFeed = Boolean(remote && Object.prototype.hasOwnProperty.call(remote, provider.id));
              let host = 'Invalid URL';
              try { host = new URL(provider.movie).hostname; } catch { /* keep the label */ }
              return <article className={`embed-card${custom ? ' embed-card-custom' : ''}`} key={provider.id}>
                <div className="embed-card-head">
                  <strong>{provider.name}</strong>
                  <small>{custom ? 'Your player' : edited ? 'Edited locally' : fromFeed ? 'Feed updated' : host}</small>
                </div>
                <div className="embed-card-actions">
                  <button className="button button-primary button-small" onClick={() => void start(provider, false)}><Play size={14} /> {isAndroidApp() ? 'Protected player' : 'Open here'}</button>
                  <button className="button button-secondary button-small" onClick={() => void start(provider, true)}>Browser <ExternalLink size={13} /></button>
                  <button className="button button-secondary button-small" onClick={() => edit(provider)} aria-label={`Edit ${provider.name} templates`}>Edit</button>
                  {custom && <button className="icon-button" aria-label={`Remove ${provider.name}`} onClick={() => setCustom((current) => current.filter((item) => item.id !== provider.id))}><Trash2 size={15} /></button>}
                </div>
              </article>;
            })}
            {!providers.length && <p className="source-stage-status">No matching players.</p>}
          </div>
        </section>

        <p className="embed-warning">Embed sites may show ads or track visits. The protected Android player blocks known ad/tracker hosts and pop-ups, but is not uBlock Origin and cannot block every ad. Browser mode is unfiltered. On the web the sandbox blocks pop-ups but does not filter network ads. Availability, legality, and compatibility are not verified. Only use sites and content you are authorized to access. {isAndroidApp() ? 'Protected player runs separately from the app bridge. Some sites may not play.' : 'In-app embeds are restricted and may not work; you can open them in your browser instead.'}</p>

        {editing && <div className="embed-add">
          <strong>Update {editing.name}</strong>
          <p>Only use an address you trust. Local edits take priority over the optional update feed.</p>
          <form onSubmit={saveEdit}>
            <label>Movie template<input required value={editMovie} onChange={(e) => setEditMovie(e.target.value)} /></label>
            <label>Series template<input required value={editSeries} onChange={(e) => setEditSeries(e.target.value)} /></label>
            <div className="embed-provider-actions">
              <button className="button button-primary button-small">Save changes</button>
              <button type="button" className="button button-secondary button-small" onClick={() => setEditing(null)}>Cancel</button>
              {!editing.id.startsWith('custom-') && <button type="button" className="button button-secondary button-small" onClick={() => resetPreset(editing.id)}>Use feed/default</button>}
            </div>
          </form>
        </div>}

        <details className="embed-add"><summary>Automatic domain updates</summary>
          <p>The built-in PRAHA feed is checked when this screen opens, at most once a day. The app keeps the last successful update if the feed is unavailable, and manual edits take priority. The feed needs maintenance when domains change; it cannot discover new domains itself. You can change or disable it below. Only use feeds you trust: their operator can change player domains.</p>
          <form onSubmit={saveFeed}><label>Trusted feed URL<input type="url" value={feedDraft} onChange={(e) => setFeedDraft(e.target.value)} placeholder="https://your-server.example/providers.json" required /></label><div className="embed-provider-actions"><button className="button button-secondary button-small">{updateConfig.enabled ? 'Save feed' : 'Enable updates'}</button>{updateConfig.enabled && <><button type="button" className="button button-secondary button-small" onClick={() => setRefreshKey((value) => value + 1)}>Check now</button><button type="button" className="button button-secondary button-small" onClick={() => { setUpdateConfig({ enabled: false, url: '' }); setUpdateStatus('Automatic updates disabled.'); }}>Disable</button></>}</div></form>
          <p role="status">{updateStatus || (updateConfig.enabled && updateCache.url === updateConfig.url && updateCache.checkedAt ? `Last successful update: ${new Date(updateCache.checkedAt).toLocaleString()}` : updateConfig.enabled ? 'No successful update yet.' : 'Automatic updates are off.')}</p>
        </details>

        <details className="embed-add"><summary>Add your own player</summary><p>Use HTTPS templates with {'{id}'}, {'{tmdb}'} or {'{imdb}'}. TV also requires {'{season}'} and {'{episode}'}. Templates are stored on this device.</p><form onSubmit={add}><label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Provider name" /></label><label>Movie template<input required value={movie} onChange={(e) => setMovie(e.target.value)} placeholder="https://example.com/movie/{tmdb}" /></label><label>Series template<input required value={series} onChange={(e) => setSeries(e.target.value)} placeholder="https://example.com/tv/{tmdb}/{season}/{episode}" /></label><button className="button button-secondary button-small">Add player</button></form></details>

        <p className="embed-directory">More sites: <a href="https://rentry.co/onbksdgu" target="_blank" rel="noopener noreferrer">open the provider directory <ExternalLink size={12} /></a>. Not every site supports these templates.</p>
      </>}
    </section>
  </div>;
};
export default EmbedModal;
