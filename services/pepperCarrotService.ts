import episodeIndex from '../data/pepperCarrotEpisodes.json';
import type { ComicLanguageFilter } from './comicLanguages';
import { currentNsfwMode } from './nsfwGate';
import type { SankaMangaDetail, SankaTitle, SankaTitlesPage } from './sankaService';

const SITE = 'https://www.peppercarrot.com';
const SERIES = 'pepper-carrot';

// Episode names, page counts, and available translations from the official index at
// https://www.peppercarrot.com/0_sources/episodes.json (bundled for browser use).
const episodes = episodeIndex.map(([directory, pages, translations]) => {
  const name = String(directory);
  const [episode, title] = name.split('_');
  return { name, number: episode.slice(2), title: title.replaceAll('-', ' '), pages: Number(pages), translations: String(translations).split(' ') };
});

function translation(language: ComicLanguageFilter) {
  if (language === 'all') return 'en';
  if (language === 'zh') return 'cn';
  if (language === 'zh-hk') return 'tw';
  if (language === 'pt-br') return 'br';
  if (language === 'es-la') return 'mx';
  if (language === 'ko') return 'kr';
  return language;
}

function image(episode: typeof episodes[number], page = '', code = 'en'): string {
  return `${SITE}/0_sources/${episode.name}/low-res/${code}_Pepper-and-Carrot_by-David-Revoy_E${episode.number}${page}.jpg`;
}

const series: SankaTitle = {
  id: `peppercarrot:${SERIES}`,
  slug: SERIES,
  title: 'Pepper&Carrot',
  summary: 'A fantasy webcomic about Pepper, a young witch, and her cat Carrot.',
  poster: image(episodes[0]),
  comicType: 'Webcomic',
  genres: ['Fantasy'],
  kind: 'comic',
  source: 'peppercarrot',
  sourceUrl: `${SITE}/en/webcomics/peppercarrot.html`,
};

export function pepperCarrotCatalog(query: string, page: number, language: ComicLanguageFilter = 'all'): SankaTitlesPage {
  const term = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const matches = term.split(' ').every((word) => 'pepper and carrot david revoy fantasy webcomic'.includes(word))
    || episodes.some(({ title }) => title.toLowerCase().includes(term));
  return { items: page === 1 && matches && episodes.some((episode) => episode.translations.includes(translation(language))) && currentNsfwMode() !== 'only' ? [series] : [], page, hasMore: false };
}

export function pepperCarrotDetail(language: ComicLanguageFilter = 'all'): SankaMangaDetail {
  const code = translation(language);
  return {
    ...series,
    author: 'David Revoy',
    chapters: episodes.filter((episode) => episode.translations.includes(code)).map(({ name, title, number }) => ({
      id: name, slug: name, language: language === 'all' ? 'en' : language, title: `Episode ${Number(number)} · ${title}`,
    })),
  };
}

export function pepperCarrotPages(id: string, language: ComicLanguageFilter = 'all'): string[] {
  const episode = episodes.find(({ name }) => name === id);
  const code = translation(language);
  if (!episode?.translations.includes(code)) throw new Error('This Pepper&Carrot episode is unavailable.');
  // The official count excludes the credits page. Page numbers start at zero.
  return Array.from({ length: episode.pages + 1 }, (_, index) => image(episode, `P${String(index).padStart(2, '0')}`, code));
}
