import { Bookmark, BookmarkCheck } from 'lucide-react';
import { readingKey, type ReadingEntry, type ReadingLibraryProps } from '../services/readingLibrary';

export default function ReadingSaveButton({ entry, savedReading, onToggleReading }: ReadingLibraryProps & { entry: ReadingEntry }) {
  if (!onToggleReading) return null;
  const saved = savedReading?.some((item) => readingKey(item) === readingKey(entry)) ?? false;
  return <button type="button" className="button button-secondary button-small" aria-pressed={saved} onClick={() => onToggleReading(entry)}>
    {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />} {saved ? 'Saved to Library' : 'Save to Library'}
  </button>;
}
