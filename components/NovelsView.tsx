import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { loadNovelChapters, loadNovelText, NOVEL_SOURCES, searchNovels, type Novel, type NovelChapter, type NovelSource } from '../services/novelService';
import ReaderZoomControls from './ReaderZoomControls';
import './novels-view.css';

function getSavedChapter(novel: Novel) {
  try {
    return JSON.parse(localStorage.getItem(`praha.novel.chapter:${novel.url}`) || 'null') as { url: string; page: number } | null;
  } catch { return null; }
}

export default function NovelsView() {
  const [source, setSource] = useState<NovelSource>('readnovelfull');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Novel[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<NovelChapter[]>([]);
  const [chapterPage, setChapterPage] = useState(1);
  const [chapterPages, setChapterPages] = useState(1);
  const [chapterIndex, setChapterIndex] = useState<number | null>(null);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [chapterError, setChapterError] = useState('');
  const [zoom, setZoom] = useState(1);
  const reader = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    searchNovels(source, search, page).then((result) => {
      if (!active) return;
      setItems((previous) => page === 1 ? result.items : [...previous, ...result.items]);
      setHasMore(result.hasMore);
    }).catch(() => { if (active) setError('Could not load this novel catalog.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source, search, page]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setChapters([]);
    setChapterError('');
    loadNovelChapters(selected, chapterPage).then((result) => {
      if (!active) return;
      setChapters(result.items);
      setChapterPages(result.pageCount);
      if (!result.items.length) setChapterError('This novel has no readable chapters.');
    }).catch(() => { if (active) setChapterError('Could not load the chapters.'); });
    return () => { active = false; };
  }, [selected, chapterPage]);

  const chapter = chapterIndex === null ? undefined : chapters[chapterIndex];
  useEffect(() => {
    if (!selected || !chapter) return;
    let active = true;
    setParagraphs([]);
    setChapterError('');
    if (reader.current) reader.current.scrollTop = 0;
    loadNovelText(chapter).then((text) => {
      if (!active) return;
      setParagraphs(text);
      try { localStorage.setItem(`praha.novel.chapter:${selected.url}`, JSON.stringify({ url: chapter.url, page: chapterPage })); } catch { /* Reading remains available. */ }
    }).catch((reason: unknown) => { if (active) setChapterError(reason instanceof Error ? reason.message : 'Could not open the chapter.'); });
    return () => { active = false; };
  }, [chapter, selected, chapterPage]);

  const openNovel = (novel: Novel) => {
    setError('');
    setChapters([]);
    setChapterError('');
    setChapterIndex(null);
    setChapterPage(getSavedChapter(novel)?.page || 1);
    setChapterPages(1);
    setSelected(novel);
  };

  const resume = selected ? chapters.findIndex((entry) => entry.url === getSavedChapter(selected)?.url) : -1;
  return (
    <div className="standard-page page-enter books-page">
      <div className="books-hero">
        <span className="books-hero-tile" aria-hidden="true"><BookOpen size={22} /></span>
        <div><h1>Novels</h1><p>Search and read English novels in PRAHA.</p></div>
      </div>
      <div className="comic-source-rail" role="tablist" aria-label="Novel source">
        {Object.entries(NOVEL_SOURCES).map(([id, site]) => (
          <button key={id} type="button" role="tab" aria-selected={source === id} className={`comic-source-chip${source === id ? ' active' : ''}`}
            onClick={() => { if (id !== source) { setSource(id as NovelSource); setPage(1); setItems([]); } }}>
            {site.label}
          </button>
        ))}
      </div>
      <form className="sanka-search" onSubmit={(event) => {
        event.preventDefault();
        if (query.trim() !== search || page !== 1) { setItems([]); setSearch(query.trim()); setPage(1); }
      }}>
        <Search size={16} />
        <input aria-label="Search novels" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search novels…" />
        <button type="submit" className="button button-primary">Search</button>
      </form>
      {loading && <p role="status">Loading novels…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !items.length && <p>No English novels found.</p>}
      <div className="novel-list">
        {items.map((novel) => (
          <button type="button" key={novel.url} className="button button-secondary" onClick={() => openNovel(novel)}>
            {novel.title}
          </button>
        ))}
      </div>
      {hasMore && !loading && !error && <button type="button" className="button button-secondary" onClick={() => setPage(page + 1)}>Load more</button>}
      {selected && createPortal(
        <div className="novel-dialog" role="dialog" aria-modal="true" aria-label={selected.title}>
          <header>
            {chapter && <button type="button" className="icon-button" onClick={() => setChapterIndex(null)} aria-label="Back to chapters"><ChevronLeft size={18} /></button>}
            <h2>{chapter?.title || selected.title}</h2>
            <button type="button" className="icon-button" onClick={() => setSelected(null)} aria-label="Close novel"><X size={18} /></button>
          </header>
          {chapter && chapterIndex !== null ? (
            <>
              <article ref={reader} className="novel-text" style={{ fontSize: `${zoom}rem` }}>
                {chapterError ? <p role="alert">{chapterError}</p> : paragraphs.length ? paragraphs.map((text, index) => <p key={index}>{text}</p>) : <p role="status">Loading chapter…</p>}
              </article>
              <footer>
                <button type="button" className="icon-button" disabled={chapterIndex === 0} onClick={() => setChapterIndex(chapterIndex - 1)} aria-label="Previous chapter"><ChevronLeft size={18} /></button>
                <ReaderZoomControls zoom={zoom} onChange={setZoom} />
                <button type="button" className="icon-button" disabled={chapterIndex === chapters.length - 1} onClick={() => setChapterIndex(chapterIndex + 1)} aria-label="Next chapter"><ChevronRight size={18} /></button>
              </footer>
            </>
          ) : (
            <div className="novel-list novel-chapters">
              {chapterError ? <p role="alert">{chapterError}</p> : !chapters.length && <p role="status">Loading chapters…</p>}
              {resume >= 0 && <button type="button" className="button button-primary" onClick={() => setChapterIndex(resume)}>Resume {chapters[resume].title}</button>}
              {chapterPages > 1 && <div className="novel-chapter-pages">
                <button type="button" className="button button-secondary" disabled={chapterPage === 1} onClick={() => setChapterPage(chapterPage - 1)}>Previous group</button>
                <span>{chapterPage} / {chapterPages}</span>
                <button type="button" className="button button-secondary" disabled={chapterPage >= chapterPages} onClick={() => setChapterPage(chapterPage + 1)}>Next group</button>
              </div>}
              {chapters.map((entry, index) => (
                <button type="button" key={entry.url} className="button button-secondary" onClick={() => setChapterIndex(index)}>{entry.title}</button>
              ))}
            </div>
          )}
        </div>, document.body,
      )}
    </div>
  );
}
