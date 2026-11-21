# VyseTV → PRAHA STREAM — Port Plan v2 (for approval)

Source: `https://gitlab.com/ayman707-ux/vysetv` @ depth 1, cloned to `/tmp/vysetv_probe`
Plan date: 2026-11-20
**Status: awaiting your approval. Nothing is being changed yet.**

---

## Your decisions, as I understood them

| # | Your instruction | How this plan handles it |
|---|---|---|
| 1 | Adopt GPL-3.0 | Section 1 — licence work items |
| 2 | Keep Nuvio + Stremio addon sources, do not remove | Section 2 — explicit keep-list |
| 3 | Copy everything from the GitLab repo | Section 3 — full inventory, 4 groups |
| 4 | Remove manga built-in source and embed-link sources, put VyseTV's there | Section 4 — deletion list |
| 5 | Take Live TV source completely | Section 5 |
| 6 | Take the mpv player | Section 6 — the risky one, now verified |
| 7 | Take audiobook source | Section 7 |
| 8 | Take manga source | Section 7 |
| 9 | Take music source and layout | Section 7 |

**Please confirm 4 and 6 especially** — those are the two that delete working code and add a
native build step. Details in Section 9.

---

## 1. Licence — GPL-3.0 adoption

VyseTV is GPL-3.0 (`LICENSE`, 35,149 bytes, full GNU GPL v3 text). PRAHA STREAM has **no
LICENSE file at all** right now, which legally means all-rights-reserved. Adopting GPL-3.0 lets
us copy code directly instead of rewriting it — which is what you asked for.

**Work items:**

| # | Item | Detail |
|---|---|---|
| 1.1 | Add `LICENSE` | Copy the GPL-3.0 text verbatim |
| 1.2 | `NOTICE` file | Must credit: VyseTV authors, **Plezy** (edde746, GPL-3.0), **TorrServer** (YouROK, GPL-3.0), **PlayTorrio** (GPL-3.0), Vyla SDK, mpv/FFmpeg/libass, Anime4K/ArtCNN/NVScaler, TMDB, AniList, TheIntroDB |
| 1.3 | Per-file headers | Every file copied from VyseTV keeps its original copyright line. VyseTV marks its own additions with `// VyseTV` — preserve those markers |
| 1.4 | README licence section | State GPL-3.0, link the source, note that APK distribution carries a source-availability obligation |
| 1.5 | `pubspec`/`package.json` licence field | `"license": "GPL-3.0-only"` |

**Obligation you're accepting:** anyone you give an APK to can demand the full source. Your
repo already is the source, so this is satisfied — but the repo must stay public or you must
ship source with the APK.

**⚠ One thing to check:** VyseTV's README says their `lib/media_servers` and `lib/mpv` are
adapted from **Plezy**, also GPL-3.0. That is compatible. But `lib/dpad` says only *some* files
come from upstream — verify each file's header before copying, because a file with no licence
header and no upstream attribution may not be theirs to relicense.

---

## 2. What we KEEP (your instruction #2)

These stay exactly as they are. Nothing in this plan touches them:

- `services/nuvioService.ts`, `services/nuvioWorker.ts`
- `services/stremioService.ts`
- `services/playtorrioScrapers.ts`
- `components/NuvioExplorer.tsx`, `components/StremioExplorer.tsx`
- `components/ExtensionsView.tsx`, `components/AddonHomeRows.tsx`
- `services/sourcePreferences.ts`, `services/debridService.ts` (we add to it, not replace)
- `services/torrentStreamingService.ts` (WebTorrent stays)
- All of `components/`, `hooks/`, `data/` except what Section 4 lists for deletion

**Rule for the whole port:** VyseTV's sources are **added alongside** the Nuvio/addon ones,
never instead of them. In the source picker they appear as an extra group.

---

## 3. Full inventory of what comes over

### Group A — Live TV (complete, 12,164 LOC)

| VyseTV file | LOC | Goes to |
|---|---|---|
| `services/iptv/iptv_controller.dart` | 1,242 | `services/liveTv/controller.ts` |
| `services/iptv/iptv_network.dart` | 1,205 | `services/liveTv/network.ts` |
| `services/iptv/hardcoded_channels.dart` | 1,620 | `services/liveTv/hardcodedChannels.ts` |
| `services/iptv/iptv_settings.dart` | 364 | `services/liveTv/settings.ts` |
| `services/iptv/iptv_storage.dart` | 349 | `services/liveTv/storage.ts` |
| `services/iptv/m3u_parser.dart` | 118 | `services/liveTv/m3uParser.ts` |
| `services/iptv/m3u_store.dart` | 71 | `services/liveTv/m3uStore.ts` |
| `services/iptv/pastesh_decryptor.dart` | 127 | `services/liveTv/pastesh.ts` |
| `data/live_tv/*.dart` (9 files) | 1,541 | `services/liveTv/*` |
| `models/iptv/*.dart` (2 files) | 270 | `types/liveTv.ts` |
| `screens/live_tv/*.dart` (7 files) | 5,110 | `components/liveTv/*` |

**Replaces:** `services/iptvService.ts` (1,888 LOC), `services/m3uWorker.ts`,
`services/liveTvPrefs.ts`, `components/LiveTvView.tsx`, `components/live-tv.css`.
**Kept from ours:** the virtualised channel list (`react-window`-style) — their list is not
virtualised and ours handles large playlists better. Merge, don't discard.

### Group B — mpv player (5,273 LOC Kotlin + 8,953 LOC Dart)

**Verified finding: the mpv core has zero Flutter dependencies.**

```
android/app/src/main/kotlin/com/vyse/player/
  mpv/       13 files, 5,273 LOC  → imports com.edde746.mpv.* (the AAR), pure Android
  shared/    13 files, 1,343 LOC  → AudioFocus, FrameRate, Surface host, DeviceQuirks
  exoplayer/ 34 files, 12,878 LOC → media3 fallback, needs the libass module
```

Only **5 of 68** Kotlin files import `io.flutter`, and all five are channel-binding wrappers
(`MpvPlayerPlugin`, `ExoPlayerPlugin`, `PlayerChannelBinding`, `ExternalPlayerChannel`). The
cores themselves (`MpvPlayerCore`, `SurfacePlayerCore`) are plain Android.

That means: **port the cores unchanged, rewrite only the channel layer for Capacitor.**

| VyseTV file | LOC | Action |
|---|---|---|
| `mpv/MpvPlayerCore.kt` | ~1,400 | **copy as-is** |
| `mpv/MpvOperationQueue.kt`, `DecoderHold.kt`, `DecoderOptions.kt`, `DemuxerBudget.kt`, `EglHdrCaps.kt`, `OsdPlanePolicy.kt`, `PresentedFrameRate.kt`, `SurfaceFrameRateVote.kt`, `MpvPropertyFailure.kt`, `MpvEndFileDiagnostics.kt`, `DecoderOperatingRate.kt` | ~3,900 | **copy as-is** |
| `shared/AudioFocusManager.kt`, `FrameRateManager.kt`, `PlayerSurfaceHost.kt`, `SurfacePlayerCore.kt`, `DeviceQuirks.kt`, `DisplayModeSelector.kt`, `PlayerDebugLog.kt`, `PlayerDelegate.kt`, `MpvContentUriResolver.kt` | ~1,343 | **copy as-is** |
| `mpv/MpvPlayerPlugin.kt` | ~700 | **rewrite** → `PrahaMpvPlugin.kt` (Capacitor `Plugin` + `MessageChannel`) |
| `lib/mpv/player/player_base.dart` | 1,775 | port to `services/mpv/playerCore.ts` |
| `lib/mpv/player/player_native.dart` | 1,407 | port to `services/mpv/native.ts` |
| `lib/mpv/player/platform/player_android_mpv.dart` | — | port to `services/mpv/android.ts` |
| `lib/mpv/models.dart` + `models.freezed.dart` | ~2,800 | port to `types/mpv.ts` |
| `lib/mpv/extras/picture_effects.dart`, `pip.dart`, `display_match.dart`, `external_player.dart` | — | port |
| `lib/mpv/support/*` (5 files) | — | port |

**Native build dependency — verified downloadable:**
```
mpv-android-d633bbc71269.aar   53,934,545 bytes
https://github.com/edde746/mpv-build/releases/download/binaries-f78e66727714/
checksum 4bf8a9720bfdec00cb854fc73095ee3d322afc3caaa66d6322ad1dd4abc69df7
```
Pulled through a Gradle Ivy repository (no metadata, no auth). Needs **NDK + CMake** for
`dovi_bridge.cpp` (Dolby Vision) and the FFmpeg JNI adapter.

**Build config deltas in our project:**

| Setting | Ours | VyseTV | Action |
|---|---|---|---|
| `minSdk` | 24 | 25 | **bump to 25** (drops Android 7.0; 7.1 is the floor) |
| `compileSdk` | 36 | 36 | same |
| AGP | 8.13.0 | 9.1.0 | stay on 8.13 unless the AAR refuses |
| Kotlin | not applied | 2.4.0 | **add Kotlin plugin** (coroutines in the cores) |
| CMake | absent | required | **add** |
| ABI split | single | 4 ABIs | decide: `arm64-v8a` only, or all |

**APK size impact:** the AAR carries libmpv + FFmpeg for 4 ABIs. Expect **+40 MB arm64-only**,
**+110 MB** with all four.

### Group C — Sources (manga, audiobooks, music, films)

| VyseTV source | LOC | Replaces |
|---|---|---|
| `services/manga/manga_service.dart` → **WeebCentral** | 500 | `services/mangaService.ts`, `services/sankaService.ts`, `services/comickService.ts` |
| `services/audiobook/audiobook_scraper_service.dart` → **8 sites** | 420 | `services/audiobookService.ts`, `services/bookracyService.ts` |
| `services/music/youtube_audio_extractor.dart` | 997 | `services/youtubeService.ts`, `services/youtubeMirror.ts` |
| `services/music/youtube_rate_limit_guard.dart` | 123 | new |
| `services/music/deezer_api_client.dart` | 296 | new (metadata source) |
| `services/music/lyrics_service.dart` | 179 | `services/lyricsService.ts` |
| `data/music/yt_music.dart` (YouTube Music browse) | 864 | new |
| `data/sources/film_sources/scrapers.dart` → **39 sources** | 3,091 | `public/embed-providers.json` + `services/embedProviders.ts` |
| `data/sources/film_sources/film_sources.dart` | ~400 | new |
| `data/sources/film_sources/common.dart` | ~300 | new |
| `data/sources/film_sources/source_settings.dart` | ~150 | `services/sourcePreferences.ts` (merge) |
| `data/sources/debrid/*` (5 providers + 2 utils) | ~1,300 | `services/debridService.ts` (merge) |
| `data/sources/knaben.dart` | 229 | new |
| `data/sources/badges.dart` | ~300 | `services/badgeRules.ts` (merge) |
| `data/sources/torrent_file_pick.dart`, `torrent_file_ask.dart` | ~250 | new |
| `data/sources/addons.dart` | 808 | `services/stremioService.ts` (merge — keep ours working) |

**The 8 audiobook sites:** goldenaudiobooks, fulllengthaudiobooks, hotaudiobooks,
bookaudiobooks, audiozaic, audioaz, audiobooks4soul, audionest (Firebase-backed).

**The 39 film scrapers:** CNO, VidUp, 111477, VidLink, VidBolt, RiveStream, 3EyedRaven, VidLux,
Vidly, PurStream, FSOnline, Castle, NetPlayz, MeowTV, CinemaArmy, VidZee, YaStream, LookMovie,
VidCore, CineBros, ThugTV, FrameXTV, LMScript, VidQueen, WatchOut, VidSpark, Willow, TrendiMovies,
VidVault, Torrentio, BraFlix, MovieBox, VixSrc, AniZone, ANV, 123Anime, Hexa, CineSrc, Mapple
— plus **Movy** (17 built-in servers, not a scraper).

### Group D — Supporting layers

| Layer | LOC | Why it's needed |
|---|---|---|
| `data/subtitles/*` (3 files) | 1,042 | subtitle styling + CP1250-1257/874 decoding |
| `data/playback/stream_proxy.dart` | 522 | local relay for header-gated streams |
| `data/playback/intro_db.dart` | ~200 | skip intro/recap/preview/credits |
| `data/playback/watch_progress.dart` | 247 | progress + resume |
| `data/net.dart` | — | DNS-over-HTTPS rescue for blocked hosts |
| `data/app_settings.dart` | 235 | the typed preference system |
| `core/theme.dart`, `nav_sections.dart`, `platform/*` | ~1,000 | themes, configurable navbar, TV detection |
| `dpad/*` (21 files) | 4,818 | focus engine — needed for the new player's remote support |
| `screens/music/*` (6 files) | 4,992 | **music layout** (your instruction #9) |
| `screens/manga/*` (4 files) | 1,800 | reader modes |
| `screens/audiobooks/*` (3 files) | 901 | audiobook player |

---

## 4. What gets DELETED (your instruction #4)

These are the embed-link sources and the current manga stack. **Confirm each line.**

| Delete | LOC | Replaced by |
|---|---|---|
| `services/embedProviders.ts` | 67 | 39 VyseTV scrapers + Movy |
| `services/embedUpdates.ts` | ~40 | VyseTV source settings |
| `components/EmbedModal.tsx` | 163 | `components/SourcesPanel.tsx` (new) |
| `public/embed-providers.json` | 1 file | gone |
| `services/mangaService.ts` | 220 | WeebCentral |
| `services/sankaService.ts` | 1,292 | WeebCentral |
| `services/comickService.ts` | 375 | WeebCentral |
| `services/archiveService.ts` | 241 | (keep? it also serves books — see note) |
| `components/SankaExplorer.tsx` | — | `components/MangaView.tsx` (new) |
| `components/AnimeView.tsx` | — | keep, anime is separate from manga |
| `components/ArchiveReader.tsx` | — | `components/MangaReader.tsx` (new) |
| `tests/playtorrio-scrapers.test.ts` embed assertions | 2 tests | rewrite against new sources |

**Note on `archiveService.ts`:** it serves the Books tab as well as comics. Deleting it breaks
Books. I recommend **keeping it for Books only** and deleting just its comic paths. Your call.

**Note on `sankaService.ts`:** 1,292 LOC is the largest single deletion. It also feeds anime
metadata (`anilistId`, `mal`, `kitsu` fields in `types.ts`). Confirm anime metadata survives
before deleting — VyseTV's AniList client (`data/anime/anilist.dart`, 816 LOC) would replace it,
but that is extra scope.

---

## 5. Live TV — complete replacement

Already itemised in Group A. The specific behaviours that come with it:

1. **Portal browser with live preview pane** (`portal_browser_page.dart`, 1,990) — categories on
   one side, player on the other, per portal
2. **Match finder** — reads each candidate channel's EPG around kick-off to find which feed
   actually has the game (144 LOC)
3. **Sports schedule** — ESPN public scoreboard, fixtures + live scores (280 LOC)
4. **Favourites per portal** — same channel on two portals = two separate favourites (130 LOC)
5. **EPG now/next** — cached per-stream guide wired into channel rows (211 LOC)
6. **M3U multi-playlist manager** — named playlists, add URL or paste, returns
   `{added, skipped, failed}`, delete (189 LOC)
7. **84 curated hardcoded channels** + keyword scanner + per-portal hit cache (1,620 LOC)
8. **Paste-site portal discovery** + PasteSh AES-CBC decryptor (1,205 + 127 LOC)
9. **Appearance settings** — hero, card density, HD badge, default tab, browser layout (364)
10. **Xtream + M3U group trees**, cached per portal (1,242)

---

## 6. The mpv player — technical detail and the one real risk

### Why this is feasible

The Kotlin cores are pure Android. `MpvPlayerCore` imports:

```
android.*, android.view.SurfaceView, android.media.AudioAttributes
com.edde746.mpv.*          ← the mpv-android AAR's Kotlin API
com.vyse.player.shared.*   ← their own shared layer
kotlinx.coroutines.*
```

No `io.flutter` anywhere. The only Flutter code is the plugin wrapper, which is ~700 lines of
`MethodChannel`/`EventChannel` plumbing we replace with Capacitor's `Plugin` + `PluginCall`.

### The risk: surface compositing

Flutter draws video through a *platform view* (a native view embedded in the Flutter scene).
Capacitor draws the UI in a **WebView**. Putting a `SurfaceView` under/over a WebView is a
different problem:

- `SurfaceView` with `setZOrderMediaOverlay(true)` sits **above** the WebView — video covers the
  UI, so our controls must be drawn natively or the WebView must be made transparent in the
  video rect.
- `TextureView` composites into the view hierarchy but **loses HDR** and adds a copy — which
  defeats the reason for using mpv.

**Proposed approach (needs a spike before committing):**

1. Add the `SurfaceView` to the Activity's content root, **behind** the WebView.
2. Set the WebView background transparent and give the React player shell a transparent
   "hole" where the video goes (a CSS `background: transparent` region).
3. Position the `SurfaceView` to match that rect via `setX/setY/setLayoutParams`, driven by the
   WebView reporting its rect through the Capacitor bridge.
4. Overlays (controls, subtitles drawn by the WebView) stay in the WebView on top.

This is a known-working pattern for hybrid apps, but it is **not** what VyseTV does and it needs
to be proven on a real device before we spend 2 weeks on it.

**Recommendation: a 1–2 day spike first.** Build a minimal Capacitor app that puts a
`SurfaceView` behind the WebView, plays one file with the AAR, and shows a React button on top.
If that works, the rest of the port is mechanical. If it doesn't, we fall back to LibVLC (which
we already ship) and lose HDR/passthrough but keep the entire UI layer.

### What mpv buys us that LibVLC doesn't

- Real HDR (HDR10 / Dolby Vision via `dovi_bridge.cpp`)
- TrueHD / DTS-HD / Atmos bitstream passthrough to a receiver
- The `MpvOperationQueue` + `DecoderHold` logic that prevents decoder hangs
- Frame-rate matching (`SurfaceFrameRateVote`, `PresentedFrameRate`)
- ASS subtitle rendering with full styling

### What we skip

- `android/libass/` (the C++ ASS renderer, 4 Kotlin files + CMake) — **only** the ExoPlayer
  fallback needs it. mpv renders ASS itself. Skip unless we also port ExoPlayer.
- `android/app/src/main/cpp/media3_ffmpeg_decoder/` — Media3-only.
- `exoplayer/` (34 files, 12,878 LOC) — a second full player. Not requested. Skip.
- Anime4K / ArtCNN / NVScaler GLSL shaders (3.3 MB) — these *would* work under mpv, but they are
  a separate scope. Flag as optional Phase 7.

---

## 7. Manga, audiobooks, music

### Manga → WeebCentral (`weebcentral.com`)

| VyseTV | LOC | Notes |
|---|---|---|
| `services/manga/manga_service.dart` | 500 | search, popular, genres, series detail, chapter list, chapter images, progress, likes, history |
| `models/manga/manga.dart` | 59 | |
| `models/manga/manga_chapter.dart` | 55 | |
| `data/manga/manga_library.dart` | 229 | saved series + per-chapter progress |
| `screens/manga/manga_page.dart` | 331 | browse |
| `screens/manga/manga_details_page.dart` | 384 | series detail |
| `screens/manga/manga_reader_page.dart` | 975 | **webtoon vs paged toggle, floating glass control bar, next-chapter deck, reader settings** |
| `screens/manga/manga_widgets.dart` | 110 | |

Endpoints: `/search/data`, `/series/{id}`, `/series/{id}/full-chapter-list`,
`/chapters/{id}/images`. Covers from `temp.compsci88.com`.

### Audiobooks → 8 sites

| VyseTV | LOC |
|---|---|
| `services/audiobook/audiobook_scraper_service.dart` | 420 |
| `data/audiobooks/audiobook_player.dart` | 363 |
| `models/audiobook/audiobook_model.dart` | ~80 |
| `screens/audiobooks/audiobooks_page.dart` | 242 |
| `screens/audiobooks/audiobook_details_page.dart` | 257 |
| `screens/audiobooks/audiobook_player_page.dart` | 402 |
| `widgets/audiobook_widgets.dart` | 294 |

Includes **chapter bookmarks, waveform seek bar, background progress service**, and per-site
chapter extraction (standard WordPress, audiozaic, audioaz, audiobooks4soul each need their own
path).

### Music → YouTube Music + Deezer

| VyseTV | LOC | What it is |
|---|---|---|
| `data/music/yt_music.dart` | 864 | YouTube Music InnerTube browse: search, home, artists, albums, playlists, charts, moods, radio |
| `services/music/youtube_audio_extractor.dart` | 997 | the full stream resolver |
| `services/music/youtube_rate_limit_guard.dart` | 123 | cooldown queue with a user message |
| `services/music/deezer_api_client.dart` | 296 | metadata (artists, albums, playlists) |
| `services/music/lyrics_service.dart` | 179 | LRC + synced |
| `data/music/music_player.dart` | 553 | queue, shuffle, repeat |
| `data/music/music_library.dart` | 348 | liked songs, playlists |
| `models/music/music_track.dart` | 535 | |

**Layout (your instruction #9) — `screens/music/`, 4,992 LOC:**

| File | LOC | What it gives us |
|---|---|---|
| `music_shell.dart` | 977 | sidebar + segments + top search pill + **bottom `MusicBar` with progress + queue panel** |
| `music_pages.dart` | 1,152 | Artist / Album / Playlist / My Playlist / Liked Songs / Library / Browse / Mood / History pages |
| `music_page.dart` | 888 | home |
| `music_ui.dart` | 830 | shared music widgets |
| `music_detail_pages.dart` | 476 | |
| `music_player_page.dart` | 669 | full-screen now-playing |
| `widgets/music_widgets.dart` | 661 | |

**This replaces our `components/music/` (3 files) + `components/MusicView.tsx`.** The layout is
the thing you asked for: a persistent bottom bar with inline progress and a queue drawer, plus a
left sidebar of segments — not a tab.

---

## 8. Build order

| Phase | What | Blocks |
|---|---|---|
| **P0** | GPL licence files + NOTICE + headers | everything (do first, 1 day) |
| **P1** | **mpv spike** — SurfaceView behind WebView, prove it on device | the whole player path |
| **P2** | Foundations: themes, configurable navbar, platform detector, typed prefs | everything else |
| **P3** | mpv core port (Kotlin copy + Capacitor channel rewrite + Dart→TS player) | — |
| **P4** | Live TV complete replacement | — |
| **P5** | Sources: 39 scrapers + Movy + 5 debrid + Knaben + badges, and **delete** embed fleet | — |
| **P6** | Manga (WeebCentral) + delete Sanka/Comick | — |
| **P7** | Audiobooks (8 sites) | — |
| **P8** | Music (YT Music + Deezer + lyrics + full layout) | — |
| **P9** | D-pad focus engine (needed for remote control of the new player) | — |
| **P10** | Optional: Anime4K/ArtCNN/NVScaler shaders | — |

P3 through P8 are independent — they can run in parallel if you want, but on this phone they
must be sequential.

---

## 9. Decisions I need before starting

### ⚠ 9.1 — The embed deletion (instruction #4)

You said remove the embed-link sources. Those are 21 providers in `services/embedProviders.ts`
plus `EmbedModal.tsx`. Removing them and adding 39 scrapers means:

- **Gain:** real playable streams instead of iframes that often fail
- **Lose:** the iframe fallback when every scraper fails
- **Question:** keep `EmbedModal` as a **last-resort fallback** (shown only when all scrapers
  return nothing), or delete it entirely? I recommend **keep as fallback** — it costs nothing
  and saves the odd title.

### ⚠ 9.2 — mpv ABI

Which ABIs? `arm64-v8a` only is +40 MB and covers ~95% of devices. All four is +110 MB.
I recommend **arm64-v8a + armeabi-v7a** (+70 MB), dropping x86 emulators.

### ⚠ 9.3 — minSdk 24 → 25

The AAR needs 25. That drops Android 7.0 (Nougat), keeps 7.1+. Confirm that's acceptable.

### ⚠ 9.4 — Sanka deletion collateral

`sankaService.ts` feeds anime metadata as well as manga. If we delete it, anime loses
`anilistId`/`mal`/`kitsu` enrichment unless we also port `data/anime/anilist.dart` (816 LOC).
**Port AniList too, or keep Sanka for anime metadata only?**

### 9.5 — ExoPlayer fallback

VyseTV ships **two** players: mpv and an ExoPlayer/Media3 one (12,878 LOC) with a libass
renderer. We are taking only mpv. If mpv fails on a device there is no fallback. Accept that, or
also port ExoPlayer (doubles the native work)?

### 9.6 — TorrServer

Not requested. We keep WebTorrent. Confirm.

---

## 10. Honest size estimate

| Group | LOC in | LOC out (TS/TSX) | Effort |
|---|---|---|---|
| Licence | — | — | 1 day |
| mpv spike | — | — | 1–2 days |
| Foundations | 1,000 | ~1,200 | 3 days |
| mpv player | 14,226 (Kotlin+Dart) | ~6,000 | 2 weeks |
| Live TV | 12,164 | ~9,000 | 2 weeks |
| Sources | ~7,750 | ~6,500 | 2 weeks |
| Manga | 1,800 + 843 | ~2,000 | 1 week |
| Audiobooks | 1,558 + 443 | ~1,600 | 4 days |
| Music | 4,992 + 3,961 | ~5,500 | 1.5 weeks |
| D-pad | 4,818 | ~4,000 | 1.5 weeks |
| **Total** | **~62,000** | **~36,000** | **~10–11 weeks** |

On this phone, building the APK alone takes hours. Realistically **3 months** of sessions.

---

## 11. Summary of what I'll do once you approve

1. Add `LICENSE` (GPL-3.0) + `NOTICE` crediting VyseTV, Plezy, TorrServer, PlayTorrio, Vyla
2. Run the **mpv SurfaceView spike** — report back before committing to the full port
3. Port foundations (themes, navbar, prefs, platform detection)
4. Copy the mpv cores unchanged, rewrite the channel layer for Capacitor
5. Replace Live TV wholesale, keeping our virtualised list
6. Add 39 scrapers + Movy + debrid + Knaben, delete the embed fleet
7. Replace manga with WeebCentral, delete Sanka/Comick (pending 9.4)
8. Replace audiobooks with the 8 sites
9. Replace music with YT Music + Deezer + their layout
10. Port the D-pad engine
11. Verify: `tsc --noEmit`, `vitest run`, `vite build`, `assembleDebug`, install and test

**Nothing is touched until you answer 9.1–9.6.**
