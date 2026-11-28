package com.praha.stream

import com.hikari.app.HikariApp
import com.praha.stream.cloudstream.CsApp
import com.praha.stream.cloudstream.CsPluginManager
import kotlinx.coroutines.launch

/**
 * PRAHA's application class.
 *
 * It extends the CloudStream application shim rather than reimplementing it, so
 * extensions that read `CloudStreamApp.context` / `getKey` find a real
 * Application instance, and `com.lagradost.api.setContext` (which the CloudStream
 * library's Android code uses) is initialised the same way the official app does.
 *
 * On top of that it gives PRAHA's CloudStream host its context and loads whatever
 * extensions are already installed, off the main thread, so the first search does
 * not have to pay for it.
 */
class PrahaApplication : HikariApp() {
    override fun onCreate() {
        super.onCreate()
        CsApp.init(this)

        // Installed extensions are loaded once per process. Their `load()` registers
        // providers, extractors and video actions — exactly what the first
        // home/search call needs — so doing it here keeps the UI responsive instead
        // of stalling the first request.
        CsApp.scope.launch {
            runCatching { CsPluginManager.loadAll() }
        }
    }
}
