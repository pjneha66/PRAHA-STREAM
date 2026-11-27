import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Globe, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { openArchiveLoan, openPublicationUrl } from '../services/androidBridge';
import { BooksService, canReadBookFile, type BookFile } from '../services/archiveService';
import { readScanPage, saveScanPage } from '../services/continueStore';
import ArchiveBorrowButton from './ArchiveBorrowButton';
import ReaderZoomControls, { useReaderZoom } from './ReaderZoomControls';

/**
 * In-app "Read online" viewer for archive.org text items. Renders scanned
 * leaves natively (`page/nX_wY.jpg` service derivatives) instead of embedding
 * the archive.org BookReader — the sandboxed iframe embed breaks inside the
 * Capacitor WebView (blank cream leaves, dead page counter).
 *
 * Scroll mode mounts a small window of images with spacers for the other
 * pages. A uniform page height keeps scroll offsets stable as images load.
 * The official Internet Archive item is available if the scan cannot load.
 */

const LEAF_WIDTHS = [760, 500, 1200] as const;
/** Real <img> pages mounted around the current position (scroll mode). */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 6;
/** Default placeholder aspect until the first page reveals the real one. */
const DEFAULT_ASPECT: LeafDims = { w: 3, h: 4 };
/** Max leaf width — mirrors the CSS `min(100%, 820px)` on leaf images. */
const LEAF_MAX_WIDTH = 820;

interface LeafDims { w: number; h: number }

const ReaderLeaf: React.FC<{
  identifier: string;
  leaf: number;
  eager: boolean;
  onLoaded?: (dims: LeafDims) => void;
  onFail?: () => void;
}> = ({ identifier, leaf, eager, onLoaded, onFail }) => {
  const [widthIndex, setWidthIndex] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const url = BooksService.leafImageUrl(identifier, leaf, LEAF_WIDTHS[widthIndex] ?? 760);

  useEffect(() => {
    setWidthIndex(0);
  }, [identifier, leaf]);

  // Every leaf width failed — count it so the shell can surface the fallback.
  useEffect(() => {
    if (widthIndex >= LEAF_WIDTHS.length && onFail) onFail();
  }, [widthIndex, onFail]);

  if (widthIndex >= LEAF_WIDTHS.length) {
    return (
      <div className="archive-leaf-fallback">
        <p>Page {leaf + 1} could not be loaded.</p>
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={() => {
            setWidthIndex(0);
            setRetryTick((v) => v + 1);
          }}
        >
          <RotateCcw size={12} /> Retry
        </button>
      </div>
    );
  }

  return (
    <img
      key={`${url}-${retryTick}`}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      src={url}
      alt={`Page ${leaf + 1}`}
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth && img.naturalHeight && onLoaded) {
          onLoaded({ w: img.naturalWidth, h: img.naturalHeight });
        }
      }}
      onError={() => setWidthIndex((prev) => prev + 1)}
    />
  );
};

const ArchiveReader: React.FC<{
  identifier: string;
  title?: string;
  onClose: () => void;
  onPageRead?: (page: number) => void;
}> = ({ identifier, title, onClose, onPageRead }) => {
  const [leafCount, setLeafCount] = useState<number | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [readableFiles, setReadableFiles] = useState<BookFile[]>([]);
  const [openError, setOpenError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<'scroll' | 'paged'>('scroll');
  const [chromeVisible, setChromeVisible] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  /** Real aspect (w/h) taken from the first loaded page. */
  const [pageAspect, setPageAspect] = useState<LeafDims | null>(null);
  /** Height of one leaf in px inside the scroll container (linear layout). */
  const [fitLeafHeight, setFitLeafHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { zoom, changeZoom, bindViewport } = useReaderZoom(scrollRef);
  const leafHeight = fitLeafHeight === null ? null : fitLeafHeight * zoom;
  const scrollTarget = useRef<number | null>(null);
  const lastLayout = useRef<{ height: number | null; mode: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setLeafCount(null);
    setRestricted(false);
    setReadableFiles([]);
    setOpenError(false);
    setError(null);
    scrollTarget.current = null;
    lastLayout.current = null;
    setCurrentPage(0);
    setFailedCount(0);
    setPageAspect(null);
    setFitLeafHeight(null);
    BooksService.itemLeaves(identifier)
      .then(async (info) => {
        if (!alive) return;
        if (!info.restricted && !info.leafCount) {
          const files = await BooksService.itemFiles(identifier);
          if (!alive) return;
          setReadableFiles(files.filter(canReadBookFile));
        }
        const page = Math.min(readScanPage(identifier) ?? 0, Math.max(0, info.leafCount - 1));
        scrollTarget.current = page;
        setCurrentPage(page);
        setLeafCount(info.leafCount);
        setRestricted(info.restricted);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'The reader could not start.');
      });
    return () => {
      alive = false;
    };
  }, [identifier, retry]);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (mode === 'paged' && lastLayout.current?.mode !== mode) root.scrollTop = 0;
    if (mode === 'scroll' && leafHeight
      && (scrollTarget.current !== null || lastLayout.current?.height !== fitLeafHeight || lastLayout.current?.mode !== mode)) {
      root.scrollTop = (scrollTarget.current ?? currentPage) * leafHeight;
      scrollTarget.current = null;
    }
    lastLayout.current = { height: fitLeafHeight, mode };
  }, [currentPage, mode, leafHeight, fitLeafHeight]);

  useEffect(() => {
    if (!leafCount || restricted || error) return;
    saveScanPage(identifier, currentPage);
    onPageRead?.(currentPage);
  }, [identifier, currentPage, leafCount, restricted, error, onPageRead]);

  const handleLeafFail = useCallback(() => setFailedCount((v) => v + 1), []);

  const handleLeafLoaded = useCallback((dims: LeafDims) => {
    setPageAspect((existing) => (existing || !dims.w || !dims.h ? existing : dims));
  }, []);

  // One leaf = width min(container, 820px) × aspect. Uniform across the book,
  // so page N sits at exactly N × leafHeight.
  const aspect = pageAspect || DEFAULT_ASPECT;
  useEffect(() => {
    const measure = () => {
      const root = scrollRef.current;
      if (!root) return;
      const width = Math.min(root.clientWidth, LEAF_MAX_WIDTH);
      if (width > 0 && aspect.h > 0) setFitLeafHeight((width * aspect.h) / aspect.w);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [aspect.w, aspect.h, mode, leafCount, error]);

  const handleScroll = useCallback(() => {
    if (scrollTarget.current !== null) return;
    const root = scrollRef.current;
    if (!root || !leafHeight || !leafCount) return;
    const index = Math.floor((root.scrollTop + Math.min(40, leafHeight / 2)) / leafHeight);
    setCurrentPage(Math.min(Math.max(0, index), leafCount - 1));
  }, [leafCount, leafHeight]);

  const scrollToLeaf = useCallback((leaf: number) => {
    if (!leafCount) return;
    const clamped = Math.min(Math.max(0, leaf), leafCount - 1);
    if (mode === 'scroll' && scrollRef.current && leafHeight) {
      scrollRef.current.scrollTop = clamped * leafHeight;
    }
    if (mode === 'paged' && scrollRef.current && clamped !== currentPage) scrollRef.current.scrollTop = 0;
    setCurrentPage(clamped);
  }, [currentPage, leafCount, leafHeight, mode]);

  const switchMode = (next: 'scroll' | 'paged') => {
    if (next === mode) return;
    scrollTarget.current = next === 'scroll' ? currentPage : null;
    setMode(next);
  };

  const displayTitle = title || identifier;
  const showFailedBanner = !error && failedCount >= (mode === 'paged' ? 1 : 3);

  const renderLeafContent = (leaf: number, eager: boolean) => (
    <ReaderLeaf
      identifier={identifier}
      leaf={leaf}
      eager={eager}
      onLoaded={handleLeafLoaded}
      onFail={handleLeafFail}
    />
  );

  const firstLeaf = Math.max(0, currentPage - WINDOW_BEFORE);
  const lastLeaf = Math.min((leafCount ?? 0) - 1, currentPage + WINDOW_AFTER);

  // Portal to document.body: a fixed shell rendered inside a page that carries
  // any ancestor transform/filter gets trapped in that container (the reader
  // once opened scrolled 2000px away from the viewport). Portal + body = safe.
  return createPortal(
    <div
      className="modal-backdrop archive-reader-shell"
      role="dialog"
      aria-modal="true"
      aria-label={`Read ${displayTitle}`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      <div className="archive-reader-bar" style={{ display: chromeVisible ? 'flex' : 'none' }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle}</strong>
        {!restricted && Boolean(leafCount) && <div className="archive-mode-pills" role="tablist">
          <button type="button" className={mode === 'scroll' ? 'active' : ''} onClick={() => switchMode('scroll')}>Scroll</button>
          <button type="button" className={mode === 'paged' ? 'active' : ''} onClick={() => switchMode('paged')}>Paged</button>
        </div>}
        <button
          type="button"
          className="icon-button"
          aria-label="Open Internet Archive"
          onClick={async () => setOpenError(!await openArchiveLoan(BooksService.detailsUrl(identifier)))}
        >
          <Globe size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Close reader" onClick={onClose} data-android-back>
          <X size={16} />
        </button>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000' }}>
        {/* Lending-locked items: page images are 403 without an archive.org loan
            (verified live — the embed is also blank for these), so be honest
            instead of showing an empty reader. */}
        {restricted && leafCount !== null && !error && (
          <div className="archive-reader-error">
            <p>Check Internet Archive for a free loan or waitlist. Sign in to read an available copy.</p>
            <ArchiveBorrowButton identifier={identifier} />
          </div>
        )}

        {!restricted && leafCount === 0 && !error && (
          <div className="archive-reader-error archive-file-options">
            <p>{readableFiles.length ? 'Choose a volume to read.' : 'No readable files were listed for this item.'}</p>
            {readableFiles.map((file) => (
              <button type="button" key={file.url} className="button button-secondary" onClick={async () => setOpenError(!await openPublicationUrl(file.url))}>
                {file.name}
              </button>
            ))}
            {!readableFiles.length && <ArchiveBorrowButton identifier={identifier} label="Open Internet Archive" />}
            {openError && <p role="alert">Could not open the reader. Try the file again.</p>}
          </div>
        )}

        {/* Native leaf rendering (unrestricted scans only) */}
        {!restricted && leafCount !== null && leafCount > 0 && !error && (
          <div
            ref={bindViewport}
            className={mode === 'scroll' ? 'archive-scroll-body' : 'archive-paged-body'}
            style={{ '--reader-zoom': zoom } as React.CSSProperties}
            onScroll={mode === 'scroll' ? handleScroll : undefined}
            onClick={mode === 'paged' ? () => setChromeVisible((v) => !v) : undefined}
          >
            {mode === 'paged' ? (
              <>
                <button
                  type="button"
                  aria-label="Previous page"
                  className="archive-paged-zone archive-paged-prev"
                  onClick={(event) => {
                    event.stopPropagation();
                    scrollToLeaf(currentPage - 1);
                  }}
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  className="archive-paged-zone archive-paged-next"
                  onClick={(event) => {
                    event.stopPropagation();
                    scrollToLeaf(currentPage + 1);
                  }}
                >
                  <ChevronRight size={20} />
                </button>
                {/* Paged mode mounts exactly one page. */}
                <div className="archive-leaf">{renderLeafContent(currentPage, true)}</div>
              </>
            ) : (
              <>
                {leafHeight !== null && <div aria-hidden="true" style={{ height: firstLeaf * leafHeight }} />}
                {Array.from({ length: lastLeaf - firstLeaf + 1 }, (_, offset) => {
                  const leaf = firstLeaf + offset;
                  return (
                    <div key={leaf} className="archive-leaf" style={{ height: leafHeight ?? undefined }}>
                      {renderLeafContent(leaf, Math.abs(leaf - currentPage) <= 1)}
                    </div>
                  );
                })}
                {leafHeight !== null && <>
                  <div aria-hidden="true" style={{ height: (leafCount - lastLeaf - 1) * leafHeight }} />
                  <div aria-hidden="true" style={{ height: `max(0px, calc(100% - ${leafHeight}px))` }} />
                </>}
              </>
            )}
          </div>
        )}

        {showFailedBanner && (
          <div className="archive-fallback-banner">
            <span>Scanned pages are not loading — this scan may be access-restricted.</span>
            <ArchiveBorrowButton identifier={identifier} label="Open Internet Archive" />
          </div>
        )}

        {/* Explicit fallback after a metadata failure */}
        {error && (
          <div className="archive-reader-error">
            <p>{error}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => setRetry((count) => count + 1)}
              >
                <RotateCcw size={12} /> Retry
              </button>
              <ArchiveBorrowButton identifier={identifier} label="Open Internet Archive" />
            </div>
          </div>
        )}

        {/* Loading spinner (native path) */}
        {!restricted && leafCount === null && !error && (
          <div className="archive-reader-error">
            <LoaderCircle size={26} className="spin" />
            <span>Loading the scan…</span>
          </div>
        )}

        {/* Bottom scrubber */}
        {!restricted && leafCount !== null && leafCount > 0 && !error && chromeVisible && (
          <div className="archive-reader-scrub">
            <ReaderZoomControls zoom={zoom} onChange={changeZoom} />
            <span className="archive-page-label">Page {currentPage + 1} / {leafCount}</span>
            <input
              type="range"
              min={1}
              max={leafCount}
              value={currentPage + 1}
              onChange={(event) => scrollToLeaf(Number(event.target.value) - 1)}
              aria-label="Jump to page"
            />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default ArchiveReader;
