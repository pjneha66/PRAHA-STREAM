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
- **Advanced Discover**: Filter TMDB’s `/discover` catalog by Genre, Year, Minimum Rating, Original Language, and Sort Order with *Load More* pagination. Search also merges AniCore anime and the optional IMDx provider.
- **Anime tab (AniCore + Anikura)**: A dedicated index of 32,000+ shows with trending, seasonal, top-rated, airing and film rows, format/score/genre filters, full episode guides, and per-episode Anikura comment threads.
- **Anime & Comics tab (Sanka API)**: Browse/search anime and manga/comics. The comic browser supports source-specific latest/popular/search feeds, manga details, chapter lists, and an image reader when the upstream endpoints provide them. Sanka/API source availability and rights remain controlled by those providers.
- **Optional IMDx (Tiffara) metadata**: IMDb-style titles, ratings, plots, cast and episodes from `api.tiffara.com`, switched on in Settings. TMDB remains the primary catalog and your TMDB key is never replaced.
- **Household Profiles & Library Statuses**: Multiple local profiles with separate watchlists (`Watching`, `Plan to Watch`, `On Hold`, `Completed`, `Dropped`) and histories. Fresh installs start with a “Who’s watching?” profile picker; the choice is remembered for subsequent launches.
- **Full JSON Backup & Trakt / Simkl Scrobbling**: Export/share or import a single `.json` bundle containing all addons, repositories, profiles, library items, watch history, and settings—plus optional Trakt.tv and Simkl watch-history scrobbling.

### Flow tab (YouTube / YouTube Music, no account needed)
- **Where it comes from**: the tab is modelled after [Flow](https://github.com/Flow-Tube/Flow), the privacy-first YouTube / YouTube Music client for Android, and reads the same key-free data tier — YouTube's own `youtubei/v1` web endpoints and public channel RSS feeds. No API key, OAuth account, or third-party proxy is involved, and nothing about your viewing is stored outside PRAHA's local preferences.
- **Layout**: a YouTube-shaped shell — sticky top bar with the logo, pill search field and a **YouTube / Music** mode switch, a left rail (Home, Search, YouTube, Music, Channels) that becomes a scroll row on phones, filter chips, and horizontally scrolling shelves of video cards. Music mode swaps the accent to YouTube Music's pink and keeps the same geometry.
- **Search**: videos and channels. Pasting a `watch`, `youtu.be`, `shorts`, or `embed` link jumps straight to that video.
- **Music**: song/mix-only search and shelves — live streams, zero-length rows and sub-45-second clips are filtered out so news and podcasts never leak in. Audio-only playback through PRAHA's player, plus a one-tap, account-free **Flow radio** stream.
- **Subscriptions**: subscribe by `@handle`, `/channel/UC…`, `/c/`, or `/user/` link, or with the **Subscribe** button on a search result, a channel page, or the bar overlaid on the player itself. Subscriptions live only on this device (`praha.v2.flow-subscriptions`); opening one reads its recent uploads from YouTube's public feed.
- **Watching**: videos play in a **direct `<video>` player** built from the stream URLs the data source returns, inside a full YouTube watch page — picture on the left, *Up next* column on the right, channel row with the in-page **Subscribe** button, title, view/date line, like/share/save pills, chapters, an expandable description, and comments. **No silent playback**: every stream is flagged `hasAudio` (Piped `videoOnly`, Invidious `formatStreams` vs `adaptiveFormats`, InnerTube `audioQuality`). A video-only stream is automatically paired with the audio-only track on a hidden `<audio>` element that follows the picture's clock, seek and rate — and the quality menu labels any remaining silent option.
- **Speed**: requests are bounded — 9s per YouTube call, 6s per mirror with a 14s cap on the whole sweep — the `player` and `next` calls run in parallel, InnerTube's muxed `formats` are merged with `adaptiveFormats` so the direct player always has an audio track, and home/video details are cached for a few minutes (Retry clears them). A cold start no longer spends a minute on dead hosts.
- **Player settings** (gear inside the player toolbar, or the gear in the top bar) switch the player **language**, **captions** and **caption language**, the default quality (*Auto* up to 720p / *Highest* / *Data saver*), the **embed host** (`youtube-nocookie.com` or `youtube.com`) and autoplay-next. They are stored at `praha.v2.flow-player-prefs` and feed straight into the embed URL (`hl`, `cc_load_policy`, `cc_lang_pref`, `playsinline`). A **quality selector** lists *Auto*, one entry per muxed height (`720p`, `360p`, …) with bitrate, **Audio only**, and the *Use YouTube embed* / *Up to 4K on YouTube* shortcuts; each choice swaps the source in place. Mirrors often carry only 360p, so a higher-quality YouTube link is always one click away.
- **No banners over the picture.** The player is just the picture (plus an optional caption badge). Errors appear *below* the player as one dismissible line with *Embed* / *YouTube* escapes, and nothing explains error 153 any more — the embed simply plays.
- **Music fallbacks**: if a mirror has no music-only endpoint, its *general* trending and search results are filtered for song-like rows (title/channel hints, minus news/talk), so the Music tab still fills instead of erroring.
- **Diagnostics**: *Mirror settings* runs a live sweep and lists every instance with `kind`, response time, video count, or the exact failure (`HTTP 500`, `blocked before it reached the server (CORS/offline)`, `timed out`, `answered, but had nothing usable`). Retry escalates: normal → mirrors only → stop, so a broken YouTube path is never retried forever. A network-level YouTube block is remembered for the session, so later calls skip straight to mirrors instead of repeating the failed request.
- **Data tiers**: YouTube's own key-free endpoints are always tried first and talk to `youtube.com` directly — the PRAHA dev server is never in the path, and nothing goes to a third party. When YouTube blocks or rate-limits a client (HTTP 429/500 is common on shared IPs), the tab retries the same request through community **Piped and Invidious** mirrors and shows *“using a mirror”* in the hero card. Mirrors are listed under **Mirror settings** and can be replaced with any Piped/Invidious API URL; dead ones are skipped automatically.
- **Platform notes**: the Android APK routes the same requests through the native HTTP bridge, so they work without CORS.

### Anime tab, Anikura discussions and optional IMDx metadata

The **Anime** tab reads two key-free public APIs directly from the device:

- **AniCore** (`https://anicore.dpdns.org/v1`) — a five-way index (Kitsu, TVDB, TMDB, AniList, MAL) with `GET /anime` browse/search, `/anime/{slug}` details, `/anime/{slug}/episodes` episode guides, characters and recommendations. PRAHA uses its `externalIds` to hand the right TMDB/IMDb id to your Stremio and Nuvio sources.
- **Anikura** (`https://anikura.club/api/v1`) — `GET /catalog` for catalog lookups and `GET /comments?…&episode=` for episode discussion. Comments are gathered by Anikura from MyAnimeList forums, Anikoto and Reanime and belong to their authors.

Open any anime's details modal to load its AniCore episode guide and Anikura discussion for a chosen episode; those threads are also available for TMDB/Stremio titles once AniCore can match the title. Both APIs are requested only while the Anime tab or a discussion panel is open, responses are cached in memory for ten minutes, and no credentials are sent.

The separate **Anime & Comics** tab uses the public endpoints documented by [Sanka's Anime and Comic API](https://github.com/SankaVollereii/Rest-Api-Anime-and-Comic). Anime uses `/anime/home` and `/anime/{source}/search/{query}`. Comic feeds use `/comic/homepage` or `/comic/{source}/latest|popular`, search uses `/comic/{source}/search/{query}`, manga details use `/comic/{source}/manga/{slug}`, and chapter pages use `/comic/{source}/chapter/{slug}`. The comic source selector intentionally lists non-adult source options. Provider availability, CORS policy, artwork, and response fields are controlled by the upstream project. For local development, `VITE_API_PROXY=1` routes its requests through Vite; `SANKA_PROXY_TARGET` can point to a mirror or fixture server.

**IMDx / Tiffara** is disabled by default. When enabled in **Settings → IMDx · Tiffara**, PRAHA adds IMDb-style search results to Discover and the Anime tab, an extra *Popular on IMDx* home row, richer plots/cast/episode stills in details (used when TMDB has no data), and — if no TMDB key is configured — a fallback home catalog. The base URL is editable (`https://api.tiffara.com` by default) and an optional `x-api-key` can be supplied for self-hosted deployments. Turning IMDx off does not affect TMDB.

**WebCORS:** the APIs are browser-friendly but a corporate proxy, ad blocker or strict privacy extension can still block them; PRAHA then shows a clear error with a retry. Inside the Android APK, requests automatically fall back to PRAHA's native HTTP bridge, so neither CORS nor header restrictions apply. For local development behind a CORS-limited network, start Vite with `VITE_API_PROXY=1 npm run dev` to relay `/anicore`, `/anikura` and `/imdx` through the dev server (`vite.config.ts`); `ANICORE_PROXY_TARGET`, `ANIKURA_PROXY_TARGET` and `IMDX_PROXY_TARGET` point those relays at a mirror, a self-hosted instance or local fixtures. The three upstream hosts learn the sandbox's IP when the relay is used, and requests are made only when you open the corresponding screen.

The anime and metadata code is covered by `tests/anime-flow.test.ts` (request shapes and mappers), `tests/anime-ui.test.tsx` (server-rendered shells) and `tests/app.integration.test.tsx`, which mounts the whole app in jsdom with stubbed provider responses and walks the Anime tab, details modal, Anikura discussion and the IMDx settings card.

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
