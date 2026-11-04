import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell, BellRing, Check, ChevronRight, CircleAlert, Clock, ExternalLink, Film, ListMusic,
  LoaderCircle, Music, Play, Plus, Radio, RefreshCw, Search, Share2, Trash2, Video, X,
} from 'lucide-react';
import { usePersistentState } from '../hooks/usePersistentState';
import { isAndroidApp, openSafeExternalUrl } from '../services/androidBridge';
import {
  FLOW_RADIO, FLOW_SEARCH_SUGGESTIONS, parseVideoId, resolveChannelId,
  youtubeChannelUrl, youtubeEmbedUrl, youtubeWatchUrl,
  type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult, type YtShelf, type YtVideo,
} from '../services/youtubeService';
import {
  DEFAULT_MIRRORS, flowChannel, flowDetail, flowHome, flowMusicHome, flowMusicSearch, flowSearch,
  isMusicVideo, normalizeMirrorUrl, youtubeMedia, youtubeStream,
  type FlowVideoRef, type YtBackend,
} from '../services/flowService';

/**
 * Flow tab — a privacy-first YouTube / YouTube Music browser modelled after
 * https://github.com/Flow-Tube/Flow. It reads YouTube's key-free data (no
 * account, no API key), keeps subscriptions locally, plays audio in PRAHA's
 * player, and opens videos in a cookie-less embed.
 */

type FlowTab = 'home' | 'search' | 'music' | 'channels';
type FlowVideo = FlowVideoRef;

interface FlowSubscription {
  id: string;
  name: string;
  avatar?: string;
  addedAt: number;
}

const FLOW_RELEASES = 'https://github.com/Flow-Tube/Flow/releases/latest';
const FLOW_REPO = 'https://github.com/Flow-Tube/Flow';
const SUBS_KEY = 'praha.v2.flow-subscriptions';
const LEGACY_CHANNELS_KEY = 'praha.v2.flow-channels';

const MUSIC_MOODS = ['Lo-fi beats', 'Jazz playlist', 'Synthwave mix', 'Live sessions', 'Music videos 4K'];

const VideoCard: React.FC<{ video: FlowVideo; onOpen: () => void }> = ({ video, onOpen }) => {
  const meta = [video.views, video.published].filter(Boolean).join(' · ');
  return (
    <article className="flow-card">
      <button className="flow-card-art" onClick={onOpen} aria-label={`Play ${video.title}`}>
        {video.thumbnail
          ? <img src={video.thumbnail} alt="" loading="lazy" />
          : <span className="flow-card-placeholder"><Video size={22} /></span>}
        {video.live
          ? <span className="flow-card-live">LIVE</span>
          : video.duration && <span className="flow-card-time">{video.duration}</span>}
        <span className="flow-card-play"><Play size={18} fill="currentColor" /></span>
      </button>
      <button className="flow-card-copy" onClick={onOpen}>
        <strong title={video.title}>{video.title}</strong>
        <span className="flow-card-channel">{video.channel || 'YouTube'}</span>
        {meta && <small>{meta}</small>}
      </button>
    </article>
  );
};

const Shelf: React.FC<{ shelf: YtShelf; onOpen: (video: YtVideo) => void; note?: string }> = ({ shelf, onOpen, note }) => (
  <section className="flow-shelf">
    <div className="section-heading">
      <div>
        <h2>{shelf.title}</h2>
        <p>{note || `${shelf.videos.length} video${shelf.videos.length === 1 ? '' : 's'} · streamed without an account`}</p>
      </div>
    </div>
    <div className="flow-row">
      {shelf.videos.slice(0, 18).map((video) => (
        <VideoCard key={`${shelf.id}-${video.id}`} video={video} onOpen={() => onOpen(video)} />
      ))}
    </div>
  </section>
);

interface FlowViewProps {
  onPlay: (media: ReturnType<typeof youtubeMedia>, stream: ReturnType<typeof youtubeStream>) => void;
  onEmbed: (media: ReturnType<typeof youtubeMedia>) => void;
  compact?: boolean;
}

const FlowView: React.FC<FlowViewProps> = ({ onPlay, onEmbed }) => {
  const [tab, setTab] = useState<FlowTab>('home');
  const [backend, setBackend] = useState<YtBackend | null>(null);

  /* ---------------- home ---------------- */
  const [home, setHome] = useState<YtHome | null>(null);
  const [homeState, setHomeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [homeError, setHomeError] = useState('');
  const [homeAttempt, setHomeAttempt] = useState(0);

  /* ---------------- search ---------------- */
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<YtSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  /* ---------------- music ---------------- */
  const [musicHome, setMusicHome] = useState<YtHome | null>(null);
  const [musicState, setMusicState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [musicError, setMusicError] = useState('');
  const [musicTerm, setMusicTerm] = useState('');
  const [musicQuery, setMusicQuery] = useState('');
  const [musicResults, setMusicResults] = useState<YtSearchResult | null>(null);
  const [musicSearching, setMusicSearching] = useState(false);

  /* ---------------- subscriptions ---------------- */
  const [subs, setSubs] = usePersistentState<FlowSubscription[]>(SUBS_KEY, []);
  const [channelDraft, setChannelDraft] = useState('');
  const [channelError, setChannelError] = useState('');
  const [feed, setFeed] = useState<YtChannelFeed | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [feedError, setFeedError] = useState('');

  /* ---------------- detail ---------------- */
  const [detail, setDetail] = useState<YtDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [detailError, setDetailError] = useState('');
  const [copied, setCopied] = useState(false);

  /* ---------------- mirrors ---------------- */
  const [mirrors, setMirrors] = usePersistentState<string[]>('praha.v2.flow-mirrors', DEFAULT_MIRRORS);
  const [mirrorDraft, setMirrorDraft] = useState('');
  const [mirrorError, setMirrorError] = useState('');
  const [showMirrors, setShowMirrors] = useState(false);

  const [radioOn, setRadioOn] = useState(false);
  const android = isAndroidApp();

  const isSubscribed = useCallback((id?: string) => Boolean(id && subs.some((entry) => entry.id === id)), [subs]);

  const toggleSubscribe = (channel: { id?: string; name?: string; avatar?: string }) => {
    if (!channel.id) return;
    const id = channel.id;
    setSubs((current) => (current.some((entry) => entry.id === id)
      ? current.filter((entry) => entry.id !== id)
      : [{ id, name: channel.name || id, avatar: channel.avatar, addedAt: Date.now() }, ...current]));
  };

  /* ---------------- legacy migration: followed channels → subscriptions ---------------- */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LEGACY_CHANNELS_KEY);
      if (!raw) return;
      const legacy = JSON.parse(raw) as unknown;
      if (!Array.isArray(legacy)) return;
      setSubs((current) => {
        const known = new Set(current.map((entry) => entry.id));
        const additions = legacy
          .filter((id): id is string => typeof id === 'string' && !known.has(id))
          .map((id) => ({ id, name: id, addedAt: Date.now() }));
        return additions.length ? [...additions, ...current] : current;
      });
    } catch { /* ignore unreadable legacy storage */ }
    // Runs once on mount; the setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- home load ---------------- */
  useEffect(() => {
    let active = true;
    setHomeState((state) => (state === 'ready' ? state : 'loading'));
    setHomeError('');
    flowHome()
      .then(({ data, backend: source }) => {
        if (!active) return;
        setHome(data);
        setBackend(source);
        setHomeState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setHomeState('error');
        setHomeError(error instanceof Error ? error.message : 'Could not reach YouTube.');
      });
    return () => { active = false; };
  }, [homeAttempt]);

  /* ---------------- music load ---------------- */
  useEffect(() => {
    if (tab !== 'music') return;
    let active = true;
    setMusicState((state) => (state === 'ready' ? state : 'loading'));
    setMusicError('');
    flowMusicHome()
      .then(({ data, backend: source }) => {
        if (!active) return;
        setMusicHome(data);
        setBackend(source);
        setMusicState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMusicState('error');
        setMusicError(error instanceof Error ? error.message : 'Could not load music.');
      });
    return () => { active = false; };
  }, [tab, homeAttempt]);

  /* ---------------- search ---------------- */
  useEffect(() => {
    if (!submitted) return;
    let active = true;
    setSearching(true);
    setSearchError('');
    flowSearch(submitted)
      .then(({ data, backend: source }) => { if (active) { setResults(data); setBackend(source); } })
      .catch((error: unknown) => {
        if (!active) return;
        setResults(null);
        setSearchError(error instanceof Error ? error.message : 'Search failed.');
      })
      .finally(() => { if (active) setSearching(false); });
    return () => { active = false; };
  }, [submitted]);

  /* ---------------- music search ---------------- */
  useEffect(() => {
    if (!musicQuery) return;
    let active = true;
    setMusicSearching(true);
    flowMusicSearch(musicQuery)
      .then(({ data, backend: source }) => {
        if (!active) return;
        setMusicResults({ ...data, videos: data.videos.filter(isMusicVideo) });
        setBackend(source);
      })
      .catch(() => { if (active) setMusicResults({ videos: [], channels: [] }); })
      .finally(() => { if (active) setMusicSearching(false); });
    return () => { active = false; };
  }, [musicQuery]);

  /* ---------------- channel feed ---------------- */
  const loadChannel = useCallback((id: string) => {
    setFeedId(id);
    setFeedState('loading');
    setFeedError('');
    flowChannel(id)
      .then(({ data, backend: source }) => { setFeed(data); setBackend(source); setFeedState('ready'); })
      .catch((error: unknown) => {
        setFeed(null);
        setFeedState('error');
        setFeedError(error instanceof Error ? error.message : 'Could not load that channel.');
      });
  }, []);

  useEffect(() => {
    if (tab !== 'channels' || feedId || !subs.length) return;
    loadChannel(subs[0].id);
  }, [tab, feedId, subs, loadChannel]);

  /* ---------------- detail ---------------- */
  const openVideo = useCallback((video: FlowVideo | string) => {
    const id = typeof video === 'string' ? video : video.id;
    setDetailId(id);
    setDetailState('loading');
    setDetailError('');
    setDetail(null);
    setCopied(false);
    flowDetail(id)
      .then(({ data, backend: source }) => { setDetail(data); setBackend(source); setDetailState('idle'); })
      .catch((error: unknown) => {
        setDetailState('error');
        setDetailError(error instanceof Error ? error.message : 'Could not load that video.');
      });
  }, []);

  const closeDetail = () => { setDetailId(null); setDetail(null); setDetailState('idle'); setDetailError(''); };

  /** Audio-only playback through PRAHA's player; the embed stays available beside it. */
  const playAudio = (video: YtDetail | FlowVideo) => {
    const media = youtubeMedia(video as FlowVideo, 'youtube');
    const stream = youtubeStream(video as FlowVideo);
    const audio = (video as YtDetail).audioTracks?.[0];
    if (audio) {
      stream.url = audio.url;
      stream.format = 'audio';
      stream.title = `${video.title} · audio only`;
    }
    onPlay(media, stream);
  };

  const shareVideo = async (id: string) => {
    const url = youtubeWatchUrl(id);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      openSafeExternalUrl(url);
    }
  };

  /* ---------------- derived ---------------- */
  const trending = useMemo(() => home?.shelves[0] || null, [home]);
  const shelves = useMemo(() => home?.shelves.slice(1) || [], [home]);

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const cleaned = term.trim();
    if (!cleaned) return;
    setSubmitted(cleaned);
  };

  const submitMusicSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const cleaned = musicTerm.trim();
    if (!cleaned) return;
    setMusicQuery(cleaned);
  };

  const searchVideoId = () => {
    try { return parseVideoId(term); } catch { return null; }
  };

  const addChannel = async (event: FormEvent) => {
    event.preventDefault();
    setChannelError('');
    try {
      const id = await resolveChannelId(channelDraft || '');
      if (!isSubscribed(id)) {
        setSubs((current) => [{ id, name: channelDraft.replace(/^.*\/channel\//, '') || id, addedAt: Date.now() }, ...current]);
      }
      setChannelDraft('');
      setFeed(null);
      loadChannel(id);
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : 'Could not add that channel.');
    }
  };

  const unsubscribe = (id: string) => {
    setSubs((current) => current.filter((entry) => entry.id !== id));
    if (feedId === id) { setFeedId(null); setFeed(null); setFeedState('idle'); }
  };

  const tabs: Array<{ id: FlowTab; label: string; subtitle: string; icon: typeof Video }> = [
    { id: 'home', label: 'Home', subtitle: 'Recommendations & trending', icon: Video },
    { id: 'search', label: 'Search', subtitle: 'Videos & channels', icon: Search },
    { id: 'music', label: 'Music', subtitle: 'Songs & mixes only', icon: Music },
    { id: 'channels', label: 'Subscriptions', subtitle: 'Channels you follow', icon: ListMusic },
  ];

  const detailChannel = detail
    ? { id: detail.channelId, name: detail.channel, avatar: detail.channelAvatar }
    : null;

  return (
    <div className="standard-page flow-page page-enter">
      <div className="flow-hero">
        <div className="flow-hero-copy">
          <span className="page-kicker"><Radio size={14} /> FLOW · YOUTUBE WITHOUT THE TRACKING</span>
          <h1>YouTube, on your terms</h1>
          <p>
            Browse recommendations, search, subscribe to channels, and listen to YouTube or YouTube
            Music audio in PRAHA's player. Data comes straight from YouTube's key-free endpoints — no
            account, no API key, and nothing handed to a third-party proxy.
          </p>
          <div className="flow-hero-actions">
            <a className="button button-primary" href={FLOW_RELEASES} target="_blank" rel="noreferrer noopener">
              Get Flow for Android <ExternalLink size={15} />
            </a>
            <a className="button button-secondary" href={FLOW_REPO} target="_blank" rel="noreferrer noopener">
              Source on GitHub
            </a>
            <button
              className={`button button-secondary ${radioOn ? 'is-saved' : ''}`}
              onClick={() => setRadioOn((on) => !on)}
            >
              {radioOn ? <Radio size={15} /> : <Music size={15} />} {radioOn ? 'Radio on' : 'Flow radio'}
            </button>
          </div>
          {radioOn && (
            <div className="flow-radio">
              <span className="status-dot" />
              <div>
                <strong>{FLOW_RADIO.name}</strong>
                <p>{FLOW_RADIO.description}</p>
              </div>
              <audio src={FLOW_RADIO.url} controls autoPlay preload="none" />
            </div>
          )}
        </div>
        <div className="flow-hero-side">
          <span className="flow-badge"><Film size={13} /> Flow tab</span>
          <p>{subs.length} subscription{subs.length === 1 ? '' : 's'} stored on this device only.</p>
          <span className={`flow-source-state ${backend || 'unknown'}`}>
            <span className="status-dot" />
            {backend === 'youtube'
              ? 'Served by YouTube directly'
              : backend === 'mirror'
                ? 'YouTube blocked — using a mirror'
                : 'Checking data sources…'}
          </span>
          {homeState === 'error' && (
            <button className="flow-link-button" onClick={() => setHomeAttempt((n) => n + 1)}>Retry YouTube</button>
          )}
          <button className="flow-link-button" onClick={() => setShowMirrors((open) => !open)}>
            {showMirrors ? 'Hide mirror settings' : 'Mirror settings'}
          </button>
          {showMirrors && (
            <div className="flow-mirrors">
              <p>YouTube’s key-free API sometimes refuses requests. These Piped / Invidious mirrors are only used when that happens.</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setMirrorError('');
                  try {
                    const url = normalizeMirrorUrl(mirrorDraft);
                    setMirrors((current) => (current.includes(url) ? current : [url, ...current]));
                    setMirrorDraft('');
                    setHomeAttempt((n) => n + 1);
                  } catch (error) {
                    setMirrorError(error instanceof Error ? error.message : 'Invalid mirror URL.');
                  }
                }}
              >
                <input
                  value={mirrorDraft}
                  onChange={(event) => setMirrorDraft(event.target.value)}
                  placeholder="https://pipedapi.example.com"
                  aria-label="Add a mirror"
                />
                <button type="submit" className="button button-secondary" aria-label="Add mirror"><Plus size={14} /></button>
              </form>
              {mirrorError && <p className="flow-channel-error"><CircleAlert size={12} /> {mirrorError}</p>}
              {mirrors.map((mirror) => (
                <div key={mirror} className="flow-mirror-row">
                  <span>{mirror.replace(/^https:\/\//, '')}</span>
                  <button onClick={() => setMirrors((current) => current.filter((entry) => entry !== mirror))} aria-label={`Remove ${mirror}`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button className="flow-link-button" onClick={() => { setMirrors(DEFAULT_MIRRORS); setHomeAttempt((n) => n + 1); }}>
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="explore-tabs flow-tabs" role="tablist" aria-label="Flow section">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`explore-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon size={18} />
              <span>{item.label}<small>{item.subtitle}</small></span>
              {item.id === 'channels' && subs.length > 0 && <b>{subs.length}</b>}
            </button>
          );
        })}
      </div>

      {tab === 'home' && (
        <div className="flow-section">
          {homeState === 'loading' && (
            <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Loading YouTube recommendations…</div>
          )}
          {homeState === 'error' && (
            <div className="empty-state explore-empty">
              <span><CircleAlert size={28} /></span>
              <h2>YouTube did not answer</h2>
              <p>{homeError} YouTube rate-limits key-free requests and every configured mirror failed. Add another mirror under Mirror settings, or retry in a minute.</p>
              <button className="button button-primary" onClick={() => setHomeAttempt((n) => n + 1)}>
                <RefreshCw size={15} /> Try again
              </button>
            </div>
          )}
          {homeState === 'ready' && trending && <Shelf shelf={trending} onOpen={(video) => openVideo(video)} />}
          {homeState === 'ready' && shelves.map((shelf) => (
            <Shelf key={shelf.id} shelf={shelf} onOpen={(video) => openVideo(video)} />
          ))}
        </div>
      )}

      {tab === 'search' && (
        <div className="flow-section">
          <form className="explore-search flow-search" onSubmit={submitSearch}>
            <Search size={17} />
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search YouTube, or paste a video link…"
              aria-label="Search YouTube"
            />
            {term && <button type="button" className="search-clear" onClick={() => setTerm('')} aria-label="Clear">×</button>}
          </form>
          <div className="flow-chips">
            {FLOW_SEARCH_SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} className="flow-chip" onClick={() => { setTerm(suggestion); setSubmitted(suggestion); }}>
                {suggestion}
              </button>
            ))}
            {searchVideoId() && (
              <button className="flow-chip flow-chip-accent" onClick={() => openVideo(searchVideoId() as string)}>
                <Play size={12} /> Open pasted video
              </button>
            )}
          </div>

          {searching && <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Searching YouTube…</div>}
          {searchError && <div className="flow-inline-error"><CircleAlert size={16} /> {searchError}</div>}

          {results && (
            <>
              {results.channels.length > 0 && (
                <section className="flow-shelf">
                  <div className="section-heading"><div><h2>Channels</h2><p>Subscribe to see a channel's uploads without an account.</p></div></div>
                  <div className="flow-channels-inline">
                    {results.channels.slice(0, 8).map((channel) => {
                      const subscribed = isSubscribed(channel.id);
                      return (
                        <div key={channel.id} className="flow-channel-pill">
                          <button
                            className="flow-channel-pill-main"
                            onClick={() => { setFeed(null); loadChannel(channel.id); setTab('channels'); }}
                          >
                            {channel.thumbnail
                              ? <img src={channel.thumbnail} alt="" loading="lazy" />
                              : <span className="flow-channel-initial">{channel.name.charAt(0)}</span>}
                            <span>
                              <strong>{channel.name}</strong>
                              <small>{channel.subscribers || channel.handle || 'Channel'}</small>
                            </span>
                          </button>
                          <button
                            className={`flow-subscribe ${subscribed ? 'subscribed' : ''}`}
                            onClick={() => toggleSubscribe({ id: channel.id, name: channel.name, avatar: channel.thumbnail })}
                          >
                            {subscribed ? <><Check size={12} /> Subscribed</> : <><Plus size={12} /> Subscribe</>}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              {results.videos.length > 0 ? (
                <section className="flow-shelf">
                  <div className="section-heading"><div><h2>Videos for “{submitted}”</h2><p>{results.videos.length} results</p></div></div>
                  <div className="flow-grid">
                    {results.videos.map((video) => (
                      <VideoCard key={video.id} video={video} onOpen={() => openVideo(video)} />
                    ))}
                  </div>
                </section>
              ) : (
                !searching && <div className="flow-loading">No videos matched that search.</div>
              )}
            </>
          )}
          {!results && !searching && !searchError && (
            <div className="empty-state explore-empty">
              <span><Search size={28} /></span>
              <h2>Search YouTube</h2>
              <p>Typing sends only your words to YouTube — the Flow tab keeps no history and no profile.</p>
            </div>
          )}
        </div>
      )}

      {tab === 'music' && (
        <div className="flow-section">
          <div className="flow-music-banner">
            <span className="flow-source-icon"><Music size={20} /></span>
            <div>
              <strong>YouTube Music — songs and mixes only</strong>
              <p>Live news, podcasts and anything without a running time is filtered out. Playback is audio-only in PRAHA's player.</p>
            </div>
          </div>

          <form className="explore-search flow-search" onSubmit={submitMusicSearch}>
            <Music size={17} />
            <input
              value={musicTerm}
              onChange={(event) => setMusicTerm(event.target.value)}
              placeholder="Search for songs, artists, albums, or mixes…"
              aria-label="Search music"
            />
            {musicTerm && <button type="button" className="search-clear" onClick={() => { setMusicTerm(''); setMusicQuery(''); setMusicResults(null); }} aria-label="Clear">×</button>}
          </form>

          <div className="flow-chips">
            {MUSIC_MOODS.map((mood) => (
              <button key={mood} className="flow-chip" onClick={() => { setMusicTerm(mood); setMusicQuery(mood); }}>
                {mood}
              </button>
            ))}
          </div>

          {musicSearching && <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Finding music…</div>}

          {musicResults && !musicSearching && (
            musicResults.videos.length ? (
              <Shelf
                shelf={{ id: 'music-search', title: `Music for “${musicQuery}”`, videos: musicResults.videos }}
                onOpen={(video) => openVideo(video)}
                note={`${musicResults.videos.length} audio track${musicResults.videos.length === 1 ? '' : 's'} · live streams filtered out`}
              />
            ) : (
              <div className="flow-inline-error"><CircleAlert size={16} /> No music matched that search.</div>
            )
          )}

          {!musicResults && !musicSearching && (
            <>
              {musicState === 'loading' && <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Tuning the music shelves…</div>}
              {musicState === 'error' && <div className="flow-inline-error"><CircleAlert size={16} /> {musicError}</div>}
              {musicState === 'ready' && musicHome?.shelves.map((shelf) => (
                <Shelf
                  key={shelf.id}
                  shelf={shelf}
                  onOpen={(video) => openVideo(video)}
                  note={`${shelf.videos.length} track${shelf.videos.length === 1 ? '' : 's'} · music only`}
                />
              ))}
            </>
          )}
        </div>
      )}

      {tab === 'channels' && (
        <div className="flow-section flow-channels">
          <aside className="flow-channel-list">
            <p className="explore-list-label">SUBSCRIPTIONS</p>
            <form className="flow-channel-form" onSubmit={addChannel}>
              <input
                value={channelDraft}
                onChange={(event) => setChannelDraft(event.target.value)}
                placeholder="@handle, /channel/UC… link"
                aria-label="Subscribe to a YouTube channel"
              />
              <button type="submit" className="button button-primary" aria-label="Subscribe"><Plus size={15} /></button>
            </form>
            {channelError && <p className="flow-channel-error"><CircleAlert size={13} /> {channelError}</p>}
            {subs.length === 0 && <p className="flow-channel-empty">No subscriptions yet. Add a channel with its @handle or /channel/ link.</p>}
            {subs.map((entry) => (
              <div key={entry.id} className={`flow-channel-row ${feedId === entry.id ? 'active' : ''}`}>
                <button onClick={() => loadChannel(entry.id)} title={entry.name}>{entry.name.length > 18 ? `${entry.name.slice(0, 18)}…` : entry.name}</button>
                <button className="flow-channel-remove" onClick={() => unsubscribe(entry.id)} aria-label={`Unsubscribe from ${entry.name}`}><Trash2 size={13} /></button>
              </div>
            ))}
          </aside>

          <div className="flow-channel-feed">
            {feedState === 'loading' && <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Loading channel…</div>}
            {feedState === 'error' && <div className="flow-inline-error"><CircleAlert size={16} /> {feedError}</div>}
            {feedState === 'ready' && feed && (
              <>
                <div className="flow-channel-header">
                  <div>
                    <h2>{feed.title}</h2>
                    <p>{feed.videos.length} recent uploads{feed.subscribers ? ` · ${feed.subscribers}` : ''}</p>
                  </div>
                  <div className="flow-channel-header-actions">
                    <button
                      className={`button ${isSubscribed(feed.channelId) ? 'button-secondary is-saved' : 'button-primary'}`}
                      onClick={() => toggleSubscribe({ id: feed.channelId, name: feed.title, avatar: feed.avatar })}
                    >
                      {isSubscribed(feed.channelId) ? <><Check size={14} /> Subscribed</> : <><Bell size={14} /> Subscribe</>}
                    </button>
                    <button className="button button-secondary" onClick={() => loadChannel(feed.channelId)}><RefreshCw size={14} /> Refresh</button>
                    <button className="button button-secondary" onClick={() => openSafeExternalUrl(youtubeChannelUrl(feed.channelId))}>
                      Open on YouTube <ExternalLink size={14} />
                    </button>
                  </div>
                </div>
                <div className="flow-grid">
                  {feed.videos.map((video) => (
                    <VideoCard key={video.id} video={video} onOpen={() => openVideo(video)} />
                  ))}
                </div>
              </>
            )}
            {feedState === 'idle' && !subs.length && (
              <div className="empty-state explore-empty">
                <span><BellRing size={28} /></span>
                <h2>No subscriptions</h2>
                <p>Add a channel to pull its uploads straight from YouTube's public feed. Everything stays on this device.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {detailId && (
        <div className="flow-detail-backdrop" role="dialog" aria-modal="true" aria-label="YouTube video" onClick={closeDetail}>
          <div className="flow-detail" onClick={(event) => event.stopPropagation()}>
            <div className="flow-detail-head">
              <div>
                <span className="page-kicker"><Video size={13} /> YOUTUBE · FLOW</span>
                <h2>{detail?.title || 'Loading video…'}</h2>
                <div className="flow-detail-meta">
                  {detail?.channel && <span>{detail.channel}</span>}
                  {detail?.views && <span>{detail.views}</span>}
                  {detail?.published && <span><Clock size={11} /> {detail.published}</span>}
                  {detail?.likes && <span>{detail.likes} likes</span>}
                  {detail?.live && <span className="flow-live">LIVE</span>}
                </div>
              </div>
              <button className="flow-close" onClick={closeDetail} aria-label="Close"><X size={17} /></button>
            </div>

            <div className="flow-detail-stage">
              {detailState === 'loading' && <div className="flow-loading"><LoaderCircle size={22} className="spin" /> Preparing player…</div>}
              {detailState === 'error' && (
                <>
                  {/* The embed does not need the metadata API, so keep the video playable. */}
                  <iframe
                    src={youtubeEmbedUrl(detailId)}
                    title="YouTube video"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                    allowFullScreen
                  />
                  <div className="flow-stage-note">
                    <CircleAlert size={15} />
                    <span>Details unavailable ({detailError}). The player above still works.</span>
                    <button onClick={() => openVideo(detailId)}><RefreshCw size={12} /> Retry</button>
                    <button onClick={() => openSafeExternalUrl(youtubeWatchUrl(detailId))}><ExternalLink size={12} /> YouTube</button>
                  </div>
                </>
              )}
              {detailState === 'idle' && detail && (
                <iframe
                  src={youtubeEmbedUrl(detail.id)}
                  title={detail.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              )}
              {detailState === 'idle' && detail && detailChannel?.id && (
                <div className="flow-inplayer-bar">
                  <span className="flow-inplayer-channel">
                    {detailChannel.avatar
                      ? <img src={detailChannel.avatar} alt="" />
                      : <span className="flow-channel-initial">{detailChannel.name.charAt(0)}</span>}
                    <span>
                      <strong>{detailChannel.name}</strong>
                      <small>{detail.channelSubscribers || 'YouTube channel'}</small>
                    </span>
                  </span>
                  <button
                    className={`flow-subscribe ${isSubscribed(detailChannel.id) ? 'subscribed' : ''}`}
                    onClick={() => toggleSubscribe(detailChannel)}
                  >
                    {isSubscribed(detailChannel.id)
                      ? <><BellRing size={13} /> Subscribed</>
                      : <><Bell size={13} /> Subscribe</>}
                  </button>
                </div>
              )}
            </div>

            <div className="flow-detail-actions">
              {detail && (
                <>
                  <button className="button button-primary" onClick={() => playAudio(detail)}>
                    <Play size={15} fill="currentColor" /> Play audio in PRAHA
                  </button>
                  <button className="button button-secondary" onClick={() => onEmbed(youtubeMedia(detail, detail.id))}>
                    <Film size={15} /> Embedded player
                  </button>
                  <button className="button button-secondary" onClick={() => { void shareVideo(detail.id); }}>
                    {copied ? <><Check size={15} /> Link copied</> : <><Share2 size={15} /> Share</>}
                  </button>
                  <button className="button button-secondary" onClick={() => openSafeExternalUrl(youtubeWatchUrl(detail.id))}>
                    <ExternalLink size={15} /> YouTube
                  </button>
                </>
              )}
              {!detail && detailId && detailState === 'loading' && (
                <button className="button button-secondary" onClick={() => openSafeExternalUrl(youtubeWatchUrl(detailId))}>
                  <ExternalLink size={15} /> Open on YouTube
                </button>
              )}
            </div>

            {detail && (
              <div className="flow-detail-body">
                <div className="flow-detail-main">
                  {detail.chapters.length > 0 && (
                    <div className="flow-chapters">
                      <p className="explore-list-label">CHAPTERS</p>
                      {detail.chapters.map((chapter) => (
                        <span key={`${chapter.start}-${chapter.title}`}>
                          <b>{formatClock(chapter.start)}</b> {chapter.title}
                        </span>
                      ))}
                    </div>
                  )}
                  {detail.description && <p className="flow-description">{detail.description.slice(0, 1600)}</p>}
                  {detail.keywords && detail.keywords.length > 0 && (
                    <div className="flow-chips">
                      {detail.keywords.map((keyword) => (
                        <span key={keyword} className="flow-chip flow-chip-static">#{keyword.replace(/\s+/g, '')}</span>
                      ))}
                    </div>
                  )}

                  <div className="flow-comments">
                    <p className="explore-list-label">COMMENTS {detail.comments.length ? `· ${detail.comments.length}` : ''}</p>
                    {detail.comments.length === 0 && (
                      <p className="flow-channel-empty">
                        Comments are not exposed by this data source. Open the video on YouTube to read them.
                      </p>
                    )}
                    {detail.comments.map((comment) => (
                      <div key={comment.id} className="flow-comment">
                        <span className="flow-comment-avatar">{comment.author.charAt(0).toUpperCase()}</span>
                        <div>
                          <strong>{comment.author} <small>{comment.published}</small></strong>
                          <p>{comment.text}</p>
                          <small>{comment.likes ? `${comment.likes} likes` : ''} {comment.replies ? `· ${comment.replies} replies` : ''}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <aside className="flow-detail-side">
                  <p className="explore-list-label">UP NEXT</p>
                  {detail.related.slice(0, 12).map((video) => (
                    <button key={video.id} className="flow-related" onClick={() => openVideo(video)}>
                      <span className="flow-related-art">
                        {video.thumbnail ? <img src={video.thumbnail} alt="" loading="lazy" /> : <Video size={16} />}
                        {video.duration && <small>{video.duration}</small>}
                      </span>
                      <span>
                        <strong>{video.title}</strong>
                        <small>{video.channel}</small>
                        <small>{[video.views, video.published].filter(Boolean).join(' · ')}</small>
                      </span>
                    </button>
                  ))}
                  {detail.related.length === 0 && <p className="flow-channel-empty">No related videos returned.</p>}
                </aside>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export default FlowView;
