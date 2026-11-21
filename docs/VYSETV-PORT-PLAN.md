# VyseTV → PRAHA STREAM — Master Port Plan

Source audited: `https://gitlab.com/ayman707-ux/vysetv` (cloned to `/tmp/vysetv_probe`, depth 1)
Audit date: 2026-11-20

---

## 0. The one thing to understand first

**VyseTV is Flutter/Dart. PRAHA STREAM is React + TypeScript + Capacitor.**

| | VyseTV | PRAHA STREAM |
|---|---|---|
| Language | Dart (159,125 LOC) + Kotlin (25,004 LOC) | TypeScript + TSX (~72k LOC incl. CSS) |
| UI | Flutter widgets | React 19 components |
| Player | native **mpv** surface behind the UI | LibVLC (Java) + hls.js / dash.js / mpegts.js |
| Platforms | Windows, Android, macOS, Linux, iOS | Android, Android TV, Web/PWA |
| Server | PocketBase + LiveKit + relay | none (local-first) |
| Licence | **GPL-3.0** | **no LICENSE file** |

So we **cannot copy code**. Every item below is a *feature port*: we read their logic and
re-implement it in React/TS, or in our Capacitor Java bridge where it needs native access.

Feasibility tags used throughout:

- **A** — pure TS/React, drops straight into `services/` or `components/`
- **B** — needs Java/Kotlin work in `android/app/src/main/java/com/praha/stream/`
- **C** — not reachable in our stack (mpv-only, desktop-only, or GLSL shaders)

### Licence warning (read before copying anything)

VyseTV is GPL-3.0. PRAHA STREAM currently ships **no LICENSE file**, which means
"all rights reserved" by default. Porting GPL-3.0 *code* into a non-GPL project is a
licence violation. Two safe paths:

1. **Clean-room port** — read their behaviour, write our own implementation. That is what this
   plan assumes. Legal, but must be deliberate.
2. **Adopt GPL-3.0** for PRAHA — then you may port code directly and keep the copyright
   notices. Adds a source-availability obligation to anyone you distribute to.

Decide this before Tier 1 starts, not after.

---

## 1. What VyseTV actually has (measured)

```
lib/                        159,125 LOC   (Dart)
  media_servers/  49,185  203 files   Plex + Jellyfin + Emby engine
  screens/        54,179   70 files   every page
  data/           26,054   85 files   sources, playback, subs, party, trackers
  mpv/             8,953   31 files   Dart side of the player
  services/        8,131   18 files   IPTV, music, manga, audiobooks
  widgets/         5,032   15 files
  dpad/            4,818   21 files   TV remote navigation
  core/            1,492   15 files   theme, nav, platform detection
  models/            986    6 files

android/           25,004 LOC   (Kotlin)
  exoplayer/      12,878   34 files
  mpv/             5,273   13 files
  shared/          1,343   13 files

test/dpad/         ~10,000 LOC  (navigation regression bed)
assets/shaders/      3.3 MB    Anime4K + ArtCNN + NVScaler GLSL
assets/fonts/       16 MB      Go Noto (subtitle font, 100+ scripts)
```

Biggest single files (these are the ones worth reading first):

| File | LOC | What it is |
|---|---|---|
| `screens/player/player_page.dart` | 5,257 | the whole player host |
| `media_servers/services/plex_client.dart` | 5,143 | Plex API client |
| `screens/profile/profile_page.dart` | 3,108 | profile + settings hub |
| `data/sources/film_sources/scrapers.dart` | 3,091 | built-in film scrapers |
| `screens/player/player_menus.dart` | 1,998 | every player panel |
| `screens/live_tv/portal_browser_page.dart` | 1,990 | IPTV portal browser |
| `services/iptv/hardcoded_channels.dart` | 1,620 | 84 curated channels |

---

## 2. What PRAHA already has (so we don't rebuild it)

Already covered — **extend, do not port**:

- TMDB catalog, home rows, discover, search, watchlist, continue watching, profiles
- Live TV: M3U + Xtream portals, sports matches, virtualised channel list, zap bar
- Stremio addon catalogs/streams, Nuvio scraper repositories, source ranking
- Anime (Sanka), comics (Comick), books (Open Library / folkscanomy), audiobooks (Bookracy)
- Music (YouTube), Flow tab, lyrics service stub
- Player: HLS/DASH/MPEG-TS/progressive, buffering recovery, retries, subtitles, audio tracks
- External player hand-off, PiP, immersive fullscreen, D-pad basics
- Debrid (basic), WebTorrent P2P, stream health, search relevance (basic)
- Backup/restore, auto-update from GitHub Releases, profile PIN
- `docs/PORT-BACKLOG.md` already lists 58 Nuvio/PlayTorrio items — several overlap this plan.
  Where they overlap, **merge into that backlog rather than duplicating**.

---

## 3. THE PORT LIST

Nine tiers, ordered by value-per-effort. Every item names the VyseTV source file so we can
read the logic when we build it.

### Tier 0 — Foundations (do first, everything else sits on it)

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 0.1 | **8-theme system** — Vyse / Crimson / Abyss / Amber / Bloom / Canopy / Glacier / Violet, each with an accent colour + optional ambient glow layer over every page | `data/app_settings.dart`, `core/theme.dart` | A |
| 0.2 | **Configurable navbar** — stable string ids per section, saved order + hidden list, unknown ids ignored, new sections slot in after their default neighbour | `core/nav_sections.dart` | A |
| 0.3 | **PlatformDetector** — TV vs phone vs desktop, plus a device performance tier that gates heavy effects | `core/platform/platform_detector.dart`, `device_performance.dart` | A |
| 0.4 | **Design tokens** — the exact Vyse palette (`#07080F` bg, `#0E1020` surface, `#FFA53A` accent, `#7A5CFF` violet) and Inter as the type face | `core/theme.dart` | A |
| 0.5 | **Setting<T> listenable prefs** — typed, namespaced, change-notifying preference objects (`look.theme`, `play.seek`, `subs.size`…) | `data/app_settings.dart` | A |
| 0.6 | **Lean motion switch** — a global "reduce animation" tier separate from OS accessibility | `core/lean.dart` | A |

**Why first:** every other tier writes into these. Doing it later means rewriting settings twice.

---

### Tier 1 — The player (VyseTV's crown jewel, ~40% of its value)

This is where VyseTV is genuinely ahead of us. Their player is 5,257 lines of host plus
1,998 lines of panels, and the panel *design* is the thing to copy.

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 1.1 | **Full panel system** — slide-in panels with `MenuSegments` tabs, `MenuRow` rows, `MenuStepper`, `MenuChoice`, `MenuToggle`, `MenuCaption`, `MenuTag`, source dot indicators, live bars | `screens/player/player_menus.dart` | A |
| 1.2 | **Sources panel** — ranked list with per-source dots, "try again" re-scrape, addon filter, quality/seeders line, copy magnet | `screens/player/sources_page.dart` (1,402) | A |
| 1.3 | **Subtitle styling, full set** — size, colour, box colour + opacity, bold, italic, outline width + colour, shadow + colour, blur, letter spacing, top/bottom, lift %, "never in black bars", ASS mode (scale / force / strip) | `data/subtitles/subtitle_style.dart` (276) | A |
| 1.4 | **Subtitle sync panel** — ±ms nudge with live preview, per-track, no remount | `screens/player/subtitle_sync_panel.dart` (624) | A |
| 1.5 | **Windows code page decoding** — CP1250/51/52/53/54/55/56/57/874 upper-half tables, so old SRT files stop showing `Ã©` | `data/subtitles/codepages.dart` | A |
| 1.6 | **Skip segments** — intro / recap / preview / credits from TheIntroDB, each independently toggleable, "runs to end" handling | `data/playback/intro_db.dart` | A |
| 1.7 | **Audio controls** — lip-sync delay ±5,000 ms, passthrough toggle, channel limit (original / 5.1 / stereo), volume levelling | `data/app_settings.dart` §device | B |
| 1.8 | **Picture controls** — zoom %, shape (fit / fill / original / stretch), ambient light, brightness, sleep timer | `screens/player/picture_shape.dart` | A |
| 1.9 | **Episode list inside the player** — season/episode deck, watched state, jump | `screens/player/player_episodes.dart` (754) | A |
| 1.10 | **Next-episode preload** — fetch sources ~30 s before the card, countdown overlay, binge-group continuity | `screens/player/player_page.dart` | A |
| 1.11 | **Autoplay policy** — best-source autoplay, source order, "try the rest" fallback chain | `data/app_settings.dart` §play | A |
| 1.12 | **Binge-group link cache** — reuse the last working debrid/stream link keyed by content + filename + infoHash | `screens/player/player_page.dart` | A |
| 1.13 | **Recovery UX** — stalled-buffer watchdog, decode-hang policy, resume-stall policy, visible error banner with "switch source" | `data/playback/*`, Kotlin `exoplayer/*Policy.kt` | A/B |
| 1.14 | **Mini player** — keeps video going while browsing, one stop in the focus order | `screens/player/player_page.dart` §MiniPlayer | A |
| 1.15 | **Sleep timer** — 15/30/45/60/90/end-of-video | `screens/player/player_page.dart` §_setSleep | A |
| 1.16 | **External player hand-off with progress read-back** | `mpv/extras/external_player.dart` | B |
| 1.17 | **Audio focus manager** — music pauses for film, film pauses for music, one thing plays at a time | Kotlin `shared/AudioFocusManager.kt` | B |

**C (skip):** Anime4K / ArtCNN / NVScaler shaders. They are mpv GLSL passes
(`assets/shaders/*.glsl`, 3.3 MB). Nothing in a Capacitor WebView or LibVLC can run them.
Also skip HDR output and TrueHD/DTS-HD bitstream passthrough — those are mpv surface features,
not achievable through our player path.

---

### Tier 2 — Sources & streams

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 2.1 | **Debrid, all five providers** — Real-Debrid, AllDebrid, Premiumize, Debrid-Link, TorBox, with a shared link service interface | `data/sources/debrid/providers/*` | A |
| 2.2 | **Debrid media matcher** — scores files inside a torrent against a requested season/episode; sure-score / junk-score thresholds | `data/sources/debrid/utils/debrid_media_matcher.dart` | A |
| 2.3 | **Torrent title parser** — year, resolution, source, codec, HDR, audio, group, extended/theatrical/uncut/open-matte, season/episode ranges | `data/sources/debrid/utils/parse_torrent_title.dart` | A |
| 2.4 | **Torrent file picker** — pick the right file from a multi-file torrent by name/folder/range/episode-title scoring; "ask the user" fallback | `data/sources/torrent_file_pick.dart`, `torrent_file_ask.dart` | A |
| 2.5 | **Knaben torrent search** — built-in index so a title resolves without an addon | `data/sources/knaben.dart` | A |
| 2.6 | **P2P consent dialog** — explains that your address is visible to peers, once, before the first torrent | `widgets/dialogs/p2p_consent.dart` | A |
| 2.7 | **Debrid consent dialog** — warns the host's account is used when a room plays their link | `widgets/dialogs/debrid_consent.dart` | A |
| 2.8 | **Stream proxy relay** — a small `127.0.0.1` relay that injects headers some streams require | `data/playback/stream_proxy.dart` (522) | A/B |
| 2.9 | **Blocked-DNS rescue** — when local DNS returns a dead address, re-resolve over DNS-over-HTTPS and connect anyway | `data/net.dart` | A |
| 2.10 | **Source badge engine** — importable regex template (djgenesis `gold_badges`), grouped and exclusive-match rules, image or text chips | `data/sources/badges.dart` | A |
| 2.11 | **Addon manager, full** — per-addon feature toggles (catalog / search / stream / subtitle), reorder, rename, "configure" URL, disable | `data/sources/addons.dart` (808) | A |
| 2.12 | **Paste-anything search** — a direct URL, an HLS playlist or a magnet in the search box plays | `screens/search/open_link.dart` | A |
| 2.13 | **Source settings** — order and off-list, applied before any network call | `data/sources/film_sources/source_settings.dart` | A |
| 2.14 | **Built-in film scrapers** — 3,091 lines across many sites | `data/sources/film_sources/scrapers.dart` | A (selective) |

**Note on 2.14:** porting all of it is high-maintenance. Take 3–5 that survive, not 30.
`docs/PORT-BACKLOG.md` already flags the embed-scraper fleet as "port selectively".

---

### Tier 3 — Live TV (PRAHA is strong here; these are the gaps)

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 3.1 | **Portal browser with a player pane** — categories on one side, live preview on the other, per-portal | `screens/live_tv/portal_browser_page.dart` (1,990) | A |
| 3.2 | **Match finder** — for a fixture, read each candidate channel's EPG around kick-off and rank which feed actually has the game | `data/live_tv/match_finder.dart` | A |
| 3.3 | **Sports schedule** — ESPN public scoreboard, fixtures + live scores | `data/live_tv/sports_schedule.dart` (280) | A |
| 3.4 | **Favourites** — per portal (same channel on two portals = two favourites) and per channel | `data/live_tv/live_favorites.dart` | A |
| 3.5 | **EPG now/next** — per-stream cached EPG futures wired into channel rows | `data/live_tv/live_guide.dart` | A |
| 3.6 | **M3U multi-playlist manager** — named playlists, add URL or paste, returns `{added, skipped, failed}`, delete | `services/iptv/m3u_store.dart`, `m3u_parser.dart` | A |
| 3.7 | **Hardcoded channel scan** — 84 curated channels, keyword match against stream names, per-portal hit cache | `services/iptv/hardcoded_channels.dart` (1,620) | A |
| 3.8 | **Paste-site portal discovery + PasteSh decryptor** — find portals from paste sites, AES-CBC decrypt the blobs | `services/iptv/iptv_network.dart`, `pastesh_decryptor.dart` | A |
| 3.9 | **Live TV appearance** — hero style, card density, HD badge, default tab, browser layout | `services/iptv/iptv_settings.dart` | A |
| 3.10 | **Portal categories + groups cache** — Xtream and M3U group trees, cached per portal | `services/iptv/iptv_controller.dart` (1,242) | A |

---

### Tier 4 — Media servers (the single biggest win, 49,185 LOC)

PRAHA has `JellyfinHome.tsx` and `JellyfinSettings.tsx`. VyseTV has a **complete**
Plex + Jellyfin + Emby engine with a shared media model. This is 203 files.

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 4.1 | **Shared media model** — `MediaItem`, `MediaLibrary`, `MediaStream`, `MediaPart`, `MediaVersion`, `MediaPerson`, `MediaRole`, `MediaSort`, `MediaFilter`, `LibraryQuery` | `media_servers/media/*` | A |
| 4.2 | **Plex client, full** — auth (PIN + token), home users, browse, collections, playlists, play queues, Live TV, metadata edit, lyrics | `media_servers/services/plex_client.dart` + `parts/*` | A |
| 4.3 | **Jellyfin client, full** — auth, browse, collections, playlists, music, Live TV + DVR, watch state, metadata edit, file info, images/downloads | `media_servers/services/jellyfin_client/parts/*` | A |
| 4.4 | **Emby** — via the Jellyfin client shape | `media_servers/media_servers.dart` | A |
| 4.5 | **Multi-server manager** — one list of connections, active-client scope, per-server failover | `media_servers/services/multi_server_manager.dart` (1,731) | A |
| 4.6 | **Library event sockets** — WebSocket for Plex + Jellyfin, live library refresh | `media_servers/services/library_events/*` | A |
| 4.7 | **LAN discovery** — UDP broadcast + happy-eyeballs racing to find a server on the network | `jellyfin_lan_discovery_service.dart`, `utils/happy_eyeballs.dart` | A/B |
| 4.8 | **Playback reporting** — scrobble start/progress/stop back to the server, session ids, device identity | `services/playback_report_session.dart`, `playback_report.dart` | A |
| 4.9 | **Track selection service** — audio/subtitle preference resolution per user + per server | `services/track_selection_service.dart` (1,303) | A |
| 4.10 | **Trickplay / BIF thumbnails** — scrub previews from the server | `services/jellyfin_trickplay_service.dart`, `bif_thumbnail_service.dart` | A |
| 4.11 | **Server sign-in UX** — connect, sign in, pick a user, per-server item pages | `screens/servers/*` (3,600+) | A |
| 4.12 | **Watch-state policy** — choose whether the server or VyseTV marks things watched | `media_servers/watched_rule.dart` | A |

**This tier alone roughly doubles PRAHA's catalogue surface.** If only one tier gets funded,
make it this one.

---

### Tier 5 — Catalog, search & browsing UX

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 5.1 | **Search relevance scorer** — exact 10,000 / substring 5,000 / prefix 3,000 / token-ratio, with "the/a/an" stripping | `utils/search/relevance_scorer.dart` | A |
| 5.2 | **Person pages** — full cast/crew browse with their filmography | `screens/details/person_page.dart` (1,020) | A |
| 5.3 | **Details page, full** — cast, seasons, episodes, similar, trailer popup, logo-or-title rendering | `screens/details/details_page.dart` (1,178) | A |
| 5.4 | **Episode explorer** — season grid/list toggle, per-episode stills, watched state, bulk mark/unmark | `screens/details/episode_explorer.dart` (978) | A |
| 5.5 | **Continue-watching enrichment** — cached next-up snapshots so home paints instantly; dismissed keys; card styles | `screens/home/continue_watching.dart` | A |
| 5.6 | **Discover page** — poster wall with genre / year / rating / language filters and local filtering | `screens/discover/discover_page.dart` (1,276) | A |
| 5.7 | **My List** — grid/list toggle, sort by added/title/year/rating, bulk actions | `screens/library/my_list_page.dart` (1,246) | A |
| 5.8 | **History page** — what you watched and where you stopped | `screens/library/history_page.dart` (572) | A |
| 5.9 | **Profile page** — name, avatar, bio, banner, status line, avatar picker | `screens/profile/profile_page.dart` (3,108), `avatar_picker.dart` | A |
| 5.10 | **Phone-as-keyboard** — a TV shows a QR code, you type the URL on your phone | `screens/profile/phone_edit_dialog.dart`, `data/phone_edit/*` | A |
| 5.11 | **Anime section** — AniList browse with season/format/genre filters, own details pages | `screens/anime/anime_page.dart` (1,358), `data/anime/anilist.dart` (816) | A |
| 5.12 | **Anime source rules** — which source suits which anime, audio preference | `data/trackers/anime_rules.dart`, `data/anime/anime_sources.dart` (571) | A |
| 5.13 | **Hero carousel** — auto-rotate, parallax, TMDB logo art with title fallback | `widgets/hero_carousel.dart` | A |
| 5.14 | **Shell chrome** — floating rail, phone bottom bar, now-playing bar placement rules | `screens/shell/shell.dart` (1,307) | A |

---

### Tier 6 — Music, manga, audiobooks, downloads

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 6.1 | **YouTube Music browse** — search, home, artists, albums, playlists, charts, moods, radio | `data/music/yt_music.dart` (864) | A |
| 6.2 | **YouTube audio extractor** — the full resolver (997 lines) with mirror fallback | `services/music/youtube_audio_extractor.dart` | A |
| 6.3 | **YouTube rate-limit guard** — cooldown queue with a user-facing message instead of silent failure | `services/music/youtube_rate_limit_guard.dart` | A |
| 6.4 | **Lyrics** — LRC parser, synced highlighting, Deezer fallback client | `services/music/lyrics_service.dart`, `deezer_api_client.dart` | A |
| 6.5 | **Music player** — queue, shuffle, repeat, cross-surface handoff | `data/music/music_player.dart` (553) | A |
| 6.6 | **Manga reader modes** — webtoon vs paged, floating control bar, next-chapter deck, reader settings, remembered page | `screens/manga/manga_reader_page.dart` (975) | A |
| 6.7 | **Manga library** — saved series, progress per chapter | `data/manga/manga_library.dart` | A |
| 6.8 | **Audiobook player** — chapter bookmarks, waveform seek bar, background progress service | `screens/audiobooks/audiobook_player_page.dart` | A/B |
| 6.9 | **Downloads manager** — direct files resume, HLS saved with audio + subtitle tracks, torrents read in full, progress notification with pause/cancel | `data/downloads/downloads.dart` (884) | B |

---

### Tier 7 — Social & tracking (needs a server — decide separately)

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 7.1 | **Accounts** — PocketBase auth, email + reset, profile sync | `data/account/*` (727) | A + infra |
| 7.2 | **Friends** — requests both ways, blocking | `data/party/friends.dart` | A + infra |
| 7.3 | **DMs** — typing indicators, read marks, messages expire after a day | `data/party/dms.dart` | A + infra |
| 7.4 | **Rooms with voice** — public or code-private, hold-to-talk, mute, deafen, join/leave sounds, owner controls (rename, topic, code, mute, kick, hand over) | `data/party/voice.dart`, `screens/party/room_page.dart` (1,576) | A + **LiveKit** |
| 7.5 | **Watch together** — host presses play, everyone stays in step; link-copy disabled in a party | `data/party/watch_party.dart` (496) | A + infra |
| 7.6 | **Listen together** — host's music leads, everyone plays their own copy | `data/party/party_music.dart` | A + infra |
| 7.7 | **Live TV together** — one portal connection shared through a relay | `data/party/party_live.dart`, `live_upload.dart` | A + infra |
| 7.8 | **Mini chat** — floats over the app like the mini player | `screens/party/party_strip.dart` | A |
| 7.9 | **Profile libraries** — a profile can show its My List and music | `screens/party/profile_library.dart` | A |
| 7.10 | **Trackers** — AniList, Simkl, Trakt: scrobble while watching, list push, history | `data/trackers/*` (2,805) | A |
| 7.11 | **Tracker outbox** — unsent updates queue and replay; holds desired state, not a call log | `data/trackers/outbox.dart` | A |
| 7.12 | **Library import** — preview what would come in before changing anything | `data/trackers/library_import.dart`, `widgets/trackers/import_dialog.dart` | A |

**Reality check:** 7.1–7.7 need a PocketBase instance, a LiveKit deployment and a relay
process. `docs/PORT-BACKLOG.md` already marks watch party as "only after a cloud-sync
backbone exists". **7.10–7.12 need no server** and can ship independently — do those first.

---

### Tier 8 — D-pad / TV navigation (4,818 LOC + 10,000 LOC of tests)

PRAHA has `hooks/useSpatialNavigation.ts`. VyseTV has a full focus engine with a regression bed.

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 8.1 | **Focus ring + traversal** — geometric traversal, focus memory per route, covered-route boundary | `dpad/dpad_navigator.dart`, `dpad_traversal.dart`, `focus_memory_tracker.dart` | A |
| 8.2 | **Seek keys** — Left/Right seek while controls are hidden | `dpad/dpad_seek.dart` | A |
| 8.3 | **Transport keys** — remote media keys (play/pause/stop/next) | `dpad/transport_keys.dart` | A |
| 8.4 | **TV text input** — arrows move the caret, leave at the ends, Escape clears a search box | `dpad/tv_text_input.dart` | A |
| 8.5 | **Long-press** — hold Enter does what a long press or right-click does | `dpad/dpad_select_long_press_controller.dart` | A |
| 8.6 | **Key repeat** — held arrow repeats at a sane rate | `dpad/key_repeat_helper.dart` | A |
| 8.7 | **Input mode tracker** — ring appears on a key, vanishes on touch/mouse | `dpad/input_mode_tracker.dart` | A |
| 8.8 | **Focus chrome / theme** — what a focused control looks like, per platform | `dpad/focus_chrome.dart`, `focus_theme.dart` | A |
| 8.9 | **The test bed** — the walk/journey harness that proves every page is reachable | `test/dpad/*` (~10k LOC) | A |

**Worth noting:** 8.9 is the most under-appreciated thing in the repo. A crawl test that walks
every screen and asserts every control is reachable by arrow keys would catch a whole class of
Android TV bugs we currently ship blind.

---

### Tier 9 — Platform & infrastructure

| # | Take | VyseTV source | Feas |
|---|---|---|---|
| 9.1 | **Signed update list** — ECDSA P-256 signature over the version list; the app refuses an unsigned list; every download checked against the published SHA-256 | `data/updates/update_signature.dart`, `updater.dart` (585) | A |
| 9.2 | **Update UX** — check once per start, offer once, remember dismissed versions | `widgets/dialogs/update_dialog.dart` | A |
| 9.3 | **Diagnostics logs** — one file per subsystem (perf / music / subtitles), toggled by a build flag | `core/logs/*` | A |
| 9.4 | **Local relay** — the `127.0.0.1` proxy that holds headers for streams that need them | `data/playback/stream_proxy.dart` | A/B |
| 9.5 | **Audio channel limit** — cap a 7.1 track to stereo for a stereo device | `mpv/support/audio_channel_limit.dart` | B |
| 9.6 | **Display mode selector** — match the panel's refresh rate to the film | `core/platform/*`, Kotlin `shared/FrameRateManager.kt` | B |

---

## 4. Explicit SKIP list (and why)

| Skip | Why |
|---|---|
| mpv native players for Windows / Linux / macOS / iOS | We are Android + Web only. Their `windows/`, `linux/`, `macos/`, `ios/` runners are irrelevant. |
| `flutter-plezy` patched engine | Flutter-only. We have no Flutter. |
| Anime4K / ArtCNN / NVScaler shaders (3.3 MB) | mpv GLSL passes. Cannot run in a WebView or LibVLC. |
| `assets/fonts/` Go Noto (16 MB) | libass-specific font pipeline. Web subtitles use system fonts or a webfont. |
| `packages/torrserver_flutter` + binaries (~300 MB) | We already ship WebTorrent (`webtorrent` 2.8.5). Port their *settings and consent UX*, not the engine. |
| `packages/screen_brightness_windows` | Windows-only stub. |
| HDR output / TrueHD / DTS-HD bitstream passthrough | Needs an mpv video surface. LibVLC can approximate, but not match. Treat as out of scope. |
| Their whole 84-channel hardcoded table verbatim | Port the *scanner* (3.7). The channel list itself rots; take it as a seed, not gospel. |
| Their test suite as-is | Dart. Take the *approach* (8.9), write ours in vitest. |

---

## 5. Recommended build order

Six phases. Each is independently shippable — no phase blocks the next.

| Phase | Contents | Why this order | Est. |
|---|---|---|---|
| **P1** | Tier 0 foundations + 5.1 search scorer + 1.3–1.5 subtitle styling/codepages/sync | Cheap, immediately visible, and everything later writes into it | ~1 wk |
| **P2** | Tier 1 player panels (1.1, 1.2, 1.7–1.12, 1.14, 1.15) | Biggest user-visible jump; no server, no new deps | ~2 wks |
| **P3** | Tier 4 media servers (4.1–4.9) | Biggest feature jump. Replaces `JellyfinHome.tsx` with a real engine | ~3 wks |
| **P4** | Tier 2 sources (2.1–2.4, 2.10, 2.11) + Tier 3 Live TV gaps (3.1, 3.4, 3.5, 3.6) | Sharpens what we already do well | ~2 wks |
| **P5** | Tier 8 D-pad engine + test bed | Android TV quality; makes P1–P4 testable | ~2 wks |
| **P6** | Tier 7.10–7.12 trackers (server-free), then decide on Party | Trackers need no infra; Party is a separate project | ~1 wk + decision |

**Phase 3 is the one to argue about.** 49,185 lines of server engine is the largest single
block in VyseTV and the largest gap in PRAHA. It is also the least "exciting" to build.
If you want one answer: do Tier 4 before Tier 2.

---

## 6. Open decisions before we start

1. **Licence.** Clean-room port (safe, slower) or adopt GPL-3.0 (fast, viral)? This blocks
   whether we may copy any code at all.
2. **Party.** Build a server (PocketBase + LiveKit + relay), or ship Tier 7.10–7.12 trackers
   only and leave Party out?
3. **Media servers.** Is Plex + Jellyfin + Emby actually wanted, or is `JellyfinHome.tsx` enough?
   Tier 4 is ~3 weeks of the schedule.
4. **Player engine.** Stay on LibVLC + hls.js, or is there appetite for a native mpv bridge?
   Everything in Tier 1 except the shaders works on our current engines — no need to change.
5. **Scrapers.** Which 3–5 of the 3,091-line film scraper set do we actually want to maintain?

---

## 7. Cross-reference with existing backlog

Several items already appear in `docs/PORT-BACKLOG.md` from the Nuvio/PlayTorrio audit.
**Merge, don't duplicate:**

| This plan | Existing backlog item |
|---|---|
| 2.2 debrid media matcher | #21 Debrid extras |
| 2.3 torrent title parser | #20 PTT torrent title parser |
| 2.10 badge engine | #22 Stream badge filter packs |
| 1.12 binge-group cache | #23 Binge-group link cache |
| 5.1 search scorer | #2 Search relevance scorer |
| 6.3 YouTube rate-limit guard | #19 YouTube rate-limit guard |
| 6.4 lyrics | #18 LRC parser + synced lyrics |
| 3.6 M3U multi-playlist | #9 M3U multi-playlist manager |
| 3.5 EPG now/next | #8 EPG now/next snippets |
| 3.7 hardcoded channels | #50 Hardcoded-channel keyword scan |
| 3.8 PasteSh discovery | #49 Portal discovery via paste sites |
| 6.9 downloads manager | #51 Downloads manager |
| 8.x D-pad | #25-adjacent, but VyseTV's is far more complete |
| 7.10–7.12 trackers | #26 skip-list note: "port only the provider-abstraction shape" |

Where both exist, **VyseTV's implementation is the better reference** — it is newer, has tests,
and the file paths above point straight at the logic.

---

## 8. One-line summary

VyseTV is 159k lines of Flutter we cannot copy, but it contains **five things PRAHA genuinely
lacks**: a real player panel system, a complete Plex/Jellyfin/Emby engine, a full D-pad focus
engine with a test bed, a mature source/debrid layer, and a proper subtitle styling stack.
Take those five. Skip the native mpv work, the shaders, and the server-dependent Party tier
unless we decide to run infrastructure.
