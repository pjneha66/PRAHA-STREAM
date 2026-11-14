import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { openSafeExternalUrl } from '../services/androidBridge';
import { BooksService } from '../services/archiveService';

/**
 * In-app "Read online" viewer for archive.org text items. Renders scanned
 * leaves natively (`page/nX_wY.jpg` service derivatives) instead of embedding
 * the archive.org BookReader — the sandboxed iframe embed breaks inside the
 * Capacitor WebView (blank cream leaves, dead page counter).
 *
 * Performance: a scan can have hundreds of leaves. Only a small window of
 * pages around the current position mounts a real <img>; the rest are
 * aspect-ratio placeholders (sized from the first loaded page), so opening a
 * big book never blocks the WebView main thread. The scroll tracker reads a
 * cached offsets array (no per-frame layout reads). If the metadata or the
 * image service fails (e.g. access-restricted scans), the old iframe embed
 * (now unsandboxed) stays available as an explicit fallback.
 */

const LEAF_WIDTHS = [760, 500, 1200] as const;
/** How many real pages stay mounted around the current position (scroll mode). */
const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 6;

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
  const [error, setError] = useState<string | null>(null);
  const [useEmbed, setUseEmbed] = useState(false);
  const [embedLoaded, setEmbedLoaded] = useState(false);
  const [mode, setMode] = useState<'scroll' | 'paged'>('scroll');
  const [chromeVisible, setChromeVisible] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  /** Aspect (w/h) taken from the first loaded page — placeholder pages use it. */
  const [pageAspect, setPageAspect] = useState<LeafDims | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const leafRefs = useRef<Array<HTMLDivElement | null>>([]);
  /** Cached offsetTop per leaf (leaf container is the offsetParent). */
  const offsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);

  useEffect(() => {
    let alive = true;
    setLeafCount(null);
    setError(null);
    setUseEmbed(false);
    setCurrentPage(0);
    setFailedCount(0);
    setPageAspect(null);
    offsetsRef.current = [];
    BooksService.itemLeaves(identifier)
      .then((info) => {
        if (alive) setLeafCount(info.leafCount);
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

  // Scroll container is position:relative, so each leaf's offsetTop is already
  // relative to it — a plain array scan, zero layout reads in the scroll path.
  const recomputeOffsets = useCallback(() => {
    offsetsRef.current = leafRefs.current.map((node) => (node ? node.offsetTop : 0));
  }, []);

  useEffect(() => {
    recomputeOffsets();
  }, [recomputeOffsets, mode, leafCount, pageAspect, error]);

  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      const root = scrollRef.current;
      if (!root || !leafCount) return;
      const scrollTop = root.scrollTop;
      const offsets = offsetsRef.current;
      let current = 0;
      for (let i = 0; i < offsets.length; i += 1) {
        if (offsets[i] <= scrollTop + 80) current = i;
        else break;
      }
      setCurrentPage(current);
    });
  }, [leafCount]);

  const scrollToLeaf = useCallback((leaf: number) => {
    setCurrentPage(leaf);
    const node = leafRefs.current[leaf];
    if (node) node.scrollIntoView({ block: 'start' });
  }, []);

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

  const placeholderStyle: React.CSSProperties = pageAspect
    ? { aspectRatio: `${pageAspect.w} / ${pageAspect.h}` }
    : { aspectRatio: '3 / 4' };

  return (
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
        {/* Native leaf rendering */}
        {!useEmbed && leafCount !== null && !error && (
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
                    scrollToLeaf(Math.max(0, currentPage - 1));
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
                    scrollToLeaf(Math.min(leafCount - 1, currentPage + 1));
                  }}
                >
                  <ChevronRight size={20} />
                </button>
                {/* Paged mode mounts exactly one page. */}
                <div className="archive-leaf">{renderLeafContent(currentPage, true)}</div>
              </>
            ) : (
              Array.from({ length: leafCount }, (_, leaf) => {
                const inWindow = leaf >= currentPage - WINDOW_BEFORE && leaf <= currentPage + WINDOW_AFTER;
                return (
                  <div
                    key={leaf}
                    ref={(node) => {
                      leafRefs.current[leaf] = node;
                    }}
                    className="archive-leaf"
                  >
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
        {!useEmbed && leafCount === null && !error && (
          <div className="archive-reader-error">
            <LoaderCircle size={26} className="spin" />
            <span>Loading the scan…</span>
          </div>
        )}

        {/* Bottom scrubber */}
        {!useEmbed && leafCount !== null && !error && chromeVisible && (
          <div className="archive-reader-scrub">
            <span className="archive-page-label">Page {currentPage + 1} / {leafCount}</span>
            <input
              type="range"
              min={1}
              max={leafCount}
              value={currentPage + 1}
              onChange={(event) => {
                const next = Number(event.target.value) - 1;
                scrollToLeaf(next);
              }}
              aria-label="Jump to page"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ArchiveReader;
