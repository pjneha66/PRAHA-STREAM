// Adapted from Hikari (Copyright (C) 2026 Codegeasse), GPL-3.0.
package com.praha.stream.download

enum class DownloadKind { OFFLINE, EXPORT }

data class DownloadTask(
    val title: String,
    val url: String,
    val headers: Map<String, String>,
    val kind: DownloadKind,
    val preferredHeight: Int,
    val preferredAudio: String,
    val isM3u8: Boolean,
    val resumePartial: Boolean = false,
    val preferredBandwidth: Long = 0L,
) {
    fun titleFolder(): String = sanitizeFile(title).ifBlank { "praha-video" }
    fun episodeStem(): String = titleFolder()
}
/** Strips path-hostile characters out of a user-facing title. */
fun sanitizeFile(name: String): String =
    name.replace(Regex("[\\\\/:*?\"<>|\\p{Cc}]"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
        .take(80)
