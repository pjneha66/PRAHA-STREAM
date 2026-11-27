package com.praha.stream.mpv

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import com.edde746.mpv.MpvEvent
import com.edde746.mpv.MpvPlayer
import com.edde746.mpv.MpvPlayerConfig
import com.edde746.mpv.PropertyChange
import com.edde746.mpv.PropertyFormat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Capacitor bridge for libmpv.
 *
 * The engine itself is not here: it arrives compiled in the mpv-android AAR
 * (`com.edde746.mpv.MpvPlayer`, from Plezy / edde746's mpv-build). That AAR
 * carries libmpv, FFmpeg, libass and libdovi statically linked into libmpv.so,
 * which is why this file only has to marshal calls and keep a Surface alive.
 *
 * The option set and the surface handoff are ported from VyseTV's
 * `android/app/src/main/kotlin/com/vyse/player/mpv/MpvPlayerCore.kt` and
 * `lib/mpv/` (GPL-3.0-or-later), which drives the *same* AAR build
 * (`d633bbc71269`, verified by sha256 in `android/variables.gradle`). Anything
 * here that looks arbitrary is that original's decision, kept for the same
 * reason; the comments say which.
 *
 * Video surface strategy: two SurfaceViews are added *behind* the WebView at
 * index 0 and the page leaves a transparent hole for them. The WebView must be
 * transparent for that to work, and it is (see MainActivity's
 * setBackgroundColor).
 *
 *  - `surfaceView` is the video plane, and its `Surface` must be handed to mpv
 *    with `attachSurfaces()`. Nothing renders without that call: mpv has no
 *    output target, never draws a frame, and the start guard reports the stream
 *    as dead. That was this bridge's bug — the view was created and never
 *    attached.
 *  - `osdSurfaceView` is the transparent subtitle/OSD plane that the
 *    `vo=mediacodec` hardware path draws into. It only exists for hardware
 *    sessions; the GL paths render OSD in the video plane and a second layer
 *    would demote hardware composition (and drop HDR).
 *
 * All property writes go through `runOnMpvThread` because libmpv's client API is
 * not thread-safe for commands; property *reads* are safe from anywhere but are
 * cheap enough to also route through the same serial queue.
 */
@CapacitorPlugin(name = "PrahaMpv")
class PrahaMpvPlugin : Plugin() {

    private var player: MpvPlayer? = null
    private var surfaceView: SurfaceView? = null
    private var osdSurfaceView: SurfaceView? = null

    /**
     * Hardware decode is the default and what the app selects. `vo=mediacodec`
     * only accepts decoder buffers, so a software session must start on the GL
     * path instead; the two are decided together in [configurePlayer].
     */
    private var hardwareDecoding = true

    /** Published by the SurfaceHolder callbacks, never read from `isValid`. */
    private var videoSurface: Surface? = null
    private var osdSurface: Surface? = null

    /** The page's view size, kept because it can arrive before the player. */
    private var lastSurfaceWidth = 0
    private var lastSurfaceHeight = 0
    private var lastAppliedSurfaceWidth = 0
    private var lastAppliedSurfaceHeight = 0

    /**
     * True while the video track is off because its surface went away.
     *
     * `SurfaceHolder` requires consumers to release a surface before
     * destruction returns, and this AAR's only way to release one is `vid=no`.
     * The flag is what makes the next attach put the track back: restoring
     * unconditionally would override a viewer who turned video off on purpose,
     * and never restoring would leave a recreated SurfaceView black.
     */
    private var videoSuspendedForSurfaceLoss = false

    /**
     * Bumped on every surface (re)creation and passed to `attachSurfaces`.
     *
     * mpv uses the pair to tell a stale handoff from a current one; a recreated
     * SurfaceView produces a new `Surface` object even when the view is reused,
     * so a generation that did not move is the only way to know the attachment
     * is the live one.
     */
    private val videoGeneration = AtomicLong(0)
    private val osdGeneration = AtomicLong(0)

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
        // The Dart original takes this as an argument; a host that never sends
        // it (this one) keeps hardware decoding on, which is what every phone
        // and TV build wants.
        hardwareDecoding = call.getBoolean("hardwareDecoding") ?: true

        runOnMpvThread {
            try {
                if (player == null) {
                    val created = MpvPlayer.create(
                        context,
                        listener,
                        -1L,
                    ) {
                        // The AAR declares this as a receiver lambda
                        // (`MpvPlayerConfig.() -> Unit`), so `this` is the config.
                        configurePlayer(this)
                    }
                    player = created
                    // A surface may already be waiting: the page attaches the
                    // element before `initialize` on a cold start.
                    attachPlayerSurfaces(created)
                }
                call.resolve(JSObject().put("initialized", player != null))
            } catch (e: Throwable) {
                call.reject("Could not initialise mpv: ${e.message}")
            }
        }
    }

    /**
     * The initial option set, before `mpv_initialize`.
     *
     * Ported from VyseTV `MpvPlayerCore.kt`'s init block. Every option below is
     * set before init because mpv resolves builtin scripts, the video output and
     * the decoder options there; a property written after `loadfile` would be
     * too late for some of them.
     */
    private fun configurePlayer(config: MpvPlayerConfig) {
        if (!hardwareDecoding) {
            // Software sessions run gpu,gpu-next: gpu is the battle-tested GLES
            // renderer on the Android device zoo. vo=mediacodec only takes
            // decoder buffers, so it cannot be in a software chain at all.
            config.setOption("vo", "gpu,gpu-next")
        } else {
            // Hardware sessions use the fork's vo=mediacodec: decoded buffers go
            // from MediaCodec straight to the compositor with per-frame
            // presentation timestamps — no GLES pass, 10-bit and the decoder's
            // dataspace (HDR10/HLG) intact — and subtitles/OSD render on the
            // sibling OSD surface. gpu stays in the chain for preinit failure.
            config.setOption("vo", "mediacodec,gpu")
        }
        config.setOption("gpu-context", "android")
        config.setOption("opengl-es", "yes")

        // The decoder chain MediaCodec-only. `mediacodec` decodes straight to
        // the video plane; `mediacodec-copy` is the fallback for devices below
        // API 26 and for codecs whose buffers the plane cannot take. Without an
        // explicit hwdec, mpv defaults to software and the vo=mediacodec chain
        // would reject every frame.
        if (hardwareDecoding) {
            config.setOption("hwdec", "mediacodec,mediacodec-copy")
        }

        // The Java MediaCodec wrapper, driven asynchronously where the platform
        // is trusted to. `ndk_codec=0` is the wrapper Media3/Chromium/Kodi drive
        // and the only one that can read the decoder's crop rectangle below API
        // 28 (without it a 1920x960 stream in a 1920x1088 buffer renders
        // stretched). `async=1` from API 31 lets the codec report finished
        // frames on its own thread instead of being polled — Media3's own
        // threshold, chosen for the same device-quirk history. `priority=0` is
        // realtime; some vendors refuse to configure a decoder with an operating
        // rate and no priority.
        val decoderOptions = buildList {
            add("ndk_codec=0")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add("async=1")
            add("priority=0")
        }.joinToString(",")
        config.setOption("vd-lavc-o", decoderOptions)

        // mpv's default hwdec-codecs leaves out mpeg2video, so broadcast MPEG-2
        // (Live TV) would decode in software and leave the hardware plane for a
        // GL vo, where 1080i with deinterlacing falls behind on TV-class CPUs.
        // The hardware decoder deinterlaces by itself and stays on the plane.
        // mpeg4 stays off so Xvid/DivX keep the software path.
        config.setOption("hwdec-codecs", "h264,hevc,mpeg2video,vp8,vp9,av1")

        if (hardwareDecoding) {
            // A MediaCodec decoder is a pipeline with a declared output delay; a
            // frame may leave it half a second after it went in. mpv's playloop
            // decodes on demand and looks ahead two frames, so with such a
            // decoder frames reach the vo after their display time and are shown
            // a vsync late. Running the decoder on its own thread with up to
            // half a second of frames queued ahead removes those late frames.
            config.setOption("vd-queue-enable", "yes")
            config.setOption("vd-queue-max-samples", "12")
            config.setOption("vd-queue-max-secs", "0.5")
            config.setOption("vd-queue-max-bytes", "48MiB")
        }

        // Keep AV1 film grain inside the decoder (dav1d). `auto` hands it to any
        // vo claiming VO_CAP_FILM_GRAIN, and gpu-next claims it on GLES where
        // libplacebo's raster grain fallback renders luma upside-down.
        config.setOption("vd-lavc-film-grain", "cpu")

        // audiotrack is the normal Android output; opensles is its fallback on
        // devices where audiotrack refuses the format.
        config.setOption("ao", "audiotrack,opensles")

        config.setOption("audio-exclusive", "no")
        // Pause on the last frame at EOF instead of unloading the file, so a
        // seek after the video ends still works.
        config.setOption("keep-open", "yes")
        config.setOption("idle", "yes")

        // Nothing here resolves media-server URLs, so mpv's ytdl_hook has
        // nothing to do: it costs an on_load hook per open and, on a failed
        // open, spawns yt-dlp with the URL in its argv.
        config.setOption("ytdl", "no")

        // Builtin Lua scripts nothing in the app reaches. At mpv's defaults each
        // is a Lua state started by mpv_initialize, most keep a thread for the
        // life of the player, and the first loadfile waits until every one has
        // loaded.
        for (name in UNUSED_BUILTIN_SCRIPT_OPTIONS) config.setOption(name, "no")

        // Torrent read-ahead. Larger than VyseTV's heap-tiered budget because
        // PRAHA streams from TorrServer over loopback where the reader is fast
        // and the cache is the only buffer between a piece and the decoder.
        config.setOption("cache", "yes")
        config.setOption("demuxer-max-bytes", "128MiB")
        config.setOption("demuxer-max-back-bytes", "64MiB")
        config.setOption("force-seekable", "yes")

        config.setLogLevel("warn")
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
     * Creates (or reuses) the surface views and attaches them to the bridge's
     * view hierarchy at index 0, so the WebView paints on top of them.
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
                    created.holder.addCallback(videoSurfaceCallback)
                    created.holder.setFixedSize(width.coerceAtLeast(1), height.coerceAtLeast(1))
                    // Behind the WebView, in the same slot the page leaves
                    // transparent.
                    parent.addView(created, 0)
                    surfaceView = created
                }

                // Only the hardware path draws OSD on its own plane. The GL
                // paths render OSD into the video plane, and an extra
                // translucent layer there would demote hardware composition.
                // Index 1 keeps the view order video → OSD → WebView; the
                // media-overlay z-order is what actually places it above the
                // video plane.
                if (hardwareDecoding && osdSurfaceView == null) {
                    val osd = SurfaceView(context)
                    osd.holder.addCallback(osdSurfaceCallback)
                    osd.holder.setFormat(PixelFormat.TRANSLUCENT)
                    osd.setZOrderOnTop(false)
                    osd.setZOrderMediaOverlay(true)
                    parent.addView(osd, 1)
                    osdSurfaceView = osd
                }

                updateSurfaceRect(view, x, y, width, height)
                osdSurfaceView?.let { updateSurfaceRect(it, x, y, width, height) }
                applySurfaceSize(width, height)
                // The video plane is *behind* the WebView, so an opaque WebView
                // paints straight over it and the picture never appears — which
                // is exactly what MainActivity's #090A0C backdrop did. The page
                // already goes transparent while a native session is live; this
                // makes the native side match. Restored in detachSurface.
                webView.setBackgroundColor(Color.TRANSPARENT)
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
            osdSurfaceView?.let { updateSurfaceRect(it, x, y, width, height) }
            // mpv sizes its video output from this property, not from the
            // Surface's buffer size: a fixed-size holder and the real view size
            // disagree, and only this tells mpv which one to scale to.
            applySurfaceSize(width, height)
            call.resolve()
        }
    }

    @PluginMethod
    fun detachSurface(call: PluginCall) {
        activity.runOnUiThread {
            videoSuspendedForSurfaceLoss = true
            runOnMpvThread {
                // `attachSurfaces()` takes non-null Surfaces, so the way to stop
                // video without tearing down the player is to disable the video
                // track; removing the view alone would leave mpv drawing into a
                // surface that is no longer on screen.
                try {
                    player?.setProperty("vid", "no")
                } catch (_: Throwable) {
                    // Nothing playing; nothing to undo.
                }
            }
            videoSurface = null
            osdSurface = null
            surfaceView?.let { view ->
                (view.parent as? ViewGroup)?.removeView(view)
            }
            osdSurfaceView?.let { view ->
                (view.parent as? ViewGroup)?.removeView(view)
            }
            surfaceView = null
            osdSurfaceView = null
            // Back to the opaque app backdrop, which is what every non-player
            // screen expects; a transparent WebView there would show the
            // Activity's window background instead of the app's own colour.
            bridge.webView?.setBackgroundColor(OPAQUE_BACKDROP)
            call.resolve()
        }
    }

    private val videoSurfaceCallback = object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
            val surface = holder.surface.takeIf { it.isValid } ?: return
            videoSurface = surface
            videoGeneration.incrementAndGet()
            runOnMpvThread {
                val mpv = player
                if (mpv == null) {
                    // initialize() attaches whatever is pending once it has a
                    // player, so nothing is lost by returning here.
                    return@runOnMpvThread
                }
                attachPlayerSurfaces(mpv)
            }
        }

        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            // Buffer pixels, and only a fallback: the page's rect is the size
            // the video should occupy inside the view, so it wins whenever it
            // has been measured.
            if (lastSurfaceWidth <= 0 || lastSurfaceHeight <= 0) {
                applySurfaceSize(width, height)
            }
        }

        override fun surfaceDestroyed(holder: SurfaceHolder) {
            // SurfaceHolder requires consumers to stop using a surface before
            // destruction returns.
            videoSurface = null
            videoGeneration.incrementAndGet()
            videoSuspendedForSurfaceLoss = true
            runOnMpvThread {
                try {
                    player?.setProperty("vid", "no")
                } catch (_: Throwable) {
                }
            }
        }
    }

    private val osdSurfaceCallback = object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
            osdSurface = holder.surface.takeIf { it.isValid } ?: return
            osdGeneration.incrementAndGet()
            runOnMpvThread {
                player?.let { attachPlayerSurfaces(it) }
            }
        }

        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            // Buffer pixels, not the reference viewport; nothing to apply.
        }

        override fun surfaceDestroyed(holder: SurfaceHolder) {
            osdSurface = null
            osdGeneration.incrementAndGet()
            runOnMpvThread {
                // Rebuild the output without the OSD plane, keeping video.
                player?.let { attachPlayerSurfaces(it) }
            }
        }
    }

    /**
     * Hands the current surfaces to mpv. Must run on the mpv thread.
     *
     * The renderer is passed explicitly rather than left to the AAR default,
     * because VyseTV's equivalent call always names one (`target ?: "mediacodec"`)
     * and the fork's default is not the same as "use whatever `vo` says": it is
     * the plane renderer, which is wrong for a GL session.
     */
    private fun attachPlayerSurfaces(mpv: MpvPlayer) {
        val video = videoSurface?.takeIf { it.isValid } ?: return
        val osd = osdSurface?.takeIf { it.isValid }
        // Matches the `vo` chain configurePlayer set: the hardware path renders
        // onto the video plane, the software path onto the GL vo.
        val renderer = if (hardwareDecoding) "mediacodec" else "gpu"
        try {
            mpv.attachSurfaces(
                video,
                osd,
                videoGeneration.get(),
                osdGeneration.get(),
                renderer,
            )
        } catch (e: Throwable) {
            notifyError("Could not attach the video surface: ${e.message}")
            return
        }
        // A destroyed surface or an earlier detach left this at "no". Only
        // restore when this bridge suspended it: a viewer who chose to turn
        // video off keeps it off.
        if (videoSuspendedForSurfaceLoss) {
            try {
                mpv.setProperty("vid", "auto")
                videoSuspendedForSurfaceLoss = false
            } catch (_: Throwable) {
                // No video track yet; loadfile selects one on its own.
            }
        }
        // The page may have measured the element before the player existed.
        applySurfaceSizeOnMpvThread(mpv)
    }

    /** Tells mpv the size to scale its output to. */
    private fun applySurfaceSize(width: Int, height: Int) {
        if (width <= 0 || height <= 0) return
        lastSurfaceWidth = width
        lastSurfaceHeight = height
        runOnMpvThread {
            player?.let { applySurfaceSizeOnMpvThread(it) }
        }
    }

    private fun applySurfaceSizeOnMpvThread(mpv: MpvPlayer) {
        val width = lastSurfaceWidth
        val height = lastSurfaceHeight
        if (width <= 0 || height <= 0 || width == lastAppliedSurfaceWidth && height == lastAppliedSurfaceHeight) {
            return
        }
        try {
            mpv.setProperty("android-surface-size", "${width}x$height")
            lastAppliedSurfaceWidth = width
            lastAppliedSurfaceHeight = height
        } catch (_: Throwable) {
            // Not fatal: mpv falls back to the Surface's own size.
        }
    }

    private fun updateSurfaceRect(view: SurfaceView, x: Int, y: Int, width: Int, height: Int) {
        val params = view.layoutParams as? ViewGroup.MarginLayoutParams ?: return
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
                // A previous detach may have left the video track off.
                attachPlayerSurfaces(mpv)
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
        val timeMs = call.data.optLong("timeMs", 0L)
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

    /**
     * Subscribes to a property, so its changes arrive as `propertyChange`.
     *
     * libmpv only pushes `MPV_EVENT_PROPERTY_CHANGE` for properties registered
     * with `mpv_observe_property`; a plain property write reports nothing. The
     * web layer used to send `setProperty("observe-<name>")`, which is not an
     * mpv API at all — every observation was silently rejected, so no time,
     * duration or pause state ever reached the UI and the start guard judged a
     * working stream dead after its timeout.
     */
    @PluginMethod
    fun observe(call: PluginCall) {
        val name = call.getString("name")
        if (name.isNullOrBlank()) {
            call.reject("observe needs a name.")
            return
        }
        val format = when (call.getString("format")?.lowercase()) {
            "double" -> PropertyFormat.Double
            "flag" -> PropertyFormat.Flag
            "int64" -> PropertyFormat.Int64
            "string" -> PropertyFormat.String
            else -> PropertyFormat.None
        }
        runOnMpvThread {
            try {
                val mpv = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnMpvThread
                }
                mpv.observeProperty(name, format)
                call.resolve()
            } catch (e: Throwable) {
                call.reject("observe($name) failed: ${e.message}")
            }
        }
    }

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

    private companion object {
        /**
         * The app's own backdrop, matching MainActivity's
         * `webView.setBackgroundColor(...)` and the CSS `--bg`. Kept here so the
         * two cannot drift: detach must restore exactly what the activity set.
         */
        val OPAQUE_BACKDROP = Color.parseColor("#090A0C")

        /**
         * Builtin Lua scripts nothing in the app reaches: the stats overlay, the
         * console, the selection menus, drag-to-pan, the `open` prompt and the
         * context menu answer key bindings and script messages, and the app
         * sends mpv neither. auto-profiles serves conditional profiles from a
         * config file this player never reads.
         */
        val UNUSED_BUILTIN_SCRIPT_OPTIONS = listOf(
            "load-stats-overlay",
            "load-console",
            "load-auto-profiles",
            "load-select",
            "load-positioning",
            "load-commands",
            "load-context-menu",
        )
    }
}
