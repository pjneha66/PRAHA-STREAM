// VyseTV plugin helpers — a direct port of `assets/plugins/helpers.js` from
// VyseTV (GPL-3.0-or-later). A plugin written against VyseTV expects these as
// globals: `searchQueries`, `parseTitle`, `titleScore`, `bestMatch`,
// `searchBest`, `searchByImdb`, `imdbMatches`, `parseHtml`, `unescapeHtml`.
//
// Kept behaviour-for-behaviour with upstream on purpose: plugins are written by
// third parties against this exact behaviour, and "close enough" title matching
// would silently change which film a plugin picks. Do not tidy.
//
// This is a *module* rather than a script to be evaluated: the sandbox copies
// these functions onto its global object (`Object.assign`), so no dynamic
// evaluation is involved in making them available. The bodies are upstream's,
// with types added.
//
//   searchQueries(query)            -> the strings to search a site for, best first
//   parseTitle(raw)                 -> { title, year, season } from a listing like "Dune (2021) 1080p S02"
//   titleScore(candidate, query)    -> 0..100, how well a listing's title matches the film or show
//   rankMatches(items, query, get)  -> matching items, best first
//   bestMatch(items, query, get)    -> the best matching item, or null
//   searchBest(query, search, get)  -> tries each search string until a match turns up
//   searchByImdb(query, search, pageOf, accept) -> the last resort
//   imdbMatches(text, query)        -> true / false / null
//
// `get(item)` returns a string (the listing's title) or { title, year?, season? }.

/** What the matchers need to know about the title asked for. */
export interface MatchQuery {
  title?: string;
  originalTitle?: string;
  titles?: string[];
  year?: number | null;
  season?: number | null;
  isTv?: boolean;
  imdbId?: string | null;
}

export interface ParsedTitle {
  title: string;
  year: number | null;
  season: number | null;
}

type Getter = (item: unknown) => string | { title?: string; year?: number | null; season?: number | null } | null;

export function normTitle(s: unknown): string {
  let v = String(s == null ? '' : s).toLowerCase();
  try {
    v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    // an engine without String#normalize: the name is compared as written
  }
  return v.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
}

const _loose = (s: string) => s.replace(/\b(the|a|an)\b/g, ' ').replace(/ +/g, '');
const _stripArticle = (s: string) => s.replace(/^(the|a|an) /, '');

/** Every name this title is known by, distinct, at most 6. */
export function titleList(query: MatchQuery): string[] {
  const out: string[] = [];
  const seen: Record<string, number> = {};
  for (const t of [query.title, query.originalTitle].concat(query.titles || [])) {
    const n = normTitle(t);
    const key = n.replace(/ /g, '');
    if (!key || seen[key] || out.length >= 6) continue;
    seen[key] = 1;
    out.push(String(t));
  }
  return out;
}

/**
 * What to type into a site's search box, in the order to try: the title, the same
 * without punctuation, the original title and the first aliases; for a show past
 * season 1 also "Title Season 2" and "Title S2".
 */
export function searchQueries(query: MatchQuery): string[] {
  const names = titleList(query);
  const out: string[] = [];
  const seen: Record<string, number> = {};
  const add = (value: unknown) => {
    const q = String(value || '').replace(/^ +| +$/g, '');
    const k = q.toLowerCase();
    if (!q || seen[k] || out.length >= 10) return;
    seen[k] = 1;
    out.push(q);
  };
  if (names.length) {
    add(names[0]);
    const plain = normTitle(names[0]);
    if (plain !== names[0].toLowerCase()) add(plain);
  }
  names.slice(1, 4).forEach((n) => {
    if (normTitle(n).replace(/ /g, '').length >= 4) add(n);
  });
  if (query.isTv && Number(query.season) > 1 && names.length) {
    add(`${names[0]} Season ${query.season}`);
    add(`${names[0]} S${query.season}`);
  }
  // last resorts (a request each, only reached when the strings above found nothing)
  if (names.length) {
    if (!query.isTv && query.year) add(`${names[0]} ${query.year}`);
    const head = names[0].split(/\s*[:\u2013\u2014]\s*|\s+-\s+/)[0];
    if (head !== names[0] && normTitle(head).replace(/ /g, '').length >= 4) add(head);
  }
  return out;
}

/**
 * "Oppenheimer (2023) BluRay 1080p Dual Audio" -> { title: 'Oppenheimer', year: 2023, season: null }
 * "Breaking Bad Season 2 Complete"            -> { title: 'Breaking Bad', year: null, season: 2 }
 */
export function parseTitle(raw: unknown): ParsedTitle {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').replace(/^ +| +$/g, '');
  let year: number | null = null;
  let season: number | null = null;
  let m: RegExpMatchArray | null;
  const bracket = s.search(/[\(\[]/);
  const cuts: number[] = [];
  // the year: "(2023)" if there is one; otherwise the last bare 4-digit year
  m = s.match(/[\(\[]((?:19|20)\d\d)[\)\]]/);
  if (m) year = +m[1];
  else {
    const re = /(?:^|[ .])((?:19|20)\d\d)(?=$|[ .\-\)\]])/g;
    let last: RegExpExecArray | RegExpMatchArray | null = null;
    for (const x of s.matchAll(re)) last = x;
    if (last) {
      year = +last[1];
      if ((last as RegExpMatchArray).index! > 0) cuts.push((last as RegExpMatchArray).index!);
    }
  }
  m = s.match(/\bseasons? *0*(\d{1,2})\b/i) || s.match(/\bS0*(\d{1,2})(?:E\d+)?\b/);
  if (m) season = +m[1];
  if (bracket > 0) cuts.push(bracket);
  const tok = s.search(
    /\s-\s|\b(?:480|576|720|1080|2160|4k|uhd)p?\b|\bseasons?\s*\d|\bS\d{1,2}\b|\b(?:blu-?ray|web-?dl|webrip|hdrip|hdtv|dvdrip|brrip|x26[45]|hevc|dual audio|complete)\b/i,
  );
  if (tok > 0) cuts.push(tok);
  const cut = cuts.length ? Math.min.apply(null, cuts) : -1;
  const title = (cut > 0 ? s.slice(0, cut) : s).replace(/[\s:\-\u2013\u2014,.]+$/g, '');
  return { title, year, season };
}

function _scoreAgainst(candidate: unknown, names: string[]): number {
  const c = normTitle(candidate);
  if (!c) return 0;
  const cs = _stripArticle(c);
  const calpha = c.replace(/ /g, '');
  let best = 0;
  for (const t of names) {
    const q = normTitle(t);
    if (!q) continue;
    const qs = _stripArticle(q);
    if (c === q || cs === qs || calpha === q.replace(/ /g, '')) best = Math.max(best, 100);
    else if (_loose(c) && _loose(c) === _loose(q)) best = Math.max(best, 90);
    else if (c.indexOf(`${q} `) === 0 || cs.indexOf(`${qs} `) === 0) best = Math.max(best, 60);
    else if (q.indexOf(`${c} `) === 0 && c.length >= 4) best = Math.max(best, 40);
  }
  return best;
}

/**
 * How well a listing's title is the one asked for: 100 same name, 60 the listing
 * continues the name ("Breaking Bad Season 2"), 40 the listing is the name's
 * shorter form. 0 is no match.
 */
export function titleScore(candidate: unknown, query: MatchQuery): number {
  return _scoreAgainst(candidate, titleList(query));
}

function _aliasScore(title: unknown, query: MatchQuery, yearFits: boolean, hasYear: boolean): number {
  let best = 0;
  for (const name of titleList(query)) {
    const sc = _scoreAgainst(title, [name]);
    if (!sc) continue;
    const words = normTitle(name).split(' ').length;
    const letters = normTitle(name).replace(/ /g, '').length;
    if (yearFits) best = Math.max(best, Math.min(sc, 70));
    else if (!hasYear && (words >= 2 || letters >= 9)) best = Math.max(best, Math.min(sc, 50));
  }
  return best;
}

/**
 * Items that match the film or show, best first. A film's year must be within 1
 * of the listing's when both are known; a show is never turned down for its year.
 * A listing for the wrong season ranks lower. `minScore` defaults to 40.
 */
export function rankMatches(items: unknown[], query: MatchQuery, get?: Getter, minScore?: number): unknown[] {
  const out: Array<{ item: unknown; score: number; i: number }> = [];
  const primary = [query.title, query.originalTitle].filter(Boolean) as string[];
  (items || []).forEach((item, i) => {
    const g = get ? get(item) : (item as any);
    const info: ParsedTitle =
      typeof g === 'string'
        ? parseTitle(g)
        : { title: String((g as any)?.title ?? ''), year: (g as any)?.year ?? null, season: (g as any)?.season ?? null };
    const title = info.title != null ? info.title : '';
    const year = info.year != null ? +info.year : null;
    const yearFits = Boolean(query.year && year && Math.abs(year - query.year!) <= 1);
    let score = _scoreAgainst(title, primary);
    if (typeof g === 'string' && score === 0) score = _scoreAgainst(g, primary);
    if (!score) score = _aliasScore(title, query, yearFits, year != null);
    if (!score) return;
    if (!query.isTv && query.year && year && !yearFits) return;
    if (!query.isTv && yearFits && year === query.year) score += 20;
    if (query.isTv && query.season && info.season != null) score += info.season === query.season ? 15 : -15;
    if (score >= (minScore || 40)) out.push({ item, score, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.map((r) => r.item);
}

export function bestMatch(items: unknown[], query: MatchQuery, get?: Getter): unknown | null {
  return rankMatches(items, query, get)[0] || null;
}

/** Searches the site with each string from `searchQueries()` until a listing matches. */
export async function searchBest(
  query: MatchQuery,
  search: (text: string) => Promise<unknown[]>,
  get?: Getter,
): Promise<unknown | null> {
  for (const q of searchQueries(query)) {
    let items: unknown[];
    try {
      items = await search(q);
    } catch {
      items = [];
    }
    const match = bestMatch(items, query, get);
    if (match) return match;
  }
  return null;
}

/**
 * The last resort: ask the site's own search for the IMDb id. A result only
 * counts when its page names the same id. Tries at most 3 listings.
 */
export async function searchByImdb(
  query: MatchQuery,
  search: (text: string) => Promise<unknown[]>,
  pageOf: (item: unknown) => Promise<string>,
  accept?: (item: unknown) => boolean,
): Promise<{ item: unknown; page: string } | null> {
  if (!query.imdbId) return null;
  let items: unknown[];
  try {
    items = await search(query.imdbId);
  } catch {
    return null;
  }
  items = (items || []).filter((it) => !accept || accept(it)).slice(0, 3);
  for (const item of items) {
    let page = '';
    try {
      page = await pageOf(item);
    } catch {
      // a page that will not load is no evidence either way
    }
    if (imdbMatches(page, query) === true) return { item, page };
  }
  return null;
}

/** Does a page name this film's IMDb id? null when the page names none. */
export function imdbMatches(text: unknown, query: MatchQuery): boolean | null {
  if (!query.imdbId) return null;
  const found = String(text || '').match(/\btt\d{7,9}\b/g);
  if (!found || !found.length) return null;
  return found.indexOf(query.imdbId) >= 0;
}

// ───────────────────────── HTML (a small stand-in for BeautifulSoup / Jsoup) ─────────────────────────
//
//   var doc = parseHtml(html);            // a tree; nothing is fetched
//   doc.select('div.card a[href^=http]')  // all matches, in page order
//   doc.selectFirst('h1.entry-title')     // the first match, or null
//   node.attr('href')                     // the attribute ('' when missing)
//   node.text() / node.data() / node.html()
//   node.tag, node.parent, node.children, node.next() / node.prev()
//
// Selectors: tag, *, .class, #id, [attr], [attr=v], [attr^=v], [attr$=v],
// [attr*=v], [attr~=v], compound, descendant, > + ~, lists, :contains,
// :first-child, :last-child, :nth-child(n|odd|even), :not(compound).

const _VOID: Record<string, number> = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
};
const _RAW: Record<string, number> = { script: 1, style: 1, textarea: 1 };
/** An opening tag that closes an unfinished one of these. */
const _CLOSES: Record<string, Record<string, number>> = {
  li: { li: 1 },
  p: { p: 1 },
  tr: { tr: 1, td: 1, th: 1 },
  td: { td: 1, th: 1 },
  th: { td: 1, th: 1 },
  option: { option: 1 },
  dt: { dt: 1, dd: 1 },
  dd: { dt: 1, dd: 1 },
};
const _ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', laquo: '«', raquo: '»', middot: '·',
  bull: '•', times: '×', eacute: 'é', egrave: 'è', aacute: 'á', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

export function unescapeHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e.charAt(0) === '#') {
      const n = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    const v = _ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * The first match of `re` at or after `from`, or null. `matchAll` starts from the
 * regex's `lastIndex`, which is how the tokenizer resumes mid-page.
 */
function _firstMatchAt(re: RegExp, text: string, from: number): RegExpMatchArray | null {
  re.lastIndex = from;
  const step = text.matchAll(re).next();
  return step.done ? null : step.value;
}

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  parent: HtmlNode | null;
  kids: Array<HtmlNode | string>;
}

class Node implements HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  parent: Node | null;
  kids: Array<Node | string> = [];

  constructor(tag: string, attrs: Record<string, string>, parent: Node | null) {
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent;
  }

  attr(n: string): string {
    const v = this.attrs[String(n).toLowerCase()];
    return v == null ? '' : v;
  }

  hasAttr(n: string): boolean {
    return this.attrs[String(n).toLowerCase()] != null;
  }

  get children(): Node[] {
    return this.kids.filter((k): k is Node => typeof k !== 'string');
  }

  next(): Node | null {
    if (!this.parent) return null;
    const c = this.parent.children;
    return c[c.indexOf(this) + 1] || null;
  }

  prev(): Node | null {
    if (!this.parent) return null;
    const c = this.parent.children;
    return c[c.indexOf(this) - 1] || null;
  }

  data(): string {
    return this.kids.map((k) => (typeof k === 'string' ? k : k.data())).join('');
  }

  text(): string {
    // a script's or style's text is data(), not text()
    if (this.tag === 'script' || this.tag === 'style') return '';
    const out: string[] = [];
    const walk = (n: Node) => {
      for (const k of n.kids) {
        if (typeof k === 'string') out.push(k);
        else if (k.tag !== 'script' && k.tag !== 'style') walk(k);
      }
    };
    walk(this);
    return unescapeHtml(out.join('')).replace(/[\s ]+/g, ' ').replace(/^ +| +$/g, '');
  }

  html(): string {
    return this.kids.map((k) => (typeof k === 'string' ? k : k.outerHtml())).join('');
  }

  outerHtml(): string {
    const a = Object.keys(this.attrs)
      .map((k) => ` ${k}="${String(this.attrs[k]).replace(/"/g, '&quot;')}"`)
      .join('');
    return _VOID[this.tag] ? `<${this.tag}${a}>` : `<${this.tag}${a}>${this.html()}</${this.tag}>`;
  }

  select(css: string): Node[] {
    const groups = _parseSelector(css);
    const out: Node[] = [];
    const scope = this;
    const walk = (n: Node) => {
      for (const k of n.children) {
        for (const g of groups) {
          if (_matchChain(k, g, g.length - 1, scope)) {
            out.push(k);
            break;
          }
        }
        walk(k);
      }
    };
    walk(this);
    return out;
  }

  selectFirst(css: string): Node | null {
    return this.select(css)[0] || null;
  }
}

export function parseHtml(html: unknown): Node {
  const source = String(html == null ? '' : html);
  const root = new Node('#root', {}, null);
  let cur: Node = root;
  let last = 0;
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>\/]*)[^>]*>|<([a-zA-Z][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const takeText = (to: number) => {
    if (to > last) cur.kids.push(source.slice(last, to));
  };
  for (;;) {
    const m = _firstMatchAt(re, source, last);
    if (!m) break;
    takeText(m.index!);
    last = m.index! + m[0].length;
    if (m[1]) {
      // a closing tag: close the nearest open one of that name
      const name = m[1].toLowerCase();
      let n: Node | null = cur;
      while (n && n.tag !== name) n = n.parent;
      if (n && n.parent) cur = n.parent;
    } else if (m[2]) {
      // an opening tag
      const tag = m[2].toLowerCase();
      const attrText = m[3] || '';
      const closes = _CLOSES[tag];
      while (closes && cur.parent && closes[cur.tag]) cur = cur.parent;
      const attrs: Record<string, string> = {};
      for (const am of attrText.matchAll(/([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const key = am[1].toLowerCase();
        if (attrs[key] == null) {
          attrs[key] = unescapeHtml(am[2] != null ? am[2] : am[3] != null ? am[3] : am[4] != null ? am[4] : '');
        }
      }
      const node = new Node(tag, attrs, cur);
      cur.kids.push(node);
      if (_RAW[tag]) {
        let end = source.toLowerCase().indexOf(`</${tag}`, last);
        if (end < 0) end = source.length;
        if (end > last) node.kids.push(source.slice(last, end));
        const close = source.indexOf('>', end);
        last = close < 0 ? source.length : close + 1;
      } else if (!_VOID[tag] && !/\/\s*$/.test(attrText)) {
        cur = node;
      }
    }
  }
  takeText(source.length);
  return root;
}

// ── selectors ──

interface AttrTest {
  n: string;
  op: string;
  v: string;
}
interface Pseudo {
  name: string;
  arg: any;
}
interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrTest[];
  pseudos: Pseudo[];
  comb: string;
}

function _parseSelector(css: unknown): Compound[][] {
  const groups: Compound[][] = [];
  const s = String(css || '').replace(/^\s+|\s+$/g, '');
  let i = 0;
  const ident = () => {
    const m = s.slice(i).match(/^[^\s.#\[\]:>+~,()=*^$|"']+/);
    if (!m) return '';
    i += m[0].length;
    return m[0];
  };
  const compound = (): Compound => {
    const c: Compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [], comb: ' ' };
    let any = false;
    if (s.charAt(i) === '*') {
      i++;
      any = true;
    } else {
      const t = ident();
      if (t) {
        c.tag = t.toLowerCase();
        any = true;
      }
    }
    for (;;) {
      const ch = s.charAt(i);
      if (ch === '.') {
        i++;
        c.classes.push(ident());
        any = true;
      } else if (ch === '#') {
        i++;
        c.id = ident();
        any = true;
      } else if (ch === '[') {
        const end = s.indexOf(']', i);
        const body = s.slice(i + 1, end);
        const m = body.match(
          /^\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?$/,
        );
        if (!m) throw new Error(`bad selector: ${css}`);
        c.attrs.push({
          n: m[1].toLowerCase(),
          op: m[2] || '',
          v: m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '',
        });
        i = end + 1;
        any = true;
      } else if (ch === ':') {
        i++;
        let name = ident().toLowerCase();
        let arg: any = null;
        if (s.charAt(i) === '(') {
          let depth = 1;
          let j = i + 1;
          while (j < s.length && depth) {
            if (s.charAt(j) === '(') depth++;
            else if (s.charAt(j) === ')') depth--;
            j++;
          }
          arg = s.slice(i + 1, j - 1);
          i = j;
        }
        if (name === 'not') arg = _parseSelector(arg);
        else if (name === 'contains' || name === '-soup-contains') {
          name = 'contains';
          arg = String(arg).replace(/^\s*["']?|["']?\s*$/g, '').toLowerCase();
        }
        c.pseudos.push({ name, arg });
        any = true;
      } else break;
    }
    if (!any) throw new Error(`bad selector: ${css}`);
    return c;
  };
  while (i < s.length) {
    const chain: Compound[] = [];
    let comb = ' ';
    for (;;) {
      const c = compound();
      c.comb = comb;
      chain.push(c);
      const ws = s.slice(i).match(/^\s*/)![0];
      i += ws.length;
      const ch = s.charAt(i);
      if (ch === ',' || i >= s.length) break;
      if (ch === '>' || ch === '+' || ch === '~') {
        comb = ch;
        i++;
        i += s.slice(i).match(/^\s*/)![0].length;
      } else comb = ' ';
    }
    groups.push(chain);
    if (s.charAt(i) === ',') {
      i++;
      i += s.slice(i).match(/^\s*/)![0].length;
    }
  }
  return groups;
}

function _matchOne(n: Node, c: Compound): boolean {
  if (c.tag && n.tag !== c.tag) return false;
  if (c.id != null && n.attr('id') !== c.id) return false;
  if (c.classes.length) {
    const have = ` ${n.attr('class').replace(/\s+/g, ' ')} `;
    for (const name of c.classes) if (have.indexOf(` ${name} `) < 0) return false;
  }
  for (const at of c.attrs) {
    const v = n.attrs[at.n];
    if (v == null) return false;
    if (at.op === '=' && v !== at.v) return false;
    if (at.op === '^=' && (at.v === '' || v.indexOf(at.v) !== 0)) return false;
    if (at.op === '$=' && (at.v === '' || v.slice(-at.v.length) !== at.v)) return false;
    if (at.op === '*=' && (at.v === '' || v.indexOf(at.v) < 0)) return false;
    if (at.op === '~=' && (` ${v.replace(/\s+/g, ' ')} `).indexOf(` ${at.v} `) < 0) return false;
    if (at.op === '|=' && v !== at.v && v.indexOf(`${at.v}-`) !== 0) return false;
  }
  for (const ps of c.pseudos) {
    if (ps.name === 'contains') {
      if (n.text().toLowerCase().indexOf(ps.arg) < 0) return false;
    } else if (ps.name === 'not') {
      if ((ps.arg as Compound[][]).some((g) => g.length === 1 && _matchOne(n, g[0]))) return false;
    } else if (ps.name === 'first-child') {
      if (n.prev()) return false;
    } else if (ps.name === 'last-child') {
      if (n.next()) return false;
    } else if (ps.name === 'nth-child') {
      const sib = n.parent ? n.parent.children : [n];
      const idx = sib.indexOf(n) + 1;
      const arg = String(ps.arg).replace(/\s+/g, '').toLowerCase();
      if (arg === 'odd') {
        if (idx % 2 !== 1) return false;
      } else if (arg === 'even') {
        if (idx % 2 !== 0) return false;
      } else if (/^\d+$/.test(arg)) {
        if (idx !== +arg) return false;
      } else return false;
    } else return false;
  }
  return true;
}

function _matchChain(n: Node, chain: Compound[], i: number, scope: Node): boolean {
  const c = chain[i];
  if (!_matchOne(n, c)) return false;
  if (i === 0) return true;
  const comb = c.comb;
  if (comb === '>') {
    const p = n.parent;
    return Boolean(p) && p !== scope.parent && p!.tag !== '#root' && _matchChain(p!, chain, i - 1, scope);
  }
  if (comb === ' ') {
    for (let p = n.parent; p && p.tag !== '#root'; p = p.parent) {
      if (_matchChain(p, chain, i - 1, scope)) return true;
    }
    return false;
  }
  if (comb === '+') {
    const p = n.prev();
    return Boolean(p) && _matchChain(p!, chain, i - 1, scope);
  }
  if (comb === '~') {
    for (let p = n.prev(); p; p = p.prev()) if (_matchChain(p, chain, i - 1, scope)) return true;
    return false;
  }
  return false;
}
