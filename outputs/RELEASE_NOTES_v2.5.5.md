# PRAHA STREAM v2.5.5

Full-codebase error audit + security hardening + Material 3 Expressive redesign.

**Signed with the existing project release key**, so devices on v2.5.4 can upgrade in place.

---

## Security

| Severity | Fix |
|---|---|
| CRITICAL | **Arbitrary APK install** — the updater accepted any JS-supplied URL. Now requires `https:`, a GitHub host, and an `.apk` path, enforced on both the web and native sides. |
| CRITICAL | **Hardcoded signing password** — `'prahastream'` was the fallback store/key password in `build.gradle`. Removed; release signing now fails loudly instead of producing a forgeable build. |
| HIGH | **Native bridge URL validation** — new `safeRemoteUrl()` applied to `proxyStreamUrl`, `httpRequest`/`Async`, `openExternalPlayer`, `downloadAndInstallUpdate`, `vlcPlay`, `addSubtitle`. |
| HIGH | **Backup import** — deep validation: prototype-pollution keys stripped, recursion capped, addon `manifestUrl` must be http(s) with a manifest, oversized scraper code rejected. |
| HIGH | **Local proxy** — per-hop target validation (rejects `169.254.169.254` and its own port), CRLF/hop-by-hop header rejection, `Access-Control-Allow-Origin` pinned to `https://localhost`. |
| HIGH | **Backup leak** — `allowBackup="false"` + `dataExtractionRules` excluding API keys and tokens from cloud/D2D backup. |
| HIGH | **Cleartext** — new `network_security_config.xml` forbids cleartext for TMDB/Trakt/Simkl/GitHub while keeping legacy IPTV/LAN streams working (staged migration). |
| MEDIUM | Bounded thread pool, FileProvider narrowed to `Download/`, `server.allowNavigation`, dialog semantics + focus restore for TV overlays. |

## Correctness

- Discover "Load more" and Stremio catalog no longer let a stale response overwrite a newer one.
- A new search now clears the pagination flag instead of leaving it stuck `true`.
- Arrow keys no longer scroll the page at D-pad focus edges.
- `.details-episode-card` mobile `gap` is no longer overridden by the base rule.

## UI — Material 3 Expressive

- `--md-sys-*` role layer derived from the existing theme tokens, so **all five accent palettes keep working**.
- 48dp minimum touch targets (was 45/41/33/32px), 3px focus ring, spring motion.
- Opt-in light theme with contrast-corrected per-accent values.
- `prefers-reduced-motion` honoured globally.
- 240px rail, 28px hero corner scale.

## Known open issues (not fixed in this release)

- **The native bridge is still injected into every frame.** `addJavascriptInterface` cannot verify the calling origin. The fix is `WebViewCompat.addWebMessageListener` with `allowedOriginRules` plus a JS async-bridge rewrite; until then, untrusted iframes are sandboxed and scheme-allowlisted as defence-in-depth.
- TMDB key still reaches Worker scope (removing it breaks third-party scrapers).
- `nuvioWorker` response/timeout handling, cache caps, IPTV HTTPS migration, AnimeView/AnimeDiscussion races, VLC PiP lifecycle, FlowView aria-labels.

Full details: `outputs/ERROR_AUDIT_REPORT.md` (40 findings).

## Verification

- `npm run typecheck` — exit 0
- `npm test` — 18/18 files, 143/143 tests
- `npm run build` — success
- `./gradlew assembleRelease` — success, signature verified
