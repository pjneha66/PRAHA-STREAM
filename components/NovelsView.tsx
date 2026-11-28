import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { loadNovelChapters, loadNovelText, NOVEL_SOURCES, searchNovels, type Novel, type NovelChapter, type NovelSource } from '../services/novelService';
import { ecoNovelChapters, ecoNovelSearch, ecoNovelText, installedReadingExtensions } from '../services/ecosystems/reading';
import type { EcosystemExtension } from '../services/ecosystems/store';
import type { NsfwMode } from '../types';

/** An ecosystem source in the picker: `eco:<extension key>`. */
type EcoNovelSource = `eco:${string}`;

const novelExtensionOf = (key: string | undefined | null, mode?: NsfwMode): EcosystemExtension | null =>
  key ? installedReadingExtensions('novel', mode).find((entry) => entry.key === key) ?? null : null;
import ReadingSourceDirectory from './ReadingSourceDirectory';
import ReaderZoomControls from './ReaderZoomControls';
import { Artwork } from './MediaCard';
import './novels-view.css';

function getSavedChapter(novel: Novel) {
  try {
    return JSON.parse(localStorage.getItem(`praha.novel.chapter:${novel.url}`) || 'null') as { url: string; page: number } | null;
  } catch { return null; }
}

export default function NovelsView({ extensionOnly = false, heading = 'Novels', adultMode }: {
  extensionOnly?: boolean;
  heading?: 'Books' | 'Novels';
  adultMode?: NsfwMode;
} = {}) {
  const extensions = installedReadingExtensions('novel', adultMode);
  const [source, setSource] = useState<NovelSource | EcoNovelSource>(() =>
    extensionOnly ? `eco:${extensions[0]?.key ?? ''}` : 'readnovelfull');

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
    const ecoExtension = novelExtensionOf(source.startsWith('eco:') ? source.slice(4) : null, adultMode);
    const loader = ecoExtension
      ? ecoNovelSearch(ecoExtension, search, page)
      : source.startsWith('eco:') ? Promise.reject(new Error('This extension is unavailable.'))
        : searchNovels(source as NovelSource, search, page);
    loader.then((result) => {
      if (!active) return;
      setItems((previous) => page === 1 ? result.items : [...previous, ...result.items]);
      setHasMore(result.hasMore);
    }).catch(() => { if (active) setError('Could not load this novel catalog.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source, search, page, adultMode]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setChapters([]);
    setChapterError('');
    const ecoExtension = novelExtensionOf(selected.ecoKey, adultMode);
    const loader = ecoExtension
      ? ecoNovelChapters(ecoExtension, selected.url).then((items) => ({ items, pageCount: 1 }))
      : selected.ecoKey ? Promise.reject(new Error('This extension is unavailable.'))
        : loadNovelChapters(selected, chapterPage);
    loader.then((result) => {
      if (!active) return;
      setChapters(result.items);
      setChapterPages(result.pageCount);
      if (!result.items.length) setChapterError('This novel has no readable chapters.');
    }).catch(() => { if (active) setChapterError('Could not load the chapters.'); });
    return () => { active = false; };
  }, [selected, chapterPage, adultMode]);

  const chapter = chapterIndex === null ? undefined : chapters[chapterIndex];
  useEffect(() => {
    if (!selected || !chapter) return;
    let active = true;
    setParagraphs([]);
    setChapterError('');
    if (reader.current) reader.current.scrollTop = 0;
    const ecoExtension = novelExtensionOf(chapter.ecoKey, adultMode);
    const loader = ecoExtension
      ? ecoNovelText(ecoExtension, chapter.url)
      : chapter.ecoKey ? Promise.reject(new Error('This extension is unavailable.'))
        : loadNovelText(chapter);
    loader.then((text) => {
      if (!active) return;
      setParagraphs(text);
      try { localStorage.setItem(`praha.novel.chapter:${selected.url}`, JSON.stringify({ url: chapter.url, page: chapterPage })); } catch { /* Reading remains available. */ }
    }).catch((reason: unknown) => { if (active) setChapterError(reason instanceof Error ? reason.message : 'Could not open the chapter.'); });
    return () => { active = false; };
  }, [chapter, selected, chapterPage, adultMode]);

  const openNovel = (novel: Novel) => {
    setError('');
    setChapters([]);
    setChapterError('');
    setChapterIndex(null);
    setChapterPage(getSavedChapter(novel)?.page || 1);
    setChapterPages(1);
    setSelected(novel);
  };

  const chooseSource = (next: NovelSource | EcoNovelSource) => {
    if (source !== next) { setSource(next); setPage(1); setItems([]); }
  };
  const resume = selected ? chapters.findIndex((entry) => entry.url === getSavedChapter(selected)?.url) : -1;
  return (
    <div className="standard-page page-enter books-page reading-page">
      <h1 className="reading-heading">{heading}</h1>
      <form className="sanka-search reading-search" onSubmit={(event) => {
        event.preventDefault();
        if (query.trim() !== search || page !== 1) { setItems([]); setSearch(query.trim()); setPage(1); }
      }}>
        <Search size={16} />
        <input type="search" aria-label={`Search ${heading.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${heading.toLowerCase()}`} />
        <button type="submit" className="button button-primary">Search</button>
      </form>
      <div className="reading-controls">
        <select className="reading-select" aria-label="Novel source" value={source} onChange={(event) => chooseSource(event.target.value as NovelSource | EcoNovelSource)}>
          {!extensionOnly && Object.entries(NOVEL_SOURCES).map(([id, site]) => <option key={id} value={id}>{site.label}</option>)}
          {extensions.map((entry) => (
            <option key={entry.key} value={`eco:${entry.key}`}>{entry.name} (extension)</option>
          ))}
        </select>
        {!extensionOnly && <details className="reading-options">
          <summary>Source directories</summary>
          <ReadingSourceDirectory repository="lnreader" readers={{ 'The Wandering Inn': () => chooseSource('wanderinginn') }} />
          <ReadingSourceDirectory repository="ireader" readers={{ 'Standard Ebooks': () => chooseSource('standardebooks') }} />
        </details>}
      </div>
      {loading && <p role="status">Loading novels…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !items.length && <p>No English novels found.</p>}
      <div className="novel-grid">
        {items.map((novel, index) => (
          <button type="button" key={novel.url} className="novel-card" onClick={() => openNovel(novel)}>
            <span className="novel-cover" aria-hidden="true"><Artwork src={novel.cover} alt={novel.title} priority={index < 2} /></span>
            <strong>{novel.title}</strong>
            {novel.author && <small>{novel.author}</small>}
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
