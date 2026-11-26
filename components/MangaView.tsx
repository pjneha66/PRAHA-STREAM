import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, LoaderCircle, RotateCcw, Search, X } from 'lucide-react';
import { MangaService, type MangaChapter, type MangaItem } from '../services/mangaService';
import MangaReader from './MangaReader';
import ChapterOrder, { compareChapters, useChapterOrder } from './ChapterOrder';
import ReadingSaveButton from './ReadingSaveButton';
import type { MangaSource, ReadingLibraryProps } from '../services/readingLibrary';
import { mangaDexCatalog, mangaDexDetail, mangaDexPages } from '../services/mangaDexService';
import { NSFW_COPY } from '../services/nsfwGate';
import './manga-view.css';

interface MangaViewProps extends ReadingLibraryProps { prefillQuery?: string }

const MangaView: React.FC<MangaViewProps> = (props) => {
  const [source, setSource] = useState<MangaSource>(props.openReading?.kind === 'manga' ? props.openReading.source : 'WeebCentral');
  const [fromLibrary, setFromLibrary] = useState(Boolean(props.openReading));
  return <MangaCatalog key={source} {...props} openReading={fromLibrary ? props.openReading : null} source={source}
    onSourceChange={(next) => { if (next !== source) { setFromLibrary(false); setSource(next); } }} />;
};

const MangaCatalog: React.FC<MangaViewProps & { source: MangaSource; onSourceChange: (source: MangaSource) => void }> = ({
  prefillQuery, source, onSourceChange, ...readingLibrary
}) => {
  const [query, setQuery] = useState(prefillQuery || '');
  const [submitted, setSubmitted] = useState(prefillQuery || '');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MangaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<MangaItem | null>(null);
  const [chapters, setChapters] = useState<MangaChapter[]>([]);
  const [chapterOrder, setChapterOrder] = useChapterOrder();
  const [chapterError, setChapterError] = useState('');
  const detailRequest = useRef(0);
  const pageRequest = useRef(0);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [reader, setReader] = useState<{
    chapter: MangaChapter;
    images: string[];
    index: number;
  } | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);

  const load = useCallback(async (reset = true) => {
    const request = ++pageRequest.current;
    setLoading(true);
    setError('');
    try {
      const nextPage = reset ? 1 : page + 1;
      const result: MangaItem[] = source === 'MangaDex'
        ? (await mangaDexCatalog(submitted, nextPage, 'popular', undefined, 'en')).items.map((item) => ({
          id: item.slug, title: item.title, coverNormal: item.poster || '', coverSmall: item.poster || '',
          type: item.comicType || 'Manga', url: '', synopsis: item.summary, year: item.year,
        }))
        : submitted ? await MangaService.searchManga(submitted, nextPage) : await MangaService.getManga(nextPage);
      if (request !== pageRequest.current) return;
      setPage(nextPage);
      if (reset) {
        setItems(result);
      } else {
        setItems((current) => [...current, ...result]);
      }
    } catch {
      if (request === pageRequest.current) setError(`Could not reach ${source}. Try again in a moment.`);
    } finally {
      if (request === pageRequest.current) setLoading(false);
    }
  }, [submitted, page, source]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted]);

  useEffect(() => {
    if (prefillQuery) {
      setQuery(prefillQuery);
      setSubmitted(prefillQuery);
    }
  }, [prefillQuery]);

  const closeDetail = () => {
    detailRequest.current += 1;
    setReaderLoading(false);
    setDetail(null);
  };

  const openDetail = useCallback(async (item: MangaItem) => {
    const request = ++detailRequest.current;
    setDetail(item);
    setChapters([]);
    setChapterError('');
    setChaptersLoading(true);
    const ascending = (a: MangaChapter, b: MangaChapter) => compareChapters(a.name, b.name, a.chapterNumber, b.chapterNumber);
    try {
      if (source === 'MangaDex') {
        const full = await mangaDexDetail(item.id, undefined, 'en');
        if (request !== detailRequest.current) return;
        setDetail({ ...item, synopsis: full.summary, author: full.author, tags: full.genres });
        setChapters(full.chapters.map((entry) => ({ id: entry.slug, name: entry.title, url: '' })).sort(ascending));
      } else {
        const [full, list] = await Promise.allSettled([
          MangaService.getSeriesDetail(item.id),
          MangaService.getChapters(item.id),
        ]);
        if (request !== detailRequest.current) return;
        if (full.status === 'fulfilled') setDetail(full.value);
        if (list.status === 'rejected') throw list.reason;
        setChapters([...list.value].sort(ascending));
      }
    } catch {
      if (request === detailRequest.current) setChapterError('Could not load chapters.');
    } finally {
      if (request === detailRequest.current) setChaptersLoading(false);
    }
  }, [source]);

  const target = readingLibrary.openReading;
  const appliedTarget = useRef<typeof target>(null);
  useEffect(() => {
    if (target?.kind !== 'manga' || target.source !== source || target === appliedTarget.current) return;
    appliedTarget.current = target;
    void openDetail(target.item);
  }, [target, source, openDetail]);

  const openChapter = async (chapter: MangaChapter, index: number) => {
    const request = detailRequest.current;
    setChapterError('');
    setReaderLoading(true);
    try {
      const images = await (source === 'MangaDex' ? mangaDexPages(chapter.id) : MangaService.getChapterImages(chapter.id));
      if (request !== detailRequest.current) return;
      if (!images.length) throw new Error('This chapter has no readable images right now.');
      setReader({ chapter, images, index });
    } catch (error) {
      if (request === detailRequest.current) setChapterError(error instanceof Error ? error.message : 'Could not load this chapter.');
    } finally {
      if (request === detailRequest.current) setReaderLoading(false);
    }
  };

  const openNeighbour = (delta: number) => {
    if (!reader || readerLoading) return;
    const index = reader.index + delta;
    if (chapters[index]) void openChapter(chapters[index], index);
  };

  const heading = useMemo(() => {
    if (submitted) return `Results for “${submitted}”`;
    return `Popular manga on ${source}`;
  }, [submitted, source]);

  return (
    <div className="standard-page manga-page page-enter">
      <div className="manga-heading">
        <div>
          <BookOpen size={20} />
          <div>
            <h1>Manga</h1>
            <p>English manga · {NSFW_COPY.title}: {NSFW_COPY.modes[0].label} by default</p>
          </div>
        </div>
      </div>

      <div className="comic-source-rail" role="tablist" aria-label="Manga source">
        {(['WeebCentral', 'MangaDex'] as const).map((name) => (
          <button type="button" key={name} role="tab" aria-selected={source === name}
            className={`comic-source-chip${source === name ? ' active' : ''}`} onClick={() => onSourceChange(name)}>{name}</button>
        ))}
      </div>
      <form
        className="manga-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search manga, manhwa, manhua…"
          aria-label="Search manga"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setSubmitted(''); }}>
            <X size={15} />
          </button>
        )}
        <button type="submit" className="button button-primary">Search</button>
      </form>

      <div className="manga-results-heading">
        <h2>{heading}</h2>
        {!loading && <span>{items.length} titles</span>}
      </div>

      {loading && !items.length ? (
        <div className="manga-loading"><LoaderCircle size={22} className="spin" /> Loading manga…</div>
      ) : error && !items.length ? (
        <div className="empty-state manga-empty" role="alert">
          <h2>Couldn’t reach {source}</h2>
          <p>{error}</p>
          <button className="button button-secondary" onClick={() => void load(true)}>
            <RotateCcw size={15} /> Try again
          </button>
        </div>
      ) : (
        <>
          <div className="comic-grid manga-grid">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="manga-card"
                onClick={() => void openDetail(item)}
              >
                <div className="manga-cover">
                  {item.coverNormal ? (
                    <img src={item.coverNormal} alt="" loading="lazy" />
                  ) : (
                    <span><BookOpen size={28} /></span>
                  )}
                </div>
                <div className="manga-card-meta">
                  <strong>{item.title}</strong>
                  <span>{[item.type, item.year, item.status].filter(Boolean).join(' · ')}</span>
                </div>
              </button>
            ))}
          </div>
          {items.length > 0 && (
            <div className="manga-more">
              <button
                className="button button-secondary"
                disabled={loading}
                onClick={() => {
                  void load(false);
                }}
              >
                {loading ? <LoaderCircle size={15} className="spin" /> : <ChevronLeft size={15} className="flip" />}
                Load more
              </button>
            </div>
          )}
        </>
      )}

      {detail && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDetail()}>
          <section className="manga-detail" role="dialog" aria-modal="true" aria-label={detail.title}>
            <button className="modal-close floating" onClick={closeDetail} aria-label="Close manga details" data-android-back>
              <X size={18} />
            </button>
            <div className="manga-detail-top">
              {detail.coverNormal && <img src={detail.coverNormal} alt="" />}
              <div>
                <h2>{detail.title}</h2>
                <p>{[detail.type, detail.author, detail.year, detail.status].filter(Boolean).join(' · ')}</p>
                {detail.synopsis && <p className="manga-synopsis">{detail.synopsis}</p>}
                {!!detail.tags?.length && (
                  <div className="manga-tags">{detail.tags.slice(0, 8).map((tag) => <span key={tag}>{tag}</span>)}</div>
                )}
              </div>
            </div>
            <ReadingSaveButton {...readingLibrary} entry={{ kind: 'manga', item: detail, source }} />
            <div className="sanka-chapter-heading">
              <h3>Chapters</h3>
              {chapters.length > 1 && <ChapterOrder value={chapterOrder} onChange={setChapterOrder} />}
            </div>
            {chapterError && <p className="sanka-inline-error" role="alert">{chapterError}</p>}
            {chaptersLoading ? (
              <div className="manga-loading"><LoaderCircle size={18} className="spin" /> Loading chapters…</div>
            ) : (
              <div className="manga-chapters">
                {(chapterOrder === 'asc' ? chapters : [...chapters].reverse()).map((chapter, displayIndex) => {
                  const index = chapterOrder === 'asc' ? displayIndex : chapters.length - displayIndex - 1;
                  return (
                  <button
                    key={chapter.id}
                    type="button"
                    className="manga-chapter"
                    disabled={readerLoading}
                    onClick={() => void openChapter(chapter, index)}
                  >
                    <span>{chapter.name || `Chapter ${chapter.chapterNumber ?? index + 1}`}</span>
                  </button>
                  );
                })}
                {!chapters.length && !chapterError && <p>No chapters found for this series.</p>}
              </div>
            )}
          </section>
        </div>
      )}

      {reader && (
        <MangaReader
          chapterId={reader.chapter.id}
          chapterTitle={reader.chapter.name}
          chapterNumber={reader.chapter.chapterNumber?.toString()}
          images={reader.images}
          onClose={() => setReader(null)}
          onNextChapter={reader.index < chapters.length - 1 ? () => void openNeighbour(1) : undefined}
          onPrevChapter={reader.index > 0 ? () => void openNeighbour(-1) : undefined}
          status={readerLoading ? 'Loading chapter…' : chapterError}
          hasNextChapter={reader.index < chapters.length - 1}
        />
      )}
    </div>
  );
};

export default MangaView;
