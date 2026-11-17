# Workspace Memory — PRAHA-STREAM

_Last updated: 2026-11-17. Everything below is verified against the working tree and build logs._

## 1. Project overview

- **App:** PRAHA-STREAM — a Capacitor (React + TypeScript + Vite) media streaming app for Android (also a web app).
- **Package / applicationId:** `com.praha.stream`, label `PRAHA STREAM`.
- **Version:** 2.11.8, `versionCode 33` (bumped in `package.json`, `package-lock.json`, `android/app/build.gradle`).
- **Key configs:** `capacitor.config.json`, `vite.config.ts`, `android/build.gradle` (AGP `8.13.0`, Gradle 8.13), `android/app/build.gradle`.
- **Native Android entry:** `android/app/src/main/java/com/praha/stream/MainActivity.java` (includes a WebView bridge with `@JavascriptInterface` methods). LibVLC/VLC native libs are bundled in the APK.

## 2. What was accomplished in this session

The user asked to fix all **47 verified bugs** and produce a locally installable APK (no GitHub release / push needed). All work was done autonomously.

- **All 47 bugs fixed** across **36 files** in the real repo (`/storage/emulated/0/Ob/PRAHA-STREAM/`).
- Changes are **uncommitted / unpushed** (intentionally — no git delivery was requested).
- **Debug APK built and delivered** to:
  `/storage/emulated/0/Ob/PRAHA-STREAM/dist-apk/praha-stream-v2.11.8-debug.apk` (≈185 MB)
  - SHA-256: `6773327906d7c44339d36fd4ff5ed18fffc107c89b289784a371056c2439ec98`
  - `aapt2 dump badging`: `versionCode='33' versionName='2.11.8'`, targetSdk 36, compileSdk 36.

## 3. The 47 fixed bugs (authoritative list, by severity)

Source of truth was a prior audit message. All are now fixed in the working tree.

### Critical (build/CI)
1. `android/gradle.properties` — hardcoded macOS Homebrew `org.gradle.java.home` broke Linux CI. Line removed.
2. Release workflow + `android/app/build.gradle` — release signing/keystore task made conditional; debug builds unaffected.

### High
3. `MainActivity.java` — redirect SSRF: re-validate `isAllowedRemoteUrl()` on every redirect hop.
4. `App.tsx` — PIN bypass: centralized `requestProfileSwitch` / `commitProfileSwitch` + back-handler guard.
5. `backupSyncService.ts` → `stremioService.ts` — normalize imported addon manifests (object shape, resource/catalog arrays).
6. `sankaService.ts` — single outer `finally` releases the artwork concurrency slot on Kitsu success.
7. `MpvPlayer.tsx` / `useMpvEngine.ts` — swipe-to-seek uses `base + delta` (start time captured) instead of live `currentTime`.
8. `iptvService.ts` — fix `||` precedence producing `.../live/undefined`.
9. `archiveService.ts` — cover URL `/b/cover_i/` → `/b/id/`.
10. `iptvService.ts` — Xtream login success no longer accepted merely on `user_info` presence.

### Medium
11. `networkCondition.ts` — return `'online'` on successful probe (inverted logic fixed).
12. `usePersistentState.ts` — re-read storage synchronously when the `key` changes (profile switch).
13. `App.tsx` — hardware-back chain respects `pinGateProfile`.
14. `useMpvEngine.ts` — `toggleMute()` and `audio:off` affect the real audio engine (LibVLC / hls.js / dash.js).
15. `PlayerModal.tsx` — keep and call the `subscribeStats()` unsubscribe.
16. `MpvPlayer.tsx` — subtitle sync no longer remounts tracks / resets chosen track; blob URLs not regenerated per nudge.
17. `AudioSubtitleDialog.tsx` — `activeTab` re-seeded on open.
18. `MainActivity.java` — `downloadFile` RPC arg order fixed (title vs headers).
19. `vite.config.ts` — `isPrivateHost()` handles bracketed IPv6 + `fe80::`/`fc00::` ranges.
20. `MusicPlayerProvider.tsx` — `setVolume()` clears `audio.muted` when raising volume.
21. `MusicPlayerProvider.tsx` — removing current queue item keeps playback coherent / index correct.
22. `LibraryView.tsx` — shift-click delete stops propagation.
23. `FlowView.tsx` — detail-error fallback iframe uses `detailId`, not empty `embedSrc`.
24. `FlowView.tsx` — request tokens in `loadChannel()` / `openVideo()` prevent stale responses.
25. `FlowView.tsx` — `prefs.speed` removed from `<video>` key; imperative playback-rate effect instead.
26. `DiscoverView.tsx` — search results honor genre / language / sortBy filters locally.
27. `LiveTvView.tsx` — `playMatch()` has a `catch` (user-visible error).
28. `autoUpdateService.ts` — prerelease ranking compares per-component numbers.
29. `musicService.ts` — YouTube direct first, mirror fallback (policy restored).
30. `audiobookService.ts` — corrected wrong chapter file mappings.
31. `bookracyService.ts` + `BooksView.tsx` — results tagged with real `source`/`identifier` so read/download actions appear.
32. `stremioService.ts` — use `season != null && episode != null` so specials (season/episode 0) resolve.
33. `tmdbService.ts` — fixed TV Horror/Thriller genre IDs.
34. `nuvioWorker.ts` — proxy forwards non-string request bodies (`URLSearchParams`, `FormData`, `Blob`).
35. `AnimeView.tsx` — genre filter auto page-ahead + "Load more" shown when filtered list empty.
36. `backupSyncService.ts` — scraper code-size guard also checks `repositories[].scrapers[].code`.
37. `MainActivity.java` — `downloadAndInstallUpdate()` annotated `@JavascriptInterface`.
38. `FlowView.tsx` — radio `<audio>` hoisted out of the settings drawer; play/pause effect added.
39. `MpvPlayer.tsx` — brightness HUD label shows real brightness (not the 0–100 fill %).
40. `App.tsx` — `searchPrefill` cleared via effect when leaving the target tab.

### Low
41. `searchRelevance.ts` — prefix-match ranking bonus no longer unreachable.
42. `imdxService.ts` — specials season `0` preserved (`Number(season) || 1` fixed).
43. `AudiobooksView.tsx` — "Close player" actually closes the bar.
44. `MainActivity.java` — `enterPip()` reports success from the UI-thread callback.
45. `MpvPlayer.tsx` — `onPreloadNextEpisode` added to `MpvPlayerProps`.
46. `SettingsView.tsx` — `onUpdateProfile` declared in props type.
47. `FlowView.tsx` — unused `captionSize` field/control removed.

Root cause explicitly noted in the audit: `package.json` omits `@types/react` / `@types/react-dom` and `tsconfig.json` restricts `types`, so TS treated React components as `any` and missed prop/type bugs (#45, #46).

## 4. Environment constraints (READ THIS BEFORE REBUILDING)

This runs on an **Android phone inside OpenCode Mobile's Ubuntu** (`uname -m` = **aarch64**), with limited CPU/RAM.

- **`node_modules` cannot run native/esbuild binaries from the `/sdcard` mount.** All Node builds MUST run from a copy at `/tmp/opencode/PRAHA-STREAM-build`. Native `.node` / esbuild binaries there were `chmod +x`'d after copying.
- Installed deps with `npm ci --ignore-scripts --no-bin-links --no-audit --no-fund`; invoke tools via `node node_modules/...` (no `.bin` symlinks).
- **Java:** OpenJDK 21 (apt). **Android SDK:** `/tmp/opencode/android-sdk` (platforms/android-36, build-tools/36.0.0, platform-tools, cmdline-tools/latest). Set `sdk.dir` in the build copy's `android/local.properties`.
- **Gradle 8.13** distribution pre-downloaded (Java wrapper timed out; curl worked) into `/root/.gradle/wrapper/dists/gradle-8.13-bin/5xuhj0ry160q40clulazy9h7d/`.
- **THE BIG GOTCHA — x86_64 vs aarch64:** Android's native build tools (AAPT2, aidl, zipalign, split-select) ship **only as x86_64** on Google Maven/SDK repo; there is no arm64 classifier. On this aarch64 host, AAPT2 failed with `Daemon startup failed` / `cannot execute: required file not found`.
  - **Solution that worked:** download **native ARM64** drop-in binaries from `Commit451/android-arm-build-tools` (release `platform-tools-36.0.0`), replacing the x86_64 binaries in `build-tools/36.0.0/`, and add to `/root/.gradle/gradle.properties`:
    `android.aapt2FromMavenOverride=/tmp/opencode/android-sdk/build-tools/36.0.0/aapt2`
  - `binfmt_misc` is NOT usable (kernel doesn't support registering handlers). QEMU user-mode emulation also worked for smoke tests but the native arm64 binaries are the clean fix.
  - apt multiarch was also configured (amd64 libs) but is not required once native arm64 tools are in place.

## 5. Rebuild recipe (verified working)

```bash
# 0) Sync latest fixed sources into the build copy (only if repo changed since)
rsync -a --exclude node_modules --exclude .git --exclude dist-apk \
  /storage/emulated/0/Ob/PRAHA-STREAM/ /tmp/opencode/PRAHA-STREAM-build/

# 1) Web build (must be under /tmp)
cd /tmp/opencode/PRAHA-STREAM-build
node node_modules/vite/bin/vite.js build

# 2) Copy web assets into Android project
node node_modules/@capacitor/cli/bin/capacitor sync android

# 3) Gradle debug build
cd /tmp/opencode/PRAHA-STREAM-build/android
printf 'sdk.dir=/tmp/opencode/android-sdk\n' > local.properties
export ANDROID_HOME=/tmp/opencode/android-sdk ANDROID_SDK_ROOT=/tmp/opencode/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
bash ./gradlew assembleDebug --no-daemon
```

The `copyApkToDist` task (in `android/app/build.gradle`) copies the result to
`/tmp/opencode/PRAHA-STREAM-build/dist-apk/praha-stream-v2.11.8-debug.apk`
(note: `rootDir/../dist-apk` resolves relative to the Android project, **not** `/tmp/opencode`).

Then copy to the final destination:
```bash
cp /tmp/opencode/PRAHA-STREAM-build/dist-apk/praha-stream-v2.11.8-debug.apk \
   /storage/emulated/0/Ob/PRAHA-STREAM/dist-apk/
```

## 6. Verification commands (all passed this session)

```bash
cd /tmp/opencode/PRAHA-STREAM-build
node node_modules/typescript/bin/tsc --noEmit          # clean, no errors
node node_modules/vitest/vitest.mjs run                # 18 files, 143 tests pass

# APK sanity
unzip -t <apk>                                        # no errors
/tmp/opencode/android-sdk/build-tools/36.0.0/aapt2 dump badging <apk>
```

## 7. Notes / gotchas for future sessions

- Do **not** try to push or create a GitHub release — the user explicitly said local APK only. No GitHub credentials are configured anyway.
- The 36 modified files are uncommitted; treat them as the delivered work, not something to revert.
- The debug APK is unsigned-with-debug-key and installable directly; `assembleRelease` needs a real keystore + secrets, which were deliberately avoided.
- Avoid leaving Gradle daemons, long builds, or many parallel processes running — Android kills background processes and can terminate this whole environment under memory pressure. Use `--no-daemon` and background shell tasks with a single build at a time.
- Gradle wrapper's Java downloader times out (10s) in this network; the zip was fetched with curl. If the cache is wiped, re-download with curl into the wrapper dists path.
