// Voice pack selection and VITS setup adapted from Hikari (GPL-3.0).
package com.praha.stream.dub

import android.content.Context
import android.util.Base64
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.praha.stream.download.DownloadHttp
import okhttp3.Request
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest

object PiperDubVoice {
    private data class Pack(val name: String, val hash: String)
    private val voices = mapOf(
        "en" to Pack("vits-piper-en_US-lessac-medium-int8", "f1c6d0295cf16087b05f80fdca5b44daca5cd78e2c425d419a42ba34929805f9"),
        "hi" to Pack("vits-piper-hi_IN-pratham-medium-int8", "20f568c56207c13b9a0d9478aec8b7d1449122e618aeebc7211f6abc942b58b7"),
    )
    private var loaded: Pair<String, OfflineTts>? = null
    private fun root(context: Context) = File(context.filesDir, "piper_voices")
    private fun model(directory: File): File? = directory.walkTopDown().firstOrNull {
        it.isFile && it.extension == "onnx" && File(it.parentFile, "tokens.txt").isFile &&
            File(it.parentFile, "espeak-ng-data").isDirectory
    }

    @JvmStatic
    fun ready(context: Context, language: String): Boolean =
        voices[language]?.let { model(File(root(context), it.name)) != null } ?: false

    @JvmStatic
    @Synchronized
    fun install(context: Context, language: String): Boolean {
        val pack = voices[language] ?: return false
        if (ready(context, language)) return true
        val root = root(context).apply { mkdirs() }
        val archive = File.createTempFile("voice-", ".tar.bz2", root)
        val staging = File(root, "stage-" + java.util.UUID.randomUUID())
        check(staging.mkdir()) { "Could not prepare voice storage." }
        val destination = File(root, pack.name)
        try {
            val url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${pack.name}.tar.bz2"
            val digest = MessageDigest.getInstance("SHA-256")
            DownloadHttp.client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                check(response.isSuccessful) { "Voice download returned HTTP ${response.code}." }
                response.body.byteStream().use { input ->
                    archive.outputStream().use { output ->
                        val buffer = ByteArray(65536)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count == -1) break
                            total += count
                            if (total > 30 * 1024 * 1024) throw IOException("Voice pack exceeded its size limit.")
                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                        }
                    }
                }
            }
            check(digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == pack.hash) { "Voice pack checksum mismatch." }
            val prefix = staging.canonicalPath + File.separator
            TarArchiveInputStream(BZip2CompressorInputStream(archive.inputStream().buffered())).use { tar ->
                var total = 0L
                while (true) {
                    val entry = tar.nextEntry ?: break
                    val output = File(staging, entry.name)
                    check(output.canonicalPath.startsWith(prefix)) { "Invalid file in voice pack." }
                    if (entry.isDirectory) output.mkdirs()
                    else if (entry.isFile && !entry.isLink && !entry.isSymbolicLink) {
                        total += entry.size
                        check(total < 100 * 1024 * 1024) { "Expanded voice pack exceeded its size limit." }
                        output.parentFile?.mkdirs()
                        output.outputStream().use { tar.copyTo(it) }
                    }
                }
            }
            check(model(staging) != null) { "Voice pack is missing its model or tokenizer." }
            if (destination.exists()) destination.deleteRecursively()
            check(staging.renameTo(destination)) { "Could not install the voice pack." }
            return true
        } finally {
            archive.delete()
            staging.deleteRecursively()
        }
    }

    @JvmStatic
    @Synchronized
    fun synthesize(context: Context, text: String, language: String): String {
        require(text.isNotBlank() && text.length <= 420)
        val pack = voices[language] ?: error("This language has no Piper voice pack.")
        val model = model(File(root(context), pack.name)) ?: error("Install this Piper voice first.")
        val engine = loaded?.takeIf { it.first == language }?.second ?: run {
            loaded?.second?.release()
            loaded = null
            OfflineTts(config = OfflineTtsConfig(model = OfflineTtsModelConfig(
                vits = OfflineTtsVitsModelConfig(
                    model = model.path,
                    tokens = File(model.parentFile, "tokens.txt").path,
                    dataDir = File(model.parentFile, "espeak-ng-data").path,
                ),
                numThreads = 2,
            ))).also { loaded = language to it }
        }
        val file = File.createTempFile("dub-", ".wav", context.cacheDir)
        try {
            val audio = engine.generate(text = text, sid = 0, speed = 1f)
            check(audio.samples.isNotEmpty() && audio.samples.size < 1_000_000 && audio.save(file.path)) { "Piper could not synthesize this cue." }
            return Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        } finally {
            file.delete()
        }
    }
}
