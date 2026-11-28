package com.praha.stream.download

import android.app.Activity
import android.app.Dialog
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.ui.PlayerView
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object DownloadBridge {
    @JvmStatic
    fun enqueue(activity: Activity, json: String): String {
        val options = JSONObject(json)
        val url = options.optString("url").toHttpUrlOrNull() ?: return ""
        if (url.username.isNotEmpty() || url.password.isNotEmpty() ||
            url.encodedPath.endsWith(".mpd", ignoreCase = true) || options.optString("title").isBlank()) return ""
        val id = DownloadQueue.enqueue(activity, options)
        try {
            PrahaDownloadService.start(activity)
        } catch (error: Exception) {
            DownloadQueue.change(activity, id, "remove")
            throw error
        }
        return id
    }

    @JvmStatic
    fun rows(activity: Activity): JSONArray = DownloadQueue.rows(activity)

    @JvmStatic
    fun status(activity: Activity, id: String): JSONObject = DownloadQueue.status(activity, id)

    @JvmStatic
    fun action(activity: Activity, id: String, action: String): Boolean {
        if (action in listOf("pause", "resume", "remove")) {
            val changed = DownloadQueue.change(activity, id, action)
            if (changed && action == "resume") PrahaDownloadService.start(activity)
            return changed
        }
        val job = DownloadQueue.get(activity, id) ?: return false
        if (job.optString("state") != "complete") return false
        val local = job.optString("path").takeIf { it.isNotBlank() }?.let(::File)
        val saved = job.optString("savedUri").takeIf { it.isNotBlank() }?.let {
            if (it.startsWith("content:")) Uri.parse(it) else Uri.fromFile(File(it))
        }
        if (action == "export") {
            if (local?.extension != "m3u8") return false
            return enqueue(activity, job.apply { put("title", optString("title") + " (export)") }
                .put("export", true).put("resume", false).put("path", "").put("savedUri", "")
                .put("bytes", 0).put("total", 0).put("duration", 0).put("downloadedDuration", 0).toString()).isNotEmpty()
        }
        if (action == "play") {
            val uri = local?.takeIf { it.isFile }?.let(Uri::fromFile) ?: saved ?: return false
            activity.runOnUiThread { play(activity, uri) }
            return true
        }
        if (action != "share" || local?.extension == "m3u8") return false
        val uri = saved?.takeIf { it.scheme == "content" } ?: local?.let {
            FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", it)
        } ?: return false
        val intent = Intent(Intent.ACTION_SEND)
            .setType(activity.contentResolver.getType(uri) ?: "video/*")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .apply { clipData = ClipData.newRawUri("Video", uri) }
        activity.runOnUiThread { activity.startActivity(Intent.createChooser(intent, "Export video")) }
        return true
    }

    internal fun play(activity: Activity, uri: Uri, source: MediaSource.Factory? = null) {
        val dialog = Dialog(activity, android.R.style.Theme_Material_NoActionBar_Fullscreen)
        val builder = ExoPlayer.Builder(activity)
        if (source != null) builder.setMediaSourceFactory(source)
        val player = builder.build()
        val view = PlayerView(activity).apply { this.player = player }
        dialog.setContentView(view)
        dialog.setOnDismissListener { player.release() }
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Toast.makeText(activity, "Could not play this offline video.", Toast.LENGTH_LONG).show()
                dialog.dismiss()
            }
        })
        dialog.show()
        player.setMediaItem(MediaItem.fromUri(uri))
        player.prepare()
        player.play()
    }
}
