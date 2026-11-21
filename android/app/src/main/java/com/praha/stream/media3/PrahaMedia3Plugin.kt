package com.praha.stream.media3

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cronet.CronetDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.chromium.net.CronetEngine
import java.util.concurrent.Executors

/**
 * Capacitor bridge for Media3 / ExoPlayer.
 *
 * This is the second playback engine. mpv is the default because it decodes
 * everything (DTS, TrueHD, Dolby Vision) and renders ASS subtitles with libass.
 * Media3 is the fallback for the cases where the platform decoder is the better
 * citizen: hardware decoding on low-end phones, and the tunnels some TVs want.
 *
 * It is deliberately NOT a port of VyseTV's `ExoPlayerCore.kt` (4,662 lines).
 * That file imports `com.vyse.libass.*` for its ASS pipeline and a Flutter
 * overlay helper, neither of which exists here, and this host cannot compile
 * native code (see docs/NATIVE-BUILD-CONSTRAINTS.md). What is kept is the part
 * that matters for compatibility: Cronet for the header-protected CDNs, the
 * track-override plumbing, and a generous load control for torrent read-ahead.
 *
 * Subtitle rendering uses Media3's own `SubtitleView`, so SRT/VTT and plain SSA
 * render fine but ASS positioning and typesetting do not. That is acceptable
 * because mpv is the default engine and handles ASS properly; Media3 is the
 * fallback.
 */
@UnstableApi
@CapacitorPlugin(name = "PrahaMedia3")
class PrahaMedia3Plugin : Plugin() {

    private var player: ExoPlayer? = null
    private var surfaceView: SurfaceView? = null
    private var subtitleView: SubtitleView? = null
    private var cronetEngine: CronetEngine? = null

    /** Cronet does its own threading; one small executor keeps callbacks off the UI thread. */
    private val cronetExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "praha-cronet").apply { isDaemon = true }
    }

    private var pendingSeekMs: Long? = null
    private var pendingPlayWhenReady = true
    private var lastCues: CueGroup? = null

    // ── Lifecycle ──────────────────────────────────────────────────────────

    @PluginMethod
    fun initialize(call: PluginCall) {
        activity.runOnUiThread {
            try {
                if (player == null) {
                    player = buildPlayer(context)
                }
                call.resolve(JSObject().put("initialized", player != null))
            } catch (e: Throwable) {
                call.reject("Could not initialise Media3: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun destroy(call: PluginCall) {
        activity.runOnUiThread {
            releasePlayer()
            call.resolve()
        }
    }

    private fun buildPlayer(context: Context): ExoPlayer {
        // Cronet is what lets Media3 send the per-stream headers the scrapers
        // need (Referer, Origin, Cookie). The platform HttpURLConnection path
        // works too but silently drops some of them on redirect, which is the
        // exact failure mode that makes a working scraper look dead.
        val httpFactory = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
            .setUserAgent(DEFAULT_UA)

        val cronet = try {
            CronetEngine.Builder(context)
                .enableQuic(true)
                .enableHttp2(true)
                .build()
                .also { cronetEngine = it }
        } catch (e: Throwable) {
            // Embedded Cronet can fail to load on a stripped ROM. Falling back to
            // the platform HTTP stack is much better than refusing to play.
            null
        }

        val cronetFactory = cronet?.let {
            CronetDataSource.Factory(it, cronetExecutor)
                .setConnectionTimeoutMs(15_000)
                .setReadTimeoutMs(20_000)
        }

        val baseFactory = DefaultDataSource.Factory(
            context,
            (cronetFactory ?: httpFactory) as androidx.media3.datasource.DataSource.Factory,
        )

        val renderers = DefaultRenderersFactory(context)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)

        // Torrent streaming is read-ahead heavy: the next chunk can take a
        // second to arrive, so a short buffer starves and stalls. These are the
        // same numbers VyseTV settled on for the same reason.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                20_000,   // min buffer to start
                120_000,  // max buffer
                2_500,    // buffer for playback to continue after a rebuffer
                5_000,    // buffer for playback to start after a seek
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        val exo = ExoPlayer.Builder(context, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(baseFactory))
            .setLoadControl(loadControl)
            .build()

        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                val name = when (state) {
                    Player.STATE_IDLE -> "idle"
                    Player.STATE_BUFFERING -> "buffering"
                    Player.STATE_READY -> "ready"
                    Player.STATE_ENDED -> "ended"
                    else -> "unknown"
                }
                notifyListeners("playbackState", JSObject().put("state", name))
                if (state == Player.STATE_READY) {
                    pendingSeekMs?.let { target ->
                        pendingSeekMs = null
                        exo.seekTo(target)
                    }
                }
                if (state == Player.STATE_ENDED) {
                    notifyListeners("ended", JSObject().put("ended", true))
                }
                emitProgress()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                notifyListeners("playing", JSObject().put("playing", isPlaying))
            }

            override fun onPlayerError(error: PlaybackException) {
                notifyListeners(
                    "error",
                    JSObject()
                        .put("message", error.message ?: "Playback failed")
                        .put("code", error.errorCodeName),
                )
            }

            override fun onTracksChanged(tracks: Tracks) {
                notifyListeners("tracksChanged", JSObject().put("tracks", describeTracks(tracks)))
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                notifyListeners(
                    "videoSize",
                    JSObject()
                        .put("width", videoSize.width)
                        .put("height", videoSize.height)
                        .put("pixelRatio", videoSize.pixelWidthHeightRatio.toDouble()),
                )
            }

            override fun onCues(cueGroup: CueGroup) {
                // Forwarded so the JS side can render subtitles in the DOM when
                // the native SubtitleView is not being used (picture-in-picture).
                lastCues = cueGroup
                subtitleView?.setCues(cueGroup.cues)
                val text = cueGroup.cues.joinToString("\n") { it.text?.toString() ?: "" }
                notifyListeners("cues", JSObject().put("text", text))
            }
        })

        return exo
    }

    private fun releasePlayer() {
        try {
            player?.release()
        } catch (_: Throwable) {
            // Already released.
        }
        player = null
        try {
            cronetEngine?.shutdown()
        } catch (_: Throwable) {
        }
        cronetEngine = null
        removeOverlayViews()
    }

    // ── Surface ────────────────────────────────────────────────────────────

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

                if (surfaceView == null) {
                    val surface = SurfaceView(context)
                    parent.addView(surface, 0, FrameLayout.LayoutParams(width, height))
                    surfaceView = surface

                    // Subtitles are a sibling above the surface but below the
                    // WebView, so the page's own controls stay clickable.
                    val subs = SubtitleView(context)
                    subs.setStyle(
                        CaptionStyleCompat(
                            Color.WHITE,
                            Color.TRANSPARENT,
                            Color.TRANSPARENT,
                            CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                            Color.BLACK,
                            null,
                        ),
                    )
                    subs.setFractionalTextSize(1f)
                    subs.setBottomPaddingFraction(0.08f)
                    val subParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    subParams.gravity = Gravity.CENTER
                    parent.addView(subs, 1, subParams)
                    subtitleView = subs
                }

                surfaceView?.let { updateSurfaceRect(it, x, y, width, height) }
                subtitleView?.let { updateSurfaceRect(it, x, y, width, height) }
                bindSurface()
                call.resolve(JSObject().put("attached", true))
            } catch (e: Throwable) {
                call.reject("Could not attach the video surface: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun setSurfaceRect(call: PluginCall) {
        val x = call.getInt("x") ?: 0
        val y = call.getInt("y") ?: 0
        val width = call.getInt("width") ?: 0
        val height = call.getInt("height") ?: 0

        activity.runOnUiThread {
            val surface = surfaceView
            if (surface == null) {
                call.reject("No surface attached.")
                return@runOnUiThread
            }
            updateSurfaceRect(surface, x, y, width, height)
            subtitleView?.let { updateSurfaceRect(it, x, y, width, height) }
            call.resolve()
        }
    }

    @PluginMethod
    fun detachSurface(call: PluginCall) {
        activity.runOnUiThread {
            try {
                player?.clearVideoSurface()
            } catch (_: Throwable) {
            }
            removeOverlayViews()
            call.resolve()
        }
    }

    private fun updateSurfaceRect(view: android.view.View, x: Int, y: Int, width: Int, height: Int) {
        val params = view.layoutParams as? FrameLayout.LayoutParams
            ?: FrameLayout.LayoutParams(width, height)
        params.width = width
        params.height = height
        params.leftMargin = x
        params.topMargin = y
        view.layoutParams = params
        view.requestLayout()
    }

    private fun bindSurface() {
        val exo = player ?: return
        val surface = surfaceView ?: return
        exo.setVideoSurfaceView(surface)
    }

    private fun removeOverlayViews() {
        surfaceView?.let { view -> (view.parent as? ViewGroup)?.removeView(view) }
        subtitleView?.let { view -> (view.parent as? ViewGroup)?.removeView(view) }
        surfaceView = null
        subtitleView = null
    }

    // ── Loading ────────────────────────────────────────────────────────────

    @PluginMethod
    fun load(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("load needs a url.")
            return
        }
        val headers = call.getObject("headers")
        val startMs = call.getLong("startMs") ?: 0L
        val autoPlay = call.getBoolean("autoPlay") ?: true
        val isLive = call.getBoolean("isLive") ?: false
        val mimeType = call.getString("mimeType")

        activity.runOnUiThread {
            try {
                val exo = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnUiThread
                }

                // Media3 reads headers off the MediaItem, not the player, so the
                // data source factory has to be rebuilt per item to keep them.
                val httpFactory = DefaultHttpDataSource.Factory()
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15_000)
                    .setReadTimeoutMs(20_000)
                    .setUserAgent(DEFAULT_UA)

                headers?.let { obj ->
                    val map = HashMap<String, String>()
                    obj.keys().forEach { key ->
                        map[key] = obj.optString(key, "")
                    }
                    if (map.isNotEmpty()) {
                        httpFactory.setDefaultRequestProperties(map)
                    }
                }

                val cronetFactory = cronetEngine?.let {
                    CronetDataSource.Factory(it, cronetExecutor)
                        .setConnectionTimeoutMs(15_000)
                        .setReadTimeoutMs(20_000)
                }
                val chosen: androidx.media3.datasource.DataSource.Factory =
                    (cronetFactory ?: httpFactory)
                val dataSource = DefaultDataSource.Factory(context, chosen)

                val builder = MediaItem.Builder().setUri(url)
                resolveMimeType(mimeType, url)?.let { builder.setMimeType(it) }

                // The headers live on the data source, so the source has to be
                // rebuilt for each item. setMediaSourceFactory only exists on the
                // Builder, hence constructing the source directly here from the
                // real item — an empty MediaItem would play nothing.
                val source = DefaultMediaSourceFactory(dataSource)
                    .createMediaSource(builder.build())
                exo.setMediaSource(source)
                exo.playWhenReady = autoPlay

                pendingPlayWhenReady = autoPlay
                pendingSeekMs = if (startMs > 0) startMs else null

                if (isLive) {
                    // Live wants to sit at the edge and never buffer far behind.
                    exo.setSeekParameters(androidx.media3.exoplayer.SeekParameters.CLOSEST_SYNC)
                }

                exo.prepare()
                bindSurface()
                call.resolve()
            } catch (e: Throwable) {
                call.reject("Media3 could not load the stream: ${e.message}")
            }
        }
    }

    /**
     * Media3 sniffs the container from the URL extension, which fails for the
     * query-string streams the scrapers hand back. Passing the type explicitly
     * avoids a pointless probe request.
     */
    private fun resolveMimeType(hint: String?, url: String): String? {
        val lower = hint?.lowercase() ?: ""
        if (lower.isNotEmpty()) {
            return when (lower) {
                "hls", "m3u8", "application/x-mpegurl", "application/vnd.apple.mpegurl" ->
                    MimeTypes.APPLICATION_M3U8
                "dash", "mpd", "application/dash+xml" -> MimeTypes.APPLICATION_MPD
                "mp4", "video/mp4" -> MimeTypes.VIDEO_MP4
                "mkv", "video/x-matroska" -> MimeTypes.VIDEO_MATROSKA
                "webm", "video/webm" -> MimeTypes.VIDEO_WEBM
                "ts", "mpegts", "video/mp2t" -> MimeTypes.VIDEO_MP2T
                else -> null
            }
        }
        val path = url.substringBefore('?').lowercase()
        return when {
            path.endsWith(".m3u8") -> MimeTypes.APPLICATION_M3U8
            path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
            path.endsWith(".mkv") -> MimeTypes.VIDEO_MATROSKA
            path.endsWith(".webm") -> MimeTypes.VIDEO_WEBM
            path.endsWith(".ts") -> MimeTypes.VIDEO_MP2T
            path.endsWith(".mp4") -> MimeTypes.VIDEO_MP4
            else -> null
        }
    }

    // ── Transport ──────────────────────────────────────────────────────────

    @PluginMethod
    fun play(call: PluginCall) {
        activity.runOnUiThread {
            player?.playWhenReady = true
            call.resolve()
        }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        activity.runOnUiThread {
            player?.playWhenReady = false
            call.resolve()
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity.runOnUiThread {
            player?.stop()
            call.resolve()
        }
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val timeMs = call.getLong("timeMs") ?: 0L
        val absolute = call.getBoolean("absolute") ?: true
        activity.runOnUiThread {
            val exo = player ?: run {
                call.reject("Call initialize first.")
                return@runOnUiThread
            }
            if (absolute) {
                if (exo.playbackState == Player.STATE_IDLE) pendingSeekMs = timeMs
                else exo.seekTo(timeMs)
            } else {
                exo.seekTo((exo.currentPosition + timeMs).coerceAtLeast(0))
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val volume = call.getInt("volume") ?: 100
        activity.runOnUiThread {
            // Media3 takes 0..1, the UI works in 0..100 (and allows up to 130).
            player?.volume = (volume.coerceIn(0, 130) / 100f).coerceAtMost(1f)
            call.resolve()
        }
    }

    @PluginMethod
    fun setRate(call: PluginCall) {
        val rate = call.getDouble("rate") ?: 1.0
        activity.runOnUiThread {
            player?.setPlaybackSpeed(rate.toFloat().coerceIn(0.25f, 4f))
            call.resolve()
        }
    }

    @PluginMethod
    fun setMute(call: PluginCall) {
        val muted = call.getBoolean("muted") ?: false
        activity.runOnUiThread {
            player?.volume = if (muted) 0f else 1f
            call.resolve()
        }
    }

    // ── Tracks ─────────────────────────────────────────────────────────────

    @PluginMethod
    fun getTracks(call: PluginCall) {
        activity.runOnUiThread {
            val exo = player ?: run {
                call.reject("Call initialize first.")
                return@runOnUiThread
            }
            try {
                call.resolve(JSObject().put("tracks", describeTracks(exo.currentTracks)))
            } catch (e: Throwable) {
                call.reject("Could not read tracks: ${e.message}")
            }
        }
    }

    private fun describeTracks(tracks: Tracks): JSArray {
        val array = JSArray()
        var index = 0
        for (group in tracks.groups) {
            val type = when (group.type) {
                C.TRACK_TYPE_AUDIO -> "audio"
                C.TRACK_TYPE_TEXT -> "sub"
                C.TRACK_TYPE_VIDEO -> "video"
                else -> "other"
            }
            for (i in 0 until group.length) {
                val format = group.getTrackFormat(i)
                array.put(
                    JSObject()
                        .put("id", index)
                        .put("type", type)
                        .put("title", format.label ?: "")
                        .put("lang", format.language ?: "")
                        .put("codec", format.sampleMimeType ?: "")
                        .put("selected", group.isTrackSelected(i))
                        .put("external", format.id?.startsWith("external") ?: false),
                )
                index++
            }
        }
        return array
    }

    @PluginMethod
    fun selectTrack(call: PluginCall) {
        val type = call.getString("type") ?: "audio"
        val id = call.getInt("id") ?: -1

        activity.runOnUiThread {
            val exo = player ?: run {
                call.reject("Call initialize first.")
                return@runOnUiThread
            }
            try {
                val trackType = when (type) {
                    "audio" -> C.TRACK_TYPE_AUDIO
                    "sub" -> C.TRACK_TYPE_TEXT
                    "video" -> C.TRACK_TYPE_VIDEO
                    else -> C.TRACK_TYPE_AUDIO
                }

                val builder = exo.trackSelectionParameters.buildUpon()
                if (id < 0) {
                    // -1 means "off" for subtitles and "auto" for audio/video.
                    if (trackType == C.TRACK_TYPE_TEXT) {
                        builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    } else {
                        builder.clearOverridesOfType(trackType)
                    }
                } else {
                    val target = findTrackGroup(exo.currentTracks, trackType, id)
                    if (target == null) {
                        call.reject("No $type track with id $id.")
                        return@runOnUiThread
                    }
                    builder.setTrackTypeDisabled(trackType, false)
                    builder.setOverrideForType(TrackSelectionOverride(target.group.mediaTrackGroup, target.indexInGroup))
                }
                exo.trackSelectionParameters = builder.build()
                call.resolve()
            } catch (e: Throwable) {
                call.reject("Could not select the $type track: ${e.message}")
            }
        }
    }

    private data class LocatedTrack(
        val group: androidx.media3.common.Tracks.Group,
        val indexInGroup: Int,
    )

    /**
     * The JS side sees one flat list, so an id has to be mapped back to the
     * (group, index) pair Media3's override API wants.
     */
    private fun findTrackGroup(tracks: Tracks, trackType: Int, flatId: Int): LocatedTrack? {
        var index = 0
        for (group in tracks.groups) {
            if (group.type != trackType) {
                // Still count these: ids are global across every track type.
                index += group.length
                continue
            }
            for (i in 0 until group.length) {
                if (index == flatId) return LocatedTrack(group, i)
                index++
            }
        }
        return null
    }

    @PluginMethod
    fun addSubtitle(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("addSubtitle needs a url.")
            return
        }
        activity.runOnUiThread {
            try {
                val exo = player ?: run {
                    call.reject("Call initialize first.")
                    return@runOnUiThread
                }
                val current = exo.currentMediaItem ?: run {
                    call.reject("No media loaded.")
                    return@runOnUiThread
                }

                val subConfig = MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(url))
                    .setMimeType(subtitleMimeType(url))
                    .setLanguage("und")
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build()

                // Replacing the item restarts playback, so carry the position
                // across — losing the user's place when they pick a subtitle is
                // a bug, not an acceptable cost.
                val position = exo.currentPosition
                val wasPlaying = exo.playWhenReady

                val rebuilt = current.buildUpon().setSubtitleConfigurations(listOf(subConfig)).build()
                exo.setMediaItem(rebuilt, position)
                exo.playWhenReady = wasPlaying
                exo.prepare()
                call.resolve()
            } catch (e: Throwable) {
                call.reject("Could not add the subtitle: ${e.message}")
            }
        }
    }

    private fun subtitleMimeType(url: String): String {
        val path = url.substringBefore('?').lowercase()
        return when {
            path.endsWith(".srt") -> MimeTypes.APPLICATION_SUBRIP
            path.endsWith(".vtt") -> MimeTypes.TEXT_VTT
            path.endsWith(".ssa") || path.endsWith(".ass") -> MimeTypes.TEXT_SSA
            else -> MimeTypes.APPLICATION_SUBRIP
        }
    }

    // ── Stats ──────────────────────────────────────────────────────────────

    @PluginMethod
    fun getStats(call: PluginCall) {
        activity.runOnUiThread {
            val exo = player ?: run {
                call.reject("Call initialize first.")
                return@runOnUiThread
            }
            val stats = JSObject()
                .put("positionMs", exo.currentPosition)
                .put("durationMs", if (exo.duration > 0) exo.duration else 0)
                .put("bufferedMs", exo.bufferedPosition)
                .put("bitrate", exo.currentTracks.groups.sumOf { group ->
                    if (group.type == C.TRACK_TYPE_VIDEO && group.length > 0) {
                        group.getTrackFormat(0).bitrate
                    } else 0
                })
                .put("droppedFrames", exo.videoDecoderCounters?.droppedBufferCount ?: 0)
                .put("isLive", exo.isCurrentMediaItemLive)
                .put("paused", !exo.playWhenReady)
            call.resolve(stats)
        }
    }

    private fun emitProgress() {
        val exo = player ?: return
        notifyListeners(
            "progress",
            JSObject()
                .put("positionMs", exo.currentPosition)
                .put("durationMs", if (exo.duration > 0) exo.duration else 0)
                .put("bufferedMs", exo.bufferedPosition),
        )
    }

    override fun handleOnPause() {
        // A backgrounded activity must not keep decoding; Android kills the
        // process rather than let that happen, and the WebView keeps the
        // position anyway so resuming is cheap.
        activity.runOnUiThread {
            if (player?.playWhenReady == true) {
                player?.pause()
                notifyListeners("pausedForBackground", JSObject().put("paused", true))
            }
        }
    }

    override fun handleOnDestroy() {
        releasePlayer()
        cronetExecutor.shutdownNow()
    }

    private companion object {
        /** Desktop Chrome UA; some CDNs 403 on a WebView UA. */
        const val DEFAULT_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    }
}
