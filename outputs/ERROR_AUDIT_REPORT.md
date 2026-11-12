# PRAHA STREAM — Full Codebase Error & Security Audit

**Audited revision:** `git HEAD` = `4f37582` (v2.5.4), **pre-fix baseline**  
**Generated:** 2026-11-12 · **Method:** `android-native-dev` skill workflow (Gradle-first validation), three parallel read-only audits (React/hooks/CSS, services/data, Android native), cross-verified and deduplicated  
**Scope:** compile, test, build, runtime, async, security, Android-native, TV/D-pad, accessibility, Material Design compliance

> **Revision note — read this first.** All line numbers below refer to **`git HEAD` (4f37582)**, the revision the three audits examined. Seven files were modified in the working tree during/after the audit (`App.tsx`, `PlayerModal.tsx`, `StremioExplorer.tsx`, `UpdateModal.tsx`, `useSpatialNavigation.ts`, `androidBridge.ts`, `vite.config.ts`), plus three Android/native/CSS tracks currently in flight. Therefore some cited sinks **no longer exist in the working tree**. The **Status** column records remediation explicitly. To verify any finding against the original code, use `git show HEAD:<path>`.

---

## 1. Executive summary

| Severity | Count | Headline |
|---|---:|---|
| **CRITICAL** | 3 | Arbitrary APK install from a JS-supplied URL; hardcoded public signing credentials; untrusted stream URL in an unsandboxed iframe reaching the all-frames native bridge |
| **HIGH** | 11 | Native bridge exposure, open proxy / SSRF, unvalidated native URL sinks, backup trusts arbitrary JSON, TMDB key exposed to untrusted scraper code, cleartext + mixed content, dev-relay redirect SSRF, two React async race conditions |
| **MEDIUM** | 20 | Intent redirection, backup/cleartext leaks, exported deep link, VLC/PiP lifecycle, unbounded caches & threads, IPTV correctness bugs, D-pad overlay scoping, etc. |
| **LOW** | 6 | Arrow-key edge scroll, uncleaned timers, missing aria-labels, CSS media-order bug, defensive `JSON.parse`, native hygiene |
| **Total distinct** | **40** | After dedup (see §7) |

**Strongest realistic exploit chain:** a malicious addon/scraper injected via a trusted-looking backup (H-04) → untrusted `stream.url` rendered into an unsandboxed iframe (C-01) → `window.PrahaNative.downloadAndInstallUpdate` reachable in that frame (C-02) → arbitrary APK install with a publicly-known signing key (C-03). Side channel: TMDB API key theft (H-05).

**Build/test health before any fix:** `npm run typecheck` ✅ · `npm run build` ✅ (after one transient sandbox broker retry) · `./gradlew assembleDebug --offline` ✅ (`BUILD SUCCESSFUL in 21s`) · `npm test` ❌ (Vitest worker-startup failures).

---

## 2. Verification results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | ✅ exit 0 (also re-verified after the first fix batch) |
| Production build | `npm run build` | ✅ `2192 modules transformed`, built in 22.92s. First attempt hit a transient `ECONNREFUSED .../broker.sock` loading `lucide-react/.../half-note.mjs`; plain retry succeeded — not a code defect. |
| Test suite (baseline) | `npm test` | ❌ unhandled `[vitest-pool]` worker errors, exit 1 |
| Test suite (after `vite.config.ts` fix) | `npm test` | ✅ **18/18 files, 143/143 tests, exit 0** in 292.69s |
| Android build | `cd android && ./gradlew assembleDebug --offline` | ✅ `BUILD SUCCESSFUL in 21s`. Warnings only: deprecated Gradle features, deprecated API in `ProtectedEmbedActivity.java`, `Unable to strip libc++_shared.so / libvlc.so / libvlcjni.so`. |
| AppleDouble pollution | `git ls-files \| grep '/\._'` | ✅ 0 tracked (515 untracked `._*` covered by `.gitignore`) |

### 2.1 Root cause of the test failure (F-01, fixed)

Vitest 5 defaults `maxWorkers` to `hw.ncpu` (10 on this machine) and isolates **every file in its own fork**. Each jsdom fork cold-starts in ~22–27s, so ten concurrent forks exceed the pool's 60s worker-startup timeout; files silently never run and Vitest exits 1 with `[vitest-pool-runner]: Timeout waiting for worker to respond`.

`vite.config.ts:146-160` now sets `maxWorkers: 2`, `testTimeout: 15000`, `hookTimeout: 20000`. **`isolate` is deliberately left at its default `true`** — the `isolate: false` experiment made 3 tests fail (`2 failed | 16 passed` files, `3 failed | 140 passed` tests) because suites that `vi.mock()` whole modules leak those mocks across shared workers. A fully serial `--maxWorkers=1` run was killed after >8 minutes.

---

## 3. CRITICAL findings

### C-01 — Untrusted stream URL → unsandboxed iframe → native bridge
**Evidence:** producers `services/stremioService.ts:152-159` (`stream.url` copied verbatim) and `services/nuvioService.ts:139-144`; sink `components/PlayerModal.tsx:273-278` `<iframe src={... : activeStream.url}>` with **no `sandbox`, no protocol allowlist**; `components/FlowView.tsx:543` and `:554-561` also unsandboxed (latter has only `referrerPolicy="origin"`). `components/EmbedModal.tsx:143` does sandbox, but is a second untrusted-content sink (user-defined provider templates / update feed).
**Root cause:** no scheme allowlist on `StreamResult.url`; `javascript:` / `data:` / `blob:` are accepted.
**Amplification (native):** `MainActivity.java:102` calls `webView.addJavascriptInterface(new PrahaJsBridge(), "PrahaNative")`. Per Google's official guidance ([developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)), `addJavascriptInterface` exposes the object to **ALL frames**, including cross-origin iframes, and "the app cannot verify the origin of the calling frame". So framed content can invoke `httpRequest`, `proxyStreamUrl`, `downloadAndInstallUpdate`, `vlcPlay` etc. directly. `CapacitorHttpAndroidInterface` (`CapacitorHttp.java:32`) is likewise injected into all frames.
**Important correction:** the escalation comes **only** from `addJavascriptInterface`. Capacitor's document-start fetch/XHR patch is origin-scoped via `WebViewCompat.addDocumentStartJavaScript(..., Collections.singleton("https://localhost"))` (`Bridge.java:266-270`) and reaches neither Worker scopes nor off-origin iframes. Do **not** attribute the bridge exposure to a CapacitorHttp CORS bypass.
**Sandbox caveat (epistemic precision):** `sandbox` without `allow-same-origin` assigns an opaque origin (restricting DOM/storage/cookies) but does **not** remove natively-injected globals; `EmbedModal.tsx:143` has `allow-scripts`, so that frame still sees `window.PrahaNative` — **per Android's documented all-frames `addJavascriptInterface` behaviour**, not runtime-verified here (no emulator). A one-line on-device `typeof window.PrahaNative` check inside that frame would settle it empirically. Google's mitigation list for this risk contains **no `sandbox` entry**; contrast `Bridge.java:266-270`, where Capacitor's own JS *is* origin-gated. Attribute-level sandboxing is defence-in-depth, **not** the fix.

**CRITICAL stands independently of the above inference**, on three grounds: (a) at audited HEAD `4f37582`, `PlayerModal.tsx:273-278` and `FlowView.tsx:543/554-561` have **no sandbox at all** — those frames definitely have the bridge; (b) the main-frame MITM path (`MIXED_CONTENT_ALWAYS_ALLOW` + `usesCleartextTraffic=true`) injects script into the privileged document; (c) the bridge attack needs **no SOP bypass** — `window.PrahaNative` is a natively-injected global in every frame, not SOP-gated, so cross-origin iframe content calls it directly. Also verified: `Bridge.java:409-411` returns false for `data:`/`blob:`, so those are not intercepted and do render in-frame.
**Fix:** (1) **native-side** — replace `addJavascriptInterface` with `WebViewCompat.addWebMessageListener(webView, "PrahaNative", Collections.singleton("https://localhost"), listener)` (androidx.webkit is already on the classpath); add `removeJavascriptInterface("PrahaNative")` before untrusted loads; set `MIXED_CONTENT_NEVER_ALLOW`, `cleartext=false`, and an explicit `server.allowNavigation` allowlist. (2) **web-side, defence-in-depth** — `safeFrameUrl()` allowing only `http:`/`https:`, restrictive `sandbox` **without** `allow-same-origin`, `referrerPolicy`, and scheme allowlisting on every iframe src.
**Status:** **OPEN — CRITICAL rating retained.** The working-tree patch is genuine *defence-in-depth* (`safeFrameUrl` rejects `javascript:`/`data:`/`blob:`/`file:`, `encodeURIComponent(ytId)`, "Unsafe embed URL" fallback, `referrerPolicy`, `sandbox`, a blocked-state UI with an External-player button), but it does **not** close the finding:

- **Primary reason (native amplification is intact):** the sandbox contains `allow-scripts allow-same-origin` **and** `addJavascriptInterface` injects `PrahaNative` into every frame regardless of origin. So an **absolute `https://attacker.com` embed still gets a frame with `window.PrahaNative`** and can call `httpRequest` / `downloadAndInstallUpdate`. This is supported by Google's official all-frames guidance plus `CapacitorHttp.java:32` injecting `CapacitorHttpAndroidInterface` into all frames — not by a runtime test.
- **Two additional web-side gaps:** `safeFrameUrl` permits plain **`http:`**, which is MITM-able while `allowMixedContent` / `usesCleartextTraffic` remain true (H-07); and the sandbox includes **`allow-popups`**, so framed content can still `window.open()` an off-origin URL that Capacitor converts into an ACTION_VIEW intent (M-01/M-02).
- **Secondary hardening notes (NOT a proven exploit chain):** `allow-scripts` + `allow-same-origin` is a classic sandbox-escape combination; and `new URL(raw, window.location.href)` accepts **relative** URLs resolving to the app's own origin, so the http(s) check does not exclude app-origin frames. Treat these as reasons to tighten the helper, not as evidence of an additional compromise path.
- `FlowView.tsx:543` and `:554-561` remain completely unsandboxed.
- **Scope limit of the native fix:** origin gating (`addWebMessageListener` + `allowNavigation`) blocks off-origin frames, but does **not** block attacker-controlled content loaded at the app's own origin. Full closure also requires `server.allowNavigation`, HTTPS-only / `cleartext=false`, a scheme+host allowlist on every iframe, and a restrictive sandbox.

Native-side origin gating is **required** and **IN PROGRESS** (impl-native). Do not downgrade this finding when the web-side patch lands.

### C-02 — Arbitrary APK install from a JS-supplied URL
**Evidence:** `android/app/src/main/java/com/praha/stream/MainActivity.java:636-708` (`downloadAndInstallUpdate`) — only a null/empty check at `:637`; `DownloadManager` at `:660-667`; FileProvider install at `:681-690`; `AndroidManifest.xml:69` grants `REQUEST_INSTALL_PACKAGES`. Feed source: `services/autoUpdateService.ts:75` (`browser_download_url || html_url`) and `UpdateModal.tsx:29`.
**Root cause:** no `https` enforcement, no fixed release host, no SHA-256 / signing-certificate verification.
**Fix:** require `https:` + host `github.com` / `*.githubusercontent.com` + `.apk` path on both the web and native sides; verify APK digest/signer against a pinned value; or remove the self-updater and the permission.
**Status:** **IN PROGRESS** (impl-web + impl-native). Web-side `openSafeExternalUrl()` fallback already applied.

### C-03 — Hardcoded public signing credentials
**Evidence:** `android/app/build.gradle:3-6` — `ksPass`, `ksAlias`, `ksKeyPass` all default to the literal `'prahastream'`; `:39-63` auto-generates a self-signed keystore with a fixed dname. Verified `release.keystore` opens with `-storepass prahastream`. `.gitignore:43` ignores the file but the password is in source.
**Impact:** enables forged updates, compounding C-02.
**Fix:** remove fallback literals; fail the build when env vars are absent, or read a gitignored `keystore.properties`; use a real release key.
**Status:** **IN PROGRESS** (impl-native).

---

## 4. HIGH findings

| ID | Finding | Evidence | Root cause / Fix | Status |
|---|---|---|---|---|
| **H-01** | Unvalidated URLs passed **directly** to `window.PrahaNative.*` (distinct from C-01 — needs no iframe) | `services/androidBridge.ts:238-252` `proxyStreamUrl`, `:394-424` `httpRequest`/`Async`, `:500-512` `openExternalPlayer`, `:558-561` `downloadAndInstallUpdate`; native `MainActivity.java:225-235, 344-348, 395-448` | No scheme/host allowlist before the native call. Centralize `safeRemoteUrl()` (`new URL`, `https:`/`http:` only, reject credentials) and apply before every bridge call; reuse the already-correct `openSafeExternalUrl` (`:167-176`). | **MOSTLY OPEN — IN PROGRESS** (impl-web + impl-native). Only `:566` is fixed (`openSafeExternalUrl`). Still unvalidated: `:561` direct `PrahaNative.downloadAndInstallUpdate(apkUrl, ...)`, `:238-252` `proxyStreamUrl`, `:394-424` `httpRequest`/`Async`, `:500-512` `openExternalPlayer`, and the `window.open(href, ...)` at `:522`. |
| **H-02** | `PrahaNative` bridge exposed to every frame of a cleartext/mixed-content WebView | `MainActivity.java:102` (+`:100`); `capacitor.config.json:8,11`; `AndroidManifest.xml:25` | `MIXED_CONTENT_ALWAYS_ALLOW` + `usesCleartextTraffic=true` + `allowMixedContent/cleartext=true` permit MITM HTTP script injection into the privileged document. Fix per C-01 (native). | **IN PROGRESS** (impl-native) |
| **H-03** | Unauthenticated open proxy → SSRF / header injection / DoS | `PrahaStreamProxy.java:48, 79-90, 134-149, 215, 226-240, 349`; `capacitor.config.json:15-17` | Loopback bind is **correct** (`:48`, `127.0.0.1` only), but arbitrary `url`/`headers` query params with no token/origin check, `ACAO: *`, self-referential URL → recursive DoS on the uncapped pool. Fix: validate target scheme/host, reject link-local metadata + own port, sanitize header names/values (CRLF), require app-origin `Origin`/`Referer`, echo `https://localhost` instead of `*`, bound threads. `javascript:`/`file:` are **not** execution/file-disclosure vectors here (cast failure at `:215`, swallowed at `:202`). | **IN PROGRESS** (impl-native) |
| **H-04** | SSRF via native HTTP layer / `nativeFetchText` | `services/androidBridge.ts:370-391` (`CapacitorHttp.request` with no validation), `services/nuvioService.ts:91-98` (forwards `msg.url` verbatim), `services/nuvioWorker.ts:16-32,53-60`, `services/torrentStreamingService.ts:25-28`, `services/androidBridge.ts:294-306` | **Precise mechanism:** the Worker's `fetch` is plain browser `fetch` (CORS-bound). `smartFetch` falls back to `proxyFetchViaMainThread` → posts `fetch-proxy` to the **main thread** → `nuvioService.ts` calls `nativeFetchText` → explicit `CapacitorHttp.request({url,...})`. Capacitor's document-start fetch patch is scoped to `https://localhost` and **never reaches Workers**. So the CORS-free leg is main-thread and is genuine SSRF; `CapacitorHttp.enabled: true` with no host allowlist is the native amplifier, not the cause. Fix: host allowlist + URL validation at `nativeFetchText`. | **IN PROGRESS** (impl-web + impl-native) |
| **H-05** | User's TMDB API key exposed to untrusted scraper code | `services/nuvioService.ts:130` (`getTmdbApiKey()` into Worker), `services/nuvioWorker.ts:92` (`setGlobal('TMDB_API_KEY', ...)`), `:100-104` (`new Function()` evaluates repository-supplied code) | **Web-side secret-isolation defect.** Needs no CapacitorHttp at all: plain `fetch` can `no-cors` POST data out, and the scraper can embed the key in a returned `stream.url` the app later loads. `App.tsx:119`, `usePersistentState.ts:44`, `tmdbConfig.ts:10-18` are correctly guarded — not a React-layer defect. Fix: remove the key from the Worker payload/`setGlobal`; proxy TMDB calls on the main thread or require scrapers to supply their own key. | **DEFERRED** — removing the global would break existing third-party scrapers; requires a compatibility shim and a scraper API migration. Documented as accepted residual risk. |
| **H-06** | Backup import trusts arbitrary JSON | `services/backupSyncService.ts:42-61` (only `app` + `Array.isArray(addons)`), `App.tsx:826-839` | `addons[].manifestUrl`, Nuvio `code`, `profiles`, `repositories`, `nuvioSettings`, `profileData` trusted wholesale; only a `window.confirm` at `:825` mitigates. Fix: deep-validate every field, cap sizes, reject `__proto__`/unknown keys. **No separate `App.tsx` defect** — flat keys, inside outer try. | **IN PROGRESS** (impl-web) |
| **H-07** | Cleartext + mixed content, no network security config | `AndroidManifest.xml:25`, `capacitor.config.json:8,11`, `MainActivity.java:100` | MITM HTTP script injection into the bridge-holding WebView. **Fix must be staged** — see §6. | **IN PROGRESS** (impl-native) |
| **H-08** | `allowBackup=true` leaks plaintext secrets | `AndroidManifest.xml:19`; `MainActivity.java:101` (`setDomStorageEnabled(true)`); merged manifest has no `dataExtractionRules`/`fullBackupContent`/`networkSecurityConfig` | Impact evidence: `data/defaults.ts:95-118` (`tmdbApiKey`, `debrid.apiKey`, `sync.traktToken`, `sync.simklToken`, both client IDs, `imdx.apiKey`) + `praha.torrent.host` stored plaintext via `usePersistentState.ts:43-47`. **`usePersistentState` itself is correct** (quota try/catch) — do not report plaintext-at-rest as a standalone defect. `minSdk 24` means Android 7-11 expose all of it via `adb backup`; 12+ include WebView localStorage by default. Fix: `allowBackup="false"` + `dataExtractionRules`, and encrypt the secrets. | **IN PROGRESS** (impl-native) |
| **H-09** | Dev/preview image-relay SSRF via redirects (Node server, distinct from H-03) | `vite.config.ts:79-95`, `isPrivateHost` at `:60-74` | `isPrivateHost` validates only the initial hostname; Node `fetch` defaults to `redirect:'follow'`, so a public URL can 302 to `127.0.0.1` / `169.254.169.254`. Also misses IPv6-mapped `::ffff:127.0.0.1`, `100.64/10`, DNS rebinding. Fix: `redirect:'manual'` + re-validate every `Location`; resolve DNS. | **OPEN** — dev/preview only, not shipped in the APK; low production exposure. |
| **H-10** | `StremioExplorer` catalog async race | `components/StremioExplorer.tsx:54-67,102-111` | `loadCatalog` (`useCallback []`) has no in-flight cancellation; debounce cleanup only clears the timer, so an older search can overwrite a newer one at `setCatalogItems` (`:59`). Fix: monotonic `requestIdRef`, ignore stale resolutions, invalidate on addon switch. | **FIXED** — `catalogRequestRef` + `isCurrent()` guards + addon-switch invalidation; typecheck ✅, full suite ✅ |
| **H-11** | `App.tsx` Discover pagination async race | `App.tsx:449-474` | `loadMoreDiscover` has no guard; a stale page-2 response appends OLD-query results via `setDiscoverItems(prev => [...prev, ...])` and clobbers `setDiscoverPage`/`setDiscoverHasMore`. Fix: capture a request token at call time and bail out of `setState` if superseded. | **FIXED** — `discoverRequestRef` + `isCurrent()` guards; typecheck ✅, full suite ✅ |

---

## 5. MEDIUM and LOW findings

| ID | Sev | Finding | Evidence | Fix | Status |
|---|---|---|---|---|---|
| M-01 | MED | `window.open()` fallbacks → outgoing ACTION_VIEW intents | `services/androidBridge.ts:522` (`openExternalPlayer`), `:566` (`downloadAndInstallUpdate`); `Bridge.java:389-426` `launchIntent` has no scheme allowlist; `BridgeWebViewClient.java:27-30`; `Bridge.java:593` `setJavaScriptCanOpenWindowsAutomatically(true)`; `capacitor.config.json:6-9` no `server.allowNavigation`; `MainActivity.java:395-448` `openExternalPlayer` unhardened (attacker-controlled title/headers/package) | Validate `https:` before `window.open`; set `allowNavigation`; add `isForMainFrame()` check. `**:566**` is a separate fallback path (native absent/false) — keep with this item, not H-01. | **PARTIALLY FIXED** — `:566` now `openSafeExternalUrl()`; `:522` still open; `allowNavigation` IN PROGRESS |
| M-02 | MED | Unvalidated intent launch from WebView navigation | `Bridge.java:389-426` + `BridgeWebViewClient.java:27-30` delegate `shouldOverrideUrlLoading` with **no `isForMainFrame()` check**, no `allowNavigation` | Strict `server.allowNavigation` allowlist + WebViewClient rejecting non-http(s) schemes. Off-origin iframe loads may trigger this (WebView-version-dependent, not runtime-verified). | **IN PROGRESS** (impl-native) |
| M-03 | MED | Proxied `Response` forced to `text/plain`; raw status | `services/nuvioWorker.ts:74-77` | Status 204/205/304/0 throws inside `async onmessage` (no try/catch) → unhandled rejection; scraper content-type checks break. Fix: forward real content-type, guard status, wrap branch. | **OPEN** |
| M-04 | MED | `pendingProxy` timeout leak; `AbortError` re-issued | `services/nuvioWorker.ts:16-32,53-59` | Add timeout + delete; rethrow `AbortError` instead of treating it as CORS. Note `nuvioService.ts:86,116,122` **do** terminate workers/clear timers — no missing-termination defect. | **OPEN** |
| M-05 | MED | `RESPONSE_CACHE` unbounded | `services/sankaService.ts:75,447-496` | Expired entries never evicted (only full `clearSankaCache`). Fix: delete-on-read + LRU/size cap. | **IN PROGRESS** (impl-web) |
| M-06 | MED | `rawSubtitleCache` unbounded, caches `blob:` keys | `services/subtitleService.ts:80,228` | Bound/evict; never cache `blob:` keys. | **IN PROGRESS** (impl-web) |
| M-07 | MED | `JSON.parse(readyRes.data)` without `ok` check | `services/debridService.ts:57-58` | Check `readyRes.ok` first. | **IN PROGRESS** (impl-web) |
| M-08 | MED | IPTV bare `fetch` instead of `nativeFetchText` on Android | `services/iptvService.ts:197-215,350` | CORS blocks portal calls; forbidden `User-Agent` header dropped. Fix: `nativeFetchText`. | **IN PROGRESS** (impl-web) |
| M-09 | MED | IPTV ternary precedence bug producing `/live/undefined` | `services/iptvService.ts:1088` — `s.iframe \|\| s.uri_name ? \`https://old.ppv.to/live/${s.uri_name}\` : ''` | Parses as `(a\|\|b)?...`, discarding a valid `s.iframe`. Fix: `s.iframe \|\| (s.uri_name ? ... : '')`. **Verified in HEAD.** | **IN PROGRESS** (impl-web) |
| M-10 | MED | M3U URL lines accepted without scheme validation | `services/iptvService.ts:950` | `.m3u8`/`.ts` substring or protocol-relative `//host/...` accepted. Fix: require absolute `https?:` or resolve against playlist base. | **IN PROGRESS** (impl-web) |
| M-11 | MED | `streamId`/`containerExt` unencoded → path/query injection | `services/iptvService.ts:311` | `encodeURIComponent` both. | **IN PROGRESS** (impl-web) |
| M-12 | MED | Hardcoded cleartext `http://` Xtream portals with credentials in URL paths | `services/iptvService.ts:459-461` (`watch.topiptv.xyz:80`, `cdn.megastreams.io:8080`, `live.stream4k.xyz:80`), `:394` forces `http://`, `:311` | On-path readable, reflected by proxy `ACAO: *`, also lands in plaintext backup (H-08). Fix: migrate to HTTPS, stop putting credentials in URL paths. | **DEFERRED (staged)** — see §6 |
| M-13 | MED | Auto-update feed is an untrusted source over cleartext/MITM | `UpdateModal.tsx:29,35`; `services/autoUpdateService.ts:75` | **Not a third sink.** `downloadAndInstallUpdate` never rethrows (native absent → fallback; native throws → caught `:563` → fallback), so `UpdateModal.tsx:35`'s `catch` is normally unreachable. Its live sinks are `:561` (→ H-01) and `:566` (→ M-01). Folded into those as source evidence. | **FIXED (web-side)** — `openSafeExternalUrl()` + timer cleanup |
| M-14 | MED | D-pad focus escapes overlays on Android TV | `hooks/useSpatialNavigation.ts:44-46` scopes to last visible `[role="dialog"]`; `components/Navigation.tsx:133-171` profile popover uses `role="menu"`, `:255-294` "More" sheet has no dialog role | Add `role="dialog" aria-modal="true"`, focus first button on open, scope arrow focus, Escape to close, restore trigger focus. | **IN PROGRESS** (impl-ui) |
| M-15 | MED | `AnimeView` grid async race | `components/AnimeView.tsx:125-152` | `loadGrid(1,false)` re-runs on `[sort,format,minScore]` without cancelling the prior `animeService.browse`. Fix: `let active=true; return ()=>{active=false}`. | **OPEN** |
| M-16 | MED | `AnimeDiscussion` comment async race | `components/AnimeDiscussion.tsx:64-82` | Prior `getComments` not cancelled when `episode`/`resolvedIds` change. Fix: active flag / `AbortController`. | **OPEN** |
| M-17 | MED | Exported `stremio://` deep link | `AndroidManifest.xml:28-48` | Exported, BROWSABLE, `singleTask`, arbitrary `stremio://` data, no host/path validation, no `onNewIntent` sanitization; `capacitor.plugins.json` is `[]` and `@capacitor/app` is not installed, so the feature is **also inert**. Fix: host/path restrictions + `onNewIntent` validation, or remove the filter. | **IN PROGRESS** (impl-native) |
| M-18 | MED | Unbounded thread pools | `MainActivity.java:56` (`Executors.newCachedThreadPool()`), `:218-223`; `PrahaStreamProxy.java:51,96-97` | Reachable from JS (`httpRequestAsync`) and any TCP client → thread/OOM DoS. Fix: fixed-size pool + bounded queue. | **IN PROGRESS** (impl-native) |
| M-19 | MED | VLC lifecycle / PiP / audio focus | `MainActivity.java:134-139,377-393`; `AndroidManifest.xml:68` | `onPause()` pauses unconditionally (no `isInPictureInPictureMode()`, no `onResume()`), `enterPip()` returns true unconditionally, no `AudioManager` focus handling, `WAKE_LOCK` never acquired → PiP freezes, audio overlaps. Fix: skip pause in PiP, honor PiP result, request/abandon audio focus. | **IN PROGRESS** (impl-native) |
| M-20 | MED | Overbroad FileProvider paths | `res/xml/file_paths.xml:3-6` | `<external-path path=".">`, `<cache-path path=".">`, `<external-files-path path=".">` expose whole external storage/cache. Fix: narrow to the directories actually used (e.g. `external-files-path path="Download/"`). | **IN PROGRESS** (impl-native) |
| L-01 | LOW | Arrow keys scroll the page at D-pad focus edges | `hooks/useSpatialNavigation.ts:83-87` | No `preventDefault()` when no directional candidate exists. **FIXED** — `event.preventDefault()` added after mapped arrow handling; duplicate later calls removed. | **FIXED** |
| L-02 | LOW | Uncleaned timers → `setState` after unmount | `SourcePanel.tsx:106`, `FlowView.tsx:504`, `PlayerModal.tsx:150`, `DetailsModal.tsx:318`, `UpdateModal.tsx:31`, `MpvPlayer.tsx:461`; `AnimeView.tsx:95-123` `loadRows` fires 5 requests with no active guard | Store timer ids in refs, clear in effect cleanup, add active guards. | **PARTIALLY FIXED** — `UpdateModal.tsx` `indicatorTimerRef` cleanup applied; rest **OPEN** |
| L-03 | LOW | Icon-only buttons lack accessible names | `components/FlowView.tsx:1040,1190` (`<button type="submit"><Plus/></button>`) | Add `aria-label`/`title`. | **IN PROGRESS** (impl-web) |
| L-04 | LOW | CSS mobile overrides silently discarded | `index.css:2022` base `.details-episode-card` sits **after** the `@media (max-width:680px)` block at `:1370-1684`; two 680px blocks (`:1370`, `:2105`) sandwich it; intended mobile `gap:10px` at `:1661/1662` loses to base `gap:14px` at equal specificity | Consolidate duplicates; keep base rules above all media queries. | **IN PROGRESS** (impl-ui) |
| L-05 | LOW | Synchronous `httpRequest` path `JSON.parse(raw)` lacks try/catch | `services/androidBridge.ts:423-433` | **Defensive only** — `MainActivity.java:344-348` always returns `JSONObject.toString()` (success `:305-307`, exception `:309-315`, redirect cap `:321-326`); only a missing bridge / Java crash yields `undefined`. Wrap for parity with the async path (`:95-114`). | **OPEN** |
| L-06 | LOW | Native hygiene | `android/gradle.properties:23` hardcoded macOS JDK path; `android/build.gradle:25-27` macOS build-dir redirect; `res/xml/config.xml:3` `<access origin="*"/>`; `MainActivity.java:699` `RECEIVER_EXPORTED`; `EmbedBlocklist.java:43-53` syntactic host check allows DNS rebinding (`nip.io` → `127.0.0.1`) | Fix each. The JDK path is intentionally retained on this machine so Gradle keeps building. | **PARTIALLY DEFERRED** |

---

## 6. Staged cleartext migration — the wording that matters

`usesCleartextTraffic=false` / `cleartextTrafficPermitted=false` is **PROCESS-WIDE** on Android, not WebView-only. It governs every cleartext `HttpURLConnection` in the app process.

- A **blanket** disable **without** narrow `<domain>` exceptions is what **breaks** the app: hardcoded `http://` Xtream portals (`services/iptvService.ts:459-461, :394, :311`), `PrahaStreamProxy.openFollowRedirects` (`PrahaStreamProxy.java:215`, any `http://` stream URL), `MainActivity.executeHttpRequest` (`:235`), LibVLC HTTP fetching (`PrahaVlcPlayer.java:223`), CapacitorHttp, and the `DownloadManager` request (`MainActivity.java:660-667`).
- A new `res/xml/network_security_config.xml` with `cleartextTrafficPermitted=false` **plus narrow `<domain includeSubdomains>` exceptions** is the **staged fix that preserves functionality**. The exceptions are the mitigation, not the cause of breakage.
- **Honest limitation:** a static allowlist covers the three hardcoded hosts but cannot enumerate arbitrary Reddit-scraped portals, because `IptvScraper.extractPortals` (`:394`) forces `http://` onto any scraped host. Those need an app-level HTTPS upgrade or they will break. Long-term fix = migrate portals to HTTPS; the staged config bridges that.
- **Desirable side effect:** blocking cleartext for `DownloadManager` reinforces C-02's force-https-APK fix.

---

## 7. Deduplication and attribution rules applied

Three independent audits produced overlapping results. The following merge rules were agreed across all three and applied above:

1. **One CRITICAL iframe row.** Explore-2 #1 (HIGH) and Explore-1 #5 (escalated CRITICAL) are the **same defect** → C-01, reported once at CRITICAL.
2. **Four distinct URL-related items, no over-merge:** (1) C-01 iframe; (2) H-01 direct `window.PrahaNative.*` calls (different sink, needs no iframe); (3) M-01 `window.open()` fallbacks → `Bridge.launchIntent` ACTION_VIEW (different mechanism); (4) H-04 SSRF via native HTTP proxy / `nativeFetchText`.
3. **No standalone "plaintext secrets in localStorage" defect.** `usePersistentState.ts:43-47` is correct generic persistence behaviour (quota try/catch). The defect is H-08 (`allowBackup=true`); the enumerated secrets are its **impact evidence**.
4. **Backup import gap** lives solely in `services/backupSyncService.ts:42-61`; no separate `App.tsx:826-839` item.
5. **TMDB-key-in-Worker** (H-05) lives entirely in `services/`; `App.tsx:119` / `usePersistentState.ts:44` / `tmdbConfig.ts:10-18` are corroborating, not a React-layer defect.
6. **`UpdateModal.tsx:35`** is a redundant, normally-unreachable fallback; not a third live `window.open` sink. Folded into M-13 as source evidence.
7. **Retracted:** the `startsWith('http')` / `httpjavascript:` vector is **not exploitable** (`imageUrl` rejects `javascript:`; `httpjavascript:` in an `<img src>` is a non-executable invalid URL). Its only residue, `http://127.0.0.1` reaching `nativeFetchText`, is a subset of H-04. Explore-2's authoritative item #16 is the LOW `JSON.parse` defensive item (L-05) — **not** the retracted claim.
8. **Verified correct — do NOT report:** `PrahaStreamProxy.java:48` binds loopback only (not `0.0.0.0`); SDK versions match Capacitor 8.6.0 (`compileSdk 36 / targetSdk 36 / minSdk 24`); `PrahaVlcPlayer.release()` detaches/releases LibVLC and **is** called (`MainActivity.java:143-145`); `ProtectedEmbedActivity` is hardened (no bridge, file access off, `MIXED_CONTENT_NEVER_ALLOW`, blocklist); TV manifest declarations correct; JS built via `JSONObject.quote`/`toString` (`MainActivity.java:333-335, 86`) is properly escaped; `openBrowser` (`:189-198`) is https-hardened; `openSafeExternalUrl` / `openProtectedEmbed` are correctly guarded; `homeCache.ts`, `embedUpdates.ts`, `sankaService.ts` `safeUrl`/`fetchJson`, `nuvioService` worker termination, `IptvStore`, and all in-scope `localStorage`/`JSON.parse` are try/catch guarded.

---

## 8. Verification after the first fix batch

The following were applied **before** the three in-flight tracks and verified together:

| File | Change | Verified |
|---|---|---|
| `vite.config.ts:146-160` | `maxWorkers: 2`, `testTimeout: 15000`, `hookTimeout: 20000`; `isolate` stays `true` | ✅ 18/18 files, 143/143 tests, exit 0 |
| `App.tsx` | `discoverRequestRef` monotonic token + `isCurrent()` guards in `loadMoreDiscover` | ✅ typecheck 0, suite green |
| `components/StremioExplorer.tsx` | `catalogRequestRef` + stale-response guards + invalidation on addon switch | ✅ typecheck 0, suite green |
| `hooks/useSpatialNavigation.ts` | `event.preventDefault()` on mapped arrow keys; removed duplicate later calls | ✅ typecheck 0, suite green |
| `components/PlayerModal.tsx` | `safeFrameUrl()` http(s)-only, `referrerPolicy`, `sandbox`, "Unsafe embed URL" blocked state, `encodeURIComponent(ytId)` | ✅ typecheck 0, suite green — **but `allow-same-origin` still present** |
| `services/androidBridge.ts` | `downloadAndInstallUpdate` fallback → `openSafeExternalUrl(apkUrl)` | ✅ typecheck 0, suite green |
| `components/UpdateModal.tsx` | `indicatorTimerRef` cleanup on unmount; `openSafeExternalUrl(update.apkUrl)` in catch | ✅ typecheck 0, suite green |
| `App.tsx` *(added during report review)* | Regression fix: search effect now calls `setDiscoverLoadingMore(false)` when it bumps `discoverRequestRef` | ✅ typecheck 0 |

**Why the last row was needed:** the original race-condition fix guarded the `finally` block with `if (isCurrent()) setDiscoverLoadingMore(false)`. When a new search invalidated an in-flight "load more", `isCurrent()` became false, so the flag was **never cleared** and `discoverLoadingMore` stayed `true` permanently — disabling all future pagination. The search effect now clears it synchronously when the token is bumped.

### 8.1 Resolved / open status for the React-layer findings

Verified against the working tree (single authority for revision status):

| Finding | Status | Detail |
|---|---|---|
| H-10 `StremioExplorer` race | ✅ **RESOLVED** | `catalogRequestRef` token + `isCurrent()` guards, including addon-switch invalidation |
| H-11 `App.tsx` pagination race | ✅ **RESOLVED** | `discoverRequestRef` token checked after await / catch / finally, plus the flag-clear correction above |
| L-01 arrow-edge scroll | ✅ **RESOLVED** | Unconditional `preventDefault()` for mapped arrow keys |
| L-02 `UpdateModal` timer | ✅ **PARTIALLY RESOLVED** | `:31` timer now cleared on unmount; the other five timers and `AnimeView.loadRows` remain open |
| C-01 iframe → native bridge | ❌ **OPEN (CRITICAL)** | Web-side patch is defence-in-depth only; see §3. Native origin gating still required |
| H-01 direct native URL calls | ❌ **MOSTLY OPEN** | Only `:566` fixed; gap list in §4 |
| M-13 update URL source | ⚠️ **PARTIALLY RESOLVED** | `window.open` paths fixed; the direct native call at `:561` is not |
| M-14 D-pad overlay scoping | ❌ **UNTOUCHED** | `Navigation.tsx:133` / `:255` still lack `role="dialog"` |
| M-15 / M-16 async races | ❌ **UNTOUCHED** | `AnimeView.tsx:125-152`, `AnimeDiscussion.tsx:64-82` |
| L-03 icon-only aria-labels | ❌ **UNTOUCHED** | `FlowView.tsx:1040,1190` |
| L-04 CSS media ordering | ❌ **UNTOUCHED** | `index.css:2022` |
| C-01 second sink | ❌ **UNTOUCHED** | `FlowView.tsx:543` / `:554-561` iframes still unsandboxed |

---

## 9. Residual risk and recommended next steps

1. **Complete the native bridge migration.** Everything in §3 rests on `addJavascriptInterface`. Web-side allowlisting is defence-in-depth only; `WebViewCompat.addWebMessageListener` with `allowedOriginRules = ["https://localhost"]` is the actual fix. Until then, any cross-origin iframe in the app document can call the bridge.
2. **Empirically confirm the sandboxed-frame question** on a device/emulator: log `typeof window.PrahaNative` from inside `EmbedModal.tsx:143`'s frame.
3. **Fix the OPEN items** (H-09 dev-relay redirect SSRF; M-03/M-04 `nuvioWorker` response handling & timeout; M-15/M-16 `AnimeView`/`AnimeDiscussion` races; L-02 remaining timers; L-05 defensive parse).
4. **Plan the H-05 migration** — removing `TMDB_API_KEY` from Worker scope will break third-party scrapers that read the global; ship a main-thread TMDB proxy first, then remove the global behind a compatibility window.
5. **Plan the HTTPS portal migration** (§6) — scraped portals cannot be enumerated in a static allowlist.
6. **Re-run the full gate after all tracks land:** `npm run typecheck && npm test && npm run build` and `cd android && ./gradlew assembleDebug --offline`. Run the Android build on a device with at least one `http://` legacy stream to prove the network security config exceptions work.
7. **UI follow-up:** after the M3 token remap, audit literal `rgba()`/hex colours still outside the token system, and verify all five accent themes in both dark and light at 375px / 1280px / 1920px.

---

## 10. Deliverables in this pass

| File | Purpose |
|---|---|
| `outputs/ERROR_AUDIT_REPORT.md` | This consolidated audit |
| `outputs/MATERIAL3_EXPRESSIVE_SPEC.md` | Material 3 Expressive design spec (user-selected direction) |
| `outputs/m3-expressive-preview.html` | Interactive design preview: dark/light, 5 accents, legacy comparison, 8dp grid, D-pad simulation |
| In-repo code changes | Error fixes (§8) + implementation pass (§11) |

---

## 11. Implementation pass — authoritative final status

The three delegated implementation tracks were killed by an account-wide HTTP 429 usage limit before landing any edits, so the remaining work was completed directly. **This table supersedes the Status column above** where the two disagree.

### Verified gate

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ `✓ built in 18.83s` |
| Full test suite | ✅ **18/18 files, 143/143 tests, exit 0** (66.98s) |
| Targeted tests (7 suites, 61 tests) | ✅ 7/7 files, 61/61 tests, exit 0 |
| `./gradlew assembleDebug --offline` | ✅ `BUILD SUCCESSFUL in 8s` (only the pre-existing deprecation note) |

One regression was caught by the suite and fixed: `safeRemoteUrl` initially rejected the `content://` URIs that Android's system file picker returns for local subtitles (`tests/audio-subtitle-manager.test.tsx:149`). `addNativeSubtitleSlave` now accepts `content://` (permission-granted by the OS, CR/LF rejected) while still requiring http(s) for remote tracks.

### Closed in this pass

| ID | What changed | File |
|---|---|---|
| **C-02** | APK install now requires `https:` + host `github.com`/`*.githubusercontent.com` + an `.apk` path, enforced **on both sides** (web `safeRemoteUrl` + native `isAllowedRemoteUrl`/`looksLikeApk`/`hostOf`). | `services/androidBridge.ts`, `MainActivity.java` |
| **C-03** | Removed the `'prahastream'` fallback passwords and the auto-generated keystore. Release signing now fails loudly without env vars instead of producing a forgeable build. Debug builds are unaffected. | `android/app/build.gradle` |
| **H-01** | Added `safeRemoteUrl(raw, {allowHttp, allowedHosts})` and applied it to `proxyStreamUrl`, `nativeFetchText` (both CapacitorHttp and `httpRequest*`), `openExternalPlayer`, `downloadAndInstallUpdate`, `nativeVlcPlay`, `addNativeSubtitleSlave`. | `services/androidBridge.ts` |
| **H-03** | Proxy validates every hop's target (http(s), no userinfo, rejects `169.254.169.254` and its own port), rejects CR/LF + hop-by-hop header overrides, and pins `Access-Control-Allow-Origin` to `https://localhost`. | `PrahaStreamProxy.java` |
| **H-06** | Backup import now deep-validates: prototype-pollution keys stripped, recursion capped, addon `manifestUrl` must be http(s) with no credentials and must carry a manifest, profiles/repositories capped and shape-checked, oversized scraper `code` rejected. | `services/backupSyncService.ts` |
| **H-07** | New `network_security_config.xml`; cleartext forbidden for TMDB/Trakt/Simkl/GitHub, permissive base retained so IPTV/LAN still works (staged, as designed). | `res/xml/network_security_config.xml`, `AndroidManifest.xml` |
| **H-08** | `allowBackup="false"` + `dataExtractionRules` excluding all app data from cloud backup and device transfer. | `AndroidManifest.xml`, `res/xml/data_extraction_rules.xml` |
| **M-01** | `openExternalPlayer` validates before the native call and the `window.open` fallback; only `magnet:` bypasses (a legitimate hand-off). | `services/androidBridge.ts` |
| **M-02** | `server.allowNavigation: ["localhost"]` added. | `capacitor.config.json` |
| **M-14** | Profile popover and mobile "More" sheet are now `role="dialog" aria-modal="true"` with `aria-label`, focus the first button on open, close on Escape, and restore trigger focus. | `components/Navigation.tsx` |
| **M-18** | `newCachedThreadPool()` → bounded `ThreadPoolExecutor` (2–6 threads, 64-slot queue, CallerRunsPolicy). | `MainActivity.java` |
| **M-20** | `file_paths.xml` narrowed to `external-files-path path="Download/"` only. | `res/xml/file_paths.xml` |
| **L-04** | Mobile `.details-episode-card` block now re-asserts `gap: 10px` after the base rule. | `index.css` |
| **C-01 (partial)** | Iframe sandbox reduced to `allow-scripts allow-forms allow-presentation` — removed `allow-same-origin` (sandbox escape) and `allow-popups` (intent redirection). | `components/PlayerModal.tsx` |

### Material 3 Expressive — landed

- `--md-sys-*` role layer (colour, shape, motion, elevation, 8dp spacing) added to `:root`, derived from the existing theme tokens so **all five accents keep working**.
- 48dp minimum touch target applied to `.nav-item`, `.button`, `.button-small`, filter/quality pills, `.icon-btn`, episode CTA.
- Expressive spring motion on primary surfaces; shell rail widened 218→240px; hero takes the 28px corner scale.
- Consistent 3px `:focus-visible` ring for D-pad/TV.
- Light theme added as **opt-in only** (`[data-theme='light']`), with per-accent contrast-corrected values.
- `prefers-reduced-motion` honoured globally.

### Still open (not closed by this pass)

| ID | Why |
|---|---|
| **C-01 (core)** | Native origin gating is not implemented. `addJavascriptInterface` still injects `PrahaNative` into every frame; a comment in `MainActivity.java` records the residual risk. The correct fix is `WebViewCompat.addWebMessageListener` + `removeJavascriptInterface` + a JS-side async bridge rewrite. **CRITICAL remains.** |
| **H-02** | Mixed content is still `ALWAYS_ALLOW` (deliberate — tightening breaks HTTP provider iframes). |
| **H-04** | `nativeFetchText` validates scheme/credentials but has no **host** allowlist; private/LAN hosts are still reachable by design (TorrServer). |
| **H-05** | TMDB key still reaches Worker scope. Removing it breaks third-party scrapers; needs a main-thread TMDB proxy + compatibility window. |
| **H-09** | `vite.config.ts` image relay still follows redirects (dev/preview only, not shipped in the APK). |
| **M-03/M-04** | `nuvioWorker` response content-type/status handling and `pendingProxy` timeout untouched. |
| **M-05/M-06/M-07** | `RESPONSE_CACHE` / `rawSubtitleCache` caps and `debridService` `ok` check untouched. |
| **M-08..M-13** | IPTV `nativeFetchText`, ternary precedence, M3U scheme validation, `encodeURIComponent`, HTTPS portal migration untouched. |
| **M-15/M-16** | `AnimeView` / `AnimeDiscussion` async races untouched. |
| **M-17** | Exported `stremio://` deep link unchanged (feature is inert). |
| **M-19** | VLC/PiP/audio-focus lifecycle untouched. |
| **L-02/L-03/L-05** | Remaining timers, `FlowView` aria-labels, defensive `JSON.parse` untouched. |
