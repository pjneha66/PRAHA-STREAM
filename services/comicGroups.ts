import type { SankaTitle } from './sankaService';

export function comicEditionKey(item: SankaTitle): string {
  return item.id.startsWith('archive:') ? item.id : `${item.source}:${item.slug}`;
}

function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function provider(item: SankaTitle): string {
  if (item.id.startsWith('archive:')) return 'archive.org';
  return item.source === 'comick' ? item.comicType?.toLowerCase() || 'comick' : item.source;
}

export function groupComicTitles(items: SankaTitle[]): SankaTitle[][] {
  const groups: SankaTitle[][] = [];
  const byAlias = new Map<string, SankaTitle[][]>();
  for (const item of items) {
    const keys = [item.title, ...(item.aliases || [])].map(titleKey).filter((key) => key.length > 1);
    const matches = keys.flatMap((key) => byAlias.get(key) || []);
    const group = matches.find((entries) => entries.every((entry) =>
      (!entry.year || !item.year || entry.year === item.year)
      && (provider(entry) !== provider(item) || comicEditionKey(entry) === comicEditionKey(item)),
    )) || [];
    if (!group.length) groups.push(group);
    if (group.some((entry) => comicEditionKey(entry) === comicEditionKey(item))) continue;
    group.push(item);
    for (const key of new Set(keys)) {
      const indexed = byAlias.get(key) || [];
      if (!indexed.includes(group)) byAlias.set(key, [...indexed, group]);
    }
  }
  return groups;
}
