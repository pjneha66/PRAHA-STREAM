# PRAHA STREAM

A local-first **Android, Android TV, and Web/PWA** streaming interface inspired by Nuvio’s bring-your-own-sources philosophy. PRAHA combines **Stremio addons** (catalogs, streams & subtitles), **Nuvio plugin repositories**, and **CloudStream extension repositories** in one cohesive app.

**No movies or shows are bundled in this repository.** Every title, poster, trailer, cast list, season/episode guide, rating, and backdrop is fetched live from TMDB with your own API key, and every stream comes from the sources you install.

---

## Android & Android TV Features (`v2.1.0`)

PRAHA STREAM is built first-class for Android phones, tablets, and Android TV / Fire TV boxes via Capacitor + custom native Android Java bridges (`MainActivity.java` & `PrahaStreamProxy.java`):

- **Embedded Native Stream Header Proxy (`PrahaStreamProxy`)**: Runs a local `127.0.0.1` loopback proxy inside the Android APK that injects `Referer`, `Origin`, `User-Agent`, `Cookie`, and `Authorization` headers, forwards HTTP `Range` requests for instant seeking, and rewrites relative HLS `.m3u8` segment/key URLs so header-protected streams play natively in `MpvPlayer`.
- **CORS-Free Native Scraper Networking**: Both main-thread requests and Web Worker scrapers (Nuvio & CloudStream JS) automatically delegate blocked or header-restricted HTTP calls to PRAHA’s native Android HTTP bridge.
- **Hardware Back Gesture & Deep-Link Navigation**: Android’s back button closes fullscreen → player → source finder → details modal → returns to Home, with double-back confirmation to exit.
- **Immersive Fullscreen, Auto-Landscape & Native Picture-in-Picture**: Enters immersive edge-to-edge fullscreen, locks sensor landscape orientation while watching, and supports Android O+ native PiP windows.
- **One-Tap External Player Intents**: Launch streams or magnets directly in **VLC**, **mpv-android**, **MX Player**, **Just Player**, or the Android system chooser—with custom HTTP headers forwarded as intent extras.
- **Android TV (`LEANBACK_LAUNCHER`) & Spatial D-Pad Navigation**: Includes a native TV home-screen banner and 2D arrow-key remote focus navigation across rows, tabs, and modals.

### Build Android APK locally
```bash
npm install
npm run build:android
# Output: dist-apk/praha-stream-v2.1.0.apk
```
*(If `android/app/release.keystore` does not exist yet, Gradle automatically generates a local signing keystore during `assembleRelease`, or uses `ANDROID_KEYSTORE_PATH` / `ANDROID_KEYSTORE_PASSWORD` environment variables in CI.)*

---

## Run locally (Web / PWA)

```bash
npm install
npm run dev
```

The Vite server listens on `0.0.0.0:3000`.

To run PRAHA together with the CloudStream plugin server (which executes native `.cs3` providers):

```bash
npm run dev:full
```

Quality checks & unit tests:

```bash
npm run typecheck
npm test
npm run build
```

---

## Core Capabilities

### Playback & Progress (`MpvPlayer`)
- **Multi-Engine Playback**: HLS (`hls.js`), DASH `.mpd` (`dashjs`), MPEG-TS / `.ts` / `.flv` (`mpegts.js`), and native HTML5 video.
- **Real Watch Progress & Timestamp Resume**: Saves exact `currentTime`, `duration`, percentage, `season`, `episode`, and last working stream—with one-tap resume from *Continue Watching* and individual item removal.
- **Up Next & Auto-Play Next Episode**: Automatically resolves and advances to `S{x} E{y+1}` (including season rollovers) with an in-player countdown card.
- **Skip Intro (`IntroDB`)**: Automatically detects episode intro windows via `api.introdb.app` and displays a floating **Skip Intro** button alongside a quick `+85s` opener skip.
- **MediaSession & Cast**: Populates Android lock-screen / notification shade controls, Bluetooth headset buttons, and `RemotePlayback` casting.

### Subtitles, Debrid & Sources
- **Stremio Subtitle Addons (`/subtitles/`)**: Automatically queries installed subtitle addons such as OpenSubtitles v3.
- **SRT / ASS → WebVTT Converter, Local Upload & Sync Delay**: Converts `.srt` and `.ass` subtitles on the fly, supports loading local `.srt`/`.vtt`/`.ass` files from device storage, and adjusts subtitle timing offset (`Z`/`X` or `-0.25s`/`+0.25s`) and background opacity.
- **Debrid Magnet Streaming**: Optional **Real-Debrid**, **AllDebrid**, and **TorBox** integration converts torrent magnets/`infoHash` streams into direct 4K HTTP streams inside the built-in player.
- **Unified Source Finder & 1-Click Directory**: Searches Stremio, Nuvio (with per-scraper settings), and CloudStream providers together, with priority reordering (`↑`/`↓`), `/configure` links, and a built-in 1-click addon directory.

### Rich TMDB Metadata, Discover Filters, Profiles & Backup
- **Rich Details Modal**: Inline YouTube trailers, real TMDB season & episode guides with thumbnails/air dates/watched bars, cast & director strip, and *More Like This* recommendations.
- **Advanced Discover**: Filter TMDB’s `/discover` catalog by Genre, Year, Minimum Rating, Original Language, and Sort Order with *Load More* pagination.
- **Household Profiles & Library Statuses**: Multiple local profiles with separate watchlists (`Watching`, `Plan to Watch`, `On Hold`, `Completed`, `Dropped`) and histories.
- **Full JSON Backup & Trakt / Simkl Scrobbling**: Export/share or import a single `.json` bundle containing all addons, repositories, profiles, library items, watch history, and settings—plus optional Trakt.tv and Simkl watch-history scrobbling.
