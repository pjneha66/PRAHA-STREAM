// Replaces the buildkonfig-generated object upstream uses. Upstream generates these
// from local.properties at build time; they are API keys for MyAnimeList and Trakt,
// and PRAHA ships neither integration, so both are the literal string "null" as
// upstream's own default is.
package com.lagradost.api

object BuildConfig {
    val MDL_API_KEY: String = "null"
    val TRAKT_CLIENT_ID: String = "null"
}
