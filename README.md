# PRAHA STREAM

A local-first **Android, Android TV, and Web/PWA** streaming interface inspired by Nuvio’s bring-your-own-sources philosophy. PRAHA combines **Stremio addons** (catalogs, streams & subtitles) and **Nuvio plugin repositories** in one cohesive app.

**No movies or shows are bundled in this repository.** Every title, poster, trailer, cast list, season/episode guide, rating, and backdrop is fetched live from TMDB with your own API key, and every stream comes from the sources you install.

---

## Android & Android TV Features (`v2.2.0`)

PRAHA STREAM is built first-class for Android phones, tablets, and Android TV / Fire TV boxes via Capacitor + custom native Android Java bridges (`MainActivity.java` & `PrahaStreamProxy.java`):

- **Embedded Native Stream Header Proxy (`PrahaStreamProxy`)**: Runs a local `127.0.0.1` loopback proxy inside the Android APK that injects `Referer`, `Origin`, `User-Agent`, `Cookie`, and `Authorization` headers, forwards HTTP `Range` requests for instant seeking, and rewrites relative HLS `.m3u8` segment/key URLs so header-protected streams play natively in `MpvPlayer`.
- **CORS-Free Native Scraper Networking**: Main-thread requests and Web Worker scrapers (Nuvio) automatically delegate blocked or header-restricted HTTP calls to PRAHA’s native Android HTTP bridge.
- **Hardware Back Gesture & Deep-Link Navigation**: Android’s back button closes fullscreen → player → source finder → details modal → returns to Home, with double-back confirmation to exit.
- **Immersive Fullscreen, Auto-Landscape & Native Picture-in-Picture**: Enters immersive edge-to-edge fullscreen, locks sensor landscape orientation while watching, and supports Android O+ native PiP windows.
- **One-Tap External Player Intents**: Launch streams or magnets directly in **VLC**, **mpv-android**, **MX Player**, **Just Player**, or the Android system chooser—with custom HTTP headers forwarded as intent extras.
- **Android TV (`LEANBACK_LAUNCHER`) & Spatial D-Pad Navigation**: Includes a native TV home-screen banner and 2D arrow-key remote focus navigation across rows, tabs, and modals.

### Connection troubleshooting: Private DNS

If your network's DNS cannot resolve TMDB or a source, Android 9+ users can open **Settings → Private DNS** in PRAHA, then configure Android's Private DNS provider hostname (for example `dns.google` or `one.one.one.one`). PRAHA opens Android settings but cannot enable or verify the setting for you. Some Android TV devices do not expose this option; menu names vary. This is a device-wide change, and your chosen DNS provider receives your DNS queries. To undo it or restore connectivity, set Private DNS to **Automatic**.

Private DNS only changes DNS resolution: it is not a VPN and does not bypass IP blocking, geographic restrictions, or unavailable services. Web users must configure secure DNS in their browser or operating system.

### Build Android APK locally
```bash
npm install
npm run build:android
# Output: dist-apk/praha-stream-v2.2.0.apk
```
*(If `android/app/release.keystore` does not exist yet, Gradle automatically generates a local signing keystore during `assembleRelease`, or uses `ANDROID_KEYSTORE_PATH` / `ANDROID_KEYSTORE_PASSWORD` environment variables in CI.)*

---

## Run locally (Web / PWA)

```bash
npm install
npm run dev
```

The Vite server listens on `0.0.0.0:3000`.

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
- **Unified Source Finder & 1-Click Directory**: Searches Stremio and Nuvio (with per-scraper settings) providers together, with priority reordering (`↑`/`↓`), `/configure` links, and a built-in 1-click addon directory.

### Rich TMDB Metadata, Discover Filters, Profiles & Backup
- **Rich Details Modal**: Inline YouTube trailers, real TMDB season & episode guides with thumbnails/air dates/watched bars, cast & director strip, and *More Like This* recommendations.
- **Advanced Discover**: Filter TMDB’s `/discover` catalog by Genre, Year, Minimum Rating, Original Language, and Sort Order with *Load More* pagination.
- **Household Profiles & Library Statuses**: Multiple local profiles with separate watchlists (`Watching`, `Plan to Watch`, `On Hold`, `Completed`, `Dropped`) and histories.
- **Full JSON Backup & Trakt / Simkl Scrobbling**: Export/share or import a single `.json` bundle containing all addons, repositories, profiles, library items, watch history, and settings—plus optional Trakt.tv and Simkl watch-history scrobbling.

### Player recovery and diagnostics

For in-player diagnostics use the Statistics button. It shows the playback engine, device network indication, buffering, resolution, decoded/dropped frames and reconnect attempts; a device reporting online does not prove that a stream host is reachable. After 15 seconds without playback progress, the player tries up to two reconnects, preserving the position where the stream supports seeking. It does not restart while paused, seeking or backgrounded. If recovery fails, retry manually or choose another source. External and embedded players manage their own recovery.

For the Android-native Media3 player assessment and proposed test plan, see [docs/android-player-evaluation.md](docs/android-player-evaluation.md). The native player is not yet implemented.

### Home caching and rows

Home stores recent TMDB catalog responses locally for up to seven days and refreshes them on launch. If refresh fails, saved titles remain visible with a retry notice. On the web/PWA, a bounded service-worker cache stores public TMDB artwork; the Android WebView uses its normal HTTP cache. Playback streams, addon requests and API credentials are not stored in the artwork cache. Use **Customize home rows** to hide or reorder sections per profile.

The existing JSON backup is a manual transfer, not automatic cross-device synchronization. It now carries each profile's home-row preferences and preferred source. Backups may contain secrets and executable scraper code: store them securely and import only trusted files. In Settings, Jellyfin library browsing uses a temporary in-memory login and opens titles in Jellyfin for playback. In-app Jellyfin playback and automatic sync are not implemented; web access requires Jellyfin CORS configuration.

### Embedded players

Use **Embedded players** on a title's details or the home spotlight to browse third-party website players separately from Stremio/Nuvio source results. The built-in templates follow provider documentation but are not tested or guaranteed to work. You can add HTTPS movie and TV URL templates with `{id}`, `{tmdb}`, `{imdb}`, `{season}`, and `{episode}`; they stay on the device and are not included in backups. Do not put credentials in templates.

A provider is contacted only when you select it. Websites may track visitors, show ads, or block embedding; check rights and use only authorized content. Web embeds run in a restricted iframe and may need the browser option to work. On Android, **Protected player** opens a separate WebView with no PRAHA JavaScript bridge; **Browser** opens an external browser without PRAHA's filtering. PRAHA cannot reliably detect whether an embedded website is playing or record its watch progress. Normal source search and playback remain separate.

The embedded-player list includes templates derived from providers' published documentation; this is not proof that a player or a title currently works. Select **Edit** next to any player to update its movie and series HTTPS templates after a domain or route change, or **Use feed/default** for a built-in player. Manual changes stay on this device; the optional update feed may update built-in templates automatically. Automatic domain discovery, uptime guarantees, and live playback verification are not provided. Check provider announcements and verify any replacement address before saving it.

### Automatic embed updates

The app defaults to the PRAHA repository's `public/embed-providers.json` feed on GitHub's `main` branch. No feed setup is needed once this file is published on that branch. The file included with the app and the built-in templates supply the baseline; the remote feed is checked when the player list opens, at most once per 24 hours after a successful check. **Check now** forces a refresh; the last successful update remains available offline. Manual edits take precedence. You can change or disable the feed in the player list. Existing users who previously disabled updates remain opted out.

**Maintenance is still required:** repository maintainers must verify provider changes and update the JSON in `main`. The app does not discover provider domain changes itself; no feed can guarantee provider availability. Until this change is published to `main`, the default remote feed may return 404 and the app uses its built-in templates. The feed fetch sends no title IDs or credentials, does not follow redirects, and validates and bounds the response. Feed operators can redirect viewers to different websites, so only use a source you trust. Local player templates and feed settings are not included in JSON backups.

### Embedded player ad and popup protection

Android's **Protected player** uses a bundled, host-based blocklist and blocks new windows, downloads and same-tab navigation away from the selected provider. The list is the MIT-licensed [StevenBlack/hosts](https://github.com/StevenBlack/hosts), snapshot 6d56ab44f2b3d27de062b5194eb51bcd8115a773 (1 November 2026); its license is included alongside the list in the Android assets. It is bundled with the app and does not update automatically. The player has no PRAHA native bridge, denies WebView permission requests, and disables file/content access. If the list cannot be loaded, protected playback does not start.

This is **not uBlock Origin** or its filter engine: it blocks requests to known listed hosts and their subdomains, not all ads, same-host ads, scriptlets or all trackers. Some WebView traffic, such as service-worker traffic, may bypass the WebView request callback. Protection is best effort, not a security guarantee, and blocking can break a player or a legitimate redirect. Browser mode has no PRAHA filtering. Web embeds use a restricted iframe that blocks pop-ups, but PRAHA cannot filter their network requests. uBlock Origin is a browser extension and cannot be installed inside PRAHA's iframe or its external Android browser. Android build and real-device playback have not yet been verified.
