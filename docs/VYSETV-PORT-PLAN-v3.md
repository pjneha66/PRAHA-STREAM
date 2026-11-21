# VyseTV → PRAHA STREAM — Port Plan v3 (for approval)

Source: `https://gitlab.com/ayman707-ux/vysetv` @ depth 1
Plan date: 2026-11-20 · **Status: awaiting your approval. Nothing changed.**

---

## 1. Your decisions, resolved

| # | Your instruction | This plan |
|---|---|---|
| 1 | Adopt GPL-3.0 | §2 |
| 2 | **Keep Nuvio + addon sources** | §3 keep-list — untouched |
| 3 | **Keep comic source, separate tabs** | §4 — `Comic` tab (ours) + `Manga` tab (VyseTV), both live |
| 4 | **Keep Flow tab** | §4 — untouched |
| 5 | **Copy sources show FIRST, embed fallback after** | §5 — chain: 39 scrapers → Movy → embed → dead |
| 6 | **Keep EmbedModal as last resort** | §5 — kept, but demoted to bottom of chain |
| 7 | **arm64 only** | §6 — single ABI, +40 MB AAR + 24 MB TorrServer |
| 8 | **Keep Sanka, use AniList for VyseTV fallback** | §7 — Sanka stays for Comic; AniList 816 LOC added |
| 9 | **Take BOTH players (mpv + Media3/ExoPlayer)** | §8 — doubles the native work, itemised |
| 10 | **Add TorrServer** | §9 — verified viable, 3-method plugin |
| 11 | **Copy P2P working method** | §9 — the tuned settings, extracted verbatim |

---

## 2. Licence — GPL-3.0

| # | Item |
|---|---|
| 2.1 | Add `LICENSE` — GPL-3.0 text verbatim |
| 2.2 | Add `NOTICE` — VyseTV, **Plezy** (edde746, GPL-3.0), **TorrServer** (YouROK, GPL-3.0), **PlayTorrio** (GPL-3.0), Vyla SDK, mpv/FFmpeg/libass, Anime4K/ArtCNN/NVScaler, TMDB, AniList, TheIntroDB |
| 2.3 | Keep every original copyright header on copied files; preserve VyseTV's `// VyseTV` markers |
| 2.4 | `package.json` → `"license": "GPL-3.0-only"` |
| 2.5 | README licence section + source-offer statement for APK distribution |

⚠ Verify each `lib/dpad/*` file's header — VyseTV's README says only *some* dpad files come from Plezy.

---

## 3. What stays exactly as-is

`services/nuvioService.ts`, `nuvioWorker.ts`, `stremioService.ts`, `playtorrioScrapers.ts`,
`sankaService.ts`, `comickService.ts`, `mangaService.ts`, `flowService.ts`,
`components/FlowView.tsx`, `NuvioExplorer.tsx`, `StremioExplorer.tsx`, `SankaExplorer.tsx`,
`AnimeView.tsx`, `ExtensionsView.tsx`, `AddonHomeRows.tsx`, `services/embedProviders.ts`,
`embedUpdates.ts`, `components/EmbedModal.tsx`, `public/embed-providers.json`,
`services/sourcePreferences.ts`, `torrentStreamingService.ts`, all `hooks/`, all `data/`.

**Rule:** VyseTV layers are **added alongside** ours. They never replace a working source.

---

## 4. Navigation — the new tab structure

You asked for separate Comic and Manga tabs. Current `types.ts` has 13 views; this becomes 18.

| Tab | id | Backed by | Status |
|---|---|---|---|
| Home | `home` | TMDB | unchanged |
| Discover | `discover` | TMDB | unchanged |
| Live TV | `livetv` | **VyseTV, complete** | replaced |
| Anime | `anime` | Sanka anime + AniList | extended |
| **Comic** | `comic` | **ours — Sanka comics (bacakomik, komikindo, shinigami, kiryuu) + Comick** | **new tab, your existing code** |
| **Manga** | `manga` | **VyseTV — WeebCentral** | **new tab** |
| Music | `music` | **VyseTV — YT Music + Deezer** | replaced |
| Audiobooks | `audiobooks` | **VyseTV — 8 sites** | replaced |
| Books | `books` | Open Library / archive.org | unchanged |
| **Flow** | `flow` | **ours — YouTube** | **kept untouched** |
| Explore | `explore` | ours | unchanged |
| My Library | `library` | ours | unchanged |
| Extensions | `extensions` | ours (Nuvio + Stremio) | unchanged |
| Settings | `settings` | ours | extended |

Comic and Manga are genuinely different stacks, so two tabs is correct:

- **Comic** = Sanka aggregator (4 Indonesian sources) + Comick. Yours, unchanged.
- **Manga** = WeebCentral direct scrape. VyseTV's, new.

`components/Navigation.tsx` needs new ids. `AppView` in `types.ts` gets `'comic' | 'manga'`.

---

## 5. Source priority chain (your instruction #5)

**New order, top to bottom. This is the whole point of the change.**

```
1. VyseTV's 39 scrapers + Movy (17 servers)     ← FIRST, always
2. VyseTV debrid (RD/AD/Premiumize/DL/TorBox)   ← then
3. TorrServer (P2P, if enabled)                 ← then
4. Nuvio + Stremio addons (ours)                ← then
5. EmbedModal iframe fallback (ours)            ← LAST RESORT only
6. "No source found" + manual retry
```

Today the embed iframe is the *primary* path. After this it is **step 5** — reached only when
steps 1–4 all return nothing.

**Implementation:** a single `SourceOrchestrator` in `services/sources/orchestrator.ts` that
walks the chain, emits results progressively (first answer wins, rest keep loading), and calls
the embed chain only on a total miss. `EmbedModal` itself is **unchanged** — it just gets a
different call site.

---

## 6. Build changes (arm64-only)

| Setting | Now | After |
|---|---|---|
| `minSdk` | 24 | **25** (AAR requirement; drops Android 7.0, keeps 7.1) |
| `compileSdk` / `targetSdk` | 36 / 36 | 36 / 36 |
| Kotlin plugin | absent | **added** (2.x, for coroutines) |
| CMake | absent | **added** (3.22.1) |
| NDK | absent | **28.2.13676358** |
| **`abiFilters`** | none | **`arm64-v8a` only** |
| AGP | 8.13.0 | 8.13.0 (stay unless the AAR refuses) |

**APK size:**

| Component | arm64 bytes |
|---|---|
| mpv-android AAR (libmpv + FFmpeg + libc++) | 53.9 MB (compressed ~40 MB) |
| TorrServer binary | 64.4 MB (compressed ~24 MB) |
| media3 + cronet (for ExoPlayer) | ~8 MB |
| libass (built from source) | ~2 MB |
| **Total added** | **~74 MB installed** |

⚠ Single-ABI arm64 means **no x86 emulator support** and **no 32-bit devices**. Confirm that's OK.

---

## 7. Manga / Comic / Anime split (your instruction #8)

| Tab | Source | Files |
|---|---|---|
| **Comic** | Sanka comics + Comick (**kept**) | `sankaService.ts` 1,292, `comickService.ts` 375, `mangaService.ts` 220, `SankaExplorer.tsx` |
| **Manga** | WeebCentral (**new**) | `manga_service.dart` 500, `manga_reader_page.dart` 975, `manga_details_page.dart` 384, `manga_page.dart` 331, `manga_library.dart` 229, 2 models |
| **Anime** | Sanka anime + **AniList (new)** | `anilist.dart` 816 — supplies `anilistId`, `mal`, `kitsu`, cover, banner, genres, relations |

`anilist.dart` is **added, not substituted** — it fills the metadata gap when a VyseTV scraper
returns a title that can't be matched to TMDB. It writes into the existing
`animeService.ts` id fields (`types.ts:53`, `:299-302`).

---

## 8. Both players (your instruction #9)

VyseTV ships **two** engines and picks per device. We take both.

### 8a. mpv engine

| What | Files | LOC |
|---|---|---|
| `mpv/MpvPlayerCore.kt` + 11 policy files | 12 | 5,273 |
| `shared/` (AudioFocus, FrameRate, SurfaceHost, SurfacePlayerCore, DeviceQuirks…) | 13 | 1,343 |
| `MpvPlayerPlugin.kt` | 1 | ~700 → **rewrite** for Capacitor |
| Dart side (`lib/mpv/player/*`) | ~18 | 8,953 → port to TS |

**Verified: zero Flutter in the cores.** Only 5 of 68 Kotlin files import `io.flutter`, all
channel wrappers.

### 8b. Media3 / ExoPlayer engine

| What | Files | LOC |
|---|---|---|
| `exoplayer/` (ExoPlayerCore + 33 files: DoviBridge, PgsCompositionParser, TrueHdMatPacker, DtsHdIecPacker, AudioNormalizationEffect, ZlibMatroskaExtractor, DownmixMatrices, all the *Policy.kt) | 34 | 12,878 |
| `ExoPlayerPlugin.kt` | 1 | ~900 → **rewrite** |
| `android/libass/` (the ASS renderer) | 21 Kotlin + 1,146 C | 3,500 |
| `app/src/main/cpp/dovi_bridge.cpp` | C++ | Dolby Vision |
| `app/src/main/cpp/media3_ffmpeg_decoder/ffmpeg_jni.cc` | C++ | FFmpeg audio |
| Gradle: media3 1.11.0 (exoplayer, hls, dash, ui, common, decoder), cronet-embedded 143.7445.0 | — | — |

**Which engine when** (`data/playback/player_engine.dart:33`): default on Android TV is
**Media3**; mpv is opt-in. Selector in Settings → Playback → Player engine.

### 8c. The one unproven thing — surface compositing

Flutter embeds native views as *platform views*. Capacitor draws everything in a **WebView**.
A `SurfaceView` under a WebView is a different problem:

- `SurfaceView` + `setZOrderMediaOverlay(true)` → video sits **above** the UI
- `TextureView` → composites correctly but **loses HDR** (defeats mpv's purpose)

**Proposed:** add the `SurfaceView` to the Activity root **behind** the WebView, make the WebView
transparent, cut a transparent CSS hole for the video rect, position the surface via
`setX/setY/LayoutParams` driven by the WebView reporting its rect over the bridge.

**→ P0 spike required (1–2 days).** Play one file through the AAR with a React button on top.
If it works, the port is mechanical. If not, we stay on LibVLC.

---

## 9. TorrServer + the P2P method (your instruction #10, #11)

### What TorrServer is

A Go torrent engine that runs as a **separate process** next to the app, exposes a REST API on
`127.0.0.1`, downloads pieces in the order the player reads them, and hands the player a local URL.

### Verified facts

| Item | Value |
|---|---|
| Engine binary | `torrserver-android-arm64` — 64,423,136 bytes |
| Zipped | 23,793,583 bytes, sha256 `0b2a7c486b6ecf74e98d9463e6ca9d77bc3523e4ee70200e7efd29b76c3f8f71` |
| Source | `packages/torrserver_flutter/binaries/torrserver-android-arm64.zip` (in repo) |
| REST client | 278 LOC, 10 endpoints (`/torrents`, `/stream`, `/settings`, `/echo`) |
| Android plugin | **only 3 methods**: `startForegroundService`, `stopForegroundService`, `getNativeLibraryDir` |
| Binary launch | extracted from `nativeLibraryDir` / assets, `chmod 755`, run as child process |
| Lifetime | tied to app process; dies with it |
| Cache | **memory only** (`UseDisk: false`), wiped on stop and before start |

### The tuned settings — this is the "working method" (copy verbatim)

From `lib/data/sources/torrents.dart:122-156`. These are measured, not guessed:

```
CacheSize            256 MB phone / 1024 MB desktop
ReaderReadAHead      95 %      ← big read-ahead window
PreloadCache         2 %       ← start playing at 2%, not 50%
ConnectionsLimit     150 phone / 300 desktop
EnableIPv6           FALSE     ← measured: on = 1.3–2.4 MB/s + stalls; off = 4.1–4.8 MB/s
RetrackersMode       1         ← extra public trackers on every torrent
ResponsiveMode       true
ForceEncrypt         false     ← encryption turns peers away
EnableLPD            true      ← local peer discovery
DisableUPNP          false
DisableDHT           false
DisablePEX           false
DisableUpload        false     ← uploading gets you more peers
TorrentDisconnectTimeout  120 s  ← survives pause/seek-back
EnableDLNA / EnableBonjour  false
UseDisk              false     ← memory only, nothing persisted
RemoveCacheOnDrop    true
```

The IPv6 note is the single most valuable line in the file: *"measured on a large public
torrent: with it on, 1.3–2.4 MB/s and nothing for the first 10–16 s, then a stall; off,
4.1–4.8 MB/s and data within ~8 s every time."*

### Port shape

| Piece | Action |
|---|---|
| `torrserver-android-arm64` binary | ship in `android/app/src/main/assets/` (~24 MB compressed) |
| `TorrServerForegroundService.kt` | copy (pure Android, no Flutter) |
| `rest_client.dart` (278 LOC) | port to `services/p2p/torrServerClient.ts` |
| `torrents.dart` (485 LOC) | port to `services/p2p/torrents.ts` — the tuned settings above |
| `torrent_file_pick.dart` (250 LOC) | port — picks the right file from a multi-file torrent |
| `p2p_consent.dart` | port — the "peers see your IP" dialog |
| Android plugin | **rewrite** 3 methods for Capacitor |

**Coexistence with WebTorrent:** both stay. `torrentStreamingService.ts` (WebTorrent) handles
browser/PWA; TorrServer handles Android native. A setting picks which, defaulting to TorrServer
on Android because it has the seek-ahead piece ordering.

---

## 10. Live TV — complete (unchanged from v2)

12,164 LOC across 19 files. Replaces `iptvService.ts` (1,888), `m3uWorker.ts`,
`liveTvPrefs.ts`, `LiveTvView.tsx`, `live-tv.css`.

Ten behaviours: portal browser with preview pane · match finder (EPG around kick-off) · ESPN
sports schedule · per-portal favourites · EPG now/next · M3U multi-playlist with
`{added, skipped, failed}` · 84 hardcoded channels + keyword scanner · paste-site discovery +
PasteSh AES-CBC · appearance settings · Xtream/M3U group trees.

**Kept from ours:** the virtualised channel list — theirs isn't virtualised and ours handles
large playlists better. Merge.

---

## 11. Music — source + layout

**Source:** `yt_music.dart` (864, InnerTube browse) · `youtube_audio_extractor.dart` (997) ·
`youtube_rate_limit_guard.dart` (123) · `deezer_api_client.dart` (296) ·
`lyrics_service.dart` (179) · `music_player.dart` (553) · `music_library.dart` (348) ·
`music_track.dart` (535).

**Layout** (`screens/music/`, 4,992 LOC) — this is what you asked for:

| File | LOC | Gives us |
|---|---|---|
| `music_shell.dart` | 977 | left sidebar + segment tabs + top search pill + **persistent bottom `MusicBar`** (inline progress) + **slide-out `_QueuePanel`** |
| `music_pages.dart` | 1,152 | Artist / Album / Playlist / My Playlist / Liked / Library / Browse / Mood / History |
| `music_page.dart` | 888 | home |
| `music_ui.dart` | 830 | shared widgets |
| `music_player_page.dart` | 669 | full-screen now-playing |
| `music_detail_pages.dart` | 476 | |
| `widgets/music_widgets.dart` | 661 | |

Replaces `components/music/` (3 files) + `components/MusicView.tsx`.

**Verified live:** the InnerTube endpoint answers `200` for `WEB_REMIX` with the documented
headers.

---

## 12. Audiobooks — 8 sites

`audiobook_scraper_service.dart` (420) · `audiobook_player.dart` (363) · `audiobook_model.dart`
(~80) · 3 screens (901) · `audiobook_widgets.dart` (294).
Chapter bookmarks, waveform seek bar, background progress.

**Live-checked today:**

| Site | Status |
|---|---|
| goldenaudiobooks.com | **200** |
| hotaudiobooks.com | **200** |
| audioaz.com | **200** |
| audiobooks4soul.com | **403** |
| fulllengthaudiobooks / bookaudiobooks / audiozaic / audionest | not re-checked |

⚠ `audiobooks4soul` is behind Cloudflare right now. It ships but may need the native fetch
path (`nativeFetchText`) that our `androidBridge.ts` already provides.

---

## 13. ⚠ WeebCentral — pre-existing risk, now confirmed

Both codebases fight this site and **both may be losing**:

- Our `sankaService.ts:18-20` says: *"weebcentral.com itself blocks non-browser scraping (403)
  — those were removed after users hit 'No comics found'."*
- I just tested VyseTV's exact endpoint with its exact UA:
  `search/data` → **307 redirect → `/400`**. Cloudflare in front.
- VyseTV's own comments in `hardcoded_channels.dart` and elsewhere acknowledge Source: `MangaService`
  needs a browser-like UA and still gets challenged.

**Conclusion: WeebCentral may not work from a plain fetch.** Options:

1. **Test before building** — try WeebCentral through our existing `nativeFetchText` bridge
   (which passes real Android WebView cookies/UA). This is the most likely fix.
2. If it still fails, fall back to our own Comick for the Manga tab too, and keep VyseTV's
   *reader UI* (which is the valuable part — 975 LOC of webtoon/paged modes).

**Recommendation:** build the Manga tab around VyseTV's **reader and library UI**, with the
source behind an interface. WeebCentral first, Comick second. That way the tab works either way.

---

## 14. Build order

| Phase | Work | Days |
|---|---|---|
| **P0** | GPL files · **mpv SurfaceView spike** · **WeebCentral reachability test** | 3 |
| **P1** | Build plumbing: Kotlin, CMake, NDK, arm64, AAR, media3, libass, TorrServer asset | 3 |
| **P2** | Foundations: themes, configurable navbar, platform detector, typed prefs | 3 |
| **P3** | **mpv** engine — copy cores, Capacitor channel, Dart→TS player | 10 |
| **P4** | **Media3/ExoPlayer** engine — copy 34 files, libass module, FFmpeg JNI, dovi bridge | 10 |
| **P5** | **TorrServer** — binary, service, REST client, tuned settings, file picker | 5 |
| **P6** | **Live TV** complete | 10 |
| **P7** | **Sources** — 39 scrapers + Movy + debrid + Knaben + badges + orchestrator + embed demotion | 10 |
| **P8** | **Comic/Manga split** + AniList | 6 |
| **P9** | **Audiobooks** 8 sites | 4 |
| **P10** | **Music** source + layout | 8 |
| **P11** | D-pad focus engine | 7 |
| **P12** | Verify: tsc, vitest, vite build, assembleDebug, install, test | 5 |

**~74 working days ≈ 3.5 months of sessions on this phone.**

---

## 15. Honest risk list

| Risk | Likelihood | Mitigation |
|---|---|---|
| **SurfaceView behind WebView doesn't composite** | Medium | P0 spike before committing 20 days to P3+P4 |
| **WeebCentral blocked by Cloudflare** | **High** (already 307→400) | Test in P0; keep Comick as fallback behind the same reader UI |
| **TorrServer binary won't exec from APK on Android 10+** | Low-medium | It's already proven in VyseTV's Android build; `nativeLibraryDir` path is the known-good route |
| **libass CMake fetch fails** | Low | It downloads a pinned fork with a SHA-256 check; we have the CMake file |
| **Single-ABI breaks someone's device** | Low | arm64 covers ~95%+; document it |
| **+74 MB APK** | Certain | Accept, or ship a "lite" build without the players |
| **This phone can't build it** | **Medium-high** | Previous builds took hours; 4 native ABIs → 1 helps a lot, but expect failed builds |

---

## 16. What I need before starting

1. **Approve the plan** — then I start at P0 (licence + spike + WeebCentral test).
2. **Confirm single-ABI arm64** — no x86 emulator, no 32-bit devices.
3. **Confirm `minSdk 25`** — drops Android 7.0.
4. **Confirm the Manga-tab fallback** — if WeebCentral is blocked, run the VyseTV reader on
   Comick instead. Yes/no?
5. **TorrServer vs WebTorrent default on Android** — I propose TorrServer (better seek-ahead),
   WebTorrent stays for browser.

P0 alone will answer the two questions that decide whether P3/P4 and P8 are worth 30 days.
I'd rather spend 3 days proving it than 30 days discovering it.
