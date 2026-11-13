# PRAHA STREAM v2.6.0

Installs over v2.5.6 (same signing key). versionCode 13.

## New: Books tab

- Search and read from Open Library and archive.org: covers grid, collections
  switcher (folkscanomy comics & manga, sci-fi/fantasy, fiction, computers,
  science, history, game art), pagination.
- In-app Read Online (OMLE) viewer using the archive.org BookReader embed,
  plus pdf/epub/cbz download lists with sizes.
- Open Library subject chips (Classics, Manga, Comics, ...) and quick links.
- Anna's Archive and OceanofPDF are linked as external sites only — PRAHA does
  not integrate shadow-library search or downloads.

## Manga & Comics

- New source: Internet Archive folkscanomy — comics & manga. Every subject
  filter from the archive.org comics browse is OR-combined (43,369 items
  verified): comic, manga, Marvel/DC/Archie/Hindi/golden-age/horror comics,
  graphic novels, webcomics and more.
- In-app Read Online for archive items; pdf/epub/cbz download list.
- Fixed the detail modal sliding under the bottom navigation: the page
  animation keyframe kept a transform alive, creating a stacking context that
  trapped fixed modals below the mobile nav. Root-caused and fixed; body
  scroll is now locked behind modals, and on mobile the detail modal is a
  bottom sheet with safe-area clearance.

## Live TV

- New Sources tab. MAIN sources first: iptv-org (country picker from the
  official API + 27 categories + all-channels) and StepDaddyLiveHD
  (self-hosted server URL, persisted). Community sources: doms9, Aria,
  Aria+ extended, ibert mirrors, IPTVCat link. EPG guide URLs (iptv-epg.org,
  mjh.nz) with copy buttons. Xtream portal scraping is unchanged.
- Portal scraping root-caused and fixed: portal logins were CORS-blocked in
  the app WebView (plain fetch). Now routed through the native client;
  verification is parallel (5 workers) with live progress; Reddit portal
  scrape goes direct on Android.

## Music

- Full-length playback: tracks resolve through the YouTube pipeline
  (YouTube Music search -> Piped/Invidious audio streams) instead of jumping
  straight to 30-second iTunes previews. The player bar shows an honest
  FULL / 30s PREVIEW badge; preview is the fallback when mirrors are down.

## Audiobooks

- 10th source: Internet Archive audio_bookspoetry collection (75,655 free
  public-domain readings). Chapters resolve from item metadata; one-tap
  browse chips (Poetry, Shakespeare, Poe, Dickinson, Rumi, Whitman...).

## Carried from the v2.5.6 line (already shipped)

- Origin-gated native bridge (C-01 closed), addon reliability fixes
  (native HTTP before CapacitorHttp), TMDB key isolation from scraper
  workers, IPTV HTTPS-preferred portal probing, VLC PiP auto-pause fix,
  bounded caches, AnimeView/AnimeDiscussion race guards.

## Verification

- typecheck exit 0; 143/143 tests; vite build + gradle assembleRelease OK.
- APK signed (v2/v3 scheme), cert CN=PRAHA STREAM.
