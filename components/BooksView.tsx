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
import { BookracyService } from '../services/bookracyService';
import { readContinue, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';
import './books-view.css';

type SourceMode = 'openlibrary' | 'archive' | 'bookracy';

/** Open Library quick subjects (openlibrary.org/subjects/...). */
const OPEN_LIBRARY_SUBJECTS = [
  'Classics', 'Science Fiction', 'Fantasy', 'Mystery', 'Romance', 'Horror',
  'History', 'Philosophy', 'Manga', 'Comics', 'Poetry', 'Biography',
];

/** Compact chip label per source mode (full names stay next to the search bar). */
const SOURCE_LABEL: Record<SourceMode, string> = {
  archive: 'Archive.org',
  openlibrary: 'Open Library',
  bookracy: 'Bookracy',
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
    <div className="book-cover">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setCandidateIdx((idx) => idx + 1)}
        />
      ) : (
        <BookOpen size={30} />
      )}
    </div>
  );
};

const BookCard: React.FC<{ item: BookItem; onOpen: (item: BookItem) => void }> = ({ item, onOpen }) => {
  const sourceBadge = item.source === 'openlibrary' ? 'OL' : item.id.startsWith('bookracy-') ? 'Bookracy' : 'IA';
  return (
    <article className="book-card">
      <button
        type="button"
        className="book-card-open"
        onClick={() => onOpen(item)}
        onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}
        aria-label={`Open ${item.title}`}
      >
        <div className="book-poster">
          <BookCover item={item} />
          <span className="book-source-badge">{sourceBadge}</span>
        </div>
        <div className="book-copy">
          <h3 title={item.title}>{item.title}</h3>
          <p>{item.authors.join(', ') || (item.source === 'archive' ? 'archive.org' : 'Open Library')}</p>
          {item.year && <span>{item.year}</span>}
        </div>
      </button>
    </article>
  );
};

/**
 * Books tab: Open Library + Internet Archive search, folkscanomy collections,
 * Bookracy catalog with curated shelves, downloadable pdf/epub/cbz files.
 * Anna's Archive / OceanofPDF are offered as external site links only —
 * PRAHA does not integrate shadow-library search or downloads.
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

  // Bookracy curated shelves (home rails before a search narrows things down).
  const [shelves, setShelves] = useState<Array<{ label: string; items: BookItem[] }>>([]);
  const [shelvesLoading, setShelvesLoading] = useState(false);
  const loadShelves = useCallback(async () => {
    if (mode !== 'bookracy') return;
    setShelvesLoading(true);
    try {
      const rows = await BookracyService.featuredCategories();
      // Empty rows mean the API answered but everything failed — still fine,
      // the shelves just don't render.
      setShelves(rows.filter((row) => row.items.length > 0));
    } catch {
      setShelves([]);
    } finally {
      setShelvesLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode === 'bookracy' && !submitted) void loadShelves();
    else setShelves([]);
  }, [mode, submitted, loadShelves]);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) setError('');
    const collection = ARCHIVE_COLLECTIONS.find((c) => c.id === collectionId) || ARCHIVE_COLLECTIONS[0];
    try {
      const result = mode === 'archive'
        ? await BooksService.searchArchive(submitted, collection, nextPage)
        : mode === 'bookracy'
          ? await BookracyService.search(submitted || 'fantasy', nextPage, 24)
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
  const showShelves = mode === 'bookracy' && !submitted && shelves.length > 0;

  return (
    <div className="standard-page page-enter books-page">
      <div className="books-hero">
        <span className="books-hero-tile" aria-hidden="true"><Library size={22} /></span>
        <div>
          <span className="page-kicker">EBOOKS · COMICS · PAPERBACKS</span>
          <h1>Books</h1>
          <p>Millions of free texts from archive.org &amp; Open Library, plus Bookracy downloads — read online or save pdf / epub / cbz.</p>
        </div>
      </div>

      <ContinueShelf
        entries={continueEntries}
        onResume={resumeBook}
        onDismiss={(entry) => {
          removeContinue('book', entry.id);
          setContinueEntries(readContinue('book'));
        }}
      />

      <div className="books-toolbar">
        <div className="filter-pills" role="tablist" aria-label="Book source">
          {(Object.keys(SOURCE_LABEL) as SourceMode[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              className={mode === key ? 'active' : ''}
              onClick={() => setMode(key)}
            >
              {SOURCE_LABEL[key]}
            </button>
          ))}
        </div>
        {mode === 'archive' && (
          <label className="source-select">
            <span className="books-sr-only">archive.org collection</span>
            <select
              aria-label="archive.org collection"
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
            >
              {ARCHIVE_COLLECTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="text-button books-external-link"
          onClick={() => openSafeExternalUrl(mode === 'archive' ? 'https://archive.org' : mode === 'openlibrary' ? 'https://openlibrary.org' : 'https://bookracy.com')}
        >
          <ExternalLink size={12} /> {SOURCE_LABEL[mode]} site
        </button>
      </div>

      {mode === 'openlibrary' && (
        <div className="books-subject-rail">
          {OPEN_LIBRARY_SUBJECTS.map((subject) => (
            <button
              key={subject}
              type="button"
              className={`books-subject-chip ${submitted === subject ? 'active' : ''}`}
              onClick={() => { setInput(subject); setSubmitted(subject); }}
            >
              {subject}
            </button>
          ))}
        </div>
      )}

      <form className="books-search" onSubmit={(e) => { e.preventDefault(); setSubmitted(input.trim()); }}>
        <div className="books-search-field">
          <Search size={15} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === 'archive' ? `Search ${collection.name}…` : mode === 'bookracy' ? 'Search Bookracy (title, author)…' : 'Search Open Library (title, author)…'}
            aria-label="Search books"
          />
          {input && (
            <button type="button" className="search-clear" aria-label="Clear book search" onClick={() => { setInput(''); setSubmitted(''); }}>
              ×
            </button>
          )}
        </div>
        <button className="button button-primary button-small" type="submit" disabled={loading}>Search</button>
      </form>

      {error && (
        <div className="books-error" role="alert">
          <CircleAlert size={15} /> {error}
          <button onClick={() => void load(1, false)}>
            <RefreshCw size={13} /> Retry
          </button>
        </div>
      )}

      {/* Shadow-library notice: external sites only, never integrated */}
      <div className="books-notice">
        <BookOpen size={14} />
        <span>
          <strong>Anna's Archive</strong> is a shadow-library aggregator and <strong>OceanofPDF</strong> distributes
          unauthorized ebook copies — both are linked as external sites only.
        </span>
        <button type="button" className="button button-secondary button-small" onClick={() => openSafeExternalUrl('https://annas-archive.org')}>
          Anna's Archive
        </button>
        <button type="button" className="button button-secondary button-small" onClick={() => openSafeExternalUrl('https://theoceanofpdf.com/')}>
          OceanofPDF
        </button>
      </div>

      {showShelves && (
        <div className="books-shelves">
          {shelvesLoading && <p className="sanka-inline-status"><LoaderCircle size={15} className="spin" /> Loading curated shelves…</p>}
          {shelves.map((shelf) => (
            <section key={shelf.label} className="books-shelf">
              <h2>{shelf.label}</h2>
              <div className="books-shelf-row">
                {shelf.items.map((item) => (
                  <BookCard key={item.id} item={item} onOpen={(book) => void openItem(book)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {loading ? (
        <SkeletonGrid count={12} label="Loading books…" />
      ) : (
        <div className={`books-grid ${compact ? 'books-grid-compact' : ''}`}>
          {items.map((item) => (
            <BookCard key={item.id} item={item} onOpen={(book) => void openItem(book)} />
          ))}
        </div>
      )}

      {hasMore && !loading && (
        <div className="books-load-more">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void load(page + 1, true)}
            disabled={loadingMore}
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
        >
          <section className="books-sheet" role="dialog" aria-modal="true" aria-label={selected.title}>
            <button className="modal-close floating" onClick={() => setSelected(null)} aria-label="Close">
              <X size={18} />
            </button>
            <div className="books-sheet-head">
              <BookCover item={selected} />
              <div>
                <span className="page-kicker">{selected.source === 'openlibrary' ? 'OPEN LIBRARY' : selected.id.startsWith('bookracy-') ? 'BOOKRACY' : 'INTERNET ARCHIVE'}</span>
                <h2>{selected.title}</h2>
                {selected.authors.length > 0 && <p className="books-sheet-authors">{selected.authors.join(', ')}</p>}
                {selected.year && <span className="books-sheet-year">First published {selected.year}</span>}
              </div>
            </div>

            {filesLoading && <p className="sanka-inline-status"><LoaderCircle size={15} className="spin" /> Loading files…</p>}
            {filesError && <p className="sanka-inline-error" role="alert">{filesError}</p>}

            {files && files.length > 0 && (
              <div className="books-sheet-files">
                {files.map((file) => (
                  <button
                    key={file.name}
                    className="books-sheet-file"
                    onClick={() => openSafeExternalUrl(file.url)}
                  >
                    <FileDown size={16} />
                    <span>{file.name}</span>
                    <small>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</small>
                  </button>
                ))}
              </div>
            )}

            <div className="books-sheet-actions">
              {selected.identifier && (
                <>
                  <button type="button" className="button button-primary" onClick={() => setReaderItem(selected)}>
                    <BookOpen size={14} /> Read online
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => openSafeExternalUrl(BooksService.detailsUrl(selected.identifier!))}>
                    <ExternalLink size={13} /> archive.org page
                  </button>
                </>
              )}
              {selected.openLibraryKey && (
                <button type="button" className="button button-secondary" onClick={() => openSafeExternalUrl(BooksService.workUrl(selected.openLibraryKey!))}>
                  <ExternalLink size={13} /> Open Library page
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {/* In-app Read Online — native archive.org leaf reader */}
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
