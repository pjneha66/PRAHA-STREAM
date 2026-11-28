package com.hikari.app.net

import com.praha.stream.download.DownloadHttp
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException

/** Network ABI used by Hikari extensions. */
object Http {
    const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
    private const val MAX_BODY = 8L * 1024 * 1024

    private fun request(url: String, headers: Map<String, String>) = Request.Builder().url(url).header("User-Agent", UA).apply {
        headers.forEach { (key, value) -> if (!key.equals("Host", true)) header(key, value) }
    }

    fun get(url: String, headers: Map<String, String> = emptyMap()): Response =
        DownloadHttp.client.newCall(request(url, headers).build()).execute()

    fun getString(url: String, headers: Map<String, String> = emptyMap()): String? =
        getBytes(url, headers)?.toString(Charsets.UTF_8)

    fun getBytes(url: String, headers: Map<String, String> = emptyMap()): ByteArray? =
        runCatching { get(url, headers).use { if (it.isSuccessful) readBody(it) else null } }.getOrNull()

    fun postString(url: String, body: String, headers: Map<String, String> = emptyMap(), contentType: String = "application/json; charset=utf-8"): String? =
        runCatching {
            DownloadHttp.client.newCall(request(url, headers).post(body.toRequestBody(contentType.toMediaType())).build())
                .execute().use { if (it.isSuccessful) readBody(it).toString(Charsets.UTF_8) else null }
        }.getOrNull()

    internal fun readBody(response: Response): ByteArray {
        if (response.body.contentLength() > MAX_BODY) throw IOException("Extension response exceeds 8 MB")
        val out = ByteArrayOutputStream()
        response.body.byteStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (out.size() + count > MAX_BODY) throw IOException("Extension response exceeds 8 MB")
                out.write(buffer, 0, count)
            }
        }
        return out.toByteArray()
    }
}
