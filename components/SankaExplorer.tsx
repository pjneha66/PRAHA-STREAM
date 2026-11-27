import ReadingSourceDirectory from './ReadingSourceDirectory';
import type { NsfwMode } from '../types';
import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink,
  FileDown, Flame, LoaderCircle, Play, RotateCcw, Search, X,
} from 'lucide-react';
import { buildImageCandidates, isAndroidApp, openArchiveLoan, openSafeExternalUrl } from '../services/androidBridge';
import SkeletonGrid from './SkeletonGrid';
import ContinueShelf from './ContinueShelf';
import { readContinue, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';
import { ARCHIVE_COLLECTIONS, BooksService, canReadBookFile, type BookFile } from '../services/archiveService';
import { COMICK_SOURCE_OPTIONS as COMICK_ACTIVE_SOURCE_OPTIONS } from '../services/comickService';
import { resolveComickPoster } from '../services/sankaService';
import ArchiveReader from './ArchiveReader';
import ChapterOrder, { compareChapters, useChapterOrder } from './ChapterOrder';
import ReadingSaveButton from './ReadingSaveButton';
import type { ReadingLibraryProps } from '../services/readingLibrary';
import HoldToSaveButton from './HoldToSaveButton';
import ArchiveBorrowButton from './ArchiveBorrowButton';
import { COMIC_LANGUAGES, type ComicLanguage, type ComicLanguageFilter } from '../services/comicLanguages';
import { COMIC_BOOK_SITES, comicBookSiteUrl, isComicBookSite, loadComicBookSite, openComicBookSite, readPublicationIssue } from '../services/comicBookSites';
import ReaderZoomControls, { useReaderZoom } from './ReaderZoomControls';
import { comicEditionKey, groupComicTitles } from '../services/comicGroups';
import { isKotatsuComicSource, KOTATSU_COMIC_SOURCES } from '../services/kotatsuComicService';
import {
  clearSankaCache, fetchSankaChapterImages, fetchSankaMangaDetail, fetchSankaTitlesPage,
  resolveArtworkFallback, SANKA_API_ORIGIN, SANKA_COMIC_SOURCES,
  type ComicFeed, type SankaChapter, type SankaMangaDetail, type SankaTitle, type SankaTitlesPage,
} from '../services/sankaService';

const SafeComicImg: React.FC<{
  src?: string;
  title?: string;
  alt: string;
  eager?: boolean;
  fallback: React.ReactNode;
  /** Last-resort poster resolver (e.g. Comick og:image from the series page). */
  posterFallback?: () => Promise<string | undefined>;
}> = ({ src, title, alt, eager = false, fallback, posterFallback }) => {
  const initialCandidates = useMemo(() => buildImageCandidates(src), [src]);
  const [candidates, setCandidates] = useState<string[]>(initialCandidates);
  const [index, setIndex] = useState(0);
  const [lookupDone, setLookupDone] = useState(false);
  const posterFallbackRef = useRef(posterFallback);
  posterFallbackRef.current = posterFallback;

  useEffect(() => {
    setCandidates(initialCandidates);
    setIndex(0);
    setLookupDone(false);
  }, [initialCandidates, title]);

  const needFallbackLookup = index >= candidates.length && !lookupDone && Boolean(title);

  useEffect(() => {
    if (!needFallbackLookup || !title) return;
    let alive = true;
    (async () => {
      let resolved: string | null | undefined = null;
      try {
        resolved = await resolveArtworkFallback(title, 'comic');
      } catch {
        // Artwork lookup failed — try the page-based poster resolver next.
      }
      if (!resolved && posterFallbackRef.current) {
        try {
          resolved = await posterFallbackRef.current();
        } catch {
          // Poster resolver failed too — give up on the placeholder.
        }
      }
      if (!alive) return;
      setLookupDone(true);
      if (resolved) {
        const next = buildImageCandidates(resolved);
        if (next.length > 0) {
          setCandidates(next);
          setIndex(0);
        }
      }
    })();
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
  const seen = new Set(existing.map((item) => `${item.source}:${item.slug}`));
  const merged = [...existing];
  let addedCount = 0;
  for (const item of incoming) {
    const key = `${item.source}:${item.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    addedCount += 1;
  }
  return { merged, addedCount };
}

// Web sources plus the Comick aggregator gateway, WEBTOON (locked to the
// webtoon aggregator), and the Internet Archive folkscanomy collections.
const COMIC_SOURCE_OPTIONS = [
  { id: 'all', label: 'All Sources' },
  { id: 'mangadex', label: 'MangaDex' },
  { id: 'peppercarrot', label: 'Pepper&Carrot' },
  { id: 'twokinds', label: 'Twokinds (Kotatsu)' },
  { id: 'weebcentral', label: 'Weeb Central' },
  ...KOTATSU_COMIC_SOURCES,
  ...SANKA_COMIC_SOURCES.map((option) => ({ id: option.id as string, label: option.label })),
  { id: 'comick', label: 'Comick (aggregator search)' },
  { id: 'webtoon', label: 'WEBTOON' },
  { id: 'archive', label: 'Internet Archive (folkscanomy)' },
  { id: 'vintage', label: 'Vintage Western Comics' },
  { id: 'international', label: 'International Comic Scans' },
  ...Object.entries(COMIC_BOOK_SITES).map(([id, site]) => ({ id, label: site.label })),
];

// Compact labels for the source rail chips (full labels stay in tooltips).
const COMIC_SOURCE_SHORT: Record<string, string> = {
  weebcentral: 'Weeb Central',
  archive: 'Archive.org',
  comick: 'Comick',
  webtoon: 'WEBTOON',
};

// Comick's all-provider search already includes WEBTOON.
const ARCHIVE_COMIC_SOURCES = {
  archive: ARCHIVE_COLLECTIONS.find((item) => item.id === 'folk-comics')!.query,
  vintage: 'collection:comics AND year:[1930 TO 1956] AND imagecount:[8 TO *] AND (language:eng OR language:English) AND -access-restricted-item:true',
  international: 'collection:comics AND imagecount:[8 TO *] AND (language:fre OR language:spa OR language:por OR language:ita OR language:ger) AND -access-restricted-item:true',
};
const ARCHIVE_LANGUAGES: Partial<Record<ComicLanguage, string>> = {
  en: 'eng OR language:English', fr: 'fre', es: 'spa', pt: 'por', it: 'ita', de: 'ger',
};
const isArchiveSource = (source: string): source is keyof typeof ARCHIVE_COMIC_SOURCES => Object.hasOwn(ARCHIVE_COMIC_SOURCES, source);

function languageName(code: string): string {
  return COMIC_LANGUAGES[code as ComicLanguage] || code;
}

function LanguageSelect({ language, onChange, label, showAll = true }: {
  language: ComicLanguageFilter;
  onChange: (language: ComicLanguageFilter) => void;
  label: string;
  showAll?: boolean;
}) {
  return (
    <select aria-label={label} className="settings-select" value={language} onChange={(event) => onChange(event.target.value as ComicLanguageFilter)}>
      {showAll && <option value="all">All languages</option>}
      {Object.entries(COMIC_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
    </select>
  );
}

const ALL_COMIC_SOURCES = COMIC_SOURCE_OPTIONS.map(({ id }) => id).filter((id) => id !== 'all' && id !== 'webtoon' && !isComicBookSite(id));

function sourceLabel(id: string): string {
  return COMIC_SOURCE_SHORT[id] || COMIC_SOURCE_OPTIONS.find((option) => option.id === id)?.label || id;
}

async function loadComicPage(
  source: string, query: string, feed: ComicFeed, page: number, signal: AbortSignal,
  language: ComicLanguageFilter, bypassCache = false, onTitles?: (items: SankaTitle[]) => void,
): Promise<SankaTitlesPage> {
  if (isComicBookSite(source)) return loadComicBookSite(source, query, language, page);
  if (!isArchiveSource(source)) {
    const knownLanguage = source === 'weebcentral' || source === 'twokinds' || isKotatsuComicSource(source) ? 'en'
      : SANKA_COMIC_SOURCES.some((option) => option.id === source) ? 'id' : undefined;
    if (language !== 'all' && source !== 'mangadex' && source !== 'peppercarrot' && language !== knownLanguage) {
      return { page, items: [], hasMore: false };
    }
    return fetchSankaTitlesPage('comic', { source, query, feed, page, signal, language, bypassCache, onTitles });
  }
  const archiveLanguage = language === 'all' ? undefined : ARCHIVE_LANGUAGES[language];
  if (language !== 'all' && !archiveLanguage) return { page, items: [], hasMore: false };
  const collection = {
    id: source, name: sourceLabel(source),
    query: ARCHIVE_COMIC_SOURCES[source] + (archiveLanguage ? ` AND (language:${archiveLanguage})` : ''),
  };
  const found = await BooksService.searchArchive(query, collection, page, 24);
  return {
    page,
    hasMore: found.length >= 24,
    items: found.map((book) => ({
      id: book.id,
      slug: book.identifier || book.id,
      title: book.title,
      poster: book.coverUrl,
      year: book.year,
      summary: book.authors.join(', '),
      status: book.restricted ? '🔒 Borrow on archive.org' : undefined,
      genres: [],
      kind: 'comic',
      source,
    })),
  };
}

async function loadAllComicSources(
  pages: [source: string, page: number][], query: string, feed: ComicFeed, signal: AbortSignal,
  language: ComicLanguageFilter, bypassCache: boolean, onTitles: (items: SankaTitle[]) => void,
  onNextPage: (source: string, nextPage: number) => void,
) {
  let cursor = 0;
  let failures = 0;
  const worker = async () => {
    while (!signal.aborted && cursor < pages.length) {
      const [source, page] = pages[cursor++];
      try {
        const result = await loadComicPage(source, query, feed, page, signal, language, bypassCache, onTitles);
        if (signal.aborted) return;
        onTitles(result.items);
        if (result.hasMore) onNextPage(source, page + 1);
      } catch {
        failures += 1;
      }
    }
  };
  // Keep bridge capacity for chapter opens while catalogs and pagination overlap.
  const limit = pages[0]?.[1] === 1 ? 4 : 1;
  const workers = isAndroidApp() ? Math.min(limit, pages.length) : pages.length;
  await Promise.all(Array.from({ length: workers }, worker));
  return failures;
}

const SankaExplorer: React.FC<ReadingLibraryProps & { prefillQuery?: string; adultMode?: NsfwMode; onAdultMode?: (mode: NsfwMode) => void }> = ({ prefillQuery, adultMode, onAdultMode, ...readingLibrary }) => {
  // 'archive' routes search + detail to the Internet Archive folkscanomy
  // collections instead of the Sanka web sources.
  const [source, setSource] = useState<string>('bacakomik');
  const [language, setLanguage] = useState<ComicLanguageFilter>('all');
  const [readerLanguage, setReaderLanguage] = useState<ComicLanguageFilter>('all');
  const [feed, setFeed] = useState<ComicFeed>('latest');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [items, setItems] = useState<SankaTitle[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchingSources, setSearchingSources] = useState(false);
  const browseRequest = useRef<AbortController | null>(null);
  const nextSourcePages = useRef(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fallbackNotice, setFallbackNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [manualSource, setManualSource] = useState(false);
  /** Comick: restrict the aggregator search to one source ('all' = all 46). */
  const [comickSubSource, setComickSubSource] = useState('all');

  const [selected, setSelected] = useState<SankaTitle | null>(null);
  const [editions, setEditions] = useState<SankaTitle[]>([]);
  const [failedEdition, setFailedEdition] = useState<{ term: string; key: string }>();
  const groups = useMemo(() => {
    if (source !== 'all') return items.map((item) => [item]);
    const choices = failedEdition?.term === submittedQuery
      ? items.filter((item) => comicEditionKey(item) !== failedEdition.key)
      : items;
    return groupComicTitles(choices);
  }, [items, source, failedEdition, submittedQuery]);
  const [detail, setDetail] = useState<SankaMangaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  const [chapterQuery, setChapterQuery] = useState('');
  const [chapterOrder, setChapterOrder] = useChapterOrder();

  const [readerImages, setReaderImages] = useState<string[] | null>(null);
  const [readerChapterIndex, setReaderChapterIndex] = useState(0);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState('');
  const readerPagesRef = useRef<HTMLDivElement | null>(null);
  const { zoom: readerZoom, changeZoom: changeReaderZoom } = useReaderZoom(readerPagesRef);
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
    if (readerMode === 'paged' && readerPagesRef.current) readerPagesRef.current.scrollTop = 0;
    else document.getElementById(`sanka-page-${clamped - 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
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
  const archiveRequest = useRef(0);

  const openArchiveItem = async (item: SankaTitle) => {
    const request = ++archiveRequest.current;
    setArchiveItem(item);
    setArchiveFiles(null);
    setArchiveError('');
    if (item.status?.includes('Borrow')) {
      setArchiveLoading(false);
      return;
    }
    setArchiveLoading(true);
    try {
      const files = await BooksService.itemFiles(item.slug);
      if (request !== archiveRequest.current) return;
      setArchiveFiles(files);
      if (!files.length) setArchiveError('No downloadable pdf/epub/cbz files in this item.');
    } catch (err) {
      if (request === archiveRequest.current) setArchiveError(err instanceof Error ? err.message : 'Could not load the archive.org file list.');
    } finally {
      if (request === archiveRequest.current) setArchiveLoading(false);
    }
  };

  const [bookSiteError, setBookSiteError] = useState('');
  const browseBookSite = async (url: string) => {
    setBookSiteError('');
    if (!await openComicBookSite(url)) setBookSiteError('Could not open the comic site.');
  };

  const [publicationLoading, setPublicationLoading] = useState(false);
  const [publicationError, setPublicationError] = useState('');
  const publicationRequest = useRef(0);

  const openPublication = async (item: SankaTitle) => {
    if (!isComicBookSite(item.source) || !item.sourceUrl) return;
    const request = ++publicationRequest.current;
    setPublicationError('');
    setPublicationLoading(true);
    try {
      const opened = await readPublicationIssue(item.source, item.sourceUrl, () => request === publicationRequest.current);
      if (!opened && request === publicationRequest.current) setPublicationError('Could not open the reader.');
    } catch (reason) {
      if (request === publicationRequest.current) setPublicationError(reason instanceof Error ? reason.message : 'Could not read this issue.');
    } finally {
      if (request === publicationRequest.current) setPublicationLoading(false);
    }
  };

  const handleSelectTitle = (item: SankaTitle, variants = [item], readNow = true) => {
    publicationRequest.current += 1;
    setPublicationError('');
    setBookSiteError('');
    setPublicationLoading(false);
    chapterAbortRef.current?.abort();
    setReaderLoading(false);
    setReaderImages(null);
    setReaderError('');
    setDetail(null);
    setEditions(variants);
    if (isArchiveSource(item.source)) {
      setSelected(null);
      void openArchiveItem(item);
      return;
    }
    setArchiveItem(null);
    setReaderLanguage(item.source === 'peppercarrot' && language === 'all' ? 'en' : language);
    setSelected(item);
    if (readNow && isComicBookSite(item.source)) void openPublication(item);
  };

  const target = readingLibrary.openReading;
  const appliedTarget = useRef<typeof target>(null);
  useEffect(() => {
    if (target?.kind !== 'sanka' || target === appliedTarget.current) return;
    appliedTarget.current = target;
    handleSelectTitle(target.item, [target.item], false);
  }, [target, handleSelectTitle]);

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
    browseRequest.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setSearchingSources(false);
    setError('');
    setFallbackNotice('');
    setPage(1);
    setHasMore(false);
    nextSourcePages.current.clear();

    const load = async () => {
      const bypassCache = attempt > 0;
      const activeSource = source;

      if (activeSource === 'all') {
        setItems([]);
        setSearchingSources(true);
        const sources = submittedQuery && language === 'all'
          ? [...ALL_COMIC_SOURCES, 'oceanofpdf']
          : ALL_COMIC_SOURCES;
        const failures = await loadAllComicSources(
          sources.map((id) => [id, 1]), submittedQuery, feed, controller.signal, language, bypassCache,
          (titles) => {
            if (!current || !titles.length) return;
            setItems((previous) => mergeUniqueTitles(previous, titles).merged);
            setLoading(false);
          },
          (id, nextPage) => {
            nextSourcePages.current.set(id, nextPage);
            setHasMore(true);
          },
        );
        if (!current) return;
        setSearchingSources(false);
        if (failures === sources.length) setError('The comic sources did not respond.');
        else if (failures) setFallbackNotice('Some comic sources did not respond.');
        return;
      }

      if (isArchiveSource(activeSource) || isComicBookSite(activeSource) || isKotatsuComicSource(activeSource) ||
        ['mangadex', 'peppercarrot', 'twokinds'].includes(activeSource) || language !== 'all') {
        try {
          const result = await loadComicPage(activeSource, submittedQuery, feed, 1, controller.signal, language, bypassCache);
          if (!current) return;
          setItems(result.items);
          setHasMore(result.hasMore);
        } catch (reason) {
          if (!current) return;
          setItems([]);
          setError(reason instanceof Error ? reason.message : 'Could not load comics.');
        }
        return;
      }

      let primaryError = '';
      // Comick sweeps many aggregators — show each source's results as they
      // arrive instead of a full-page spinner.
      let progressiveStarted = false;
      const onTitles = source === 'comick' || source === 'webtoon'
        ? (titles: SankaTitle[]) => {
            if (!current || !titles.length) return;
            if (!progressiveStarted) {
              progressiveStarted = true;
              setLoading(false);
            }
            setItems((prev) => mergeUniqueTitles(prev, titles).merged);
          }
        : undefined;
      if (onTitles) setItems([]);
      try {
        const primary = await fetchSankaTitlesPage('comic', {
          query: submittedQuery,
          source: activeSource,
          feed,
          page: 1,
          signal: controller.signal,
          bypassCache,
          subSource: source === 'comick' ? comickSubSource : undefined,
          onTitles,
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
        primaryError = primaryErr instanceof Error ? primaryErr.message : 'Could not load comics from Sanka API.';
        setItems([]);
        setHasMore(false);
        // A manually picked source that died must not dead-end — fall through
        // to the automatic fallback below (it skips the failed source).
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
      } else if (primaryError) {
        setError(primaryError);
      }
    };

    void load().finally(() => {
      if (current) setLoading(false);
    });

    return () => {
      current = false;
      controller.abort();
    };
  }, [source, feed, submittedQuery, attempt, manualSource, comickSubSource, language, adultMode]);

  const handleLoadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const signal = browseRequest.current?.signal;
    if (!signal || signal.aborted) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    const append = (titles: SankaTitle[]) => {
      if (!signal.aborted) setItems((previous) => mergeUniqueTitles(previous, titles).merged);
    };
    try {
      if (source === 'all') {
        const ready = [...nextSourcePages.current];
        nextSourcePages.current.clear();
        await loadAllComicSources(
          ready, submittedQuery, feed, signal, language, false, append,
          (id, sourcePage) => nextSourcePages.current.set(id, sourcePage),
        );
        if (signal.aborted) return;
        setHasMore(nextSourcePages.current.size > 0);
      } else {
        const next = await loadComicPage(source, submittedQuery, feed, nextPage, signal, language);
        if (signal.aborted) return;
        append(next.items);
        setHasMore(next.items.length > 0 && next.hasMore);
      }
      setPage(nextPage);
    } catch {
      if (!signal.aborted) setHasMore(false);
    } finally {
      if (!signal.aborted) setLoadingMore(false);
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
    if (selected.id.startsWith('archive:') || isComicBookSite(selected.source)) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError('');
      return;
    }
    const controller = new AbortController();
    detailRequest.current = controller;
    let current = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    setChapterQuery('');
    setChapterWindow(150);
    chapterAbortRef.current?.abort();

    fetchSankaMangaDetail(selected.source, selected.slug, controller.signal, selected.detailPath, readerLanguage)
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
  }, [selected, readerLanguage]);

  const loadOlderChapters = async () => {
    const signal = detailRequest.current?.signal;
    if (!selected || !detail?.nextChapterPage || detailLoading || !signal || signal.aborted) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const older = await fetchSankaMangaDetail(selected.source, selected.slug, signal, selected.detailPath, readerLanguage, detail.nextChapterPage);
      if (!signal.aborted) {
        const chapters = [...new Map([...detail.chapters, ...older.chapters].map((chapter) => [chapter.id, chapter])).values()];
        setDetail({ ...detail, chapters, nextChapterPage: older.nextChapterPage });
      }
    } catch {
      if (!signal.aborted) setDetailError('Could not load older chapters. Try again.');
    } finally {
      if (!signal.aborted) setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (readerImages) {
          setReaderImages(null);
        } else {
          closeDetails();
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
      const pages = await fetchSankaChapterImages(selected.source, chapter.slug, controller.signal, chapter.chapterPath, readerLanguage);
      if (controller.signal.aborted) return;
      if (!pages.length) throw new Error('This chapter has no readable pages.');
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
          language: readerLanguage,
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
    publicationRequest.current += 1;
    setPublicationLoading(false);
    chapterAbortRef.current?.abort();
    setReaderLoading(false);
    setSelected(null);
    setReaderImages(null);
    setReaderError('');
    setContinueEntries(readContinue('comic'));
  };

  const findAnotherSource = () => {
    if (!selected) return;
    const title = selected.title.trim();
    const suffix = title.match(/^(.*?)\s+\(([^()]+)\)$/);
    const term = suffix && suffix[2].toLowerCase().startsWith(suffix[1].toLowerCase()) ? suffix[2] : title;
    setFailedEdition({ term, key: comicEditionKey(selected) });
    closeDetails();
    setSource('all');
    setManualSource(true);
    setQuery(term);
    setSubmittedQuery(term);
    if (source === 'all' && term === submittedQuery) setAttempt((value) => value + 1);
  };

  const comicFromContinue = (entry: ContinueEntry) => {
    const payload = (entry.payload || {}) as { language?: ComicLanguageFilter; source?: string; detailPath?: string; poster?: string; kind?: SankaTitle['kind'] };
    if (!payload.source) return;
    const item: SankaTitle = {
      id: entry.id,
      slug: entry.id,
      title: entry.title,
      poster: payload.poster,
      kind: payload.kind || 'comic',
      genres: [],
      source: payload.source,
      detailPath: payload.detailPath,
    };
    return { item, language: payload.language };
  };

  const resumeComic = (entry: ContinueEntry) => {
    const result = comicFromContinue(entry);
    if (!result) return;
    setEditions([]);
    setReaderLanguage(result.language && result.language !== 'all' ? result.language : result.item.source === 'peppercarrot' ? 'en' : 'all');
    setSelected(result.item);
  };

  const handleRetry = () => {
    clearSankaCache();
    setAttempt((value) => value + 1);
  };

  const chapters = useMemo(() => [...(detail?.chapters || [])].sort((a, b) => compareChapters(a.title, b.title)), [detail]);
  const selectedChapter = chapters[readerChapterIndex];
  const [chapterWindow, setChapterWindow] = useState(150);

  const displayedChapters = useMemo(() => {
    const indexed = chapters.map((chapter, index) => ({ chapter, index }));
    const ordered = chapterOrder === 'asc' ? indexed : [...indexed].reverse();
    const q = chapterQuery.trim().toLowerCase();
    return ordered.filter(({ chapter }) => chapter.title.toLowerCase().includes(q) || chapter.slug.toLowerCase().includes(q));
  }, [chapters, chapterOrder, chapterQuery]);

  const firstReadTarget = chapters.length ? { chapter: chapters[0], index: 0 } : null;

  const visibleEdition = selected || archiveItem;
  const visibleEditionKey = visibleEdition && comicEditionKey(visibleEdition);
  const currentGroup = visibleEditionKey && groups.find((group) => group.some((item) => comicEditionKey(item) === visibleEditionKey));
  const availableEditions = currentGroup && currentGroup.length >= editions.length ? currentGroup : editions;
  const alternateEditions = availableEditions.filter((item) => comicEditionKey(item) !== visibleEditionKey);
  const sourceSwitcher = alternateEditions.length > 0 && (
    <div className="sanka-detail-actions" id="comic-editions">
      {alternateEditions.map((item) => (
        <button type="button" className="button button-secondary button-small" key={comicEditionKey(item)} onClick={() => handleSelectTitle(item, availableEditions)}>
          Switch to {item.source === 'comick' ? item.comicType || 'Comick' : sourceLabel(item.source)}
        </button>
      ))}
    </div>
  );

  const selectedBookSite = isComicBookSite(source) ? source : null;
  const activeSourceLabel = COMIC_SOURCE_OPTIONS.find((item) => item.id === source)?.label || source;
  const selectKotatsuSource = (id: string) => {
    setManualSource(true);
    setLanguage('en');
    setQuery('');
    setSubmittedQuery('');
    setSource(id);
  };

  return (
    <div className="standard-page page-enter sanka-page reading-page">
      <h1 className="reading-heading">Comics</h1>
      <form className="sanka-search reading-search" onSubmit={search}>
        <Search size={16} />
        <input
          aria-label="Search manga and comics"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search comics"
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
        <button className="button button-primary button-small" type="submit" disabled={loading && source !== 'all'}>Search</button>
      </form>

      <div className="sanka-toolbar reading-controls">
        <select className="reading-select" aria-label="Comic source" value={source} onChange={(event) => {
          const id = event.target.value;
          setManualSource(true);
          if (isKotatsuComicSource(id) && language !== 'all') setLanguage('en');
          setSource(id);
        }}>
          {COMIC_SOURCE_OPTIONS.filter(({ id }) => !isKotatsuComicSource(id)).map(({ id, label }) => (
            <option key={id} value={id}>{COMIC_SOURCE_SHORT[id] || label}</option>
          ))}
          <optgroup label="Kotatsu Redo">
            {KOTATSU_COMIC_SOURCES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </optgroup>
        </select>
        <LanguageSelect language={language} onChange={setLanguage} label="Comic language" />
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
        {source === 'comick' && (
          <label className="source-select">
            <span className="sanka-sr-only">Comick aggregator</span>
            <select
              aria-label="Comick aggregator"
              value={comickSubSource}
              onChange={(event) => setComickSubSource(event.target.value)}
            >
              <option value="all">All sources ({COMICK_ACTIVE_SOURCE_OPTIONS.length})</option>
              {COMICK_ACTIVE_SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ContinueShelf
        entries={continueEntries}
        onResume={resumeComic}
        onSave={(entry) => {
          const result = comicFromContinue(entry);
          if (result) readingLibrary.onSaveReading?.({ kind: 'sanka', item: result.item });
        }}
        onDismiss={(entry) => {
          removeContinue('comic', entry.id);
          setContinueEntries(readContinue('comic'));
        }}
      />

      <ReadingSourceDirectory repository="kotatsu" adultMode={adultMode} onAdultMode={onAdultMode} collapseListings
        readerLabels={Object.fromEntries(KOTATSU_COMIC_SOURCES.map(({ name, label }) => [name, label]))} readers={{
        Twokinds: () => selectKotatsuSource('twokinds'),
        'Weeb Central': () => selectKotatsuSource('weebcentral'),
        ...Object.fromEntries(KOTATSU_COMIC_SOURCES.map(({ id, name }) => [name, () => selectKotatsuSource(id)])),
      }} />
      {selectedBookSite && (
        <button className="button button-secondary button-small" onClick={() => void browseBookSite(comicBookSiteUrl(selectedBookSite, query.trim(), language))}>
          <ExternalLink size={14} /> Browse {COMIC_BOOK_SITES[selectedBookSite].label}
        </button>
      )}
      {bookSiteError && <p role="alert">{bookSiteError}</p>}

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
          <span>{groups.length} titles · {searchingSources ? 'Checking more sources…' : activeSourceLabel}</span>
        )}
      </div>

      {loading ? (
        <SkeletonGrid count={12} label="Loading manga and comics…" />
      ) : error ? (
        <div className="empty-state sanka-state sanka-error" role="alert">
          <span><CircleAlert size={25} /></span>
          <h2>{selectedBookSite ? 'Open the site’s catalog' : `Couldn’t reach ${activeSourceLabel}`}</h2>
          <p>{error}{!selectedBookSite && ' Try switching to another comic source or retrying.'}</p>
          <button className="button button-secondary" onClick={handleRetry}>
            <RotateCcw size={15} /> Try again
          </button>
          {SANKA_COMIC_SOURCES.some((option) => option.id === source) && (
            <a href={`${SANKA_API_ORIGIN}/comic/${source}`} target="_blank" rel="noreferrer noopener">
              Open API docs <ExternalLink size={12} />
            </a>
          )}
        </div>
      ) : items.length ? (
        <>
          <div className="comic-grid">
            {groups.map(([item, ...alternates], index) => {
              const metaLine = [
                alternates.length ? `${alternates.length + 1} editions` : source === 'all' ? sourceLabel(item.source) : undefined,
                item.comicType,
                item.year,
                item.status,
                item.rating ? `★ ${item.rating}` : undefined,
              ].filter(Boolean).join(' · ') || sourceLabel(item.source);
              const kind = item.comicType || (isComicBookSite(item.source) || isArchiveSource(item.source) ? 'Comic' : 'Manga');

              const readingEntry = readingSlugs.has(item.slug)
                ? continueEntries.find((entry) => entry.id === item.slug)
                : undefined;

              return (
                <article className={`comic-card ${readingEntry ? 'comic-card-reading' : ''}`} key={`${item.id}-${item.title}`}>
                  <HoldToSaveButton
                    className="comic-card-open"
                    type="button"
                    onSave={() => readingLibrary.onSaveReading?.({ kind: 'sanka', item })}
                    onClick={() => handleSelectTitle(item, [item, ...alternates])}
                    aria-label={`Open ${item.title}${isComicBookSite(item.source) ? '' : ' chapters'}`}
                  >
                    <div className="comic-poster">
                      <SafeComicImg
                        src={item.poster}
                        eager={index < 2}
                        title={item.title}
                        alt={`${item.title} cover`}
                        posterFallback={
                          item.source === 'comick' && item.sourceUrl
                            ? () => resolveComickPoster(item.sourceUrl!)
                            : undefined
                        }
                        fallback={<div className="comic-poster-fallback"><BookOpen size={26} /></div>}
                      />
                      <span className="comic-kind">{kind.toUpperCase()}</span>
                      {item.chapter && <span className="comic-chapter-badge">{item.chapter}</span>}
                      {readingEntry && <span className="comic-resume"><Play size={10} /> Resume</span>}
                    </div>
                    <div className="comic-copy">
                      <h3 title={item.title}>{item.title}</h3>
                      <p>{metaLine}</p>
                    </div>
                  </HoldToSaveButton>
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
            ) : page > 1 && !searchingSources ? (
              <span className="sanka-end-note">Showing all {items.length} loaded titles</span>
            ) : null}
          </div>
        </>
      ) : (
        <div className="empty-state sanka-state">
          <span><BookOpen size={26} /></span>
          <h2>No comics found</h2>
          <p>{source === 'comick' && !submittedQuery
            ? 'Comick swept every aggregator and nothing matched right now — try a specific title above.'
            : submittedQuery
              ? 'Try another title or switch comic sources above.'
              : 'This source returned no comics right now. Try selecting another source above.'}</p>
        </div>
      )}

      <p className="sanka-attribution">
        Chapter availability varies by source.
      </p>

      {selected && !selected.id.startsWith('archive:') && (
        <div
          className="sanka-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !readerImages) closeDetails(); }}
        >
          <section className="sanka-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sanka-detail-title">
            <button className="modal-close floating" onClick={closeDetails} aria-label="Close comic details" data-android-back>
              <X size={18} />
            </button>
            {isComicBookSite(selected.source) ? <div className="publication-issue">
              <h2 id="sanka-detail-title">{selected.title}</h2>
              <div className="comic-archive-actions">
                <ReadingSaveButton {...readingLibrary} entry={{ kind: 'sanka', item: selected }} />
                <button type="button" className="button button-primary button-small" disabled={publicationLoading} onClick={() => void openPublication(selected)}>
                  {publicationLoading ? <LoaderCircle size={16} className="spin" /> : <BookOpen size={16} />} {publicationLoading ? 'Finding reader file…' : 'Read issue'}
                </button>
                {selected.sourceUrl && <button type="button" className="button button-secondary button-small" onClick={() => void browseBookSite(selected.sourceUrl!)}>
                  <ExternalLink size={16} /> Open listing
                </button>}
                <button type="button" className="button button-secondary button-small" onClick={findAnotherSource}>
                  <Search size={16} /> Find another source
                </button>
              </div>
              {publicationError && <p className="sanka-inline-error" role="alert">{publicationError}</p>}
              {bookSiteError && <p className="sanka-inline-error" role="alert">{bookSiteError}</p>}
            </div> : <>
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
                  {sourceLabel(selected.source)}
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
                {selected.source === 'peppercarrot' && (
                  <p>
                    <a href="https://www.peppercarrot.com/en/webcomics/peppercarrot.html" target="_blank" rel="noreferrer">Pepper&amp;Carrot by David Revoy</a>
                    {' · '}
                    <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
                  </p>
                )}
                {firstReadTarget && (
                  <div className="sanka-detail-actions">
                    <button
                      type="button"
                      className="button button-primary button-small"
                      onClick={() => void openChapter(firstReadTarget.chapter, firstReadTarget.index)}
                    >
                      <Play size={13} /> Start {firstReadTarget.chapter.title}
                    </button>
                    {chapters.length > 1 && (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => void openChapter(chapters[chapters.length - 1], chapters.length - 1)}
                      >
                        Latest ({chapters[chapters.length - 1].title})
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

              {sourceSwitcher}
              <ReadingSaveButton {...readingLibrary} entry={{ kind: 'sanka', item: selected }} />
              <div className="sanka-chapter-heading">
                <h3>Chapters <span>({chapters.length})</span></h3>
                {(selected.source === 'mangadex' || selected.source === 'peppercarrot') && (
                  <LanguageSelect language={readerLanguage} onChange={setReaderLanguage} label="Chapter language" showAll={selected.source !== 'peppercarrot'} />
                )}
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
                    <ChapterOrder value={chapterOrder} onChange={(order) => { setChapterOrder(order); setChapterWindow(150); }} />
                  </div>
                )}
              </div>

              {!detailLoading && !detailError && chapters.length === 0 && (
                <p className="sanka-muted">No chapter list was provided by this source.</p>
              )}

              {readerError && !readerLoading && (
                <div className="chapter-load-error" role="alert">
                  <p>{readerError}</p>
                  <div>
                    {selectedChapter && <button type="button" className="button button-secondary button-small" onClick={() => void openChapter(selectedChapter, readerChapterIndex)}>Retry chapter</button>}
                    <button type="button" className="button button-secondary button-small" onClick={findAnotherSource}>Find another source</button>
                  </div>
                </div>
              )}
              <div className="sanka-chapter-list">
                {/* Long-running series expose 1,000–4,000+ chapters; mounting
                    every row (~4 nodes each) blocks the WebView main thread on
                    every detail open. Render a window with an expander. */}
                {displayedChapters.slice(0, chapterWindow).map(({ chapter, index }) => (
                  <button key={chapter.id} onClick={() => void openChapter(chapter, index)}>
                    <span>
                      <strong>{chapter.title}</strong>
                      {chapter.language && <small>{languageName(chapter.language)}</small>}
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
                {detail?.nextChapterPage && (
                  <button className="sanka-chapter-more" disabled={detailLoading} onClick={() => void loadOlderChapters()}>
                    {detailLoading ? 'Loading older chapters…' : 'Load older chapters'}
                  </button>
                )}
              </div>
            </div>
            </>}
          </section>

          {readerImages && selectedChapter && (
            <div
              className="sanka-reader-backdrop"
              role="presentation"
              onMouseDown={(event) => { if (event.target === event.currentTarget) setReaderImages(null); }}
            >
              <section className="sanka-reader" role="dialog" aria-modal="true" aria-labelledby="sanka-reader-title">
                <header className="sanka-reader-header">
                  <button className="icon-button" onClick={() => setReaderImages(null)} aria-label="Back to chapters" data-android-back>
                    <ChevronLeft size={17} />
                  </button>
                  <div>
                    <small>{detail?.title || selected.title}</small>
                    <h2 id="sanka-reader-title">{selectedChapter.title}</h2>
                  </div>
                  {alternateEditions.length > 0 && (
                    <button type="button" className="button button-secondary button-small" onClick={() => {
                      setReaderImages(null);
                      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#comic-editions button')?.focus());
                    }}>Sources</button>
                  )}
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
                  className="sanka-reader-pages"
                  style={{ '--reader-zoom': readerZoom } as React.CSSProperties}
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
                <div className="sanka-page-scrubber" onClick={(e) => e.stopPropagation()}>
                  <ReaderZoomControls zoom={readerZoom} onChange={changeReaderZoom} />
                  {(readerImages.length > 4 || (readerMode === 'paged' && readerImages.length > 1)) && <>
                    <button onClick={() => jumpToPage(scrubberPage - 1)} disabled={scrubberPage <= 1} aria-label="Previous page">
                      <ChevronLeft size={15} />
                    </button>
                    <span className="sanka-scrubber-label">{scrubberPage} / {readerImages.length}</span>
                    <button onClick={() => jumpToPage(scrubberPage + 1)} disabled={scrubberPage >= readerImages.length} aria-label="Next page">
                      <ChevronRight size={15} />
                    </button>
                  </>}
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
        </div>
      )}

      {/* Internet Archive (folkscanomy) item overlay */}
      {archiveItem && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => event.target === event.currentTarget && setArchiveItem(null)}
        >
          <section className="comic-archive-sheet" role="dialog" aria-modal="true" aria-label={archiveItem.title}>
            <button className="modal-close floating" onClick={() => setArchiveItem(null)} aria-label="Close comic details" data-android-back>
              <X size={18} />
            </button>
            <span className="page-kicker">INTERNET ARCHIVE · {sourceLabel(archiveItem.source)}</span>
            <h2>{archiveItem.title}</h2>
            {sourceSwitcher}
            <ReadingSaveButton {...readingLibrary} entry={{ kind: 'sanka', item: archiveItem }} />
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
                    onClick={() => canReadBookFile(file) ? void browseBookSite(file.url) : void openSafeExternalUrl(file.url)}
                  >
                    <FileDown size={16} />
                    <span>{file.name}</span>
                    <small>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="comic-archive-actions">
              {archiveItem.status?.includes('Borrow') ? (
                <ArchiveBorrowButton key={archiveItem.slug} identifier={archiveItem.slug} />
              ) : (
                <button type="button" className="button button-primary" onClick={() => setReaderIdentifier(archiveItem.slug)}>
                  <BookOpen size={14} /> Read online
                </button>
              )}
              <button type="button" className="button button-secondary" onClick={() => openArchiveLoan(BooksService.detailsUrl(archiveItem.slug))}>
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
