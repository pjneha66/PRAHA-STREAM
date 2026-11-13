/**
 * User-importable stream badge rules (port of Nuvio's StreamBadgeRules):
 * one regex per line in Settings → Streams; the first matching rule's label
 * is rendered as a colored badge on the stream. Rules persist locally.
 */

const KEY = 'praha.stream.badgeRules.v1';

export interface BadgeRule {
  pattern: string;
  label: string;
  color: string;
}

export function readBadgeRules(): BadgeRule[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as BadgeRule[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((rule) => rule && typeof rule.pattern === 'string' && typeof rule.label === 'string').slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

export function saveBadgeRules(rules: BadgeRule[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rules.slice(0, 30)));
  } catch {
    // best effort
  }
}

const compiledCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (compiledCache.has(pattern)) return compiledCache.get(pattern)!;
  let result: RegExp | null = null;
  try {
    result = new RegExp(pattern, 'i');
  } catch {
    result = null;
  }
  compiledCache.set(pattern, result);
  return result;
}

/** First matching rule for a stream title (provider + title text). */
export function matchBadgeRule(text: string): BadgeRule | null {
  const haystack = text || '';
  for (const rule of readBadgeRules()) {
    const re = compile(rule.pattern);
    if (re && re.test(haystack)) return rule;
  }
  return null;
}
