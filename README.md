# PRAHA STREAM

A completely rebuilt, responsive streaming interface inspired by Nuvio’s bring-your-own-sources philosophy. PRAHA combines Stremio addons, Nuvio plugin repositories, and CloudStream extension repositories in one local-first library.

**No movies or shows are bundled in this repository.** Every title, poster, rating, genre, and backdrop is fetched live from TMDB with your own API key, and every stream comes from the sources you install. The app ships nothing but the UI, the Cinemeta metadata addon, and the player.

## Run locally

```bash
npm install
npm run dev
```

The Vite server listens on `0.0.0.0:3000`.

```bash
npm run build
npm run preview
```

## Source support

### Stremio

- Install `https://…/manifest.json` and `stremio://…` links.
- Read manifest resources, catalogs, types, and ID prefixes.
- Load catalogs, catalog search, and full `/meta/{type}/{id}.json` details.
- Request movie and episode streams using Stremio’s `/stream/{type}/{id}.json` contract.
- Enable, disable, refresh, inspect, and remove installed addons.

Cinemeta is included as the default metadata/catalog addon. It does **not** provide streams; add a stream source to watch content.

### Nuvio plugins

- Install Nuvio repository manifests (`name`, `version`, and `scrapers`).
- Fetch each scraper’s `filename`, including absolute and repository-relative URLs.
- Run the Nuvio `getStreams(tmdbId, mediaType, season, episode)` contract in a dedicated web worker.
- Provide Cheerio and CryptoJS compatibility, per-provider controls, and test execution.
- Enable, disable, refresh, and remove repositories.

### CloudStream extensions

- Install CloudStream repositories from `repo.json` (a repository-of-repositories), a direct `plugins.json`, or the legacy `{ addons: [...] }` shape.
- Resolve each entry’s `url`, `iconUrl`, `language`, `tvTypes`, `authors`, and `fileSize`.
- Enable, disable, refresh, and remove repositories, and toggle each extension individually.

CloudStream extensions are Kotlin (`.cs3`) packages that run inside the native CloudStream app. PRAHA installs and lists them alongside Stremio and Nuvio, but they cannot resolve streams in a browser. Stream playback continues to come from Stremio addons and Nuvio plugins.

### Browse by source

The **Explore** tab keeps each ecosystem separate. Switch between **Addons** (Stremio), **Plugins** (Nuvio), and **Extensions** (CloudStream) to browse a single source’s catalogs and providers without mixing them into one list. Use the Extensions page to install and manage everything.

Only install third-party repositories you trust. Native Nuvio and browser networking are different: remote manifests, scrapers, catalogs, and media must permit browser CORS requests. PRAHA reports these errors rather than pretending a source is connected.

## TMDB API key (required for the catalog)

PRAHA ships **without a built-in or shared TMDB key** and **without a bundled catalog**. Open **Settings → TMDB API** to paste, verify, save, show/hide, or clear your own key. Both TMDB v3 API keys and v4 read access tokens are supported.

The key drives the entire catalog:

| Screen | TMDB endpoints used |
| --- | --- |
| Home spotlight | `/trending/all/week`, enriched with `/movie/{id}` or `/tv/{id}` (runtime, genres, certification, IMDB id) |
| Home rows | `/movie/popular`, `/tv/popular`, `/movie/top_rated`, `/trending/{type}/week` |
| Discover & search | `/search/multi`, plus the catalogs of your installed Stremio addons |
| Details & sources | `/{type}/{id}?append_to_response=external_ids,…` and `/find/{imdb_id}` for ID resolution |
| Nuvio providers | the standard `TMDB_API_KEY` runtime binding |

Until a key is saved, Home and Discover show a setup card that links to Settings and to [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — the app never falls back to a hardcoded list. Self-hosted deployments can optionally set `VITE_TMDB_API_KEY`; a key saved in Settings takes priority.

## Playback: the mpvRx-style player

Direct browser-compatible video and HLS streams play in PRAHA’s built-in player, modelled on [mpvRx](https://github.com/Riteshp2001/mpvRx) (the libmpv-based Android player):

- **On-screen controller** that auto-hides like mpv’s OSC, with a buffered-aware seek bar, hover scrub preview, and A-B loop markers.
- **Quality, audio, and subtitle menus** built on hls.js levels and audio/subtitle tracks, plus external subtitle tracks from your sources (size and color adjustable).
- **Statistics overlay** (`I`): resolution, FPS, dropped frames, active variant, bitrate, buffer ahead, host, and track selection.
- **Themes** for the controller: mpvRx Purple, AMOLED Black, Catppuccin Mocha, Nord, Tokyo Night, Dracula, Gruvbox, and Rosé Pine (Settings → Player).
- **mpv key bindings**: `Space`/`K` play-pause, `←`/`→` seek, `,`/`.` frame step, `[`/`]` speed, `↑`/`↓` volume, `M` mute, `J` subtitles, `#` audio, `F` fullscreen, `P` picture-in-picture, `L` A-B loop, `S` save frame, `I` stats, `?` full list.
- **Touch gestures**: double-tap left/right to seek, center to play/pause, horizontal swipe to seek, vertical swipe for volume (right) or brightness (left), long-press for 2× speed.

Controller theme, seek step, auto-hide delay, subtitle size, gestures, and the stats default are all configurable in **Settings → Player**; volume, speed, and brightness persist between sessions.

YouTube sources open in an embedded player, and magnet links can be copied or handed to an external application — browsers have no torrent engine. PRAHA does not host media. Custom headers reported by a source cannot be applied to browser playback and are flagged in the player footer.

## Privacy

Watchlist, history, sources, API keys, and preferences are stored in this browser’s local storage. Keys are sent directly to TMDB; installed Nuvio providers can also access the saved key through their runtime, so only install providers you trust.
