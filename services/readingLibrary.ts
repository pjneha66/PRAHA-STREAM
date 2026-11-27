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
}

export function readingKey(entry: ReadingEntry) {
  const source = entry.kind === 'manga' ? entry.source : entry.item.source;
  return JSON.stringify([entry.kind, source, entry.item.id]);
}
