// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DISCOVER_LANGUAGES, mapTmdbItem } from '../services/tmdbService';

/**
 * "Pick which content you want to see — Arabic, Turkish, German" is a language
 * filter, and it only works if two things hold: the picker offers the codes the
 * filter sends, and every search result carries its language so it can be
 * filtered on the device. The second was missing until it was fixed here, which
 * made the picker empty the results of any search.
 */

describe('DISCOVER_LANGUAGES — the picker\'s list', () => {
  it('starts with "any language", so no filter is the default', () => {
    expect(DISCOVER_LANGUAGES[0]).toEqual({ code: 'all', label: 'Any language' });
  });

  it('offers the languages VyseTV offers, in its order', () => {
    expect(DISCOVER_LANGUAGES.map((language) => language.code)).toEqual([
      'all', 'en', 'ja', 'ko', 'es', 'fr', 'hi', 'zh', 'it', 'de', 'pt', 'tr', 'th', 'sv', 'da',
    ]);
  });

  it('names the ones the request asks for, so they can be found in the list', () => {
    const labels = DISCOVER_LANGUAGES.map((language) => language.label);
    expect(labels).toEqual(expect.arrayContaining(['German', 'Turkish']));
    expect(DISCOVER_LANGUAGES.find((language) => language.code === 'tr')?.label).toBe('Turkish');
    expect(DISCOVER_LANGUAGES.find((language) => language.code === 'de')?.label).toBe('German');
  });

  it('has a label and a unique code for every entry', () => {
    const codes = DISCOVER_LANGUAGES.map((language) => language.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const language of DISCOVER_LANGUAGES) expect(language.label.trim(), language.code).not.toBe('');
  });
});

describe('mapTmdbItem — every result carries its language', () => {
  const row = {
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    poster_path: '/p.jpg',
    release_date: '1999-10-15',
    original_language: 'en',
    genre_ids: [18],
  };

  it('keeps the original language, uppercased as `enrich` does', () => {
    expect(mapTmdbItem(row)?.originalLanguage).toBe('EN');
  });

  it('answers with no language rather than an empty one when TMDB gives none', () => {
    expect(mapTmdbItem({ ...row, original_language: undefined })?.originalLanguage).toBeUndefined();
    expect(mapTmdbItem({ ...row, original_language: '' })?.originalLanguage).toBeUndefined();
    expect(mapTmdbItem({ ...row, original_language: 42 as never })?.originalLanguage).toBeUndefined();
  });

  it('carries a language for a show as well as a film', () => {
    expect(mapTmdbItem({ ...row, media_type: 'tv', name: 'A Show', original_language: 'tr' })?.originalLanguage).toBe('TR');
  });

  it('matches the code the picker filters by, in any case', () => {
    // `DiscoverView` compares lowercased, so "TR" from TMDB matches "tr" from the picker.
    const item = mapTmdbItem({ ...row, original_language: 'tr' });
    expect((item?.originalLanguage || '').toLowerCase()).toBe('tr');
  });
});
