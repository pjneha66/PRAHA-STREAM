package com.lagradost.cloudstream3.ui.home

import com.lagradost.cloudstream3.utils.DataStoreHelper

/**
 * The official app's home view model, as far as extensions use it (Ultima, WatchParty):
 * Continue Watching. PRAHA's watch history lives in the web layer, so this returns what
 * the extension records say — the same `result_resume_watching_2` entries an extension
 * wrote through [DataStoreHelper.setLastWatched] — rather than a second, empty library.
 */
class HomeViewModel {
    companion object {
        suspend fun getResumeWatching(): List<DataStoreHelper.ResumeWatchingResult>? =
            DataStoreHelper.getAllResumeStateIds().orEmpty().mapNotNull { id ->
                val resume = DataStoreHelper.getLastWatched(id) ?: return@mapNotNull null
                val bookmarked = DataStoreHelper.getBookmarkedData(id) ?: return@mapNotNull null
                val pos = DataStoreHelper.getViewPos(id)
                DataStoreHelper.ResumeWatchingResult(
                    name = bookmarked.name,
                    url = bookmarked.url,
                    apiName = bookmarked.apiName,
                    posterUrl = bookmarked.posterUrl,
                    watchPos = pos,
                    id = id,
                    parentId = resume.parentId,
                    episode = resume.episode,
                    season = resume.season,
                    isFromDownload = resume.isFromDownload,
                )
            }
    }
}
