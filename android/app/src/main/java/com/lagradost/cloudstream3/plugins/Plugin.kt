package com.lagradost.cloudstream3.plugins

import android.content.Context
import android.content.res.Resources
import com.lagradost.cloudstream3.actions.VideoClickAction
import com.lagradost.cloudstream3.actions.VideoClickActionHolder

/**
 * Same shape as app/src/main/java/com/lagradost/cloudstream3/plugins/Plugin.kt
 * upstream. The library supplies [BasePlugin]; this adds what only the app
 * module has: a `load(context)` overload and the extension's own resources.
 */
abstract class Plugin : BasePlugin() {
    @Throws(Throwable::class)
    open fun load(context: Context) {
        load()
    }

    /** Registers an extension's own video action, like the official app (M6+, RMC+, TF1+, StreamCenter). */
    fun registerVideoClickAction(element: VideoClickAction) {
        element.sourcePlugin = this.filename
        VideoClickActionHolder.allVideoClickActions.add(element)
    }

    var resources: Resources? = null

    /** Settings screens of extensions (Android fragments); PRAHA does not host them yet. */
    var openSettings: ((context: Context) -> Unit)? = null
}
