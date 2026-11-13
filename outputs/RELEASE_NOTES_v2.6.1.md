# PRAHA STREAM v2.6.1

Installs over v2.6.0 (same signing key). versionCode 14.

## Fixes

- ANR ("PRAHA STREAM isn't responding"): the Channels Hub rendered every
  channel of huge playlists (iptv-org "All channels" is 10,000+) in one pass.
  Rendering is now chunked — 250 cards plus a "Show more" button.
- Channels Hub is source-driven: the old hardcoded channel grid and its
  scanner modal are removed. Loading a source fills the hub with group pills,
  search, and chunked rendering. No source loaded → a prompt to open Sources.
- M3U Playlists: every public source (doms9, Aria, Aria+, ibert mirrors) is a
  one-tap preset pill alongside the classic Sports/News/Movies presets.
- Details pages: a Show Details table (Status, Release info, Runtime,
  Certification, Origin country, Original language) and Networks chips now
  render for every source; Cast and More-like-this enrich automatically.
- Book thumbnails: cover fallback chain (covers.openlibrary.org → wsrv.nl
  proxy → archive.org scan image → placeholder).
- Music: full-stream resolution hardened — YouTube Music search, mirror-tier
  search fallback, then detail from any tier before the 30s preview applies.
  The FULL / 30s PREVIEW badge stays honest.
- Xtream portals: scraper now races three subreddits through direct and proxy
  routes. Honest status when reddit blocks scraping (it now 403s every
  automated route we tested) — your own portal credentials still work via
  Add Xtream Portal.

## New

- Settings → Private DNS: "Use AdGuard DNS" copies dns.adguard-dns.com and
  opens Android's Private DNS screen (Android only allows the system Settings
  app to set Private DNS — this is the maximum any app can do).

## Verification

- typecheck exit 0; 143/143 tests; vite build + gradle assembleRelease OK.
- APK signed (v2/v3 scheme), cert CN=PRAHA STREAM.
