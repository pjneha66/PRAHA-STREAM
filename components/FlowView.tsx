import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, CircleAlert, Clock, ExternalLink, Eye, Film, ListMusic, LoaderCircle,
  MessageCircle, Music, Play, Plus, Radio, RefreshCw, Search, Trash2, Video, X,
} from 'lucide-react';
import type { MediaItem, StreamResult } from '../types';
import { usePersistentState } from '../hooks/usePersistentState';
import { isAndroidApp, openSafeExternalUrl } from '../services/androidBridge';
import {
  FLOW_RADIO, FLOW_SEARCH_SUGGESTIONS, fetchYoutubeChannel, fetchYoutubeDetail, fetchYoutubeHome,
  normalizeChannelInput, parseVideoId, resolveChannelId, searchYoutube, youtubeChannelUrl, youtubeEmbedUrl,
  youtubeWatchUrl,
  type YtChannelFeed, type YtDetail, type YtHome, type YtSearchResult, type YtShelf, type YtVideo,
} from '../services/youtubeService';

/**
 * Flow tab — a privacy-first YouTube / YouTube Music browser modelled after
 * https://github.com/Flow-Tube/Flow. It reads YouTube's own key-free data (no
 * account, no API key, nothing sent to a third party), plays audio inside
 * PRAHA's native player, and can hand a video to the embedded player or the
 * Flow Android app.
 */

type FlowTab = 'home' | 'search' | 'music' | 'channels';
type FlowVideo = Pick<YtVideo, 'id' | 'title' | 'channel' | 'thumbnail' | 'duration' | 'views' | 'published'>;

const FLOW_RELEASES = 'https://github.com/Flow-Tube/Flow/releases/latest';
const FLOW_REPO = 'https://github.com/Flow-Tube/Flow';

/** Turn a Flow video into the MediaItem-shaped record PRAHA's player expects. */
export function youtubeMedia(video: FlowVideo, fallbackId = 'youtube:unknown'): MediaItem {
  return {
    id: `youtube:${video.id || fallbackId}`,
    type: 'movie',
    title: video.title || 'YouTube video',
    overview: '',
    poster: video.thumbnail || '',
    backdrop: video.thumbnail || '',
    year: video.published,
    genres: ['YouTube'],
    source: 'youtube',
  };
}

export function youtubeStream(video: FlowVideo): StreamResult {
  return {
    id: `youtube:${video.id}`,
    title: video.title,
    url: youtubeWatchUrl(video.id),
    sourceName: 'YouTube · Flow',
    sourceType: 'nuvio',
    provider: 'flow',
    format: 'youtube',
    externalUrl: youtubeWatchUrl(video.id),
    ytId: video.id,
  };
}

const VideoCard: React.FC<{ video: FlowVideo; onOpen: () => void; radio?: boolean }> = ({ video, onOpen, radio }) => (
  <article className="flow-card">
    <button className="flow-card-art" onClick={onOpen} aria-label={`Play ${video.title}`}>
      {video.thumbnail
        ? <img src={video.thumbnail} alt="" loading="lazy" />
        : <span className="flow-card-placeholder"><Video size={22} /></span>}
      {video.duration && <span className="flow-card-time">{video.duration}</span>}
      <span className="flow-card-play"><Play size={18} fill="currentColor" /></span>
    </button>
    <button className="flow-card-copy" onClick={onOpen}>
      <strong title={video.title}>{video.title}</strong>
      <span>{video.channel || 'YouTube'}</span>
      <small>{[video.views, video.published].filter(Boolean).join(' · ') || (radio ? 'Radio' : 'YouTube')}</small>
    </button>
  </article>
);

const Shelf: React.FC<{ shelf: YtShelf; onOpen: (video: YtVideo) => void }> = ({ shelf, onOpen }) => (
  <section className="flow-shelf">
    <div className="section-heading">
      <div>
        <h2>{shelf.title}</h2>
        <p>{shelf.videos.length} video{shelf.videos.length === 1 ? '' : 's'} · recommendations computed by YouTube, streamed without an account</p>
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
  onPlay: (media: MediaItem, stream: StreamResult) => void;
  onEmbed: (media: MediaItem) => void;
  compact?: boolean;
}

const FlowView: React.FC<FlowViewProps> = ({ onPlay, onEmbed }) => {
  const [tab, setTab] = useState<FlowTab>('home');

  const [home, setHome] = useState<YtHome | null>(null);
  const [homeState, setHomeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [homeError, setHomeError] = useState('');
  const [homeAttempt, setHomeAttempt] = useState(0);

  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [results, setResults] = useState<YtSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const [channels, setChannels] = usePersistentState<string[]>('praha.v2.flow-channels', ['UCXuqSBlHAE6Xw-yeJA0Tunw']);
  const [channelDraft, setChannelDraft] = useState('');
  const [channelError, setChannelError] = useState('');
  const [feed, setFeed] = useState<YtChannelFeed | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [feedError, setFeedError] = useState('');

  const [detail, setDetail] = useState<YtDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [detailError, setDetailError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const [radioOn, setRadioOn] = useState(false);
  const android = isAndroidApp();

  /* ---------------- home ---------------- */
  useEffect(() => {
    if (tab !== 'home' && tab !== 'music' && tab !== 'search' && tab !== 'channels') return;
    let active = true;
    setHomeState((state) => (state === 'ready' ? state : 'loading'));
    setHomeError('');
    fetchYoutubeHome()
      .then((payload) => { if (active) { setHome(payload); setHomeState('ready'); } })
      .catch((error: unknown) => {
        if (!active) return;
        setHomeState('error');
        setHomeError(error instanceof Error ? error.message : 'Could not reach YouTube.');
      });
    return () => { active = false; };
  }, [homeAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- search ---------------- */
  useEffect(() => {
    if (!submitted) return;
    let active = true;
    setSearching(true);
    setSearchError('');
    searchYoutube(submitted)
      .then((payload) => { if (active) setResults(payload); })
      .catch((error: unknown) => {
        if (!active) return;
        setResults(null);
        setSearchError(error instanceof Error ? error.message : 'Search failed.');
      })
      .finally(() => { if (active) setSearching(false); });
    return () => { active = false; };
  }, [submitted]);

  /* ---------------- channel ---------------- */
  const loadChannel = useCallback((id: string) => {
    setFeedId(id);
    setFeedState('loading');
    setFeedError('');
    fetchYoutubeChannel(id)
      .then((payload) => { setFeed(payload); setFeedState('ready'); })
      .catch((error: unknown) => {
        setFeed(null);
        setFeedState('error');
        setFeedError(error instanceof Error ? error.message : 'Could not load that channel.');
      });
  }, []);

  useEffect(() => {
    if (tab !== 'channels' || feedId || !channels.length) return;
    loadChannel(channels[0]);
  }, [tab, feedId, channels, loadChannel]);

  /* ---------------- detail ---------------- */
  const openVideo = useCallback((video: FlowVideo | string) => {
    const id = typeof video === 'string' ? video : video.id;
    setDetailId(id);
    setDetailState('loading');
    setDetailError('');
    setDetail(null);
    fetchYoutubeDetail(id)
      .then((payload) => { setDetail(payload); setDetailState('idle'); })
      .catch((error: unknown) => {
        setDetailState('error');
        setDetailError(error instanceof Error ? error.message : 'Could not load that video.');
      });
  }, []);

  const closeDetail = () => { setDetailId(null); setDetail(null); setDetailState('idle'); setDetailError(''); };

  /** Audio-only playback through PRAHA's player, with the embed as a fallback. */
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

  /* ---------------- derived ---------------- */
  const trending: YtShelf | null = useMemo(() => home?.shelves[0] || null, [home]);
  const shelves = useMemo(() => home?.shelves.slice(1) || [], [home]);
  const musicShelf = useMemo(() => {
    if (!home) return null;
    const match = home.shelves.find((shelf) => /music|mix|song|album|playlist|radio/i.test(shelf.title));
    return match || home.shelves[home.shelves.length - 1] || null;
  }, [home]);

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const cleaned = term.trim();
    if (!cleaned) return;
    setSubmitted(cleaned);
  };

  const searchVideoId = () => {
    try { return parseVideoId(term); } catch { return null; }
  };

  const addChannel = async (event: FormEvent) => {
    event.preventDefault();
    setChannelError('');
    try {
      const id = await resolveChannelId(channelDraft || '');
      setChannels((current) => (current.includes(id) ? current : [id, ...current]));
      setChannelDraft('');
      setFeed(null);
      loadChannel(id);
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : 'Could not add that channel.');
    }
  };

  const removeChannel = (id: string) => {
    setChannels((current) => current.filter((entry) => entry !== id));
    if (feedId === id) { setFeedId(null); setFeed(null); setFeedState('idle'); }
  };

  const tabs: Array<{ id: FlowTab; label: string; subtitle: string; icon: typeof Video }> = [
    { id: 'home', label: 'Home', subtitle: 'Recommendations & trending', icon: Video },
    { id: 'search', label: 'Search', subtitle: 'Videos & channels', icon: Search },
    { id: 'music', label: 'Music', subtitle: 'Songs, mixes & radio', icon: Music },
    { id: 'channels', label: 'Channels', subtitle: 'Subscribe without an account', icon: ListMusic },
  ];

  return (
    <div className="standard-page flow-page page-enter">
      <div className="flow-hero">
        <div className="flow-hero-copy">
          <span className="page-kicker"><Radio size={14} /> FLOW · YOUTUBE WITHOUT THE TRACKING</span>
          <h1>YouTube, on your terms</h1>
          <p>
            Browse recommendations, search, follow channels, and listen to YouTube or YouTube Music
            audio in PRAHA's player. Data comes straight from YouTube's key-free endpoints — no
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
          <p>Plays in PRAHA's native player, opens in the built-in embed, or hands off to the Flow app.</p>
          {android && (
            <button className="button button-secondary" onClick={() => openSafeExternalUrl(FLOW_RELEASES)}>
              Open Flow on this device <ExternalLink size={14} />
            </button>
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
              <p>{homeError} YouTube sometimes rate-limits key-free requests; retrying usually works.</p>
              <button className="button button-primary" onClick={() => setHomeAttempt((n) => n + 1)}>
                <RefreshCw size={15} /> Try again
              </button>
            </div>
          )}
          {homeState === 'ready' && trending && <Shelf shelf={trending} onOpen={(video) => openVideo(video)} />}
          {homeState === 'ready' && shelves.map((shelf) => <Shelf key={shelf.id} shelf={shelf} onOpen={(video) => openVideo(video)} />)}
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
                  <div className="section-heading"><div><h2>Channels</h2><p>Follow a channel to see its uploads without subscribing.</p></div></div>
                  <div className="flow-channels-inline">
                    {results.channels.slice(0, 8).map((channel) => (
                      <button
                        key={channel.id}
                        className="flow-channel-pill"
                        onClick={() => {
                          setChannels((current) => (current.includes(channel.id) ? current : [channel.id, ...current]));
                          setFeed(null);
                          loadChannel(channel.id);
                          setTab('channels');
                        }}
                      >
                        {channel.thumbnail ? <img src={channel.thumbnail} alt="" loading="lazy" /> : <span className="flow-channel-initial">{channel.name.charAt(0)}</span>}
                        <span>
                          <strong>{channel.name}</strong>
                          <small>{channel.subscribers || channel.handle || 'Channel'}</small>
                        </span>
                        <Plus size={14} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {results.videos.length > 0 ? (
                <section className="flow-shelf">
                  <div className="section-heading"><div><h2>Videos for “{submitted}”</h2><p>{results.videos.length} results</p></div></div>
                  <div className="flow-row">
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
              <strong>YouTube Music audio</strong>
              <p>Every video can play audio-only in PRAHA's player, so mixes and albums keep playing with the screen off.</p>
            </div>
            <button className="button button-secondary" onClick={() => setTab('search')}>
              Find music <ChevronRight size={15} />
            </button>
          </div>
          {homeState === 'loading' && <div className="flow-loading"><LoaderCircle size={20} className="spin" /> Tuning the music shelf…</div>}
          {homeState === 'error' && <div className="flow-inline-error"><CircleAlert size={16} /> {homeError}</div>}
          {musicShelf && (
            <Shelf
              shelf={{ ...musicShelf, title: 'Mixes & music' }}
              onOpen={(video) => openVideo(video)}
            />
          )}
          <div className="flow-chips">
            {['Lo-fi beats', 'Jazz playlist', 'Synthwave mix', 'Live sessions', 'Music videos 4K'].map((suggestion) => (
              <button key={suggestion} className="flow-chip" onClick={() => { setTerm(suggestion); setSubmitted(suggestion); setTab('search'); }}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'channels' && (
        <div className="flow-section flow-channels">
          <aside className="flow-channel-list">
            <p className="explore-list-label">FOLLOWED CHANNELS</p>
            <form className="flow-channel-form" onSubmit={addChannel}>
              <input
                value={channelDraft}
                onChange={(event) => setChannelDraft(event.target.value)}
                placeholder="@handle, /channel/UC… link"
                aria-label="Add a YouTube channel"
              />
              <button type="submit" className="button button-primary" aria-label="Add channel"><Plus size={15} /></button>
            </form>
            {channelError && <p className="flow-channel-error"><CircleAlert size={13} /> {channelError}</p>}
            {channels.length === 0 && <p className="flow-channel-empty">No channels yet. Add one with its @handle or /channel/ link.</p>}
            {channels.map((id) => (
              <div key={id} className={`flow-channel-row ${feedId === id ? 'active' : ''}`}>
                <button onClick={() => loadChannel(id)}>{id.slice(0, 14)}…</button>
                <button className="flow-channel-remove" onClick={() => removeChannel(id)} aria-label={`Remove ${id}`}><Trash2 size={13} /></button>
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
                    <p>{feed.videos.length} recent uploads from the public feed — no subscription needed.</p>
                  </div>
                  <div className="flow-channel-header-actions">
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
            {feedState === 'idle' && !channels.length && (
              <div className="empty-state explore-empty">
                <span><ListMusic size={28} /></span>
                <h2>No channels followed</h2>
                <p>Add a channel to pull its uploads straight from YouTube's public feed.</p>
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
                  {detail?.views && <span><Eye size={11} /> {detail.views}</span>}
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
                <div className="flow-stage-error">
                  <CircleAlert size={22} />
                  <p>{detailError}</p>
                  <div>
                    <button className="button button-secondary" onClick={() => openVideo(detailId)}><RefreshCw size={14} /> Retry</button>
                    <button className="button button-secondary" onClick={() => openSafeExternalUrl(youtubeWatchUrl(detailId))}>
                      Watch on YouTube <ExternalLink size={14} />
                    </button>
                  </div>
                </div>
              )}
              {detailState === 'idle' && detail && (
                <iframe
                  src={youtubeEmbedUrl(detail.id)}
                  title={detail.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              )}
            </div>

            <div className="flow-detail-actions">
              {detail && (
                <>
                  <button className="button button-primary" onClick={() => playAudio(detail)}>
                    <Play size={15} fill="currentColor" /> Play in PRAHA
                  </button>
                  <button className="button button-secondary" onClick={() => onEmbed(youtubeMedia(detail, detail.id))}>
                    <Film size={15} /> Embedded player
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
                      {detail.keywords.map((keyword) => <span key={keyword} className="flow-chip flow-chip-static">#{keyword.replace(/\s+/g, '')}</span>)}
                    </div>
                  )}

                  <div className="flow-comments">
                    <p className="explore-list-label"><MessageCircle size={12} /> COMMENTS {detail.comments.length ? `· ${detail.comments.length}` : ''}</p>
                    {detail.comments.length === 0 && <p className="flow-channel-empty">Comments are not exposed for this video.</p>}
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
                      {video.thumbnail ? <img src={video.thumbnail} alt="" loading="lazy" /> : <span className="flow-related-placeholder"><Video size={16} /></span>}
                      <span>
                        <strong>{video.title}</strong>
                        <small>{video.channel}</small>
                        <small>{[video.views, video.duration].filter(Boolean).join(' · ')}</small>
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
