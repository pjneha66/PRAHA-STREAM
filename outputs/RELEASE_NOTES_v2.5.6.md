# PRAHA STREAM v2.5.6

Installs over v2.5.5 (same signing key). versionCode 12.

## CRITICAL security fix: origin-gated native bridge (audit C-01 — closed)

The entire actuator surface of the native bridge used to be reachable from
EVERY frame via `addJavascriptInterface` — a sandboxed embed iframe with an
opaque origin could call the CORS-bypass HTTP client, the external-player
intents, or the APK installer directly, and native code had no way to tell
which frame was calling.

v2.5.6 splits the bridge in two:

- `PrahaReadOnlyBridge` (sync, injected via `addJavascriptInterface`) now
  exposes only read-only accessors: TV detection, proxy port, proxy URL
  builder, app version, VLC track/delay queries. No network, no intents.
- Everything actuating — native HTTP, external players, APK install, share,
  subtitle picker, VLC playback control, immersive mode, PiP, exit — moved
  behind `WebViewCompat.addWebMessageListener` (`prahaNativeBridge`),
  restricted to the app's own main frame (`https://localhost`), main-frame
  messages only. Sandboxed iframes never receive the object.
- JS side rewritten to a promise-based RPC with request-id correlation and
  timeouts; void player controls are fire-and-forget, boolean sinks are async.
- WebViews older than 116 (no WebMessageListener) fall back to the previous
  full sync bridge, so nothing breaks on ancient devices.

## Stremio addons + Nuvio plugins: reliability fixes

- `nativeFetchText` now tries the hardened native `httpRequest` FIRST instead
  of CapacitorHttp, which mangles JSON re-parsing and drops custom headers on
  redirects — the most likely cause of addons "not working properly".
- Nuvio scraper worker: interim `postMessage` noise from scraper code no
  longer terminates the run early; proxy fetches get a 20s per-request
  timeout instead of hanging until the 30s budget.

## TMDB key no longer enters the scraper worker (audit H-open)

Scraper code that reads `TMDB_API_KEY` now receives a placeholder; requests
carrying it are rewritten on the main thread, which is the only realm holding
the real key. Third-party Nuvio scrapers keep working.

## Other fixes

- VLC PiP: the activity auto-pause no longer fires while in
  picture-in-picture, so PiP playback keeps running.
- Cache caps: flow detail/list (120), intro segments (300), raw subtitles
  (40), TMDB seasons (150) now evict oldest entries — long sessions no longer
  grow caches without limit.
- IPTV: portal metadata probes try HTTPS first and pin the upgraded transport
  per portal, with plain-HTTP fallback so legacy portals keep playing.
  Stream URLs are intentionally left untouched (availability over purity).
- AnimeView grid + AnimeDiscussion comments: stale-response races fixed with
  request-sequence guards (slow old fetches can no longer overwrite newer
  results).

## Verification

- `npm run typecheck` exit 0
- `npm test` 18/18 files, 143/143 tests
- `vite build` OK; `./gradlew assembleRelease` BUILD SUCCESSFUL
- APK signed (v2/v3 scheme), cert `CN=PRAHA STREAM`

## Known open issues

- Protected embed iframes remain sandboxed (no `allow-same-origin`/`allow-popups`);
  with the bridge now origin-gated this is hardening, not exposure.
- IPTV stream URLs stay plain HTTP where providers never shipped TLS.
