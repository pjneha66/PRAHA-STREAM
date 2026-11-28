package com.praha.stream.hiki

import android.content.Context
import com.hikari.ext.HikariProvider
import com.praha.stream.download.DownloadHttp
import dalvik.system.PathClassLoader
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipFile

/** Loads the Hikari native provider ABI from a verified, app-private archive. */
internal object HikiPackages {
    private const val MAX_PACKAGE = 32L * 1024 * 1024
    private val loaders = ConcurrentHashMap<String, List<HikariProvider>>()

    private fun prefs(context: Context) = context.getSharedPreferences("praha.hiki.packages", Context.MODE_PRIVATE)
    private fun directory(context: Context, id: String) = File(context.filesDir, "hiki/$id")
    private fun file(context: Context, entry: JSONObject) =
        File(directory(context, entry.getString("id")), entry.getString("fileHash").removePrefix("sha256-") + ".jar")

    fun entries(context: Context): List<JSONObject> = prefs(context).all.values.mapNotNull { raw ->
        (raw as? String)?.let { runCatching { JSONObject(it) }.getOrNull() }
    }.sortedBy { it.optString("name").lowercase() }

    fun validateUrl(raw: String): String {
        val url = raw.toHttpUrlOrNull() ?: error("Enter an HTTPS repository or package URL.")
        require(url.isHttps && url.username.isEmpty() && url.password.isEmpty()) { "An HTTPS URL without credentials is required." }
        return url.toString()
    }

    @Synchronized
    fun install(context: Context, request: JSONObject): JSONObject {
        val url = validateUrl(request.getString("url"))
        require(url.toHttpUrlOrNull()!!.encodedPath.endsWith(".hiki", ignoreCase = true)) { "This entry is not a .hiki package." }
        val hash = request.optString("fileHash").lowercase()
        require(hash.matches(Regex("sha256-[a-f0-9]{64}"))) { "This repository entry needs a SHA-256 fileHash." }
        val id = sha256(url.toByteArray()).take(32)
        val previous = prefs(context).getString(id, null)?.let(::JSONObject)
        val entry = JSONObject().put("id", id).put("name", request.getString("name").take(150))
            .put("url", url).put("fileHash", hash).put("version", request.optString("version").take(32))
            .put("adult", request.optBoolean("adult")).put("enabled", previous?.optBoolean("enabled", true) ?: true)
        val output = file(context, entry)
        val parent = output.parentFile ?: error("Could not prepare extension storage.")
        parent.mkdirs()
        if (!output.isFile) {
            val staging = File.createTempFile("hiki-", ".jar", parent)
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                DownloadHttp.client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    check(response.isSuccessful && response.request.url.isHttps) { "Package download returned HTTP ${response.code}." }
                    check(response.body.contentLength() <= MAX_PACKAGE) { "The .hiki package exceeds the 32 MB limit." }
                    response.body.byteStream().use { input ->
                        FileOutputStream(staging).use { sink ->
                            check(staging.setReadOnly()) { "Could not protect the downloaded package." }
                            val buffer = ByteArray(65536)
                            var total = 0L
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                total += count
                                check(total <= MAX_PACKAGE) { "The .hiki package exceeds the 32 MB limit." }
                                digest.update(buffer, 0, count)
                                sink.write(buffer, 0, count)
                            }
                        }
                    }
                }
                check("sha256-" + digest.digest().hex() == hash) { "The .hiki checksum does not match the repository." }
                // Load from the final filename. Providers may read bundled resources after installation.
                check(staging.renameTo(output)) { "Could not store the verified .hiki package." }
            } finally {
                staging.delete()
            }
        }
        try {
            val providers = providers(context, entry)
            val names = JSONArray(providers.map { it.name })
            entry.put("providers", names)
            check(prefs(context).edit().putString(id, entry.toString()).commit()) { "Could not save the installation." }
        } catch (error: Throwable) {
            if (previous?.optString("fileHash") != hash) {
                loaders.remove(output.absolutePath)
                output.delete()
            }
            throw error
        }
        return entry
    }

    @Synchronized
    fun setEnabled(context: Context, id: String, enabled: Boolean) {
        val raw = prefs(context).getString(id, null) ?: error("Extension is no longer installed.")
        check(prefs(context).edit().putString(id, JSONObject(raw).put("enabled", enabled).toString()).commit()) {
            "Could not save the extension setting."
        }
    }

    fun providers(context: Context, entry: JSONObject): List<HikariProvider> {
        val archive = file(context, entry)
        check(archive.isFile && archive.setReadOnly()) { "The installed .hiki package is missing or is not read-only." }
        return loaders.computeIfAbsent(archive.absolutePath) {
            val classes = ZipFile(archive).use { zip ->
                check(zip.getEntry("classes.dex") != null) { "The .hiki archive has no classes.dex." }
                val manifest = zip.getEntry("manifest.json") ?: error("The .hiki archive has no manifest.json.")
                check(manifest.size in 1..65536) { "The .hiki manifest is too large." }
                val root = JSONObject(zip.getInputStream(manifest).bufferedReader().use { it.readText() })
                when (val value = root.opt("mainClass")) {
                    is String -> listOf(value)
                    is JSONArray -> (0 until value.length().coerceAtMost(150)).map { value.getString(it) }
                    else -> error("The .hiki manifest has no mainClass.")
                }
            }
            val loader = PathClassLoader(archive.absolutePath, context.classLoader)
            val failures = mutableListOf<String>()
            classes.mapNotNull { name ->
                try {
                    val type = loader.loadClass(name)
                    check(type.classLoader === loader && HikariProvider::class.java.isAssignableFrom(type)) {
                        "The entry does not implement HikariProvider."
                    }
                    type.getDeclaredConstructor().newInstance() as HikariProvider
                } catch (error: Exception) {
                    failures += "$name: ${error.cause?.message ?: error.message}"
                    null
                } catch (error: LinkageError) {
                    failures += "$name: ${error.message}"
                    null
                }
            }.ifEmpty { error(failures.firstOrNull()?.take(280) ?: "The .hiki archive registered no providers.") }
        }
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).hex()
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 255) }
}
