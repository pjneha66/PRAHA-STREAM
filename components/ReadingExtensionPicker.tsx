import { useState, type ReactNode } from 'react';
import type { NsfwMode } from '../types';
import type { ReadingLibraryProps } from '../services/readingLibrary';
import { installedReadingExtensions } from '../services/ecosystems/reading';
import MangaView from './MangaView';
import NovelsView from './NovelsView';

export default function ReadingExtensionPicker({ mode, adultMode, children, ...library }: ReadingLibraryProps & {
  mode: 'comics' | 'books';
  adultMode: NsfwMode;
  children: ReactNode;
}) {
  const [extensions, setExtensions] = useState(false);
  const available = installedReadingExtensions(mode === 'comics' ? 'manga' : 'novel', adultMode);

  if (!available.length) return children;
  return <>
    <div className="reading-controls standard-page" style={{ paddingBottom: 0 }}>
      <label>Catalog <select className="reading-select" value={extensions ? 'extensions' : 'built-in'}
        onChange={(event) => setExtensions(event.target.value === 'extensions')}>
        <option value="built-in">{mode === 'comics' ? 'Comics sources' : 'Book sources'}</option>
        <option value="extensions">Installed extensions</option>
      </select></label>
    </div>
    <div hidden={extensions}>{children}</div>
    {extensions && (mode === 'comics'
      ? <MangaView {...library} adultMode={adultMode} extensionOnly heading="Comics" />
      : <NovelsView adultMode={adultMode} extensionOnly heading="Books" />)}
  </>;
}
