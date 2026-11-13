# PRAHA STREAM — Master Port Backlog (from Nuvio + PlayTorrio V3 deep audits)

Compiled 2026-11-14 from two exhaustive second-pass audits of the reference apps
in the workspace. Legend: **[N]** = found in Nuvio (Kotlin/Compose, `NuvioMobile-cmp-rewrite`),
**[PT]** = found in PlayTorrio V3 (Flutter, `ptv3-main`).
Feasibility: **A** = pure JS/React for us · **B** = needs native/Capacitor-plugin work · **C** = skip.

## Tier 1 — high value, easy (A)

| # | Port | Source | Where in reference | PRAHA today |
|---|------|--------|--------------------|-------------|
| 1 | **Resume with full source context** — persist magnet+trackers, fileIdx, addon, quality, headers with the position so resume re-opens the *identical* stream; dedupe per show; ≥90% = completed; ≥50 sessions cap | PT | `lib/services/continue_watching/continue_watching_service.dart:209-283` | position only |
| 2 | **Search relevance scorer** — exact +10000 / substring / prefix / token-ratio, article stripping | PT | `lib/utils/search/relevance_scorer.dart`, `addon_manager.dart:260-320` | basic |
| 3 | **Stream health checker** — ranged GET probe (8–64KB), dead content-type + video-signature sniffing, 5s timeout; IPTV variant with concurrency 24 | PT | `lib/services/stream/stream_health_checker.dart`, `iptv_network.dart:376-491` | none |
| 4 | **Streaming home sections** — rows appear as each source responds (async generator), not bulk | PT/N | `addon_manager.dart:178-223`, Nuvio `HomeRepository.kt` | bulk |
| 5 | **Catalog in-flight dedup + duplicate-page pagination guard** | N | `features/catalog/CatalogData.kt` | none |
| 6 | **Watched-state machine rules** — 90% completion, 121s debrid-placeholder-clip guard, 1s store threshold | N | `features/watching/domain/WatchingPolicies.kt` | thresholds only |
| 7 | **Global rate-limit coordinator** — 429/Retry-After cooldown with jitter, atomic state | N | `core/network/BackendRateLimit.kt` | none |
| 8 | **EPG now/next snippets** — per-stream cached EPG futures wired into channel rows | PT | `iptv_controller.dart:96-124` | none (EPG models exist) |
| 9 | **M3U multi-playlist manager** — named playlists, add-URL/paste with added/skipped/failed counts, delete | PT | `m3u_store.dart`, `iptv_controller.dart:615-660` | single playlist |
| 10 | **IntroDB extensions** — AniSkip anime segment types (op/ed/mixed-op), community submission, auto-skip-by-type prefs | N | `features/player/skip/*` | IntroDB intro only |
| 11 | **Addon manager UX** — reorder up/down, user-renamed addons, configurable-badge → configure URL | N | `AddonsScreen.kt:151-177` | basic list |
| 12 | **Stremio addon per-feature toggles** — catalog/search/stream checkboxes per addon | PT | `addons_settings_page.dart` | install/enable only |
| 13 | **Updater polish** — stable/beta channels, semantic compare, dismissed-version memory, delayed check | N/PT | `ReleaseSelector.kt`, `app_updater_service.dart` | single channel |
| 14 | **Network condition probe** — no-internet vs servers-unreachable distinction for empty states | N | `core/network/NetworkStatusRepository.kt` | navigator.onLine-ish |
| 15 | **Search history** persisted per profile | N/PT | `SearchHistoryRepository.kt`, `search_page.dart` | ? |
| 16 | **Settings search** — find any setting by keyword | N | `features/settings/SettingsSearch.kt` | none |
| 17 | **IPTV channel/portal favorites** + "live only" filter persisted | PT | `iptv_storage.dart:208-237` | none |
| 18 | **Lyrics LRC parser + synced lyrics** in music | PT | `lib/services/music/*lyrics*` | none |
| 19 | **YouTube rate-limit guard** — cooldown queue with user message (protects Flow/music) | PT | `lib/services/music/*youtube*` | none |
| 20 | **PTT torrent title parser** (quality/resolution/S/E) for auto file selection in WebTorrent | PT | `lib/utils/torrent/parse_torrent_title.dart` | basic |
| 21 | **Debrid extras** — file-selector heuristics, local availability cache, presentation/badges | N/PT | `DebridFileSelectors.kt`, `LocalDebridAvailabilityService.kt`, `debrid_media_matcher.dart` | basic |
| 22 | **Stream badge filter packs** — user-importable regex rules for stream labels | N | `StreamBadgeRules.kt` | none |
| 23 | **Binge-group link cache** — reuse last debrid/stream link keyed by content/filename/infoHash | N | `StreamLinkCacheRepository.kt`, `BingeGroupCacheRepository.kt` | none |
| 24 | **Deep-link scheme** — praha://meta/imdb/tmdb, stremio:// addon install conversion | N | `core/deeplink/AppUrlBridge.kt` | simple |
| 25 | **Per-profile storage-key prefixing** + profile PIN (crypto+cache) | N | `core/storage/ProfileScopedKey.kt`, `ProfilePinCrypto/*` | plain keys |

## Tier 2 — bigger UI/logic builds (A)

| # | Port | Source | Reference |
|---|------|--------|-----------|
| 26 | **Home-row manager** — reorder/pin/rename/toggle rows, hero source per row, hide-unreleased | N | `HomeCatalogSettingsRepository.kt` |
| 27 | **Hero upgrades** — TMDB logo art with fallback, auto-rotate timer, parallax, hero meta cache | N/PT | `HomeHeroSection.kt`, `home_page.dart:608-916` |
| 28 | **Continue-watching prefs** — dismissed keys, card styles, blur unaired, sort, launch resume prompt | N | `ContinueWatchingPreferencesRepository.kt`, `ResumePromptRepository.kt` |
| 29 | **CW enrichment cache** — cached next-up snapshots so home paints instantly | N | `ContinueWatchingEnrichmentCache.kt` |
| 30 | **"Similar to what you're watching"** + BestSimilar scraper rows | PT | `bestsimilar_scraper.dart`, `home_page.dart:142-233` |
| 31 | **Details-page section manager** — reorder/hide sections, episode card style, season grid/list | N | `MetaScreenSettingsRepository.kt` |
| 32 | **Per-episode IMDb ratings** with visibility toggle | N | `ImdbEpisodeRatingsRepository.kt` |
| 33 | **Watch screen (pre-player) upgrades** — size-filter dropdown, addon filter, copy-magnet, shimmer | PT | `watch_screen.dart:955-1460` |
| 34 | **In-player Sources panel as error recovery** — targeted re-scrape, per-episode cache, error banner | PT | `player_sources_panel.dart`, `player_screen.dart:434-455` |
| 35 | **Next-episode preload pipeline** — fetch sources 30s before the card, binge-group continuity, countdown overlay | N | `PlayerNextEpisodeAutoPlay.kt` |
| 36 | **Manga reader modes** — webtoon/paged toggle, floating glass control bar, next-chapter deck, reader settings | PT | `manga_reader_page.dart` (1152 ln) |
| 37 | **Audiobook chapter bookmarks + waveform seekbar + progress service** | PT | `audiobook_player_screen.dart` |
| 38 | **IPTV appearance settings** — hero, card density, HD badge, default tab, browser layout | PT | `iptv_settings.dart` |
| 39 | **Ambient background / custom background / theme palettes** — CSS/canvas ports | PT/N | `animated_ambient_background.dart`, `custom_background_service.dart`, `ThemeColors.kt` |
| 40 | **Configurable dock/nav** — per-item enable/order, floating styles | PT/N | `dock_settings.dart`, `NavigationBar.kt` |
| 41 | **Categorized settings tree** (You/Look/Watch/Services/System) | N | `SettingsScreen.kt`, `SettingsModels.kt` |
| 42 | **Collections/folders** on the watchlist with JSON import/export | N | `features/collection/*` |
| 43 | **Watched badge bulk resolver** — batch grid lookups | N | `WatchedBadgeBulkResolver.kt` |
| 44 | **Episode watched action sheet** (bulk mark/unmark) | N | `EpisodeWatchedActionSheet.kt` |
| 45 | **Popup trailer player** on details + logo-or-title rendering | N/PT | `TrailerPlayerPopup.kt`, `details_page.dart:772` |
| 46 | **Cache API disk cache for addon/catalog responses** + response size caps | N | `AddonPlatform.android.kt` (50MB OkHttp cache) |
| 47 | **Person detail pages** (cast/crew browse) | N | `PersonDetailScreen.kt` |
| 48 | **Genre browse across addons** page with chips + skip pagination | PT | `catalog_page.dart`, `addon_manager.dart:321+` |
| 49 | **Portal discovery via paste sites** + PasteSh AES-CBC decryptor (WebCrypto) | PT | `iptv_network.dart:523-705`, `pastesh_decryptor.dart` |
| 50 | **Hardcoded-channel keyword scan** — 84-channel curated table + portal scraping + hit caching | PT | `hardcoded_channels.dart`, `iptv_controller.dart:674-966` |

## Tier 3 — needs native/Capacitor-plugin work (B)

| # | Port | Source | Note |
|---|------|--------|------|
| 51 | **Downloads manager** — queue, notifications with pause/cancel, HLS engine with AES-128 decrypt, wakelock | N/PT | ~1,600 ln native each; Capacitor downloader plugin |
| 52 | **Episode-release notifications** — follows library shows, worker + channel | N | Capacitor LocalNotifications + background task |
| 53 | **Discord Rich Presence** | PT | native IPC plugin |
| 54 | **MediaSession foreground service / audio-focus hardening** | N | plugin |
| 55 | **In-app APK updater** — download + install intent (we have gh-release check already) | N/PT | native intent |
| 56 | **External player hand-off** — VLC/MX intents with progress read-back + subtitle/skip forwarding | N/PT | easiest B item |
| 57 | **Native P2P engine with VOD disk cache + profiles** | N | we have TorrServer/WebTorrent; port only settings/consent UX |
| 58 | **Shared-element poster→detail zoom** (View Transitions API approximation) | N | mostly CSS |

## Skip (C) — with reasons
- Tracking triple-integration (Trakt+Simkl+MDBList, ~100 files N) → port only the provider-abstraction shape if wanted
- Jellyfin/Emby servers (N) — orthogonal to our IPTV/torrent focus
- Watch party (N, 4,900 ln, Supabase-dependent) — only after a cloud-sync backbone exists
- Membership gating, glass shaders/jelly springs/ash disintegration (N) — business/cosmetic/native-only
- TTS audiobook generation, Qobuz/Eclipse, h-anime/Arabic anime extractors (PT) — fragile third-party deps
- 17-site embed scraper fleet (PT) — port selectively, high maintenance
- MOBI/FB2 parsers, desktop window service (PT) — niche/platform mismatch
- Plugin JS sandbox (N) — we ARE the JS runtime; adopt concepts only (10-concurrent cap, 60s timeout)

## Where PRAHA is already ahead (nothing to port)
IPTV+zap bar, comics/manga, books, audiobooks, music, YouTube Flow, AdGuard DNS,
backup export, real multi-profiles, WebTorrent in-app P2P.

## Already ported in v2.6.3/v2.6.4
Engine failover + position preservation, recovery toast, accumulating double-tap seek,
duration-scaled scrub, hold-to-speed, frozen-live watchdog, skip-segment markers,
skeletons, universal search, continue shelf (basic), zap bar, jump-to-live, comic scrubber.
