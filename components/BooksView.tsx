import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, CircleAlert, ExternalLink, FileDown, Library, LoaderCircle, RefreshCw, Search, X,
} from 'lucide-react';
import {
  ALL_ARCHIVE_TEXTS, ARCHIVE_COLLECTIONS, BooksService, canReadBookFile, type BookFile, type BookItem,
} from '../services/archiveService';
import { openArchiveLoan, openPublicationUrl, openReaderFile, openSafeExternalUrl } from '../services/androidBridge';
import ArchiveReader from './ArchiveReader';
import ArchiveBorrowButton from './ArchiveBorrowButton';
import SkeletonGrid from './SkeletonGrid';
import ContinueShelf from './ContinueShelf';
import { BookracyService } from '../services/bookracyService';
import { readContinue, readScanPage, recordContinue, removeContinue, type ContinueEntry } from '../services/continueStore';
import { loadComicBookSite, loadPublicationFiles } from '../services/comicBookSites';
import './books-view.css';

type PublicationSite = 'annasarchive' | 'oceanofpdf';
type Catalog = 'openlibrary' | 'archive' | 'bookracy' | PublicationSite;
const isPublicationSite = (source: string): source is PublicationSite => source === 'annasarchive' || source === 'oceanofpdf';
type SourceMode = Catalog | 'all';
const CATALOGS: Catalog[] = ['archive', 'openlibrary', 'bookracy', 'annasarchive', 'oceanofpdf'];
const SITE_URLS: Partial<Record<Catalog, string>> = { archive: 'https://archive.org', openlibrary: 'https://openlibrary.org', bookracy: 'https://bookracy.com' };

function mergeBooks(current: BookItem[], incoming: BookItem[]): BookItem[] {
  const byEdition = new Map(current.map((book) => [book.identifier || book.id, book]));
  for (const book of incoming) {
    const key = book.identifier || book.id;
    const existing = byEdition.get(key);
    byEdition.set(key, existing
      ? { ...existing, openLibraryKey: existing.openLibraryKey || book.openLibraryKey, restricted: existing.restricted || book.restricted }
      : book);
  }
  return [...byEdition.values()];
}

/** Open Library quick subjects (openlibrary.org/subjects/...). */
const OPEN_LIBRARY_SUBJECTS = [
  'Classics', 'Science Fiction', 'Fantasy', 'Mystery', 'Romance', 'Horror',
  'History', 'Philosophy', 'Manga', 'Comics', 'Poetry', 'Biography',
];

/** Compact chip label per source mode (full names stay next to the search bar). */
const SOURCE_LABEL: Record<SourceMode, string> = {
  all: 'All catalogs',
  archive: 'Archive.org',
  openlibrary: 'Open Library',
  bookracy: 'Bookracy',
  annasarchive: 'Anna’s Archive',
  oceanofpdf: 'OceanofPDF',
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
    const title = item.title.trim();
    // Direct covers.openlibrary.org URLs HANG (no error event) on constrained
    // networks, so every OL candidate goes through the wsrv.nl image proxy —
    // it fetches the upstream server-side and 404s quickly when a cover is
    // missing (default=false), letting the chain advance.
    if (item.coverUrl) {
      const olCover = item.coverUrl.replace('?default=false', '');
      list.push(`https://wsrv.nl/?url=${encodeURIComponent(`${olCover}?default=false`)}`);
    }
    // OL editions frequently have no scan of their own — the title-based cover
    // API almost always has one (verified: The Secret Garden cover_i 404s but
    // /b/title/ serves a real 291×400 JPEG).
    if (title) {
      list.push(`https://wsrv.nl/?url=${encodeURIComponent(`https://covers.openlibrary.org/b/title/${encodeURIComponent(title)}-L.jpg?default=false`)}`);
    }
    if (item.identifier) list.push(`https://archive.org/services/img/${item.identifier}`);
    return list;
  }, [item.coverUrl, item.identifier, item.title]);

  const advance = () => setCandidateIdx((idx) => idx + 1);
  const url = candidates[candidateIdx];
  return (
    <div className="book-cover">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          // wsrv.nl happily proxies OL's blank cover as a 1×1 without an error
          // event — treat tiny images as failures and keep walking the chain.
          onLoad={(event) => {
            if (event.currentTarget.naturalWidth <= 2) advance();
          }}
          onError={advance}
        />
      ) : (
        <BookOpen size={30} />
      )}
    </div>
  );
};

const BookCard: React.FC<{ item: BookItem; onOpen: (item: BookItem) => void }> = ({ item, onOpen }) => {
  const sourceBadge = isPublicationSite(item.source) ? SOURCE_LABEL[item.source] : item.source === 'openlibrary'
    ? 'OL'
    : item.id.startsWith('bookracy-')
      ? 'Bookracy'
      : item.restricted ? 'IA · 🔒' : 'IA';
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
          <p>{item.authors.join(', ') || SOURCE_LABEL[item.source]}</p>
          {item.year && <span>{item.year}</span>}
        </div>
      </button>
    </article>
  );
};

const BooksView: React.FC<{ compact?: boolean; prefillQuery?: string }> = ({ compact, prefillQuery }) => {
  const [mode, setMode] = useState<SourceMode>('all');
  const [collectionId, setCollectionId] = useState<string>(ARCHIVE_COLLECTIONS[1].id);
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [items, setItems] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pages = useRef<Partial<Record<Catalog, number>>>({});
  const [hasMore, setHasMore] = useState(false);
  const [unavailable, setUnavailable] = useState<Catalog[]>([]);
  const [siteError, setSiteError] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<BookItem | null>(null);
  const [files, setFiles] = useState<BookFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [readerItem, setReaderItem] = useState<BookItem | null>(null);
  const requestSeq = useRef(0);
  const fileSeq = useRef(0);
  const [continueEntries, setContinueEntries] = useState<ContinueEntry[]>(() => readContinue('book'));

  // Bookracy curated shelves (home rails before a search narrows things down).
  const [shelves, setShelves] = useState<Array<{ label: string; items: BookItem[] }>>([]);
  const [shelvesLoading, setShelvesLoading] = useState(false);
  useEffect(() => {
    if (mode !== 'bookracy' || submitted || loading || !items.length || unavailable.length) {
      setShelves([]);
      setShelvesLoading(false);
      return;
    }
    let active = true;
    setShelvesLoading(true);
    void BookracyService.featuredCategories().then((rows) => {
      if (active) setShelves(rows);
    }).finally(() => { if (active) setShelvesLoading(false); });
    return () => { active = false; };
  }, [mode, submitted, loading, items.length > 0, unavailable.length]);

  const load = useCallback(async (append = false) => {
    const seq = ++requestSeq.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setError('');
      setUnavailable([]);
      setHasMore(false);
      setItems([]);
      pages.current = mode === 'all'
        ? submitted ? { archive: 1, openlibrary: 1, bookracy: 1 } : { archive: 1 }
        : { [mode]: 1 };
    }
    const collection = mode === 'all' && submitted
      ? ALL_ARCHIVE_TEXTS
      : ARCHIVE_COLLECTIONS.find((entry) => entry.id === collectionId) || ARCHIVE_COLLECTIONS[0];
    const activeCatalogs = CATALOGS.filter((catalog) => pages.current[catalog] !== undefined);
    const results = await Promise.allSettled(activeCatalogs.map(async (catalog) => {
      const page = pages.current[catalog]!;
      const site = isPublicationSite(catalog) ? await loadComicBookSite(catalog, submitted, 'en', page, true) : null;
      const books: BookItem[] = site && isPublicationSite(catalog)
        ? site.items.map((item) => ({ id: item.id, title: item.title, authors: [], source: catalog, sourceUrl: item.sourceUrl, coverUrl: item.poster }))
        : await (catalog === 'archive'
        ? BooksService.searchArchive(submitted, collection, page)
        : catalog === 'openlibrary'
          ? BooksService.searchOpenLibrary(submitted || 'classics', page)
          : BookracyService.search(submitted || 'fantasy', page));
      if (seq === requestSeq.current) {
        setItems((current) => mergeBooks(current, books));
        if (books.length) setLoading(false);
        if (site ? !site.hasMore : books.length < 24) delete pages.current[catalog];
        else pages.current[catalog] = page + 1;
      }
      return books;
    }));
    if (seq !== requestSeq.current) return;

    const failed = activeCatalogs.filter((_, index) => results[index].status === 'rejected');
    const hasResults = results.some((result) => result.status === 'fulfilled' && result.value.length > 0);
    setUnavailable(failed);
    setHasMore(CATALOGS.some((catalog) => !failed.includes(catalog) && pages.current[catalog] !== undefined));
    if (!append && !hasResults && !failed.length) setError(submitted ? 'No books matched that search.' : 'Nothing found. Try a search.');
    setLoading(false);
    setLoadingMore(false);
  }, [mode, collectionId, submitted]);

  useEffect(() => {
    void load();
    return () => { requestSeq.current += 1; };
  }, [load]);

  // Universal-search deep link: a query issued in Discover lands here pre-filled.
  const appliedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const term = (prefillQuery || '').trim();
    if (!term || appliedPrefillRef.current === term) return;
    appliedPrefillRef.current = term;
    setMode('all');
    setInput(term);
    setSubmitted(term);
  }, [prefillQuery]);

  const rememberBook = useCallback((item: BookItem, page?: number) => {
    recordContinue({
      domain: 'book',
      id: item.identifier || item.id,
      title: item.title,
      cover: item.coverUrl,
      detail: page === undefined ? item.authors[0] : `Page ${page + 1}`,
      payload: {
        identifier: item.identifier,
        openLibraryKey: item.openLibraryKey,
        downloadUrl: item.downloadUrl,
        source: item.source,
        sourceUrl: item.sourceUrl,
        authors: item.authors,
        year: item.year,
        restricted: item.restricted,
      },
    });
    setContinueEntries(readContinue('book'));
  }, []);

  const openItem = async (item: BookItem) => {
    const seq = ++fileSeq.current;
    setSelected(item);
    setFiles(null);
    setFilesError('');
    setFilesLoading(Boolean((item.identifier && !item.restricted) || item.sourceUrl));
    if (isPublicationSite(item.source) && item.sourceUrl) {
      try {
        const list = await loadPublicationFiles(item.source, item.sourceUrl);
        if (seq !== fileSeq.current) return;
        setFiles(list);
        if (!list.length) setFilesError('This listing does not provide a direct reader file.');
        else rememberBook(item);
      } catch {
        if (seq === fileSeq.current) setFilesError('Could not load the reader files.');
      } finally {
        if (seq === fileSeq.current) setFilesLoading(false);
      }
      return;
    }
    if (!item.identifier || item.restricted) {
      rememberBook(item);
      return;
    }
    try {
      const list = await BooksService.itemFiles(item.identifier);
      if (seq === fileSeq.current) setFiles(list);
    } catch (err) {
      if (seq === fileSeq.current) setFilesError(err instanceof Error ? err.message : 'Could not load the file list.');
    } finally {
      if (seq === fileSeq.current) setFilesLoading(false);
    }
  };

  const resumeBook = (entry: ContinueEntry) => {
    const payload = (entry.payload || {}) as Partial<BookItem>;
    const item: BookItem = {
      id: entry.id,
      title: entry.title,
      authors: payload.authors || [],
      year: payload.year,
      restricted: payload.restricted,
      coverUrl: entry.cover,
      identifier: payload.identifier,
      openLibraryKey: payload.openLibraryKey,
      downloadUrl: payload.downloadUrl,
      source: payload.source || 'archive',
      sourceUrl: payload.sourceUrl,
    };
    if (item.identifier && !item.restricted) setReaderItem(item);
    else void openItem(item);
  };

  const recordPage = useCallback((page: number) => {
    if (readerItem) rememberBook(readerItem, page);
  }, [readerItem, rememberBook]);

  const openSite = async (url: string) => {
    setSiteError('');
    const opened = await openPublicationUrl(url);
    if (!opened) setSiteError('Could not open this site. Try again.');
  };

  const openFile = async (file: BookFile) => {
    const opened = await openReaderFile(file.url);
    setFilesError(opened ? '' : 'Could not start the Android reader.');
  };

  const findOtherCopies = (book: BookItem) => {
    setSelected(null);
    setMode('all');
    setInput(book.title);
    if (submitted !== book.title) setSubmitted(book.title);
    else if (mode === 'all') void load();
  };

  const showShelves = mode === 'bookracy' && !submitted && (shelvesLoading || shelves.length > 0);
  const savedPage = selected?.identifier ? readScanPage(selected.identifier) : undefined;

  return (
    <div className="standard-page page-enter books-page">
      <div className="books-hero">
        <span className="books-hero-tile" aria-hidden="true"><Library size={22} /></span>
        <div>
          <span className="page-kicker">EBOOKS · COMICS · PAPERBACKS</span>
          <h1>Books</h1>
          <p>Search by title, author, or ISBN.</p>
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
        {mode !== 'all' && SITE_URLS[mode] && <button
          type="button"
          className="text-button books-external-link"
          onClick={() => mode === 'openlibrary' ? void openSite(SITE_URLS[mode]!) : void openSafeExternalUrl(SITE_URLS[mode]!)}
        >
          <ExternalLink size={12} /> {SOURCE_LABEL[mode]} site
        </button>}
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

      <form className="books-search" onSubmit={(e) => {
        e.preventDefault();
        const term = input.trim();
        if (term === submitted) void load();
        else setSubmitted(term);
      }}>
        <div className="books-search-field">
          <Search size={15} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Title, author, or ISBN"
            aria-label="Search books"
            maxLength={200}
          />
          {input && (
            <button type="button" className="search-clear" aria-label="Clear book search" onClick={() => { setInput(''); setSubmitted(''); }}>
              ×
            </button>
          )}
        </div>
        <button className="button button-primary button-small" type="submit">Search</button>
      </form>

      {(error || unavailable.length > 0) && (
        <div className="books-error" role="status">
          <CircleAlert size={15} />
          {error || `${unavailable.map((catalog) => SOURCE_LABEL[catalog]).join(', ')} unavailable.`}
          {unavailable.length > 0 && (
            <button type="button" onClick={() => void load(items.length > 0)} disabled={loadingMore}>
              <RefreshCw size={13} /> Retry
            </button>
          )}
          {mode === 'bookracy' && unavailable.length > 0 && (
            <button type="button" onClick={() => setMode('all')}>Search all catalogs</button>
          )}
        </div>
      )}

      {siteError && <p role="status">{siteError}</p>}

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
            onClick={() => void load(true)}
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
                {selected.restricted && <span className="books-sheet-year">Sign in to Internet Archive to borrow an available copy or join a waitlist if offered.</span>}
              </div>
            </div>

            {/* Actions first — on a phone the file list pushed "Read online"
                below the fold and it looked unreachable. */}
            <div className="books-sheet-actions">
              {selected.identifier && (
                <>
                  {!selected.restricted && (
                    <button type="button" className="button button-primary" onClick={() => setReaderItem(selected)}>
                      <BookOpen size={14} /> {savedPage === undefined ? 'Read online' : `Resume page ${savedPage + 1}`}
                    </button>
                  )}
                  {selected.restricted ? <ArchiveBorrowButton key={selected.identifier} identifier={selected.identifier} /> : (
                    <button type="button" className="button button-secondary" onClick={() => openArchiveLoan(BooksService.detailsUrl(selected.identifier!))}>
                      <ExternalLink size={13} /> archive.org page
                    </button>
                  )}
                </>
              )}
              {selected.restricted && (
                <button type="button" className="button button-secondary" onClick={() => findOtherCopies(selected)}>
                  <Search size={13} /> Find another copy
                </button>
              )}
              {selected.openLibraryKey && (
                <button type="button" className="button button-secondary" onClick={() => openSite(BooksService.workUrl(selected.openLibraryKey!))}>
                  <ExternalLink size={13} /> Open Library page
                </button>
              )}
              {selected.downloadUrl && (
                <button type="button" className="button button-primary" onClick={() => openSafeExternalUrl(selected.downloadUrl!)}>
                  <FileDown size={14} /> Download from Bookracy
                </button>
              )}
            </div>

            {filesLoading && <p className="sanka-inline-status"><LoaderCircle size={15} className="spin" /> Loading files…</p>}
            {filesError && <p className="sanka-inline-error" role="alert">{filesError}</p>}

            {files && files.length > 0 && (
              <div className="books-sheet-files">
                {files.map((file) => (
                  <button
                    key={file.name}
                    className="books-sheet-file"
                    onClick={() => isPublicationSite(selected.source) ? void openFile(file) : canReadBookFile(file) ? void openSite(file.url) : void openSafeExternalUrl(file.url)}
                  >
                    <FileDown size={16} />
                    <span>{file.name}</span>
                    <small>{file.format}{BooksService.formatSize(file.sizeBytes) ? ` · ${BooksService.formatSize(file.sizeBytes)}` : ''}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* In-app Read Online — native archive.org leaf reader */}
      {readerItem?.identifier && (
        <ArchiveReader
          key={readerItem.identifier}
          identifier={readerItem.identifier}
          title={readerItem.title}
          onPageRead={recordPage}
          onClose={() => setReaderItem(null)}
        />
      )}
    </div>
  );
};

export default BooksView;
