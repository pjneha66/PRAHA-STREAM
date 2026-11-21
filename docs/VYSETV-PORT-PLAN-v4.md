# VyseTV → PRAHA STREAM — Phase-Wise Build Plan v4

Source: `https://gitlab.com/ayman707-ux/vysetv` @ depth 1
Plan date: 2026-11-20 · **Status: awaiting approval. No code changed.**

---

## Your decisions, locked in

| # | Instruction | Locked answer |
|---|---|---|
| 1 | **arm64 APK AND a normal (universal) APK** | Ship **two** APKs per release |
| 2 | **VyseTV WeebCentral for manga** | Committed — 3-tier fetch, §Phase 8 |
| 3 | **TorrServer is default** | TorrServer default on Android; WebTorrent only for web/PWA |
| 4 | GPL-3.0 | §Phase 0 |
| 5 | Keep comic source + separate Comic/Manga tabs | §Phase 8 |
| 6 | Keep Flow | Untouched, all phases |
| 7 | Copy sources first, embed last resort | §Phase 7 |
| 8 | Keep Sanka + add AniList | §Phase 8 |
| 9 | Both players | §Phase 3 + §Phase 4 |
| 10 | TorrServer + P2P method | §Phase 5 |
| 11 | Live TV complete, music layout, audiobooks source | §Phase 6, 10, 9 |

---

## Release shape — two APKs

| APK | ABIs | Contents | Est. size |
|---|---|---|---|
| `praha-stream-v3.0.0-arm64.apk` | `arm64-v8a` | libmpv, FFmpeg, libass, TorrServer arm64 | **~265 MB** |
| `praha-stream-v3.0.0-universal.apk` | `arm64-v8a` + `armeabi-v7a` + `x86_64` | same, 3 ABIs | **~390 MB** |

Current APK is **192 MB** (LibVLC-all + WebTorrent). The growth is:

| Addition | arm64 | 3-ABI |
|---|---|---|
| mpv-android AAR (libmpv + FFmpeg + libc++) | +40 MB | +54 MB |
| TorrServer binary | +24 MB | +73 MB |
| media3 + cronet (ExoPlayer) | +8 MB | +8 MB |
| libass (built) | +2 MB | +5 MB |
| **Net change** | **+73 MB** | **+140 MB** |

⚠ **390 MB is very large.** If you'd rather keep universal smaller, I can ship the universal
build with **only mpv** (no Media3/libass) and put the full dual-engine in arm64.
Say "universal = arm64 + armv7 only" and it lands at ~330 MB. **Your call.**

Gradle wiring: `splits { abi { enable true; reset(); include 'arm64-v8a','armeabi-v7a','x86_64'; universalApk true } }`
plus a copy task so `copyApkToDist` emits both names.

---

## Dependency graph

```
P0 proof ─┬─ P1 build plumbing ─┬─ P3 mpv ────────────┐
          │                     ├─ P4 Media3 ─────────┤
          │                     └─ P5 TorrServer ─────┤
          └─ P2 foundations ────┬─ P6 Live TV ────────┤
                                ├─ P7 Sources ────────┼─ P12 verify & ship
                                ├─ P8 Comic/Manga ────┤
                                ├─ P9 Audiobooks ─────┤
                                ├─ P10 Music ─────────┤
                                └─ P11 D-pad ─────────┘
```

P3, P4, P5, P6, P7, P8, P9, P10 are all independent once P1 and P2 land.

---

# PHASE 0 — Proof & licence (3 days)

**Goal:** answer the two questions that decide whether 30+ days of player/manga work is worth it.

### Tasks

| # | Task | Output |
|---|---|---|
| 0.1 | Add `LICENSE` — GPL-3.0 verbatim (35,149 bytes, copy from VyseTV) | `LICENSE` |
| 0.2 | Add `NOTICE` — VyseTV, **Plezy** (edde746, GPL-3.0), **TorrServer** (YouROK, GPL-3.0), **PlayTorrio** (GPL-3.0), Vyla SDK, mpv/FFmpeg/libass, Anime4K/ArtCNN/NVScaler, TMDB, AniList, TheIntroDB | `NOTICE` |
| 0.3 | Audit `lib/dpad/*` headers — VyseTV says only *some* are from Plezy | report |
| 0.4 | `package.json` → `"license": "GPL-3.0-only"` | edit |
| 0.5 | **mpv SurfaceView spike** — minimal Capacitor app: add `SurfaceView` behind WebView, play one file via the AAR, React button on top | spike APK |
| 0.6 | **WeebCentral probe** — 3 fetch tiers against `search/data` | report |

### Spike detail (0.5)

```
MainActivity
  └─ FrameLayout (root)
       ├─ SurfaceView          ← added first, z-order 0
       └─ WebView              ← added second, transparent background
```

Then: `capabilities.setZOrderMediaOverlay(false)`, `webView.setBackgroundColor(Color.TRANSPARENT)`,
and a CSS hole. Report which of these works:

- **A** — `SurfaceView` behind a transparent WebView, video visible through the hole
- **B** — `SurfaceView` above WebView, controls drawn natively
- **C** — neither → fall back to `TextureView` (loses HDR) or stay on LibVLC

### WeebCentral probe detail (0.6)

| Tier | Method | Expected |
|---|---|---|
| 1 | plain `fetch` + desktop UA | **fails** (already tested: 307 → /400) |
| 2 | `nativeFetchText` (our Android OkHttp bridge) | maybe |
| 3 | **hidden WebView fetch** (JS challenge runs, cookies captured) | **should work** |

Tier 3 is the certain fix. It is also exactly what our `PrahaStreamProxy.java` (432 LOC) already
does for streams — capture headers + cookies from a real WebView, then replay them. Extending it
to a page-fetch mode is a small job.

### Acceptance
- [ ] `LICENSE` + `NOTICE` present, `npm run ci` still green
- [ ] Spike APK installs and plays one file with UI on top → **A/B/C recorded**
- [ ] WeebCentral returns real HTML through at least one tier → **tier recorded**

### Gate
**If 0.5 = C and 0.6 all fail → stop and we re-scope before spending 30 days.**

---

# PHASE 1 — Build plumbing + dual APK (3 days)

**Goal:** the Android project can compile native code and emit two APKs.

| # | Task | Detail |
|---|---|---|
| 1.1 | Add Kotlin plugin | `org.jetbrains.kotlin.android` 2.x, `kotlinx-coroutines-android:1.11.0` |
| 1.2 | Add CMake + NDK | CMake 3.22.1, NDK `28.2.13676358` |
| 1.3 | `minSdk` 24 → **25** | AAR requirement (Android 7.1 floor) |
| 1.4 | Add mpv AAR via Ivy repo | `edde746:mpv-android:d633bbc71269@aar` from `binaries-f78e66727714`, sha256 verified, `exclusiveContent` filter |
| 1.5 | Add libdovi | `downloadLibdovi` task, v2.3.1, per-ABI sha256 from VyseTV's task |
| 1.6 | Add media3 + cronet | 1.11.0 (exoplayer, hls, dash, ui, common, decoder) + `cronet-embedded:143.7445.0` |
| 1.7 | Add `:libass` module | copy 21 Kotlin + `CMakeLists.txt` + `FetchLibass.cmake`; pins libass 0.18.3, sha256 `fc9863…1a17` |
| 1.8 | Copy `dovi_bridge.cpp` + `media3_ffmpeg_decoder/` | C++ |
| 1.9 | `packaging { jniLibs { useLegacyPackaging = true } }` | **required** — TorrServer execs from `nativeLibraryDir`, must be unpacked |
| 1.10 | `pickFirsts libc++_shared.so` | AAR's copy wins |
| 1.11 | ABI splits + universal APK | see release shape |
| 1.12 | Extend `copyApkToDist` | emit `-arm64.apk` and `-universal.apk` |

### Acceptance
- [ ] `assembleDebug` succeeds with no native code used yet
- [ ] Both APK names appear in `dist-apk/`
- [ ] `aapt2 dump badging` shows `minSdk 25`, correct `native-code` per APK

---

# PHASE 2 — Foundations (3 days)

| # | Port | From | To |
|---|---|---|---|
| 2.1 | 8-theme system (Vyse/Crimson/Abyss/Amber/Bloom/Canopy/Glacier/Violet + ambient glow) | `core/theme.dart` | `styles/themes.ts` |
| 2.2 | Configurable navbar (stable ids, saved order, hidden list) | `core/nav_sections.dart` | `services/navLayout.ts` |
| 2.3 | PlatformDetector (TV / phone / desktop + perf tier) | `core/platform/*` | `services/platformDetector.ts` |
| 2.4 | `Setting<T>` listenable prefs | `data/app_settings.dart` (235) | `services/settings/*` |
| 2.5 | Lean motion switch | `core/lean.dart` | `services/lean.ts` |
| 2.6 | Design tokens | `core/theme.dart` palette | `index.css` vars |

### Acceptance
- [ ] Switching theme recolours the whole app, persists across restart
- [ ] Navbar reorder + hide persists; unknown ids ignored
- [ ] `tsc --noEmit` clean; existing 143 tests still pass

---

# PHASE 3 — mpv engine (10 days)

**Prerequisite:** Phase 0 spike = A or B.

| # | Task | Files | LOC |
|---|---|---|---|
| 3.1 | Copy `MpvPlayerCore.kt` + 11 policy files, unchanged | `mpv/` | 5,273 |
| 3.2 | Copy `shared/` (AudioFocus, FrameRate, SurfaceHost, SurfacePlayerCore, DeviceQuirks, DisplayModeSelector, PlayerDebugLog, PlayerDelegate, MpvContentUriResolver) | `shared/` | 1,343 |
| 3.3 | **Rewrite** `MpvPlayerPlugin.kt` → `CapacitorMpvPlugin.kt` | 1 | ~700 |
| 3.4 | Port Dart player core → TS | `player_base.dart` | 1,775 |
| 3.5 | Port native bridge | `player_native.dart` | 1,407 |
| 3.6 | Port Android platform layer | `platform/player_android_mpv.dart` | ~600 |
| 3.7 | Port models | `models.dart` + `models.freezed.dart` | 2,800 |
| 3.8 | Port extras (picture effects, PiP, display match, external player) | `mpv/extras/*` | ~800 |
| 3.9 | Port support (audio channel limit, playback rate, player settings, track metadata) | `mpv/support/*` | ~600 |
| 3.10 | Surface rect sync — WebView reports rect → native `setX/setY/LayoutParams` | new | ~200 |

### Capability parity targets
HDR10 · Dolby Vision (via libdovi) · TrueHD/DTS-HD/Atmos passthrough · hardware HEVC 10-bit ·
frame-rate matching · ASS styling · decoder-hang recovery · seek-ahead buffering.

### Acceptance
- [ ] Plays MKV/HEVC/4K on the test phone
- [ ] HDR badge appears on an HDR panel; SDR tone-maps correctly
- [ ] Subtitle sync panel nudges without remount
- [ ] Controls remain clickable over the video (spike outcome A or B)

---

# PHASE 4 — Media3 / ExoPlayer engine (10 days)

**Prerequisite:** Phase 1 (media3 + libass + dovi + ffmpeg-jni in place).

| # | Task | Files | LOC |
|---|---|---|---|
| 4.1 | Copy `ExoPlayerCore.kt` + 33 siblings | `exoplayer/` | 12,878 |
| 4.2 | Copy `:libass` module (21 Kotlin, 1,146 C) | `android/libass/` | 3,500 |
| 4.3 | **Rewrite** `ExoPlayerPlugin.kt` → `CapacitorExoPlugin.kt` | 1 | ~900 |
| 4.4 | Port Dart Media3 layer | `player_android.dart` | ~800 |
| 4.5 | Engine selector — `''` → Media3 default on TV, `mpv` opt-in | `player_engine.dart` | small |
| 4.6 | Gradle: media3, cronet, `project(":libass")` | build file | — |

### Why keep both (VyseTV's own rationale)
Media3 is the **default on Android TV**; mpv is opt-in. Media3 handles HLS/DASH natively,
cronet for networking, libass for ASS, and the Dovi/TrueHD/DTS packers give it near-mpv audio.

### Acceptance
- [ ] Engine switch in Settings flips between them at runtime
- [ ] Both play the same file; UI panels work identically
- [ ] Letting Media3 fail over to mpv recovers a stalled stream

---

# PHASE 5 — TorrServer (5 days) ← **default on Android**

| # | Task | Detail |
|---|---|---|
| 5.1 | Ship binary | `torrserver-android-arm64` (64,423,136 B) in `assets/`, armv7 copy for universal |
| 5.2 | Copy `TorrServerForegroundService.kt` | pure Android, no Flutter |
| 5.3 | Rewrite 3-method plugin | `startForegroundService`, `stopForegroundService`, `getNativeLibraryDir` |
| 5.4 | Port REST client (10 endpoints) | `rest_client.dart` 278 → `services/p2p/torrServerClient.ts` |
| 5.5 | Port `torrents.dart` with **the tuned settings** | 485 LOC |
| 5.6 | Port `torrent_file_pick.dart` + `torrent_file_ask.dart` | 250 LOC — picks the right episode file |
| 5.7 | Port `p2p_consent.dart` | the "peers see your IP" dialog, once |
| 5.8 | **Make it default** — Android uses TorrServer, web/PWA uses WebTorrent | setting + branch |

### The tuned settings — copied verbatim

```
CacheSize                 256 MB phone / 1024 MB desktop
ReaderReadAHead           95 %        big read-ahead window
PreloadCache              2 %         start at 2%, not 50%
ConnectionsLimit          150 phone / 300 desktop
EnableIPv6                FALSE       ← the measured win
RetrackersMode            1           extra public trackers
ResponsiveMode            true
ForceEncrypt              false       ← encryption turns peers away
EnableLPD                 true        local peer discovery
DisableUPNP               false
DisableDHT                false
DisablePEX                false
DisableUpload             false       ← uploading earns peers
TorrentDisconnectTimeout  120 s       survives pause / seek-back
EnableDLNA / EnableBonjour  false
UseDisk                   false       memory only, nothing persisted
RemoveCacheOnDrop         true
```

**The IPv6 line is the whole point.** VyseTV's note: *"measured on a large public torrent: with it
on, 1.3–2.4 MB/s and nothing for the first 10–16 s, then a stall; off, 4.1–4.8 MB/s and data
within ~8 s every time."*

### Acceptance
- [ ] Magnet plays in under 10 s on a healthy torrent
- [ ] Seeking works (TorrServer prioritises read-ahead pieces)
- [ ] Multi-file torrent auto-picks the right episode
- [ ] Engines dies with the app; no cache left on disk
- [ ] Consent dialog shows exactly once

---

# PHASE 6 — Live TV complete (10 days)

12,164 LOC across 19 files. Replaces `iptvService.ts` (1,888), `m3uWorker.ts`,
`liveTvPrefs.ts`, `LiveTvView.tsx`, `live-tv.css`.

| # | Port | LOC |
|---|---|---|
| 6.1 | `iptv_controller.dart` → `services/liveTv/controller.ts` | 1,242 |
| 6.2 | `iptv_network.dart` → `network.ts` (scrape + verify + discover) | 1,205 |
| 6.3 | `hardcoded_channels.dart` → 84 curated + keyword scanner | 1,620 |
| 6.4 | `iptv_settings.dart`, `iptv_storage.dart` | 713 |
| 6.5 | `m3u_parser.dart`, `m3u_store.dart` (multi-playlist, `{added,skipped,failed}`) | 189 |
| 6.6 | `pastesh_decryptor.dart` (AES-CBC) | 127 |
| 6.7 | `data/live_tv/*` (9 files: guide, favorites, match_finder, sports_schedule, catalog) | 1,541 |
| 6.8 | `screens/live_tv/*` (7 files, incl. 1,990-LOC portal browser) | 5,110 |
| 6.9 | **Keep our virtualised channel list**, merge with theirs | new |

Ten behaviours: portal browser w/ preview pane · match finder (EPG around kick-off) ·
ESPN schedule · per-portal favourites · EPG now/next · multi-playlist · hardcoded scan ·
paste-site discovery · appearance settings · Xtream/M3U group trees.

### Acceptance
- [ ] Xtream portal adds, verifies, browses categories
- [ ] M3U playlist of 10k channels scrolls at 60 fps (our virtualisation)
- [ ] "Which channel has the match" finds the right feed
- [ ] Favourites survive per portal

---

# PHASE 7 — Sources + priority orchestrator (10 days)

| # | Port | LOC |
|---|---|---|
| 7.1 | 39 scrapers → `services/sources/scrapers/*` | 3,091 |
| 7.2 | `film_sources.dart` (Movy, 17 servers) + `common.dart` | ~700 |
| 7.3 | `source_settings.dart` → merge into `sourcePreferences.ts` | ~150 |
| 7.4 | Debrid: RD / AD / Premiumize / Debrid-Link / TorBox | ~1,300 |
| 7.5 | `debrid_media_matcher.dart` + `parse_torrent_title.dart` | 653 |
| 7.6 | `knaben.dart` | 229 |
| 7.7 | `badges.dart` → merge `badgeRules.ts` | ~300 |
| 7.8 | `addons.dart` → merge into `stremioService.ts` (per-addon toggles, reorder, rename, configure) | 808 |
| 7.9 | **`SourceOrchestrator`** — the priority chain | new ~400 |

### The priority chain (your instruction)

```
1. 39 VyseTV scrapers + Movy          ← FIRST
2. VyseTV debrid                      ← then
3. TorrServer (P2P)                   ← then
4. Nuvio + Stremio addons (ours)      ← then
5. EmbedModal iframe                  ← LAST RESORT
6. "No source found" + retry
```

Results stream in progressively — first answer plays, the rest keep loading. EmbedModal is
called **only** on a total miss from 1–4. `EmbedModal.tsx` itself is untouched; only its call
site moves.

### Acceptance
- [ ] A title with no addons installed still plays (scrapers alone)
- [ ] Items 1–4 all visible in one ranked list with source dots
- [ ] Embed appears only when all four miss
- [ ] Debrid link resolves and plays through the relay

---

# PHASE 8 — Comic / Manga / Anime split (6 days)

### Tabs

| Tab | Source | Code |
|---|---|---|
| **Comic** (existing) | Sanka comics (bacakomik, komikindo, shinigami, kiryuu) + Comick | **ours, untouched** |
| **Manga** (new) | **WeebCentral** | VyseTV |
| **Anime** | Sanka anime + **AniList** (new) | ours + 816 LOC added |

### Manga — WeebCentral, committed

| # | Port | LOC |
|---|---|---|
| 8.1 | `manga_service.dart` (search, popular, genres, series, chapters, images, progress, likes, history) | 500 |
| 8.2 | `manga_reader_page.dart` — **webtoon vs paged, floating glass bar, next-chapter deck** | 975 |
| 8.3 | `manga_details_page.dart`, `manga_page.dart`, `manga_widgets.dart` | 825 |
| 8.4 | `manga_library.dart` (saved series, per-chapter progress) | 229 |
| 8.5 | 2 models | 114 |
| 8.6 | **3-tier fetch** — see below | new |

### 8.6 — the WeebCentral fetch strategy

Phase 0 tests three tiers. The plan ships **all three**, tried in order:

| Tier | Mechanism | When it wins |
|---|---|---|
| 1 | plain `fetch` with desktop UA + `Accept` + `Accept-Language` | plain sites |
| 2 | `nativeFetchText` (Android OkHttp bridge, no CORS) | most Cloudflare fronts |
| 3 | **hidden WebView fetch** — load the URL in an offscreen `WebView`, let the JS challenge
run, then read `document.documentElement.outerHTML` + cookies | JS challenges (Cloudflare's default) |

Tier 3 is the certain path. We already have the machinery: `PrahaStreamProxy.java` (432 LOC)
captures headers and cookies from a real WebView and replays them for streams. Extending it with
a `fetchPageWithChallenge(url)` method is ~150 lines of Java.

```java
// new method on MainActivity / PrahaStreamProxy
String fetchPageWithChallenge(String url, int timeoutMs)
//  - offscreen WebView, real UA, cookie jar on
//  - wait for onPageFinished + a settle delay
//  - return outerHTML
```

Cached per host for the session so we pay the challenge once, not per page.

### 8.7 — AniList (added, not substituted)

`anilist.dart` (816 LOC, GraphQL `https://graphql.anilist.co`) fills `anilistId`, `mal`,
`kitsu`, cover, banner, genres, relations. Writes into the existing fields at `types.ts:53`
and `:299-302`. **Sanka stays** for both comic and anime browse.

### Acceptance
- [ ] Comic tab: unchanged behaviour, all 4 Sanka sources + Comick
- [ ] Manga tab: WeebCentral search → series → chapters → reader, page remembered
- [ ] Reader: webtoon and paged modes both correct, next-chapter deck works
- [ ] Anime: AniList ids populate for titles Sanka can't match
- [ ] Flow tab: **byte-identical, no diff**

---

# PHASE 9 — Audiobooks, 8 sites (4 days)

| # | Port | LOC |
|---|---|---|
| 9.1 | `audiobook_scraper_service.dart` (8 sites, per-site chapter extraction) | 420 |
| 9.2 | `audiobook_player.dart` (bookmarks, waveform seek, background progress) | 363 |
| 9.3 | `audiobook_model.dart` | ~80 |
| 9.4 | 3 screens (list, details, player) | 901 |
| 9.5 | `audiobook_widgets.dart` | 294 |

### Live-checked today

| Site | Status |
|---|---|
| goldenaudiobooks.com | **200** |
| hotaudiobooks.com | **200** |
| audioaz.com | **200** |
| audiobooks4soul.com | **403** → route through tier-3 WebView fetch |
| fulllength / bookaudiobooks / audiozaic / audionest | implemented, verified at build time |

### Acceptance
- [ ] Search returns results across all working sites
- [ ] Chapter list correct per site
- [ ] Position remembered; bookmarks work; waveform scrubs

---

# PHASE 10 — Music source + layout (8 days)

| # | Port | LOC |
|---|---|---|
| 10.1 | `yt_music.dart` — InnerTube browse (home, search, artist, album, playlist, charts, moods, radio) | 864 |
| 10.2 | `youtube_audio_extractor.dart` | 997 |
| 10.3 | `youtube_rate_limit_guard.dart` | 123 |
| 10.4 | `deezer_api_client.dart` | 296 |
| 10.5 | `lyrics_service.dart` (LRC + synced) | 179 |
| 10.6 | `music_player.dart` + `music_library.dart` + `music_track.dart` | 1,436 |
| 10.7 | **Layout** — see below | 4,992 |

### The layout you asked for

| File | LOC | What it gives |
|---|---|---|
| `music_shell.dart` | 977 | left sidebar + segment tabs + top search pill + **persistent bottom `MusicBar` with inline progress** + **slide-out queue panel** |
| `music_pages.dart` | 1,152 | Artist · Album · Playlist · My Playlist · Liked · Library · Browse · Mood · History |
| `music_page.dart` | 888 | home |
| `music_ui.dart` | 830 | shared widgets |
| `music_player_page.dart` | 669 | full-screen now-playing |
| `music_detail_pages.dart` | 476 | |
| `widgets/music_widgets.dart` | 661 | |

Replaces `components/music/` (3 files) + `components/MusicView.tsx`.

**Verified live:** InnerTube `WEB_REMIX` search returns `200` with the documented headers.

### Acceptance
- [ ] Browse + search + artist/album/playlist pages all render
- [ ] Bottom bar persists across navigation, queue drawer works
- [ ] Lyrics sync line-by-line
- [ ] One thing plays at a time — music pauses for a film, film pauses for music

---

# PHASE 11 — D-pad focus engine (7 days)

| # | Port | LOC |
|---|---|---|
| 11.1 | geometric traversal + focus memory + covered-route boundary | ~1,200 |
| 11.2 | seek keys (Left/Right while controls hidden) | ~200 |
| 11.3 | transport keys (remote media keys) | ~150 |
| 11.4 | TV text input (caret at ends, Escape clears search) | ~300 |
| 11.5 | long-press + key repeat | ~350 |
| 11.6 | input mode tracker + focus chrome/theme | ~500 |
| 11.7 | **the walk test bed** — crawl every screen, assert every control reachable | ~2,100 |

⚠ `lib/dpad/*` header audit from Phase 0.3 applies before copying.

### Acceptance
- [ ] Every screen reachable by arrows alone
- [ ] Crawl test passes on the new player, Live TV, Music, Manga
- [ ] Ring appears on key, vanishes on touch

---

# PHASE 12 — Verify & ship (5 days)

| # | Check |
|---|---|
| 12.1 | `node node_modules/typescript/bin/tsc --noEmit` — clean |
| 12.2 | `vitest run` — existing 143 tests + new suites green |
| 12.3 | `vite build` — clean |
| 12.4 | `assembleDebug` + `assembleRelease` for both APKs |
| 12.5 | `unzip -t` + `aapt2 dump badging` on both |
| 12.6 | Install on device; smoke every tab |
| 12.7 | Update `memory.md`, `docs/PORT-BACKLOG.md` cross-refs |
| 12.8 | Copy both APKs to `dist-apk/` |

---

## Total effort

| Phase | Days | Deliverable |
|---|---|---|
| 0 Proof & licence | 3 | go/no-go + `LICENSE` |
| 1 Build plumbing | 3 | dual APK boilerplate |
| 2 Foundations | 3 | themes, navbar, prefs |
| 3 mpv | 10 | mpv engine live |
| 4 Media3 | 10 | second engine live |
| 5 TorrServer | 5 | P2P default |
| 6 Live TV | 10 | complete replacement |
| 7 Sources | 10 | 39 scrapers + orchestrator |
| 8 Comic/Manga | 6 | WeebCentral live |
| 9 Audiobooks | 4 | 8 sites |
| 10 Music | 8 | source + layout |
| 11 D-pad | 7 | TV control |
| 12 Verify | 5 | both APKs shipped |
| **Total** | **~84 days** | **≈ 4 months of sessions** |

On this phone each `assembleRelease` is hours. Realistically **1 phase per 2–3 sessions**.

---

## Checkpoints where you decide

| After | You see | You decide |
|---|---|---|
| **P0** | spike result + WeebCentral tier | continue or re-scope |
| **P1** | two empty APKs, correct ABIs | size acceptable? |
| **P2** | new themes + navbar | look right? |
| **P3** | mpv playing 4K HDR | keep mpv? |
| **P4** | engine switch working | keep both? |
| **P5** | torrent playing in <10 s | TorrServer default OK? |
| **P6** | new Live TV | replace old? |
| **P7** | scraper list + embed demoted | order correct? |
| **P8** | Comic + Manga tabs live | WeebCentral good? |
| **P9** | audiobooks | sources good? |
| **P10** | new music layout | right look? |
| **P11** | remote control everywhere | ship? |

Each checkpoint produces an installable APK. If you stop anywhere, everything before it works.

---

## Open item — universal APK contents

| Option | ABIs | Size | Contents |
|---|---|---|---|
| **A** (proposed) | arm64 + armv7 + x86_64 | ~390 MB | both engines + libass + TorrServer |
| **B** | arm64 + armv7 only | ~330 MB | both engines + libass + TorrServer |
| **C** | arm64 + armv7 + x86_64 | ~310 MB | **mpv only**, no Media3/libass |

Plus arm64-only APK at ~265 MB in every option.

**Tell me A, B or C and I start Phase 0.**
