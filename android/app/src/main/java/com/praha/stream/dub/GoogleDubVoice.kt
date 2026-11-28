// Google Translate voice and bounded sentence chunks adapted from Hikari (GPL-3.0).
package com.praha.stream.dub

import android.util.Base64
import com.praha.stream.download.DownloadHttp
import okhttp3.HttpUrl
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException

object GoogleDubVoice {
    @JvmStatic
    fun synthesize(text: String, language: String): String {
        require(text.isNotBlank() && text.length <= 800 && language.matches(Regex("[a-zA-Z-]{2,12}")))
        val output = ByteArrayOutputStream()
        for (line in chunk(text)) {
            val url = HttpUrl.Builder().scheme("https").host("translate.google.com").addPathSegment("translate_tts")
                .addQueryParameter("ie", "UTF-8").addQueryParameter("client", "tw-ob")
                .addQueryParameter("tl", language).addQueryParameter("q", line).build()
            val request = Request.Builder().url(url).header("Referer", "https://translate.google.com/")
                .header("User-Agent", DownloadHttp.USER_AGENT).build()
            DownloadHttp.client.newCall(request).execute().use { response ->
                val type = response.body.contentType()
                if (!response.isSuccessful || type?.type != "audio") throw IOException("Google voice returned HTTP ${response.code}.")
                val buffer = ByteArray(8192)
                response.body.byteStream().use { stream ->
                    while (true) {
                        val count = stream.read(buffer)
                        if (count == -1) break
                        if (output.size() + count > 512 * 1024) throw IOException("Google voice clip is too large.")
                        output.write(buffer, 0, count)
                    }
                }
            }
        }
        return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }

    private fun chunk(text: String): List<String> {
        val parts = mutableListOf<String>()
        var tail = text.trim()
        while (tail.length > 180) {
            val window = tail.take(180)
            val boundary = window.lastIndexOfAny(charArrayOf('.', '!', '?', '。', '！', '？', '।', ',', ' ')) + 1
            val end = if (boundary >= 60) boundary else if (Character.isHighSurrogate(window.last())) 179 else 180
            parts += tail.take(end).trim()
            tail = tail.drop(end).trimStart()
        }
        if (tail.isNotEmpty()) parts += tail
        return parts.filter { it.isNotEmpty() }
    }
}
