import type { BookItem } from './archiveService';
import type { MangaItem } from './mangaService';
import type { SankaTitle } from './sankaService';

export type MangaSource = 'WeebCentral' | 'MangaDex' | 'Kotatsu';

export type ReadingEntry =
  | { kind: 'books'; item: BookItem }
  | { kind: 'sanka'; item: SankaTitle }
  | { kind: 'manga'; item: MangaItem; source: MangaSource };

export interface ReadingLibraryProps {
  savedReading?: ReadingEntry[];
  openReading?: ReadingEntry | null;
  onToggleReading?: (entry: ReadingEntry) => void;
  onSaveReading?: (entry: ReadingEntry) => void;
}

export function readingKey(entry: ReadingEntry) {
  const source = entry.kind === 'manga' ? entry.source : entry.item.source;
  const id = entry.kind === 'books' ? entry.item.identifier || entry.item.openLibraryKey || entry.item.id
    : entry.kind === 'sanka' ? entry.item.slug || entry.item.id
    : entry.item.id;
  return JSON.stringify([entry.kind, source, id]);
}
