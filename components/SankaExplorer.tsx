import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown, BookOpen, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink,
  FileDown, Flame, LoaderCircle, Play, RotateCcw, Search, Sparkles, X,
} from 'lucide-react';
import { buildImageCandidates, openSafeExternalUrl } from '../services/androidBridge';
import SkeletonGrid from './SkeletonGrid';
import ContinueShelf from './ContinueShelf';
import { readContinue, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';
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

// Web sources plus the Comick aggregator gateway and the Internet Archive
// folkscanomy collections.
const COMIC_SOURCE_OPTIONS: Array<{ id: string; label: string }> = [
  ...SANKA_COMIC_SOURCES.map((option) => ({ id: option.id as string, label: option.label })),
  { id: 'comick', label: 'Comick (aggregator search)' },
  { id: 'archive', label: 'Internet Archive (folkscanomy)' },
];

// Compact labels for the source rail chips (full labels stay in tooltips).
const COMIC_SOURCE_SHORT: Record<string, string> = {
  weebcentral: 'WeebCentral',
  archive: 'Archive.org',
  comick: 'Comick',
};

const SankaExplorer: React.FC<{ prefillQuery?: string }> = ({ prefillQuery }) => {
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
  const chapterAbortRef = useRef<AbortController | null>(null);
  const [scrubberPage, setScrubberPage] = useState(1);
  // Reader mode (port of PlayTorrio's manga reader): webtoon long-strip vs
  // paged single-page. Persisted.
  const [readerMode, setReaderMode] = useState<'webtoon' | 'paged'>(() => {
    try {
      const stored = localStorage.getItem('praha.comic.readerMode');
      return stored === 'paged' ? 'paged' : 'webtoon';
    } catch {
      return 'webtoon';
    }
  });
  const switchReaderMode = (mode: 'webtoon' | 'paged') => {
    setReaderMode(mode);
    try { localStorage.setItem('praha.comic.readerMode', mode); } catch { /* best effort */ }
  };

  const jumpToPage = (page: number) => {
    if (!readerImages) return;
    const clamped = Math.min(Math.max(1, page), readerImages.length);
    setScrubberPage(clamped);
    document.getElementById(`sanka-page-${clamped - 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Track the page under the viewport top so the scrubber label follows scrolling.
  const onReaderScroll = () => {
    const container = readerPagesRef.current;
    if (!container || !readerImages) return;
    let current = 1;
    for (let i = 0; i < readerImages.length; i += 1) {
      const anchor = document.getElementById(`sanka-page-${i}`);
      if (anchor && anchor.offsetTop - container.offsetTop <= container.scrollTop + 80) current = i + 1;
      else break;
    }
    setScrubberPage(current);
  };
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>(() => readContinue('comic'));
  const readingSlugs = useMemo(() => new Set(continueEntries.map((entry) => entry.id)), [continueEntries]);

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
            status: book.restricted ? '🔒 Borrow on archive.org' : undefined,
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
          status: book.restricted ? '🔒 Borrow on archive.org' : undefined,
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
    setChapterWindow(150);
    chapterAbortRef.current?.abort();

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

  // Universal-search deep link: a query issued in Discover lands here pre-filled.
  const appliedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const term = (prefillQuery || '').trim();
    if (!term || appliedPrefillRef.current === term) return;
    appliedPrefillRef.current = term;
    setQuery(term);
    setSubmittedQuery(term);
  }, [prefillQuery]);

  const openChapter = async (chapter: SankaChapter, chapterIndex: number) => {
    if (!selected) return;
    // Cancel the previous chapter fetch: rapid Next/Prev clicks must not stack
    // concurrent requests (native pool backlog) or let a slower stale response
    // overwrite the newer chapter's pages.
    chapterAbortRef.current?.abort();
    const controller = new AbortController();
    chapterAbortRef.current = controller;
    setReaderChapterIndex(chapterIndex);
    setReaderImages(null);
    setScrubberPage(1);
    setReaderLoading(true);
    setReaderError('');
    try {
      const pages = await fetchSankaChapterImages(selected.source, chapter.slug, controller.signal, chapter.chapterPath);
      if (controller.signal.aborted) return;
      setReaderImages(pages);
      recordContinue({
        domain: 'comic',
        id: selected.slug,
        title: selected.title,
        cover: selected.poster,
        detail: chapter.title,
        payload: {
          source: selected.source,
          detailPath: selected.detailPath,
          poster: selected.poster,
          kind: selected.kind,
          chapterIndex,
        },
      });
      requestAnimationFrame(() => {
        if (readerPagesRef.current) readerPagesRef.current.scrollTop = 0;
      });
    } catch (reason) {
      if ((reason as { name?: string })?.name === 'AbortError' || controller.signal.aborted) return;
      setReaderError(reason instanceof Error ? reason.message : 'Could not load chapter pages.');
    } finally {
      if (chapterAbortRef.current === controller) {
        setReaderLoading(false);
      }
    }
  };

  const closeDetails = () => {
    setSelected(null);
    setReaderImages(null);
    setReaderError('');
    setContinueEntries(readContinue('comic'));
  };

  const resumeComic = (entry: ContinueEntry) => {
    const payload = (entry.payload || {}) as { source?: string; detailPath?: string; poster?: string; kind?: SankaTitle['kind'] };
    if (!payload.source) return;
    setSelected({
      id: entry.id,
      slug: entry.id,
      title: entry.title,
      poster: payload.poster,
      kind: payload.kind || 'comic',
      genres: [],
      source: payload.source,
      detailPath: payload.detailPath,
    });
  };

  const handleRetry = () => {
    clearSankaCache();
    setAttempt((value) => value + 1);
  };

  const chapters = detail?.chapters || [];
  const selectedChapter = chapters[readerChapterIndex];
  const [chapterWindow, setChapterWindow] = useState(150);

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
      <div className="comic-hero">
        <span className="comic-hero-tile" aria-hidden="true"><BookOpen size={22} /></span>
        <div>
          <span className="page-kicker"><Sparkles size={12} /> MANGA · MANHWA · COMICS</span>
          <h1>Comics</h1>
          <p>Read manga, manhwa, and comics from 9 sources with the built-in chapter reader.</p>
        </div>
      </div>
      <ContinueShelf
        entries={continueEntries}
        onResume={resumeComic}
        onDismiss={(entry) => {
          removeContinue('comic', entry.id);
          setContinueEntries(readContinue('comic'));
        }}
      />

      <div className="comic-source-rail" role="tablist" aria-label="Comic source">
        {COMIC_SOURCE_OPTIONS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={source === option.id}
            className={`comic-source-chip ${source === option.id ? 'active' : ''}`}
            title={option.label}
            onClick={() => {
              if (option.id === source) return;
              setManualSource(true);
              setSource(option.id);
              setSubmittedQuery('');
              setQuery('');
            }}
          >
            {COMIC_SOURCE_SHORT[option.id] || option.label}
          </button>
        ))}
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
        <SkeletonGrid count={12} label="Loading manga and comics…" />
      ) : error ? (
        <div className="empty-state sanka-state sanka-error" role="alert">
          <span><CircleAlert size={25} /></span>
          <h2>Couldn’t reach {activeSourceLabel}</h2>
          <p>{error} Try switching to another comic source or retrying.</p>
          <div className="comic-source-rail comic-source-rail-center">
            {COMIC_SOURCE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`comic-source-chip ${option.id === source ? 'active' : ''}`}
                title={option.label}
                onClick={() => {
                  setManualSource(true);
                  setSource(option.id);
                  setAttempt((v) => v + 1);
                }}
              >
                {COMIC_SOURCE_SHORT[option.id] || option.label}
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
          <div className="comic-grid">
            {items.map((item) => {
              const metaLine = [
                item.comicType,
                item.year,
                item.status,
                item.rating ? `★ ${item.rating}` : undefined,
              ].filter(Boolean).join(' · ') || 'Manga / comic';

              const readingEntry = readingSlugs.has(item.slug)
                ? continueEntries.find((entry) => entry.id === item.slug)
                : undefined;

              return (
                <article className={`comic-card ${readingEntry ? 'comic-card-reading' : ''}`} key={`${item.id}-${item.title}`}>
                  <button
                    className="comic-card-open"
                    type="button"
                    onClick={() => handleSelectTitle(item)}
                    aria-label={`Open ${item.title} chapters`}
                  >
                    <div className="comic-poster">
                      <SafeComicImg
                        src={item.poster}
                        title={item.title}
                        alt={`${item.title} cover`}
                        fallback={<div className="comic-poster-fallback"><BookOpen size={26} /></div>}
                      />
                      <span className="comic-kind">{item.comicType ? item.comicType.toUpperCase() : 'MANGA'}</span>
                      {item.chapter && <span className="comic-chapter-badge">{item.chapter}</span>}
                      {readingEntry && <span className="comic-resume"><Play size={10} /> Resume</span>}
                    </div>
                    <div className="comic-copy">
                      <h3 title={item.title}>{item.title}</h3>
                      <p>{metaLine}</p>
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
          <p>{source === 'comick' && !submittedQuery
            ? 'Comick is search-driven — type a title above to search every aggregator at once.'
            : submittedQuery
              ? 'Try another title or switch comic sources above.'
              : 'This source returned no comics right now. Try selecting another source above.'}</p>
        </div>
      )}

      <p className="sanka-attribution">
        Metadata and chapter pages are provided by{' '}
        <a href="https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic" target="_blank" rel="noreferrer noopener">Sanka API</a>.
        {' '}Availability and rights depend on the upstream source.
      </p>

      {selected && !selected.id.startsWith('archive:') && (
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
                {/* Long-running series expose 1,000–4,000+ chapters; mounting
                    every row (~4 nodes each) blocks the WebView main thread on
                    every detail open. Render a window with an expander. */}
                {displayedChapters.slice(0, chapterWindow).map(({ chapter, index }) => (
                  <button key={chapter.id} onClick={() => void openChapter(chapter, index)}>
                    <span>
                      <strong>{chapter.title}</strong>
                      {chapter.date && <small>{chapter.date}</small>}
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
                {displayedChapters.length > chapterWindow && (
                  <button
                    className="sanka-chapter-more"
                    onClick={() => setChapterWindow((value) => value + 400)}
                  >
                    Show more chapters ({(displayedChapters.length - chapterWindow).toLocaleString()} remaining)
                  </button>
                )}
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
                  <button
                    className="button button-secondary button-small"
                    onClick={() => switchReaderMode(readerMode === 'webtoon' ? 'paged' : 'webtoon')}
                    title="Toggle reader mode"
                  >
                    {readerMode === 'webtoon' ? 'Webtoon' : 'Paged'}
                  </button>
                  <button className="modal-close" onClick={closeDetails} aria-label="Close reader">
                    <X size={17} />
                  </button>
                </header>
                <div
                  className={`sanka-reader-pages ${readerMode === 'paged' ? 'sanka-reader-paged' : ''}`}
                  ref={readerPagesRef}
                  onScroll={readerMode === 'webtoon' ? onReaderScroll : undefined}
                >
                  {readerMode === 'paged'
                    ? readerImages[scrubberPage - 1] && (
                      <div className="sanka-page-anchor">
                        <ReaderPageImg src={readerImages[scrubberPage - 1]} pageNumber={scrubberPage} />
                      </div>
                    )
                    : readerImages.map((url, index) => (
                      <div key={`${url}-${index}`} id={`sanka-page-${index}`} className="sanka-page-anchor">
                        <ReaderPageImg src={url} pageNumber={index + 1} />
                      </div>
                    ))}
                </div>
                {readerImages.length > 4 && (
                  <div className="sanka-page-scrubber" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => jumpToPage(scrubberPage - 1)} disabled={scrubberPage <= 1} aria-label="Previous page">
                      <ChevronLeft size={15} />
                    </button>
                    <span className="sanka-scrubber-label">{scrubberPage} / {readerImages.length}</span>
                    <button onClick={() => jumpToPage(scrubberPage + 1)} disabled={scrubberPage >= readerImages.length} aria-label="Next page">
                      <ChevronRight size={15} />
                    </button>
                  </div>
                )}
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
        >
          <section className="comic-archive-sheet" role="dialog" aria-modal="true" aria-label={archiveItem.title}>
            <button className="modal-close floating" onClick={() => setArchiveItem(null)} aria-label="Close">
              <X size={18} />
            </button>
            <span className="page-kicker">INTERNET ARCHIVE · FOLKSCANOMY</span>
            <h2>{archiveItem.title}</h2>
            {archiveItem.summary && <p className="comic-archive-summary">{archiveItem.summary}</p>}
            {archiveLoading && (
              <p className="sanka-inline-status"><LoaderCircle size={16} className="spin" /> Loading files…</p>
            )}
            {archiveError && <p className="sanka-inline-error" role="alert">{archiveError}</p>}
            {archiveFiles && archiveFiles.length > 0 && (
              <div className="comic-archive-files">
                {archiveFiles.map((file) => (
                  <button
                    key={file.name}
                    className="comic-archive-file"
                    onClick={() => openSafeExternalUrl(file.url)}
                  >
                    <FileDown size={16} />
                    <span>{file.name}</span>
                    <small>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="comic-archive-actions">
              <button type="button" className="button button-primary" onClick={() => setReaderIdentifier(archiveItem.slug)}>
                <BookOpen size={14} /> Read online
              </button>
              <button type="button" className="button button-secondary" onClick={() => openSafeExternalUrl(BooksService.detailsUrl(archiveItem.slug))}>
                <ExternalLink size={13} /> archive.org page
              </button>
            </div>
          </section>
        </div>
      )}

      {/* In-app Read Online — native archive.org leaf reader */}
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
