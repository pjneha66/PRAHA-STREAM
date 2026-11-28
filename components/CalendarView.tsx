import { useCallback, useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import {
  CALENDAR_COUNTRIES, countryName, groupAnime, loadAnimeCalendar, loadTmdbCalendar,
  type AnimeRelease, type CalendarKind, type DayGroup,
} from '../services/releaseCalendar';
import { mapTmdbItem } from '../services/tmdbService';
import type { MediaItem } from '../types';
import { Artwork } from './MediaCard';

/**
 * Release Calendar — port of Hikari's AnimeCalendarScreen.kt: three pages
 * (Anime / Movies / Series) of upcoming releases grouped by day. Anime rows
 * launch a title search; TMDB rows open the title directly.
 */

const REGION_KEY = 'praha.calendar.region.v1';

type Tab = 'anime' | 'movies' | 'series';

const TABS: Array<{ id: Tab; label: string; subtitle: string }> = [
  { id: 'anime', label: 'Anime', subtitle: 'Anime episodes' },
  { id: 'movies', label: 'Movies', subtitle: 'Upcoming movies' },
  { id: 'series', label: 'Series', subtitle: 'Airing series' },
];

function savedRegion(): string {
  try {
    const value = localStorage.getItem(REGION_KEY);
    return CALENDAR_COUNTRIES.some(([code]) => code === value) ? value as string : 'US';
  } catch {
    return 'US';
  }
}

function airTime(release: AnimeRelease): string {
  const date = new Date(release.airAt);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function CalendarView({ onOpenMedia }: { onOpenMedia: (item: MediaItem) => void }) {
  const [tab, setTab] = useState<Tab>('anime');
  const [region, setRegion] = useState<string>(savedRegion);
  const [anime, setAnime] = useState<DayGroup[] | null>(null);
  const [tmdb, setTmdb] = useState<Partial<Record<'movies' | 'series', DayGroup[]>>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (target: Tab, regionCode: string) => {
    setError('');
    setBusy(target === 'anime' ? 'Loading anime calendar…' : target === 'movies' ? 'Loading upcoming movies…' : 'Loading airing series…');
    try {
      if (target === 'anime') {
        const releases = await loadAnimeCalendar();
        setAnime(groupAnime(releases));
      } else {
        const kind: CalendarKind = target === 'movies' ? 'movie' : 'tv';
        const groups = await loadTmdbCalendar(kind, regionCode);
        setTmdb((prev) => ({ ...prev, [target]: groups }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The calendar could not be loaded.');
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => {
    if (tab === 'anime') {
      if (!anime) void load('anime', region);
      return;
    }
    if (!tmdb[tab]) void load(tab, region);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function changeRegion(next: string) {
    setRegion(next);
    try { localStorage.setItem(REGION_KEY, next); } catch { /* private mode */ }
    setTmdb({});
    if (tab !== 'anime') void load(tab, next);
  }

  function openTmdbEntry(kind: 'movie' | 'tv') {
    return (entry: DayGroup['entries'][number]) => {
      const item = mapTmdbItem(entry.raw, kind);
      if (item) onOpenMedia(item);
    };
  }

  function openAnime(release: AnimeRelease) {
    onOpenMedia({
      id: `calendar-anime:${release.simklId}:${release.airAt}`,
      title: release.title,
      type: 'series',
      source: 'calendar',
      overview: release.episode ? `Episode ${release.episode} airs at ${airTime(release)}.` : '',
      poster: release.poster || '',
      genres: [],
    });
  }

  const groups = tab === 'anime' ? anime : tmdb[tab === 'movies' ? 'movies' : 'series'];
  const subtitle = TABS.find((t) => t.id === tab)?.subtitle ?? '';

  return <>
    <section className="install-panel">
      <h2><CalendarDays size={20} /> Release Calendar</h2>
      <p>{subtitle}{tab !== 'anime' ? ` · ${countryName(region)}` : ''}</p>
      <div className="directory-actions" role="group" aria-label="Calendar sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="button button-secondary" aria-pressed={tab === t.id}
            disabled={Boolean(busy)} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
        {tab !== 'anime' && <select className="reading-select" aria-label="Calendar region" value={region}
          disabled={Boolean(busy)} onChange={(event) => changeRegion(event.target.value)}>
          {CALENDAR_COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>}
      </div>
      {busy && <p role="status">{busy}</p>}
      {error && <p className="install-error" role="alert">{error}</p>}
    </section>

    {groups && !groups.length && <p>Nothing scheduled right now.</p>}
    {tab === 'anime' && groups?.map((group) => <section key={group.sortKey} className="calendar-day">
      <h3>{group.label}</h3>
      <div className="directory-grid">
        {group.entries.map((entry) => {
          const release = entry.raw as unknown as AnimeRelease;
          return <article className="directory-card" key={`${release.simklId}:${release.airAt}:${release.episode ?? ''}`}>
            {entry.poster && <div className="source-title-art"><Artwork src={entry.poster} alt="" /></div>}
            <h4>{entry.title}</h4>
            <p>{entry.blurb || `Airs at ${airTime(release)}`}{release.totalEpisodes ? ` · ${release.totalEpisodes} episodes` : ''}</p>
            <div className="directory-actions">
              <button className="button button-primary" disabled={Boolean(busy)} onClick={() => openAnime(release)}>Open sources</button>
            </div>
          </article>;
        })}
      </div>
    </section>)}
    {tab !== 'anime' && groups?.map((group) => <section key={group.sortKey} className="calendar-day">
      <h3>{group.label}</h3>
      <div className="directory-grid">
        {group.entries.map((entry) => <article className="directory-card" key={`${entry.kind}:${entry.tmdbId}`}>
          {entry.poster && <div className="source-title-art"><Artwork src={entry.poster} alt="" /></div>}
          <h4>{entry.title}{entry.year ? ` (${entry.year})` : ''}</h4>
          <p>{entry.blurb || entry.genres.join(' · ')}</p>
          <div className="directory-actions">
            <button className="button button-primary" disabled={Boolean(busy)}
              onClick={() => openTmdbEntry(entry.kind === 'movie' ? 'movie' : 'tv')(entry)}>Open title</button>
          </div>
        </article>)}
      </div>
    </section>)}
  </>;
}
