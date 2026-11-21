package com.praha.stream.torr

import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Capacitor bridge for the bundled TorrServer executable.
 *
 * The Go binary ships in `jniLibs/<abi>/libtorrserver.so`. With
 * `useLegacyPackaging = true` Android extracts it to `nativeLibraryDir` with
 * the executable bit set, so it can be launched directly with `ProcessBuilder`
 * — no shell, no root, no download at runtime.
 *
 * Only the process lifecycle lives here. All ten REST endpoints are called
 * from TypeScript through the existing native HTTP bridge, which also avoids
 * WebView CORS and mixed-content problems against 127.0.0.1.
 */
@CapacitorPlugin(name = "PrahaTorrServer")
class PrahaTorrServerPlugin : Plugin() {

    companion object {
        private const val BINARY_NAME = "libtorrserver.so"
        private const val MIN_BINARY_BYTES = 1024 * 1024
        private val running = AtomicBoolean(false)

        @Volatile
        private var process: Process? = null

        @Volatile
        private var activePort = 0

        @Volatile
        private var activePid = -1

        @Volatile
        private var binaryPath: String? = null

        private val logLines = ArrayDeque<String>()
        private const val MAX_LOG_LINES = 120

        fun isRunning(): Boolean = running.get()
    }

    private val executor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "praha-torrserver").apply { isDaemon = true }
    }

    @PluginMethod
    fun getNativeLibraryDir(call: PluginCall) {
        val result = JSObject()
        result.put("path", context.applicationInfo.nativeLibraryDir)
        call.resolve(result)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        executor.execute {
            try {
                if (running.get()) {
                    val result = JSObject()
                    result.put("port", activePort)
                    result.put("pid", activePid)
                    result.put("alreadyRunning", true)
                    call.resolve(result)
                    return@execute
                }

                val libDir = context.applicationInfo.nativeLibraryDir
                val binary = File(libDir, BINARY_NAME)
                if (!binary.exists() || binary.length() < MIN_BINARY_BYTES) {
                    call.reject("TorrServer binary is missing from $libDir")
                    return@execute
                }
                // Extracted libs are normally 0755 already, but repair the bit
                // defensively — some OEM extractors drop it.
                binary.setExecutable(true, false)
                binary.setReadable(true, false)

                val dataDir = File(context.filesDir, "torrserver_data").apply { mkdirs() }
                val port = call.getInt("port")?.takeIf { it in 1..65535 } ?: findFreePort()
                if (port <= 0) {
                    call.reject("Could not find a free local TCP port for TorrServer")
                    return@execute
                }

                synchronized(logLines) { logLines.clear() }

                val builder = ProcessBuilder(
                    binary.absolutePath,
                    "-p", port.toString(),
                    "-d", dataDir.absolutePath,
                ).redirectErrorStream(true)

                val started = builder.start()
                process = started
                activePort = port
                activePid = processPid(started)
                binaryPath = binary.absolutePath
                running.set(true)

                try {
                    File(dataDir, "torrserver.pid").writeText(activePid.toString())
                } catch (_: Exception) {
                }

                PrahaTorrForegroundService.start(context.applicationContext)

                executor.execute { drainOutput(started) }

                val result = JSObject()
                result.put("port", port)
                result.put("pid", activePid)
                result.put("binaryPath", binary.absolutePath)
                result.put("dataDir", dataDir.absolutePath)
                call.resolve(result)
            } catch (error: Exception) {
                running.set(false)
                process = null
                activePort = 0
                activePid = -1
                call.reject("Could not start TorrServer: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        executor.execute {
            val current = process
            running.set(false)
            process = null
            activePort = 0
            activePid = -1
            try {
                if (current != null) {
                    current.destroy()
                    try {
                        current.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                    }
                    if (current.isAlive) current.destroyForcibly()
                }
            } catch (_: Exception) {
            }
            try {
                PrahaTorrForegroundService.stop(context.applicationContext)
            } catch (_: Exception) {
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val result = JSObject()
        val current = process
        val alive = running.get() && current != null && current.isAlive
        if (!alive) {
            running.set(false)
            process = null
            activePort = 0
            activePid = -1
        }
        result.put("running", alive)
        result.put("port", activePort)
        result.put("pid", activePid)
        result.put("binaryPath", binaryPath)
        val snapshot = synchronized(logLines) { logLines.toList() }
        val logs = org.json.JSONArray()
        snapshot.forEach { logs.put(it) }
        result.put("logs", logs)
        call.resolve(result)
    }

    @PluginMethod
    fun getLogs(call: PluginCall) {
        val snapshot = synchronized(logLines) { logLines.toList() }
        val logs = org.json.JSONArray()
        snapshot.forEach { logs.put(it) }
        val result = JSObject()
        result.put("logs", logs)
        call.resolve(result)
    }

    override fun handleOnDestroy() {
        running.set(false)
        try {
            process?.destroyForcibly()
        } catch (_: Exception) {
        }
        process = null
        executor.shutdownNow()
        super.handleOnDestroy()
    }

    /** `Process.pid()` is API 31+; fall back to "unknown" without failing startup. */
    private fun processPid(started: Process): Int = try {
        val method = started.javaClass.getMethod("pid")
        (method.invoke(started) as Long).toInt()
    } catch (_: Throwable) {
        -1
    }

    private fun findFreePort(): Int = try {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
    } catch (_: Exception) {
        -1
    }

    private fun drainOutput(started: Process) {
        try {
            BufferedReader(InputStreamReader(started.inputStream)).useLines { lines ->
                lines.forEach { line ->
                    synchronized(logLines) {
                        logLines.addLast(line)
                        while (logLines.size > MAX_LOG_LINES) logLines.removeFirst()
                    }
                }
            }
        } catch (_: Exception) {
        }
        // The binary exited on its own: clean up so the UI can offer a restart.
        if (process === started) {
            running.set(false)
            process = null
            activePort = 0
            activePid = -1
            try {
                PrahaTorrForegroundService.stop(context.applicationContext)
            } catch (_: Exception) {
            }
        }
    }
}
