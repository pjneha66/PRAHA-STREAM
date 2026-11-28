// The embed-host allowlist behind the relay's `/eco-page` route.
//
// The extension ecosystems' extractor helpers (AnymeX's `doodExtractor`,
// `streamWishExtractor`, `filemoonExtractor` …) resolve a video host's embed
// page into direct streams. Those pages are exactly where the CORS and
// Cloudflare walls live, which is what the relay exists to cross — but the
// relay is not an open proxy: the route answers only hosts that match the
// same families the reference app's extractor stack covers, so an extension
// (or anyone holding the relay URL) cannot point it at an arbitrary target.

const EMBED_HOST_PATTERNS = [
  // sibnet
  /(^|\.)sibnet\.ru$/i,
  // okru / odnoklassniki
  /(^|\.)ok\.ru$/i,
  /(^|\.)odnoklassniki\.ru$/i,
  // voe and its rotating mirrors
  /(^|\.)voe[\w-]*\./i,
  // vidbom / vidmoly family
  /(^|\.)(vidbom|vidmoly|vidmoly\.me|vidloxx|videzz)\./i,
  // streamlare
  /(^|\.)streamlare\./i,
  // sendvid
  /(^|\.)sendvid\.com$/i,
  // yourupload
  /(^|\.)yourupload\.com$/i,
  // gogo/playtaku family
  /(^|\.)(goload|gogocdn|playtaku|streamhd|giligili|vidstreaming|gogo)\./i,
  // dood family (dood.watch/.la/.to/.stream/.yt, d000d, ds2play, doodips…)
  /(^|\.)(dood|d000d|ds2play|dsvplay|doodcloud|doodips)[\w.-]*\./i,
  // streamtape family
  /(^|\.)(streamtape|strcloud|streamta|tapewithadblock|streamad)[\w.-]*\./i,
  // mp4upload
  /(^|\.)mp4upload\.com$/i,
  // streamwish family
  /(^|\.)(streamwish|wishembed|awish|swish|wishfast|kilikhk|dwish)[\w.-]*\./i,
  // filemoon family
  /(^|\.)(filemoon|moonplayer|moonfile)[\w.-]*\./i,
];

/** True when `raw` is an http(s) URL on one of the extractor families' hosts. */
export function isEcoEmbedUrl(raw) {
  if (typeof raw !== 'string') return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return EMBED_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname));
}
