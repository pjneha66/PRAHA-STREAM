import type { AppSettings, InstalledAddon, MediaItem, WatchProgress } from '../types';

const tmdb = (path: string, size = 'w780') => `https://image.tmdb.org/t/p/${size}${path}`;

export const CURATED_MEDIA: MediaItem[] = [
  {
    id: 'tmdb:693134', tmdbId: 693134, imdbId: 'tt15239678', type: 'movie',
    title: 'Dune: Part Two', year: '2024', rating: 8.2, runtime: '2h 46m', maturity: 'PG-13',
    genres: ['Sci-fi', 'Adventure', 'Drama'], source: 'praha',
    overview: 'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family. As he faces a choice between the love of his life and the fate of the known universe, he endeavors to prevent a terrible future.',
    poster: tmdb('/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg'), backdrop: '/images/dune-hero.jpg',
  },
  {
    id: 'tmdb:872585', tmdbId: 872585, imdbId: 'tt15398776', type: 'movie',
    title: 'Oppenheimer', year: '2023', rating: 8.1, runtime: '3h 1m', maturity: 'R',
    genres: ['Drama', 'History', 'Thriller'], source: 'praha',
    overview: 'The story of American scientist J. Robert Oppenheimer and his role in the development of the atomic bomb, and the profound consequences that followed.',
    poster: tmdb('/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg'), backdrop: tmdb('/rLb2cwF3Pazuxaj0sRXQ037tGI1.jpg', 'original'),
  },
  {
    id: 'tmdb:414906', tmdbId: 414906, imdbId: 'tt1877830', type: 'movie',
    title: 'The Batman', year: '2022', rating: 7.7, runtime: '2h 56m', maturity: 'PG-13',
    genres: ['Crime', 'Mystery', 'Thriller'], source: 'praha',
    overview: 'In his second year of fighting crime, Batman uncovers corruption in Gotham City that connects to his own family while facing a serial killer known as the Riddler.',
    poster: '/images/the-batman.jpg', backdrop: tmdb('/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg', 'original'),
  },
  {
    id: 'tmdb:666277', tmdbId: 666277, imdbId: 'tt13238346', type: 'movie',
    title: 'Past Lives', year: '2023', rating: 7.8, runtime: '1h 46m', maturity: 'PG-13',
    genres: ['Romance', 'Drama'], source: 'praha',
    overview: 'Two deeply connected childhood friends are separated after one family emigrates from South Korea. Decades later, they reunite in New York for one fateful week.',
    poster: '/images/past-lives.jpg',
  },
  {
    id: 'tmdb:126308', tmdbId: 126308, imdbId: 'tt2788316', type: 'series',
    title: 'Shōgun', year: '2024', rating: 8.5, runtime: '10 episodes', maturity: 'TV-MA',
    genres: ['Drama', 'History', 'Adventure'], source: 'praha',
    overview: 'In Japan in the year 1600, Lord Yoshii Toranaga is fighting for his life as his enemies unite against him, when a mysterious European ship is found marooned in a nearby fishing village.',
    poster: '/images/shogun.jpg', backdrop: '/images/shogun.jpg',
  },
  {
    id: 'tmdb:95396', tmdbId: 95396, imdbId: 'tt11280740', type: 'series',
    title: 'Severance', year: '2022', rating: 8.4, runtime: '2 seasons', maturity: 'TV-MA',
    genres: ['Sci-fi', 'Drama', 'Mystery'], source: 'praha',
    overview: 'Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives. When a mysterious colleague appears outside of work, it begins a journey to discover the truth about their jobs.',
    poster: tmdb('/lFf6LLrQjYldcZItzOkGmMMigP7.jpg'), backdrop: '/images/severance-wide.jpg',
  },
  {
    id: 'tmdb:100088', tmdbId: 100088, imdbId: 'tt3581920', type: 'series',
    title: 'The Last of Us', year: '2023', rating: 8.6, runtime: '2 seasons', maturity: 'TV-MA',
    genres: ['Drama', 'Sci-fi', 'Adventure'], source: 'praha',
    overview: 'Twenty years after modern civilization has been destroyed, Joel is hired to smuggle Ellie out of an oppressive quarantine zone. What starts as a small job soon becomes a brutal, heartbreaking journey.',
    poster: '/images/the-last-of-us.jpg', backdrop: tmdb('/uDgy6hyPd82kOHh6I95FLtLnj6p.jpg', 'original'),
  },
  {
    id: 'tmdb:569094', tmdbId: 569094, imdbId: 'tt9362722', type: 'movie',
    title: 'Across the Spider-Verse', year: '2023', rating: 8.4, runtime: '2h 20m', maturity: 'PG',
    genres: ['Animation', 'Action', 'Adventure'], source: 'praha',
    overview: 'Miles Morales catapults across the Multiverse, where he encounters a team of Spider-People charged with protecting its very existence.',
    poster: tmdb('/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg'),
  },
  {
    id: 'tmdb:792307', tmdbId: 792307, imdbId: 'tt14230458', type: 'movie',
    title: 'Poor Things', year: '2023', rating: 7.8, runtime: '2h 21m', maturity: 'R',
    genres: ['Fantasy', 'Romance', 'Comedy'], source: 'praha',
    overview: 'Brought back to life by an unorthodox scientist, a young woman runs off with a debauched lawyer on a whirlwind adventure across the continents.',
    poster: tmdb('/kCGlIMHnOm8JPXq3rXM6c5wMxcT.jpg'),
  },
  {
    id: 'tmdb:106379', tmdbId: 106379, imdbId: 'tt12637874', type: 'series',
    title: 'Fallout', year: '2024', rating: 8.3, runtime: '2 seasons', maturity: 'TV-MA',
    genres: ['Sci-fi', 'Drama', 'Action'], source: 'praha',
    overview: 'In a future, post-apocalyptic Los Angeles brought about by nuclear decimation, citizens must live in underground bunkers to protect themselves from radiation, mutants and bandits.',
    poster: tmdb('/AnsSKR9LuK0T9bAOcPVA3PUvyWj.jpg'),
  },
  {
    id: 'tmdb:119051', tmdbId: 119051, imdbId: 'tt13443470', type: 'series',
    title: 'Wednesday', year: '2022', rating: 8.0, runtime: '2 seasons', maturity: 'TV-14',
    genres: ['Comedy', 'Mystery', 'Fantasy'], source: 'praha',
    overview: 'Wednesday Addams is sent to Nevermore Academy, where she attempts to master her psychic powers and solve a monstrous killing spree.',
    poster: tmdb('/9PFonBhy4cQy7Jz20NpMygczOkv.jpg'),
  },
  {
    id: 'tmdb:157336', tmdbId: 157336, imdbId: 'tt0816692', type: 'movie',
    title: 'Interstellar', year: '2014', rating: 8.4, runtime: '2h 49m', maturity: 'PG-13',
    genres: ['Sci-fi', 'Drama', 'Adventure'], source: 'praha',
    overview: 'A team of explorers travel through a wormhole in space in an attempt to ensure humanity’s survival.',
    poster: tmdb('/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg'), backdrop: tmdb('/xJHokMBLjvjADY5kAQ3Oc0Nui8.jpg', 'original'),
  },
];

export const FEATURED_MEDIA = [CURATED_MEDIA[0], CURATED_MEDIA[4], CURATED_MEDIA[5]];

export const DEFAULT_PROGRESS: WatchProgress[] = [
  { media: CURATED_MEDIA[0], progress: 64, watchedAt: Date.now(), },
  { media: CURATED_MEDIA[5], progress: 38, watchedAt: Date.now() - 1000, season: 1, episode: 4 },
  { media: CURATED_MEDIA[2], progress: 81, watchedAt: Date.now() - 2000 },
  { media: CURATED_MEDIA[6], progress: 22, watchedAt: Date.now() - 3000, season: 1, episode: 3 },
];

export const CINEMETA_ADDON: InstalledAddon = {
  manifestUrl: 'https://v3-cinemeta.strem.io/manifest.json',
  enabled: true,
  installedAt: Date.now(),
  updatedAt: Date.now(),
  manifest: {
    id: 'org.stremio.cinemeta',
    name: 'Cinemeta',
    description: 'Metadata and catalogs for movies and series.',
    version: '3.0.0',
    logo: 'https://www.stremio.com/website/stremio-logo-small.png',
    types: ['movie', 'series'],
    resources: [
      { name: 'catalog', types: ['movie', 'series'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] },
    ],
    catalogs: [
      { type: 'movie', id: 'top', name: 'Popular movies', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] },
      { type: 'series', id: 'top', name: 'Popular series', extra: [{ name: 'genre' }, { name: 'skip' }, { name: 'search' }] },
    ],
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  autoplay: true,
  compactCards: false,
  reduceMotion: false,
  preferredLanguage: 'en',
  accent: 'lime',
  tmdbApiKey: '',
};
