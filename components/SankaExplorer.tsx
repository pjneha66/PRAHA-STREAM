import React, { FormEvent, useEffect, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, LoaderCircle, RotateCcw, Search, Sparkles, Tv, X } from 'lucide-react';
import {
  fetchSankaChapterImages, fetchSankaMangaDetail, fetchSankaTitles, SANKA_API_ORIGIN, SANKA_COMIC_SOURCES,
  type ComicFeed, type SankaKind, type SankaTitle, type SankaMangaDetail,
} from '../services/sankaService';

const SankaExplorer: React.FC = () => {
  const [kind, setKind] = useState<SankaKind>('anime');
  const [source, setSource] = useState('komiku');
  const [feed, setFeed] = useState<ComicFeed>('latest');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [items, setItems] = useState<SankaTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<SankaTitle | null>(null);
  const [detail, setDetail] = useState<SankaMangaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [readerImages, setReaderImages] = useState<string[] | null>(null);
  const [readerChapterIndex, setReaderChapterIndex] = useState(0);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    fetchSankaTitles(kind, submittedQuery, kind === 'comic' ? source : 'otakudesu', feed)
      .then((result) => { if (current) setItems(result); })
      .catch((reason: unknown) => {
        if (!current) return;
        setItems([]);
        setError(reason instanceof Error ? reason.message : 'Could not load titles from Sanka API.');
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kind, source, feed, submittedQuery, attempt]);

  useEffect(() => {
    if (!selected || selected.kind !== 'comic') {
      setDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return;
    }
    let current = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    fetchSankaMangaDetail(selected.source, selected.slug)
      .then((result) => { if (current) setDetail(result); })
      .catch((reason: unknown) => { if (current) setDetailError(reason instanceof Error ? reason.message : 'Could not load manga details.'); })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selected]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  const changeKind = (next: SankaKind) => {
    setKind(next);
    setQuery('');
    setSubmittedQuery('');
    setSource(next === 'comic' ? 'komiku' : 'otakudesu');
    setFeed('latest');
  };

  const openTitle = (item: SankaTitle) => {
    if (item.kind === 'comic') setSelected(item);
  };

  const openChapter = async (slug: string, chapterIndex: number) => {
    if (!selected) return;
    setReaderChapterIndex(chapterIndex);
    setReaderImages(null);
    setReaderLoading(true);
    setReaderError('');
    try {
      const pages = await fetchSankaChapterImages(selected.source, slug);
      setReaderImages(pages);
    } catch (reason) {
      setReaderError(reason instanceof Error ? reason.message : 'Could not load chapter pages.');
    } finally {
      setReaderLoading(false);
    }
  };

  const closeDetails = () => {
    setSelected(null);
    setReaderImages(null);
    setReaderError('');
  };
  const KindIcon = kind === 'anime' ? Tv : BookOpen;
  const chapters = detail?.chapters || [];
  const selectedChapter = chapters[readerChapterIndex];

  return (
    <div className="standard-page page-enter sanka-page">
      <div className="page-heading sanka-heading">
        <div>
          <span className="page-kicker"><Sparkles size={14} /> SANKA API · ANIME & COMICS</span>
          <h1>Explore beyond the catalog.</h1>
          <p>Browse anime and manga from the linked Sanka API. Comic chapters are read from the selected API source.</p>
        </div>
        <a className="text-button" href="https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic" target="_blank" rel="noreferrer noopener">
          API project <ExternalLink size={13} />
        </a>
      </div>

      <div className="sanka-toolbar">
        <div className="filter-pills" role="tablist" aria-label="Sanka catalog type">
          <button role="tab" aria-selected={kind === 'anime'} className={kind === 'anime' ? 'active' : ''} onClick={() => changeKind('anime')}><Tv size={14} /> Anime</button>
          <button role="tab" aria-selected={kind === 'comic'} className={kind === 'comic' ? 'active' : ''} onClick={() => changeKind('comic')}><BookOpen size={14} /> Manga & comics</button>
        </div>
        <div className="sanka-catalog-controls">
          {kind === 'comic' && (
            <>
              <label className="source-select">
                <span className="sanka-sr-only">Comic source</span>
                <select aria-label="Comic source" value={source} onChange={(event) => { setSource(event.target.value); setSubmittedQuery(''); setQuery(''); }}>
                  {SANKA_COMIC_SOURCES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label className="source-select">
                <span className="sanka-sr-only">Comic feed</span>
                <select aria-label="Comic feed" value={feed} onChange={(event) => setFeed(event.target.value as ComicFeed)}>
                  <option value="latest">Latest</option>
                  <option value="popular">Popular</option>
                </select>
              </label>
            </>
          )}
          <form className="sanka-search" onSubmit={search}>
            <Search size={16} />
            <input aria-label={`Search ${kind === 'anime' ? 'anime' : 'manga and comics'}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${kind === 'anime' ? 'anime' : 'manga and comics'}…`} />
            <button className="button button-primary button-small" type="submit" disabled={loading}>Search</button>
          </form>
        </div>
      </div>

      <div className="sanka-results-heading">
        <div><KindIcon size={17} /><h2>{submittedQuery ? `Results for “${submittedQuery}”` : kind === 'anime' ? 'Latest anime' : feed === 'popular' ? 'Popular manga & comics' : 'Latest manga & comics'}</h2></div>
        {!loading && !error && <span>{items.length} titles · {kind === 'comic' ? SANKA_COMIC_SOURCES.find((item) => item.id === source)?.label : 'Otakudesu'}</span>}
      </div>

      {loading ? (
        <div className="sanka-state" role="status"><LoaderCircle size={23} className="spin" /><p>Loading {kind === 'anime' ? 'anime' : 'manga and comics'}…</p></div>
      ) : error ? (
        <div className="empty-state sanka-state sanka-error" role="alert"><span><CircleAlert size={25} /></span><h2>Couldn’t reach Sanka API</h2><p>{error} The API may be temporarily unavailable or block this network.</p><button className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={15} /> Try again</button><a href={`${SANKA_API_ORIGIN}/${kind === 'anime' ? `anime/${source}` : `comic/${source}`}`} target="_blank" rel="noreferrer noopener">Open API docs <ExternalLink size={12} /></a></div>
      ) : items.length ? (
        <div className="sanka-grid">
          {items.map((item) => (
            <article className={`sanka-card ${item.kind === 'comic' ? 'sanka-card-actionable' : ''}`} key={`${item.id}-${item.title}`}>
              <button className="sanka-card-open" type="button" onClick={() => openTitle(item)} disabled={item.kind !== 'comic'} aria-label={item.kind === 'comic' ? `Open ${item.title} chapters` : item.title}>
                <div className="sanka-poster">
                  {item.poster ? <img loading="lazy" src={item.poster} alt={`${item.title} cover`} onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <div className="sanka-poster-fallback"><KindIcon size={27} /><span>No cover</span></div>}
                  <span className="sanka-kind">{kind === 'anime' ? 'ANIME' : 'MANGA'}</span>
                </div>
                <div className="sanka-card-copy">
                  <h3 title={item.title}>{item.title}</h3>
                  <p>{[item.year, item.status].filter(Boolean).join(' · ') || (kind === 'anime' ? 'Anime title' : 'Manga / comic')}</p>
                  {item.genres.length > 0 && <div className="sanka-genres">{item.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</div>}
                  {kind === 'comic' && <span className="sanka-card-cta">Details & chapters <ChevronRight size={13} /></span>}
                </div>
              </button>
              {item.summary && kind === 'anime' && <details className="sanka-anime-summary"><summary>Synopsis</summary><p>{item.summary}</p></details>}
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state sanka-state"><span><BookOpen size={26} /></span><h2>No titles found</h2><p>{submittedQuery ? 'Try another title or clear your search to browse the latest updates.' : 'The API returned no titles for this section right now.'}</p></div>
      )}
      <p className="sanka-attribution">Metadata and chapter pages are provided by <a href="https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic" target="_blank" rel="noreferrer noopener">Sanka API</a>. Availability and rights depend on the upstream source.</p>

      {selected && (
        <div className="sanka-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !readerImages) closeDetails(); }}>
          <section className="sanka-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sanka-detail-title">
            <button className="modal-close floating" onClick={closeDetails} aria-label="Close manga details"><X size={18} /></button>
            <div className="sanka-detail-header">
              {detail?.poster || selected.poster ? <img src={detail?.poster || selected.poster} alt="" /> : <div className="sanka-detail-cover"><BookOpen size={26} /></div>}
              <div>
                <span className="page-kicker">{SANKA_COMIC_SOURCES.find((item) => item.id === selected.source)?.label || selected.source} · MANGA</span>
                <h2 id="sanka-detail-title">{detail?.title || selected.title}</h2>
                {(detail?.status || selected.status) && <p>{detail?.status || selected.status}</p>}
              </div>
            </div>
            <div className="sanka-detail-body">
              {detailLoading && <p className="sanka-inline-status"><LoaderCircle size={16} className="spin" /> Loading manga details…</p>}
              {detailError && <p className="sanka-inline-error" role="alert">{detailError}</p>}
              {(detail?.summary || selected.summary) && <p className="sanka-detail-summary">{detail?.summary || selected.summary}</p>}
              {detail?.genres && detail.genres.length > 0 && <div className="sanka-genres">{detail.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>}
              <div className="sanka-chapter-heading"><h3>Chapters</h3><span>{chapters.length}</span></div>
              {!detailLoading && !detailError && chapters.length === 0 && <p className="sanka-muted">No chapter list was provided by this source.</p>}
              <div className="sanka-chapter-list">
                {chapters.map((chapter, index) => <button key={chapter.id} onClick={() => void openChapter(chapter.slug, index)}>{chapter.title}<ChevronRight size={14} /></button>)}
              </div>
            </div>
          </section>

          {readerImages && selectedChapter && (
            <div className="sanka-reader-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReaderImages(null); }}>
              <section className="sanka-reader" role="dialog" aria-modal="true" aria-labelledby="sanka-reader-title">
                <header className="sanka-reader-header">
                  <button className="icon-button" onClick={() => setReaderImages(null)} aria-label="Back to chapters"><ChevronLeft size={17} /></button>
                  <div><small>{selected.title}</small><h2 id="sanka-reader-title">{selectedChapter.title}</h2></div>
                  <button className="modal-close" onClick={closeDetails} aria-label="Close reader"><X size={17} /></button>
                </header>
                <div className="sanka-reader-pages">
                  {readerImages.map((url, index) => <img key={`${url}-${index}`} loading={index < 2 ? 'eager' : 'lazy'} src={url} alt={`Page ${index + 1}`} />)}
                </div>
                <footer className="sanka-reader-footer">
                  <button className="button button-secondary" disabled={readerChapterIndex <= 0} onClick={() => void openChapter(chapters[readerChapterIndex - 1].slug, readerChapterIndex - 1)}><ChevronLeft size={15} /> Previous</button>
                  <span>Page images from Sanka API</span>
                  <button className="button button-primary" disabled={readerChapterIndex >= chapters.length - 1} onClick={() => void openChapter(chapters[readerChapterIndex + 1].slug, readerChapterIndex + 1)}>Next <ChevronRight size={15} /></button>
                </footer>
              </section>
            </div>
          )}
          {readerLoading && <div className="sanka-reader-loading" role="status"><LoaderCircle size={22} className="spin" /><span>Loading chapter pages…</span></div>}
          {readerError && !readerLoading && <div className="sanka-reader-error" role="alert"><p>{readerError}</p><button onClick={() => setReaderError('')}>Close</button></div>}
        </div>
      )}
    </div>
  );
};

export default SankaExplorer;
