package com.praha.stream.cloudstream

import android.net.Uri
import com.lagradost.cloudstream3.AnimeLoadResponse
import com.lagradost.cloudstream3.HomePageList
import com.lagradost.cloudstream3.LoadResponse
import com.lagradost.cloudstream3.MainAPI
import com.lagradost.cloudstream3.MovieLoadResponse
import com.lagradost.cloudstream3.SearchResponse
import com.lagradost.cloudstream3.SubtitleFile
import com.lagradost.cloudstream3.TorrentLoadResponse
import com.lagradost.cloudstream3.TvSeriesLoadResponse
import com.lagradost.cloudstream3.utils.ExtractorLink
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The JSON surface the web UI drives over the origin-gated bridge.
 *
 * Every method is a plain, synchronous function that blocks until the extension call
 * finishes; MainActivity runs these on its network pool, never on the WebView thread,
 * so a slow extension cannot freeze the UI. Results are JSON strings/objects so the
 * Java side only has to put them into the reply envelope.
 *
 * Nothing here re-implements CloudStream behaviour: it is a serializer in front of
 * [CsEngine], [CsPluginManager] and [CsRepositoryManager], so the web UI and an
 * extension calling its own manager both see the same state.
 */
object CsBridge {

    /** One call may take as long as the slowest provider; keep the envelope bounded. */
    private const val CALL_TIMEOUT = 120_000L

    // ── Repositories ──────────────────────────────────────────────────────────

    fun repositories(): JSONArray = JSONArray().apply {
        CsRepositoryManager.getRepositories().forEach { r ->
            put(JSONObject().apply {
                put("name", r.name)
                put("url", r.url)
                put("iconUrl", r.iconUrl ?: JSONObject.NULL)
                put("description", r.description ?: JSONObject.NULL)
            })
        }
    }

    fun addRepository(input: String): JSONObject = runBlocking {
        val r = CsRepositoryManager.addRepository(input)
        JSONObject().apply {
            put("name", r.name)
            put("url", r.url)
            put("iconUrl", r.iconUrl ?: JSONObject.NULL)
            put("description", r.description ?: JSONObject.NULL)
        }
    }

    fun removeRepository(url: String) {
        CsRepositoryManager.removeRepository(url)
        CsPluginManager.bumpVersion()
    }

    fun jsDelivr(): Boolean = CsRepositoryManager.useJsDelivr

    fun setJsDelivr(enabled: Boolean) {
        CsRepositoryManager.useJsDelivr = enabled
    }

    /** Every extension a repository lists, marked with whether it is installed and up to date. */
    fun repoPlugins(repositoryUrl: String): JSONArray = runBlocking {
        val repo = CsRepositoryManager.getRepositories().firstOrNull { it.url == repositoryUrl }
            ?: error("Unknown repository")
        val installed = CsPluginManager.installed().associateBy { it.internalName }
        val wrappers = CsRepositoryManager.getRepoPlugins(repo) ?: error("Couldn't read ${repo.name}")
        JSONArray().apply {
            wrappers.forEach { w ->
                val p = w.plugin
                val local = installed[p.internalName]
                put(JSONObject().apply {
                    put("internalName", p.internalName)
                    put("name", p.name)
                    put("version", p.version)
                    put("description", p.description ?: JSONObject.NULL)
                    put("authors", JSONArray(p.authors))
                    put("language", p.language ?: JSONObject.NULL)
                    put("iconUrl", p.iconUrl ?: JSONObject.NULL)
                    put("status", p.status)
                    put("tvTypes", JSONArray(p.tvTypes.orEmpty()))
                    put("fileSize", p.fileSize ?: JSONObject.NULL)
                    put("repositoryUrl", repositoryUrl)
                    put("installed", local != null)
                    put("installedVersion", local?.version ?: JSONObject.NULL)
                    put("updateAvailable", local != null && p.version > local.version)
                })
            }
        }
    }

    // ── Installed extensions ──────────────────────────────────────────────────

    fun plugins(): JSONArray = JSONArray().apply {
        CsPluginManager.installed().forEach { d ->
            val entry = CsPluginManager.loaded[d.filePath]
            put(JSONObject().apply {
                put("internalName", d.internalName)
                put("name", d.name ?: d.internalName)
                put("version", d.version)
                put("isOnline", d.isOnline)
                put("repositoryUrl", d.repositoryUrl ?: JSONObject.NULL)
                put("loaded", entry != null)
                put("providerCount", entry?.providers?.size ?: 0)
                put("extractorCount", entry?.extractorCount ?: 0)
                put("error", CsPluginManager.failures[d.internalName]?.message ?: JSONObject.NULL)
            })
        }
    }

    fun installPlugin(repositoryUrl: String, internalName: String): Boolean = runBlocking {
        val repo = CsRepositoryManager.getRepositories().firstOrNull { it.url == repositoryUrl }
            ?: error("Unknown repository")
        val wrapper = CsRepositoryManager.getRepoPlugins(repo)
            ?.firstOrNull { it.plugin.internalName == internalName }
            ?: error("$internalName is not in ${repo.name}")
        CsPluginManager.install(wrapper).isSuccess
    }

    fun uninstallPlugin(internalName: String) {
        CsPluginManager.uninstall(internalName)
    }

    fun updateAll(): JSONArray = runBlocking {
        JSONArray(CsPluginManager.updateAll())
    }

    fun installMissing(includeNew: Boolean, languages: JSONArray?): JSONArray = runBlocking {
        val langs = (0 until (languages?.length() ?: 0))
            .map { languages!!.getString(it).lowercase() }.toSet()
        JSONArray(CsPluginManager.installMissing(includeNew, langs))
    }

    /** A .cs3 picked from storage (a content:// uri). */
    fun sideload(uriString: String): Boolean {
        val ctx = CsApp.context ?: error("No context")
        val uri = Uri.parse(uriString)
        val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.endsWith(".cs3") }
            ?: "sideloaded.cs3"
        val input = ctx.contentResolver.openInputStream(uri) ?: error("Couldn't open the file")
        return input.use { CsPluginManager.sideload(name, it).isSuccess }
    }

    // ── Providers ─────────────────────────────────────────────────────────────

    fun providers(): JSONArray = JSONArray().apply {
        CsEngine.providers().forEach { api ->
            put(JSONObject().apply {
                put("name", api.name)
                put("lang", api.lang)
                put("hasMainPage", api.hasMainPage)
                put("supportedTypes", JSONArray(api.supportedTypes.map { it.name }))
                put("sourcePlugin", api.sourcePlugin ?: JSONObject.NULL)
            })
        }
    }

    private fun resolve(names: JSONArray?): List<MainAPI> {
        val allowed = CsEngine.providers()
        if (names == null || names.length() == 0) return allowed
        val wanted = (0 until names.length()).map { names.getString(it) }.toSet()
        return allowed.filter { it.name in wanted }
    }

    // ── Home ──────────────────────────────────────────────────────────────────

    /** Home rows, one per enabled catalog of each provider. */
    fun home(apiNames: JSONArray?): JSONArray = runBlocking {
        val apis = resolve(apiNames).filter { it.hasMainPage }
        val sections = withTimeoutOrNull(CALL_TIMEOUT) { CsEngine.home(apis).toList() }
            ?: emptyList()
        JSONArray().apply {
            sections.sortedBy { it.order }.forEach { s ->
                put(JSONObject().apply {
                    put("apiName", s.api.name)
                    put("section", s.section.name)
                    put("name", s.list.name)
                    put("horizontal", s.list.isHorizontalImages)
                    put("items", JSONArray().apply {
                        s.list.list.forEach { put(searchItem(it)) }
                    })
                })
            }
        }
    }

    /** Every catalog of every provider, enabled or not, so the UI can show a picker. */
    fun catalogs(apiNames: JSONArray?): JSONArray = JSONArray().apply {
        resolve(apiNames).forEach { api ->
            CsCatalogs.all(api).forEach { e ->
                put(JSONObject().apply {
                    put("apiName", api.name)
                    put("name", e.section.name)
                    put("enabled", e.enabled)
                    put("index", e.index)
                })
            }
        }
    }

    fun setCatalogEnabled(apiName: String, section: String, enabled: Boolean) {
        val api = CsEngine.provider(apiName) ?: error("Unknown provider")
        val entries = CsCatalogs.all(api).map {
            if (it.section.name == section) CsCatalogs.Entry(it.index, it.section, enabled) else it
        }
        CsCatalogs.save(api, entries)
    }

    // ── Search ────────────────────────────────────────────────────────────────

    fun search(query: String, apiNames: JSONArray?): JSONArray = runBlocking {
        val batches = withTimeoutOrNull(CALL_TIMEOUT) { CsEngine.search(query, resolve(apiNames)).toList() }
            ?: emptyList()
        JSONArray().apply {
            batches.forEach { b ->
                put(JSONObject().apply {
                    put("apiName", b.api.name)
                    put("error", b.error?.message ?: JSONObject.NULL)
                    put("items", JSONArray().apply { b.results.forEach { put(searchItem(it)) } })
                })
            }
        }
    }

    // ── Title page ────────────────────────────────────────────────────────────

    fun load(apiName: String, url: String): JSONObject = runBlocking {
        val api = CsEngine.provider(apiName) ?: error("Unknown provider: $apiName")
        val response = CsEngine.load(api, url) ?: error("$apiName couldn't load that title")
        loadResponse(response).also { obj ->
            // Warm the first episode's sources while the user is still reading.
            runCatching {
                val first = CsEngine.playables(response).firstOrNull()
                if (first != null) CsEngine.prefetch(api, first.data)
            }
            obj.put("apiName", apiName)
        }
    }

    // ── Sources ───────────────────────────────────────────────────────────────

    fun links(apiName: String, data: String): JSONObject = runBlocking {
        val api = CsEngine.provider(apiName) ?: error("Unknown provider: $apiName")
        val found = CsEngine.allLinks(api, data)
        JSONObject().apply {
            put("links", JSONArray().apply { found.links.forEach { put(link(it)) } })
            put("subtitles", JSONArray().apply { found.subtitles.forEach { put(subtitle(it)) } })
        }
    }

    fun prefetch(apiName: String, data: String) {
        CsEngine.provider(apiName)?.let { CsEngine.prefetch(it, data) }
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    fun settings(): JSONObject = JSONObject().apply {
        put("sourcesTimeoutSeconds", CsSettings.sourcesTimeoutSeconds)
        put("preferredQuality", CsSettings.preferredQuality)
        put("audioLanguage", CsSettings.audioLanguage)
        put("prepareSources", CsSettings.prepareSources)
        put("allowAdult", CsSettings.allowAdult)
        put("jsDelivr", CsRepositoryManager.useJsDelivr)
    }

    fun setSettings(patch: JSONObject) {
        if (patch.has("sourcesTimeoutSeconds")) CsSettings.sourcesTimeoutSeconds = patch.getInt("sourcesTimeoutSeconds")
        if (patch.has("preferredQuality")) CsSettings.preferredQuality = patch.getInt("preferredQuality")
        if (patch.has("audioLanguage")) CsSettings.audioLanguage = patch.getString("audioLanguage")
        if (patch.has("prepareSources")) CsSettings.prepareSources = patch.getBoolean("prepareSources")
        if (patch.has("allowAdult")) CsSettings.allowAdult = patch.getBoolean("allowAdult")
        if (patch.has("jsDelivr")) CsRepositoryManager.useJsDelivr = patch.getBoolean("jsDelivr")
    }

    // ── Serialization ─────────────────────────────────────────────────────────

    private fun searchItem(r: SearchResponse) = JSONObject().apply {
        put("name", r.name)
        put("url", r.url)
        put("apiName", r.apiName)
        put("type", r.type?.name ?: JSONObject.NULL)
        put("posterUrl", r.posterUrl ?: JSONObject.NULL)
        put("quality", r.quality?.name ?: JSONObject.NULL)
        put("score", r.score?.toDouble() ?: JSONObject.NULL)
        put("id", r.id ?: JSONObject.NULL)
    }

    private fun loadResponse(r: LoadResponse) = JSONObject().apply {
        put("name", r.name)
        put("url", r.url)
        put("type", r.type.name)
        put("posterUrl", r.posterUrl ?: JSONObject.NULL)
        put("backgroundPosterUrl", r.backgroundPosterUrl ?: JSONObject.NULL)
        put("logoUrl", r.logoUrl ?: JSONObject.NULL)
        put("year", r.year ?: JSONObject.NULL)
        put("plot", r.plot ?: JSONObject.NULL)
        put("duration", r.duration ?: JSONObject.NULL)
        put("score", r.score?.toDouble() ?: JSONObject.NULL)
        put("contentRating", r.contentRating ?: JSONObject.NULL)
        put("tags", JSONArray(r.tags.orEmpty()))
        put("playables", JSONArray().apply {
            CsEngine.playables(r).forEach { p ->
                put(JSONObject().apply {
                    put("label", p.label)
                    put("data", p.data)
                    put("season", p.season ?: JSONObject.NULL)
                    put("episode", p.episode ?: JSONObject.NULL)
                    put("name", p.name ?: JSONObject.NULL)
                    put("posterUrl", p.posterUrl ?: JSONObject.NULL)
                    put("description", p.description ?: JSONObject.NULL)
                    put("dub", p.dub ?: JSONObject.NULL)
                })
            }
        })
        // Which shape the response was, so the UI can say "series" vs "movie" without guessing.
        put("kind", when (r) {
            is TvSeriesLoadResponse -> "series"
            is AnimeLoadResponse -> "anime"
            is MovieLoadResponse -> "movie"
            is TorrentLoadResponse -> "torrent"
            else -> "live"
        })
    }

    private fun link(l: ExtractorLink) = JSONObject().apply {
        put("source", l.source)
        put("name", l.name)
        put("url", l.url)
        put("referer", l.referer)
        put("quality", l.quality)
        put("type", l.type.name)
        put("isM3u8", l.isM3u8)
        put("headers", JSONObject().apply { l.headers.forEach { (k, v) -> put(k, v) } })
    }

    private fun subtitle(s: SubtitleFile) = JSONObject().apply {
        put("lang", s.lang)
        put("url", s.url)
        put("headers", JSONObject().apply { s.headers.orEmpty().forEach { (k, v) -> put(k, v) } })
    }

    /** Absolute path of an installed extension's file, for the UI's "share/export" affordance. */
    fun pluginFile(internalName: String): String? =
        CsPluginManager.installed().firstOrNull { it.internalName == internalName }
            ?.let { File(it.filePath).absolutePath }
}
