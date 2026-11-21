// Phase 6 Live TV helpers — side-effect-free modules awaiting UI wiring.
//
// Integration map for a later phase (this barrel deliberately changes nothing
// outside services/liveTv/):
//   • components/LiveTvView.tsx — KEEP its virtualised channel list and its NSFW
//     gating. Call buildXtreamGroupTree / buildM3uGroupTree for group chips,
//     nowNext / epgProgress / guideTime for channel EPG rows, buildPreviewUrl +
//     buildEpgPreviewUrl for portal previews, favoriteKey / toggleFavoriteKey for
//     stars, importPlaylists for multi-playlist adds, mergeMatchSources for the
//     matches tab, and loadLiveTvAppearance for card styling.
//   • components/SettingsView.tsx (owned by another agent) — call
//     updateLiveTvAppearance / resetLiveTvAppearance / toggleVisibleCategory for
//     a Live TV appearance card.
//   • services/iptvService.ts — leave PasteShDecryptor, the 84 hardcoded
//     channels, its scrapers and isAdultChannel() exactly as they are; the
//     paste helpers here only normalise URLs before delegating to it.
//   • VyseTV's scroll-aware GuideLoader and MatchFinder EPG pump are not
//     reimplemented: their pure logic (nowNext, groupHits, bestEpgMatch) is
//     here; the request scheduling belongs to a later UI phase.

export * from './appearance';
export * from './epg';
export * from './groupTree';
export * from './matchFinder';
export * from './multiPlaylist';
export * from './portalBrowser';
