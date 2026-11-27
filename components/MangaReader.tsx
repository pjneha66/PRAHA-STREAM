import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, BookOpen, ChevronLeft, ChevronRight, ImageOff, LoaderCircle, Rows3, SkipForward,
} from 'lucide-react';
import { buildFallbackImageUrl } from '../services/androidBridge';
import ReaderZoomControls, { useReaderZoom } from './ReaderZoomControls';
import './manga-reader.css';

/**
 * Manga chapter reader — port of VyseTV's `screens/manga/manga_reader_page.dart`.
 *
 * Two modes, the same two the Dart page has:
 *   - `webtoon`: one long vertical strip, every page stacked, read by scrolling.
 *   - `paged`:   one page at a time, flipped horizontally by swipe, arrow buttons
 *                or the Left / Right keys.
 *
 * Kept from the original: the remembered page per chapter, the mode that
 * survives a restart, the glass bar over the pages, and prefetching the next
 * couple of pages so a flip never waits. Dropped: the D-pad / TV fit cycling
 * (PRAHA has no D-pad focus model), and `ResizeImage` decoding (the browser
 * sizes images itself).
 */

export type MangaReaderMode = 'webtoon' | 'paged';

export interface MangaReaderProps {
  chapterId: string;
  chapterTitle: string;
  chapterNumber?: string;
  /** Ordered image URLs. */
  images: string[];
  onClose: () => void;
  onNextChapter?: () => void;
  onPrevChapter?: () => void;
  hasNextChapter?: boolean;
  status?: string;
}

const MODE_KEY = 'praha.manga.reader-mode.v1';
const POSITIONS_KEY = 'praha.manga.pos.v1';
/** Reading position entries kept before the oldest are dropped. */
const MAX_STORED_CHAPTERS = 300;
/** Pages fetched ahead of the one on screen. */
const PRELOAD_AHEAD = 2;
/** How far a horizontal swipe must travel to flip a page. */
const SWIPE_THRESHOLD_PX = 48;

// ───────────────────────── persisted state ─────────────────────────

function readMode(): MangaReaderMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'paged' ? 'paged' : 'webtoon';
  } catch {
    return 'webtoon';
  }
}

function writeMode(mode: MangaReaderMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private mode / storage full: the reader still works for this session.
  }
}

function readPositions(): Record<string, number> {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [chapterId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        out[chapterId] = Math.trunc(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readPosition(chapterId: string): number {
  return readPositions()[chapterId] ?? 0;
}

function writePosition(chapterId: string, page: number): void {
  try {
    const positions = readPositions();
    delete positions[chapterId];
    positions[chapterId] = Math.max(0, Math.trunc(page));
    const ids = Object.keys(positions);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_STORED_CHAPTERS))) {
      delete positions[stale];
    }
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Storage unavailable: progress just will not survive a reload.
  }
}

// ───────────────────────── one page ─────────────────────────

const MangaPage: React.FC<{
  url: string;
  index: number;
  total: number;
  eager: boolean;
  onBroken: (index: number) => void;
}> = ({ url, index, total, eager, onBroken }) => {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState(url);
  const fallbackTried = useRef(false);

  // A new URL (next chapter, changed page list) starts clean.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setSource(url);
    fallbackTried.current = false;
  }, [url]);

  const handleError = useCallback(() => {
    if (!fallbackTried.current) {
      // Hotlink-protected CDNs answer with a 403 for the direct URL; the
      // project's relay candidates usually still work.
      const fallback = buildFallbackImageUrl(source);
      if (fallback) {
        fallbackTried.current = true;
        setSource(fallback);
        return;
      }
    }
    setFailed(true);
    onBroken(index);
  }, [index, onBroken, source]);

  if (failed) {
    return (
      <div className="mr-broken" role="img" aria-label={`Page ${index + 1} unavailable`}>
        <ImageOff size={26} aria-hidden="true" />
        <span>Page {index + 1} could not be loaded</span>
      </div>
    );
  }

  return (
    <div className="mr-page">
      {!loaded ? (
        <div className="mr-placeholder" aria-hidden="true">
          <span className="mr-placeholder-number">{index + 1}</span>
          <LoaderCircle size={18} className="mr-spin" />
          <span className="mr-placeholder-total">of {total}</span>
        </div>
      ) : null}
      <img
        className={`mr-img${loaded ? ' is-loaded' : ''}`}
        src={source}
        alt={`Page ${index + 1}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={handleError}
        draggable={false}
      />
    </div>
  );
};

// ───────────────────────── reader ─────────────────────────

export const MangaReader: React.FC<MangaReaderProps> = ({
  chapterId,
  chapterTitle,
  chapterNumber,
  images,
  onClose,
  onNextChapter,
  onPrevChapter,
  hasNextChapter = false,
  status,
}) => {
  const total = images.length;
  const [mode, setMode] = useState<MangaReaderMode>(readMode);
  const [page, setPage] = useState<number>(() => readPosition(chapterId));
  const [broken, setBroken] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [barVisible, setBarVisible] = useState(true);

  const stripRef = useRef<HTMLDivElement | null>(null);
  const { zoom, changeZoom, bindViewport } = useReaderZoom(stripRef);
  const restorePending = useRef(true);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const clampPage = useCallback(
    (value: number) => Math.min(Math.max(0, Math.trunc(value)), Math.max(0, total - 1)),
    [total],
  );

  // Opening a chapter (or getting its pages) restores the saved page.
  useEffect(() => {
    setPage(clampPage(readPosition(chapterId)));
    setBroken(new Set<number>());
    restorePending.current = true;
  }, [chapterId, clampPage]);

  // Clamp when the page list changes under us (a shorter chapter, a reload).
  useEffect(() => {
    setPage((current) => clampPage(current));
  }, [clampPage]);

  // Remember the page as it changes.
  useEffect(() => {
    if (total > 0) writePosition(chapterId, clampPage(page));
  }, [chapterId, clampPage, page, total]);

  // Prefetch the next pages so a flip or a scroll never waits on the network.
  useEffect(() => {
    if (typeof Image === 'undefined') return;
    for (let offset = 1; offset <= PRELOAD_AHEAD; offset += 1) {
      const url = images[page + offset];
      if (!url) continue;
      const preload = new Image();
      preload.decoding = 'async';
      preload.referrerPolicy = 'no-referrer';
      preload.src = url;
    }
  }, [images, page]);

  const goNext = useCallback(() => {
    setPage((current) => {
      if (current < total - 1) return current + 1;
      if (hasNextChapter && onNextChapter) onNextChapter();
      return current;
    });
  }, [hasNextChapter, onNextChapter, total]);

  const goPrev = useCallback(() => {
    setPage((current) => {
      if (current > 0) return current - 1;
      if (onPrevChapter) onPrevChapter();
      return current;
    });
  }, [onPrevChapter]);

  // Keyboard: Left / Right flip in page mode (as the Dart page's arrow keys
  // do), Escape leaves the reader in both modes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (mode !== 'paged') return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev, mode, onClose]);

  const toggleMode = useCallback(() => {
    setMode((current) => {
      const next: MangaReaderMode = current === 'paged' ? 'webtoon' : 'paged';
      writeMode(next);
      restorePending.current = true;
      return next;
    });
  }, []);

  // Webtoon: keep the counter honest with the scroll position, and open the
  // strip on the remembered page.
  const handleStripScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || strip.clientHeight === 0) return;
    const line = strip.scrollTop + strip.clientHeight * 0.35;
    let low = 0;
    let high = total - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((strip.children[middle] as HTMLElement).offsetTop <= line) low = middle;
      else high = middle - 1;
    }
    setPage(low);
  }, [total]);

  useEffect(() => {
    if (mode !== 'webtoon' || !restorePending.current) return;
    restorePending.current = false;
    const strip = stripRef.current;
    if (!strip || page <= 0) return;
    const target = strip.querySelector<HTMLElement>(`[data-page-index="${page}"]`);
    if (target) strip.scrollTop = Math.max(0, target.offsetTop - 8);
  }, [mode, page, total]);

  useLayoutEffect(() => {
    if (mode === 'paged' && stripRef.current) stripRef.current.scrollTop = 0;
  }, [chapterId, mode, page]);

  const onTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    swipeStart.current = mode === 'paged' && zoom === 1 && event.touches.length === 1
      ? { x: touch.clientX, y: touch.clientY } : null;
  }, [mode, zoom]);

  const onTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const start = swipeStart.current;
      swipeStart.current = null;
      if (!start) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
      if (dx < 0) goNext();
      else goPrev();
    },
    [goNext, goPrev],
  );

  const markBroken = useCallback((index: number) => {
    setBroken((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, []);

  // The page counter lives in its own element (`.mr-counter`), so the subtitle
  // carries only the chapter number to keep one unambiguous "12 / 43" on screen.
  const subtitle = useMemo(
    () => (chapterNumber ? `Chapter ${chapterNumber}` : ''),
    [chapterNumber],
  );

  const onLastPage = total > 0 && page >= total - 1;
  const onFirstPage = page <= 0;
  const brokenCount = broken.size;

  return createPortal(
    <div className="mr" role="region" aria-label={`Reader: ${chapterTitle}`} style={{ '--reader-zoom': zoom } as React.CSSProperties}>
      <div
        className={`mr-stage${mode === 'paged' ? ' is-paged' : ' is-webtoon'}${zoom > 1 ? ' is-zoomed' : ''}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={() => { swipeStart.current = null; }}
      >
        {total === 0 ? (
          <div className="mr-empty">
            <ImageOff size={30} aria-hidden="true" />
            <p>This chapter has no pages yet.</p>
          </div>
        ) : mode === 'paged' ? (
          <div className="mr-paged" ref={bindViewport} onClick={() => setBarVisible((visible) => !visible)}>
            <MangaPage
              key={`${chapterId}/${page}`}
              url={images[clampPage(page)]}
              index={clampPage(page)}
              total={total}
              eager
              onBroken={markBroken}
            />
          </div>
        ) : (
          <div className="mr-strip" ref={bindViewport} onScroll={handleStripScroll}>
            {images.map((url, index) => (
              <div
                key={`${chapterId}/${index}`}
                className="mr-strip-item"
                data-page-index={index}
                onClick={() => setBarVisible((visible) => !visible)}
              >
                <MangaPage
                  url={url}
                  index={index}
                  total={total}
                  eager={Math.abs(index - clampPage(page)) <= PRELOAD_AHEAD}
                  onBroken={markBroken}
                />
              </div>
            ))}
            <div className="mr-strip-end">
              <p>
                {onLastPage
                  ? `End of ${chapterTitle}`
                  : `Page ${clampPage(page) + 1} of ${total}`}
              </p>
              {hasNextChapter && onNextChapter ? (
                <button type="button" className="mr-end-next" onClick={onNextChapter}>
                  <SkipForward size={16} aria-hidden="true" />
                  Next chapter
                </button>
              ) : null}
            </div>
          </div>
        )}

        {/* Paged-mode arrows sit over the page edges, like the Dart tap zones. */}
        {mode === 'paged' && total > 0 ? (
          <>
            <button
              type="button"
              className="mr-edge is-left"
              onClick={goPrev}
              disabled={onFirstPage && !onPrevChapter}
              aria-label="Previous page"
            >
              <ChevronLeft size={22} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="mr-edge is-right"
              onClick={goNext}
              disabled={onLastPage && !(hasNextChapter && onNextChapter)}
              aria-label="Next page"
            >
              <ChevronRight size={22} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>

      {barVisible ? (
        <div className="mr-bar">
          <button type="button" className="mr-btn" onClick={onClose} aria-label="Back (Esc)" data-android-back>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>

          <div className="mr-titles">
            <span className="mr-chapter" title={chapterTitle}>{chapterTitle}</span>
            {subtitle ? <span className="mr-sub">{subtitle}</span> : null}
          </div>

          <span className="mr-counter" aria-live="polite">
            {total > 0 ? `${clampPage(page) + 1} / ${total}` : '0 / 0'}
          </span>
          {total > 0 && <ReaderZoomControls zoom={zoom} onChange={changeZoom} />}

          <button
            type="button"
            className="mr-btn mr-mode"
            onClick={toggleMode}
            aria-label={mode === 'paged' ? 'Switch to webtoon mode' : 'Switch to page mode'}
            aria-pressed={mode === 'paged'}
            title={mode === 'paged' ? 'Webtoon mode' : 'Page mode'}
          >
            {mode === 'paged' ? <Rows3 size={18} aria-hidden="true" /> : <BookOpen size={18} aria-hidden="true" />}
            <span>{mode === 'paged' ? 'Pages' : 'Webtoon'}</span>
          </button>

          {onLastPage && hasNextChapter && onNextChapter ? (
            <button type="button" className="mr-btn is-accent" onClick={onNextChapter}>
              <SkipForward size={18} aria-hidden="true" />
              <span>Next</span>
            </button>
          ) : null}
        </div>
      ) : <button type="button" className="mr-back-hidden" onClick={onClose} tabIndex={-1} aria-hidden="true" data-android-back />}

      {status && <p className="mr-note" role="status">{status}</p>}
      {!status && brokenCount > 0 ? (
        <p className="mr-note" role="status">
          {brokenCount} page{brokenCount === 1 ? '' : 's'} could not be loaded.
        </p>
      ) : null}

      <div className="mr-progress" aria-hidden="true">
        <span style={{ width: total > 0 ? `${((clampPage(page) + 1) / total) * 100}%` : '0%' }} />
      </div>
    </div>,
    document.body,
  );
};

export default MangaReader;
