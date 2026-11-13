import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown, BookOpen, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink,
  FileDown, Flame, LoaderCircle, Play, RotateCcw, Search, Sparkles, X,
} from 'lucide-react';
import { buildImageCandidates, openSafeExternalUrl } from '../services/androidBridge';
import { ARCHIVE_COLLECTIONS, BooksService, type BookFile } from '../services/archiveService';
import ArchiveReader from './ArchiveReader';
import {
  clearSankaCache, fetchSankaChapterImages, fetchSankaMangaDetail, fetchSankaTitlesPage,
  resolveArtworkFallback, SANKA_API_ORIGIN, SANKA_COMIC_SOURCES,
  type ComicFeed, type SankaChapter, type SankaMangaDetail, type SankaTitle,
} from '../services/sankaService';

const SafeComicImg: React.FC<{
  src?: string;
  title?: string;
  alt: string;
  eager?: boolean;
  fallback: React.ReactNode;
}> = ({ src, title, alt, eager = false, fallback }) => {
  const initialCandidates = useMemo(() => buildImageCandidates(src), [src]);
  const [candidates, setCandidates] = useState<string[]>(initialCandidates);
  const [index, setIndex] = useState(0);
  const [lookupDone, setLookupDone] = useState(false);

  useEffect(() => {
    setCandidates(initialCandidates);
    setIndex(0);
    setLookupDone(false);
  }, [initialCandidates, title]);

  const needFallbackLookup = index >= candidates.length && !lookupDone && Boolean(title);

  useEffect(() => {
    if (!needFallbackLookup || !title) return;
    let alive = true;
    resolveArtworkFallback(title, 'comic')
      .then((resolved) => {
        if (!alive) return;
        setLookupDone(true);
        if (resolved) {
          const next = buildImageCandidates(resolved);
          if (next.length > 0) {
            setCandidates(next);
            setIndex(0);
          }
        }
      })
      .catch(() => {
        if (alive) setLookupDone(true);
      });
    return () => {
      alive = false;
    };
  }, [needFallbackLookup, title]);

  const currentSrc = candidates[index];
  if (!currentSrc) return <>{fallback}</>;

  return (
    <img
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      src={currentSrc}
      alt={alt}
      onError={() => setIndex((prev) => prev + 1)}
    />
  );
};

const ReaderPageImg: React.FC<{ src: string; pageNumber: number }> = ({ src, pageNumber }) => {
  const [retryTick, setRetryTick] = useState(0);
  const candidates = useMemo(() => buildImageCandidates(src), [src]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [candidates, retryTick]);

  const currentSrc = candidates[index];

  if (!currentSrc) {
    return (
      <div className="sanka-page-fallback">
        <p>Page {pageNumber} could not be loaded from this CDN.</p>
        <div>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setRetryTick((v) => v + 1)}
          >
            <RotateCcw size={13} /> Retry page
          </button>
          <a className="button button-secondary button-small" href={src} target="_blank" rel="noreferrer noopener">
            Open image <ExternalLink size={12} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <img
      key={`${currentSrc}-${retryTick}`}
      loading={pageNumber <= 3 ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      src={currentSrc}
      alt={`Page ${pageNumber}`}
      onError={() => setIndex((prev) => prev + 1)}
    />
  );
};

function mergeUniqueTitles(existing: SankaTitle[], incoming: SankaTitle[]): { merged: SankaTitle[]; addedCount: number } {
  const seen = new Set(existing.map((item) => `${item.slug.toLocaleLowerCase()}|${item.title.toLocaleLowerCase()}`));
  const merged = [...existing];
  let addedCount = 0;
  for (const item of incoming) {
    const key = `${item.slug.toLocaleLowerCase()}|${item.title.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    addedCount += 1;
  }
  return { merged, addedCount };
}

// Web sources plus the Internet Archive folkscanomy collections.
const COMIC_SOURCE_OPTIONS: Array<{ id: string; label: string }> = [
  ...SANKA_COMIC_SOURCES.map((option) => ({ id: option.id as string, label: option.label })),
  { id: 'archive', label: 'Internet Archive (folkscanomy)' },
];

const SankaExplorer: React.FC = () => {
  // 'archive' routes search + detail to the Internet Archive folkscanomy
  // collections instead of the Sanka web sources.
  const [source, setSource] = useState<string>('bacakomik');
  const isArchiveMode = source === 'archive';
  const [feed, setFeed] = useState<ComicFeed>('latest');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [items, setItems] = useState<SankaTitle[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [manualSource, setManualSource] = useState(false);

  const [selected, setSelected] = useState<SankaTitle | null>(null);
  const [detail, setDetail] = useState<SankaMangaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [chapterQuery, setChapterQuery] = useState('');
  const [reverseChapters, setReverseChapters] = useState(false);

  const [readerImages, setReaderImages] = useState<string[] | null>(null);
  const [readerChapterIndex, setReaderChapterIndex] = useState(0);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState('');
  const readerPagesRef = useRef<HTMLDivElement | null>(null);

  // Internet Archive item overlay (folkscanomy files: pdf/epub/cbz).
  const [archiveItem, setArchiveItem] = useState<SankaTitle | null>(null);
  const [archiveFiles, setArchiveFiles] = useState<BookFile[] | null>(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [readerIdentifier, setReaderIdentifier] = useState<string | null>(null);

  const openArchiveItem = async (item: SankaTitle) => {
    setArchiveItem(item);
    setArchiveFiles(null);
    setArchiveError('');
    setArchiveLoading(true);
    try {
      const files = await BooksService.itemFiles(item.slug);
      setArchiveFiles(files);
      if (!files.length) setArchiveError('No downloadable pdf/epub/cbz files in this item.');
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Could not load the archive.org file list.');
    } finally {
      setArchiveLoading(false);
    }
  };

  const handleSelectTitle = (item: SankaTitle) => {
    if (isArchiveMode || item.id.startsWith('archive:')) {
      void openArchiveItem(item);
      return;
    }
    setSelected(item);
  };

  // Lock the page behind modals: the background content must not scroll
  // under the bottom navigation while a detail/reader overlay is open.
  useEffect(() => {
    const anyModalOpen = Boolean(selected) || Boolean(archiveItem) || Boolean(readerImages);
    document.body.classList.toggle('modal-open', anyModalOpen);
    return () => document.body.classList.remove('modal-open');
  }, [selected, archiveItem, readerImages]);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    setFallbackNotice('');
    setPage(1);
    setHasMore(false);

    const load = async () => {
      const bypassCache = attempt > 0;
      const activeSource = source;

      // Internet Archive folkscanomy branch (comic & manga collections).
      if (activeSource === 'archive') {
        const collection = ARCHIVE_COLLECTIONS.find((c) => c.id === 'folk-comics') || ARCHIVE_COLLECTIONS[0];
        try {
          const found = await BooksService.searchArchive(submittedQuery, collection, 1, 24);
          if (!current) return;
          setItems(found.map((book) => ({
            id: book.id,
            slug: book.identifier || book.id,
            title: book.title,
            poster: book.coverUrl,
            year: book.year,
            summary: book.authors.join(', '),
            genres: [],
            kind: 'comic' as const,
            source: 'archive',
          })));
          setPage(1);
          setHasMore(found.length >= 24);
          if (!found.length) setError(submittedQuery ? 'No archive.org items matched that search.' : '');
        } catch (err) {
          if (!current) return;
          setItems([]);
          setHasMore(false);
          setError(err instanceof Error ? err.message : 'archive.org did not answer.');
        }
        return;
      }

      try {
        const primary = await fetchSankaTitlesPage('comic', {
          query: submittedQuery,
          source: activeSource,
          feed,
          page: 1,
          signal: controller.signal,
          bypassCache,
        });
        if (!current) return;
        if (primary.items.length > 0 || submittedQuery || manualSource) {
          setItems(primary.items);
          setPage(1);
          setHasMore(primary.hasMore);
          return;
        }
      } catch (primaryErr) {
        if (!current || (primaryErr as { name?: string })?.name === 'AbortError') return;
        if (submittedQuery || manualSource) {
          setItems([]);
          setHasMore(false);
          setError(primaryErr instanceof Error ? primaryErr.message : 'Could not load comics from Sanka API.');
          return;
        }
      }

      // Automatic comic source fallback so comics load out of the box even if one mirror is down
      let lastFallbackErr: unknown = null;
      for (const candidate of SANKA_COMIC_SOURCES) {
        if (candidate.id === activeSource) continue;
        try {
          const fallbackPage = await fetchSankaTitlesPage('comic', {
            query: '',
            source: candidate.id,
            feed,
            page: 1,
            signal: controller.signal,
            bypassCache,
          });
          if (!current) return;
          if (fallbackPage.items.length > 0) {
            setSource(candidate.id);
            setItems(fallbackPage.items);
            setPage(1);
            setHasMore(fallbackPage.hasMore);
            setFallbackNotice(`Loaded comics from ${candidate.label}.`);
            return;
          }
        } catch (err) {
          if (!current || (err as { name?: string })?.name === 'AbortError') return;
          lastFallbackErr = err;
        }
      }

      if (!current) return;
      setItems([]);
      setHasMore(false);
      if (lastFallbackErr) {
        setError(lastFallbackErr instanceof Error ? lastFallbackErr.message : 'Could not load comics from Sanka API.');
      }
    };

    void load().finally(() => {
      if (current) setLoading(false);
    });

    return () => {
      current = false;
      controller.abort();
    };
  }, [source, feed, submittedQuery, attempt, manualSource]);

  const handleLoadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      if (source === 'archive') {
        const collection = ARCHIVE_COLLECTIONS.find((c) => c.id === 'folk-comics') || ARCHIVE_COLLECTIONS[0];
        const found = await BooksService.searchArchive(submittedQuery, collection, nextPage, 24);
        const mapped = found.map((book) => ({
          id: book.id,
          slug: book.identifier || book.id,
          title: book.title,
          poster: book.coverUrl,
          year: book.year,
          summary: book.authors.join(', '),
          genres: [],
          kind: 'comic' as const,
          source: 'archive',
        }));
        let added = 0;
        setItems((prev) => {
          const result = mergeUniqueTitles(prev, mapped);
          added = result.addedCount;
          return result.merged;
        });
        setPage(nextPage);
        setHasMore(added > 0 && found.length >= 24);
        return;
      }
      const next = await fetchSankaTitlesPage('comic', {
        query: submittedQuery,
        source,
        feed,
        page: nextPage,
      });
      if (next.items.length === 0) {
        setHasMore(false);
        return;
      }
      let added = 0;
      setItems((prev) => {
        const result = mergeUniqueTitles(prev, next.items);
        added = result.addedCount;
        return result.merged;
      });
      setPage(nextPage);
      setHasMore(added > 0 && next.hasMore);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return;
    }
    // Archive items have no Sanka detail endpoint; they open the file overlay.
    if (selected.id.startsWith('archive:')) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError('');
      return;
    }
    const controller = new AbortController();
    let current = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    setChapterQuery('');
    setReverseChapters(false);

    fetchSankaMangaDetail(selected.source, selected.slug, controller.signal, selected.detailPath)
      .then((result) => { if (current) setDetail(result); })
      .catch((reason: unknown) => {
        if (!current || (reason as { name?: string })?.name === 'AbortError') return;
        setDetailError(reason instanceof Error ? reason.message : 'Could not load manga details.');
      })
      .finally(() => { if (current) setDetailLoading(false); });

    return () => {
      current = false;
      controller.abort();
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (readerImages) {
          setReaderImages(null);
        } else {
          setSelected(null);
          setReaderError('');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, readerImages]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  const openChapter = async (chapter: SankaChapter, chapterIndex: number) => {
    if (!selected) return;
    setReaderChapterIndex(chapterIndex);
    setReaderImages(null);
    setReaderLoading(true);
    setReaderError('');
    try {
      const pages = await fetchSankaChapterImages(selected.source, chapter.slug, undefined, chapter.chapterPath);
      setReaderImages(pages);
      requestAnimationFrame(() => {
        if (readerPagesRef.current) readerPagesRef.current.scrollTop = 0;
      });
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

  const handleRetry = () => {
    clearSankaCache();
    setAttempt((value) => value + 1);
  };

  const chapters = detail?.chapters || [];
  const selectedChapter = chapters[readerChapterIndex];

  const displayedChapters = useMemo(() => {
    const indexed = chapters.map((chapter, index) => ({ chapter, index }));
    const ordered = reverseChapters ? [...indexed].reverse() : indexed;
    const q = chapterQuery.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(({ chapter }) =>
      chapter.title.toLowerCase().includes(q) || chapter.slug.toLowerCase().includes(q),
    );
  }, [chapters, reverseChapters, chapterQuery]);

  const firstReadTarget = useMemo(() => {
    if (!chapters.length) return null;
    if (chapters.length === 1) return { chapter: chapters[0], index: 0 };
    const firstNum = Number(chapters[0].title.match(/(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
    const lastNum = Number(chapters[chapters.length - 1].title.match(/(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
    if (Number.isFinite(firstNum) && Number.isFinite(lastNum) && firstNum > lastNum) {
      return { chapter: chapters[chapters.length - 1], index: chapters.length - 1 };
    }
    return { chapter: chapters[0], index: 0 };
  }, [chapters]);

  const activeSourceLabel = COMIC_SOURCE_OPTIONS.find((item) => item.id === source)?.label || source;

  return (
    <div className="standard-page page-enter sanka-page">
      <div className="page-heading sanka-heading">
        <div>
          <span className="page-kicker"><Sparkles size={14} /> SANKA API · MANGA & COMICS</span>
          <h1>Manga, Manhwa & Comics</h1>
          <p>Read manga, manhwa, manhua, and comics across multiple sources with the built-in chapter reader.</p>
        </div>
        <a className="text-button" href="https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic" target="_blank" rel="noreferrer noopener">
          API project <ExternalLink size={13} />
        </a>
      </div>

      <div className="sanka-toolbar">
        <div className="filter-pills" role="tablist" aria-label="Comic feed">
          <button
            role="tab"
            aria-selected={feed === 'latest'}
            className={feed === 'latest' ? 'active' : ''}
            onClick={() => { setFeed('latest'); setSubmittedQuery(''); setQuery(''); }}
          >
            <BookOpen size={14} /> Latest
          </button>
          <button
            role="tab"
            aria-selected={feed === 'popular'}
            className={feed === 'popular' ? 'active' : ''}
            onClick={() => { setFeed('popular'); setSubmittedQuery(''); setQuery(''); }}
          >
            <Flame size={14} /> Popular
          </button>
        </div>
        <div className="sanka-catalog-controls">
          <label className="source-select">
            <span className="sanka-sr-only">Comic source</span>
            <select
              aria-label="Comic source"
              value={source}
              onChange={(event) => {
                setManualSource(true);
                setSource(event.target.value);
                setSubmittedQuery('');
                setQuery('');
              }}
            >
              {COMIC_SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <form className="sanka-search" onSubmit={search}>
            <Search size={16} />
            <input
              aria-label="Search manga and comics"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search manga and comics…"
            />
            {submittedQuery && (
              <button
                type="button"
                className="search-clear"
                onClick={() => { setQuery(''); setSubmittedQuery(''); }}
                aria-label="Clear comic search"
              >
                ×
              </button>
            )}
            <button className="button button-primary button-small" type="submit" disabled={loading}>Search</button>
          </form>
        </div>
      </div>

      {fallbackNotice && !loading && !error && (
        <p className="sanka-fallback-note" role="status">{fallbackNotice}</p>
      )}

      <div className="sanka-results-heading">
        <div>
          <BookOpen size={17} />
          <h2>
            {submittedQuery
              ? `Results for “${submittedQuery}”`
              : feed === 'popular'
                ? 'Popular manga & comics'
                : 'Latest manga & comics'}
          </h2>
        </div>
        {!loading && !error && (
          <span>{items.length} titles · {activeSourceLabel}</span>
        )}
      </div>

      {loading ? (
        <div className="sanka-state" role="status">
          <LoaderCircle size={23} className="spin" />
          <p>Loading manga and comics…</p>
        </div>
      ) : error ? (
        <div className="empty-state sanka-state sanka-error" role="alert">
          <span><CircleAlert size={25} /></span>
          <h2>Couldn’t reach {activeSourceLabel}</h2>
          <p>{error} Try switching to another comic source or retrying.</p>
          <div className="sanka-source-pills">
            {COMIC_SOURCE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`button button-small ${option.id === source ? 'button-primary' : 'button-secondary'}`}
                onClick={() => {
                  setManualSource(true);
                  setSource(option.id);
                  setAttempt((v) => v + 1);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button className="button button-secondary" onClick={handleRetry}>
            <RotateCcw size={15} /> Try again
          </button>
          <a href={`${SANKA_API_ORIGIN}/comic/${source}`} target="_blank" rel="noreferrer noopener">
            Open API docs <ExternalLink size={12} />
          </a>
        </div>
      ) : items.length ? (
        <>
          <div className="sanka-grid">
            {items.map((item) => {
              const metaLine = [
                item.comicType,
                item.chapter,
                item.year,
                item.status,
                item.rating ? `★ ${item.rating}` : undefined,
              ].filter(Boolean).join(' · ') || 'Manga / comic';

              return (
                <article className="sanka-card sanka-card-actionable" key={`${item.id}-${item.title}`}>
                  <button
                    className="sanka-card-open"
                    type="button"
                    onClick={() => handleSelectTitle(item)}
                    aria-label={`Open ${item.title} chapters`}
                  >
                    <div className="sanka-poster">
                      <SafeComicImg
                        src={item.poster}
                        title={item.title}
                        alt={`${item.title} cover`}
                        fallback={<div className="sanka-poster-fallback"><BookOpen size={27} /><span>{item.title.slice(0, 18)}</span></div>}
                      />
                      <span className="sanka-kind">{item.comicType ? item.comicType.toUpperCase() : 'MANGA'}</span>
                    </div>
                    <div className="sanka-card-copy">
                      <h3 title={item.title}>{item.title}</h3>
                      <p>{metaLine}</p>
                      {item.genres.length > 0 && (
                        <div className="sanka-genres">
                          {item.genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
                        </div>
                      )}
                      <span className="sanka-card-cta">Read chapters <ChevronRight size={13} /></span>
                    </div>
                  </button>
                </article>
              );
            })}
          </div>

          <div className="sanka-load-more-row">
            {hasMore ? (
              <button
                type="button"
                className="button button-secondary sanka-load-more-btn"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <LoaderCircle size={16} className="spin" /> Loading more…
                  </>
                ) : (
                  <>
                    <ChevronDown size={16} /> Load more
                  </>
                )}
              </button>
            ) : page > 1 ? (
              <span className="sanka-end-note">Showing all {items.length} loaded titles</span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="empty-state sanka-state">
          <span><BookOpen size={26} /></span>
          <h2>No comics found</h2>
          <p>{submittedQuery ? 'Try another title or switch comic sources above.' : 'This source returned no comics right now. Try selecting another source above.'}</p>
        </div>
      )}

      <p className="sanka-attribution">
        Metadata and chapter pages are provided by{' '}
        <a href="https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic" target="_blank" rel="noreferrer noopener">Sanka API</a>.
        {' '}Availability and rights depend on the upstream source.
      </p>

      {selected && (
        <div
          className="sanka-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !readerImages) closeDetails(); }}
        >
          <section className="sanka-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sanka-detail-title">
            <button className="modal-close floating" onClick={closeDetails} aria-label="Close manga details">
              <X size={18} />
            </button>
            <div className="sanka-detail-header">
              <SafeComicImg
                src={detail?.poster || selected.poster}
                title={detail?.title || selected.title}
                alt=""
                eager
                fallback={<div className="sanka-detail-cover"><BookOpen size={26} /></div>}
              />
              <div className="sanka-detail-meta">
                <span className="page-kicker">
                  {SANKA_COMIC_SOURCES.find((item) => item.id === selected.source)?.label || selected.source}
                  {' · '}
                  {(detail?.comicType || selected.comicType || 'MANGA').toUpperCase()}
                </span>
                <h2 id="sanka-detail-title">{detail?.title || selected.title}</h2>
                <p>
                  {[
                    detail?.status || selected.status,
                    detail?.author ? `By ${detail.author}` : undefined,
                    (detail?.rating || selected.rating) ? `★ ${detail?.rating || selected.rating}` : undefined,
                  ].filter(Boolean).join(' · ')}
                </p>
                {firstReadTarget && (
                  <div className="sanka-detail-actions">
                    <button
                      type="button"
                      className="button button-primary button-small"
                      onClick={() => void openChapter(firstReadTarget.chapter, firstReadTarget.index)}
                    >
                      <Play size={13} /> Start {firstReadTarget.chapter.title}
                    </button>
                    {chapters.length > 1 && firstReadTarget.index !== 0 && (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => void openChapter(chapters[0], 0)}
                      >
                        Latest ({chapters[0].title})
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="sanka-detail-body">
              {detailLoading && (
                <p className="sanka-inline-status"><LoaderCircle size={16} className="spin" /> Loading manga details…</p>
              )}
              {detailError && <p className="sanka-inline-error" role="alert">{detailError}</p>}
              {(detail?.summary || selected.summary) && (
                <p className="sanka-detail-summary">{detail?.summary || selected.summary}</p>
              )}
              {(detail?.genres?.length ? detail.genres : selected.genres).length > 0 && (
                <div className="sanka-genres">
                  {(detail?.genres?.length ? detail.genres : selected.genres).map((genre) => (
                    <span key={genre}>{genre}</span>
                  ))}
                </div>
              )}

              <div className="sanka-chapter-heading">
                <h3>Chapters <span>({chapters.length})</span></h3>
                {chapters.length > 1 && (
                  <div className="sanka-chapter-tools">
                    {chapters.length > 8 && (
                      <input
                        type="search"
                        value={chapterQuery}
                        onChange={(e) => setChapterQuery(e.target.value)}
                        placeholder="Filter chapter…"
                        aria-label="Filter chapters"
                      />
                    )}
                    <button
                      type="button"
                      className="sanka-sort-btn"
                      onClick={() => setReverseChapters((rev) => !rev)}
                      aria-label="Toggle chapter order"
                    >
                      <ArrowUpDown size={12} /> {reverseChapters ? 'Reversed' : 'Default order'}
                    </button>
                  </div>
                )}
              </div>

              {!detailLoading && !detailError && chapters.length === 0 && (
                <p className="sanka-muted">No chapter list was provided by this source.</p>
              )}

              <div className="sanka-chapter-list">
                {displayedChapters.map(({ chapter, index }) => (
                  <button key={chapter.id} onClick={() => void openChapter(chapter, index)}>
                    <span>
                      <strong>{chapter.title}</strong>
                      {chapter.date && <small>{chapter.date}</small>}
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          </section>

          {readerImages && selectedChapter && (
            <div
              className="sanka-reader-backdrop"
              role="presentation"
              onMouseDown={(event) => { if (event.target === event.currentTarget) setReaderImages(null); }}
            >
              <section className="sanka-reader" role="dialog" aria-modal="true" aria-labelledby="sanka-reader-title">
                <header className="sanka-reader-header">
                  <button className="icon-button" onClick={() => setReaderImages(null)} aria-label="Back to chapters">
                    <ChevronLeft size={17} />
                  </button>
                  <div>
                    <small>{detail?.title || selected.title}</small>
                    <h2 id="sanka-reader-title">{selectedChapter.title}</h2>
                  </div>
                  <span className="sanka-page-count">{readerImages.length} pages</span>
                  <button className="modal-close" onClick={closeDetails} aria-label="Close reader">
                    <X size={17} />
                  </button>
                </header>
                <div className="sanka-reader-pages" ref={readerPagesRef}>
                  {readerImages.map((url, index) => (
                    <ReaderPageImg key={`${url}-${index}`} src={url} pageNumber={index + 1} />
                  ))}
                </div>
                <footer className="sanka-reader-footer">
                  <button
                    className="button button-secondary"
                    disabled={readerChapterIndex <= 0}
                    onClick={() => void openChapter(chapters[readerChapterIndex - 1], readerChapterIndex - 1)}
                  >
                    <ChevronLeft size={15} /> Previous
                  </button>
                  <span>{selectedChapter.title} · {readerImages.length} pages</span>
                  <button
                    className="button button-primary"
                    disabled={readerChapterIndex >= chapters.length - 1}
                    onClick={() => void openChapter(chapters[readerChapterIndex + 1], readerChapterIndex + 1)}
                  >
                    Next <ChevronRight size={15} />
                  </button>
                </footer>
              </section>
            </div>
          )}

          {readerLoading && (
            <div className="sanka-reader-loading" role="status">
              <LoaderCircle size={22} className="spin" />
              <span>Loading chapter pages…</span>
            </div>
          )}
          {readerError && !readerLoading && (
            <div className="sanka-reader-error" role="alert">
              <p>{readerError}</p>
              <button onClick={() => setReaderError('')}>Close</button>
            </div>
          )}
        </div>
      )}

      {/* Internet Archive (folkscanomy) item overlay */}
      {archiveItem && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setArchiveItem(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(1, 4, 9, 0.82)', zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px' }}
        >
          <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: '14px', maxWidth: '520px', width: '100%', padding: '18px', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
              <strong style={{ color: '#f0f6fc', fontSize: '16px' }}>{archiveItem.title}</strong>
              <button onClick={() => setArchiveItem(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            {archiveItem.summary && <p style={{ color: '#8b949e', fontSize: '13px', margin: '0 0 10px' }}>{archiveItem.summary}</p>}
            {archiveLoading && (
              <p style={{ color: '#8b949e', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <LoaderCircle size={14} className="spin" /> Loading files…
              </p>
            )}
            {archiveError && <p style={{ color: '#f87171', fontSize: '13px' }}>{archiveError}</p>}
            {archiveFiles && archiveFiles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '12px 0' }}>
                {archiveFiles.map((file) => (
                  <button
                    key={file.name}
                    onClick={() => openSafeExternalUrl(file.url)}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 12px', borderRadius: '10px', border: '1px solid #30363d', background: '#161b22', color: '#f0f6fc', fontSize: '13px', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <FileDown size={16} color="#d6f77a" />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                    <span style={{ color: '#8b949e', fontSize: '11.5px' }}>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setReaderIdentifier(archiveItem.slug)}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', border: 'none', background: '#d6f77a', color: '#1a1d13', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer' }}
              >
                <BookOpen size={13} /> Read online
              </button>
              <button
                onClick={() => openSafeExternalUrl(BooksService.detailsUrl(archiveItem.slug))}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}
              >
                <ExternalLink size={12} /> archive.org page
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app Read Online (OMLE) — archive.org BookReader embed */}
      {readerIdentifier && (
        <ArchiveReader
          identifier={readerIdentifier}
          title={archiveItem?.title}
          onClose={() => setReaderIdentifier(null)}
        />
      )}
    </div>
  );
};

export default SankaExplorer;
