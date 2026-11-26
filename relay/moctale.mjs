import { load } from 'cheerio';

const origin = 'https://www.moctale.in';
const labels = ['Perfection', 'Go for it', 'Timepass', 'Skip'];
const formats = { movie: /^(?:movie|film)$/i, series: /^(?:show|tv series|series|tv show)$/i, anime: /^(?:anime|movie|film|show|tv series|series|tv show)$/i };

function slug(value) {
  return value.toLowerCase().normalize('NFKD').replace(/\p{Mark}/gu, '')
    .replace(/['’]/g, '').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '');
}

export function moctaleLookup(title, year, type) {
  if (typeof title !== 'string' || !title.trim() || title.length > 160 || !/^\d{4}$/.test(year) || !Object.hasOwn(formats, type)) return null;
  const normalized = slug(title);
  if (!normalized) return null;
  const path = encodeURIComponent(`${normalized}-${year}`);
  return { normalized, year, type, url: `${origin}/content/${path}` };
}

export function parseMoctaleMeter(html, lookup) {
  const $ = load(html);
  const name = $('h1').first().text().trim();
  const meta = $('meta[property="og:title"]').attr('content') || $('title').first().text();
  if (slug(name) !== lookup.normalized || !meta.includes(`(${lookup.year})`)) return null;

  const leaves = $('body *').filter((_, element) => $(element).children().length === 0);
  if (!leaves.toArray().some((element) => {
    const [type, year] = $(element).text().split(/[•·]/u);
    return formats[lookup.type].test(type.trim()) && (year === undefined || year.trim() === lookup.year);
  })) return null;
  const heading = leaves.filter((_, element) => $(element).text().trim() === 'Moctale Meter').first();
  for (const parent of heading.parents().slice(0, 6).toArray()) {
    const section = $(parent);
    const tokens = section.find('*').filter((_, element) => $(element).children().length === 0)
      .map((_, element) => $(element).text().trim()).get().filter(Boolean);
    const text = tokens.join(' ').split('User Reviews', 1)[0];
    const buckets = labels.map((label) => {
      const match = text.match(new RegExp(`(?:^|\\s)${label}\\s+(\\d{1,3}(?:\\.\\d+)?)\\s*%`, 'i'));
      return { label, percent: match ? Number(match[1]) : NaN };
    });
    if (buckets.every(({ percent }) => Number.isFinite(percent) && percent >= 0 && percent <= 100)) {
      const total = buckets.reduce((sum, { percent }) => sum + percent, 0);
      if (total < 96 || total > 104) return null;
      return { buckets, noReviews: /\bNo Reviews Yet\b/i.test(text) };
    }
  }
  return null;
}

export async function fetchMoctaleMeter(lookup, fetcher = fetch) {
  try {
    const response = await fetcher(lookup.url, {
      headers: { Accept: 'text/html', 'User-Agent': 'PRAHA-STREAM' },
      redirect: 'error',
      signal: AbortSignal.timeout(6500),
    });
    if (response.status === 404) return { state: 'unlisted' };
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      return { state: 'unavailable', url: lookup.url };
    }
    const html = await response.text();
    if (/<title>\s*Just a moment/i.test(html)) return { state: 'unavailable', url: lookup.url };
    const meter = parseMoctaleMeter(html, lookup);
    return meter ? { state: 'ready', url: lookup.url, ...meter } : { state: 'unlisted' };
  } catch {
    return { state: 'unavailable', url: lookup.url };
  }
}
