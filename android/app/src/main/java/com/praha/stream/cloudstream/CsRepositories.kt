package com.praha.stream.cloudstream

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.readValue
import com.lagradost.cloudstream3.app
import com.lagradost.cloudstream3.mapper
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

// Data formats are copied from upstream app/.../plugins/RepositoryManager.kt so the
// same repo.json / plugins.json files work unmodified.

@JsonIgnoreProperties(ignoreUnknown = true)
data class CsRepository(
    val iconUrl: String? = null,
    val name: String,
    val description: String? = null,
    val manifestVersion: Int = 1,
    val pluginLists: List<String>,
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class CsSitePlugin(
    /** Url to the .cs3 file (Dalvik bytecode). */
    val url: String,
    /** 0: Down, 1: Ok, 2: Slow, 3: Beta only */
    val status: Int,
    val version: Int,
    val apiVersion: Int = 1,
    val name: String,
    val internalName: String,
    val authors: List<String> = emptyList(),
    val description: String? = null,
    val repositoryUrl: String? = null,
    val tvTypes: List<String>? = null,
    val language: String? = null,
    val iconUrl: String? = null,
    val fileSize: Long? = null,
    val fileHash: String? = null,
    /** Set by the gradle plugin when built with isCrossPlatform = true: plain JVM bytecode, not for Android. */
    val jarUrl: String? = null,
    val jarHash: String? = null,
    val jarFileSize: Long? = null,
)

/** Same fields as upstream's RepositoryData, stored under the same REPOSITORIES_KEY. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class CsRepositoryData(
    val iconUrl: String? = null,
    val name: String,
    val url: String,
    val description: String? = null,
)

data class CsPluginWrapper(
    val repository: CsRepository,
    val repositoryData: CsRepositoryData,
    val plugin: CsSitePlugin,
)

object CsRepositoryManager {
    const val REPOSITORIES_KEY = "REPOSITORIES_KEY"
    const val JSDELIVR_KEY = "jsdelivr_proxy_key"
    const val ONLINE_PLUGINS_FOLDER = "Extensions"
    private val GH_REGEX = Regex("^https://raw.githubusercontent.com/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/(.*)$")

    private val prefs get() = CsApp.context!!.getSharedPreferences("cloudstream_host", 0)

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
            }
        }
        return "sha256-" + digest.digest().joinToString("") { "%02x".format(it) }
    }

    var useJsDelivr: Boolean
        get() = prefs.getString(JSDELIVR_KEY, null) == "true"
        set(value) = prefs.edit().putString(JSDELIVR_KEY, value.toString()).apply()

    /** Convert raw.githubusercontent.com urls to cdn.jsdelivr.net if enabled. */
    fun convertRawGitUrl(url: String): String {
        if (!useJsDelivr) return url
        val match = GH_REGEX.find(url) ?: return url
        val (user, repo, rest) = match.destructured
        return "https://cdn.jsdelivr.net/gh/$user/$repo@$rest"
    }

    /** Accepts https urls, cloudstreamrepo:// links, and cutt.ly / py.md ("!code") shortcodes like the Android app. */
    suspend fun parseRepoUrl(url: String): String? {
        val fixedUrl = url.trim()
        return when {
            fixedUrl.contains("^https?://".toRegex()) -> fixedUrl
            fixedUrl.contains("^(cloudstreamrepo://)|(https://cs\\.repo/\\??)".toRegex()) ->
                fixedUrl.replace("^(cloudstreamrepo://)|(https://cs\\.repo/\\??)".toRegex(), "").let {
                    if (!it.contains("^https?://".toRegex())) "https://$it" else it
                }
            fixedUrl.matches("^[a-zA-Z0-9!_-]+$".toRegex()) -> runCatching {
                val (host, code) = if (fixedUrl.startsWith("!")) "py.md" to fixedUrl.removePrefix("!")
                else "cutt.ly" to fixedUrl
                val location = app.get("https://$host/$code", allowRedirects = false).headers["Location"]
                    ?: return null
                if (location.startsWith("https://$host/404") || location.removeSuffix("/") == "https://$host") null
                else location
            }.getOrNull()
            else -> null
        }
    }

    suspend fun parseRepository(url: String): CsRepository? = runCatching {
        mapper.readValue<CsRepository>(app.get(convertRawGitUrl(url), cacheTime = 15, cacheUnit = TimeUnit.MINUTES).text)
    }.onFailure { android.util.Log.w("repos", "Failed to read repository $url: $it") }.getOrNull()

    private suspend fun parsePlugins(pluginsUrl: String): List<CsSitePlugin> = runCatching {
        mapper.readValue<List<CsSitePlugin>>(app.get(convertRawGitUrl(pluginsUrl), cacheTime = 15, cacheUnit = TimeUnit.MINUTES).text)
    }.onFailure { android.util.Log.w("repos", "Failed to read plugin list $pluginsUrl: $it") }.getOrDefault(emptyList())

    suspend fun getRepoPlugins(repositoryData: CsRepositoryData): List<CsPluginWrapper>? {
        val repo = parseRepository(repositoryData.url) ?: return null
        return repo.pluginLists.flatMap { url -> parsePlugins(url).map { CsPluginWrapper(repo, repositoryData, it) } }
    }

    fun getRepositories(): List<CsRepositoryData> =
        prefs.getString(REPOSITORIES_KEY, null)?.let { mapper.readValue<List<CsRepositoryData>>(it) } ?: emptyList()

    private fun saveRepositories(list: List<CsRepositoryData>) =
        prefs.edit().putString(REPOSITORIES_KEY, mapper.writeValueAsString(list)).apply()

    /**
     * Stores a repository as given, without fetching it (the official app's
     * RepositoryManager.addRepository, which extensions like MegaRepo call on every
     * start). False if it was already there.
     */
    fun addRepositoryData(data: CsRepositoryData): Boolean = synchronized(this) {
        val current = getRepositories()
        if (current.any { it.url == data.url }) return false
        saveRepositories(current + data)
        true
    }

    /** Resolves [input] (url or shortcode), validates it is a repository, and stores it. */
    suspend fun addRepository(input: String): CsRepositoryData {
        val url = parseRepoUrl(input) ?: error("Not a repository url or shortcode: $input")
        val repo = parseRepository(url) ?: error("No valid repository manifest at $url")
        val data = CsRepositoryData(repo.iconUrl, repo.name, url, repo.description)
        synchronized(this) {
            val current = getRepositories().toMutableList()
            val index = current.indexOfFirst { it.url == url }
            if (index == -1) current += data else current[index] = data
            saveRepositories(current)
        }
        return data
    }

    fun removeRepository(url: String) {
        synchronized(this) { saveRepositories(getRepositories().filter { it.url != url }) }
        CsPluginManager.installed().filter { it.repositoryUrl == url }.forEach { CsPluginManager.uninstall(it.internalName) }
        File(extensionsDir, sanitizedFileName(url)).deleteRecursively()
    }

    val extensionsDir get() = File(CsApp.context!!.filesDir, ONLINE_PLUGINS_FOLDER)

    /** Same scheme as upstream getPluginSanitizedFileName: readable name plus hashCode for uniqueness. */
    fun sanitizedFileName(name: String): String =
        name.replace(Regex("[^A-Za-z0-9._-]"), "").take(100) + "." + name.hashCode()

    fun pluginPath(internalName: String, repositoryUrl: String, extension: String): File =
        File(extensionsDir, "${sanitizedFileName(repositoryUrl)}/${sanitizedFileName(internalName)}.$extension")

    /** Downloads atomically and verifies the sha256 that the gradle plugin wrote into plugins.json. */
    suspend fun download(url: String, target: File, expectedHash: String?): File {
        target.parentFile.mkdirs()
        val tmp = File.createTempFile(target.name, ".tmp", CsApp.context!!.cacheDir)
        try {
            val response = app.get(convertRawGitUrl(url)).okhttpResponse
            // An old address answers with an error page: never save that as the extension.
            check(response.isSuccessful) { "Couldn't download ${target.name} (HTTP ${response.code})" }
            response.body.byteStream().use { body ->
                tmp.outputStream().use { body.copyTo(it) }
            }
            // An extension (.cs3) is a zip file: anything else (a web page, a cut-off
            // download) would fail to load every time ("No manifest.json").
            if (target.name.endsWith(".cs3")) {
                val head = tmp.inputStream().use { i -> ByteArray(2).also { i.read(it) } }
                check(head[0] == 'P'.code.toByte() && head[1] == 'K'.code.toByte()) {
                    "${target.name}: the server didn't send an extension file"
                }
            }
            if (expectedHash != null) {
                val actual = sha256(tmp)
                check(actual == expectedHash) { "Hash mismatch for ${target.name}: expected $expectedHash, got $actual" }
            }
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } finally {
            tmp.delete()
        }
        return target
    }
}
