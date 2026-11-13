import React from 'react';
import { ExternalLink, LoaderCircle, X } from 'lucide-react';
import { openSafeExternalUrl } from '../services/androidBridge';

/**
 * In-app "Read online" (OMLE) viewer for archive.org text items. Uses the
 * sanctioned archive.org/embed endpoint, which serves the full BookReader
 * (page flip, zoom, search) for pdf/epub/cbz items in a sandboxed iframe.
 * The embed takes several seconds to boot — a spinner covers the black frame
 * until onLoad fires, so it never looks like a hang.
 */
const ArchiveReader: React.FC<{
  identifier: string;
  title?: string;
  onClose: () => void;
}> = ({ identifier, title, onClose }) => {
  const [loaded, setLoaded] = React.useState(false);
  // If the embed never fires onLoad (slow network, error page behind the
  // sandbox), don't spin forever — reveal the iframe and surface a fallback.
  const [timedOut, setTimedOut] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), 20000);
    return () => window.clearTimeout(timer);
  }, []);
  const showSpinner = !loaded && !timedOut;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: '#08090b', zIndex: 100, display: 'flex', flexDirection: 'column' }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px', background: '#0d1117', borderBottom: '1px solid #30363d', flexShrink: 0,
      }}>
        <strong style={{ color: '#f0f6fc', fontSize: '14px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title || identifier}
        </strong>
        <button
          onClick={() => openSafeExternalUrl(`https://archive.org/details/${encodeURIComponent(identifier)}`)}
          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
        >
          <ExternalLink size={12} /> archive.org
        </button>
        <button
          onClick={onClose}
          aria-label="Close reader"
          style={{ display: 'flex', alignItems: 'center', padding: '6px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#f0f6fc', cursor: 'pointer' }}
        >
          <X size={16} />
        </button>
      </div>
      <div style={{ position: 'relative', flex: 1, background: '#000' }}>
        {showSpinner && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#8b949e', fontSize: '13px' }}>
            <LoaderCircle size={26} className="spin" />
            <span>Loading the archive.org book reader…</span>
            <button
              onClick={() => openSafeExternalUrl(`https://archive.org/details/${encodeURIComponent(identifier)}`)}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '7px 14px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              <ExternalLink size={12} /> Open in browser instead
            </button>
          </div>
        )}
        {timedOut && !loaded && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', padding: '12px', background: 'rgba(8, 9, 11, 0.85)' }}>
            <button
              onClick={() => openSafeExternalUrl(`https://archive.org/details/${encodeURIComponent(identifier)}`)}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 16px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              <ExternalLink size={12} /> Reader did not load — open in browser instead
            </button>
          </div>
        )}
        <iframe
          src={`https://archive.org/embed/${encodeURIComponent(identifier)}`}
          title={`Read ${title || identifier} online`}
          style={{ width: '100%', height: '100%', border: 'none', background: '#000', opacity: loaded || timedOut ? 1 : 0 }}
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
};

export default ArchiveReader;
