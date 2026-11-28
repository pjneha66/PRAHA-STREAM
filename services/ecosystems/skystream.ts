// SkyStream plugins — movie/series extensions shipped as `.sky` archives (a
// ZIP with `plugin.js` + `plugin.json`) that export `getHome`, `search`,
// `load` and `loadStreams`, each called with a result callback as its last
// argument (or a returned Promise — whichever settles first wins).
//
// A port of Hikari's `skystream/SkyStreamRuntime.kt`, `SkyStreamPluginManager.kt`
// and `SkyStreamProvider.kt` (GPL-3.0-or-later, Copyright (C) 2026 Codegeasse).
// The prelude below is the shim.js contract plugins are written against —
// MultimediaItem/Episode/StreamResult, http_get/http_post/http_parallel,
// parseHtml over cheerio, getAndUnpack, crypto helpers, preferences — reduced
// to what the browser build can run (no WebView Cloudflare jar, so
// `loadExtractor` answers empty and `solveCaptcha` stays null by design).
//
// Upstream's caps and the magic-URL decoding are kept exactly: 80 items a row,
// 800 episodes, 200 streams a call, the 8-minute home TTL, and the
// `magic_m3u8:` / `MAGIC_PROXY` payload formats.

import JSZip from 'jszip';
import { runEcosystemCall } from '../pluginRuntime';
import { fetchEcosystemScript } from './scripts';
import { installEcosystemExtensions, type EcosystemExtension } from './store';
import type { MediaItem, StreamResult, StreamSubtitle } from '../../types';

// ── install: repositories and .sky packages ──

/** One entry of a SkyStream `repo.json`, as the manager lists it. */
export interface SkyStreamRepoEntry {
  id: string;
  name: string;
  url: string;
  version: string;
  description: string;
  iconUrl?: string;
  nsfw: boolean;
}

const PLACEHOLDER_HOSTS = ['.local', '.invalid', '.test', '.example', 'localhost', 'stremio-hub'];

/** Hikari's hostUrl: prepend https:// when needed, refuse placeholder hosts. */
export function skyStreamHostUrl(raw: string): string | null {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('//')) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) {
    if (!value.includes('.')) return null;
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (PLACEHOLDER_HOSTS.some((host) => url.hostname.endsWith(host))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Hikari's skyish heuristic: does this repo entry point at a SkyStream plugin? */
function isSkyish(record: Record<string, unknown>): boolean {
  const url = String(record.url ?? '');
  if (url.endsWith('.sky')) return true;
  if (record.packageName) return true;
  if (record.addons) return true;
  if (record.id && !record.fileHash) return true;
  return false;
}

/**
 * A SkyStream repository: `{"plugins": […]}`. Entries are picked by the same
 * skyish heuristic the reference app scores them with; a `.sky` URL relative
 * to the manifest resolves against its folder, and a bare `packageName` gets
 * the default `<base>/<packageName>.sky` name.
 */
export function parseSkyStreamRepo(text: string, repoUrl: string): SkyStreamRepoEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That link is not a SkyStream repository (its repo.json).');
  }
  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || !Array.isArray(record.plugins)) {
    throw new Error('That file lists no SkyStream plugins.');
  }
  const base = repoUrl.split(/[?#]/)[0];
  const folder = base.slice(0, base.lastIndexOf('/') + 1);
  const out: SkyStreamRepoEntry[] = [];
  const seen = new Set<string>();
  for (const entry of record.plugins) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (!isSkyish(item)) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    if (!name) continue;
    const pkg = String(item.packageName ?? item.id ?? '').trim();
    if (!pkg) continue;
    let url = String(item.url ?? '').trim();
    if (!url) url = `${pkg}.sky`;
    if (!/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url, folder).toString();
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const id = pkg;
    if (seen.has(id)) continue;
    seen.add(id);
    const icon = String(item.iconUrl ?? item.logo ?? item.icon ?? '').trim();
    const version = String(item.version ?? '').trim();
    out.push({
      id,
      name,
      url,
      version: version ? String(parseInt(version, 10) || 1) : '1',
      description: typeof item.description === 'string' ? item.description : '',
      iconUrl: /^https?:\/\//i.test(icon) ? icon : undefined,
      nsfw: item.nsfw === true || item.nsfw === '1',
    });
    if (out.length >= 200) break;
  }
  if (!out.length) throw new Error('That file lists no SkyStream plugins.');
  return out;
}

/** A plugin.json manifest, verbatim to what the runtime reads. */
export interface SkyStreamManifest {
  packageName: string;
  name: string;
  baseUrl?: string;
  domains: Array<{ name: string; url: string }>;
  providers: Array<{ id: string; name: string }>;
  addons: string[];
  iconUrl?: string;
}

function parseSkyManifest(text: string): SkyStreamManifest {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const packageName = String(parsed.packageName ?? parsed.id ?? '').trim();
  if (!packageName) throw new Error('Extension has no package name');
  const domainsRaw = Array.isArray(parsed.domains) ? parsed.domains : [];
  const domains = domainsRaw
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const item = entry as Record<string, unknown>;
        return { name: String(item.name ?? ''), url: String(item.url ?? '') };
      }
      return { name: '', url: String(entry ?? '') };
    })
    .filter((entry) => skyStreamHostUrl(entry.url));
  const providersRaw = Array.isArray(parsed.providers) ? parsed.providers : [];
  const providers = providersRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      const id = String(item.id ?? '').trim();
      if (!id) return null;
      return { id, name: String(item.name ?? '').trim() || id };
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
  const addonsRaw = Array.isArray(parsed.addons) ? parsed.addons : [];
  const icon = String(parsed.iconUrl ?? parsed.logo ?? parsed.icon ?? '').trim();
  return {
    packageName,
    name: String(parsed.name ?? '').trim() || packageName,
    baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : undefined,
    domains,
    providers,
    addons: addonsRaw.filter((entry): entry is string => typeof entry === 'string'),
    iconUrl: /^https?:\/\//i.test(icon) ? icon : icon.startsWith('//') ? `https:${icon}` : undefined,
  };
}

/**
 * A `.sky` archive: the shallowest `plugin.js` and `plugin.json` win, whatever
 * folder they sit in. Returns the script text, the manifest, and the byte
 * sizes the install flow reports.
 */
export async function unpackSkyArchive(bytes: ArrayBuffer | Uint8Array): Promise<{ script: string; manifest: SkyStreamManifest }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('Not a SkyStream extension (unreadable .sky archive)');
  }
  let scriptPath: string | null = null;
  let manifestPath: string | null = null;
  for (const path of Object.keys(zip.files)) {
    const file = zip.files[path];
    if (file.dir) continue;
    const lower = path.toLowerCase();
    if (lower.endsWith('/plugin.js') || lower === 'plugin.js') {
      if (!scriptPath || path.split('/').length < scriptPath.split('/').length) scriptPath = path;
    }
    if (lower.endsWith('/plugin.json') || lower === 'plugin.json') {
      if (!manifestPath || path.split('/').length < manifestPath.split('/').length) manifestPath = path;
    }
  }
  if (!scriptPath) throw new Error('Not a SkyStream extension (no plugin.js in the .sky)');
  if (!manifestPath) throw new Error('Not a SkyStream extension (no plugin.json in the .sky)');
  const script = await zip.files[scriptPath].async('string');
  const manifest = parseSkyManifest(await zip.files[manifestPath].async('string'));
  return { script, manifest };
}

const SKY_SCRIPT_CACHE_PREFIX = 'skystream-script:';

/** The plugin script, cached from its archive — scripts.ts caches raw URLs. */
async function skyStreamScript(extension: EcosystemExtension): Promise<string> {
  const cached = sessionStorage.getItem(SKY_SCRIPT_CACHE_PREFIX + extension.key);
  if (cached) return cached;
  const answer = await fetchEcosystemScript(extension.url, 5 * 1024 * 1024);
  let script: string;
  try {
    const unpacked = await unpackSkyArchive(new TextEncoder().encode(answer).buffer as ArrayBuffer);
    script = unpacked.script;
  } catch {
    // A bare URL may host the plugin.js text itself rather than an archive.
    script = answer;
  }
  try {
    sessionStorage.setItem(SKY_SCRIPT_CACHE_PREFIX + extension.key, script);
  } catch { /* a large script simply re-downloads next run */ }
  return script;
}

/** Installs one `.sky` archive's manifest as a PRAHA extension entry (or one per feed). */
export function installSkyStreamPackage(manifest: SkyStreamManifest, url: string, sourceUrl: string, persist = true): EcosystemExtension[] {
  const icon = manifest.iconUrl;
  const base = {
    ecosystem: 'skystream' as const,
    url,
    version: '1',
    lang: 'en',
    logo: icon,
    baseUrl: manifest.baseUrl,
    sourceUrl,
    enabled: true,
    installedAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (manifest.providers.length) {
    // A bundle: one row per feed, keyed `sky|<pkg>|<feedId>` — the feed id is
    // injected as `manifest.providerId` at call time, exactly as upstream does.
    const extensions = manifest.providers.map((feed): EcosystemExtension => ({
      ...base,
      key: `skystream:${manifest.packageName}|${feed.id}`,
      id: `${manifest.packageName}|${feed.id}`,
      name: `${manifest.name} · ${feed.name}`,
      kind: 'series',
    }));
    return persist ? installEcosystemExtensions(extensions) : extensions;
  }
  const extensions: EcosystemExtension[] = [{
    ...base,
    key: `skystream:${manifest.packageName}`,
    id: manifest.packageName,
    name: manifest.name,
    kind: 'series',
  }];
  return persist ? installEcosystemExtensions(extensions) : extensions;
}

// ── the shim prelude ──

/** The shim, ported from Hikari's `assets/skystream/shim.js`. String.raw keeps
 * the JS's own backslashes intact; it deliberately contains no template
 * literals of its own. */
const SKY_SHIM = String.raw`
(function () {
  var __h = (typeof http === 'function') ? http : null;

  // ── data classes (defaults per upstream's shim) ──
  function MultimediaItem(params) {
    params = params || {};
    return Object.assign({ type: 'movie', status: 'ongoing', playbackPolicy: 'none', isAdult: false, streams: [], syncData: {} }, params);
  }
  function Episode(params) {
    params = params || {};
    return Object.assign({ season: 0, episode: 0, dubStatus: 'none', playbackPolicy: 'none', streams: [] }, params);
  }
  function StreamResult(o) {
    o = o || {};
    return {
      url: o.url,
      source: o.source || o.name || 'Auto',
      name: o.name || o.source,
      quality: o.quality,
      size: o.size,
      type: o.type,
      isM3U8: o.isM3U8,
      headers: o.headers,
      subtitles: o.subtitles,
      drmKid: o.drmKid,
      drmKey: o.drmKey,
      licenseUrl: o.licenseUrl
    };
  }
  function Actor(p) { return p || {}; }
  function Trailer(p) { return p || {}; }
  function NextAiring(p) { return p || {}; }
  globalThis.MultimediaItem = MultimediaItem;
  globalThis.Episode = Episode;
  globalThis.StreamResult = StreamResult;
  globalThis.Actor = Actor;
  globalThis.Trailer = Trailer;
  globalThis.NextAiring = NextAiring;
  globalThis.CloudStream = { getLanguage: function () { return 'en'; }, getRegion: function () { return 'US'; } };

  // ── HTTP ──
  function unwrapHeaders(headers) {
    if (headers && typeof headers === 'object' && headers.headers && typeof headers.headers === 'object') return headers.headers;
    return headers || {};
  }
  function skyRequest(url, headers, method, body) {
    return new Promise(function (resolve, reject) {
      if (!__h) { reject(new Error('no http bridge')); return; }
      __h(String(url), { method: method || 'GET', headers: unwrapHeaders(headers), body: body || undefined, timeout: 20000 })
        .then(function (res) {
          var parsed = null;
          try { parsed = JSON.parse(res.text); } catch (e) { parsed = null; }
          resolve(parsed || { status: res.status || 0, body: res.text || '', headers: res.headers || {} });
        }, function (err) { reject(new Error(String((err && err.message) || err || 'request failed'))); });
    });
  }
  function withCb(promise, cb) {
    if (typeof cb === 'function') promise.then(function (v) { cb(v); }, function () { cb(null); });
    return promise;
  }
  globalThis.http_get = function (url, headers, cb) { return withCb(skyRequest(url, headers, 'GET'), cb); };
  globalThis.http_post = function (url, headers, body, cb) {
    // Upstream fixes swapped args: a string in the headers slot with an object
    // in the body slot means they were given the other way round.
    if (typeof headers === 'string' && body && typeof body === 'object') {
      var tmp = headers; headers = body; body = tmp;
    }
    return withCb(skyRequest(url, headers, 'POST', body), cb);
  };
  globalThis.http_parallel = function (requests) {
    return Promise.all((requests || []).map(function (item) {
      item = item || {};
      var url = String(item.url || '');
      if (item.params && typeof item.params === 'object' && String(item.method || 'GET').toUpperCase() === 'GET') {
        var qs = new URLSearchParams();
        Object.keys(item.params).forEach(function (k) { qs.append(k, String(item.params[k])); });
        url = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs.toString();
      }
      var body = item.data != null ? item.data : item.body;
      return skyRequest(url, item.headers, item.method || 'GET', body == null ? undefined : String(body))
        .catch(function () { return { status: 0, body: '', headers: {} }; });
    }));
  };
  function skyFetch(url, opts) {
    opts = opts || {};
    return skyRequest(url, opts.headers, opts.method || 'GET', opts.body).then(function (res) {
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        url: url,
        headers: { get: function (name) { return res.headers[String(name).toLowerCase()] != null ? res.headers[String(name).toLowerCase()] : res.headers[name] != null ? res.headers[name] : null; } },
        text: function () { return Promise.resolve(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)); },
        json: function () { return Promise.resolve(res.body); }
      };
    });
  }
  globalThis.fetch = skyFetch;
  globalThis._fetch = skyFetch;

  // ── HTML: a DOM facade over the sandbox's cheerio ──
  var __cheerio = (globalThis.__cheerioLib || globalThis.cheerio);
  function wrapNode(el) {
    if (el == null) return null;
    if (Array.isArray(el) || (el.length !== undefined && typeof el !== 'function' && !(el.cheerio))) {
      if (el.length === 1 && el[0]) return wrapNode(el[0]);
    }
    return new SkyNode(el);
  }
  function SkyNode(el) { this.__el = el; }
  SkyNode.prototype.getAttribute = function (name) { var v = this.__el.attr ? this.__el.attr(name) : null; return v == null ? '' : String(v); };
  SkyNode.prototype.hasAttribute = function (name) { var v = this.__el.attr ? this.__el.attr(name) : null; return v != null; };
  SkyNode.prototype.setAttribute = function (name, value) { if (this.__el.attr) this.__el.attr(name, value); };
  SkyNode.prototype.removeAttribute = function (name) { if (this.__el.attr) this.__el.removeAttr(name); };
  SkyNode.prototype.querySelector = function (sel) { return wrapNode(this.__el.find ? this.__el.find(sel).first() : null); };
  SkyNode.prototype.querySelectorAll = function (sel) {
    var out = [];
    if (this.__el.find) this.__el.find(sel).each(function (_i, child) { out.push(new SkyNode(__cheerio(child))); });
    return out;
  };
  SkyNode.prototype.getElementsByTagName = function (tag) { return this.querySelectorAll(tag); };
  SkyNode.prototype.getElementsByClassName = function (cls) { return this.querySelectorAll('.' + String(cls).trim()); };
  SkyNode.prototype.matches = function (sel) { try { return this.__el.is(sel); } catch (e) { return false; } };
  SkyNode.prototype.closest = function (sel) { return wrapNode(this.__el.closest ? this.__el.closest(sel) : null); };
  SkyNode.prototype.text = function () { return this.__el.text ? String(this.__el.text()).trim() : ''; };
  SkyNode.prototype.html = function () { return this.__el.html ? String(this.__el.html() || '') : ''; };
  SkyNode.prototype.attr = function (name, value) {
    if (arguments.length > 1) { this.setAttribute(name, value); return this; }
    return this.getAttribute(name);
  };
  SkyNode.prototype.find = function (sel) { return this.querySelectorAll(sel); };
  SkyNode.prototype.first = function () { return this; };
  SkyNode.prototype.toString = function () {
    try { return this.__el.prop ? String(this.__el.prop('outerHTML') || '') : this.html(); } catch (e) { return this.html(); }
  };
  Object.defineProperty(SkyNode.prototype, 'textContent', { get: function () { return this.text(); } });
  Object.defineProperty(SkyNode.prototype, 'innerText', { get: function () { return this.text(); } });
  Object.defineProperty(SkyNode.prototype, 'innerHTML', { get: function () { return this.html(); } });
  Object.defineProperty(SkyNode.prototype, 'outerHTML', { get: function () { return this.toString(); } });
  Object.defineProperty(SkyNode.prototype, 'tagName', { get: function () { try { return String(this.__el.prop('tagName') || '').toUpperCase(); } catch (e) { return ''; } } });
  Object.defineProperty(SkyNode.prototype, 'nodeName', { get: function () { return this.tagName; } });
  Object.defineProperty(SkyNode.prototype, 'id', { get: function () { return this.getAttribute('id'); } });
  Object.defineProperty(SkyNode.prototype, 'className', { get: function () { return this.getAttribute('class'); } });
  Object.defineProperty(SkyNode.prototype, 'href', { get: function () { return this.getAttribute('href'); } });
  Object.defineProperty(SkyNode.prototype, 'src', { get: function () { return this.getAttribute('src'); } });
  Object.defineProperty(SkyNode.prototype, 'children', {
    get: function () {
      var out = [];
      try { this.__el.children().each(function (_i, child) { out.push(new SkyNode(__cheerio(child))); }); } catch (e) {}
      return out;
    }
  });
  Object.defineProperty(SkyNode.prototype, 'childNodes', { get: function () { return this.children; } });
  Object.defineProperty(SkyNode.prototype, 'firstElementChild', { get: function () { return this.children[0] || null; } });
  Object.defineProperty(SkyNode.prototype, 'nextElementSibling', { get: function () { return wrapNode(this.__el.next ? this.__el.next() : null); } });
  Object.defineProperty(SkyNode.prototype, 'previousElementSibling', { get: function () { return wrapNode(this.__el.prev ? this.__el.prev() : null); } });
  Object.defineProperty(SkyNode.prototype, 'parentElement', { get: function () { return wrapNode(this.__el.parent ? this.__el.parent() : null); } });
  Object.defineProperty(SkyNode.prototype, 'parentNode', { get: function () { return this.parentElement; } });
  Object.defineProperty(SkyNode.prototype, 'classList', {
    get: function () {
      var self = this;
      var parts = this.getAttribute('class').split(/\s+/).filter(Boolean);
      return { length: parts.length, contains: function (c) { return parts.indexOf(c) >= 0; }, item: function (i) { return parts[i] || null; }, toArray: function () { return parts.slice(); }, value: parts.join(' '), toString: function () { return parts.join(' '); }, _self: self };
    }
  });
  Object.defineProperty(SkyNode.prototype, 'dataset', {
    get: function () {
      var out = {};
      var el = this.__el;
      if (el && el[0] && el[0].attribs) {
        Object.keys(el[0].attribs).forEach(function (key) {
          if (key.indexOf('data-') === 0) {
            var camel = key.slice(5).replace(/-([a-z])/g, function (_m, c) { return c.toUpperCase(); });
            out[camel] = el[0].attribs[key];
          }
        });
      }
      return out;
    }
  });

  function SkyDocument(html) {
    this.__el = __cheerio.load ? __cheerio.load(String(html == null ? '' : html)) : null;
    var self = this;
    this.body = this.__el ? new SkyNode(this.__el('body')) : null;
    this.head = this.__el ? new SkyNode(this.__el('head')) : null;
    this.documentElement = this.body;
    this.title = this.__el ? String(this.__el('title').text() || '').trim() : '';
  }
  SkyDocument.prototype.querySelector = function (sel) { return this.__el ? wrapNode(this.__el(sel).first()) : null; };
  SkyDocument.prototype.querySelectorAll = function (sel) {
    var out = [];
    if (!this.__el) return out;
    this.__el(sel).each(function (_i, child) { out.push(new SkyNode(__cheerio(child))); });
    return out;
  };
  SkyDocument.prototype.getElementsByTagName = function (tag) { return this.querySelectorAll(tag); };
  SkyDocument.prototype.getElementsByClassName = function (cls) { return this.querySelectorAll('.' + String(cls).trim()); };
  SkyDocument.prototype.getElementById = function (id) { return this.querySelectorAll('#' + String(id).trim())[0] || null; };
  SkyDocument.prototype.toString = function () { return this.__el && this.__el.html ? String(this.__el.html()) : ''; };

  globalThis.parseHtmlSync = function (html) { return new SkyDocument(html); };
  globalThis.parseHtml = function (html) { return Promise.resolve(new SkyDocument(html)); };
  globalThis.parse_html = function (html, selector, attr) {
    return Promise.resolve(new SkyDocument(html)).then(function (doc) {
      return doc.querySelectorAll(selector).map(function (node) {
        if (!attr || attr === 'text') return node.text();
        if (attr === 'html') return node.html();
        return node.attr(attr);
      }).filter(function (v) { return v; });
    });
  };
  globalThis.JSDOM = function (html) { var doc = new SkyDocument(html); return { window: { document: doc } }; };

  // ── de-obfuscation / crypto / misc ──
  var __BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function baseEncode(i, a) {
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
        unescaped = unescaped.replace(new RegExp('\\b' + baseEncode(i, a) + '\\b', 'g'), k[i]);
      }
      return unescaped;
    } catch (e) { return ''; }
  };
  var __CryptoJS = globalThis.CryptoJS;
  globalThis.crypto = globalThis.crypto || {};
  globalThis.crypto.decryptAES = function (data, key, iv, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      if (!__CryptoJS) { reject(new Error('CryptoJS missing')); return; }
      try {
        var keyParsed = /^[0-9a-fA-F]{32,64}$/.test(key) ? __CryptoJS.enc.Hex.parse(key) : __CryptoJS.enc.Utf8.parse(key);
        var ivParsed = iv ? (/^[0-9a-fA-F]{32}$/.test(iv) ? __CryptoJS.enc.Hex.parse(iv) : __CryptoJS.enc.Utf8.parse(iv)) : null;
        var mode = options.mode === 'ecb' ? __CryptoJS.mode.ECB : __CryptoJS.mode.CBC;
        var params = ivParsed ? { iv: ivParsed, mode: mode, padding: __CryptoJS.pad.Pkcs7 } : { mode: mode, padding: __CryptoJS.pad.Pkcs7 };
        var decrypted = __CryptoJS.AES.decrypt(String(data), keyParsed, params);
        resolve(decrypted.toString(__CryptoJS.enc.Utf8));
      } catch (e) { reject(e); }
    });
  };
  globalThis.crypto.pbkdf2 = function (password, salt, iterations, keyLength) {
    return new Promise(function (resolve, reject) {
      if (!__CryptoJS) { reject(new Error('CryptoJS missing')); return; }
      try {
        var key = __CryptoJS.PBKDF2(String(password), __CryptoJS.enc.Hex.parse(String(salt)), {
          keySize: ((keyLength || 32) / 4), iterations: iterations || 10000
        });
        resolve(key.toString());
      } catch (e) { reject(e); }
    });
  };
  globalThis.solveCaptcha = function () { return Promise.resolve(null); };
  globalThis.loadExtractor = function (url, cb) {
    // The reference app cracks embeds natively; this build answers empty and
    // the plugin's own links stand.
    var empty = Promise.resolve([]);
    return withCb(empty, cb);
  };
  var __prefStore = {};
  globalThis.getPreference = function (key) {
    return new Promise(function (resolve) {
      __ecoPrefGet(globalThis.__skyPrefStore || '', String(key)).then(function (v) {
        resolve(v != null ? v : (__prefStore[key] != null ? String(__prefStore[key]) : null));
      }, function () { resolve(null); });
    });
  };
  globalThis.setPreference = function (key, value) {
    return new Promise(function (resolve) {
      __ecoPrefSet(globalThis.__skyPrefStore || '', String(key), String(value)).then(function () { resolve(true); }, function () { resolve(false); });
    });
  };
})();
`;

function skystreamPrelude(extension: EcosystemExtension, manifest: Record<string, unknown>): string {
  // `manifest` is injected verbatim (plugin.json plus the feed's providerId),
  // exactly the way the reference runtime evaluates it before the plugin.
  return `
globalThis.__skyPrefStore = ${JSON.stringify(extension.key)};
globalThis.__skyCheerio = cheerio;
globalThis.manifest = ${JSON.stringify(manifest)};
globalThis.__skyEntry = function (fnName, argsJson) {
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function (payload, err) {
      if (settled) return;
      settled = true;
      if (err) { resolve({ ok: false, error: String((err && err.message) || err) }); return; }
      if (payload == null) { resolve({ ok: true, data: null }); return; }
      if (typeof payload === 'object') {
        try { resolve({ ok: true, data: JSON.parse(JSON.stringify(payload)) }); }
        catch (e) { resolve({ ok: false, error: 'unserializable result' }); }
        return;
      }
      var text = String(payload);
      var trimmed = text.trim();
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        try { resolve({ ok: true, data: JSON.parse(trimmed) }); return; } catch (e) { /* keep the raw string */ }
      }
      resolve({ ok: true, data: text });
    };
    var fn = globalThis[fnName];
    if (typeof fn !== 'function') { finish(null, new Error('plugin does not export ' + fnName)); return; }
    var args = [];
    try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
    args.push(function (res) { finish(res, null); });
    try {
      var r = fn.apply(null, args);
      if (r && typeof r.then === 'function') r.then(function (v) { finish(v, null); }, function (e) { finish(null, e); });
      else if (r !== undefined) finish(r, null);
    } catch (e) { finish(null, e); }
  });
};
${SKY_SHIM}
`.trim();
}

/** The composed SkyStream script: manifest injection + shim + the plugin. */
async function composeSkyStream(extension: EcosystemExtension, feedId?: string): Promise<string> {
  const script = await skyStreamScript(extension);
  // The manifest travels with the extension: the stored meta (baseUrl and the
  // feed's providerId) over what the archive's plugin.json said.
  const manifest: Record<string, unknown> = {
    baseUrl: extension.baseUrl ?? undefined,
    domains: [],
    ...(feedId ? { providerId: feedId } : {}),
  };
  return `${skystreamPrelude(extension, manifest)}\n${script}`;
}

/** One plugin call: `fn(args…, cb)`, callback or Promise, first settle wins. */
async function callSkyStream(
  extension: EcosystemExtension,
  fnName: string,
  args: unknown[],
  options: { catalog?: boolean } = {},
): Promise<{ ok: boolean; data?: unknown; error?: string; log: string[] }> {
  // Hikari's budgets: 75 s for getHome/search, 90 s for everything else.
  const budget = options.catalog ? 75000 : 90000;
  const feedId = extension.id.includes('|') ? extension.id.split('|')[1] : undefined;
  try {
    const code = await composeSkyStream(extension, feedId);
    return await runEcosystemCall(extension, code, '__skyEntry', [fnName, JSON.stringify(args)], {
      timeoutMs: budget,
      envelope: true,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), log: [] };
  }
}

/** Hikari's install-time validation: all four exports must be functions. */
export async function validateSkyStream(extension: EcosystemExtension): Promise<{ ok: boolean; error?: string }> {
  try {
    const code = await composeSkyStream(extension);
    const probe = await runEcosystemCall(
      extension,
      `${code}\n;globalThis.__skyProbe = function () { return JSON.stringify({ home: typeof getHome, search: typeof search, load: typeof load, streams: typeof loadStreams }); };`,
      '__skyProbe',
      [],
      { timeoutMs: 25000 },
    );
    if (!probe.ok) return { ok: false, error: probe.error };
    let report: Record<string, unknown> = {};
    try {
      report = typeof probe.data === 'string' ? JSON.parse(probe.data) : ((probe.data as Record<string, unknown>) || {});
    } catch {
      return { ok: false, error: 'the plugin probe was unreadable' };
    }
    for (const key of ['home', 'search', 'load', 'streams']) {
      if (report[key] !== 'function') return { ok: false, error: "it doesn't export getHome/search/load/loadStreams" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── data mapping (SkyStreamProvider) ──

const MAX_ITEMS_PER_ROW = 80;
const MAX_EPISODES = 800;
const MAX_STREAMS = 200;
const HOME_TTL_MS = 8 * 60 * 1000;

const asString = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

function mediaTypeOf(raw: string): 'movie' | 'series' {
  const t = raw.toLowerCase();
  if (/^(series|anime|tv|tvseries|tvshow)$/.test(t)) return 'series';
  if (/^(movie|short|film)$/.test(t)) return 'movie';
  return 'movie';
}

/** toItem: `id = url` and a title are required; everything else has defaults. */
function toItem(extension: EcosystemExtension, raw: Record<string, unknown>): MediaItem | null {
  const id = asString(raw.url).trim();
  const title = asString(raw.title).trim() || asString(raw.name).trim();
  if (!id || !title) return null;
  const year = Number(raw.year);
  return {
    id: `${extension.key}:${id}`,
    type: mediaTypeOf(asString(raw.type).trim() || 'movie'),
    title,
    overview: asString(raw.description).trim() || asString(raw.overview).trim(),
    poster: asString(raw.posterUrl).trim() || asString(raw.poster).trim(),
    backdrop: asString(raw.bannerUrl).trim() || asString(raw.backdropUrl).trim() || asString(raw.logoUrl).trim() || undefined,
    year: year > 1800 ? String(Math.floor(year)) : undefined,
    genres: [],
    source: 'skystream',
    providerId: extension.key,
    providerMediaId: id,
    addonType: asString(raw.type).trim() || 'movie',
  };
}

/** Hikari's decodeMagic: the payload formats plugins pack mirrors into. */
export function decodeMagic(url: string): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let value = url;
  if (value.startsWith('magic_m3u8:')) {
    // The payload is already base64 — upstream just prefixes the data URL.
    return { url: `data:application/vnd.apple.mpegurl;base64,${value.slice('magic_m3u8:'.length)}`, headers };
  }
  const proxyMatch = value.match(/^(MAGIC_PROXY_v2|MAGIC_PROXY_v1|MAGIC_PROXY:)(.+)$/);
  if (proxyMatch) {
    try {
      const decoded = atob(proxyMatch[2].trim());
      if (proxyMatch[1] === 'MAGIC_PROXY_v2') {
        const payload = JSON.parse(decoded) as { url?: string; headers?: Record<string, string> };
        if (payload.url && /^https?:\/\//i.test(payload.url)) {
          return { url: payload.url, headers: payload.headers || {} };
        }
        return { url, headers };
      }
      if (/^https?:\/\//i.test(decoded)) return { url: decoded, headers };
    } catch { /* keep as-is */ }
  }
  return { url: value, headers };
}

function readSkyStream(raw: Record<string, unknown>, extensionName: string): StreamResult | null {
  const rawUrl = asString(raw.url).trim();
  if (!rawUrl) return null;
  const decoded = decodeMagic(rawUrl);
  const headers: Record<string, string> = { ...decoded.headers };
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (value == null) continue;
      const text = [...String(value)].filter((ch) => ch.charCodeAt(0) < 128).join('');
      headers[key] = text;
    }
  }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = UA;
  const subtitles: StreamSubtitle[] = [];
  if (Array.isArray(raw.subtitles)) {
    for (const sub of raw.subtitles) {
      if (!sub || typeof sub !== 'object') continue;
      const record = sub as Record<string, unknown>;
      const su = asString(record.url).trim();
      if (!su) continue;
      const lang = asString(record.lang).trim() || asString(record.language).trim() || asString(record.label).trim() || 'sub';
      subtitles.push({ id: su, language: lang, url: su, name: lang });
    }
  }
  const source = asString(raw.source).trim() || asString(raw.name).trim() || 'Auto';
  const quality = asString(raw.quality).trim();
  const url = decoded.url;
  const isTorrent = /^magnet:|^torrent:/i.test(url);
  return {
    id: '',
    url,
    title: quality && !source.includes(quality) ? `${source} ${quality}` : source,
    sourceName: `${extensionName} · SkyStream`,
    sourceType: 'ecosystem',
    quality: quality || undefined,
    size: asString(raw.size).trim() || undefined,
    provider: extensionName,
    headers,
    subtitles: subtitles.length ? subtitles : undefined,
    format: asString(raw.isM3U8) === 'true' || raw.isM3U8 === true || url.startsWith('data:application/vnd.apple.mpegurl') || url.includes('.m3u8')
      ? 'hls'
      : url.includes('.mpd') ? 'dash' : undefined,
    infoHash: isTorrent ? url : undefined,
  };
}

const homeCache = new Map<string, { at: number; rows: Array<{ title: string; items: MediaItem[] }> }>();

/** `getHome`: object of named categories, or one flat array; 8-minute TTL. */
export async function skyStreamHome(extension: EcosystemExtension): Promise<Array<{ title: string; items: MediaItem[] }>> {
  const cached = homeCache.get(extension.key);
  if (cached && Date.now() - cached.at < HOME_TTL_MS) return cached.rows;
  const answer = await callSkyStream(extension, 'getHome', [], { catalog: true });
  const data = answer.ok ? answer.data : null;
  const rows: Array<{ title: string; items: MediaItem[] }> = [];
  const add = (title: string, list: unknown[]) => {
    const items = (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS_PER_ROW)
      .map((entry) => (entry && typeof entry === 'object' ? toItem(extension, entry as Record<string, unknown>) : null))
      .filter((entry): entry is MediaItem => entry !== null);
    if (items.length) rows.push({ title, items });
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [title, list] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(list) && list.length) add(title, list);
    }
  } else if (Array.isArray(data)) {
    add('Home', data);
  }
  if (!rows.length && !answer.ok && answer.error) {
    // A failed home is not cached — the next ask retries the site.
    return rows;
  }
  homeCache.set(extension.key, { at: Date.now(), rows });
  return rows;
}

export async function skyStreamSearch(extension: EcosystemExtension, query: string): Promise<MediaItem[]> {
  if (!query.trim()) return [];
  const answer = await callSkyStream(extension, 'search', [query.trim()], { catalog: true });
  const data = answer.ok ? answer.data : null;
  let list: unknown[] = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.results)) list = record.results;
    else if (Array.isArray(record.items)) list = record.items;
  }
  return list.slice(0, MAX_ITEMS_PER_ROW)
    .map((entry) => (entry && typeof entry === 'object' ? toItem(extension, entry as Record<string, unknown>) : null))
    .filter((entry): entry is MediaItem => entry !== null);
}

export interface SkyStreamEpisode {
  id: string;
  season: number;
  number: number;
  name: string;
  image?: string;
}

/** A loaded title: its episodes, and the movie streams `load` carried along. */
interface SkyLoaded {
  item: MediaItem | null;
  episodes: SkyStreamEpisode[];
  instantStreams: Map<string, StreamResult[]>;
}

async function loadSkyMeta(extension: EcosystemExtension, token: string): Promise<SkyLoaded> {
  const answer = await callSkyStream(extension, 'load', [token], { catalog: true });
  const data = answer.ok ? answer.data : null;
  const instant = new Map<string, StreamResult[]>();
  let item: MediaItem | null = null;
  const episodes: SkyStreamEpisode[] = [];
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    item = toItem(extension, { ...record, url: token });
    const list = Array.isArray(record.episodes) ? record.episodes : [];
    list.slice(0, MAX_EPISODES).forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const episodeRecord = entry as Record<string, unknown>;
      const url = asString(episodeRecord.url).trim();
      if (!url) return;
      const season = Math.max(1, Math.floor(Number(episodeRecord.season) || 1));
      const number = Math.floor(Number(episodeRecord.episode ?? episodeRecord.number)) || index + 1;
      episodes.push({
        id: url,
        season,
        number,
        name: asString(episodeRecord.name).trim() || asString(episodeRecord.title).trim() || `Episode ${number}`,
        image: asString(episodeRecord.image).trim() || asString(episodeRecord.posterUrl).trim() || undefined,
      });
      if (Array.isArray(episodeRecord.streams)) {
        const streams = readStreamList(extension, episodeRecord.streams);
        if (streams.length) instant.set(url, streams);
      }
    });
    // A movie's `load` may carry its streams at the top level.
    if (Array.isArray(record.streams)) {
      const streams = readStreamList(extension, record.streams);
      if (streams.length) instant.set(token, streams);
    }
  }
  return { item, episodes, instantStreams: instant };
}

function readStreamList(extension: EcosystemExtension, list: unknown[]): StreamResult[] {
  const out: StreamResult[] = [];
  for (const entry of (Array.isArray(list) ? list : []).slice(0, MAX_STREAMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const stream = readSkyStream(entry as Record<string, unknown>, extension.name);
    if (stream) out.push({ ...stream, id: `skystream:${extension.key}:${out.length}` });
  }
  return out;
}

/** resolveToken: exact, then season+number, then number, then the item itself. */
function resolveToken(loaded: SkyLoaded, season?: number | null, episode?: number | null): string | null {
  if (!loaded.episodes.length) return null;
  if (season != null && episode != null) {
    const exact = loaded.episodes.find((entry) => entry.season === season && entry.number === episode);
    if (exact) return exact.id;
  }
  if (episode != null) {
    const byNumber = loaded.episodes.find((entry) => entry.number === episode);
    if (byNumber) return byNumber.id;
  }
  return loaded.episodes[0]?.id ?? null;
}

/** One title's playable links: the episode token, or instant streams from `load`. */
export async function skyStreamStreams(
  extension: EcosystemExtension,
  ownId: string,
  season?: number | null,
  episode?: number | null,
): Promise<StreamResult[]> {
  if (!ownId) return [];
  const loaded = await loadSkyMeta(extension, ownId);
  if (loaded.instantStreams.size) {
    const token = resolveToken(loaded, season, episode) ?? ownId;
    const instant = loaded.instantStreams.get(token) ?? [...loaded.instantStreams.values()][0];
    if (instant?.length) return instant;
  }
  const token = resolveToken(loaded, season, episode) ?? ownId;
  const answer = await callSkyStream(extension, 'loadStreams', [token]);
  const data = answer.ok ? answer.data : null;
  let list: unknown[] = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.streams)) list = record.streams;
    else if (Array.isArray(record.sources)) list = record.sources;
  }
  const streams = readStreamList(extension, list);
  // The re-match fallback: strict search by title, then the first episode of
  // whatever the plugin finds, exactly upstream's order.
  if (!streams.length && episode == null) {
    const results = await skyStreamSearch(extension, ownId);
    const match = results.find((entry) => entry.providerMediaId);
    if (match?.providerMediaId) {
      const rematched = await loadSkyMeta(extension, match.providerMediaId);
      const rematchedToken = resolveToken(rematched, season, episode) ?? match.providerMediaId;
      const rematchAnswer = await callSkyStream(extension, 'loadStreams', [rematchedToken]);
      const rematchData = rematchAnswer.ok ? rematchAnswer.data : null;
      if (Array.isArray(rematchData)) return readStreamList(extension, rematchData);
      if (rematchData && typeof rematchData === 'object') {
        const record = rematchData as Record<string, unknown>;
        if (Array.isArray(record.streams)) return readStreamList(extension, record.streams);
        if (Array.isArray(record.sources)) return readStreamList(extension, record.sources);
      }
    }
  }
  return streams;
}

/** Test seam: forget the home cache. */
export function resetSkyStreamCaches(): void {
  homeCache.clear();
}
