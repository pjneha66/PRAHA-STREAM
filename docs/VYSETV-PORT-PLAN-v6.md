# VyseTV → PRAHA STREAM — Phase Plan v6 (FINAL, for approval)

Source: `https://gitlab.com/ayman707-ux/vysetv` @ depth 1
Plan date: 2026-11-20 · **Status: awaiting approval. No code changed.**

---

## What's new in v6

| # | Change |
|---|---|
| 1 | **NSFW toggle** — one switch in Settings, three modes, gates manga + anime + comic |
| 2 | **Order fixed:** implement everything → `LICENSE` → APK. Licence is not phase 0 any more. |
| 3 | Found: `services/mangaService.ts` **is already WeebCentral** with `adult=False` hardcoded — the Manga tab is a smaller job than planned |

---

## The NSFW finding

`services/mangaService.ts:57` and `:74` already hit WeebCentral:

```
...&adult=False&offset=...
```

It's hardcoded. Your Manga tab already exists — it just can never return adult titles.
Flipping that one param to `Any` is the entire manga side of the feature.

Verified live today:

| `adult=` | Result |
|---|---|
| `False` | **200** — 64 series, SFW |
| `Any` | **200** — includes adult |
| `false` | 307 → /400 (lowercase is rejected — this is why it looks broken) |

VyseTV does the same thing at `manga_service.dart:53`: `allowAdult ? 'Any' : 'False'`.

### The toggle design

One setting, three modes — matching VyseTV's `AdultFilter { hide, include, only }`:

| Mode | Meaning |
|---|---|
| **Off** (default) | `adult=False` — nothing adult anywhere |
| **On** | `adult=Any` — adult mixed into normal results |
| **Only** | `adult=Only` — adult results only |

### What it gates

| Surface | Gated by |
|---|---|
| Manga tab (WeebCentral) | `adult=False` ↔ `Any` ↔ `Only` |
| Comic tab (Sanka + Comick) | filter adult entries from results |
| Anime tab (AniList) | `isAdult` GraphQL param |
| TMDB catalog | `include_adult` (`tmdbService.ts:143`, `:159`) |
| Live TV (iptv-org) | the existing `isAdultChannel()` regex — currently always on |
| VyseTV adult anime sources | Hentaini / WatchHentai — only reachable when on |

### Three-layer safety

1. **Age gate** — first time it's turned on, a confirm dialog ("18 or older"), same as VyseTV's
   `_allowAdult()` at `anime_page.dart:898-930`
2. **Kids profiles** — the toggle is **forced off and hidden** for any profile with `isKids`
   (`DEFAULT_PROFILE` already has that flag)
3. **Per-profile** — the setting lives per profile, not globally, so an adult profile doesn't
   leak into a kids one

---

## Order of work (your instruction)

```
1. Implement every feature
2. Add LICENSE + NOTICE + headers
3. Build and ship the APK
```

The licence work moves from Phase 0 to **Phase 13** — right before the build. It changes
nothing functionally and unblocks nothing, so there's no reason to do it first.

---

## Locked decisions

| # | Decision |
|---|---|
| 1 | GPL-3.0 — added in Phase 13 |
| 2 | Keep Nuvio + Stremio + PlayTorrio — untouched |
| 3 | **Comic** tab (Sanka + Comick) + **Manga** tab (WeebCentral) — separate |
| 4 | **Flow** tab untouched |
| 5 | VyseTV sources first, embed last resort |
| 6 | Keep `EmbedModal` as final fallback |
| 7 | **arm64 APK + universal APK (A: both engines + TorrServer)** |
| 8 | Keep Sanka; add AniList |
| 9 | **Both players** — mpv + Media3 |
| 10 | TorrServer default on Android |
| 11 | WeebCentral — **confirmed working** |
| 12 | **NSFW toggle — 3 modes, per profile, age-gated** |
| 13 | Implement → licence → APK |

---

## Release shape

| APK | ABIs | Est. size |
|---|---|---|
| `praha-stream-v3.0.0-arm64.apk` | arm64-v8a | **~205 MB** |
| `praha-stream-v3.0.0-universal.apk` | arm64 + armv7 + x86_64 | **~340 MB** |

Both include mpv + Media3 + libass + TorrServer, with **LibVLC dropped** (redundant third engine;
removes ~50 MB, `PrahaVlcPlayer.java` 786 LOC, and the LibVLC path in `MpvPlayer.tsx`).

---

# PHASE 1 — Build plumbing + dual APK (3 days)

| # | Task |
|---|---|
| 1.1 | Kotlin plugin 2.x + `kotlinx-coroutines-android:1.11.0` |
| 1.2 | CMake 3.22.1 + NDK `28.2.13676358` |
| 1.3 | `minSdk` 24 → **25** |
| 1.4 | mpv AAR via Ivy — `edde746:mpv-android:d633bbc71269@aar`, sha256 `4bf8a972…9df7` |
| 1.5 | libdovi v2.3.1 (`downloadLibdovi`, per-ABI sha256) |
| 1.6 | media3 1.11.0 + cronet-embedded 143.7445.0 |
| 1.7 | `:libass` module — 21 Kotlin + 1,146 C; libass 0.18.3, sha256 `fc9863…1a17` |
| 1.8 | `dovi_bridge.cpp` + `media3_ffmpeg_decoder/` |
| 1.9 | `packaging { jniLibs { useLegacyPackaging = true } }` ← **required for TorrServer exec** |
| 1.10 | `pickFirsts libc++_shared.so` |
| 1.11 | ABI splits + `universalApk true` |
| 1.12 | Extend `copyApkToDist` → `-arm64.apk` / `-universal.apk` |
| 1.13 | Remove `libvlc-all` + `PrahaVlcPlayer.java` + LibVLC path |

**Acceptance:** `assembleDebug` succeeds, both APK names land in `dist-apk/`,
`aapt2 dump badging` shows `minSdk 25` and correct `native-code`.

---

# PHASE 2 — Foundations + NSFW settings (4 days)

| # | Port | LOC |
|---|---|---|
| 2.1 | 8-theme system + ambient glow | ~400 |
| 2.2 | Configurable navbar (stable ids, order, hidden) | ~150 |
| 2.3 | PlatformDetector (TV/phone/desktop + perf tier) | ~500 |
| 2.4 | `Setting<T>` listenable prefs | 235 |
| 2.5 | Lean motion | ~60 |
| 2.6 | Design tokens → CSS vars | — |
| **2.7** | **NSFW setting + settings UI** | **~120 new** |

### 2.7 detail

**Type** (`types.ts`, `AppSettings`):
```ts
/** Adult content: 'off' hides it, 'on' mixes it in, 'only' shows nothing else. */
nsfw: 'off' | 'on' | 'only';
```

**Setting** (`data/defaults.ts`): `nsfw: 'off'`

**Settings UI** (`components/SettingsView.tsx`), new card under Profiles:

```
┌ Adult content ────────────────────────────────────────┐
│ Show adult manga, anime, comics and titles.           │
│                                                        │
│   [ Off ]   [ On ]   [ Only adult ]        ← segments  │
│                                                        │
│ Turning this on asks you to confirm you're 18 or      │
│ older. It stays off for Kids profiles.                │
└────────────────────────────────────────────────────────┘
```

**Gate** (`services/nsfwGate.ts`):
```ts
export type NsfwMode = 'off' | 'on' | 'only';

// true when adult results may be requested
export function allowsAdult(settings: AppSettings, profile: UserProfile): boolean {
  if (profile.isKids) return false;      // kids profile: always off
  return settings.nsfw !== 'off';
}

// the value WeebCentral wants
export function adultParam(mode: NsfwMode): 'False' | 'Any' | 'Only' {
  return mode === 'off' ? 'False' : mode === 'only' ? 'Only' : 'Any';
}
```

**Age confirmation** — first switch to `on`/`only` opens a dialog:
*"Adult content (18+). This shows hentai and other titles marked adult, including explicit cover
art. Only turn it on if you're 18 or older."* → `[Cancel] [I'm 18 or older]`

**Kids profile** — the card renders disabled with *"Not available on a Kids profile."*

**Acceptance:**
- [ ] Toggle persists across restart, per profile
- [ ] Kids profile: toggle disabled, forced `off`
- [ ] Age dialog shows once, not on every change
- [ ] Theme switch + navbar reorder still work
- [ ] `tsc --noEmit` clean, 143 tests pass

---

# PHASE 3 — mpv engine (10 days)

Prerequisite: Phase 1. **The SurfaceView spike moves to the first 2 days of this phase.**

| # | Task | LOC |
|---|---|---|
| 3.0 | **SurfaceView-behind-WebView spike** → record A / B / C | — |
| 3.1 | Copy `MpvPlayerCore.kt` + 11 policy files unchanged | 5,273 |
| 3.2 | Copy `shared/` (13 files) unchanged | 1,343 |
| 3.3 | Rewrite `MpvPlayerPlugin.kt` → `CapacitorMpvPlugin.kt` | ~700 |
| 3.4 | Port `player_base.dart` | 1,775 |
| 3.5 | Port `player_native.dart` | 1,407 |
| 3.6 | Port `platform/player_android_mpv.dart` | ~600 |
| 3.7 | Port `models.dart` + freezed | 2,800 |
| 3.8 | Port `mpv/extras/*` | ~800 |
| 3.9 | Port `mpv/support/*` | ~600 |
| 3.10 | Surface rect sync (WebView rect → native layout params) | ~200 |

**Verified: zero Flutter in the cores** — only 5 of 68 Kotlin files import `io.flutter`, all wrappers.

**Gate:** if the spike returns **C**, skip Phases 3–4 and keep LibVLC (~20 days saved, HDR lost).

---

# PHASE 4 — Media3 / ExoPlayer engine (10 days)

| # | Task | LOC |
|---|---|---|
| 4.1 | Copy `ExoPlayerCore.kt` + 33 siblings | 12,878 |
| 4.2 | Copy `:libass` module | 3,500 |
| 4.3 | Rewrite `ExoPlayerPlugin.kt` → `CapacitorExoPlugin.kt` | ~900 |
| 4.4 | Port Dart Media3 layer | ~800 |
| 4.5 | Engine selector — Media3 default on TV, mpv opt-in | small |

---

# PHASE 5 — TorrServer, default on Android (5 days)

| # | Task |
|---|---|
| 5.1 | Ship `torrserver-android-arm64` (64,423,136 B) + armv7 for universal |
| 5.2 | Copy `TorrServerForegroundService.kt` |
| 5.3 | Rewrite 3-method plugin (`startForegroundService`, `stopForegroundService`, `getNativeLibraryDir`) |
| 5.4 | Port REST client (10 endpoints) → `services/p2p/torrServerClient.ts` |
| 5.5 | Port `torrents.dart` **with tuned settings** |
| 5.6 | Port `torrent_file_pick.dart` + `torrent_file_ask.dart` |
| 5.7 | Port `p2p_consent.dart` (once-only dialog) |
| 5.8 | **Default on Android**; WebTorrent only for web/PWA |

### The tuned settings — verbatim

```
CacheSize                 256 MB phone / 1024 MB desktop
ReaderReadAHead           95 %
PreloadCache              2 %
ConnectionsLimit          150 phone / 300 desktop
EnableIPv6                FALSE     ← the measured win
RetrackersMode            1
ResponsiveMode            true
ForceEncrypt              false
EnableLPD                 true
DisableUPNP               false
DisableDHT                false
DisablePEX                false
DisableUpload             false
TorrentDisconnectTimeout  120 s
EnableDLNA / EnableBonjour  false
UseDisk                   false
RemoveCacheOnDrop         true
```

VyseTV's measured note: *"IPv6 on → 1.3–2.4 MB/s, nothing for 10–16 s, then a stall.
Off → 4.1–4.8 MB/s, data within ~8 s every time."*

---

# PHASE 6 — Live TV complete (10 days)

12,164 LOC / 19 files. Replaces `iptvService.ts` (1,888), `m3uWorker.ts`, `liveTvPrefs.ts`,
`LiveTvView.tsx`, `live-tv.css`. **Keep our virtualised channel list.**

Ten behaviours: portal browser w/ preview · match finder · ESPN schedule · per-portal favourites ·
EPG now/next · multi-playlist `{added,skipped,failed}` · 84 hardcoded channels + scanner ·
paste-site discovery + PasteSh AES-CBC · appearance settings · Xtream/M3U group trees.

**NSFW note:** `iptvService.ts:1674-1677` already has `isAdultChannel()` — Phase 2 wires it to
the toggle instead of hardcoding.

---

# PHASE 7 — Sources + priority orchestrator (10 days)

| # | Port | LOC |
|---|---|---|
| 7.1 | 39 scrapers | 3,091 |
| 7.2 | `film_sources.dart` (Movy, 17 servers) + `common.dart` | ~700 |
| 7.3 | `source_settings.dart` → merge `sourcePreferences.ts` | ~150 |
| 7.4 | Debrid: RD / AD / Premiumize / Debrid-Link / TorBox | ~1,300 |
| 7.5 | `debrid_media_matcher` + `parse_torrent_title` | 653 |
| 7.6 | `knaben.dart` | 229 |
| 7.7 | `badges.dart` → merge `badgeRules.ts` | ~300 |
| 7.8 | `addons.dart` → merge `stremioService.ts` | 808 |
| 7.9 | **`SourceOrchestrator`** | ~400 |

### The chain

```
1. 39 VyseTV scrapers + Movy       ← FIRST
2. VyseTV debrid                   ← then
3. TorrServer (P2P)                ← then
4. Nuvio + Stremio addons (ours)   ← then
5. EmbedModal iframe               ← LAST RESORT
6. "No source found" + retry
```

`EmbedModal.tsx` untouched — only its call site moves.

---

# PHASE 8 — Comic / Manga / Anime + NSFW wiring (5 days)

| Tab | Source | Code |
|---|---|---|
| **Comic** | Sanka (bacakomik, komikindo, shinigami, kiryuu) + Comick | **ours, untouched** |
| **Manga** | **WeebCentral** — already in `mangaService.ts` | ours, upgraded |
| **Anime** | Sanka anime + **AniList** (new) | ours + 816 |

### 8.1 — Manga: the small job

`services/mangaService.ts` already scrapes WeebCentral correctly. Two lines change:

```ts
// line 57 and 74, before
...&adult=False&offset=${offset}
// after
...&adult=${adultParam(settings.nsfw)}&offset=${offset}
```

That's it for adult content. Then the reader upgrade:

| # | Port | LOC |
|---|---|---|
| 8.2 | `manga_reader_page.dart` — **webtoon vs paged, glass control bar, next-chapter deck, remembered page** | 975 |
| 8.3 | `manga_details_page.dart` + `manga_page.dart` + `manga_widgets.dart` | 825 |
| 8.4 | `manga_library.dart` (saved series, per-chapter progress) | 229 |
| 8.5 | `anilist.dart` — GraphQL, fills `anilistId`/`mal`/`kitsu` | 816 |
| 8.6 | Wire `AdultFilter` into the Anime tab (`isAdult` param) | small |

### Verified request recipe

```
GET https://weebcentral.com/search/data
    ?display_mode=Full+Display
    &adult=False | Any | Only        ← CAPITAL first letter
    &sort=Popularity&order=Descending&official=Any
    &offset={n}
Headers:
    User-Agent: <desktop Chrome 130 UA>
    HX-Request: true                 ← htmx marker, required
    Referer: https://weebcentral.com/search
```

Chapter images: `GET /chapters/{id}/images?is_prev=False` (**capital F**), follow redirects.
Image CDN `scans.lastation.us` hotlinks without a Referer.

**Live-verified:** search 200 (64/page) · paging 200 · series 200 · chapter-list 200 ·
chapter 200 · images 200 (43 imgs) · covers 200 · image CDN 200.

### Acceptance
- [ ] Comic tab: unchanged, 4 Sanka sources + Comick
- [ ] Manga tab: search → series → chapters → reader
- [ ] **NSFW off → zero adult results; on → mixed; only → adult only**
- [ ] Kids profile → adult impossible even if the flag is set
- [ ] Reader: webtoon + paged both correct
- [ ] Anime: AniList ids populate, `isAdult` respects the toggle
- [ ] **Flow tab: no diff**

---

# PHASE 9 — Audiobooks, 8 sites (4 days)

| # | Port | LOC |
|---|---|---|
| 9.1 | `audiobook_scraper_service.dart` | 420 |
| 9.2 | `audiobook_player.dart` (bookmarks, waveform, background) | 363 |
| 9.3 | `audiobook_model.dart` | ~80 |
| 9.4 | 3 screens | 901 |
| 9.5 | `audiobook_widgets.dart` | 294 |

**Live-checked:** goldenaudiobooks 200 · hotaudiobooks 200 · audioaz 200 ·
audiobooks4soul 403 (route through `nativeFetchText`).

---

# PHASE 10 — Music source + layout (8 days)

| # | Port | LOC |
|---|---|---|
| 10.1 | `yt_music.dart` — InnerTube browse (verified 200 for `WEB_REMIX`) | 864 |
| 10.2 | `youtube_audio_extractor.dart` | 997 |
| 10.3 | `youtube_rate_limit_guard.dart` | 123 |
| 10.4 | `deezer_api_client.dart` | 296 |
| 10.5 | `lyrics_service.dart` | 179 |
| 10.6 | `music_player.dart` + `music_library.dart` + `music_track.dart` | 1,436 |
| 10.7 | **Layout** | 4,992 |

### The layout

| File | LOC | Gives |
|---|---|---|
| `music_shell.dart` | 977 | sidebar + segments + search pill + **persistent bottom bar** + **queue drawer** |
| `music_pages.dart` | 1,152 | Artist · Album · Playlist · My Playlist · Liked · Library · Browse · Mood · History |
| `music_page.dart` | 888 | home |
| `music_ui.dart` | 830 | shared widgets |
| `music_player_page.dart` | 669 | full-screen now-playing |
| `music_detail_pages.dart` | 476 | |
| `music_widgets.dart` | 661 | |

Replaces `components/music/` (3 files) + `components/MusicView.tsx`.

---

# PHASE 11 — D-pad focus engine (7 days)

| # | Port | LOC |
|---|---|---|
| 11.1 | traversal + focus memory + covered-route boundary | ~1,200 |
| 11.2 | seek keys | ~200 |
| 11.3 | transport keys | ~150 |
| 11.4 | TV text input | ~300 |
| 11.5 | long-press + key repeat | ~350 |
| 11.6 | input mode tracker + focus chrome | ~500 |
| 11.7 | **walk test bed** | ~2,100 |

---

# PHASE 12 — Verify (3 days)

- `tsc --noEmit` clean
- `vitest run` — 143 existing + new
- `vite build` clean
- Smoke every tab on device
- Update `memory.md`, `docs/PORT-BACKLOG.md`

---

# PHASE 13 — Licence (1 day)

Your order: implementation first, licence here.

| # | Task |
|---|---|
| 13.1 | `LICENSE` — GPL-3.0 verbatim (35,149 B) |
| 13.2 | `NOTICE` — VyseTV, Plezy (edde746), TorrServer (YouROK), PlayTorrio, Vyla SDK, mpv/FFmpeg/libass, Anime4K/ArtCNN/NVScaler, TMDB, AniList, TheIntroDB |
| 13.3 | Audit `lib/dpad/*` headers (only *some* are from Plezy) |
| 13.4 | Preserve every original copyright header + VyseTV's `// VyseTV` markers on copied files |
| 13.5 | `package.json` → `"license": "GPL-3.0-only"` |
| 13.6 | README licence section + source-offer statement |

---

# PHASE 14 — Build & ship the APK (3 days)

| # | Task |
|---|---|
| 14.1 | `assembleRelease` → arm64 + universal |
| 14.2 | `unzip -t` + `aapt2 dump badging` on both |
| 14.3 | Sign with the existing keystore (`praha-release`, sha256 `AA:E6:13:…:C3:01`) so upgrades work in place |
| 14.4 | Copy both to `dist-apk/` |
| 14.5 | Install + full smoke test |

---

## Total

| Phase | Days | Deliverable |
|---|---|---|
| 1 Build plumbing | 3 | dual APK boilerplate |
| 2 Foundations + **NSFW** | 4 | themes, navbar, prefs, toggle |
| 3 mpv | 10 | engine 1 (+ spike in first 2 days) |
| 4 Media3 | 10 | engine 2 |
| 5 TorrServer | 5 | P2P default |
| 6 Live TV | 10 | full replacement |
| 7 Sources | 10 | 39 scrapers + orchestrator |
| 8 Comic/Manga/Anime | 5 | WeebCentral + NSFW wiring |
| 9 Audiobooks | 4 | 8 sites |
| 10 Music | 8 | source + layout |
| 11 D-pad | 7 | TV control |
| 12 Verify | 3 | green checks |
| 13 Licence | 1 | GPL-3.0 |
| 14 Build APK | 3 | both APKs |
| **Total** | **~83 days** | **≈ 4 months of sessions** |

Phases 3–11 are independent once 1 and 2 land. Reorder freely.

---

## Checkpoints — each ships an installable APK

| After | You see | Decide |
|---|---|---|
| 1 | two empty APKs, correct ABIs | size OK? |
| 2 | new themes + navbar + **NSFW toggle** | toggle right? |
| 3 | mpv playing 4K HDR | keep mpv? |
| 4 | engine switch | keep both? |
| 5 | torrent <10 s | TorrServer default OK? |
| 6 | new Live TV | replace old? |
| 7 | scraper list + embed demoted | order correct? |
| 8 | Comic + Manga + **adult results** | NSFW behaviour right? |
| 9 | audiobooks | sources good? |
| 10 | new music layout | right look? |
| 11 | remote everywhere | ship? |
| 13–14 | **final APKs** | — |

---

## Two things to confirm

1. **NSFW three modes** (`Off` / `On` / `Only adult`) — or just a simple on/off? Three modes is
   what VyseTV does and costs nothing extra.
2. **Drop LibVLC** — I've planned it dropped (arm64 ~205 MB, universal ~340 MB). Say if you
   want it kept (~217 / ~390 MB).

**Say go and I start Phase 1.**
