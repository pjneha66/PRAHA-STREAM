package com.praha.stream.mpv

import android.content.Context
import android.view.Surface
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import com.edde746.mpv.MpvEvent
import com.edde746.mpv.MpvPlayer
import com.edde746.mpv.PropertyChange
import com.edde746.mpv.PropertyFormat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Capacitor bridge for libmpv.
 *
 * The engine itself is not here: it arrives compiled in the mpv-android AAR
 * (`com.edde746.mpv.MpvPlayer`, from Plezy / edde746's mpv-build). That AAR
 * carries libmpv, FFmpeg, libass and libdovi statically linked into libmpv.so,
 * which is why this file only has to marshal calls and keep a Surface alive.
 *
 * Video surface strategy: add a SurfaceView *behind* the WebView at index 0 and
 * leave a transparent hole in the page for it. The WebView must be transparent
 * for that to work, and it is (see MainActivity's setBackgroundColor). This is
 * the approach that keeps HDR, since SurfaceView gets a real hardware layer.
 *
 * All property writes go through `runOnMpvThread` because libmpv's client API is
 * not thread-safe for commands; property *reads* are safe from anywhere but are
 * cheap enough to also route through the same serial queue.
 */
@CapacitorPlugin(name = "PrahaMpv")
class PrahaMpvPlugin : Plugin() {

    private var player: MpvPlayer? = null
    private var surfaceView: SurfaceView? = null

    /** Declared before the thread that drains it: Kotlin initialises in order. */
    private val queue = java.util.concurrent.LinkedBlockingQueue<Runnable>()
    private val shutdown = AtomicBoolean(false)

    /** One thread for every libmpv call, so commands cannot interleave. */
    private val mpvThread = object : Thread("praha-mpv") {
        override fun run() {
            while (!shutdown.get()) {
                val task = try {
                    queue.take()
                } catch (interrupted: InterruptedException) {
                    break
                }
                try {
                    task.run()
                } catch (e: Throwable) {
                    notifyError("mpv task failed: ${e.message}")
                }
            }
        }
    }

    override fun load() {
        mpvThread.isDaemon = true
        mpvThread.start()
    }

    override fun handleOnDestroy() {
        shutdown.set(true)
        mpvThread.interrupt()
        runOnMpvThread { releasePlayer() }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    @PluginMethod
    fun initialize(call: PluginCall) {
        runOnMpvThread {
            try {
                if (player == null) {
                    val created = MpvPlayer.create(
                        context,
                        listener,
                        -1L,
                    ) {
                        // Receiver lambda: `this` is the MpvPlayerConfig. These are
                        // the options VyseTV sets for the same reasons — a real GPU
                        // video output (keeps HDR), hardware decoding with a safe
                        // fallback, and a generous cache for torrent read-ahead.
                        setOption("vo", "gpu")
                        setOption("hwdec", "auto-safe")
                        setOption("gpu-context", "android")
                        setOption("audio-exclusive", "no")
                        setOption("keep-open", "yes")
                        setOption("idle", "yes")
                        setOption("cache", "yes")
                        setOption("demuxer-max-bytes", "128MiB")
                        setOption("demuxer-max-back-bytes", "64MiB")
                        setOption("force-seekable", "yes")
                        setLogLevel("warn")
                    }
                    player = created
                }
                call.resolve(JSObject().put("initialized", player != null))
            } catch (e: Throwable) {
                call.reject("Could not initialise mpv: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun destroy(call: PluginCall) {
        runOnMpvThread {
            releasePlayer()
            call.resolve()
        }
    }

    // ── Surface ────────────────────────────────────────────────────────────

    /**
     * Creates (or reuses) the SurfaceView and attaches it to the bridge's view
     * hierarchy at index 0, so the WebView paints on top of it.
     */
    @PluginMethod
    fun attachSurface(call: PluginCall) {
        val x = call.getInt("x") ?: 0
        val y = call.getInt("y") ?: 0
        val width = call.getInt("width") ?: 0
        val height = call.getInt("height") ?: 0

        activity.runOnUiThread {
            try {
                val webView = bridge.webView
                val parent = webView.parent as? ViewGroup
                    ?: run {
                        call.reject("WebView has no parent container.")
                        return@runOnUiThread
                    }

                val view = surfaceView ?: SurfaceView(context).also { created ->
                    created.holder.setFixedSize(width.coerceAtLeast(1), height.coerceAtLeast(1))
                    parent.addView(created, 0, FrameLayout.LayoutParams(width, height))
                    surfaceView = created
                }

                updateSurfaceRect(view, x, y, width, height)
                call.resolve(JSObject().put("attached", true))
            } catch (e: Throwable) {
                call.reject("Could not attach the video surface: ${e.message}")
            }
        }
    }

    /** Moves/resizes the surface when the page's player element moves. */
    @PluginMethod
    fun setSurfaceRect(call: PluginCall) {
        val x = call.getInt("x") ?: 0
        val y = call.getInt("y") ?: 0
        val width = call.getInt("width") ?: 0
        val height = call.getInt("height") ?: 0
        activity.runOnUiThread {
            val view = surfaceView
            if (view == null) {
                call.reject("No surface attached.")
                return@runOnUiThread
            }
            updateSurfaceRect(view, x, y, width, height)
            call.resolve()
        }
    }

    @PluginMethod
    fun detachSurface(call: PluginCall) {
        activity.runOnUiThread {
            runOnMpvThread {
                // attachSurfaces() takes non-null Surfaces, so the way to stop
                // video without tearing down the player is to disable the video
                // track; removing the view alone would leave mpv drawing into a
                // surface that is no longer on screen.
                try {
                    player?.setProperty("vid", "no")
                } catch (_: Throwable) {
                    // Nothing playing; nothing to undo.
                }
            }
            surfaceView?.let { view ->
                (view.parent as? ViewGroup)?.removeView(view)
            }
            surfaceView = null
            call.resolve()
        }
    }

    private fun updateSurfaceRect(view: SurfaceView, x: Int, y: Int, width: Int, height: Int) {
        val params = view.layoutParams as? FrameLayout.LayoutParams
            ?: FrameLayout.LayoutParams(width, height)
        params.width = width
        params.height = height
        params.leftMargin = x
        params.topMargin = y
        view.layoutParams = params
        view.requestLayout()
        view.holder.setFixedSize(width.coerceAtLeast(1), height.coerceAtLeast(1))
    }

    // ── Loading media ──────────────────────────────────────────────────────

    @PluginMethod
    fun load(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("load needs a url.")
            return
        }
        val headers = call.getObject("headers")
        val startSeconds = call.getDouble("startSeconds") ?: 0.0

        runOnMpvThread {
            try {
                val mpv = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnMpvThread
                }
                // Headers have to be set before the file is opened, otherwise
                // mpv has already made its first request without them (this is
                // exactly the case for the header-protected CDNs).
                headers?.let { obj ->
                    val fields = obj.keys().asSequence()
                        .joinToString(",") { key ->
                            val value = obj.optString(key, "")
                            "$key: $value"
                        }
                    if (fields.isNotEmpty()) {
                        mpv.setProperty("http-header-fields", fields)
                    }
                }
                if (startSeconds > 0) {
                    mpv.setProperty("start", "+$startSeconds")
                }
                mpv.command("loadfile", url, "replace")
                call.resolve()
            } catch (e: Throwable) {
                call.reject("mpv could not load the stream: ${e.message}")
            }
        }
    }

    // ── Transport ──────────────────────────────────────────────────────────

    @PluginMethod
    fun play(call: PluginCall) = command(call, "set pause no")

    @PluginMethod
    fun pause(call: PluginCall) = command(call, "set pause yes")

    @PluginMethod
    fun stop(call: PluginCall) = command(call, "stop")

    @PluginMethod
    fun seek(call: PluginCall) {
        val timeMs = call.getLong("timeMs") ?: 0L
        val absolute = call.getBoolean("absolute") ?: true
        val seconds = timeMs / 1000.0
        command(call, if (absolute) "seek $seconds absolute" else "seek $seconds relative")
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getInt("volume") ?: 100
        command(call, "set volume $volume")
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val rate = call.getDouble("rate") ?: 1.0
        command(call, "set speed $rate")
    }

    @PluginMethod
    fun setMute(call: PluginCall) {
        val muted = call.getBoolean("muted") ?: false
        command(call, "set mute ${if (muted) "yes" else "no"}")
    }

    private fun command(call: PluginCall, commandLine: String) {
        runOnMpvThread {
            try {
                val mpv = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnMpvThread
                }
                mpv.command(*commandLine.split(" ").toTypedArray())
                call.resolve()
            } catch (e: Throwable) {
                call.reject("mpv command failed ($commandLine): ${e.message}")
            }
        }
    }

    // ── Tracks, subtitles, audio ───────────────────────────────────────────

    @PluginMethod
    fun getTracks(call: PluginCall) {
        runOnMpvThread {
            try {
                val mpv = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnMpvThread
                }
                val count = mpv.getInt("track-list/count") ?: 0
                val tracks = com.getcapacitor.JSArray()
                for (index in 0 until count) {
                    val prefix = "track-list/$index"
                    val type = mpv.getString("$prefix/type") ?: continue
                    tracks.put(
                        JSObject()
                            .put("id", index)
                            .put("type", type)
                            .put("title", mpv.getString("$prefix/title") ?: "")
                            .put("lang", mpv.getString("$prefix/lang") ?: "")
                            .put("codec", mpv.getString("$prefix/codec") ?: "")
                            .put("selected", mpv.getFlag("$prefix/selected") ?: false)
                            .put("external", mpv.getFlag("$prefix/external") ?: false),
                    )
                }
                call.resolve(JSObject().put("tracks", tracks))
            } catch (e: Throwable) {
                call.reject("Could not read tracks: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun selectTrack(call: PluginCall) {
        val type = call.getString("type") ?: "audio"
        val id = call.getInt("id") ?: -1
        command(call, "set ${type} $id")
    }

    @PluginMethod
    fun addSubtitle(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("addSubtitle needs a url.")
            return
        }
        val select = call.getBoolean("select") ?: true
        command(call, "sub-add $url ${if (select) "select" else "auto"}")
    }

    @PluginMethod
    fun setSubtitleDelay(call: PluginCall) {
        val seconds = call.getDouble("seconds") ?: 0.0
        command(call, "set sub-delay $seconds")
    }

    @PluginMethod
    fun setAudioDelay(call: PluginCall) {
        val seconds = call.getDouble("seconds") ?: 0.0
        command(call, "set audio-delay $seconds")
    }

    // ── Property passthrough ───────────────────────────────────────────────

    @PluginMethod
    fun setProperty(call: PluginCall) {
        val name = call.getString("name")
        if (name.isNullOrBlank()) {
            call.reject("setProperty needs a name.")
            return
        }
        val value = call.getString("value") ?: ""
        runOnMpvThread {
            try {
                player?.setProperty(name, value)
                call.resolve()
            } catch (e: Throwable) {
                call.reject("setProperty($name) failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun getProperty(call: PluginCall) {
        val name = call.getString("name")
        if (name.isNullOrBlank()) {
            call.reject("getProperty needs a name.")
            return
        }
        runOnMpvThread {
            try {
                call.resolve(JSObject().put("value", player?.getString(name)))
            } catch (e: Throwable) {
                call.reject("getProperty($name) failed: ${e.message}")
            }
        }
    }

    // ── Event plumbing ─────────────────────────────────────────────────────

    private val listener = object : MpvPlayer.Listener {
        override fun onPropertyChange(change: PropertyChange) {
            val value: Any? = when (change) {
                is PropertyChange.Double -> change.value
                is PropertyChange.Flag -> change.value
                is PropertyChange.Int64 -> change.value
                is PropertyChange.Str -> change.value
                else -> null
            }
            notifyListeners(
                "propertyChange",
                JSObject().put("name", change.name).put("value", value),
            )
        }

        override fun onEvent(event: MpvEvent) {
            val payload = JSObject().put("event", event.javaClass.simpleName)
            when (event) {
                is MpvEvent.EndFile -> payload.put("reason", event.reason?.name).put("error", event.errorMessage)
                is MpvEvent.FileLoaded -> payload.put("done", true)
                is MpvEvent.LogMessage -> payload.put("text", event.text).put("prefix", event.prefix)
                else -> {
                    // StartFile / PlaybackRestart carry no fields we forward.
                }
            }
            notifyListeners("mpvEvent", payload)
        }
    }

    private fun notifyError(message: String) {
        notifyListeners("mpvError", JSObject().put("message", message))
    }

    private fun releasePlayer() {
        // close() releases the render context and its surfaces; there is no
        // separate detach step in this AAR's API.
        try {
            player?.close()
        } catch (_: Throwable) {
        }
        player = null
    }

    private fun runOnMpvThread(task: () -> Unit) {
        if (Thread.currentThread() === mpvThread) {
            task()
        } else {
            queue.put(Runnable { task() })
        }
    }
}
