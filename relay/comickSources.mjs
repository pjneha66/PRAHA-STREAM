const hosts = new Set(['mangakatana.com', 'www.webtoons.com', 'mangaread.org', 'www.mgeko.cc', 'mgeko.cc']);

export function hostedComicPage(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password
      && hosts.has(url.hostname) && /^\/(?:read|manga|series|chapters|[a-z-]+\/[^/]+\/[^/]+\/)/i.test(url.pathname)) return url;
  } catch { /* Invalid URL. */ }
  return null;
}
