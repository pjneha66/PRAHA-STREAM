# VyseTV → PRAHA STREAM — Phase Plan v5 (final, for approval)

Source: `https://gitlab.com/ayman707-ux/vysetv` @ depth 1
Plan date: 2026-11-20 · **Status: awaiting approval. No code changed.**

---

## What changed since v4

### ✅ WeebCentral is NOT blocked — I was wrong

I said it was behind Cloudflare. It isn't. **My test was broken.**

WeebCentral's query params are **case-sensitive**:

| Param | Result |
|---|---|
| `adult=False` (capital F) | **200** — 64 series |
| `adult=false` (lowercase) | **307 → /400** |
| `adult=Any` | **200** |

VyseTV's code (`manga_service.dart:53`) already does it right: `allowAdult ? 'Any' : 'False'`.
My probe used lowercase and I misread the 307 as a bot block.

**Live-verified end to end today:**

| Endpoint | Status | Result |
|---|---|---|
| `search/data?display_mode=Full+Display&adult=False` | **200** | 64 series per page |
| paging `offset=0 / 32 / 64` | **200** | different first result each time ✓ |
| `/series/{id}/{slug}` | **200** | 72 KB |
| `/series/{id}/full-chapter-list` | **200** | 324 KB |
| `/chapters/{id}` | **200** | 90 KB, first image inline |
| `/chapters/{id}/images?is_prev=False` | **200** | **43 images** |
| `scans.lastation.us/...png` (image CDN) | **200** | `image/png`, 199 KB, hotlinks fine |
| `temp.compsci88.com/cover/...jpg` | **200** | `image/jpeg`, 37 KB |
| `/latest-updates/1`, `/hot-series` | **200** | 32 series |

**Consequence:** the 3-tier fetch in v4 collapses to **one tier**. No WebView challenge hack,
no `PrahaStreamProxy` extension. Phase 8 drops from 6 days to **4 days**.

### ✅ Universal APK = option A

Both engines + TorrServer, arm64 + armv7 + x86_64.

### ✅ TorrServer default on Android

---

## Locked decisions

| # | Decision |
|---|---|
| 1 | GPL-3.0 |
| 2 | Keep Nuvio + Stremio + PlayTorrio sources — untouched |
| 3 | **Comic tab** (our Sanka + Comick) and **Manga tab** (WeebCentral) — separate |
| 4 | **Flow tab** untouched, byte-identical |
| 5 | VyseTV sources **first**, embed iframe **last resort** |
| 6 | Keep `EmbedModal` as final fallback |
| 7 | **arm64 APK + universal APK (A)** |
| 8 | Keep Sanka; add AniList for metadata |
| 9 | **Both players**: mpv + Media3 |
| 10 | TorrServer, **default on Android** |
| 11 | WeebCentral for manga — **confirmed working** |

---

## Release shape — two APKs

Measured AAR contents (real, from the downloaded 53,934,545-byte file):

| ABI | mpv native libs |
|---|---|
| arm64-v8a | **27.3 MB** |
| armeabi-v7a | **24.0 MB** |
| x86_64 | **33.1 MB** |
| x86 | 30.5 MB — **excluded** |

| APK | ABIs | Est. size |
|---|---|---|
| `praha-stream-v3.0.0-arm64.apk` | arm64-v8a | **~215–235 MB** |
| `praha-stream-v3.0.0-universal.apk` | arm64 + armv7 + x86_64 | **~355–390 MB** |

### ⚠ One decision that changes these numbers: LibVLC

We currently ship `org.videolan.android:libvlc-all:3.6.2` (~50 MB across 4 ABIs) plus
`PrahaVlcPlayer.java` (786 LOC). With **mpv + Media3 both installed**, LibVLC is redundant —
it is a third engine that does nothing the other two don't.

| Choice | arm64 | universal |
|---|---|---|
| **Drop LibVLC** (recommended) | ~205 MB | ~340 MB |
| Keep LibVLC as a third fallback | ~217 MB | ~390 MB |

Dropping it also deletes `PrahaVlcPlayer.java`, `MpvPlayer.tsx`'s LibVLC path, and the
`libvlc-all` dependency. **I recommend dropping. Tell me if you want it kept.**

---

# PHASE 0 — Licence + build proof (2 days)

| # | Task | Output |
|---|---|---|
| 0.1 | `LICENSE` — GPL-3.0 verbatim | file |
| 0.2 | `NOTICE` — VyseTV, Plezy (edde746), TorrServer (YouROK), PlayTorrio, Vyla SDK, mpv/FFmpeg/libass, Anime4K/ArtCNN/NVScaler, TMDB, AniList, TheIntroDB | file |
| 0.3 | Audit `lib/dpad/*` headers (VyseTV says only *some* are from Plezy) | report |
| 0.4 | `package.json` → `"license": "GPL-3.0-only"` | edit |
| 0.5 | **mpv SurfaceView spike** — Capacitor + AAR + one file playing + React button on top | spike APK |

### Spike detail

```
FrameLayout (root)
 ├─ SurfaceView     ← z-order 0
 └─ WebView         ← transparent bg
```
Record which works: **A** (behind WebView, hole in CSS) · **B** (above WebView, native controls)
· **C** (neither → TextureView, loses HDR).

### Acceptance
- [ ] `npm run ci` green with `LICENSE` present
- [ ] Spike APK installs, plays one file, UI clickable on top → **A/B/C recorded**

**Gate: if C → we keep LibVLC and skip Phases 3–4 (~20 days saved, HDR lost).**

---

# PHASE 1 — Build plumbing + dual APK (3 days)

| # | Task |
|---|---|
| 1.1 | Kotlin plugin 2.x + `kotlinx-coroutines-android:1.11.0` |
| 1.2 | CMake 3.22.1 + NDK `28.2.13676358` |
| 1.3 | `minSdk` 24 → **25** |
| 1.4 | mpv AAR via Ivy — `edde746:mpv-android:d633bbc71269@aar`, sha256 `4bf8a972…9df7` |
| 1.5 | libdovi v2.3.1 (`downloadLibdovi` task, per-ABI sha256) |
| 1.6 | media3 1.11.0 (exoplayer, hls, dash, ui, common, decoder) + cronet-embedded 143.7445.0 |
| 1.7 | `:libass` module — 21 Kotlin + 1,146 C; libass 0.18.3, sha256 `fc9863…1a17` |
| 1.8 | `dovi_bridge.cpp` + `media3_ffmpeg_decoder/` |
| 1.9 | `packaging { jniLibs { useLegacyPackaging = true } }` ← **required for TorrServer exec** |
| 1.10 | `pickFirsts libc++_shared.so` |
| 1.11 | ABI splits `arm64-v8a, armeabi-v7a, x86_64` + `universalApk true` |
| 1.12 | Extend `copyApkToDist` → `-arm64.apk` / `-universal.apk` |
| 1.13 | (if approved) remove `libvlc-all` + `PrahaVlcPlayer.java` |

### Acceptance
- [ ] `assembleDebug` succeeds with no native code called yet
- [ ] Both APK names land in `dist-apk/`
- [ ] `aapt2 dump badging`: `minSdk 25`, `native-code` lists only intended ABIs

---

# PHASE 2 — Foundations (3 days)

| # | Port | From | LOC |
|---|---|---|---|
| 2.1 | 8-theme system + ambient glow | `core/theme.dart` | ~400 |
| 2.2 | Configurable navbar (stable ids, order, hidden) | `core/nav_sections.dart` | ~150 |
| 2.3 | PlatformDetector (TV/phone/desktop + perf tier) | `core/platform/*` | ~500 |
| 2.4 | `Setting<T>` listenable prefs | `data/app_settings.dart` | 235 |
| 2.5 | Lean motion | `core/lean.dart` | ~60 |
| 2.6 | Design tokens → CSS vars | `core/theme.dart` | — |

### Acceptance
- [ ] Theme switch recolours app + persists
- [ ] Navbar reorder/hide persists; unknown ids ignored
- [ ] `tsc --noEmit` clean; 143 existing tests pass

---

# PHASE 3 — mpv engine (10 days)

Prerequisite: Phase 0 spike = A or B.

| # | Task | LOC |
|---|---|---|
| 3.1 | Copy `MpvPlayerCore.kt` + 11 policy files **unchanged** | 5,273 |
| 3.2 | Copy `shared/` (13 files) **unchanged** | 1,343 |
| 3.3 | Rewrite `MpvPlayerPlugin.kt` → `CapacitorMpvPlugin.kt` | ~700 |
| 3.4 | Port `player_base.dart` → `services/mpv/playerCore.ts` | 1,775 |
| 3.5 | Port `player_native.dart` | 1,407 |
| 3.6 | Port `platform/player_android_mpv.dart` | ~600 |
| 3.7 | Port `models.dart` + freezed | 2,800 |
| 3.8 | Port `mpv/extras/*` (picture effects, PiP, display match, external player) | ~800 |
| 3.9 | Port `mpv/support/*` (channel limit, rate, settings, track metadata) | ~600 |
| 3.10 | Surface rect sync — WebView reports rect → native `setX/setY/LayoutParams` | ~200 |

**Verified: zero Flutter in the cores.** Only 5 of 68 Kotlin files import `io.flutter`, all wrappers.

### Parity targets
HDR10 · Dolby Vision (libdovi) · TrueHD/DTS-HD/Atmos passthrough · HW HEVC 10-bit ·
frame-rate matching · ASS styling · decoder-hang recovery · seek-ahead buffering.

### Acceptance
- [ ] 4K HEVC MKV plays
- [ ] HDR badge on HDR panel; correct tone-map on SDR
- [ ] Subtitle sync nudges without remount
- [ ] Controls clickable over video

---

# PHASE 4 — Media3 / ExoPlayer engine (10 days)

| # | Task | LOC |
|---|---|---|
| 4.1 | Copy `ExoPlayerCore.kt` + 33 siblings | 12,878 |
| 4.2 | Copy `:libass` module | 3,500 |
| 4.3 | Rewrite `ExoPlayerPlugin.kt` → `CapacitorExoPlugin.kt` | ~900 |
| 4.4 | Port Dart Media3 layer (`player_android.dart`) | ~800 |
| 4.5 | Engine selector — Media3 default on TV, mpv opt-in | small |

### Acceptance
- [ ] Settings toggle flips engines at runtime
- [ ] Both play the same file, identical panels
- [ ] Media3 stall → mpv recovers

---

# PHASE 5 — TorrServer, default on Android (5 days)

| # | Task | Detail |
|---|---|---|
| 5.1 | Ship binaries | `torrserver-android-arm64` 64,423,136 B + armv7 for universal |
| 5.2 | Copy `TorrServerForegroundService.kt` | pure Android |
| 5.3 | Rewrite 3-method plugin | `startForegroundService`, `stopForegroundService`, `getNativeLibraryDir` |
| 5.4 | Port REST client (10 endpoints) | 278 → `services/p2p/torrServerClient.ts` |
| 5.5 | Port `torrents.dart` **with tuned settings** | 485 |
| 5.6 | Port `torrent_file_pick.dart` + `torrent_file_ask.dart` | 250 |
| 5.7 | Port `p2p_consent.dart` | once-only dialog |
| 5.8 | **Default on Android**; WebTorrent only for web/PWA | setting + branch |

### The tuned settings — verbatim, this is the "working method"

```
CacheSize                 256 MB phone / 1024 MB desktop
ReaderReadAHead           95 %
PreloadCache              2 %
ConnectionsLimit          150 phone / 300 desktop
EnableIPv6                FALSE     ← the measured win
RetrackersMode            1
ResponsiveMode            true
ForceEncrypt              false     ← encryption turns peers away
EnableLPD                 true
DisableUPNP               false
DisableDHT                false
DisablePEX                false
DisableUpload             false
TorrentDisconnectTimeout  120 s
EnableDLNA / EnableBonjour  false
UseDisk                   false     ← memory only
RemoveCacheOnDrop         true
```

VyseTV's measured note: *"with IPv6 on, 1.3–2.4 MB/s and nothing for the first 10–16 s, then a
stall; off, 4.1–4.8 MB/s and data within ~8 s every time."*

### Acceptance
- [ ] Magnet plays in <10 s on a healthy torrent
- [ ] Seek works (read-ahead ordering)
- [ ] Multi-file torrent auto-picks the episode
- [ ] Engine dies with app, no disk residue
- [ ] Consent shows exactly once

---

# PHASE 6 — Live TV complete (10 days)

12,164 LOC / 19 files. Replaces `iptvService.ts` (1,888), `m3uWorker.ts`, `liveTvPrefs.ts`,
`LiveTvView.tsx`, `live-tv.css`.

| # | Port | LOC |
|---|---|---|
| 6.1 | `iptv_controller.dart` | 1,242 |
| 6.2 | `iptv_network.dart` | 1,205 |
| 6.3 | `hardcoded_channels.dart` (84 channels + scanner) | 1,620 |
| 6.4 | `iptv_settings.dart` + `iptv_storage.dart` | 713 |
| 6.5 | `m3u_parser.dart` + `m3u_store.dart` | 189 |
| 6.6 | `pastesh_decryptor.dart` (AES-CBC) | 127 |
| 6.7 | `data/live_tv/*` (9 files) | 1,541 |
| 6.8 | `screens/live_tv/*` (7 files, portal browser 1,990) | 5,110 |
| 6.9 | **Keep our virtualised channel list** — theirs isn't virtualised | new |

### Acceptance
- [ ] Xtream portal adds, verifies, browses categories
- [ ] 10k-channel M3U scrolls at 60 fps
- [ ] Match finder picks the right feed
- [ ] Favourites per portal

---

# PHASE 7 — Sources + priority orchestrator (10 days)

| # | Port | LOC |
|---|---|---|
| 7.1 | 39 scrapers | 3,091 |
| 7.2 | `film_sources.dart` (Movy, 17 servers) + `common.dart` | ~700 |
| 7.3 | `source_settings.dart` → merge `sourcePreferences.ts` | ~150 |
| 7.4 | Debrid: RD / AD / Premiumize / Debrid-Link / TorBox | ~1,300 |
| 7.5 | `debrid_media_matcher` + `parse_torrent_title` | 653 |
| 7.6 | `knaben.dart` | 229 |
| 7.7 | `badges.dart` → merge `badgeRules.ts` | ~300 |
| 7.8 | `addons.dart` → merge `stremioService.ts` | 808 |
| 7.9 | **`SourceOrchestrator`** | new ~400 |

### The chain

```
1. 39 VyseTV scrapers + Movy       ← FIRST
2. VyseTV debrid                   ← then
3. TorrServer (P2P)                ← then
4. Nuvio + Stremio addons (ours)   ← then
5. EmbedModal iframe               ← LAST RESORT
6. "No source found" + retry
```

Results stream progressively — first answer plays, rest keep loading. `EmbedModal.tsx` is
untouched; only its call site moves.

### Acceptance
- [ ] Zero addons installed → still plays (scrapers alone)
- [ ] All four tiers in one ranked list with source dots
- [ ] Embed appears only on total miss
- [ ] Debrid link resolves through the relay

---

# PHASE 8 — Comic / Manga / Anime (4 days)

| Tab | Source | Code |
|---|---|---|
| **Comic** | Sanka (bacakomik, komikindo, shinigami, kiryuu) + Comick | **ours, untouched** |
| **Manga** | **WeebCentral** — verified working | VyseTV |
| **Anime** | Sanka anime + **AniList** (new) | ours + 816 |

| # | Port | LOC |
|---|---|---|
| 8.1 | `manga_service.dart` — **single-tier fetch, no hacks needed** | 500 |
| 8.2 | `manga_reader_page.dart` — webtoon vs paged, glass bar, next-chapter deck | 975 |
| 8.3 | `manga_details_page.dart` + `manga_page.dart` + `manga_widgets.dart` | 825 |
| 8.4 | `manga_library.dart` | 229 |
| 8.5 | 2 models | 114 |
| 8.6 | `anilist.dart` — GraphQL, fills `anilistId`/`mal`/`kitsu` | 816 |

### Verified request recipe (use exactly)

```
GET https://weebcentral.com/search/data
    ?display_mode=Full+Display
    &adult=False              ← CAPITAL F. lowercase returns 307
    &sort=Popularity&order=Descending&official=Any
    &offset={n}
Headers:
    User-Agent: <desktop Chrome 130 UA>
    HX-Request: true          ← htmx marker, required
    Referer: https://weebcentral.com/search
```

Chapter images: `GET /chapters/{id}/images?is_prev=False` (**capital F again**), needs
`-L` / redirect-follow. Image CDN `scans.lastation.us` hotlinks without a Referer.

### Acceptance
- [ ] Comic tab: unchanged, all 4 Sanka sources + Comick
- [ ] Manga tab: search → series → chapters → reader, page remembered
- [ ] Reader: webtoon and paged both correct
- [ ] Anime: AniList ids populate
- [ ] **Flow tab: no diff**

---

# PHASE 9 — Audiobooks, 8 sites (4 days)

| # | Port | LOC |
|---|---|---|
| 9.1 | `audiobook_scraper_service.dart` | 420 |
| 9.2 | `audiobook_player.dart` (bookmarks, waveform, background) | 363 |
| 9.3 | `audiobook_model.dart` | ~80 |
| 9.4 | 3 screens | 901 |
| 9.5 | `audiobook_widgets.dart` | 294 |

**Live-checked:** goldenaudiobooks **200** · hotaudiobooks **200** · audioaz **200** ·
audiobooks4soul **403** (route through `nativeFetchText`).

### Acceptance
- [ ] Search across all working sites
- [ ] Chapter list correct per site
- [ ] Position + bookmarks + waveform work

---

# PHASE 10 — Music source + layout (8 days)

| # | Port | LOC |
|---|---|---|
| 10.1 | `yt_music.dart` — InnerTube browse (verified **200** for `WEB_REMIX`) | 864 |
| 10.2 | `youtube_audio_extractor.dart` | 997 |
| 10.3 | `youtube_rate_limit_guard.dart` | 123 |
| 10.4 | `deezer_api_client.dart` | 296 |
| 10.5 | `lyrics_service.dart` | 179 |
| 10.6 | `music_player.dart` + `music_library.dart` + `music_track.dart` | 1,436 |
| 10.7 | **Layout** | 4,992 |

### The layout

| File | LOC | Gives |
|---|---|---|
| `music_shell.dart` | 977 | sidebar + segments + search pill + **persistent bottom bar** + **queue drawer** |
| `music_pages.dart` | 1,152 | Artist · Album · Playlist · My Playlist · Liked · Library · Browse · Mood · History |
| `music_page.dart` | 888 | home |
| `music_ui.dart` | 830 | shared widgets |
| `music_player_page.dart` | 669 | full-screen now-playing |
| `music_detail_pages.dart` | 476 | |
| `music_widgets.dart` | 661 | |

Replaces `components/music/` (3 files) + `components/MusicView.tsx`.

### Acceptance
- [ ] Browse/search/artist/album/playlist render
- [ ] Bottom bar persists; queue drawer works
- [ ] Lyrics sync line-by-line
- [ ] One thing plays at a time

---

# PHASE 11 — D-pad focus engine (7 days)

| # | Port | LOC |
|---|---|---|
| 11.1 | traversal + focus memory + covered-route boundary | ~1,200 |
| 11.2 | seek keys | ~200 |
| 11.3 | transport keys | ~150 |
| 11.4 | TV text input | ~300 |
| 11.5 | long-press + key repeat | ~350 |
| 11.6 | input mode tracker + focus chrome | ~500 |
| 11.7 | **walk test bed** | ~2,100 |

### Acceptance
- [ ] Every screen reachable by arrows
- [ ] Crawl test passes on player, Live TV, Music, Manga
- [ ] Ring on key, gone on touch

---

# PHASE 12 — Verify & ship (5 days)

- `tsc --noEmit` clean
- `vitest run` — 143 existing + new
- `vite build` clean
- `assembleRelease` → **both APKs**
- `unzip -t` + `aapt2 dump badging` on both
- Install on device, smoke every tab
- Update `memory.md`, `docs/PORT-BACKLOG.md`
- Copy both APKs to `dist-apk/`

---

## Total

| Phase | Days | Deliverable |
|---|---|---|
| 0 Licence + proof | 2 | go/no-go + `LICENSE` |
| 1 Build plumbing | 3 | dual APK boilerplate |
| 2 Foundations | 3 | themes, navbar, prefs |
| 3 mpv | 10 | engine 1 |
| 4 Media3 | 10 | engine 2 |
| 5 TorrServer | 5 | P2P default |
| 6 Live TV | 10 | full replacement |
| 7 Sources | 10 | 39 scrapers + orchestrator |
| 8 Comic/Manga | 4 | WeebCentral live |
| 9 Audiobooks | 4 | 8 sites |
| 10 Music | 8 | source + layout |
| 11 D-pad | 7 | TV control |
| 12 Verify | 5 | both APKs |
| **Total** | **~81 days** | **≈ 4 months of sessions** |

P3, P4, P5, P6, P7, P8, P9, P10, P11 are independent once P1 + P2 land.

---

## Checkpoints — every one ships an installable APK

| After | You see | You decide |
|---|---|---|
| P0 | spike result | continue / re-scope |
| P1 | two empty APKs, correct ABIs | size OK? |
| P2 | new themes + navbar | look right? |
| P3 | mpv playing 4K HDR | keep mpv? |
| P4 | engine switch | keep both? |
| P5 | torrent <10 s | TorrServer default OK? |
| P6 | new Live TV | replace old? |
| P7 | scraper list + embed demoted | order correct? |
| P8 | Comic + Manga tabs | WeebCentral good? |
| P9 | audiobooks | sources good? |
| P10 | new music layout | right look? |
| P11 | remote everywhere | ship? |

---

## One last decision — LibVLC

| | arm64 APK | universal APK |
|---|---|---|
| **Drop LibVLC** (recommended) | ~205 MB | ~340 MB |
| Keep LibVLC | ~217 MB | ~390 MB |

With mpv + Media3 both installed, LibVLC is a redundant third engine. Dropping it removes
`libvlc-all` (~50 MB), `PrahaVlcPlayer.java` (786 LOC), and the LibVLC path in `MpvPlayer.tsx`.

**Say "drop LibVLC" or "keep LibVLC" and I start Phase 0.**
