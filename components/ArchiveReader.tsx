import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { openSafeExternalUrl } from '../services/androidBridge';
import { BooksService } from '../services/archiveService';

/**
 * In-app "Read online" viewer for archive.org text items. Renders scanned
 * leaves natively (`page/nX_wY.jpg` service derivatives) instead of embedding
 * the archive.org BookReader — the sandboxed iframe embed breaks inside the
 * Capacitor WebView (blank cream leaves, dead page counter).
 *
 * Performance model (the v2.10.0/2.10.1 freeze): scans can have hundreds of
 * pages, so nothing here may scale with leafCount per frame. Pages are laid
 * out linearly — every leaf has the same height (uniform aspect, fixed width)
 * — which means:
 *   - scroll position ↔ page index is pure arithmetic (no refs, no layout reads),
 *   - only a small window of pages mounts a real <img>, the rest are
 *     aspect-ratio placeholders, and the list itself is rendered in chunks
 *     that extend as you approach the end (DOM stays bounded),
 *   - paged mode mounts exactly one page.
 * If the metadata or the image service fails (e.g. access-restricted scans),
 * the old iframe embed (now unsandboxed) stays as an explicit fallback.
 */

const LEAF_WIDTHS = [760, 500, 1200] as const;
/** Real <img> pages mounted around the current position (scroll mode). */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 6;
/** DOM chunking: how many leaf nodes exist at once and how much they grow. */
const CHUNK_INITIAL = 60;
const CHUNK_GROW = 80;
const CHUNK_NEAR_END = 30;
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
}> = ({ identifier, title, onClose }) => {
  const [leafCount, setLeafCount] = useState<number | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useEmbed, setUseEmbed] = useState(false);
  const [embedLoaded, setEmbedLoaded] = useState(false);
  const [mode, setMode] = useState<'scroll' | 'paged'>('scroll');
  const [chromeVisible, setChromeVisible] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  /** Real aspect (w/h) taken from the first loaded page. */
  const [pageAspect, setPageAspect] = useState<LeafDims | null>(null);
  /** How many leaf nodes currently exist in the DOM (grows near the end). */
  const [renderedCount, setRenderedCount] = useState(CHUNK_INITIAL);
  /** Height of one leaf in px inside the scroll container (linear layout). */
  const [leafHeight, setLeafHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTsRef = useRef(0);

  useEffect(() => {
    let alive = true;
    setLeafCount(null);
    setRestricted(false);
    setError(null);
    setUseEmbed(false);
    setCurrentPage(0);
    setFailedCount(0);
    setPageAspect(null);
    setRenderedCount(CHUNK_INITIAL);
    setLeafHeight(null);
    BooksService.itemLeaves(identifier)
      .then((info) => {
        if (!alive) return;
        setLeafCount(info.leafCount);
        setRestricted(info.restricted);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'The reader could not start.');
      });
    return () => {
      alive = false;
    };
  }, [identifier]);

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
      if (width > 0 && aspect.h > 0) setLeafHeight((width * aspect.h) / aspect.w);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [aspect.w, aspect.h, mode, leafCount, error]);

  // Scroll events are already coalesced per frame by the browser — throttle by
  // timestamp instead of requestAnimationFrame, which is throttled or paused
  // entirely in unfocused/backgrounded WebViews (label froze without updates).
  const handleScroll = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollTsRef.current < 80) return;
    lastScrollTsRef.current = now;
    const root = scrollRef.current;
    if (!root || !leafHeight || !leafCount) return;
    const index = Math.floor((root.scrollTop + 40) / leafHeight);
    const clamped = Math.min(Math.max(0, index), leafCount - 1);
    setCurrentPage(clamped);
    // Grow the DOM chunk as the reader approaches the rendered tail.
    setRenderedCount((rendered) => {
      if (clamped + CHUNK_NEAR_END <= rendered || rendered >= leafCount) return rendered;
      return Math.min(leafCount, Math.max(rendered + CHUNK_GROW, clamped + CHUNK_NEAR_END + WINDOW_AFTER));
    });
  }, [leafCount, leafHeight]);

  const scrollToLeaf = useCallback((leaf: number) => {
    if (!leafCount) return;
    const clamped = Math.min(Math.max(0, leaf), leafCount - 1);
    setCurrentPage(clamped);
    setRenderedCount((rendered) => {
      if (clamped + CHUNK_NEAR_END <= rendered || rendered >= leafCount) return rendered;
      return Math.min(leafCount, clamped + CHUNK_NEAR_END + WINDOW_AFTER);
    });
    const root = scrollRef.current;
    if (root && leafHeight) root.scrollTop = clamped * leafHeight;
  }, [leafCount, leafHeight]);

  const switchMode = useCallback((next: 'scroll' | 'paged') => {
    setMode(next);
    setCurrentPage(0);
    const root = scrollRef.current;
    if (root) root.scrollTop = 0;
  }, []);

  const displayTitle = title || identifier;
  const showFailedBanner = failedCount >= 3 && !error;

  const embedFallback = useEmbed && (
    <>
      <iframe
        src={`https://archive.org/embed/${encodeURIComponent(identifier)}`}
        title={`Read ${displayTitle} online`}
        style={{ width: '100%', height: '100%', border: 'none', background: '#000', opacity: embedLoaded ? 1 : 0 }}
        allowFullScreen
        onLoad={() => setEmbedLoaded(true)}
      />
      {!embedLoaded && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13, gap: 10 }}>
          <LoaderCircle size={24} className="spin" /> Loading the archive.org embed…
        </div>
      )}
    </>
  );

  const renderLeafContent = (leaf: number, eager: boolean) => (
    <ReaderLeaf
      identifier={identifier}
      leaf={leaf}
      eager={eager}
      onLoaded={handleLeafLoaded}
      onFail={handleLeafFail}
    />
  );

  const placeholderStyle: React.CSSProperties = { aspectRatio: `${aspect.w} / ${aspect.h}` };

  // Portal to document.body: a fixed shell rendered inside a page that carries
  // any ancestor transform/filter gets trapped in that container (the reader
  // once opened scrolled 2000px away from the viewport). Portal + body = safe.
  return createPortal(
    <div
      className="modal-backdrop archive-reader-shell"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      <div className="archive-reader-bar" style={{ display: chromeVisible ? 'flex' : 'none' }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle}</strong>
        <div className="archive-mode-pills" role="tablist">
          <button type="button" className={mode === 'scroll' ? 'active' : ''} onClick={() => switchMode('scroll')}>Scroll</button>
          <button type="button" className={mode === 'paged' ? 'active' : ''} onClick={() => switchMode('paged')}>Paged</button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Open on archive.org"
          onClick={() => openSafeExternalUrl(BooksService.detailsUrl(identifier))}
        >
          <ExternalLink size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Close reader" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000' }}>
        {/* Lending-locked items: page images are 403 without an archive.org loan
            (verified live — the embed is also blank for these), so be honest
            instead of showing an empty reader. */}
        {!useEmbed && restricted && leafCount !== null && !error && (
          <div className="archive-reader-error">
            <p>
              This scan is lending-locked on archive.org — pages only open with a
              free archive.org loan, which the in-app reader can't use.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button type="button" className="button button-primary button-small" onClick={() => openSafeExternalUrl(BooksService.detailsUrl(identifier))}>
                <ExternalLink size={12} /> Open on archive.org
              </button>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => openSafeExternalUrl(`https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(identifier)}.pdf`)}
              >
                Try the PDF download
              </button>
            </div>
          </div>
        )}

        {/* Native leaf rendering (unrestricted scans only) */}
        {!useEmbed && !restricted && leafCount !== null && !error && (
          <div
            ref={scrollRef}
            className={mode === 'scroll' ? 'archive-scroll-body' : 'archive-paged-body'}
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
                    setCurrentPage(Math.max(0, currentPage - 1));
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
                    setCurrentPage(Math.min(leafCount - 1, currentPage + 1));
                  }}
                >
                  <ChevronRight size={20} />
                </button>
                {/* Paged mode mounts exactly one page. */}
                <div className="archive-leaf">{renderLeafContent(currentPage, true)}</div>
              </>
            ) : (
              Array.from({ length: Math.min(leafCount, renderedCount) }, (_, leaf) => {
                const inWindow = leaf >= currentPage - WINDOW_BEFORE && leaf <= currentPage + WINDOW_AFTER;
                return (
                  <div key={leaf} className="archive-leaf">
                    {inWindow
                      ? renderLeafContent(leaf, Math.abs(leaf - currentPage) <= 1)
                      : <div className="archive-leaf-ph" style={placeholderStyle} />}
                  </div>
                );
              })
            )}
          </div>
        )}

        {showFailedBanner && (
          <div className="archive-fallback-banner">
            <span>Scanned pages are not loading — this scan may be access-restricted.</span>
            <button type="button" className="button button-secondary button-small" onClick={() => setUseEmbed(true)}>
              Try archive.org embed
            </button>
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => openSafeExternalUrl(BooksService.detailsUrl(identifier))}
            >
              Open on archive.org
            </button>
          </div>
        )}

        {/* Explicit fallback after a metadata failure */}
        {!useEmbed && error && (
          <div className="archive-reader-error">
            <p>{error}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => {
                  setError(null);
                  BooksService.itemLeaves(identifier).then((info) => setLeafCount(info.leafCount)).catch((err: unknown) => setError(err instanceof Error ? err.message : 'The reader could not start.'));
                }}
              >
                <RotateCcw size={12} /> Retry
              </button>
              <button type="button" className="button button-secondary button-small" onClick={() => setUseEmbed(true)}>
                Try archive.org embed
              </button>
              <button type="button" className="button button-secondary button-small" onClick={() => openSafeExternalUrl(BooksService.detailsUrl(identifier))}>
                <ExternalLink size={12} /> Open on archive.org
              </button>
            </div>
          </div>
        )}

        {embedFallback}

        {/* Loading spinner (native path) */}
        {!useEmbed && !restricted && leafCount === null && !error && (
          <div className="archive-reader-error">
            <LoaderCircle size={26} className="spin" />
            <span>Loading the scan…</span>
          </div>
        )}

        {/* Bottom scrubber */}
        {!useEmbed && !restricted && leafCount !== null && !error && chromeVisible && (
          <div className="archive-reader-scrub">
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
