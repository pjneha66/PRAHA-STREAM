package com.praha.stream.hiki

import android.content.Context
import com.hikari.app.net.Http
import com.hikari.ext.HikariCatalog
import com.hikari.ext.HikariEpisode
import com.hikari.ext.HikariMedia
import com.hikari.ext.HikariMediaType
import com.hikari.ext.HikariProvider
import com.hikari.ext.HikariStream
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

object HikiBridge {
    @JvmStatic
    fun dispatch(context: Context, method: String, args: JSONArray): Any? = when (method) {
        "hikiRepo" -> repository(args.getString(0))
        "hikiInstall" -> HikiPackages.install(context, JSONObject(args.getString(0)))
        "hikiInstalled" -> JSONArray(HikiPackages.entries(context))
        "hikiSetEnabled" -> HikiPackages.setEnabled(context, args.getString(0), args.getBoolean(1)).let { null }
        "hikiProviders" -> providers(context, args.getString(0)).let { (entry, providers) ->
            JSONArray(providers.map { provider ->
                JSONObject().put("key", "${entry.getString("id")}/${provider.id}")
                    .put("name", provider.name).put("description", provider.description)
            })
        }
        "hikiCatalogs" -> JSONArray(provider(context, args.getString(0)).catalogs().take(150).map {
            JSONObject().put("id", it.id).put("name", it.name).put("type", it.type.name).put("rawType", it.rawType)
        })
        "hikiBrowse" -> withProvider(context, args) { provider ->
            val catalogId = args.optString(1)
            val query = args.optString(2).trim().take(200)
            val page = args.optInt(3, 1).coerceIn(1, 100)
            val list = if (query.isNotEmpty()) provider.search(query, page) else {
                val catalog = provider.catalogs().find { it.id == catalogId }
                    ?: error("This extension has no matching catalog.")
                provider.getCatalog(catalog, page)
            }
            JSONArray(list.take(250).map(::mediaJson))
        }
        "hikiDetails" -> withProvider(context, args) { provider ->
            val media = provider.getMeta(readMedia(args.getJSONObject(1)))
            val episodes = if (media.type == HikariMediaType.SERIES) provider.getEpisodes(media).orEmpty() else emptyList()
            JSONObject().put("media", mediaJson(media)).put("episodes", JSONArray(episodes.take(2000).map(::episodeJson)))
        }
        "hikiStreams" -> withProvider(context, args) { provider ->
            val media = readMedia(args.getJSONObject(1))
            val episode = args.optJSONObject(2)?.let(::readEpisode)
            JSONArray(provider.getStreams(media, episode).take(150).map(::streamJson))
        }
        else -> throw IllegalArgumentException("Unknown Hikari extension request.")
    }

    private fun repository(input: String): JSONObject {
        val url = HikiPackages.validateUrl(input)
        val text = Http.get(url).use { response ->
            check(response.isSuccessful && response.request.url.isHttps) { "The repository returned HTTP ${response.code}." }
            Http.readBody(response).toString(Charsets.UTF_8)
        }
        val root = JSONObject(text)
        val plugins = root.optJSONArray("plugins") ?: error("This repository has no plugins list.")
        val entries = (0 until minOf(plugins.length(), 2000)).mapNotNull { index ->
            val plugin = plugins.optJSONObject(index) ?: return@mapNotNull null
            val link = runCatching {
                HikiPackages.validateUrl(java.net.URI(url).resolve(plugin.getString("url")).toString())
            }.getOrNull() ?: return@mapNotNull null
            val path = java.net.URI(link).path
            val name = plugin.optString("name").trim().take(150)
            if (!path.endsWith(".hiki", ignoreCase = true) || name.isEmpty()) return@mapNotNull null
            val types = plugin.optJSONArray("tvTypes")
            val flagged = types != null && (0 until types.length()).any { types.optString(it).equals("NSFW", true) }
            val warning = plugin.optString("contentWarning")
            val flag = plugin.optString("nsfw")
            val adult = flagged || warning.equals("CONTENT_WARNING_NSFW", true) || (warning.toIntOrNull() ?: 0) > 0 ||
                flag == "1" || flag.equals("true", true) ||
                ADULT_NAMES.contains(path.substringAfterLast('/').substringBeforeLast('.').lowercase())
            JSONObject().put("name", name).put("url", link)
                .put("description", plugin.optString("description").take(400))
                .put("version", plugin.optString("version").take(32)).put("fileHash", plugin.optString("fileHash"))
                .put("adult", adult)
        }.distinctBy { it.getString("url") }
        return JSONObject().put("url", url).put("name", root.optString("name", "Hikari repository").take(150))
            .put("plugins", JSONArray(entries))
    }

    private fun providers(context: Context, id: String): Pair<JSONObject, List<HikariProvider>> {
        val entry = HikiPackages.entries(context).find { it.getString("id") == id } ?: error("This .hiki package is not installed.")
        check(entry.optBoolean("enabled", true)) { "Enable this extension before browsing." }
        return entry to HikiPackages.providers(context, entry).distinctBy { it.id }
    }

    private fun provider(context: Context, key: String): HikariProvider =
        providers(context, key.substringBefore('/')).second.find { it.id == key.substringAfter('/') }
            ?: error("That Hikari provider is no longer installed.")

    private fun withProvider(context: Context, args: JSONArray, query: suspend (HikariProvider) -> Any): Any =
        runBlocking { withTimeout(75_000) { query(provider(context, args.getString(0))) } }

    private fun mediaJson(media: HikariMedia) = JSONObject().put("id", media.id).put("title", media.title)
        .put("type", media.type.name).put("posterUrl", media.posterUrl).put("backdropUrl", media.backdropUrl)
        .put("year", media.year).put("overview", media.overview).put("genres", JSONArray(media.genres))
        .put("rawType", media.rawType)

    private fun readMedia(raw: JSONObject) = HikariMedia(
        id = raw.getString("id"),
        title = raw.optString("title"),
        type = HikariMediaType.entries.find { it.name == raw.optString("type") } ?: HikariMediaType.UNKNOWN,
        posterUrl = raw.optional("posterUrl"),
        year = raw.optInt("year").takeIf { it > 0 },
        overview = raw.optional("overview"),
        genres = raw.optJSONArray("genres")?.let { list -> (0 until list.length()).map { list.optString(it) } }.orEmpty(),
        backdropUrl = raw.optional("backdropUrl"),
        rawType = raw.optString("rawType"),
    )

    private fun episodeJson(episode: HikariEpisode) = JSONObject().put("number", episode.number)
        .put("id", episode.id).put("name", episode.name).put("image", episode.image).put("season", episode.season)

    private fun readEpisode(raw: JSONObject) = HikariEpisode(
        raw.getInt("number"), raw.getString("id"), raw.optional("name"), raw.optional("image"), raw.optInt("season", 1),
    )

    private fun streamJson(stream: HikariStream) = JSONObject().put("name", stream.name).put("url", stream.url)
        .put("headers", JSONObject(stream.headers)).put("isM3u8", stream.isM3u8).put("isMpd", stream.isMpd)
        .put("isTorrent", stream.isTorrent).put("externalUrl", stream.externalUrl).put("ytId", stream.ytId)
        .put("infoHash", stream.infoHash).put("fileIdx", stream.fileIdx).put("trackers", JSONArray(stream.trackers))
        .put("subtitles", JSONArray(stream.subtitles.map { JSONObject().put("lang", it.lang).put("url", it.url) }))

    private fun JSONObject.optional(key: String) = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

    // The official index currently leaves contentWarning unset on these entries.
    private val ADULT_NAMES = setOf("51cg", "91dju", "chaturbate", "czsav", "fkbae", "funlove", "haose", "hanime1",
        "hanimetv", "hstream", "iwara", "javopen", "kpw91", "krx18", "leakporner", "missav", "oppai",
        "pimpbunny", "porn4fans", "pornbimbo", "pornhoarder", "ppjav", "sanji", "sehu", "she91", "tanhua",
        "tubes", "twodhive", "watchhentai", "xanime", "xfree")
}
