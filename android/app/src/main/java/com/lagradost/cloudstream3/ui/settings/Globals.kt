package com.lagradost.cloudstream3.ui.settings

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.content.res.Resources

/**
 * The official app's layout flags (ui/settings/Globals.kt): extensions check TV vs
 * phone with `isLayout(Globals.TV)`. PRAHA is a phone/tablet app with a big-screen
 * layout, so the flag comes from the device, not a setting — same detection the
 * app already uses to pick its TV layout.
 */
object Globals {
    const val PHONE: Int = 0b00001
    const val TV: Int = 0b00010
    const val EMULATOR: Int = 0b00100

    fun isLayout(flags: Int): Boolean = ((if (isTv) TV else PHONE) and flags) != 0

    fun isLandscape(): Boolean = isLayout(TV or EMULATOR) ||
        Resources.getSystem().configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

    /** Same test PRAHA's MainActivity uses for its TV layout. */
    private val isTv: Boolean by lazy {
        val ctx = com.lagradost.cloudstream3.CloudStreamApp.context ?: return@lazy false
        val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            !ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    }
}
