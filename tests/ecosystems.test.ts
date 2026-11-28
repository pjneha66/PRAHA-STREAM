// The ecosystem adapters' pure logic: repository parsing for all four
// ecosystems, the install shapes, the SkyStream archive unpacking and magic
// URLs, the Sora episode flattening, and the title matcher the source list
// matches catalog results with.
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/androidBridge', () => ({
  nativeFetchText: vi.fn(async () => ({ ok: true, status: 200, data: '', headers: {} })),
  bridgeRpcAvailable: vi.fn(() => false),
  prahaRpc: vi.fn(),
  clearReadingDownloads: vi.fn(async () => 0),
  isAndroidApp: vi.fn(() => false),
  getNativeAppVersion: vi.fn(() => null),
}));

import JSZip from 'jszip';
import { installZangetsuEntries, parseZangetsuRepo } from '../services/ecosystems/zangetsu';
import {
  installSoraModule, parseSoraManifest, parseSoraRepo, soraEpisodeList, soraModuleKind,
} from '../services/ecosystems/sora';
import {
  installSkyStreamPackage, parseSkyStreamRepo, unpackSkyArchive, decodeMagic,
} from '../services/ecosystems/skystream';
import { parseAnymexRepo } from '../services/ecosystems/anymex';
import { bestTitleMatch, normaliseTitle } from '../services/ecosystems/streams';
import {
  listEcosystemExtensions, removeEcosystemExtension, setEcosystemEnabled, itemPrefix,
} from '../services/ecosystems/store';
import {
  extensionForItemId, htmlToParagraphs, installedReadingExtensions,
} from '../services/ecosystems/reading';
import { installAnymexEntries } from '../services/ecosystems/anymex';
import { isEcoEmbedUrl } from '../relay/ecoEmbeds.mjs';

const REPO_URL = 'https://example.test/repo/index.json';

beforeEach(() => {
  localStorage.clear();
  for (const entry of [...listEcosystemExtensions()]) removeEcosystemExtension(entry.key);
});

describe('Zangetsu repository parsing', () => {
  it('lists providers and resolves repo-relative file paths', () => {
    const entries = parseZangetsuRepo(JSON.stringify([
      { id: 'hianime', file: 'providers/hianime.js', name: 'HiAnime', type: 'anime', version: '3', lang: 'en', logo: '/img/hianime.png' },
      { id: 'hdhub4u', file: 'https://cdn.example.test/hdhub4u.js', type: 'movie' },
    ]), REPO_URL);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('https://example.test/repo/providers/hianime.js');
    expect(entries[0].type).toBe('anime');
    expect(entries[1].url).toBe('https://cdn.example.test/hdhub4u.js');
  });

  it('skips entries without an id or file, and dedupes ids', () => {
    const entries = parseZangetsuRepo(JSON.stringify([
      { id: 'a', file: 'a.js' },
      { id: 'a', file: 'b.js' },
      { file: 'no-id.js' },
      { id: 'no-file' },
    ]), REPO_URL);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('a');
  });

  it('reads the official repo shape: an object with a sources list', () => {
    const entries = parseZangetsuRepo(JSON.stringify({
      name: 'Zangetsu Providers',
      sources: [
        { id: 'anikoto', name: 'AniKoto', version: '1.0.9', type: 'anime', lang: 'en', file: 'providers/anikoto.js', logo: 'icons/anikoto.png', nsfw: false },
        { id: 'hdhub4u', name: 'HDHub4u', version: '1.2.5', type: 'movie', lang: 'en', file: 'providers/hdhub4u.js' },
      ],
    }), REPO_URL);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('https://example.test/repo/providers/anikoto.js');
    expect(entries[1].type).toBe('movie');
  });

  it('refuses a file that is not a provider index', () => {
    expect(() => parseZangetsuRepo('<html>404</html>', REPO_URL)).toThrow(/not a Zangetsu repository/);
  });

  it('installs entries keyed by provider id with the content kind from type', () => {
    const [entry] = installZangetsuEntries(
      parseZangetsuRepo(JSON.stringify([{ id: 'hianime', file: 'a.js', type: 'anime' }]), REPO_URL),
      REPO_URL,
    );
    expect(entry.key).toBe('zangetsu:hianime');
    expect(entry.kind).toBe('anime');
    expect(itemPrefix(entry)).toBe('zc');
  });
});

describe('Sora repository parsing', () => {
  it('reads a modules.json index of manifest URLs', () => {
    const entries = parseSoraRepo(JSON.stringify({
      modules: [
        { manifestUrl: 'https://example.test/m/one.json', name: 'One', category: 'movies', note: '4k' },
        { manifestUrl: 'https://example.test/m/two.json', contentWarning: 'CONTENT_WARNING_NSFW' },
      ],
    }), REPO_URL);
    expect(entries).toHaveLength(2);
    expect(entries[0].description).toBe('movies · 4k');
    expect(entries[1].nsfw).toBe(true);
  });

  it('treats a bare manifest as a single module', () => {
    const entries = parseSoraRepo(JSON.stringify({
      scriptUrl: 'https://example.test/one.js', sourceName: 'One', type: 'movies', language: 'en', version: '2.1',
    }), REPO_URL);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('One');
    expect(entries[0].description).toContain('v2.1');
  });

  it('refuses a manifest without scriptUrl or sourceName', () => {
    expect(() => parseSoraManifest(JSON.stringify({ sourceName: 'X' }))).toThrow(/scriptUrl/);
    expect(() => parseSoraManifest(JSON.stringify({ scriptUrl: 'https://x/y.js' }))).toThrow(/sourceName/);
  });

  it('maps the manifest type word to video/manga/novel and the extension id', () => {
    expect(soraModuleKind('anime shows')).toBe('video');
    expect(soraModuleKind('Manhwa')).toBe('manga');
    expect(soraModuleKind('Light Novel')).toBe('novel');
    const manifest = parseSoraManifest(JSON.stringify({
      scriptUrl: 'https://example.test/x.js', sourceName: 'X Source!', type: 'novel',
    }));
    const extension = installSoraModule(manifest, manifest.scriptUrl, REPO_URL);
    expect(extension.key).toBe('sora-novel|X_Source_');
    expect(extension.kind).toBe('novel');
  });
});

describe('Sora episode shapes', () => {
  it('reads a flat episode array', () => {
    const list = soraEpisodeList([{ href: 'e1', number: 2, title: 'Two' }, { href: 'e2' }]);
    expect(list).toHaveLength(2);
  });

  it('flattens the grouped {lang: [[number, [episodes]]]} form and injects the pair number', () => {
    const list = soraEpisodeList({ en: [[5, [{ href: 'e5' }]], [7, [{ href: 'e7', number: 7 }]]] });
    expect(list).toHaveLength(2);
    expect(list[0].number).toBe(5);
    expect(list[1].number).toBe(7);
  });

  it('treats a one-entry error list as a failure, not a title', () => {
    expect(soraEpisodeList([{ title: 'Error' }])).toEqual([]);
    expect(soraEpisodeList([{ title: 'Not Found' }])).toEqual([]);
  });
});

describe('SkyStream repositories and packages', () => {
  it('picks skyish entries and resolves .sky URLs against the manifest', () => {
    const entries = parseSkyStreamRepo(JSON.stringify({
      plugins: [
        { packageName: 'ac', name: 'AC Provider', url: 'ac.sky' },
        { packageName: 'bd', name: 'BD Provider', url: 'https://cdn.example.test/bd.sky', version: '3' },
        { id: 'cs3', name: 'CS3 Thing', fileHash: 'sha256-x' },
      ],
    }), REPO_URL);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('https://example.test/repo/ac.sky');
    expect(entries[1].version).toBe('3');
  });

  it('unpacks a .sky archive: shallowest plugin.js/plugin.json win', async () => {
    const zip = new JSZip();
    zip.file('nested/deeper/plugin.js', '// deep script');
    zip.file('nested/deeper/plugin.json', JSON.stringify({ packageName: 'deep-one', name: 'Deep One' }));
    zip.file('plugin.js', '// root script');
    zip.file('plugin.json', JSON.stringify({ packageName: 'deep-one', name: 'Deep One', providers: [{ id: 'main', name: 'Main feed' }] }));
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const unpacked = await unpackSkyArchive(bytes);
    expect(unpacked.script).toBe('// root script');
    expect(unpacked.manifest.packageName).toBe('deep-one');
    expect(unpacked.manifest.providers).toEqual([{ id: 'main', name: 'Main feed' }]);
  });

  it('expands a bundle into one extension per feed', () => {
    const [feed] = installSkyStreamPackage({
      packageName: 'multi', name: 'Multi', domains: [], providers: [{ id: 'movies', name: 'Movies feed' }, { id: 'tv', name: 'TV feed' }], addons: [],
    }, 'https://example.test/multi.sky', REPO_URL);
    expect(feed.key).toBe('skystream:multi|movies');
    expect(feed.name).toBe('Multi · Movies feed');
    expect(itemPrefix(feed)).toBe('ss');
  });

  it('decodes the magic URL payloads plugins pack mirrors into', () => {
    const dataUrl = `magic_m3u8:${btoa('https://cdn.example.test/live.m3u8')}`;
    expect(decodeMagic(dataUrl).url).toBe('data:application/vnd.apple.mpegurl;base64,aHR0cHM6Ly9jZG4uZXhhbXBsZS50ZXN0L2xpdmUubTN1OA==');
    const v2 = `MAGIC_PROXY_v2${btoa(JSON.stringify({ url: 'https://proxy.example.test/v', headers: { Referer: 'https://site.test/' } }))}`;
    const decoded = decodeMagic(v2);
    expect(decoded.url).toBe('https://proxy.example.test/v');
    expect(decoded.headers.Referer).toBe('https://site.test/');
    expect(decodeMagic('https://plain.example.test/file.mp4').url).toBe('https://plain.example.test/file.mp4');
  });
});

describe('AnymeX repository parsing', () => {
  it('reads an index under any of the list keys and derives manga from itemType', () => {
    const entries = parseAnymexRepo(JSON.stringify({
      sources: [
        { name: 'Anime One', sourceCodeUrl: 'https://example.test/a1.js', lang: 'ja' },
        { name: 'Manga Two', sourceCodeUrl: 'https://example.test/m2.js', itemType: 0 },
        { name: 'Manga Three', sourceCodeUrl: 'https://example.test/m3.js', isManga: true },
      ],
    }), REPO_URL);
    expect(entries).toHaveLength(3);
    expect(entries[0].isManga).toBe(false);
    expect(entries[1].isManga).toBe(true);
    expect(entries[2].isManga).toBe(true);
    expect(entries[0].lang).toBe('ja');
  });

  it('refuses Dart-only modules unless the URL is clearly JavaScript', () => {
    const entries = parseAnymexRepo(JSON.stringify([
      { name: 'Dart One', sourceCodeUrl: 'https://example.test/dart.zip', sourceCodeLanguage: 0 },
      { name: 'Js One', sourceCodeUrl: 'https://example.test/js.js', sourceCodeLanguage: 0 },
    ]), REPO_URL);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Js One');
  });

  it('skips entries without a name or a sourceCodeUrl', () => {
    // A pkgPath-only entry has no sourceCodeUrl, so it is skipped too.
    expect(parseAnymexRepo(JSON.stringify([
      { sourceCodeUrl: 'https://example.test/x.js' },
      { name: 'No URL' },
      { pkgPath: 'some/path', name: 'Pkg Only' },
      { pkgPath: 'some/path', name: 'Real One', sourceCodeUrl: 'https://example.test/real.js' },
    ]), REPO_URL)).toHaveLength(1);
  });
});

describe('the title matcher the source list uses', () => {
  it('normalises punctuation and case away', () => {
    expect(normaliseTitle('Frieren: Beyond Journey`s End!')).toBe('frieren beyond journey s end');
  });

  it('matches exact, prefix, and word-subset titles', () => {
    const items = [{ title: 'One Piece' }, { title: 'One Piece Film: Red' }, { title: 'Overlord' }];
    expect(bestTitleMatch(items, 'one piece')?.title).toBe('One Piece');
    expect(bestTitleMatch(items, 'One Piece Film')?.title).toBe('One Piece Film: Red');
    expect(bestTitleMatch(items, 'Overlord IV')?.title).toBe('Overlord');
    expect(bestTitleMatch(items, 'Bleach')).toBeNull();
  });
});

describe('the ecosystem store', () => {
  it('toggles and removes entries', () => {
    const [entry] = installZangetsuEntries(
      parseZangetsuRepo(JSON.stringify([{ id: 'x', file: 'x.js' }]), REPO_URL), REPO_URL,
    );
    expect(listEcosystemExtensions()).toHaveLength(1);
    setEcosystemEnabled(entry.key, false);
    expect(listEcosystemExtensions()[0].enabled).toBe(false);
    setEcosystemEnabled(entry.key, true);
    expect(listEcosystemExtensions()[0].enabled).toBe(true);
    removeEcosystemExtension(entry.key);
    expect(listEcosystemExtensions()).toHaveLength(0);
  });

  it('stages reading extensions for validation without modifying a saved source', () => {
    const manifest = parseSoraManifest(JSON.stringify({
      scriptUrl: 'https://example.test/novel.js', sourceName: 'Reader', type: 'book',
    }));
    const saved = installSoraModule(manifest, manifest.scriptUrl, REPO_URL);
    const candidate = installSoraModule(manifest, 'https://example.test/broken.js', REPO_URL, false);
    expect(saved.kind).toBe('novel');
    expect(candidate.url).toContain('broken.js');
    expect(listEcosystemExtensions()).toEqual([saved]);
    expect(soraModuleKind('comic book')).toBe('manga');
  });

  it('re-installing the same key updates in place instead of duplicating', () => {
    const repo = JSON.stringify([{ id: 'x', file: 'x.js', name: 'First' }]);
    installZangetsuEntries(parseZangetsuRepo(repo, REPO_URL), REPO_URL);
    installZangetsuEntries(parseZangetsuRepo(JSON.stringify([{ id: 'x', file: 'x.js', name: 'Second' }]), REPO_URL), REPO_URL);
    const list = listEcosystemExtensions();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Second');
  });
});


describe('the reading facade', () => {
  it('lists installed manga and novel extensions separately', () => {
    installSoraModule(parseSoraManifest(JSON.stringify({
      scriptUrl: 'https://example.test/m.js', sourceName: 'MangaMod', type: 'manga',
    })), 'https://example.test/m.js', REPO_URL);
    installSoraModule(parseSoraManifest(JSON.stringify({
      scriptUrl: 'https://example.test/n.js', sourceName: 'NovelMod', type: 'light novel',
    })), 'https://example.test/n.js', REPO_URL);
    installAnymexEntries([{
      id: 'mangasite', name: 'MangaSite', url: 'https://example.test/any.js', version: '1',
      lang: 'en', isManga: true, nsfw: false,
    }], REPO_URL);
    expect(installedReadingExtensions('manga').map((entry) => entry.name).sort())
      .toEqual(['MangaMod', 'MangaSite']);
    expect(installedReadingExtensions('novel').map((entry) => entry.name)).toEqual(['NovelMod']);
  });

  it('resolves the extension behind an item id prefix', () => {
    const extension = installSoraModule(parseSoraManifest(JSON.stringify({
      scriptUrl: 'https://example.test/m.js', sourceName: 'MangaMod', type: 'manga',
    })), 'https://example.test/m.js', REPO_URL);
    expect(extensionForItemId(`${extension.key}:chapter-12`, 'manga')?.key).toBe(extension.key);
    expect(extensionForItemId('unknown:thing', 'manga')).toBeNull();
    expect(extensionForItemId(undefined)).toBeNull();
  });

  it('reads chapter HTML as paragraphs, with a plain-text fallback', () => {
    const html = '<p>First&nbsp;para.</p><script>evil()</script><p>Second &amp; last.</p>';
    expect(htmlToParagraphs(html)).toEqual(['First para.', 'Second & last.']);
    expect(htmlToParagraphs('Plain text\n\nacross blank lines')).toEqual(['Plain text', 'across blank lines']);
    expect(htmlToParagraphs('')).toEqual([]);
  });
});


describe('the relay embed allowlist', () => {
  it('allows the extractor families\' hosts', () => {
    expect(isEcoEmbedUrl('https://dood.watch/e/x')).toBe(true);
    expect(isEcoEmbedUrl('https://d000d.com/d/abc')).toBe(true);
    expect(isEcoEmbedUrl('https://filemoon.sx/e/abc')).toBe(true);
    expect(isEcoEmbedUrl('https://streamwish.to/e/abc')).toBe(true);
    expect(isEcoEmbedUrl('https://mp4upload.com/embed-abc.html')).toBe(true);
    expect(isEcoEmbedUrl('https://video.sibnet.ru/shell.php?vid=1')).toBe(true);
    expect(isEcoEmbedUrl('https://ok.ru/videoembed/1')).toBe(true);
    expect(isEcoEmbedUrl('https://voe.sx/e/abc')).toBe(true);
    expect(isEcoEmbedUrl('https://streamtape.com/e/abc')).toBe(true);
    expect(isEcoEmbedUrl('https://goload.pro/embedplus?id=1')).toBe(true);
  });

  it('refuses everything the extractor families do not cover', () => {
    expect(isEcoEmbedUrl('https://example.com/video')).toBe(false);
    expect(isEcoEmbedUrl('https://192.168.1.1/admin')).toBe(false);
    expect(isEcoEmbedUrl('ftp://dood.watch/x')).toBe(false);
    expect(isEcoEmbedUrl('https://user:pass@dood.watch/x')).toBe(false);
    expect(isEcoEmbedUrl('not a url')).toBe(false);
  });
});
