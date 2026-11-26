import { createPortal } from 'react-dom';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, ChevronDown, CircleAlert, ExternalLink, Globe, LoaderCircle, Play,
  RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, X,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import { usePersistentState } from '../hooks/usePersistentState';
import { isAndroidApp, openProtectedEmbed, openSafeExternalUrl } from '../services/androidBridge';
import { EMBED_PRESETS, applyEmbedOverrides, buildEmbedUrl, validateEmbedTemplate, type EmbedProvider } from '../services/embedProviders';
import { tmdbService } from '../services/tmdbService';
import { DEFAULT_EMBED_UPDATE_URL, EMBED_UPDATE_INTERVAL, fetchEmbedUpdate, validateUpdateUrl, type TemplateOverrides } from '../services/embedUpdates';
import { filmQueryFromMedia, scrapeFilmSources } from '../services/sourceOrchestrator';
import { sourceKey } from '../services/sourcePreferences';

interface EmbedModalProps {
  media: MediaItem;
  initialSeason?: number;
  initialEpisode?: number;
  lastSource?: string;
  suspended?: boolean;
  onClose: () => void;
  /** Hands a VyseTV scraper result to the real player instead of an iframe. */
  onPlay?: (stream: StreamResult, season?: number, episode?: number, episodeTitle?: string, alternatives?: StreamResult[]) => void;
}

/** One source's results, so the list reads as "who found what" instead of a flat dump. */
interface SourceGroup {
  sourceName: string;
  torrent: boolean;
  streams: StreamResult[];
}

const hostOf = (template: string) => { try { return new URL(template).hostname; } catch { return 'Invalid URL'; } };

/**
 * Normalises a numeric input to a positive integer, falling back to the value
 * already held when the box is empty, negative, fractional or non-numeric.
 *
 * Keeping the previous value rather than writing 0 matters: `buildEmbedUrl`
 * rejects a non-positive season, so a transient 0 would turn the next Play press
 * into an error the user never caused.
 */
function clampPositiveInt(raw: string, current: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : current;
}

/**
 * Last-resort playback screen.
 *
 * This is the screen reached when the direct source list had nothing playable,
 * so its whole job is to answer "what else can I try?" fast. That means the
 * direct results come first (they are real streams, not iframes), and the embed
 * sites sit below them as a clearly-labelled fallback — never mixed in.
 */
const EmbedModal: React.FC<EmbedModalProps> = ({ media, initialSeason = 1, initialEpisode = 1, lastSource, suspended = false, onClose, onPlay }) => {
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
  const embedSites = useRef<HTMLElement>(null);
  const [openingProvider, setOpeningProvider] = useState('');
  const [query, setQuery] = useState('');

  // VyseTV's sources — Movy and Knaben included — are the preferred ones. Their
  // results are shown here too, so this screen only falls through to an embed
  // site when nothing direct was found.
  const [vyseStreams, setVyseStreams] = useState<StreamResult[]>([]);
  const [vyseLoading, setVyseLoading] = useState(false);
  const [vyseFailures, setVyseFailures] = useState(0);
  const [vyseKey, setVyseKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setVyseLoading(true);
    setVyseStreams([]);
    setVyseFailures(0);
    const filmQuery = filmQueryFromMedia(media, media.type === 'series' ? season : undefined, media.type === 'series' ? episode : undefined);
    const publish = (result: Awaited<ReturnType<typeof scrapeFilmSources>>) => {
      if (controller.signal.aborted) return;
      setVyseStreams(result.streams);
      setVyseFailures(result.failures.length);
    };
    scrapeFilmSources(filmQuery, { signal: controller.signal, onPartial: publish })
      .then(publish)
      .catch(() => { if (!controller.signal.aborted) setVyseFailures(1); })
      .finally(() => { if (!controller.signal.aborted) setVyseLoading(false); });
    return () => controller.abort();
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
    if (suspended) return;
    const handle = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (frame) setFrame(null); else onClose(); } };
    window.addEventListener('keydown', handle);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handle); document.body.classList.remove('modal-open'); };
  }, [frame, onClose, suspended]);

  const remote = updateConfig.enabled && updateCache.url === updateConfig.url ? updateCache.providers : {};
  const remotePresets = applyEmbedOverrides(EMBED_PRESETS, remote);
  const providers = [...applyEmbedOverrides(remotePresets, overrides), ...(Array.isArray(custom) ? custom.filter((p) => p && typeof p.name === 'string' && typeof p.id === 'string') : [])].filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const rankedStreams = useMemo(() => lastSource
    ? [...vyseStreams].sort((a, b) => Number(sourceKey(b) === lastSource) - Number(sourceKey(a) === lastSource))
    : vyseStreams, [vyseStreams, lastSource]);

  /** Groups follow the ranked stream order. */
  const groups = useMemo<SourceGroup[]>(() => {
    const out: SourceGroup[] = [];
    const index = new Map<string, number>();
    for (const stream of rankedStreams) {
      const sourceName = stream.provider || stream.sourceName;
      const torrent = Boolean(stream.infoHash);
      const key = JSON.stringify([sourceName, torrent]);
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, out.length);
        out.push({ sourceName, torrent, streams: [stream] });
      } else {
        out[at].streams.push(stream);
      }
    }
    return out;
  }, [rankedStreams]);

  const torrentCount = vyseStreams.filter((stream) => Boolean(stream.infoHash)).length;
  const directCount = vyseStreams.length - torrentCount;

  const start = async (provider: EmbedProvider, external: boolean) => {
    setError('');
    setPendingExternal(null);
    setOpeningProvider(provider.id);
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
    finally { setOpeningProvider(''); }
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

  const sourceGroups = (torrent: boolean) => (
    <div className="source-groups">
      {groups.filter((group) => group.torrent === torrent).map((group) => (
        <div className="source-group" key={group.sourceName}>
          <div className="source-group-head">
            <strong>{group.sourceName}</strong>
            <small>{group.streams.length} {group.streams.length === 1 ? 'stream' : 'streams'}</small>
          </div>
          <div className="source-group-list">
            {group.streams.slice(0, 12).map((stream, index) => (
              <div className="source-row" key={`${stream.id}-${index}`}>
                <div className="source-row-info">
                  <strong>{stream.title}</strong>
                  <small>
                    {[stream.quality, stream.language, stream.size, stream.seeders !== undefined ? `${stream.seeders} seeders` : undefined, torrent ? 'torrent' : stream.format].filter(Boolean).join(' · ') || 'Stream'}
                  </small>
                </div>
                <button type="button" className="button button-primary button-small" onClick={() => playStream(stream, rankedStreams.filter((candidate) => candidate !== stream && Boolean(candidate.infoHash) === torrent))}>
                  <Play size={14} /> Play
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return createPortal(<div className={`modal-backdrop source-backdrop embed-backdrop${suspended ? ' source-suspended' : ''}`} aria-hidden={suspended || undefined} inert={suspended || undefined} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="source-modal embed-modal" role="dialog" aria-modal="true" aria-label={`Sources and embedded players for ${media.title}`}>
      <header className="source-header embed-header">
        <div className="embed-header-copy">
          <span className="page-kicker">PLAYBACK SOURCES</span>
          <h2>{media.title}</h2>
          <div className="source-header-meta">
            {media.year && <span>{media.year}</span>}
            <span>{media.type === 'movie' ? 'Movie' : 'Series'}</span>
          </div>
        </div>
        {!frame && <button type="button" className="button button-secondary button-small embed-jump"
          onClick={() => embedSites.current?.scrollIntoView({ block: 'start' })}>Embed sites</button>}
        <button className="modal-close" onClick={onClose} aria-label="Close sources"><X size={20} /></button>
      </header>

      {frame ? <div className="embed-frame-wrap">
        <div className="embed-frame-toolbar">
          <strong>{frame.name}</strong>
          <button className="button button-secondary button-small" onClick={() => setFrame(null)}>Choose another</button>
          <button className="button button-secondary button-small" onClick={() => { void openSafeExternalUrl(frame.url).then((ok) => { if (!ok) setError('Could not open the browser.'); }); }}>Open in browser <ExternalLink size={14} /></button>
        </div>
        {/* `allow-same-origin` is required: without it the frame gets an opaque
            origin, and most embed hosts detect that and refuse to play. With
            both it and `allow-scripts` the frame could escape the sandbox, so
            the real isolation here is that the URL is a known embed host and
            the frame cannot navigate this page. `no-referrer` is dropped for
            the same reason — hosts that hotlink-check reject the request. */}
        <iframe
          src={frame.url}
          title={`${frame.name} player`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
        />
        <p className="embed-frame-note"><CircleAlert size={13} /> Some sites block embedding or need cookies. If it does not load, use “Open in browser”. PRAHA cannot verify iframe playback or save its progress.</p>
      </div> : <>
        {media.type === 'series' && <form className="embed-episode" onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setSeason(clampPositiveInt(String(fields.get('season')), season));
          setEpisode(clampPositiveInt(String(fields.get('episode')), episode));
        }} key={`${season}:${episode}`}>
          <label>Season <input name="season" type="number" min="1" required defaultValue={season} /></label>
          <label>Episode <input name="episode" type="number" min="1" required defaultValue={episode} /></label>
          <button type="submit" className="button button-secondary button-small">Apply</button>
        </form>}

        <div className="embed-body">
          {/* Direct results first: they play in the real player, so they beat any
              iframe. The count is in the heading so the answer to "is there
              anything here?" is readable without scrolling. */}
          <section className="embed-block" aria-label="Direct sources">
            <div className="embed-block-head">
              <div className="embed-block-title">
                <span className="embed-block-icon direct"><Sparkles size={16} /></span>
                <div>
                  <h3>Direct sources <span className={`embed-block-count ${directCount ? 'ok' : ''}`}>{directCount}</span></h3>
                  <p>Play in PRAHA’s video player.</p>
                </div>
              </div>
              {!vyseLoading && <button type="button" className="button button-secondary button-small" onClick={() => setVyseKey((key) => key + 1)} disabled={vyseLoading} aria-label="Search the sources again">
                <RefreshCw size={14} /> Retry
              </button>}
            </div>

            {vyseLoading && <p className="embed-status"><LoaderCircle size={15} className="spin" /> Checking sources…</p>}
            {!vyseLoading && directCount === 0 && <p className="embed-status">Nothing direct{vyseFailures ? ` · ${vyseFailures} sources failed` : ''}. Use an embed site below.</p>}

            {directCount > 0 && sourceGroups(false)}
          </section>

          <section className="embed-block embed-sites" aria-label="Embed sites" ref={embedSites}>
            <div className="embed-block-head">
              <div className="embed-block-title">
                <span className="embed-block-icon fallback"><Globe size={16} /></span>
                <div>
                  <h3>Embed sites <span className="embed-block-count">{providers.length}</span></h3>
                  <p>Open a provider website in the in-app player.</p>
                </div>
              </div>
              <label className="embed-filter">
                <input type="search" placeholder="Filter players" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter players" />
              </label>
            </div>
            {error && <p className="embed-error" role="alert"><CircleAlert size={14} />{error}</p>}
            {pendingExternal && <p className="embed-status"><ArrowRight size={13} /> ID resolved. <a href={pendingExternal.url} target="_blank" rel="noopener noreferrer">Open {pendingExternal.name} in browser</a>.</p>}
            <div className="embed-grid">
              {providers.map((provider) => {
                const isCustom = provider.id.startsWith('custom-');
                const edited = Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, provider.id));
                const fromFeed = Boolean(remote && Object.prototype.hasOwnProperty.call(remote, provider.id));
                const template = media.type === 'series' ? provider.series : provider.movie;
                return <article className={`embed-card${isCustom ? ' embed-card-custom' : ''}`} key={provider.id}>
                  <div className="embed-card-head">
                    <strong>{provider.name}</strong>
                    <small>{hostOf(template)}{isCustom ? ' · Custom' : edited ? ' · Edited' : fromFeed ? ' · Updated' : ''}</small>
                  </div>
                  <div className="embed-card-actions">
                    <button className="button button-primary button-small" disabled={Boolean(openingProvider)} onClick={() => void start(provider, false)}>{openingProvider === provider.id ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} Open player</button>
                    <button className="button button-secondary button-small" disabled={Boolean(openingProvider)} onClick={() => void start(provider, true)} aria-label={`Open ${provider.name} in browser`}>Browser <ExternalLink size={13} /></button>
                    <button className="icon-button" onClick={() => edit(provider)} aria-label={`Edit ${provider.name} templates`}><Settings2 size={16} /></button>
                    {isCustom && <button className="icon-button" aria-label={`Remove ${provider.name}`} onClick={() => setCustom((current) => current.filter((item) => item.id !== provider.id))}><Trash2 size={15} /></button>}
                  </div>
                </article>;
              })}
              {!providers.length && <p className="embed-status">No matching players.</p>}
            </div>
          </section>

          {torrentCount > 0 && <details className="embed-block embed-torrents">
            <summary>Torrent sources ({torrentCount})</summary>
            <p className="embed-status">Requires P2P streaming or a debrid service.</p>
            {sourceGroups(true)}
          </details>}

          {editing && <div className="embed-add embed-edit-open">
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

          {/* Configuration lives at the bottom, collapsed. It is set-once work
              and was previously three stacked forms sitting between the title
              and the players. */}
          <div className="embed-settings">
            <details className="embed-add"><summary><ChevronDown size={14} /> Automatic domain updates</summary>
              <p>The built-in PRAHA feed is checked when this screen opens, at most once a day. The app keeps the last successful update if the feed is unavailable, and manual edits take priority. The feed needs maintenance when domains change; it cannot discover new domains itself. You can change or disable it below. Only use feeds you trust: their operator can change player domains.</p>
              <form onSubmit={saveFeed}><label>Trusted feed URL<input type="url" value={feedDraft} onChange={(e) => setFeedDraft(e.target.value)} placeholder="https://your-server.example/providers.json" required /></label><div className="embed-provider-actions"><button className="button button-secondary button-small">{updateConfig.enabled ? 'Save feed' : 'Enable updates'}</button>{updateConfig.enabled && <><button type="button" className="button button-secondary button-small" onClick={() => setRefreshKey((value) => value + 1)}>Check now</button><button type="button" className="button button-secondary button-small" onClick={() => { setUpdateConfig({ enabled: false, url: '' }); setUpdateStatus('Automatic updates disabled.'); }}>Disable</button></>}</div></form>
              <p role="status">{updateStatus || (updateConfig.enabled && updateCache.url === updateConfig.url && updateCache.checkedAt ? `Last successful update: ${new Date(updateCache.checkedAt).toLocaleString()}` : updateConfig.enabled ? 'No successful update yet.' : 'Automatic updates are off.')}</p>
            </details>
            <details className="embed-add"><summary><ChevronDown size={14} /> Add your own player</summary><p>Use HTTPS templates with {'{id}'}, {'{tmdb}'} or {'{imdb}'}. TV also requires {'{season}'} and {'{episode}'}. Templates are stored on this device.</p><form onSubmit={add}><label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Provider name" /></label><label>Movie template<input required value={movie} onChange={(e) => setMovie(e.target.value)} placeholder="https://example.com/movie/{tmdb}" /></label><label>Series template<input required value={series} onChange={(e) => setSeries(e.target.value)} placeholder="https://example.com/tv/{tmdb}/{season}/{episode}" /></label><button className="button button-secondary button-small">Add player</button></form></details>
          </div>

          <p className="embed-warning"><ShieldCheck size={13} /> Embed sites may show ads or track visits. The protected Android player blocks known ad/tracker hosts and pop-ups, but is not uBlock Origin and cannot block every ad. Browser mode is unfiltered. On the web the sandbox blocks pop-ups but does not filter network ads. Availability, legality, and compatibility are not verified. Only use sites and content you are authorized to access. {isAndroidApp() ? 'Protected player runs separately from the app bridge. Some sites may not play.' : 'In-app embeds are restricted and may not work; you can open them in your browser instead.'}</p>

          <p className="embed-directory">More sites: <a href="https://rentry.co/onbksdgu" target="_blank" rel="noopener noreferrer">open the provider directory <ExternalLink size={12} /></a>. Not every site supports these templates.</p>
        </div>
      </>}
    </section>
  </div>, document.body);
};
export default EmbedModal;
