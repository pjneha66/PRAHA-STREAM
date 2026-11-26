import { gunzipSync } from 'node:zlib';

export const readingIndexes = {
  keiyoushi: ['https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb', 'protobuf'],
  felipe: ['https://raw.githubusercontent.com/FelipeGFA/extensoes/refs/heads/repo/index.pb', 'protobuf'],
  kotatsu: ['https://kotatsu-83g.pages.dev/kotatsu/kotatsu-parsers-redo.json', 'sites'],
  kototoro: ['https://kotatsu-83g.pages.dev/kotatsu/kototoro-parsers.json', 'sites'],
  lnreader: ['https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json', 'list'],
  ireader: ['https://raw.githubusercontent.com/IReaderorg/IReader-extensions/refs/heads/repov2/index.min.json', 'list'],
  shosetsu: ['https://gitlab.com/shosetsuorg/extensions/-/raw/dev/index.json', 'scripts'],
  novelsourcery: ['https://raw.githubusercontent.com/NovelSourcery/extensions/repo/index.pb', 'protobuf'],
};

const maxIndexBytes = 4 * 1024 * 1024;
const english = /^(?:english|en(?:[-_](?:us|gb))?)$/i;

function* protobufFields(bytes) {
  let offset = 0;
  function varint() {
    let value = 0;
    for (let bit = 0; bit < 70 && offset < bytes.length; bit += 7) {
      const byte = bytes[offset++];
      if (bit < 35) value += (byte & 127) * 2 ** bit;
      if (byte < 128) return value;
    }
    throw new Error('Invalid protobuf field.');
  }

  while (offset < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      yield [field, varint()];
    } else {
      const size = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (size < 0 || offset + size > bytes.length) throw new Error('Invalid protobuf size.');
      const value = bytes.subarray(offset, offset + size);
      offset += size;
      if (wire === 2) yield [field, value];
    }
  }
}

function protobufEntries(bytes) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: maxIndexBytes }) : bytes;
  const extensions = new Map(protobufFields(raw)).get(101);
  if (!Buffer.isBuffer(extensions)) throw new Error('Missing extension list.');
  const entries = [];
  for (const [field, extension] of protobufFields(extensions)) {
    if (field !== 1 || !Buffer.isBuffer(extension)) continue;
    for (const [field, source] of protobufFields(extension)) {
      if (field !== 8 || !Buffer.isBuffer(source)) continue;
      const values = new Map(protobufFields(source));
      entries.push({ name: values.get(2)?.toString(), lang: values.get(3)?.toString(), site: values.get(4)?.toString() });
    }
  }
  return entries;
}

export function englishReadingIndex(bytes, format) {
  const data = format === 'protobuf' ? protobufEntries(bytes) : JSON.parse(bytes.toString('utf8'));
  const rows = format === 'sites' ? data.sites : format === 'scripts' ? data.scripts : data;
  if (!Array.isArray(rows)) throw new Error('Invalid reading index.');
  const entries = new Map();
  for (const item of rows) {
    if (typeof item?.name !== 'string' || !english.test(item.lang) || item.isBroken || item.nsfw) continue;
    const name = item.name.trim();
    if (!name || name.length > 140) continue;
    let site;
    try {
      const url = new URL(item.site || item.url);
      if (url.protocol === 'https:' && !url.username && !url.password) site = url.href;
    } catch { /* Some repositories put the URL in the extension package. */ }
    entries.set(`${name}|${site ?? ''}`, { name, language: 'en', ...(site && { site }) });
  }
  return [...entries.values()];
}

const readingPages = {
  annasarchive: ['https://annas-archive.gl', /^\/(?:search|md5\/[a-f\d]+)\/?$/i],
  oceanofpdf: ['https://theoceanofpdf.com', /^\/(?:[\w-]+\/)?$/],
  comicsall: ['https://comics-all.com', /^\/(?:index\.php|page\/\d+\/|\d+-[\w-]+\.html)?$/],
  getcomics: ['https://getcomics.org', /^\/(?:page\/\d+\/|(?:dc|marvel|other-comics)\/[\w-]+\/)?$/],
  readnovelfull: ['https://readnovelfull.com', /^\/(?:novel-list\/search|ajax\/chapter-archive|[\w-]+(?:\/[\w-]+)?\.html)?$/],
  novgo: ['https://novgo.net', /^\/(?:search|[\w-]+(?:\/[\w-]+)?\.html)?$/],
};

export function readingPageTarget(source, raw) {
  if (!Object.hasOwn(readingPages, source) || typeof raw !== 'string' || raw.length > 3000) return null;
  const [origin, paths] = readingPages[source];
  try {
    const target = new URL(raw);
    return target.origin === origin && !target.username && !target.password && paths.test(target.pathname) ? target : null;
  } catch { return null; }
}

export async function fetchReadingIndex(id, fetcher = fetch) {
  const [url, format] = readingIndexes[id];
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PRAHA-STREAM)' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) throw new Error('Repository unavailable.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxIndexBytes) throw new Error('Repository index too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return englishReadingIndex(Buffer.concat(chunks, length), format);
}
