import { nativeFetchText } from './androidBridge';
import { comicsRelayUrl } from './comicsRelay';

export type ReadingCatalog = 'kotatsu' | 'lnreader' | 'ireader';
export type ReadingSource = { name: string; adult: boolean };
const KOTATSU_INDEX = 'https://kotatsu-83g.pages.dev/kotatsu/kotatsu-parsers-redo.json';

export async function loadReadingCatalog(repository: ReadingCatalog): Promise<ReadingSource[]> {
  const url = repository === 'kotatsu' ? KOTATSU_INDEX : comicsRelayUrl(`/reading-index/${repository}`, true);
  const response = await nativeFetchText(url, { timeoutMs: 10000 });
  if (!response.ok) throw new Error('Catalog unavailable.');
  const data = JSON.parse(response.data);
  const rows = repository === 'kotatsu' ? data.sites : data.entries;
  if (!Array.isArray(rows)) throw new Error('Invalid catalog.');
  const unique = new Map<string, ReadingSource>();
  for (const row of rows) {
    if (typeof row?.name !== 'string' || !row.name.trim() || row.name.length > 140) continue;
    if (repository === 'kotatsu' && (row.lang !== 'en' || row.isBroken)) continue;
    const adult = row.contentType === 'HENTAI' || row.nsfw === true;
    if (repository === 'kotatsu' && !adult && !['MANGA', 'MANHWA', 'COMICS'].includes(row.contentType)) continue;
    const key = row.name.trim().toLowerCase();
    unique.set(key, { name: row.name.trim(), adult: adult || unique.get(key)?.adult === true });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}
