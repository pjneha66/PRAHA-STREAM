import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, CircleAlert, ExternalLink, FileDown, Library, LoaderCircle, RefreshCw, Search, X,
} from 'lucide-react';
import {
  ARCHIVE_COLLECTIONS, BooksService, type BookFile, type BookItem,
} from '../services/archiveService';
import { openSafeExternalUrl } from '../services/androidBridge';
import ArchiveReader from './ArchiveReader';
import SkeletonGrid from './SkeletonGrid';
import ContinueShelf from './ContinueShelf';
import { readContinue, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';

type SourceMode = 'openlibrary' | 'archive';

/** Open Library quick subjects (openlibrary.org/subjects/...). */
const OPEN_LIBRARY_SUBJECTS = [
  'Classics', 'Science Fiction', 'Fantasy', 'Mystery', 'Romance', 'Horror',
  'History', 'Philosophy', 'Manga', 'Comics', 'Poetry', 'Biography',
];

const cardStyle: React.CSSProperties = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: '12px',
  overflow: 'hidden',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
};

/**
 * Cover image with a fallback chain: the primary URL, a wsrv.nl image proxy
 * of the same URL (survives covers.openlibrary.org rate limits and DNS-level
 * blocks), then the archive.org scan image, then a placeholder.
 */
const BookCover: React.FC<{ item: BookItem }> = ({ item }) => {
  const [candidateIdx, setCandidateIdx] = React.useState(0);
  React.useEffect(() => setCandidateIdx(0), [item.coverUrl, item.identifier]);

  const candidates = React.useMemo(() => {
    const list: string[] = [];
    if (item.coverUrl) list.push(item.coverUrl);
    if (item.coverUrl && item.coverUrl.includes('covers.openlibrary.org')) {
      list.push(`https://wsrv.nl/?url=${encodeURIComponent(item.coverUrl)}`);
    }
    if (item.identifier) list.push(`https://archive.org/services/img/${item.identifier}`);
    return list;
  }, [item.coverUrl, item.identifier]);

  const url = candidates[candidateIdx];
  return (
    <div style={{ aspectRatio: '3 / 4', background: '#0d1117', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setCandidateIdx((idx) => idx + 1)}
        />
      ) : (
        <BookOpen size={30} color="#30363d" />
      )}
    </div>
  );
};

/**
 * Books tab: Open Library + Internet Archive search, folkscanomy collections,
 * downloadable pdf/epub/cbz files. Anna's Archive is offered as an external
 * site link — PRAHA does not integrate its search or downloads.
 */
const BooksView: React.FC<{ compact?: boolean; prefillQuery?: string }> = ({ compact, prefillQuery }) => {
  const [mode, setMode] = useState<SourceMode>('archive');
  const [collectionId, setCollectionId] = useState<string>(ARCHIVE_COLLECTIONS[1].id);
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [items, setItems] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<BookItem | null>(null);
  const [files, setFiles] = useState<BookFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [readerItem, setReaderItem] = useState<BookItem | null>(null);
  const requestSeq = useRef(0);
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>(() => readContinue('book'));

  const load = useCallback(async (nextPage: number, append: boolean) => {
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) setError('');
    const collection = ARCHIVE_COLLECTIONS.find((c) => c.id === collectionId) || ARCHIVE_COLLECTIONS[0];
    try {
      const result = mode === 'archive'
        ? await BooksService.searchArchive(submitted, collection, nextPage)
        : await BooksService.searchOpenLibrary(submitted || 'classics', nextPage);
      if (seq !== requestSeq.current) return;
      setItems((current) => (append ? [...current, ...result] : result));
      setPage(nextPage);
      setHasMore(result.length >= 24);
      if (!append && !result.length) setError(submitted ? 'No books matched that search.' : 'Nothing found — try a search.');
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (!append) {
        setItems([]);
        setHasMore(false);
        setError(err instanceof Error ? err.message : 'The book source did not answer.');
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [mode, collectionId, submitted]);

  useEffect(() => {
    void load(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, collectionId, submitted]);

  // Universal-search deep link: a query issued in Discover lands here pre-filled.
  const appliedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const term = (prefillQuery || '').trim();
    if (!term || appliedPrefillRef.current === term) return;
    appliedPrefillRef.current = term;
    setInput(term);
    setSubmitted(term);
  }, [prefillQuery]);

  const openItem = async (item: BookItem) => {
    setSelected(item);
    recordContinue({
      domain: 'book',
      id: item.identifier || item.id,
      title: item.title,
      cover: item.coverUrl,
      detail: item.authors?.[0],
      payload: {
        identifier: item.identifier,
        openLibraryKey: item.openLibraryKey,
        source: item.source,
        authors: item.authors,
        year: item.year,
      },
    });
    setContinueEntries(readContinue('book'));
    setFiles(null);
    setFilesError('');
    if (!item.identifier) return;
    setFilesLoading(true);
    try {
      const list = await BooksService.itemFiles(item.identifier);
      setFiles(list);
      if (!list.length) setFilesError('No downloadable pdf/epub/cbz found in this item.');
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : 'Could not load the file list.');
    } finally {
      setFilesLoading(false);
    }
  };

  const resumeBook = (entry: ContinueEntry) => {
    const payload = (entry.payload || {}) as { identifier?: string; openLibraryKey?: string; source?: 'openlibrary' | 'archive'; authors?: string[]; year?: string };
    void openItem({
      id: entry.id,
      title: entry.title,
      authors: payload.authors || [],
      year: payload.year,
      coverUrl: entry.cover,
      identifier: payload.identifier,
      openLibraryKey: payload.openLibraryKey,
      source: payload.source || 'archive',
    });
  };

  const collection = ARCHIVE_COLLECTIONS.find((c) => c.id === collectionId) || ARCHIVE_COLLECTIONS[0];

  return (
    <div style={{ padding: '20px 18px 40px', maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: 'linear-gradient(135deg, #d6f77a, #9ccc3d)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Library size={22} color="#1a1d13" />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: '22px', color: '#f0f6fc' }}>Books</h1>
          <span style={{ color: '#8b949e', fontSize: '13px' }}>
            Open Library &amp; archive.org · folkscanomy comics, manga and texts · read or download pdf / epub / cbz
          </span>
        </div>
      </div>

      {/* Source switches */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <button
          onClick={() => setMode('archive')}
          style={{
            padding: '7px 14px', borderRadius: '999px', border: '1px solid',
            borderColor: mode === 'archive' ? '#d6f77a' : '#30363d',
            background: mode === 'archive' ? 'rgba(214, 247, 122, 0.14)' : '#161b22',
            color: mode === 'archive' ? '#d6f77a' : '#8b949e', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          Internet Archive · folkscanomy
        </button>
        <button
          onClick={() => setMode('openlibrary')}
          style={{
            padding: '7px 14px', borderRadius: '999px', border: '1px solid',
            borderColor: mode === 'openlibrary' ? '#d6f77a' : '#30363d',
            background: mode === 'openlibrary' ? 'rgba(214, 247, 122, 0.14)' : '#161b22',
            color: mode === 'openlibrary' ? '#d6f77a' : '#8b949e', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          Open Library
        </button>
        {mode === 'archive' && (
          <select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            aria-label="archive.org collection"
            style={{ padding: '7px 10px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '999px', color: '#c9d1d9', fontSize: '12.5px' }}
          >
            {ARCHIVE_COLLECTIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <button
          onClick={() => openSafeExternalUrl(mode === 'archive' ? 'https://archive.org' : 'https://openlibrary.org')}
          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '7px 12px', borderRadius: '999px', border: '1px solid #30363d', background: '#161b22', color: '#8b949e', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
        >
          <ExternalLink size={11} /> {mode === 'archive' ? 'archive.org' : 'openlibrary.org'}
        </button>
      </div>

      {mode === 'openlibrary' && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {OPEN_LIBRARY_SUBJECTS.map((subject) => (
            <button
              key={subject}
              onClick={() => { setInput(subject); setSubmitted(subject); }}
              style={{
                padding: '5px 12px', borderRadius: '999px', border: '1px solid #30363d',
                background: '#161b22', color: '#c9d1d9', fontSize: '12px', cursor: 'pointer',
              }}
            >
              {subject}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <form
        onSubmit={(e) => { e.preventDefault(); setSubmitted(input.trim()); }}
        style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}
      >
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={16} color="#8b949e" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'archive' ? `Search ${collection.name}…` : 'Search Open Library (title, author)…'}
            style={{ width: '100%', padding: '11px 12px 11px 36px', background: '#0d1117', border: '1px solid #30363d', borderRadius: '10px', color: '#c9d1d9', fontSize: '13.5px', boxSizing: 'border-box' }}
          />
        </div>
        <button type="submit" style={{ padding: '0 18px', borderRadius: '10px', border: 'none', background: '#d6f77a', color: '#1a1d13', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
          Search
        </button>
      </form>

      {/* External aggregator reference cards (not integrated — site links only) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <BookOpen size={16} color="#8b949e" />
          <span style={{ color: '#8b949e', fontSize: '12.5px', flex: 1, minWidth: 180 }}>
            <strong style={{ color: '#c9d1d9' }}>Anna's Archive</strong> is a shadow-library aggregator, so PRAHA does not
            integrate its search or downloads. The Internet Archive sources above cover folkscanomy and millions of public texts.
          </span>
          <button
            onClick={() => openSafeExternalUrl('https://annas-archive.org')}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            <ExternalLink size={12} /> Open site
          </button>
        </div>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <BookOpen size={16} color="#8b949e" />
          <span style={{ color: '#8b949e', fontSize: '12.5px', flex: 1, minWidth: 180 }}>
            <strong style={{ color: '#c9d1d9' }}>OceanofPDF</strong> distributes copyrighted ebooks without authorization,
            so it is linked as an external site only — not scraped or downloaded through PRAHA.
          </span>
          <button
            onClick={() => openSafeExternalUrl('https://theoceanofpdf.com/')}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
          >
            <ExternalLink size={12} /> Open site
          </button>
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(248, 113, 113, 0.1)', border: '1px solid rgba(248, 113, 113, 0.3)', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', color: '#f87171', fontSize: '13px' }}>
          <CircleAlert size={15} /> {error}
          <button onClick={() => void load(1, false)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#c9d1d9', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      )}

      <ContinueShelf
        entries={continueEntries}
        onResume={resumeBook}
        onDismiss={(entry) => {
          removeContinue('book', entry.id);
          setContinueEntries(readContinue('book'));
        }}
      />
      {loading ? (
        <SkeletonGrid count={12} label="Loading books…" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? '140px' : '170px'}, 1fr))`, gap: '12px' }}>
          {items.map((item) => (
            <div key={item.id} style={cardStyle} onClick={() => void openItem(item)} role="button" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && void openItem(item)}>
              <BookCover item={item} />
              <div style={{ padding: '10px 12px 12px' }}>
                <strong style={{ color: '#f0f6fc', fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as never }}>
                  {item.title}
                </strong>
                <span style={{ color: '#8b949e', fontSize: '11.5px', display: 'block', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.authors.join(', ') || (item.source === 'archive' ? 'archive.org' : 'Open Library')}
                </span>
                {item.year && <span style={{ color: '#6e7681', fontSize: '11px' }}>{item.year}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasMore && !loading && (
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button
            onClick={() => void load(page + 1, true)}
            disabled={loadingMore}
            style={{ padding: '9px 22px', borderRadius: '10px', border: '1px solid #30363d', background: '#21262d', color: '#f0f6fc', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
          >
            {loadingMore ? <LoaderCircle size={15} className="spin" /> : 'Load more'}
          </button>
        </div>
      )}

      {/* Item detail overlay */}
      {selected && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && setSelected(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(1, 4, 9, 0.8)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px' }}
        >
          <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: '14px', maxWidth: '520px', width: '100%', padding: '18px', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
              <strong style={{ color: '#f0f6fc', fontSize: '16px' }}>{selected.title}</strong>
              <button onClick={() => setSelected(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            {selected.authors.length > 0 && <p style={{ color: '#8b949e', fontSize: '13px', margin: '0 0 4px' }}>{selected.authors.join(', ')}</p>}
            {selected.year && <p style={{ color: '#6e7681', fontSize: '12px', margin: '0 0 12px' }}>First published {selected.year}</p>}

            {filesLoading && <p style={{ color: '#8b949e', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}><LoaderCircle size={14} className="spin" /> Loading files…</p>}
            {filesError && <p style={{ color: '#f87171', fontSize: '13px' }}>{filesError}</p>}

            {files && files.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0' }}>
                {files.map((file) => (
                  <button
                    key={file.name}
                    onClick={() => openSafeExternalUrl(file.url)}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '11px 12px', borderRadius: '10px', border: '1px solid #30363d', background: '#161b22', color: '#f0f6fc', fontSize: '13px', cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 220 }}
                  >
                    <FileDown size={16} color="#d6f77a" />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                    <span style={{ color: '#8b949e', fontSize: '11.5px' }}>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</span>
                  </button>
                ))}
              </div>
            )}

            {selected.identifier && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setReaderItem(selected)}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', border: 'none', background: '#d6f77a', color: '#1a1d13', fontSize: '12.5px', fontWeight: 700, cursor: 'pointer' }}
                >
                  <BookOpen size={13} /> Read online
                </button>
                <button
                  onClick={() => openSafeExternalUrl(BooksService.detailsUrl(selected.identifier!))}
                  style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}
                >
                  <ExternalLink size={12} /> archive.org page
                </button>
              </div>
            )}
            {selected.openLibraryKey && (
              <button
                onClick={() => openSafeExternalUrl(BooksService.workUrl(selected.openLibraryKey!))}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', marginTop: '8px' }}
              >
                <ExternalLink size={12} /> Open Library page
              </button>
            )}
          </div>
        </div>
      )}

      {/* In-app Read Online (OMLE) — archive.org BookReader embed */}
      {readerItem?.identifier && (
        <ArchiveReader
          identifier={readerItem.identifier}
          title={readerItem.title}
          onClose={() => setReaderItem(null)}
        />
      )}
    </div>
  );
};

export default BooksView;
