package com.praha.stream.cloudstream

import com.lagradost.cloudstream3.APIHolder
import com.lagradost.cloudstream3.AnimeLoadResponse
import com.lagradost.cloudstream3.HomePageList
import com.lagradost.cloudstream3.HomePageResponse
import com.lagradost.cloudstream3.LiveStreamLoadResponse
import com.lagradost.cloudstream3.LoadResponse
import com.lagradost.cloudstream3.MainAPI
import com.lagradost.cloudstream3.MainPageData
import com.lagradost.cloudstream3.MainPageRequest
import com.lagradost.cloudstream3.MovieLoadResponse
import com.lagradost.cloudstream3.SearchResponse
import com.lagradost.cloudstream3.SubtitleFile
import com.lagradost.cloudstream3.TorrentLoadResponse
import com.lagradost.cloudstream3.TvSeriesLoadResponse
import com.lagradost.cloudstream3.utils.ExtractorLink
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Something the user can press play on: a movie, or one episode of a series. */
data class CsPlayable(
    val label: String,
    val data: String,
    val season: Int? = null,
    val episode: Int? = null,
    val name: String? = null,
    val posterUrl: String? = null,
    val description: String? = null,
    val dub: String? = null,
)

data class CsLinks(val links: List<ExtractorLink>, val subtitles: List<SubtitleFile>)

sealed interface CsLinkEvent {
    data class Link(val link: ExtractorLink) : CsLinkEvent
    data class Subtitle(val subtitle: SubtitleFile) : CsLinkEvent
    data class Done(val error: Throwable?, val timedOut: Boolean) : CsLinkEvent
}

data class CsSearchBatch(val api: MainAPI, val results: List<SearchResponse>, val error: Throwable?)

/**
 * The provider call sequence the UI drives: getMainPage / search -> load -> loadLinks.
 * Everything streams: results reach the UI as each provider, section or extractor
 * finishes, and slow ones never block fast ones.
 *
 * Port of stream-goat's `Engine`, minus the parts that belong to that app (Stremio
 * add-ons as providers, downloads, site overrides, per-profile filtering).
 */
object CsEngine {
    private val threads = AtomicInteger()

    /**
     * Extension code runs on its own pool so a misbehaving extension cannot starve the UI
     * or IO. Its threads run a little below normal priority, so the screen stays smooth
     * while extensions parse pages.
     */
    val dispatcher = Executors.newFixedThreadPool(64) { r ->
        Thread({ runCatching { android.os.Process.setThreadPriority(EXTENSION_PRIORITY) }; r.run() },
            "cs-extension-${threads.incrementAndGet()}").apply { isDaemon = true }
    }.asCoroutineDispatcher()

    /** Slightly below normal (0); 10 would be "background". */
    const val EXTENSION_PRIORITY = 3

    private const val DEFAULT_TIMEOUT = 45_000L

    /** Every loaded extension, sorted by name (they load in parallel, so order isn't stable). */
    fun allProviders(): List<MainAPI> = loadedExtensions().sortedBy { it.name.lowercase() }

    /** Extensions the user may use: adult ones only when adult content is allowed. */
    fun providers(): List<MainAPI> = allProviders().filter { api ->
        CsSettings.allowAdult || api.supportedTypes.none { it.name == "NSFW" }
    }

    /**
     * A copy of the loaded extensions. Extensions register themselves from their own threads
     * while others read the list, so copy it all at once and never throw.
     */
    fun loadedExtensions(): List<MainAPI> {
        val list = APIHolder.allProviders
        repeat(3) {
            runCatching { return list.withLock { ArrayList(list) } }
            Thread.yield()
        }
        val out = ArrayList<MainAPI>(list.size + 8)
        var i = 0
        while (true) {
            val item = runCatching { list.getOrNull(i) }.getOrNull()
                ?: if (i >= runCatching { list.size }.getOrDefault(0)) break else null
            if (item != null) out += item
            i++
        }
        return out.distinct()
    }

    fun provider(name: String): MainAPI? = providers().firstOrNull { it.name.equals(name, ignoreCase = true) }

    private fun log(api: MainAPI, what: String, t: Throwable) {
        if (t !is CancellationException) android.util.Log.w(api.name, "$what failed: $t")
    }

    /** One loaded home row. [order] sorts rows: provider position, then the user's catalog order. */
    data class HomeSection(val order: Int, val api: MainAPI, val section: MainPageData, val list: HomePageList)

    /**
     * Home rows for [apis] (one, or several for the combined feed), using each extension's
     * enabled catalogs in the user's order. Rows arrive as soon as each catalog loads.
     */
    fun home(apis: List<MainAPI>): Flow<HomeSection> = channelFlow {
        apis.forEachIndexed { p, api ->
            CsCatalogs.enabled(api).forEachIndexed { position, entry ->
                launch(dispatcher) {
                    val response = homePage(api, entry.section, 1)
                    response?.items?.forEachIndexed { i, list ->
                        if (list.list.isNotEmpty()) send(HomeSection(p * 1_000_000 + position * 100 + i, api, entry.section, list))
                    }
                }
            }
        }
    }

    suspend fun homePage(api: MainAPI, section: MainPageData, page: Int): HomePageResponse? = withContext(dispatcher) {
        try {
            withTimeoutOrNull(api.getMainPageTimeoutMs ?: DEFAULT_TIMEOUT) {
                api.getMainPage(page, MainPageRequest(section.name, section.data, section.horizontalImages))
            }
        } catch (t: Throwable) {
            log(api, "home '${section.name}'", t)
            null
        }
    }

    /** One batch per provider, in completion order. */
    fun search(query: String, apis: List<MainAPI> = providers()): Flow<CsSearchBatch> = channelFlow {
        apis.forEach { api ->
            launch(dispatcher) {
                val batch = try {
                    val results = withTimeout(api.searchTimeoutMs ?: DEFAULT_TIMEOUT) { api.search(query, 1)?.items.orEmpty() }
                    CsSearchBatch(api, results, null)
                } catch (t: Throwable) {
                    log(api, "search", t)
                    CsSearchBatch(api, emptyList(), t)
                }
                send(batch)
            }
        }
    }

    suspend fun load(api: MainAPI, url: String): LoadResponse? = withContext(dispatcher) {
        withTimeout(api.loadTimeoutMs ?: DEFAULT_TIMEOUT) { api.load(url) }
    }

    fun playables(response: LoadResponse): List<CsPlayable> = when (response) {
        is MovieLoadResponse -> listOf(CsPlayable(response.name, response.dataUrl))
        is LiveStreamLoadResponse -> listOf(CsPlayable(response.name, response.dataUrl))
        is TorrentLoadResponse -> listOfNotNull(response.magnet ?: response.torrent).map { CsPlayable(response.name, it) }
        is TvSeriesLoadResponse -> response.episodes.map { it.toPlayable(null) }
        is AnimeLoadResponse -> response.episodes.flatMap { (dub, eps) -> eps.map { it.toPlayable(dub.name) } }
        else -> emptyList()
    }

    private fun com.lagradost.cloudstream3.Episode.toPlayable(dub: String?): CsPlayable {
        val code = listOfNotNull(season?.let { "S$it" }, episode?.let { "E$it" }).joinToString("")
        val label = listOf(code, name ?: "").filter { it.isNotBlank() }.joinToString(" · ").ifBlank { "Episode" }
        return CsPlayable(label, data, season, episode, name, posterUrl, description, dub)
    }

    /**
     * One search for an episode's sources, shared by everyone who asks for them: the player
     * and the search started when the title's page opened ([prefetch]) read the same results.
     * A complete search is kept for [CACHE_MS] (like the official app's 20-minute link
     * cache), so playing the same episode again starts at once.
     */
    private class Session(val started: Long) {
        val events: MutableList<CsLinkEvent> = java.util.Collections.synchronizedList(mutableListOf())
        val updates = MutableStateFlow(0)

        @Volatile
        var done = false

        /** Finished without an error or a timeout, with sources: worth keeping. */
        @Volatile
        var complete = false

        var job: Job? = null
    }

    private const val CACHE_MS = 20 * 60_000L
    private val sessions = java.util.concurrent.ConcurrentHashMap<String, Session>()
    private val sessionScope = CoroutineScope(SupervisorJob() + dispatcher)

    private fun key(api: MainAPI, data: String) = api.name + "\u0000" + data

    private fun session(api: MainAPI, data: String): Session = synchronized(sessions) {
        val now = System.currentTimeMillis()
        sessions.entries.removeIf { (_, s) -> s.done && now - s.started > CACHE_MS }
        sessions[key(api, data)]?.let { s -> if (!s.done || s.complete) return s }
        val s = Session(now)
        sessions[key(api, data)] = s
        fun add(e: CsLinkEvent) {
            s.events += e
            s.updates.update { it + 1 }
        }
        s.job = sessionScope.launch {
            var error: Throwable? = null
            var found = 0
            val timeout = api.loadLinksTimeoutMs ?: (CsSettings.sourcesTimeoutSeconds * 1000L)
            val finished = try {
                withTimeoutOrNull(timeout) {
                    api.loadLinks(data, false, { add(CsLinkEvent.Subtitle(it)) }, { found++; add(CsLinkEvent.Link(it)) })
                    true
                }
            } catch (t: Throwable) {
                if (t is CancellationException) throw t
                log(api, "loadLinks", t)
                error = t
                true
            }
            s.complete = error == null && finished != null && found > 0
            s.done = true
            add(CsLinkEvent.Done(error, timedOut = finished == null))
        }
        s
    }

    /** Starts finding an episode's sources in the background (when its title page opens). */
    fun prefetch(api: MainAPI, data: String) {
        if (CsSettings.prepareSources) session(api, data)
    }

    /** Whether an episode's sources are already known (cached or being found), so playing it starts sooner. */
    fun cached(api: MainAPI, data: String): Boolean = sessions[key(api, data)]?.complete == true

    /** Forgets an episode's cached sources (they all failed: probably expired), so the next search asks again. */
    fun forget(api: MainAPI, data: String) {
        synchronized(sessions) { sessions.remove(key(api, data)) }
    }

    fun links(api: MainAPI, data: String): Flow<CsLinkEvent> = channelFlow {
        val s = session(api, data)
        var i = 0
        s.updates.first {
            while (true) {
                val e = synchronized(s.events) { s.events.getOrNull(i) } ?: break
                i++
                send(e)
                if (e is CsLinkEvent.Done) return@first true
            }
            false
        }
    }

    /** Collects everything at once. */
    suspend fun allLinks(api: MainAPI, data: String): CsLinks {
        val links = mutableListOf<ExtractorLink>()
        val subtitles = mutableListOf<SubtitleFile>()
        links(api, data).collect {
            when (it) {
                is CsLinkEvent.Link -> links += it.link
                is CsLinkEvent.Subtitle -> subtitles += it.subtitle
                is CsLinkEvent.Done -> Unit
            }
        }
        return CsLinks(rank(links.distinctBy { it.url }), subtitles.distinctBy { it.url })
    }

    /** "hi" -> "Hindi", "ja" -> "Japanese"; a name stays a name. */
    fun languageName(code: String): String =
        if (code.length in 2..3) java.util.Locale(code).getDisplayLanguage(java.util.Locale.ENGLISH).ifBlank { code }
        else code.replaceFirstChar { it.uppercase() }

    /** Best first: sources in the preferred audio language, then closest to the preferred quality. */
    fun rank(links: List<ExtractorLink>): List<ExtractorLink> {
        val preferred = CsSettings.preferredQuality.takeIf { it > 0 } ?: Int.MAX_VALUE
        val wanted = CsSettings.audioLanguage.split(',').map { it.trim() }.filter { it.isNotBlank() }.map { languageName(it) }
        fun speaks(l: ExtractorLink) = wanted.isEmpty() || wanted.any { it.isNotBlank() && (l.name + " " + l.source).contains(it, true) }
        return links.sortedWith(
            compareBy<ExtractorLink> { if (speaks(it)) 0 else 1 }
                .thenBy { if (it.quality <= preferred) 0 else 1 }
                .thenByDescending { if (it.quality <= preferred) it.quality else -it.quality }
        )
    }
}
