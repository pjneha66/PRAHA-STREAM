import { nativeFetchText } from './androidBridge';
import { evictOldest } from './cacheCaps';

/**
 * Books & comics data layer backed by the Internet Archive and Open Library.
 *
 * folkscanomy is an archive.org community collection family (hundreds of
 * thousands of freely-shared texts, incl. comics and manga), reached through
 * the public advancedsearch API. Anna's Archive is deliberately NOT a data
 * source here — it is a shadow-library aggregator; PRAHA links to it from the
 * Books tab as an external site instead of integrating search or downloads.
 */

export interface BookItem {
  id: string;
  title: string;
  authors: string[];
  year?: string;
  coverUrl?: string;
  /** archive.org item identifier (when source === 'archive'). */
  identifier?: string;
  /** Open Library work key (when source === 'openlibrary'), e.g. /works/OL123W. */
  openLibraryKey?: string;
  source: 'openlibrary' | 'archive';
  note?: string;
}

export interface BookFile {
  name: string;
  format: string;
  url: string;
  sizeBytes?: number;
}

export interface ArchiveCollection {
  id: string;
  name: string;
  /** Extra solr filter for this collection, used with `collection:` queries. */
  query: string;
}

/**
 * Every subject filter from the archive.org folkscanomy comics browse,
 * OR-combined so one item matching any of them surfaces (verified live:
 * ~43k items). Multi-word subjects are quoted for solr.
 */
export const FOLKSCANOMY_COMIC_SUBJECTS = [
  'comic', 'comics', 'manga', 'mangá', 'cómic', 'cómics', 'webcomic', 'webcomics',
  '"web comic"', '"fan comic"', 'fancomic', '"mini-comic"', '"comic book"', '"comic books"',
  '"comic strip"', '"comic strips"', '"graphic novel"', '"graphic novels"', '"marvel comics"',
  '"dc comics"', '"archie comics"', '"british comics"', '"superhero comics"', '"underground comics"',
  '"horror comics"', '"golden age comics"', '"golden age comic books"', '"hindi comics"',
  '"manoj comics"', '"christian comics"', '"spire christian comic"', '"alternative comics"',
  '"alternative comic"', 'manga_library', '"manga book"', '"how to draw manga"', 'comics_inbox',
  'comicgenesis', '"sprite comic"', '"1990s comics"', '"sonic the comic"', '"whiz comics"',
  '"wow comics"', '"comics wow"', '"comics whiz"', '"bessy comic"', '"cizgi roman comic"',
  '"comics & graphic novels"', '"comic books and graphic novels"', '"comic books, strips, etc."',
  '"comic europeo"', '"hanna-barbera comics"', '"wizard: the guide to comics"', '"cómic terror"',
  '"cómic galaxia bramford"', '"exciting comics"', '"pony comics"', 'magazine',
  '"advertising art"', '"graphic arts"',
];

export const FOLKSCANOMY_COMICS_QUERY =
  `(collection:folkscanomy*) AND mediatype:texts AND subject:(${FOLKSCANOMY_COMIC_SUBJECTS.join(' OR ')})`;

export const ARCHIVE_COLLECTIONS: ArchiveCollection[] = [
  { id: 'folkscanomy', name: 'folkscanomy — everything', query: 'collection:folkscanomy*' },
  {
    id: 'folk-comics',
    name: 'folkscanomy — comics & manga',
    query: FOLKSCANOMY_COMICS_QUERY,
  },
  { id: 'folk-sf', name: 'folkscanomy — sci-fi & fantasy', query: 'collection:folkscanomy_sf' },
  { id: 'folk-fiction', name: 'folkscanomy — fiction', query: 'collection:folkscanomy_fiction' },
  { id: 'folk-computer', name: 'folkscanomy — computers', query: 'collection:folkscanomy_computer' },
  { id: 'folk-science', name: 'folkscanomy — science', query: 'collection:folkscanomy_science' },
  { id: 'folk-history', name: 'folkscanomy — history', query: 'collection:folkscanomy_history' },
  { id: 'folk-gameart', name: 'folkscanomy — game art books', query: 'collection:folkscanomy_gameartbooks' },
];

const TEXT_FORMAT_RE = /\.(pdf|epub|cbz|cbr|djvu|txt|mobi|azw3?)$/i;

interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  year?: string | number;
  description?: string | string[];
}

const firstOf = (value: string | string[] | number | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  if (value === undefined) return undefined;
  return String(value);
};

export class BooksService {
  private static readonly searchCache = new Map<string, BookItem[]>();
  private static readonly filesCache = new Map<string, BookFile[]>();

  /** Open Library search; items that have an archive.org copy come first. */
  static async searchOpenLibrary(query: string, page = 1): Promise<BookItem[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const cacheKey = `ol:${trimmed}:${page}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;

    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(trimmed)}&limit=24&page=${page}` +
      `&fields=key,title,author_name,first_publish_year,cover_i,ia,ebook_access`;
    const res = await nativeFetchText(url, { timeoutMs: 12000 });
    if (!res.ok || !res.data.trim().startsWith('{')) throw new Error('Open Library did not answer.');
    const data = JSON.parse(res.data) as { docs?: Array<Record<string, unknown>> };
    const docs = Array.isArray(data.docs) ? data.docs : [];
    const items: BookItem[] = docs.map((doc) => {
      const iaList = Array.isArray(doc.ia) ? (doc.ia as string[]) : [];
      const identifier = iaList[0];
      const olCover = doc.cover_i ? `https://covers.openlibrary.org/b/cover_i/${doc.cover_i}-L.jpg` : undefined;
      return {
        id: String(doc.key || identifier || doc.title),
        title: String(doc.title || 'Untitled'),
        authors: Array.isArray(doc.author_name) ? (doc.author_name as string[]).slice(0, 3) : [],
        year: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
        // Covers.openlibrary.org is slow or blocked on some networks; the
        // archive.org scan image is the reliable fallback when a full-text
        // copy exists.
        coverUrl: olCover || (identifier ? `https://archive.org/services/img/${identifier}` : undefined),
        identifier,
        openLibraryKey: String(doc.key || ''),
        source: 'openlibrary' as const,
        note: identifier ? 'Full text on archive.org' : undefined,
      };
    });
    // Items that can actually be read on archive.org surface first.
    items.sort((a, b) => Number(Boolean(b.identifier)) - Number(Boolean(a.identifier)));
    this.searchCache.set(cacheKey, items);
    evictOldest(this.searchCache, 24);
    return items;
  }

  /** archive.org search, scoped to a folkscanomy (or any) collection query. */
  static async searchArchive(query: string, collection: ArchiveCollection, page = 1, rows = 24): Promise<BookItem[]> {
    const trimmed = query.trim();
    const cacheKey = `ia:${collection.id}:${trimmed}:${page}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;

    const q = trimmed
      ? `(${collection.query}) AND mediatype:texts AND title:(${trimmed})`
      : `(${collection.query}) AND mediatype:texts`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
      `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year&rows=${rows}&page=${page}&output=json`;
    const res = await nativeFetchText(url, { timeoutMs: 15000 });
    if (!res.ok || !res.data.trim().startsWith('{')) throw new Error('archive.org did not answer.');
    const data = JSON.parse(res.data) as { response?: { docs?: ArchiveDoc[] } };
    const docs = data.response?.docs || [];
    const items: BookItem[] = docs
      .filter((doc) => doc.identifier)
      .map((doc) => ({
        id: `archive:${doc.identifier}`,
        title: firstOf(doc.title) || doc.identifier,
        authors: Array.isArray(doc.creator) ? doc.creator.slice(0, 3) : doc.creator ? [String(doc.creator)] : [],
        year: firstOf(doc.year),
        coverUrl: `https://archive.org/services/img/${doc.identifier}`,
        identifier: doc.identifier,
        source: 'archive' as const,
      }));
    this.searchCache.set(cacheKey, items);
    evictOldest(this.searchCache, 24);
    return items;
  }

  /** Downloadable text files inside an archive.org item (pdf/epub/cbz/...). */
  static async itemFiles(identifier: string): Promise<BookFile[]> {
    const cached = this.filesCache.get(identifier);
    if (cached) return cached;
    const res = await nativeFetchText(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { timeoutMs: 12000 });
    if (!res.ok || !res.data.trim().startsWith('{')) throw new Error('Could not load the archive.org item metadata.');
    const data = JSON.parse(res.data) as { files?: Array<{ name?: string; size?: string; format?: string }> };
    const files: BookFile[] = (data.files || [])
      .filter((file) => file.name && TEXT_FORMAT_RE.test(file.name))
      .map((file) => ({
        name: String(file.name),
        format: (String(file.name).split('.').pop() || 'file').toUpperCase(),
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(String(file.name))}`,
        sizeBytes: file.size ? Number(file.size) || undefined : undefined,
      }))
      .slice(0, 12);
    this.filesCache.set(identifier, files);
    evictOldest(this.filesCache, 40);
    return files;
  }

  static detailsUrl(identifier: string): string {
    return `https://archive.org/details/${encodeURIComponent(identifier)}`;
  }

  static workUrl(key: string): string {
    return `https://openlibrary.org${key.startsWith('/') ? key : `/${key}`}`;
  }

  static formatSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return '';
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }
}
