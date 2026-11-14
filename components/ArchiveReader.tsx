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
 * Two reading modes: continuous scroll (default) and paged tap-through. If the
 * metadata or the image service fails (e.g. access-restricted scans), the old
 * iframe embed (now unsandboxed) stays available as an explicit fallback.
 */

const LEAF_WIDTHS = [760, 500, 1200] as const;

const ReaderLeaf: React.FC<{ identifier: string; leaf: number; eager: boolean; onFail?: () => void }> = ({
  identifier,
  leaf,
  eager,
  onFail,
}) => {
  const [widthIndex, setWidthIndex] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const url = BooksService.leafImageUrl(identifier, leaf, LEAF_WIDTHS[widthIndex] ?? 760);

  useEffect(() => {
    setWidthIndex(0);
  }, [identifier, leaf]);

  // Every leaf width failed — count it so the shell can surface the fallback.
  useEffect(() => {
    if (widthIndex >= LEAF_WIDTHS.length && onFail) onFail();
    // onFail is a stable setState-based callback; width changes reset it.
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const leafRefs = useRef<Array<HTMLDivElement | null>>([]);

  React.useEffect(() => {
    let alive = true;
    setLeafCount(null);
    setError(null);
    setUseEmbed(false);
    setCurrentPage(0);
    setFailedCount(0);
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

  const scrollToLeaf = useCallback((leaf: number) => {
    const node = leafRefs.current[leaf];
    if (node) node.scrollIntoView({ block: 'start' });
  }, []);

  // Track the leaf currently nearest the top of the viewport (scroll mode).
  useEffect(() => {
    if (mode !== 'scroll' || !scrollRef.current) return;
    const root = scrollRef.current;
    const onScroll = () => {
      const rootTop = root.getBoundingClientRect().top;
      let current = 0;
      for (let i = 0; i < leafRefs.current.length; i += 1) {
        const node = leafRefs.current[i];
        if (!node) continue;
        if (node.getBoundingClientRect().top <= rootTop + 40) current = i;
        else break;
      }
      setCurrentPage(current);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [mode, leafCount]);

  const displayTitle = title || identifier;
  const showFailedBanner = failedCount >= 2 && !error;

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

  return (
    <div
      className="modal-backdrop archive-reader-shell"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      <div className="archive-reader-bar" style={{ display: chromeVisible ? 'flex' : 'none' }}>
        <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle}</strong>
        <div className="archive-mode-pills" role="tablist">
          <button type="button" className={mode === 'scroll' ? 'active' : ''} onClick={() => setMode('scroll')}>Scroll</button>
          <button type="button" className={mode === 'paged' ? 'active' : ''} onClick={() => setMode('paged')}>Paged</button>
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
            onClick={mode === 'paged' ? () => setChromeVisible((v) => !v) : undefined}
          >
            {mode === 'paged' && (
              <>
                <button
                  type="button"
                  aria-label="Previous page"
                  className="archive-paged-zone archive-paged-prev"
                  onClick={() => scrollToLeaf(Math.max(0, currentPage - 1))}
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  aria-label="Next page"
                  className="archive-paged-zone archive-paged-next"
                  onClick={() => scrollToLeaf(Math.min(leafCount - 1, currentPage + 1))}
                >
                  <ChevronRight size={20} />
                </button>
              </>
            )}
            {Array.from({ length: leafCount }, (_, leaf) => (
              <div
                key={leaf}
                ref={(node) => {
                  leafRefs.current[leaf] = node;
                }}
                className="archive-leaf"
              >
                <ReaderLeaf identifier={identifier} leaf={leaf} eager={leaf <= 1} onFail={handleLeafFail} />
              </div>
            ))}
          </div>
        )}

        {showFailedBanner && (
          <div className="archive-fallback-banner">
            <span>Scanned pages are not loading — this scan may be access-restricted.</span>
            <button type="button" className="button button-secondary button-small" onClick={() => setUseEmbed(true)}>
              Try archive.org embed
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
                setCurrentPage(next);
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
