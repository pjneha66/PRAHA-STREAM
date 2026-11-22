package com.praha.stream.cloudstream

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import com.lagradost.cloudstream3.CommonActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * App-wide state for the CloudStream host: the context extensions receive, device
 * shape, and the knobs PRAHA's own UI sets over the bridge.
 *
 * This is the counterpart of stream-goat's `io.github.sherazi5110.cloudstream.App`,
 * minus the parts that belong to that app (themes, profiles, Stremio add-ons,
 * downloads, crash reporting).
 */
object CsApp {
    @Volatile
    var context: Context? = null
        private set

    /** Work that outlives a screen: loading extensions, installs. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun init(context: Context) {
        this.context = context.applicationContext
        com.lagradost.cloudstream3.CloudStreamApp.context = this.context
    }

    /** Android TV (remote) or phone/tablet (touch). Read once. */
    val isTv: Boolean by lazy {
        val ctx = context ?: return@lazy false
        val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            !ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    }

    /** A network with internet access is connected (asked only after something failed to load). */
    fun online(): Boolean = runCatching {
        val ctx = context ?: return true
        val cm = ctx.getSystemService(android.net.ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }.getOrDefault(true)

    /** Shows a short message from anywhere, like extensions do. */
    fun toast(message: String) {
        CommonActivity.showToast(message)
    }
}

/**
 * The handful of user settings the extension engine reads. stream-goat stores these in
 * its own preference screens; PRAHA's CloudStream tab writes them over the bridge, so
 * they live in the same SharedPreferences file the rest of the host uses.
 */
object CsSettings {
    private const val PREFS = "cloudstream_host"

    private val prefs get() = CsApp.context?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** How long one extension may search for sources, in seconds. */
    var sourcesTimeoutSeconds: Int
        get() = prefs?.getInt("sources_timeout_seconds", 45) ?: 45
        set(value) { prefs?.edit()?.putInt("sources_timeout_seconds", value.coerceIn(10, 300))?.apply() }

    /** Preferred quality ceiling in the library's [com.lagradost.cloudstream3.utils.Qualities] scale; 0 = no preference. */
    var preferredQuality: Int
        get() = prefs?.getInt("preferred_quality", 0) ?: 0
        set(value) { prefs?.edit()?.putInt("preferred_quality", value)?.apply() }

    /** Comma-separated audio languages, as the official app's Player setting. */
    var audioLanguage: String
        get() = prefs?.getString("audio_language", "") ?: ""
        set(value) { prefs?.edit()?.putString("audio_language", value)?.apply() }

    /** Start finding an episode's sources when its page opens. */
    var prepareSources: Boolean
        get() = prefs?.getBoolean("prepare_sources", true) ?: true
        set(value) { prefs?.edit()?.putBoolean("prepare_sources", value)?.apply() }

    /** Adult extensions and titles, mirroring PRAHA's `nsfw` setting. */
    var allowAdult: Boolean
        get() = prefs?.getBoolean("allow_adult", false) ?: false
        set(value) { prefs?.edit()?.putBoolean("allow_adult", value)?.apply() }
}
