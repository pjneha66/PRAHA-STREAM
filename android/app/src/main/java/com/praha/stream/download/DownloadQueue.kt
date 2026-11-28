package com.praha.stream.download

import android.content.Context
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal object DownloadQueue {
    private const val PREFS = "praha.video.downloads"
    private var jobs: MutableList<JSONObject>? = null
    private val active = mutableSetOf<String>()

    private fun read(context: Context): MutableList<JSONObject> = jobs ?: run {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("jobs", "[]")
        val list = runCatching { JSONArray(saved) }.getOrElse { JSONArray() }
        MutableList(list.length()) { index ->
            list.getJSONObject(index).apply {
                if (optString("state") in listOf("downloading", "converting")) put("state", "paused")
            }
        }.also { jobs = it }
    }

    private fun save(context: Context) {
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("jobs", JSONArray(read(context)).toString()).commit()) { "Could not save video downloads" }
    }

    @Synchronized
    fun enqueue(context: Context, options: JSONObject): String {
        val id = "hikari-" + UUID.randomUUID()
        val job = JSONObject(options.toString()).put("id", id).put("state", "queued")
        val jobs = read(context)
        jobs.add(0, job)
        try {
            save(context)
        } catch (error: Exception) {
            jobs.remove(job)
            throw error
        }
        return id
    }

    @Synchronized
    fun rows(context: Context): JSONArray = JSONArray(read(context).map { item ->
        JSONObject().put("id", item.optString("id")).put("title", item.optString("title"))
    })

    @Synchronized
    fun get(context: Context, id: String): JSONObject? =
        read(context).firstOrNull { it.optString("id") == id }?.let { JSONObject(it.toString()) }

    @Synchronized
    fun status(context: Context, id: String): JSONObject {
        val job = get(context, id) ?: JSONObject()
        val path = job.optString("path")
        return JSONObject()
            .put("state", job.optString("state", "missing"))
            .put("bytes", job.optLong("bytes", 0))
            .put("total", job.optLong("total", 0))
            .put("duration", job.optLong("duration", 0))
            .put("downloadedDuration", job.optLong("downloadedDuration", 0))
            .put("error", job.optString("error"))
            .put("shareable", job.optString("savedUri").isNotBlank() || path.isNotBlank() && !path.endsWith(".m3u8"))
            .put("canExport", path.endsWith(".m3u8"))
    }

    @Synchronized
    fun change(context: Context, id: String, action: String): Boolean {
        val list = read(context)
        val job = list.firstOrNull { it.optString("id") == id } ?: return false
        val state = job.optString("state")
        when (action) {
            "pause" -> if (state == "queued" || state == "downloading") job.put("state", "paused") else return false
            "resume" -> if (state == "paused" || state == "failed") {
                job.put("state", "queued").remove("error")
                job.put("resume", true)
            } else return false
            "remove" -> {
                list.remove(job)
                if (id !in active) workDir(context, id).deleteRecursively()
            }
            else -> return false
        }
        save(context)
        return true
    }

    @Synchronized
    private fun claim(context: Context): JSONObject? {
        val job = read(context).lastOrNull { it.optString("state") == "queued" && it.optString("id") !in active } ?: return null
        job.put("state", "downloading")
        active.add(job.optString("id"))
        save(context)
        return JSONObject(job.toString())
    }

    @Synchronized
    private fun update(context: Context, id: String, persist: Boolean = false, edit: (JSONObject) -> Unit) {
        val job = read(context).firstOrNull { it.optString("id") == id } ?: return
        if (job.optString("state") !in listOf("downloading", "converting")) return
        edit(job)
        if (persist) save(context)
    }

    @Synchronized
    private fun isCancelled(context: Context, id: String): Boolean =
        read(context).firstOrNull { it.optString("id") == id }?.optString("state") !in listOf("downloading", "converting")

    private fun workDir(context: Context, id: String) = File(context.filesDir, "video_downloads/$id")

    suspend fun runNext(context: Context): Boolean {
        val job = claim(context) ?: return false
        val id = job.getString("id")
        val dir = workDir(context, id)
        val headers = job.optJSONObject("headers") ?: JSONObject()
        try {
            val result = DownloadEngine.run(
                ctx = context,
                task = DownloadTask(
                    title = job.getString("title"),
                    url = job.getString("url"),
                    headers = headers.keys().asSequence().associateWith { headers.getString(it) },
                    kind = if (job.optBoolean("export")) DownloadKind.EXPORT else DownloadKind.OFFLINE,
                    preferredHeight = job.optInt("height"),
                    preferredAudio = job.optString("audio"),
                    isM3u8 = job.optBoolean("hls"),
                    resumePartial = job.optBoolean("resume"),
                ),
                workDir = dir,
                onProgress = { progress ->
                    update(context, id) {
                        it.put("bytes", progress.doneBytes).put("total", progress.totalBytes)
                            .put("duration", progress.durationMs).put("downloadedDuration", progress.doneDurationMs)
                    }
                },
                onConverting = { update(context, id, true) { it.put("state", "converting") } },
                isCancelled = { isCancelled(context, id) },
            )
            update(context, id, true) {
                it.put("state", "complete").put("path", result.localPath).put("savedUri", result.savedUri)
            }
        } catch (error: CancellationException) {
            update(context, id, true) { it.put("state", "paused").put("resume", true) }
            throw error
        } catch (error: DownloadCancelledException) {
            update(context, id, true) { it.put("state", "paused").put("resume", true) }
        } catch (error: Exception) {
            update(context, id, true) {
                it.put("state", "failed").put("error", (error.message ?: "Download failed").take(200))
            }
        } finally {
            synchronized(this) {
                active.remove(id)
                if (get(context, id) == null) dir.deleteRecursively()
            }
        }
        return true
    }
}
