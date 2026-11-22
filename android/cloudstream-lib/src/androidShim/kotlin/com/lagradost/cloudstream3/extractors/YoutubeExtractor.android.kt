package com.lagradost.cloudstream3.extractors

import com.lagradost.api.Log
import com.lagradost.cloudstream3.SubtitleFile
import com.lagradost.cloudstream3.utils.ExtractorApi
import com.lagradost.cloudstream3.utils.ExtractorLink
import com.lagradost.cloudstream3.utils.ExtractorLinkType
import com.lagradost.cloudstream3.utils.newExtractorLink

/**
 * Upstream resolves YouTube with NewPipeExtractor (jitpack-only). The page URL is
 * handed to the player instead, which resolves YouTube itself; extensions that
 * embed YouTube therefore still get a playable link.
 */
actual open class YoutubeExtractor actual constructor() : ExtractorApi() {
    actual override val mainUrl = "https://www.youtube.com"
    actual override val name = "YouTube"
    actual override val requiresReferer = false

    actual override suspend fun getUrl(
        url: String,
        referer: String?,
        subtitleCallback: (SubtitleFile) -> Unit,
        callback: (ExtractorLink) -> Unit
    ) {
        Log.i(name, "Passing $url through to the player")
        callback(newExtractorLink(name, name, url, ExtractorLinkType.VIDEO))
    }
}
