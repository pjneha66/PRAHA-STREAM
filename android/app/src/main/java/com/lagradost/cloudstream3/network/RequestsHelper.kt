package com.lagradost.cloudstream3.network

import com.lagradost.cloudstream3.USER_AGENT
import okhttp3.Headers
import okhttp3.Headers.Companion.toHeaders

/**
 * From the official app's network/RequestsHelper.kt (used by CloudflareKiller and
 * some extensions). Set headers > set cookies > default headers.
 */
private val DEFAULT_HEADERS = mapOf("user-agent" to USER_AGENT)

fun getHeaders(headers: Map<String, String>, cookie: Map<String, String>): Headers {
    val cookieMap = if (cookie.isNotEmpty()) mapOf("Cookie" to cookie.entries.joinToString(" ") { "${it.key}=${it.value};" }) else mapOf()
    return (DEFAULT_HEADERS + headers + cookieMap).toHeaders()
}
