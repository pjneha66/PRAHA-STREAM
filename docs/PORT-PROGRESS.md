# VyseTV → PRAHA STREAM — port progress

_Last updated: 2026-11-20 23:35_

## Done and verified

### Phase 2.7 — NSFW toggle (three modes)

| File | Change |
|---|---|
| `types.ts` | `NsfwMode = 'off' \| 'on' \| 'only'`; `AppSettings.nsfw` |
| `data/defaults.ts` | `nsfw: 'off'`; `normalizeSettings` rejects unknown saved values |
| `services/nsfwGate.ts` | **new** — modes, Kids override, per-provider param mapping, Live TV filter, runtime context, UI copy |
| `components/SettingsView.tsx` | "Adult content" card: three segments, 18+ confirm on first enable, disabled for Kids profiles |
| `services/mangaService.ts` | `adult=${currentWeebCentralAdultParam()}` (was hardcoded `False`); added the required `HX-Request: true` header |
| `services/tmdbService.ts` | `include_adult` follows the toggle (2 call sites) |
| `services/iptvService.ts` | `filterChannelsForNsfw`; playlist cache keyed by mode |
| `App.tsx` | pushes the effective mode into the gate on settings/profile change |
| `tests/nsfw-gate.test.ts` | **new** — 19 tests, all passing |

**Bug found and fixed:** the old adult-channel regex used `\b18\+\b`. A `\b` after `+`
can never match (a word boundary needs a word character), so `18+` channels were
never filtered. Now `\b18\+`.

**Verified:** `tsc --noEmit` clean · 19/19 NSFW tests pass · all other suites pass
except `tests/player-controls.test.tsx`, which **hangs on the untouched baseline too**
(its `MpvPlayer.tsx` is byte-identical to HEAD), so it is pre-existing and unrelated.

### Phase 1 — Build plumbing, dual APK

| Item | State |
|---|---|
| Kotlin plugin | **2.4.0** — required; the mpv AAR's metadata is 2.4.0 and older compilers refuse it |
| JVM target | 21 for both Java and Kotlin (must match or the build fails) |
| `minSdk` | 24 → **25** |
| mpv AAR | `edde746:mpv-android:d633bbc71269@aar` via Ivy from the GitHub release, sha256-checked by `verifyMpvAar` |
| Media3 | 1.11.0 — exoplayer, hls, dash, ui, common, decoder, datasource-cronet |
| cronet | `org.chromium.net:cronet-embedded:143.7445.0` |
| LibVLC | **removed** — dependency, `PrahaVlcPlayer.java`, and every call site in `MainActivity` |
| ABI splits | `arm64-v8a`, `armeabi-v7a`, `x86_64` + `universalApk true` |
| `useLegacyPackaging` | on — TorrServer has to be exec'd from `nativeLibraryDir` |
| `copyApkToDist` | names APKs `-<abi>.apk` / `-universal.apk` |

**No CMake/NDK.** This host is aarch64 and Google's NDK ships only an x86_64 host
toolchain, so nothing can be compiled here. It does not matter: `libmpv.so` already
contains libass (`ass_renderer_init`) and libdovi (`dovi_reshape`) statically. See
`docs/NATIVE-BUILD-CONSTRAINTS.md`.

**Measured, real build:**

| APK | Size | ABIs |
|---|---|---|
| `app-arm64-v8a-debug.apk` | 27 MB | arm64-v8a |
| `app-armeabi-v7a-debug.apk` | 26 MB | armeabi-v7a |
| `app-x86_64-debug.apk` | 29 MB | x86_64 |
| `app-universal-debug.apk` | 61 MB | all three |

`aapt2 dump badging`: `minSdkVersion:'25'`, `native-code` correct per APK.
`lib/arm64-v8a/` contains `libmpv.so`, `libavcodec.so`, `libavformat.so`,
`libavutil.so`, `libswresample.so`, `libswscale.so`, `libavfilter.so`,
`libavdevice.so`, `libplayer.so`, `libc++_shared.so`, `libcronet.143.0.7445.0.so`.

### Phase 3 (part) — mpv engine wiring

| File | What it is |
|---|---|
| `android/.../mpv/PrahaMpvPlugin.kt` | **new** — Capacitor plugin over `com.edde746.mpv.MpvPlayer`; serial mpv thread; SurfaceView at index 0 behind the WebView; rect sync; tracks; subtitles; property passthrough |
| `services/mpvBridge.ts` | **new** — typed JS surface, `mpvAvailable()`, observed-property list |
| `services/mpvEngine.ts` | **new** — state mirroring, surface geometry (ResizeObserver + scroll), transport, tracks |
| `MainActivity.java` | `registerPlugin(PrahaMpvPlugin.class)` — the plugin is not npm-installed, so Capacitor's scanner cannot find it |

**Verified:** compiles clean; `PrahaMpvPlugin` present in `classes7.dex` of the built APK.

### Phase 4 — Media3 engine bridge (done)

| File | What it is |
|---|---|
| `android/.../media3/PrahaMedia3Plugin.kt` | **new** — self-contained Capacitor engine over Media3 1.11.0; ExoPlayer with Cronet, per-stream headers, SurfaceView behind the WebView, track/subtitle/cue/progress events, native SubtitleView |
| `services/media3Bridge.ts` | **new** — typed JS surface and `media3Available()` |
| `services/media3Engine.ts` | **new** — mpv-shaped state snapshot, surface geometry, transport, tracks; `load()` keeps a caller-supplied live flag when native stats lag |
| `MainActivity.java` | registers `PrahaMedia3Plugin` alongside mpv |
| `tests/media3-engine.test.ts`, `tests/media3-bridge.test.ts` | **new** — 10 tests, all passing |

Media3 deliberately has no FFmpeg adapter: platform decoders only. DTS/TrueHD/DV and
native ASS typesetting stay with mpv. Libass was not needed as a separate module —
`libmpv.so` already links it statically.

**Verified:** `:app:compileDebugKotlin` clean, full `assembleDebug` successful,
`PrahaMedia3Plugin` in `classes6.dex`/`classes9.dex`, `PrahaMpvPlugin` still present,
10/10 focused tests pass.

### Phase 5 — bundled TorrServer (done)

| File | What it is |
|---|---|
| `android/app/jniLibs/<abi>/libtorrserver.so` | **new** — the four real Go binaries from VyseTV (arm64 64.4 MB, armv7 64.4 MB, x86_64 67.0 MB, x86 63.9 MB), renamed to `.so` so `useLegacyPackaging` extracts them executable |
| `android/.../torr/PrahaTorrForegroundService.kt` | **new** — ongoing notification + `mediaPlayback` foreground service |
| `android/.../torr/PrahaTorrServerPlugin.kt` | **new** — Capacitor plugin: `getNativeLibraryDir`, `start` (ProcessBuilder `-p port -d dataDir`), `stop`, `status`, `getLogs`; API-31 `pid()` reflected with a safe fallback |
| `services/p2p/torrServerBridge.ts`, `torrServerSettings.ts`, `torrServerClient.ts`, `torrServerController.ts` | **new** — typed lifecycle, tuned BTSets profile, all 10 REST endpoints, tracker cache/augmentation |
| `services/torrentStreamingService.ts` | bundled engine is now the Android default host; WebTorrent disabled on Android (web/PWA only) |
| `components/SettingsView.tsx` | bundled-engine start/stop/status card |
| `tests/torrserver-port.test.ts` | **new** — 9 tests, all passing |

Tuned profile is verbatim from VyseTV: 256 MB cache / 150 peers on phone, 1024 MB /
300 on desktop, `EnableIPv6: false` (the measured stall fix), 95 % read-ahead,
2 % preload, 120 s disconnect, DHT/PEX/LPD/UPnP on, disk off.

**Verified:** native compiles, full `assembleDebug` successful, `libtorrserver.so`
present in all four APKs, 9/9 focused tests pass. arm64 52 MB, universal 138 MB.

### Phase 6 — Live TV helpers (done)

Ten missing VyseTV behaviours are now available as self-contained, typed helpers
under `services/liveTv/` — `epg`, `groupTree`, `matchFinder`, `multiPlaylist`,
`portalBrowser`, `appearance` (+ `index` barrel). They are pure functions so the
existing virtualised `LiveTvView.tsx` and its NSFW gating stay untouched; the
barrel documents which component should call which helper later.

**Verified:** `tests/livetv-port.test.ts` 22/22 pass; no tsc errors in these files.

### Phase 7 — source priority + 39 scrapers (done)

- `services/sourceOrchestrator.ts` implements the authoritative chain
  (39 scrapers/Movy → debrid → TorrServer → Nuvio/Stremio → EmbedModal → retry),
  bounded 8-at-a-time scraping on the phone, `rankStreams`, and TorrServer
  magnet resolution.
- `components/SourceModal.tsx` runs the scraper job first and shows an explicit
  "Try embedded players" button as the last resort — EmbedModal is never
  auto-selected.
- `services/filmSources.ts` now ships all **39 scrapers** — the original 18 plus
  24 ported directly from `scrapers.dart` (CNO, VidUp, 111477, VidCore, …). All
  network calls go through `fetchText`/`fetchJson`/`fetchRaw` → `nativeFetchText`,
  every scraper catches its own errors, and all returned URLs are absolute
  http(s). Source ordering matches VyseTV.

**Verified:** `tests/film-sources.test.ts` 8/8 pass;
`tests/source-orchestrator.test.ts` 5/5 pass.

### Phases 8–11 — reader, audiobooks, music, D-pad (done)

| Area | Files | Tests |
|---|---|---|
| Manga | `services/anilistService.ts`, `components/MangaReader.tsx`, `components/manga-view.css`, `components/MangaView.tsx` | `manga-reader.test.ts` (part of 34/34 with D-pad) |
| Audiobooks | `services/audiobookService.ts` (8 sources + Firestore chapter fetch), `components/AudiobooksView.tsx` | `audiobook-port.test.ts` 12/12, `audiobook.test.ts` |
| Music | `services/youtubeMusicClient.ts` (InnerTube WEB_REMIX + ANDROID fallback, rate-limit guard), `components/MusicView.tsx` | `youtube-music.test.ts` 7/7 |
| D-pad | `hooks/useDpadNavigation.ts` | `dpad-navigation.test.ts` (part of 34/34) |

The old combined "Manga & Comics" nav item is now **Comics** (Sanka/Comick,
untouched) plus a separate **Manga** tab (WeebCentral + the new reader), both in
`App.tsx`, `types.ts`, `Navigation.tsx` and the Settings nav list.

Audiobook port note: the earlier `AudiobookItem` helpers were renamed with a
`Legacy` suffix so both that API (used by `AudiobooksView`) and the newer
`Audiobook` API (used by `searchAudiobooks`) compile without duplicate symbols.

### Phase 13 — GPL-3.0 (done)

- `LICENSE` — full GPL-3.0 text (from the VyseTV upstream).
- `NOTICE.md` — attributions for VyseTV-derived code, bundled mpv/FFmpeg/libass,
  TorrServer (GPL-3.0, separate process over loopback), Media3, Cronet, etc.
- `package.json` `"license": "GPL-3.0-only"`; README License section updated.

### Phase 14 — signed release APKs (done)

- Web bundle rebuilt with `vite build` and synced with `capacitor sync android`;
  the APK's `index-Cpw6BCCF.js` contains `WeebCentral`, `Comics` and
  `Try embedded players` (verified by extracting it from the APK).
- `assembleRelease --no-daemon --offline` with the existing `praha-release`
  keystore produced all four signed APKs (arm64, armv7, x86_64, universal).
- Both deliverables copied to `dist-apk/`:
  - `praha-stream-v2.11.15-arm64.apk` — 47 MB, sha256 `07f8af47…7910`
  - `praha-stream-v2.11.15-universal.apk` — 126 MB, sha256 `5c4a3e0b…dd45`
- Verified on **both** APKs:
  - `aapt2 dump badging`: `com.praha.stream`, versionCode 40 / 2.11.15,
    minSdk 25, targetSdk 36.
  - `unzip -t`: no errors.
  - Native libs `libmpv.so`, `libtorrserver.so`, `libplayer.so` all present.
  - Dex contains `PrahaMpvPlugin`, `PrahaMedia3Plugin`, `PrahaTorrServerPlugin`.
  - `apksigner` SHA-256 `AA:E6:13:A2:69:C5:1F:BE:75:8C:C6:36:E7:6D:8F:66:
    A8:70:05:00:27:F5:F2:94:CD:8F:D5:79:BD:45:C3:01` — identical to the
    previous release, so in-place upgrades keep working.
- Final QA: `tsc --noEmit` = 0 errors; 31 test files / 288 tests green in six
  batches (`tests/player-controls.test.tsx` excluded — pre-existing hang).

### Post-release refinements — embed sources & navigation

- `components/EmbedModal.tsx` now runs `scrapeFilmSources(filmQueryFromMedia(...))`
  and renders a **VyseTV sources** panel (39 scrapers, Retry) above the embed-site
  list. Each result has a Play button wired through a new optional `onPlay`
  prop; `App.tsx` passes `playStream`, so direct scraper streams open in the
  real player instead of an iframe. EmbedModal is now only a last resort for
  *embed sites*.
- Mobile navigation: **Comics** moved out of the 5 primary tabs and into the
  **More** hub (`moreNavItems`), leaving Home / Live TV / Anime / Manga as the
  primary tabs. Comics remains in the desktop sidebar (`mainNav`).

## Not done yet

- Phase 14.5 — install on a device and run the full interactive smoke test
  (not possible from this headless environment; no adb connection to the phone).

## Environment notes

- Build from `/tmp/opencode/PRAHA-STREAM-build` (not `/sdcard` — native binaries
  cannot exec there).
- `chmod +x android/gradlew` is needed after copying into the build dir.
- Gradle runs need `--no-daemon`; the machine has ~7 GB RAM shared with the phone.
- First online build downloads the Kotlin plugin (~3–5 min). Later ones are offline-able.
- The vitest suite must be run in batches of ~5 files: parallel workers exhaust
  memory and the run is killed.
