// What a portal stream's name says about it.
//
// Ported line for line from VyseTV `lib/data/live_tv/live_tv.dart` (`HitTags`,
// GPL-3.0-or-later). "AR: beIN SPORTS 1 HD" becomes 1 / AR / HD, which is how
// the channel page groups the same feed across ten portals and how MatchFinder
// decides that one guide lookup covers all of them.

export interface HitTags {
  number: string | null;
  lang: string | null;
  quality: string | null;
}

/** Language / region markers VyseTV recognises in stream names. */
const LANGS = new Set([
  'AR', 'EN', 'FR', 'TR', 'ES', 'DE', 'IT', 'PT', 'NL', 'PL', 'RU', 'UK', 'US', 'CA', 'MENA', 'FA', 'UR', 'HI', 'IN',
  'BR', 'MX', 'GR', 'RO', 'AL', 'SE', 'NO', 'DK', 'FI', 'KU', 'HE', 'ID', 'MY', 'PH', 'AF', 'BE', 'CH', 'AT', 'KR', 'JP',
]);

const NUMBER_RE = /^\d{1,2}$/;

/** `HitTags.of('AR: beIN SPORTS 1 HD')` → `{number:'1', lang:'AR', quality:'HD'}`. */
export function hitTagsOf(name: string): HitTags {
  const tokens = String(name || '')
    .toUpperCase()
    .split(/[^A-Z0-9+]+/)
    .filter((token) => token.length > 0);

  const number = tokens.find((token) => NUMBER_RE.test(token)) ?? null;
  const lang = tokens.find((token) => LANGS.has(token)) ?? null;

  let quality: string | null = null;
  if (tokens.some((token) => token === '4K' || token === 'UHD')) quality = '4K';
  else if (tokens.some((token) => token === 'FHD' || token === '1080' || token === '1080P')) quality = 'FHD';
  else if (tokens.includes('HD')) quality = 'HD';
  else if (tokens.includes('SD')) quality = 'SD';

  return { number, lang, quality };
}

/** The grouping key MatchFinder and the channel page share: `number|lang`. */
export function hitTagKey(tags: HitTags): string {
  return `${tags.number ?? ''}|${tags.lang ?? ''}`;
}

/** Human label for a group key, e.g. `1|AR` → `1 · AR`. */
export function hitTagLabel(key: string): string {
  const [number, lang] = key.split('|');
  return [number, lang].filter(Boolean).join(' · ');
}
