// The stream-finding facade over the four ecosystems — what the source list
// asks when a title is playing.
//
// Each ecosystem answers differently (Sora by episode links it found, SkyStream
// by its load/loadStreams pair, Zangetsu by getVideoSources, AnymeX by
// getVideoList), and the title match each one needs is the same shape: search
// its catalog for the title, take the best match, then resolve the episode.
// Hikari keeps this logic in its four provider classes; here it is one module,
// so SourceModal has a single place to ask.

import {
  soraEpisodes, soraSearch, soraStreams,
} from './sora';
import {
  skyStreamSearch, skyStreamStreams,
} from './skystream';
import {
  zangetsuEpisodes, zangetsuSearch, zangetsuStreams,
} from './zangetsu';
import {
  anymexEpisodes, anymexSearch, anymexStreams,
} from './anymex';
import type { EcosystemExtension } from './store';
import type { StreamResult } from '../../types';

/** A title query: what the source list knows about the playing title. */
export interface EcosystemQuery {
  title: string;
  year?: number | null;
  /** The extension's own id, when the title came from this extension. */
  ownId?: string;
  season?: number | null;
  episode?: number | null;
}

/** The loose title compare VyseTV's helpers use, reduced to what matching a
 * search result needs: normalise hard, then exact / prefix / word-subset. */
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function bestTitleMatch<T extends { title: string }>(
  items: T[],
  title: string,
): T | null {
  const wanted = normaliseTitle(title);
  if (!wanted) return null;
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const candidate = normaliseTitle(item.title);
    if (!candidate) continue;
    let score = 0;
    if (candidate === wanted) score = 100;
    else if (candidate.startsWith(wanted) || wanted.startsWith(candidate)) score = 80;
    else {
      const wantedWords = new Set(wanted.split(' '));
      const candidateWords = candidate.split(' ');
      const hits = candidateWords.filter((word) => wantedWords.has(word)).length;
      score = Math.round((hits / Math.max(1, Math.max(wantedWords.size, candidateWords.length))) * 60);
    }
    if (score >= 50 && (!best || score > best.score
      // A tie goes to the more specific title: "One Piece Film: Red" over
      // "One Piece" when the query was "One Piece Film".
      || (score === best.score && item.title.length > best.item.title.length))) best = { item, score };
  }
  return best?.item ?? null;
}

/** The one episode matching the season/episode ask, else the first. */
function pickEpisode<T extends { number: number; season?: number }>(
  episodes: T[],
  season?: number | null,
  episode?: number | null,
): T | null {
  if (!episodes.length) return null;
  if (episode != null) {
    const bySeason = season != null
      ? episodes.find((entry) => (entry.season ?? 1) === season && entry.number === episode)
      : undefined;
    if (bySeason) return bySeason;
    const byNumber = episodes.find((entry) => entry.number === episode);
    if (byNumber) return byNumber;
  }
  return episodes[0];
}

/**
 * One extension asked for one title's streams. Empty (not an error) when the
 * extension has nothing for it — the same contract the plugin engine uses.
 */
export async function findEcosystemStreams(
  extension: EcosystemExtension,
  query: EcosystemQuery,
): Promise<StreamResult[]> {
  const { title, ownId, season, episode } = query;
  // One of the extension's own titles: skip the search, ask by its own id.
  if (ownId) {
    switch (extension.ecosystem) {
      case 'sora': {
        if (extension.kind === 'series') {
          const episodes = await soraEpisodes(extension, ownId);
          const picked = pickEpisode(episodes, season, episode);
          if (picked) return soraStreams(extension, picked.id);
        }
        return soraStreams(extension, ownId);
      }
      case 'skystream':
        return skyStreamStreams(extension, ownId, season, episode);
      case 'zangetsu': {
        const episodes = await zangetsuEpisodes(extension, ownId);
        const picked = episodes ? pickEpisode(episodes.map((entry) => ({ ...entry, season: 1 })), season, episode) : null;
        return zangetsuStreams(extension, picked ? picked.id : ownId);
      }
      case 'anymex': {
        if (extension.kind === 'anime') {
          const episodes = await anymexEpisodes(extension, ownId);
          const picked = pickEpisode(episodes, season, episode);
          if (picked) return anymexStreams(extension, picked.id);
        }
        return anymexStreams(extension, ownId);
      }
    }
  }

  // A foreign title: search first, then resolve the match.
  switch (extension.ecosystem) {
    case 'sora': {
      const results = await soraSearch(extension, title);
      const match = bestTitleMatch(results, title);
      if (!match) return [];
      const own = match.providerMediaId ?? '';
      const episodes = await soraEpisodes(extension, own);
      const picked = pickEpisode(episodes, season, episode);
      return soraStreams(extension, picked ? picked.id : own);
    }
    case 'skystream': {
      const results = await skyStreamSearch(extension, title);
      const match = bestTitleMatch(results, title);
      if (!match?.providerMediaId) return [];
      return skyStreamStreams(extension, match.providerMediaId, season, episode);
    }
    case 'zangetsu': {
      const results = await zangetsuSearch(extension, title);
      const match = bestTitleMatch(results, title);
      if (!match?.providerMediaId) return [];
      const episodes = await zangetsuEpisodes(extension, match.providerMediaId);
      const picked = episodes ? pickEpisode(episodes.map((entry) => ({ ...entry, season: 1 })), season, episode) : null;
      return zangetsuStreams(extension, picked ? picked.id : match.providerMediaId);
    }
    case 'anymex': {
      const results = await anymexSearch(extension, title);
      const match = bestTitleMatch(results, title);
      if (!match?.providerMediaId) return [];
      const episodes = await anymexEpisodes(extension, match.providerMediaId);
      const picked = pickEpisode(episodes, season, episode);
      return anymexStreams(extension, picked ? picked.id : match.providerMediaId);
    }
  }
}
