export const COMIC_LANGUAGES = {
  en: 'English', es: 'Spanish', 'es-la': 'Spanish (Latin America)', fr: 'French',
  pt: 'Portuguese', 'pt-br': 'Portuguese (Brazil)', id: 'Indonesian',
  zh: 'Chinese (Simplified)', 'zh-hk': 'Chinese (Traditional)', ja: 'Japanese',
  ko: 'Korean', vi: 'Vietnamese', de: 'German', it: 'Italian',
  ar: 'Arabic', hi: 'Hindi', ru: 'Russian',
} as const;

export type ComicLanguage = keyof typeof COMIC_LANGUAGES;
export type ComicLanguageFilter = ComicLanguage | 'all';
