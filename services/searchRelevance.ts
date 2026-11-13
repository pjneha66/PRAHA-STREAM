/**
 * Search relevance scorer (port of PlayTorrio's RelevanceScorer): ranks
 * cross-source search results so exact matches beat substring noise.
 */

const ARTICLE_RE = /^(the|a|an)\s+/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(ARTICLE_RE, '').replace(/\s+/g, ' ').trim();
}

export interface ScoreableTitle {
  title: string;
  year?: string;
}

export function relevanceScore(query: string, candidate: ScoreableTitle): number {
  const q = normalize(query);
  const t = normalize(candidate.title);
  if (!q || !t) return 0;

  let score = 0;
  if (t === q) score += 10000;
  else if (t.includes(q)) score += 5000;
  else if (t.startsWith(q)) score += 3000;
  else {
    // Token overlap: proportion of query words present in the title.
    const qTokens = q.split(' ').filter(Boolean);
    if (qTokens.length) {
      const hit = qTokens.filter((token) => t.includes(token)).length / qTokens.length;
      score += Math.round(hit * 2000);
    }
  }

  // Year proximity bonus when the query ends with a year.
  const yearInQuery = query.match(/\b(19|20)\d{2}\b/);
  if (yearInQuery && candidate.year && yearInQuery[0] === candidate.year) score += 800;

  // Short titles that match exactly are stronger signals than long ones.
  if (score >= 5000) score += Math.max(0, 500 - t.length);
  return score;
}

/** Sorts scored items best-first; stable for equal scores (keeps source order). */
export function sortByRelevance<T extends ScoreableTitle>(query: string, items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, score: relevanceScore(query, item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
