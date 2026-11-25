# PRAHA STREAM

A local-first **Android, Android TV, and Web/PWA** streaming interface for Stremio addons and Nuvio plugins. PRAHA combines catalogs, streams, and subtitles in one cohesive app — you bring your own sources.

**No media is bundled in this repository.** Every title, poster, trailer, cast list, rating, and backdrop is fetched live from TMDB with your own API key, and every stream comes from the addons/repositories you install.

Current version: **2.11.27** · Latest release: [v2.11.27](https://github.com/pjneha66/PRAHA-STREAM/releases/tag/v2.11.27)

---

## Features

- **Home & Discovery** — TMDB-backed rows, search, watchlist, continue watching, and profile support.
- **Live TV** — curated channels, M3U/M3U8 playlists, Xtream-Codes portals, live sports matches, and a virtualized channel list for large playlists.
- **Movies & Series** — Stremio addon catalogs/streams, Nuvio scraper repositories, source filtering, and quality/codec ranking.
- **Anime & Comics** — Sanka/Comick browsing and in-app archive.org readers.
- **Books & Audiobooks** — Open Library, archive.org folkscanomy, and Bookracy downloads with an in-app scan reader.
- **Music & Flow** — YouTube-backed music and Flow tab.
- **Player** — HLS/DASH/MPEG-TS/progressive playback with buffering recovery, retries, subtitles, audio track switching, and external player handoff.
- **Extensions** — install, reorder, configure, and manage Stremio addons and Nuvio repositories.
- **Settings** — TMDB key, DNS, network/proxy, player, profiles, backup/restore, and in-app updates.

## Android & TV

PRAHA runs on Android phones, tablets, and Android TV / Fire TV via Capacitor plus native bridges:

- Native LibVLC playback for MKV/HEVC/AC-3 and other formats.
- Embedded stream header proxy for protected HLS streams.
- Immersive fullscreen, landscape lock, Picture-in-Picture, and remote/D-pad navigation.
- External player intents (VLC, mpv, MX Player, etc.).
- In-app auto-updater from GitHub Releases.

## Quick start (Web / PWA)

```bash
npm install
npm run dev
```

The Vite dev server listens on `0.0.0.0:3000`.

Live TV fixtures use Vite’s ESPN relay in development. To use the relay with a production build, set `VITE_API_PROXY=1` at build time and route `/espn-scoreboard/*` to `https://site.api.espn.com/apis/site/v2/sports/*`. Vite preview includes this route.

Quality checks:

```bash
npm run typecheck
npm test
npm run build
```

## Build Android APK

```bash
npm install
npm run build:android
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Release signing uses `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` when provided; otherwise Gradle can generate a local keystore for debug-style builds.

## Project structure

- `components/` — React UI
- `services/` — data, streaming, parsing, health, and storage logic
- `android/` — Capacitor Android project
- `tests/` — Vitest unit tests
- `docs/` — feature roadmap and Android player evaluation

## Notes

- TMDB API key is required for metadata; streams come from sources you install.
- Private DNS and network settings are device/browser-wide where applicable.
- No copyrighted media is included in this repository.

## License

PRAHA STREAM is free software under the **GNU General Public License v3.0 only**
(`GPL-3.0-only`). See [`LICENSE`](LICENSE) for the full text and
[`NOTICE.md`](NOTICE.md) for third-party component attributions, including the
VyseTV-derived code, the bundled mpv and TorrServer binaries.

The Android build ships both the mpv and Media3 players plus the bundled
TorrServer engine in every ABI-specific and universal APK.
