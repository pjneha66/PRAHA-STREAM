# PRAHA STREAM

A completely rebuilt, responsive streaming interface inspired by Nuvio’s bring-your-own-sources philosophy. PRAHA combines Stremio addons and Nuvio plugin repositories in one local-first library.

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

Only install third-party repositories you trust. Native Nuvio and browser networking are different: remote manifests, scrapers, catalogs, and media must permit browser CORS requests. PRAHA reports these errors rather than pretending a source is connected.

## Personal TMDB API key

PRAHA ships **without a built-in or shared TMDB key**. Open **Settings → TMDB API** to paste, verify, save, show/hide, or clear your own key. Both TMDB v3 API keys and v4 read access tokens are supported. The key is used for trending titles, search, metadata enrichment, IMDB/TMDB ID resolution, and Nuvio’s standard `TMDB_API_KEY` scraper binding.

The curated PRAHA catalog and Stremio addon features remain available without a TMDB key. Self-hosted deployments can optionally set `VITE_TMDB_API_KEY`; a key saved in Settings takes priority.

## Playback and privacy

Direct browser-compatible video and HLS streams use the built-in player. YouTube sources open in an embedded player; magnet links can be copied or handed to an external application. PRAHA does not host media or include a torrent engine.

Watchlist, history, sources, API keys, and preferences are stored in this browser’s local storage. Keys are sent directly to TMDB; installed Nuvio providers can also access the saved key through their runtime, so only install providers you trust.
