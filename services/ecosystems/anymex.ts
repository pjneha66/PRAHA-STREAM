// AnymeX extensions — the Mangayomi-format JavaScript modules: one `.js` file
// declaring `class DefaultExtension extends MProvider` (or one of the MProvider
// subclasses) plus a `mangayomiSources` array, answering `getPopular`,
// `getLatestUpdates`, `search`, `getFilterList`, `getDetail`, and — for anime —
// `getVideoList`, or — for manga — `getPageList`.
//
// A port of Hikari's `anymex/AnymexRuntime.kt`, `AnymexPluginManager.kt`,
// `AnymexProvider.kt`, `AnymexMangaProvider.kt` and the `anymex/harness.js`
// they boot (GPL-3.0-or-later, Copyright (C) 2026 Codegeasse). The harness
// below keeps the surface extensions actually touch — `Client`, `Document`
// over cheerio, `SharedPreferences`, the `MProvider` base class, the Kotlin
// string helpers, the packer/crypto utilities, `parseDates` — while the
// native-only parts (the embed extractor stack behind `*Extractor` globals)
// answer empty, the same polite reduction the plugin engine port made.
//
// The reference engine's polyfills (QuickJS lacking ES2021) are dropped: the
// browser worker has them. What is kept is the honest-error rewrite — an empty
// catalog where every fetch failed is an error, not a quiet empty list.

import { runEcosystemCall } from '../pluginRuntime';
import { ecoRelayPageUrl } from '../comicsRelay';
import { fetchEcosystemScript } from './scripts';
import { installEcosystemExtensions, type EcosystemExtension } from './store';
import type { MediaItem, StreamResult, StreamSubtitle } from '../../types';

// ── repositories ──

/** One entry of an AnymeX index, as the manager parses it. */
export interface AnymexRepoEntry {
  id: string;
  name: string;
  url: string;
  version: string;
  lang: string;
  isManga: boolean;
  baseUrl?: string;
  apiUrl?: string;
  logo?: string;
  nsfw: boolean;
}

/** Hikari's ExtensionNsfw.repoEntryNsfw, reduced to the shapes these repos use. */
function entryNsfw(record: Record<string, unknown>): boolean {
  if (typeof record.contentWarning === 'string' && record.contentWarning.toLowerCase() === 'content_warning_nsfw') return true;
  const numeric = Number(record.contentWarning);
  if (!Number.isNaN(numeric) && numeric > 0) return true;
  if (record.nsfw === true) return true;
  if (record.nsfw === '1') return true;
  return false;
}

/** Hikari's looksLikeAnymex: the entry names only this ecosystem uses. */
function looksLikeAnymex(record: Record<string, unknown>): boolean {
  return Boolean(record.sourceCodeUrl || record.pkgPath);
}

function pickLang(record: Record<string, unknown>): string {
  const langs = Array.isArray(record.langs) ? record.langs.map(String) : [];
  const direct = typeof record.lang === 'string' && record.lang.trim() ? record.lang.trim() : '';
  if (direct) return direct;
  if (langs.includes('en')) return 'en';
  return langs[0] || 'en';
}

const isPlainHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value);

/**
 * An AnymeX repository: a bare JSON array, an object under one of the five
 * list keys, or a single entry. Entries lacking a `name` or a `sourceCodeUrl`
 * are skipped; Dart-only modules (sourceCodeLanguage 0) are refused unless the
 * URL clearly ends in `.js`.
 */
export function parseAnymexRepo(text: string, repoUrl: string): AnymexRepoEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That link is not an AnymeX repository index.');
  }
  let list: unknown[] = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['extensions', 'sources', 'plugins', 'modules', 'list']) {
      if (Array.isArray(record[key])) {
        list = record[key] as unknown[];
        break;
      }
    }
    if (!list.length && looksLikeAnymex(record)) list = [record];
  }
  const out: AnymexRepoEntry[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (!looksLikeAnymex(record)) continue;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '';
    const sourceCodeUrl = isPlainHttpUrl(record.sourceCodeUrl) ? record.sourceCodeUrl.trim() : '';
    if (!name || !sourceCodeUrl) continue;
    const language = Number(record.sourceCodeLanguage);
    if (language === 0 && !sourceCodeUrl.endsWith('.js') && !sourceCodeUrl.includes('/javascript/')) continue;
    const key = sourceCodeUrl.replace(/^https?:\/\//i, '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-72);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const isManga = record.isManga === true || Number(record.itemType) === 0;
    out.push({
      id: key,
      name,
      url: sourceCodeUrl,
      version: record.version == null ? '' : String(record.version),
      lang: pickLang(record),
      isManga,
      baseUrl: isPlainHttpUrl(record.baseUrl) ? record.baseUrl : undefined,
      apiUrl: isPlainHttpUrl(record.apiUrl) ? record.apiUrl : undefined,
      logo: isPlainHttpUrl(record.iconUrl) ? record.iconUrl : undefined,
      nsfw: entryNsfw(record),
    });
    if (out.length >= 200) break;
  }
  if (!out.length) throw new Error('That file lists no AnymeX extensions.');
  return out;
}

/** Installs (or refreshes) the entries a repository listed. */
export function installAnymexEntries(entries: AnymexRepoEntry[], sourceUrl: string, persist = true): EcosystemExtension[] {
  const extensions = entries.map((entry): EcosystemExtension => ({
    key: `anymex${entry.isManga ? 'm' : ''}:${entry.id}`,
    ecosystem: 'anymex' as const,
    id: entry.id,
    name: entry.name,
    url: entry.url,
    version: entry.version,
    lang: entry.lang,
    kind: entry.isManga ? ('manga' as const) : ('anime' as const),
    logo: entry.logo,
    baseUrl: entry.baseUrl,
    apiUrl: entry.apiUrl,
    sourceUrl,
    nsfw: entry.nsfw,
    enabled: true,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  }));
  return persist ? installEcosystemExtensions(extensions) : extensions;
}

// ── the harness prelude ──

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** The harness, ported from Hikari's `assets/anymex/harness.js`. String.raw
 * keeps the JS's own backslashes; the shim uses no template literals. */
const ANYMEX_HARNESS = String.raw`
(function () {
  var __h = (typeof http === 'function') ? http : null;
  var __stats = { ok: 0, fail: 0, lastStatus: 0, deadSite: false, wall: false };

  function bridgeFetch(target, method, headers, body, followRedirects) {
    return new Promise(function (resolve, reject) {
      if (!__h) { reject(new Error('no http bridge')); return; }
      __h(target, { method: method, headers: headers, body: body || undefined, timeout: 20000 })
        .then(function (res) {
          var ok = res.status >= 200 && res.status < 300;
          resolve({ ok: ok, status: res.status || 0, statusText: res.error || '', url: res.url || target,
            headers: res.headers || {}, body: res.text || '' });
        }, function (err) {
          reject(new Error(String((err && err.message) || err || 'fetch failed')));
        });
    });
  }
  globalThis.fetch = function (url, init) {
    init = init || {};
    var h = {};
    if (init.headers) {
      try { new Headers(init.headers).forEach(function (v, k) { h[k] = v; }); }
      catch (e) { if (typeof init.headers === 'object') h = init.headers; }
    }
    var body = init.body == null ? undefined : (typeof init.body === 'string' ? init.body : String(init.body));
    var follow = init.redirect === 'manual' || init.redirect === 'error' ? false : true;
    return bridgeFetch(String(url), String(init.method || 'GET').toUpperCase(), h, body, follow)
      .then(function (res) {
        if (res.ok) __stats.ok++; else { __stats.fail++; __stats.lastStatus = res.status; }
        return {
          ok: res.ok, status: res.status, statusText: res.statusText, url: res.url,
          headers: { get: function (n) { return res.headers[String(n).toLowerCase()] != null ? res.headers[String(n).toLowerCase()] : null; },
            has: function (n) { return res.headers[String(n).toLowerCase()] != null; },
            forEach: function (cb) { Object.keys(res.headers).forEach(function (k) { cb(res.headers[k], k); }); } },
          text: function () { return Promise.resolve(res.body); },
          json: function () { return Promise.resolve().then(function () { try { return JSON.parse(res.body); } catch (e) { return null; } }); },
          arrayBuffer: function () { return Promise.resolve(new TextEncoder().encode(res.body).buffer); },
          clone: function () { return this; },
          blob: function () { return Promise.resolve(null); }
        };
      });
  };

  // ── Client ──
  function mergeHeaders(base, extra) {
    var out = Object.assign({}, base || {});
    if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }
  function encodeBody(body, headers) {
    if (body == null) return { body: undefined, headers: headers };
    var contentType = '';
    Object.keys(headers).some(function (k) { if (k.toLowerCase() === 'content-type') { contentType = headers[k]; return true; } return false; });
    if (typeof body === 'string') return { body: body, headers: headers };
    if (/json/i.test(contentType)) return { body: JSON.stringify(body), headers: headers };
    var parts = Object.keys(body).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(body[k])); });
    var out = Object.assign({}, headers);
    if (!contentType) out['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    return { body: parts.join('&'), headers: out };
  }
  function Client(headers) { this.__headers = headers || {}; }
  Client.prototype.withHeaders = function (headers) { return new Client(mergeHeaders(this.__headers, headers)); };
  ['get', 'post', 'put', 'delete', 'patch', 'head'].forEach(function (method) {
    Client.prototype[method] = function (url, headers, body) {
      var merged = mergeHeaders(this.__headers, headers);
      var encoded = encodeBody(body, merged);
      return bridgeFetch(String(url), method.toUpperCase(), encoded.headers, encoded.body, true).then(function (res) {
        if (res.ok) __stats.ok++; else { __stats.fail++; __stats.lastStatus = res.status; }
        return {
          body: res.body,
          code: res.status,
          status: res.status,
          statusCode: res.status,
          statusText: res.statusText,
          reasonPhrase: res.statusText,
          headers: res.headers,
          url: res.url,
          isRedirect: false,
          persistentConnection: true,
          request: { url: res.url, method: method.toUpperCase(), headers: {} }
        };
      });
    };
  });
  globalThis.Client = Client;

  // ── Document over the sandbox's cheerio ──
  var __cheerio = (globalThis.__cheerioLib || globalThis.cheerio);
  function AnymexElement(el) {
    this.__el = el && el.length ? el : null;
    if (el && el.length === 1) this.__el = el;
  }
  AnymexElement.prototype._first = function () { return this.__el && this.__el.length ? this.__el.first() : null; };
  Object.defineProperty(AnymexElement.prototype, 'text', { get: function () { var el = this._first(); return el ? String(el.text() || '').trim() : ''; } });
  AnymexElement.prototype.html = function () { var el = this._first(); return el ? String(el.html() || '') : ''; };
  AnymexElement.prototype.innerHtml = function () { return this.html(); };
  AnymexElement.prototype.outerHtml = function () { var el = this._first(); try { return el && el.prop ? String(el.prop('outerHTML') || '') : this.html(); } catch (e) { return this.html(); } };
  AnymexElement.prototype.attr = function (name) {
    var el = this._first();
    if (!el) return '';
    try { var v = el.attr(name); return v == null ? '' : String(v); } catch (e) { return ''; }
  };
  AnymexElement.prototype.getHref = function () { return this.attr('href'); };
  AnymexElement.prototype.getImg = function () { return this.attr('src'); };
  AnymexElement.prototype.getDataSrc = function () { return this.attr('data-src'); };
  AnymexElement.prototype.getSrc = function () {
    // Lazy-load aware: data-src, data-lazy-src, data-original, srcset first
    // candidate, then src — data: URIs skipped, exactly the upstream order.
    for (var _i = 0, _a = ['data-src', 'data-lazy-src', 'data-original']; _i < _a.length; _i++) {
      var lazy = this.attr(_a[_i]);
      if (lazy && lazy.indexOf('data:') !== 0) return lazy;
    }
    var srcset = this.attr('data-srcset') || this.attr('srcset');
    if (srcset) {
      var first = srcset.split(',')[0].trim().split(/\s+/)[0];
      if (first && first.indexOf('data:') !== 0) return first;
    }
    var src = this.attr('src');
    if (src && src.indexOf('data:') !== 0) return src;
    return '';
  };
  AnymexElement.prototype.className = function () { return this.attr('class'); };
  Object.defineProperty(AnymexElement.prototype, 'className', { get: function () { return this.attr('class'); } });
  AnymexElement.prototype.localName = function () { try { var el = this._first(); return el && el.prop ? String(el.prop('tagName') || '').toLowerCase() : ''; } catch (e) { return ''; } };
  AnymexElement.prototype.hasAttr = function (name) { var el = this._first(); if (!el) return false; try { return el.attr(name) != null; } catch (e) { return false; } };
  AnymexElement.prototype.select = function (sel) {
    var el = this._first();
    var out = [];
    if (!el) return out;
    el.find(sel).each(function (_i, child) { out.push(new AnymexElement(__cheerio(child))); });
    return out;
  };
  AnymexElement.prototype.selectFirst = function (sel) { return this.select(sel)[0] || null; };
  AnymexElement.prototype.first = function () { return this; };
  AnymexElement.prototype.children = function () {
    var el = this._first();
    var out = [];
    if (!el) return out;
    try { el.children().each(function (_i, child) { out.push(new AnymexElement(__cheerio(child))); }); } catch (e) {}
    return out;
  };
  AnymexElement.prototype.previousElementSibling = function () { var el = this._first(); return el && el.prev ? new AnymexElement(el.prev()) : null; };
  AnymexElement.prototype.nextElementSibling = function () { var el = this._first(); return el && el.next ? new AnymexElement(el.next()) : null; };
  AnymexElement.prototype.getElementsByClass = function (cls) { return this.select('.' + String(cls).trim()); };
  AnymexElement.prototype.getElementsByTagName = function (tag) { return this.select(tag); };

  function AnymexDocument(html) {
    this.__doc = __cheerio.load ? __cheerio.load(String(html == null ? '' : html)) : null;
    this.body = new AnymexElement(this.__doc ? this.__doc('body') : null);
    this.head = new AnymexElement(this.__doc ? this.__doc('head') : null);
  }
  AnymexDocument.prototype.select = function (sel) {
    var out = [];
    if (!this.__doc) return out;
    this.__doc(sel).each(function (_i, child) { out.push(new AnymexElement(__cheerio(child))); });
    return out;
  };
  AnymexDocument.prototype.selectFirst = function (sel) { return this.select(sel)[0] || null; };
  AnymexDocument.prototype.getElementsByClassName = function (cls) { return this.select('.' + String(cls).trim()); };
  AnymexDocument.prototype.getElementsByTagName = function (tag) { return this.select(tag); };
  AnymexDocument.prototype.getElementById = function (id) { return this.select('#' + String(id).trim())[0] || null; };
  globalThis.Document = AnymexDocument;

  // ── SharedPreferences: JSON values through the app frame's kv storage ──
  function SharedPreferences() {}
  SharedPreferences.prototype._get = function (key) {
    return new Promise(function (resolve) {
      __ecoPrefGet(globalThis.__anymexStore || '', String(key)).then(function (v) { resolve(v); }, function () { resolve(null); });
    });
  };
  SharedPreferences.prototype.get = function (key, def) {
    var self = this;
    return this._get(key).then(function (raw) {
      if (raw == null || raw === '') return def !== undefined ? def : '';
      try { return JSON.parse(raw); } catch (e) { return raw; }
    });
  };
  SharedPreferences.prototype.getString = function (key, def) {
    return this.get(key, def !== undefined ? def : '').then(function (v) { return v == null ? '' : String(v); });
  };
  SharedPreferences.prototype.set = function (key, value) {
    return new Promise(function (resolve) {
      var raw = value === undefined || value === null ? '' : JSON.stringify(value);
      __ecoPrefSet(globalThis.__anymexStore || '', String(key), raw).then(function () { resolve(); }, function () { resolve(); });
    });
  };
  SharedPreferences.prototype.setString = function (key, value) { return this.set(key, String(value == null ? '' : value)); };
  globalThis.SharedPreferences = SharedPreferences;

  // ── MProvider base ──
  var __hostMeta = typeof __ANYMEX_META__ !== 'undefined' ? __ANYMEX_META__ : {};
  function MProvider(source) {
    this.source = Object.assign({}, __hostMeta, source || {});
    this.__prefs = new SharedPreferences();
  }
  MProvider.prototype.getPreference = function (key) {
    var self = this;
    return this.__prefs.getString(key, '').then(function (value) {
      if (value) return value;
      if (key === 'custom_user_agent') return 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
      if (key === 'url') {
        var base = String(self.source.baseUrl || self.source.url || '');
        return base ? base.replace(/\/en.*$/, '') : '';
      }
      if (key === 'lang') return String(self.source.lang || 'en');
      if (key === 'name') return String(self.source.name || '');
      if (key === 'baseUrl') return String(self.source.baseUrl || '');
      return '';
    });
  };
  globalThis.MProvider = MProvider;
  globalThis.MangaProvider = MProvider;
  globalThis.AnimeProvider = MProvider;
  globalThis.NovelProvider = MProvider;

  // ── string helpers (Kotlin parity) ──
  String.prototype.substringAfter = function (delimiter) {
    var i = this.indexOf(delimiter);
    return i < 0 ? String(this) : this.slice(i + delimiter.length);
  };
  String.prototype.substringBefore = function (delimiter) {
    var i = this.indexOf(delimiter);
    return i < 0 ? String(this) : this.slice(0, i);
  };
  String.prototype.substringAfterLast = function (delimiter) {
    var i = this.lastIndexOf(delimiter);
    return i < 0 ? String(this) : this.slice(i + delimiter.length);
  };
  String.prototype.substringBeforeLast = function (delimiter) {
    var i = this.lastIndexOf(delimiter);
    return i < 0 ? String(this) : this.slice(0, i);
  };
  String.prototype.substringBetween = function (open, close) {
    var i = this.indexOf(open);
    if (i < 0) return '';
    var j = this.indexOf(close, i + open.length);
    return j < 0 ? '' : this.slice(i + open.length, j);
  };

  // ── crypto / packer utilities ──
  var __CryptoJS = globalThis.CryptoJS;
  // Dean-Edwards packer unpacking — the same decoder the SkyStream shim
  // carries, needed here because packed players are how these embeds hide.
  var __BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function __baseEncode(i, a) {
    if (i === 0) return '0';
    var out = '';
    while (i > 0) { out = __BASE62.charAt(i % a) + out; i = Math.floor(i / a); }
    return out;
  }
  globalThis.getAndUnpack = function (js) {
    try {
      var m = String(js || '').match(/}\s*\(\s*['"](.*)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"](.*?)['"]\s*\.split\(\s*['"]\|['"]\s*\)/);
      if (!m) return '';
      var p = m[1], a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
      if (a < 2 || a > 62) return '';
      var unescaped = p.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      for (var i = c - 1; i >= 0; i--) {
        if (!k[i]) continue;
        unescaped = unescaped.replace(new RegExp('\\b' + __baseEncode(i, a) + '\\b', 'g'), k[i]);
      }
      return unescaped;
    } catch (e) { return ''; }
  };
  globalThis.unpackJs = globalThis.getAndUnpack;
  globalThis.unpackJsAndCombine = function (block) {
    var out = globalThis.unpackJs(String(block || ''));
    return out || String(block || '');
  };
  globalThis.encryptAESCryptoJS = function (plain, passphrase) {
    if (!__CryptoJS) return '';
    try { return __CryptoJS.AES.encrypt(String(plain), String(passphrase)).toString(); } catch (e) { return ''; }
  };
  globalThis.decryptAESCryptoJS = function (enc, passphrase) {
    if (!__CryptoJS) return '';
    try { return __CryptoJS.AES.decrypt(String(enc), String(passphrase)).toString(__CryptoJS.enc.Utf8); } catch (e) { return ''; }
  };
  globalThis.cryptoHandler = function (text, iv, secretKeyString, encrypt) {
    if (!__CryptoJS) return String(text);
    try {
      var key = __CryptoJS.enc.Utf8.parse(String(secretKeyString));
      var ivParsed = __CryptoJS.enc.Utf8.parse(String(iv || ''));
      if (encrypt) {
        var encrypted = __CryptoJS.AES.encrypt(String(text), key, { iv: ivParsed, mode: __CryptoJS.mode.CBC, padding: __CryptoJS.pad.Pkcs7 });
        return encrypted.ciphertext.toString(__CryptoJS.enc.Base64);
      }
      var decrypted = __CryptoJS.AES.decrypt({ ciphertext: __CryptoJS.enc.Base64.parse(String(text)) }, key, { iv: ivParsed, mode: __CryptoJS.mode.CBC, padding: __CryptoJS.pad.Pkcs7 });
      return decrypted.toString(__CryptoJS.enc.Utf8);
    } catch (e) { return String(text); }
  };
  globalThis.deobfuscateJsPassword = function (str) {
    var s = String(str || '');
    if (!/^\d+$/.test(s)) return s;
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
      out += String.fromCharCode(parseInt(s.substring(i, i + 3), 10));
    }
    return out;
  };
  globalThis.evaluateJavascriptViaWebview = function () { return Promise.resolve(''); };
  globalThis.parseDates = function (value, format, locale) {
    void format; void locale;
    if (Array.isArray(value)) return value.map(function (v) { return Date.parse(String(v)) || 0; });
    return Date.parse(String(value)) || 0;
  };
  globalThis.localStorage = {
    __map: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.__map, k) ? this.__map[k] : null; },
    setItem: function (k, v) { this.__map[k] = String(v); },
    removeItem: function (k) { delete this.__map[k]; },
    clear: function () { this.__map = {}; },
    key: function (i) { return Object.keys(this.__map)[i] || null; },
    get length() { return Object.keys(this.__map).length; }
  };

  // ── extractor globals ──
  // The reference app resolves these natively; this build fetches the embed
  // page through the guarded bridge, retries through the hosted relay's
  // /eco-page (allowlisted to the extractor families' hosts) when the page is
  // walled, and unpacks the player generically. The net-disk extractors
  // (quark/uc) need accounts, so they still answer empty.
  function __ecoLoadPage(url) {
    return new Promise(function (resolve) {
      if (!__h || !/^https?:\/\//i.test(String(url))) { resolve(''); return; }
      __h(String(url), { method: 'GET', headers: { Referer: String(url) }, timeout: 20000 })
        .then(function (res) { resolve(res.status >= 200 && res.status < 300 ? res.text : ''); },
          function () { resolve(''); });
    });
  }
  globalThis.__ecoExtract = function (url, quality) {
    void quality;
    return Promise.resolve(__ecoLoadPage(String(url || ''))).then(function (html) {
      var walled = !html || /just a moment|verify you are human|cf-browser-verification|ddos.guard/i.test(html.slice(0, 2000));
      if (walled && typeof globalThis.__ecoRelayPage === 'function') {
        return __ecoLoadPage(globalThis.__ecoRelayPage(String(url)));
      }
      return html;
    }).then(function (html) {
      if (!html) return [];
      var withUnpacked = html;
      var unpacked = globalThis.getAndUnpack(html);
      if (unpacked) withUnpacked = html + '\n' + unpacked;
      var out = [];
      var seen = {};
      var push = function (u, q) {
        if (!u || !/^https?:\/\//i.test(u) || seen[u]) return;
        seen[u] = 1;
        out.push({ url: u, originalUrl: String(url), quality: q || 'auto', headers: { Referer: String(url) } });
      };
      var patterns = [
        /"?\b(?:file|source|url|stream|video_url|link)"?\s*:\s*"(https?:[^"]+\.(?:m3u8|mpd|mp4)[^"]*)"/gi,
        /(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi,
        /(https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/gi
      ];
      for (var pi = 0; pi < patterns.length; pi++) {
        var found = withUnpacked.match(patterns[pi]) || [];
        for (var fi = 0; fi < found.length; fi++) {
          var value = found[fi];
          if (value.indexOf('http') !== 0) {
            var group = value.match(/"(https?:[^"]+)"/);
            value = group ? group[1] : value;
          }
          push(value.replace(/\\/g, ''), 'auto');
        }
      }
      return out.slice(0, 20);
    }).catch(function () { return []; });
  };
  var __ecoExtractor = function (url, quality) { return globalThis.__ecoExtract(url, quality); };
  ['sibnetExtractor', 'myTvExtractor', 'okruExtractor', 'voeExtractor', 'vidBomExtractor',
    'streamlareExtractor', 'sendVidExtractor', 'yourUploadExtractor', 'gogoCdnExtractor',
    'doodExtractor', 'streamTapeExtractor', 'mp4UploadExtractor', 'streamWishExtractor',
    'filemoonExtractor', 'Mp4UploadExtractor', 'MP4UploadExtractor', 'StreamWishExtractor',
    'FilemoonExtractor', 'DoodExtractor', 'StreamTapeExtractor', 'VoeExtractor', 'OkruExtractor'
  ].forEach(function (name) { globalThis[name] = __ecoExtractor; });
  globalThis.Mp4Upload = function () { return { extract: __ecoExtractor }; };
  // The net-disk extractors need accounts — they keep answering empty.
  ['quarkVideosExtractor', 'ucVideosExtractor', 'quarkFilesExtractor', 'ucFilesExtractor']
    .forEach(function (name) { globalThis[name] = function () { return Promise.resolve([]); }; });

  // ── the call bridge ──
  globalThis.__anymexFetchStats = function () { return __stats; };
  globalThis.__anymexResetStats = function () { __stats = { ok: 0, fail: 0, lastStatus: 0, deadSite: false, wall: false }; };

  // The instance is created lazily here, exactly the way upstream's harness
  // caches it: at call time the module source has already been evaluated in
  // this scope, so the lexical DefaultExtension class and the source
  // declarations (mangayomiSources and friends) are visible without a
  // separate init pass.
  globalThis.__anymexEnsureExt = function () {
    if (globalThis.__anymexExt) return globalThis.__anymexExt;
    var source = null;
    try {
      if (typeof mangayomiSources !== 'undefined' && mangayomiSources && mangayomiSources.length) source = mangayomiSources[0];
    } catch (e) {}
    if (!source) {
      for (var _i = 0, _a = ['kegaretaSauces', 'animeSources', 'mangaSources', 'animeSauces', 'mangaSauces', 'sources']; _i < _a.length; _i++) {
        try {
          var list = globalThis[_a[_i]];
          if (Array.isArray(list) && list.length && list[0] && (list[0].baseUrl || list[0].name)) { source = list[0]; break; }
        } catch (e) {}
      }
    }
    if (!source) source = Object.assign({}, __ANYMEX_META__, { lang: String(__ANYMEX_META__.lang || 'en') });
    try {
      var ext = new DefaultExtension(source);
      globalThis.__anymexExt = ext;
      return ext;
    } catch (e) {
      return null;
    }
  };

  globalThis.__anymexCall = function (fnName, argsJson) {
    return new Promise(function (resolve) {
      var ext = typeof globalThis.__anymexEnsureExt === 'function' ? globalThis.__anymexEnsureExt() : globalThis.__anymexExt;
      if (!ext) { resolve({ ok: false, error: 'module does not define DefaultExtension' }); return; }
      var fn = ext[fnName];
      if (typeof fn !== 'function') { resolve({ ok: false, error: 'module does not implement ' + fnName }); return; }
      var args = [];
      try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
      globalThis.__anymexResetStats();
      Promise.resolve().then(function () { return fn.apply(ext, args); }).then(function (result) {
        var data = result === undefined || result === null ? null : result;
        // Upstream serialises through QuickJS stringify, which drops anything
        // unserialisable; a module result can carry a live Promise or method
        // that structured clone refuses, so round-trip it the same way.
        try {
          data = JSON.parse(JSON.stringify(data));
        } catch (serialError) {
          resolve({ ok: false, error: 'module result could not be serialized' });
          return;
        }
        // The honest-error rewrite: an empty catalog where every request
        // failed is a diagnostic, not a quiet empty list.
        var isEmpty = data == null ||
          (Array.isArray(data) && data.length === 0) ||
          (data && typeof data === 'object' && Array.isArray(data.list) && data.list.length === 0);
        var allFailed = __stats.ok === 0 && __stats.fail > 0;
        if (isEmpty && allFailed && ['getPopular', 'getLatestUpdates', 'search'].indexOf(fnName) >= 0) {
          var detail = __stats.deadSite || __stats.wall
            ? 'the site refused the request (a protection wall or a dead site)'
            : ('HTTP ' + __stats.lastStatus + ' to every request');
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true, data: data });
      }, function (err) {
        resolve({ ok: false, error: String((err && err.message) || err).slice(0, 400) });
      });
    });
  };
})();
`;

/** Per-extension site meta, derived from the manifest entry (hostMetaOf). */
function anymexHostMeta(extension: EcosystemExtension): Record<string, unknown> {
  return {
    name: extension.name,
    baseUrl: extension.baseUrl ?? '',
    apiUrl: extension.apiUrl ?? '',
    lang: extension.lang || 'en',
    iconUrl: extension.logo ?? '',
  };
}

/** The composed script: harness, host meta, the module source, then the init
 * tail that resolves `mangayomiSources` / `DefaultExtension` lexically. */
async function composeAnymex(extension: EcosystemExtension, init = true): Promise<string> {
  const source = await fetchEcosystemScript(extension.url);
  const head = `
globalThis.__anymexStore = ${JSON.stringify(extension.key)};
globalThis.__ecoRelayPage = function (url) { return ${JSON.stringify(ecoRelayPageUrl('__URL__'))}.replace('__URL__', encodeURIComponent(String(url))); };
var __ANYMEX_META__ = ${JSON.stringify(anymexHostMeta(extension))};
${ANYMEX_HARNESS}
`.trim();
  if (!init) return `${head}\n${source}`;
  // The init tail runs after the source; the instance itself is created lazily
  // by the harness's `__anymexEnsureExt`, which at this point sees the module's
  // lexical `class DefaultExtension` and `mangayomiSources`.
  const tail = `
;globalThis.__anymexInit = function () {
  var ext = globalThis.__anymexEnsureExt ? globalThis.__anymexEnsureExt() : null;
  if (!ext) return JSON.stringify({ ok: false, error: 'module does not define DefaultExtension' });
  var hasVideo = typeof ext.getVideoList === 'function';
  var hasPages = typeof ext.getPageList === 'function';
  var name = (ext.source && ext.source.name) || ${JSON.stringify(extension.name)};
  return JSON.stringify({ ok: true, isManga: !hasVideo && hasPages, name: String(name) });
};
`.trim();
  return `${head}\n${source}\n${tail}`;
}

/** The `{"ok", data|error}` envelope one extension call answers. */
export async function callAnymex(
  extension: EcosystemExtension,
  fnName: string,
  args: unknown[],
  options: { catalog?: boolean } = {},
): Promise<{ ok: boolean; data?: unknown; error?: string; log: string[] }> {
  // Hikari's budgets: 75 s catalog/detail, 60 s the rest.
  const budget = options.catalog ? 75000 : 60000;
  try {
    const code = await composeAnymex(extension);
    return await runEcosystemCall(extension, code, '__anymexCall', [fnName, JSON.stringify(args)], { timeoutMs: budget, envelope: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), log: [] };
  }
}

/** Install-time probe: creates the instance, classifies anime vs manga. */
export async function inspectAnymex(extension: EcosystemExtension): Promise<{ ok: boolean; isManga: boolean; name: string; error?: string }> {
  try {
    const code = await composeAnymex(extension);
    const answer = await runEcosystemCall(extension, code, '__anymexInit', [], { timeoutMs: 25000 });
    if (!answer.ok) return { ok: false, isManga: extension.kind === 'manga', name: extension.name, error: answer.error };
    let report: Record<string, unknown> = {};
    try {
      report = typeof answer.data === 'string' ? JSON.parse(answer.data) : ((answer.data as Record<string, unknown>) || {});
    } catch {
      return { ok: false, isManga: extension.kind === 'manga', name: extension.name, error: 'probe unreadable' };
    }
    return { ok: report.ok === true, isManga: report.isManga === true, name: String(report.name ?? extension.name), error: report.ok === true ? undefined : 'the extension did not load' };
  } catch (error) {
    return { ok: false, isManga: extension.kind === 'manga', name: extension.name, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── data mapping (AnymexProvider / AnymexMangaProvider) ──

const MAX_STREAMS = 60;
const MAX_EPISODES = 2000;
const MAX_CHAPTERS = 2000;

const asString = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

function firstString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(raw[key]).trim();
    if (value) return value;
  }
  return '';
}

/** mapItems: `name|title` required, link and poster by their key fallbacks. */
function toMediaItem(extension: EcosystemExtension, raw: Record<string, unknown>): MediaItem | null {
  const title = asString(raw.name).trim() || asString(raw.title).trim();
  if (!title) return null;
  const own = firstString(raw, ['link', 'url', 'href', 'id']);
  if (!own) return null;
  const poster = firstString(raw, ['imageUrl', 'image', 'cover', 'poster', 'thumbnail', 'artwork', 'coverUrl']);
  return {
    id: `${extension.key}:${own}`,
    type: extension.kind === 'manga' ? 'series' : 'series',
    title,
    overview: '',
    poster,
    genres: [],
    source: 'anymex',
    providerId: extension.key,
    providerMediaId: own,
    addonType: extension.kind,
  };
}

function toItems(extension: EcosystemExtension, data: unknown): MediaItem[] {
  let list: unknown[] = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).list)) {
    list = (data as Record<string, unknown>).list as unknown[];
  }
  return list.slice(0, 120)
    .map((entry) => (entry && typeof entry === 'object' ? toMediaItem(extension, entry as Record<string, unknown>) : null))
    .filter((entry): entry is MediaItem => entry !== null);
}

/** The two seed rows every AnymeX catalog has (manga has only these). */
export const ANYMEX_CATALOGS = [
  { id: 'popular', name: 'Popular' },
  { id: 'latest', name: 'Latest' },
] as const;

export async function anymexCatalog(extension: EcosystemExtension, catalogId: string, page = 1): Promise<MediaItem[]> {
  const fnName = catalogId === 'latest' ? 'getLatestUpdates' : 'getPopular';
  const first = await callAnymex(extension, fnName, [Math.max(1, page)], { catalog: true });
  let items = toItems(extension, first.ok ? first.data : null);
  if (!items.length) {
    // The cross-seed retry: popular answers with latest, and the other way.
    const other = catalogId === 'latest' ? 'getPopular' : 'getLatestUpdates';
    const retry = await callAnymex(extension, other, [Math.max(1, page)], { catalog: true });
    items = toItems(extension, retry.ok ? retry.data : null);
  }
  return items;
}

export async function anymexSearch(extension: EcosystemExtension, query: string, page = 1): Promise<MediaItem[]> {
  if (!query.trim()) return [];
  const answer = await callAnymex(extension, 'search', [query.trim(), Math.max(1, page), []], { catalog: true });
  return toItems(extension, answer.ok ? answer.data : null);
}

export async function anymexDetail(extension: EcosystemExtension, ownId: string, known?: MediaItem): Promise<MediaItem | null> {
  if (!ownId) return null;
  const answer = await callAnymex(extension, 'getDetail', [ownId], { catalog: true });
  const data = answer.ok ? answer.data : null;
  if (!data || typeof data !== 'object') return known ?? null;
  const record = data as Record<string, unknown>;
  const genresRaw = record.genres ?? record.genre;
  const genres = Array.isArray(genresRaw)
    ? genresRaw.map(asString).filter(Boolean)
    : asString(genresRaw).trim() ? asString(genresRaw).split(',').map((g) => g.trim()).filter(Boolean) : [];
  return {
    ...(known ?? { id: `${extension.key}:${ownId}`, type: 'series' as const, title: '', overview: '', poster: '', source: 'anymex' as const, providerId: extension.key, providerMediaId: ownId }),
    title: firstString(record, ['title', 'name']) || known?.title || '',
    overview: firstString(record, ['description', 'synopsis', 'overview', 'plot']) || known?.overview || '',
    poster: firstString(record, ['imageUrl', 'image']) || known?.poster || '',
    genres: genres.length ? genres : known?.genres ?? [],
  };
}

const epochToIso = (raw: string): string => {
  if (!raw) return '';
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (ms > 0) {
      try {
        return new Date(ms).toISOString().slice(0, 10);
      } catch { return ''; }
    }
    return '';
  }
  return raw.slice(0, 10);
};

export interface AnymexEpisode {
  id: string;
  number: number;
  season: number;
  name: string;
  overview?: string;
  released?: string;
}

/** getDetail's episode array, under whichever key the module put it. */
function episodeArray(detail: Record<string, unknown>): unknown[] {
  for (const key of ['episodes', 'chapters', 'list', 'data', 'entries', 'items']) {
    const value = detail[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).data)) {
      return (value as Record<string, unknown>).data as unknown[];
    }
  }
  return [];
}

export async function anymexEpisodes(extension: EcosystemExtension, ownId: string): Promise<AnymexEpisode[]> {
  if (!ownId) return [];
  const answer = await callAnymex(extension, 'getDetail', [ownId], { catalog: true });
  const data = answer.ok ? answer.data : null;
  if (!data || typeof data !== 'object') return [];
  const list = episodeArray(data as Record<string, unknown>);
  const out: AnymexEpisode[] = [];
  list.slice(0, MAX_EPISODES).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const id = firstString(record, ['url', 'link', 'href', 'id', 'episodeUrl']);
    if (!id) return;
    const numberCandidates = ['number', 'episode_number', 'episodeNumber', 'episode', 'ep', 'no', 'index', 'num'];
    let number = 0;
    for (const key of numberCandidates) {
      const value = Number(record[key]);
      if (Number.isFinite(value) && value > 0) {
        number = Math.floor(value);
        break;
      }
    }
    const seasonValue = Number(record.season);
    out.push({
      id,
      number: number || index + 1,
      season: Number.isFinite(seasonValue) && seasonValue > 0 ? Math.floor(seasonValue) : 1,
      name: firstString(record, ['name', 'title']) || `Episode ${number || index + 1}`,
      overview: firstString(record, ['description', 'synopsis', 'overview', 'plot']) || undefined,
      released: epochToIso(firstString(record, ['date', 'released', 'air_date', 'dateUpload'])) || undefined,
    });
  });
  return out;
}

function readSubtitles(raw: Record<string, unknown>): StreamSubtitle[] {
  const out: StreamSubtitle[] = [];
  const subs = raw.subtitles ?? raw.subs;
  if (!Array.isArray(subs)) return out;
  for (const sub of subs) {
    let url = '';
    let lang = 'Sub';
    if (typeof sub === 'string') url = sub;
    else if (sub && typeof sub === 'object') {
      const record = sub as Record<string, unknown>;
      url = firstString(record, ['file', 'url', 'uri']);
      lang = firstString(record, ['label', 'language']) || 'Sub';
    }
    if (url && /^https?:\/\//i.test(url)) out.push({ id: url, language: lang, url, name: lang });
  }
  return out;
}

function toStreamResult(extension: EcosystemExtension, raw: Record<string, unknown>, index: number): StreamResult | null {
  const url = firstString(raw, ['url', 'originalUrl', 'streamUrl', 'file', 'src', 'link']);
  if (!url) return null;
  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (value != null) headers[key] = String(value);
    }
  }
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = UA;
  const label = firstString(raw, ['quality', 'label', 'resolution']);
  const size = asString(raw.size).trim();
  const language = firstString(raw, ['language', 'lang']);
  const details = [label, size, language].filter(Boolean).join(' • ');
  const isTorrent = /^magnet:/i.test(url);
  return {
    id: `anymex:${extension.key}:${index}`,
    url,
    title: details || firstString(raw, ['title', 'name']) || 'Auto',
    sourceName: `${extension.name} · AnymeX`,
    sourceType: 'ecosystem',
    quality: label || undefined,
    size: size || undefined,
    language: language || undefined,
    provider: extension.name,
    headers,
    subtitles: readSubtitles(raw).length ? readSubtitles(raw) : undefined,
    format: url.includes('.m3u8') ? 'hls' : url.includes('.mpd') ? 'dash' : undefined,
    infoHash: isTorrent ? url : undefined,
  };
}

/** getVideoList: array, bare URL strings, or one raw url/magnet string. */
export async function anymexStreams(extension: EcosystemExtension, episodeId: string): Promise<StreamResult[]> {
  if (!episodeId) return [];
  const answer = await callAnymex(extension, 'getVideoList', [episodeId]);
  if (!answer.ok) return [];
  const data = answer.data;
  const out: StreamResult[] = [];
  const push = (raw: Record<string, unknown>) => {
    const stream = toStreamResult(extension, raw, out.length);
    if (stream) out.push(stream);
  };
  if (typeof data === 'string') {
    if (/^(https?:\/\/|magnet:)/i.test(data.trim())) push({ url: data.trim() });
    return out.slice(0, MAX_STREAMS);
  }
  if (Array.isArray(data)) {
    for (const entry of data.slice(0, MAX_STREAMS)) {
      if (typeof entry === 'string' && /^(https?:\/\/|magnet:)/i.test(entry)) push({ url: entry });
      else if (entry && typeof entry === 'object') push(entry as Record<string, unknown>);
    }
  }
  return out;
}

// ── manga: chapters + pages ──

export interface AnymexChapter {
  id: string;
  number: number;
  name: string;
}

/** digDetail unwraps {ok,data} envelopes and single-element arrays. */
function unwrapDetail(data: unknown): Record<string, unknown> | null {
  let current = data;
  for (let hop = 0; hop < 3; hop++) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      if (typeof record.ok === 'boolean' && 'data' in record) {
        current = record.data;
        continue;
      }
    }
    break;
  }
  if (Array.isArray(current)) {
    const first = current.find((entry) => entry && typeof entry === 'object');
    return first ? (first as Record<string, unknown>) : null;
  }
  return current && typeof current === 'object' ? (current as Record<string, unknown>) : null;
}

/** findChapterArray: BFS over the detail object, depth ≤4, ≤800 nodes. */
function findChapterArray(root: Record<string, unknown>): unknown[] {
  const linkKeys = new Set(['url', 'link', 'href', 'id', 'slug', 'path', 'endpoint', 'chapterId']);
  const chapterShaped = (entry: unknown): boolean => {
    if (typeof entry === 'string' && entry.trim()) return true;
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return linkKeys.has('') || Object.keys(record).some((key) => linkKeys.has(key));
  };
  let depth = 0;
  let queue: unknown[] = [root];
  let visited = 0;
  while (queue.length && depth < 4 && visited < 800) {
    const next: unknown[] = [];
    for (const node of queue) {
      visited++;
      if (Array.isArray(node)) {
        const head = node.slice(0, 8);
        if (head.length && head.every((entry) => chapterShaped(entry))) return node;
        next.push(...node.filter((entry) => entry && typeof entry === 'object'));
      } else if (node && typeof node === 'object') {
        next.push(...Object.values(node as Record<string, unknown>));
      }
    }
    queue = next;
    depth++;
  }
  return [];
}

export async function anymexChapters(extension: EcosystemExtension, ownId: string): Promise<AnymexChapter[]> {
  if (!ownId) return [];
  const answer = await callAnymex(extension, 'getDetail', [ownId], { catalog: true });
  if (!answer.ok) return [];
  const detail = unwrapDetail(answer.data);
  if (!detail) return [];
  let list: unknown[] = [];
  for (const key of ['chapters', 'episodes']) {
    if (Array.isArray(detail[key])) {
      list = detail[key] as unknown[];
      break;
    }
  }
  if (!list.length && detail.data && typeof detail.data === 'object') {
    const nested = detail.data as Record<string, unknown>;
    for (const key of ['chapters', 'episodes']) {
      if (Array.isArray(nested[key])) {
        list = nested[key] as unknown[];
        break;
      }
    }
  }
  if (!list.length) list = findChapterArray(detail);
  const out: AnymexChapter[] = [];
  for (const entry of list.slice(0, MAX_CHAPTERS)) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ id: entry.trim(), number: out.length + 1, name: `Chapter ${out.length + 1}` });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = firstString(record, ['url', 'link', 'href', 'id', 'slug', 'path', 'endpoint', 'chapterId']);
    if (!id) continue;
    // In the JS path the number is always the 1-based array index.
    out.push({
      id,
      number: out.length + 1,
      name: firstString(record, ['name', 'title', 'label']) || `Chapter ${out.length + 1}`,
    });
  }
  return out;
}

/** normPageUrl: refuse blanks, html pages, tiny and self-referencing URLs. */
function normPageUrl(url: string, chapterUrl: string): string | null {
  let value = String(url || '').trim();
  if (!value || /\s|[{}]/.test(value)) return null;
  if (/^(data:|javascript:|blob:)/i.test(value)) return null;
  if (value.startsWith('//')) value = `https:${value}`;
  const path = value.split(/[?#]/)[0].toLowerCase();
  if (/\.(html?|php|aspx?)$/.test(path)) return null;
  if (value.length < 12) return null;
  if (chapterUrl && value === chapterUrl) return null;
  return value;
}

const PAGE_CACHE_LIMIT = 2000;
const chapterImagesCache = new Map<string, Set<string>>();

function rememberChapterImages(extensionKey: string, itemId: string, urls: string[]): void {
  const key = `${extensionKey}|${itemId}`;
  const set = chapterImagesCache.get(key) ?? new Set<string>();
  for (const url of urls) {
    set.add(url);
    set.add(url.split(/[?#]/)[0].split('#')[0].toLowerCase());
  }
  if (set.size > PAGE_CACHE_LIMIT) chapterImagesCache.delete(key);
  else chapterImagesCache.set(key, set);
}

/** getPageList, with the page hygiene filters upstream applies. */
export async function anymexPages(extension: EcosystemExtension, ownId: string, chapterId: string): Promise<string[]> {
  void ownId;
  if (!chapterId) return [];
  const answer = await callAnymex(extension, 'getPageList', [chapterId], { catalog: true });
  if (!answer.ok) return [];
  const data = answer.data;
  let list: unknown[] = [];
  const scan = (node: unknown, narrow: boolean, depth: number): void => {
    if (list.length || depth > 5) return;
    if (Array.isArray(node)) {
      const head = node.slice(0, 3);
      const shaped = head.every((entry) =>
        typeof entry === 'string' ? true : Boolean(entry) && typeof entry === 'object' &&
        ['url', 'imageUrl', 'image', 'src', 'originalUrl'].some((key) => asString((entry as Record<string, unknown>)[key]).trim()));
      if (shaped && head.length) {
        list = node;
        return;
      }
      for (const entry of node) scan(entry, narrow, depth + 1);
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const keys = narrow
        ? ['pages', 'list', 'pagelist', 'imagelist']
        : ['pages', 'list', 'data', 'images', 'imgs', 'urls', 'sources', 'files', 'pagelist', 'imagelist'];
      for (const key of keys) {
        if (record[key] != null) {
          scan(record[key], narrow, depth + 1);
          if (list.length) return;
        }
      }
    }
  };
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    scan(data, true, 0);
    if (!list.length) scan(data, false, 0);
  }
  const chapterUrl = chapterId;
  const out: string[] = [];
  const seenExact = new Set<string>();
  const seenNormalized = new Set<string>();
  for (const entry of list) {
    let raw: string | null = null;
    if (typeof entry === 'string') raw = entry;
    else if (entry && typeof entry === 'object') {
      raw = firstString(entry as Record<string, unknown>, ['url', 'imageUrl', 'image', 'src', 'originalUrl']);
    }
    if (!raw) continue;
    if (/thumb|preview|[?]type=|thumbnail/i.test(raw)) continue;
    const normalized = normPageUrl(raw, chapterUrl);
    if (!normalized) continue;
    const exact = normalized;
    const norm = normalized.split(/[?#]/)[0].split('#')[0].toLowerCase();
    if (seenExact.has(exact) || seenNormalized.has(norm)) continue;
    seenExact.add(exact);
    seenNormalized.add(norm);
    out.push(normalized);
  }
  // The all-identical lock: one normalized URL across ≥2 pages is a walled
  // chapter, not a chapter of the same picture.
  if (out.length >= 2 && seenNormalized.size === 1) return [];
  rememberChapterImages(extension.key, chapterId, out);
  return out;
}

/** Test seam: forget the page caches. */
export function resetAnymexCaches(): void {
  chapterImagesCache.clear();
}
