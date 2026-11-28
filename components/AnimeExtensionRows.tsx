// The Anime tab's extension rows: the installed Zangetsu anime providers' home
// rows and the AnymeX anime extensions' Popular/Latest, shown beside the
// AniCore rows. Each extension gets its own row set, labelled with its source,
// so the tab keeps reading as one anime surface. Purely additive: the AniCore
// and Anikura rows above are untouched.

import React, { useEffect, useState } from 'react';
import { MediaRow } from './MediaCard';
import { anymexCatalog } from '../services/ecosystems/anymex';
import { zangetsuHomeRows } from '../services/ecosystems/zangetsu';
import { ecosystemExtensions, type EcosystemExtension } from '../services/ecosystems/store';
import type { MediaItem } from '../types';

interface AnimeExtensionRowsProps {
  watchlist: MediaItem[];
  compact: boolean;
  onSelect: (item: MediaItem) => void;
  onToggleWatchlist: (item: MediaItem) => void;
}

interface EcoRow {
  key: string;
  title: string;
  subtitle: string;
  items: MediaItem[];
}

const animeExtensions = (): EcosystemExtension[] =>
  ecosystemExtensions('zangetsu').filter((entry) => entry.enabled && entry.kind === 'anime')
    .concat(ecosystemExtensions('anymex').filter((entry) => entry.enabled && entry.kind === 'anime'));

const AnimeExtensionRows: React.FC<AnimeExtensionRowsProps> = ({ watchlist, compact, onSelect, onToggleWatchlist }) => {
  const [rows, setRows] = useState<EcoRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const extensions = animeExtensions();
      if (!extensions.length) {
        setRows([]);
        return;
      }
      const loaded: EcoRow[] = [];
      await Promise.all(extensions.map(async (extension) => {
        try {
          if (extension.ecosystem === 'zangetsu') {
            const homeRows = await zangetsuHomeRows(extension);
            for (const row of homeRows) {
              loaded.push({
                key: `${extension.key}:${row.title}`,
                title: `${extension.name} · ${row.title}`,
                subtitle: 'From an installed Zangetsu extension.',
                items: row.items,
              });
            }
          } else {
            const popular = await anymexCatalog(extension, 'popular');
            if (popular.length) {
              loaded.push({
                key: `${extension.key}:popular`,
                title: `${extension.name} · Popular`,
                subtitle: 'From an installed AnymeX extension.',
                items: popular,
              });
            }
          }
        } catch {
          // A dead extension shows no rows — the other sources keep theirs.
        }
      }));
      if (!cancelled) setRows(loaded.filter((row) => row.items.length));
    };
    void load();
    window.addEventListener('praha:ecosystems-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('praha:ecosystems-changed', load);
    };
  }, []);

  if (!rows.length) return null;
  return (
    <>
      {rows.map((row) => (
        <MediaRow
          key={row.key}
          title={row.title}
          subtitle={row.subtitle}
          items={row.items}
          onSelect={onSelect}
          onToggleWatchlist={onToggleWatchlist}
          watchlist={watchlist}
          compact={compact}
        />
      ))}
    </>
  );
};

export default AnimeExtensionRows;
