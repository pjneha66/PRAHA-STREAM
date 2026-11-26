import { usePersistentState } from '../hooks/usePersistentState';

export function useChapterOrder() {
  return usePersistentState<'asc' | 'desc'>('praha.v2.chapter-order', 'desc');
}

const chapterNumber = (title: string) => Number(title.match(/(?:\b(?:chapter|ch\.?|episode)\s*#?\s*|^\s*#?\s*)(\d+(?:\.\d+)?)/i)?.[1]);

export function compareChapters(a: string, b: string, first = chapterNumber(a), second = chapterNumber(b)) {
  if (Number.isFinite(first) && Number.isFinite(second)) return first - second;
  if (Number.isFinite(first)) return -1;
  if (Number.isFinite(second)) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
}

export default function ChapterOrder({ value, onChange }: { value: 'asc' | 'desc'; onChange: (value: 'asc' | 'desc') => void }) {
  return <label className="source-select chapter-order">
    <select aria-label="Chapter order" value={value} onChange={(event) => onChange(event.target.value === 'asc' ? 'asc' : 'desc')}>
      <option value="asc">Ascending</option>
      <option value="desc">Descending</option>
    </select>
  </label>;
}
