import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, LoaderCircle, RotateCcw, Search, X } from 'lucide-react';
import { MangaService, type MangaChapter, type MangaItem } from '../services/mangaService';
import { Artwork } from './MediaCard';
import { webtoonsCatalog, webtoonsChapters, webtoonsPages } from '../services/webtoonsMangaService';
import { extraKotatsuProvider, extraKotatsuProviders, type ExtraKotatsuProvider } from '../services/kotatsuMangaService';
import MangaReader from './MangaReader';
import ChapterOrder, { compareChapters, useChapterOrder } from './ChapterOrder';
import ReadingSaveButton from './ReadingSaveButton';
import type { MangaSource, ReadingLibraryProps } from '../services/readingLibrary';
import { mangaDexCatalog, mangaDexDetail, mangaDexPages } from '../services/mangaDexService';
import ReadingSourceDirectory from './ReadingSourceDirectory';
import type { SankaTitle } from '../services/sankaService';
import { twokindsCatalog, twokindsDetail, twokindsPages } from '../services/twokindsService';
import type { NsfwMode } from '../types';
import './manga-view.css';

interface MangaViewProps extends ReadingLibraryProps {
  prefillQuery?: string;
  adultMode?: NsfwMode;
  onAdultMode?: (mode: NsfwMode) => void;
}

const kotatsuProviders = {
  all: 'All providers', weebcentral: 'Weeb Central', webtoons: 'Webtoons English', twokinds: 'Twokinds',
  mangakatana: 'MangaKatana', mangatellers: 'Mangatellers', guyacubari: 'GuyaCubari',
} as const;
type KotatsuProvider = keyof typeof kotatsuProviders;

function catalogManga(item: SankaTitle): MangaItem {
  return {
    id: item.slug, title: item.title, coverNormal: item.poster || '', coverSmall: item.poster || '',
    type: item.comicType || 'Manga', url: item.sourceUrl || '', synopsis: item.summary, year: item.year,
  };
}

const MangaView: React.FC<MangaViewProps> = (props) => {
  const [source, setSource] = useState<MangaSource>(props.openReading?.kind === 'manga' ? props.openReading.source : 'WeebCentral');
  const [fromLibrary, setFromLibrary] = useState(Boolean(props.openReading));
  return <MangaCatalog key={source} {...props} openReading={fromLibrary ? props.openReading : null} source={source}
    onSourceChange={(next) => { if (next !== source) { setFromLibrary(false); setSource(next); } }} />;
};

const MangaCatalog: React.FC<MangaViewProps & { source: MangaSource; onSourceChange: (source: MangaSource) => void }> = ({
  prefillQuery, source, onSourceChange, adultMode, onAdultMode, ...readingLibrary
}) => {
  const [query, setQuery] = useState(prefillQuery || '');
  const [submitted, setSubmitted] = useState(prefillQuery || '');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MangaItem[]>([]);
  const [kotatsuProvider, setKotatsuProvider] = useState<KotatsuProvider>('all');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<MangaItem | null>(null);
  const [chapters, setChapters] = useState<MangaChapter[]>([]);
  const [chapterOrder, setChapterOrder] = useChapterOrder();
  const [chapterError, setChapterError] = useState('');
  const detailRequest = useRef(0);
  const pageRequest = useRef(0);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [nextEpisodePage, setNextEpisodePage] = useState(0);
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
    if (reset) setItems([]);
    try {
      const nextPage = reset ? 1 : page + 1;
      let result: MangaItem[];
      let more: boolean;
      if (source === 'WeebCentral') {
        result = submitted ? await MangaService.searchManga(submitted, nextPage) : await MangaService.getManga(nextPage);
        more = result.length > 0;
      } else if (source === 'MangaDex') {
        const catalog = await mangaDexCatalog(submitted, nextPage, 'popular', undefined, 'en');
        result = catalog.items.map(catalogManga);
        more = catalog.hasMore;
      } else {
        const enabled = (id: KotatsuProvider) => kotatsuProvider === 'all' || kotatsuProvider === id;
        const tasks: Promise<{ items: MangaItem[]; hasMore: boolean }>[] = [];
        if (enabled('weebcentral')) {
          const manga = submitted ? MangaService.searchManga(submitted, nextPage) : MangaService.getManga(nextPage);
          tasks.push(manga.then((items) => ({
            items: items.map((item) => ({ ...item, kotatsuProvider: 'weebcentral' })),
            hasMore: items.length >= 30,
          })));
        }
        if (enabled('webtoons') && adultMode !== 'only') tasks.push(webtoonsCatalog(submitted, nextPage));
        if (enabled('twokinds')) {
          const webcomic = twokindsCatalog(submitted, nextPage, 'en', adultMode);
          tasks.push(Promise.resolve({
            items: webcomic.items.map((item) => ({ ...catalogManga(item), kotatsuProvider: 'twokinds' })),
            hasMore: false,
          }));
        }
        if (adultMode !== 'only') {
          for (const id of Object.keys(extraKotatsuProviders) as ExtraKotatsuProvider[]) {
            if (enabled(id)) tasks.push(extraKotatsuProviders[id].catalog(submitted, nextPage, adultMode ?? 'off'));
          }
        }
        const resolved: Awaited<(typeof tasks)[number]>[] = [];
        const combine = (catalogs: typeof resolved) => {
          const titles: MangaItem[] = [];
          const count = Math.max(0, ...catalogs.map((catalog) => catalog.items.length));
          for (let index = 0; index < count; index += 1) {
            for (const { items } of catalogs) if (items[index]) titles.push(items[index]);
          }
          return titles;
        };
        const settled = await Promise.allSettled(tasks.map(async (task, index) => {
          const catalog = await task;
          resolved[index] = catalog;
          if (reset && request === pageRequest.current && catalog.items.length) setItems(combine(resolved.filter(Boolean)));
          return catalog;
        }));
        const catalogs = settled.flatMap((task) => task.status === 'fulfilled' ? [task.value] : []);
        if (tasks.length && !catalogs.length) throw new Error('Kotatsu providers unavailable.');
        result = combine(catalogs);
        more = catalogs.some((catalog) => catalog.hasMore);
      }
      if (request !== pageRequest.current) return;
      setPage(nextPage);
      setHasMore(more);
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
  }, [submitted, page, source, adultMode, kotatsuProvider]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, adultMode, kotatsuProvider]);

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
    setNextEpisodePage(0);
    setChapterError('');
    setChaptersLoading(true);
    const ascending = (a: MangaChapter, b: MangaChapter) => compareChapters(a.name, b.name, a.chapterNumber, b.chapterNumber);
    try {
      const provider = source === 'Kotatsu' ? extraKotatsuProvider(item.kotatsuProvider) : undefined;
      if (provider) {
        if (adultMode === 'only') throw new Error('This provider is hidden in Hentai only mode.');
        const list = await provider.chapters(item, adultMode ?? 'off');
        if (request === detailRequest.current) setChapters(list.sort(ascending));
      } else if (source === 'Kotatsu' && item.kotatsuProvider === 'webtoons') {
        const result = await webtoonsChapters(item, 1);
        if (request !== detailRequest.current) return;
        setChapters(result.chapters.sort(ascending));
        setNextEpisodePage(result.hasMore ? 2 : 0);
      } else if (source === 'MangaDex' || (source === 'Kotatsu' && item.id === 'twokinds')) {
        const full = source === 'Kotatsu' ? await twokindsDetail() : await mangaDexDetail(item.id, undefined, 'en');
        if (request !== detailRequest.current) return;
        setDetail({ ...item, synopsis: full.summary, author: full.author, tags: full.genres });
        setChapters(full.chapters.map((entry) => ({ id: entry.slug, name: entry.title, url: '' })).sort(ascending));
      } else {
        const [full, list] = await Promise.allSettled([
          MangaService.getSeriesDetail(item.id),
          MangaService.getChapters(item.id),
        ]);
        if (request !== detailRequest.current) return;
        if (full.status === 'fulfilled') setDetail({ ...full.value, kotatsuProvider: item.kotatsuProvider });
        if (list.status === 'rejected') throw list.reason;
        setChapters([...list.value].sort(ascending));
      }
    } catch (error) {
      if (request === detailRequest.current) setChapterError(error instanceof Error ? error.message : 'Could not load chapters.');
    } finally {
      if (request === detailRequest.current) setChaptersLoading(false);
    }
  }, [source, adultMode]);

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
      let images: string[];
      const provider = source === 'Kotatsu' ? extraKotatsuProvider(detail?.kotatsuProvider) : undefined;
      if (provider) images = await provider.pages(chapter);
      else if (source === 'Kotatsu' && detail?.kotatsuProvider === 'webtoons') images = await webtoonsPages(chapter);
      else if (source === 'Kotatsu' && detail?.id === 'twokinds') images = await twokindsPages(chapter.id);
      else if (source === 'MangaDex') images = await mangaDexPages(chapter.id);
      else images = await MangaService.getChapterImages(chapter.id);
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

  const selectProvider = (provider: KotatsuProvider) => {
    if (provider === kotatsuProvider) return;
    pageRequest.current += 1;
    setItems([]);
    setPage(1);
    setKotatsuProvider(provider);
  };

  const loadOlderEpisodes = async () => {
    if (!detail || !nextEpisodePage) return;
    const request = detailRequest.current;
    setChaptersLoading(true);
    setChapterError('');
    try {
      const result = await webtoonsChapters(detail, nextEpisodePage);
      if (request !== detailRequest.current) return;
      setChapters((current) => [...new Map([...current, ...result.chapters].map((chapter) => [chapter.id, chapter])).values()]
        .sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0)));
      setNextEpisodePage(result.hasMore ? nextEpisodePage + 1 : 0);
    } catch {
      if (request === detailRequest.current) setChapterError('Could not load older episodes.');
    } finally {
      if (request === detailRequest.current) setChaptersLoading(false);
    }
  };

  const heading = useMemo(() => {
    if (submitted) return `Results for “${submitted}”`;
    if (source === 'Kotatsu') return kotatsuProvider === 'all' ? 'Kotatsu catalog' : kotatsuProviders[kotatsuProvider];
    return `Popular manga on ${source}`;
  }, [submitted, source, kotatsuProvider]);

  return (
    <div className="standard-page manga-page page-enter reading-page">
      <h1 className="reading-heading">Manga</h1>
      <form
        className="manga-search reading-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search manga"
          aria-label="Search manga"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setSubmitted(''); }}>
            <X size={15} />
          </button>
        )}
        <button type="submit" className="button button-primary">Search</button>
      </form>

      <div className="reading-controls">
        <select className="reading-select" aria-label="Manga source" value={source}
          onChange={(event) => onSourceChange(event.target.value as MangaSource)}>
          {(['WeebCentral', 'MangaDex', 'Kotatsu'] as const).map((name) => <option key={name}>{name}</option>)}
        </select>
        {source === 'Kotatsu' && (
          <select className="reading-select" aria-label="Kotatsu providers" value={kotatsuProvider}
            onChange={(event) => selectProvider(event.target.value as KotatsuProvider)}>
            {Object.entries(kotatsuProviders).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>
      {source === 'Kotatsu' && (
        <ReadingSourceDirectory repository="kotatsu" adultMode={adultMode} onAdultMode={onAdultMode} collapseListings
          readers={{
            Twokinds: () => selectProvider('twokinds'), 'Weeb Central': () => selectProvider('weebcentral'),
            'LineWebtoons English': () => selectProvider('webtoons'), 'Webtoons English': () => selectProvider('webtoons'),
            MangaKatana: () => selectProvider('mangakatana'), Mangatellers: () => selectProvider('mangatellers'),
            GuyaCubari: () => selectProvider('guyacubari'),
          }} />
      )}
      <div className="manga-results-heading">
        <h2>{heading}</h2>
        {loading && items.length > 0 ? <span role="status">Loading more results…</span>
          : !loading && <span>{items.length} {items.length === 1 ? 'title' : 'titles'}</span>}
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
      ) : !items.length ? (
        <p>No matching titles.</p>
      ) : (
        <>
          <div className="comic-grid manga-grid">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="manga-card"
                onClick={() => void openDetail(item)}
              >
                <div className="manga-cover">
                  <Artwork src={item.coverNormal} alt={item.title} priority={index < 2} />
                </div>
                <div className="manga-card-meta">
                  <strong>{item.title}</strong>
                  <span>{[item.kotatsuProvider && kotatsuProviders[item.kotatsuProvider], item.type, item.year, item.status].filter(Boolean).join(' · ')}</span>
                </div>
              </button>
            ))}
          </div>
          {items.length > 0 && hasMore && (
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
            {nextEpisodePage > 0 && <button type="button" className="button button-secondary button-small"
              disabled={chaptersLoading} onClick={() => void loadOlderEpisodes()}>Load older episodes</button>}
            {chaptersLoading && !chapters.length ? (
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
