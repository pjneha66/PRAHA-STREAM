import React from 'react';
import { ExternalLink, X } from 'lucide-react';
import { openSafeExternalUrl } from '../services/androidBridge';

/**
 * In-app "Read online" (OMLE) viewer for archive.org text items. Uses the
 * sanctioned archive.org/embed endpoint, which serves the full BookReader
 * (page flip, zoom, search) for pdf/epub/cbz items in a sandboxed iframe.
 */
const ArchiveReader: React.FC<{
  identifier: string;
  title?: string;
  onClose: () => void;
}> = ({ identifier, title, onClose }) => {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(1, 4, 9, 0.92)', zIndex: 100, display: 'flex', flexDirection: 'column' }}
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
      <iframe
        src={`https://archive.org/embed/${encodeURIComponent(identifier)}`}
        title={`Read ${title || identifier} online`}
        style={{ flex: 1, width: '100%', border: 'none', background: '#000' }}
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
};

export default ArchiveReader;
