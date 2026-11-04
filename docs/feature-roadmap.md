# PRAHA STREAM feature roadmap

This roadmap tracks the feature ideas requested for PRAHA STREAM. It separates existing functionality from new work so existing features are not duplicated. Status reflects the current repository and should be rechecked as implementation proceeds.

## Phase 0 — Already present (polish or extend, do not rebuild)

- [x] Playback speed control exists in the built-in player; speed is persisted in player settings.
- [x] Seek interval is configurable (`PlayerSettings.seekStep`).
- [x] Auto-next episode can be enabled/disabled in player settings; the player already has an Up Next prompt.
- [x] Casting uses the browser's Remote Playback API where supported; there is no dedicated device picker yet.
- [x] Library status categories exist: Watching, Plan to Watch, On Hold, Completed, and Dropped.
- [x] Household profiles and a kids-profile flag exist; parental restrictions/PIN protection are not implemented.
- [x] Home rows can be hidden/reordered per profile.
- [x] Full JSON backup/restore exists; selective profile export and cloud sync do not.
- [x] Jellyfin library browsing exists; in-app playback and automatic progress sync do not.
- [x] Watch progress, resume, intro skip, episode guides, subtitles, source preferences, and source search diagnostics/recovery are present in some form.
- [x] First-launch “Who’s watching?” profile selection, remembered for later launches.
- [x] My Library title search and sorting by added date, title, year, and rating.
- [x] Anime & Comics metadata browse/search tab backed by Sanka API (no playback/reading links).

## Phase 1 — Local, device-only features

These can be built without a new server or third-party account.

- [ ] **Library filters:** filter saved titles by genre, year, rating, and type. Title search and sorting by added date/title/year/rating are implemented.
- [ ] **Collections:** create, rename, reorder, and delete custom lists.
- [ ] **Personal title data:** local ratings, notes, and custom tags.
- [ ] **Bulk library actions:** multi-select titles and change status, tag, or remove them.
- [ ] **Spoiler-free mode:** hide plot summaries and episode artwork/text until the user chooses to reveal them.
- [ ] **Surprise me:** choose a random title from the user's selected library/filters.
- [ ] **Search history:** review and clear recent searches.
- [ ] **Hide watched titles:** optional filtering for completed items in browse rows.
- [ ] **Per-profile subtitle and metadata language preferences.**
- [ ] **Subtitle appearance presets** and saved playback presets.
- [ ] **Screen-fit controls:** fit, fill, and original aspect ratio.
- [ ] **Profile PIN/app lock** and meaningful kids-profile restrictions.
- [ ] **Local activity log** with clear-history controls.
- [ ] **Storage manager** for cached catalogs, artwork, and temporary data.
- [ ] **Privacy dashboard** and per-service disable switches.
- [ ] **Single-profile backup export/import** and backup-version compatibility checks.
- [ ] **Home-screen layout controls:** themes, density, and poster sizes.
- [ ] **Accessibility improvements:** scalable controls, contrast, focus visibility, and screen-reader labels.
- [ ] **Franchise/watch-order pages** and browse-by-person pages, using available metadata.

## Phase 2 — Playback and source improvements

- [ ] Preserve the playback position when switching sources for the same title/episode.
- [ ] Manual chapter/bookmark markers.
- [ ] Audio-track selection when supported by the stream and playback engine.
- [ ] Subtitle search improvements, including language and hearing-accessibility labels when provider metadata supplies them.
- [ ] Audio-only/background playback where platform policies and source formats permit it.
- [ ] Quality selection where a provider/manifest exposes selectable variants.
- [ ] Source favorites/labels and recent success history; clearly label health as historical, not a guarantee.
- [ ] Per-source timeout/retry preferences and expanded provider diagnostics.
- [ ] Connection test screen for configured metadata, addon, debrid, and Jellyfin services.
- [ ] Improve the casting UI around the existing Remote Playback support; device discovery varies by browser/platform.

## Phase 3 — External services and platform work

These need API/provider support, Android-native work, or additional infrastructure and cannot be delivered as UI-only features.

- [ ] Episode release calendar and notifications; depends on reliable airing metadata and notification permissions.
- [ ] Personalized recommendations; start on-device, with transparent controls and an opt-out.
- [ ] Where-to-watch results view using installed sources and current search results.
- [ ] Import watchlists/history from services, subject to their APIs and authorization.
- [ ] Household shared lists while preserving separate profile histories.
- [ ] Home-screen widgets (Android-native implementation required).
- [ ] Jellyfin in-app playback and progress synchronization.
- [ ] Opt-in cloud sync, requiring a sync service, authentication, encryption, conflict resolution, and account recovery design.
- [ ] Watch parties, requiring a coordination service and a supported playback-source model. Third-party embeds may not expose controllable playback.

## Suggested delivery order

1. Phase 1 library controls, collections, tags/notes, bulk actions, and spoiler-free mode.
2. Phase 2 playback/source improvements that can be validated against supported formats.
3. Privacy, accessibility, profile safety, and backup improvements.
4. Phase 3 integrations, with separate design and platform/API validation for each.

Do not claim a feature works universally when it depends on provider metadata, browser support, Android APIs, or external services. Preserve the current local-first behavior and existing player/source fallbacks as each phase is added.
