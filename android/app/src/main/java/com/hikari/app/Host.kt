package com.hikari.app

import com.lagradost.cloudstream3.CloudStreamApp

/** The exact host names bundled .hiki adapters resolve at runtime. */
open class MainActivity : com.lagradost.cloudstream3.MainActivity()

open class HikariApp : CloudStreamApp() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: HikariApp
            private set

        @Volatile
        var mainActivity: MainActivity? = null
    }
}
