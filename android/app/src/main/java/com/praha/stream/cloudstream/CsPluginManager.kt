package com.praha.stream.cloudstream

import android.content.res.AssetManager
import android.content.res.Resources
import android.util.Log
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.module.kotlin.readValue
import com.lagradost.cloudstream3.APIHolder
import com.lagradost.cloudstream3.MainAPI
import com.lagradost.cloudstream3.mapper
import com.lagradost.cloudstream3.plugins.BasePlugin
import com.lagradost.cloudstream3.plugins.Plugin
import com.lagradost.cloudstream3.utils.extractorApis
import dalvik.system.PathClassLoader
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Installed-extension record. Same fields as upstream PluginData, plus the repository
 * it came from so an update can find it again.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class CsPluginData(
    val internalName: String,
    val url: String?,
    val isOnline: Boolean,
    val filePath: String,
    val version: Int,
    val repositoryUrl: String? = null,
    val name: String? = null,
)

class CsLoadedPlugin(
    val data: CsPluginData,
    val manifest: BasePlugin.Manifest,
    val instance: BasePlugin,
    val loader: ClassLoader,
) {
    val providers: List<MainAPI> get() = CsEngine.loadedExtensions().filter { it.sourcePlugin == instance.filename }
    val extractorCount: Int get() = extractorApis.count { it.sourcePlugin == instance.filename }
}

data class CsLoadProgress(val done: Int, val total: Int) {
    val running: Boolean get() = done < total
}

/**
 * Port of upstream PluginManager (app/.../plugins/PluginManager.kt). A .cs3 is a zip
 * holding `manifest.json` and a Dalvik `classes.dex`; it is loaded natively with its own
 * class loader whose parent is the app, so the extension links against this app's copy
 * of the CloudStream library rather than shipping one.
 */
object CsPluginManager {
    private const val PLUGINS_KEY = "PLUGINS_KEY"

    private val prefs get() = CsApp.context!!.getSharedPreferences("cloudstream_host", 0)

    val loaded = ConcurrentHashMap<String, CsLoadedPlugin>()
    val failures = ConcurrentHashMap<String, Throwable>()

    private val _progress = MutableStateFlow(CsLoadProgress(0, 0))
    val progress: StateFlow<CsLoadProgress> = _progress

    /** Bumped whenever the set of providers changes, so the UI can refresh. */
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version

    private fun changed() {
        _version.value++
    }

    /** For the bridge to signal a change from outside (install, uninstall). */
    fun bumpVersion() = changed()

    /**
     * Loading (class verification, each extension's setup) is CPU work: as many at once
     * as the device has cores, at low priority, so the screen stays responsive on TV boxes.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val loading = CsEngine.dispatcher.limitedParallelism(Runtime.getRuntime().availableProcessors().coerceIn(2, 4))

    /** Below the screen's threads; Android 10+ keeps such threads in the foreground group, older ones get 5. */
    private val LOAD_PRIORITY = if (android.os.Build.VERSION.SDK_INT >= 29) android.os.Process.THREAD_PRIORITY_BACKGROUND else 5

    /** register* calls in Plugin.load mutate global lists; translation and class loading stay parallel. */
    private val registerLock = Any()

    fun installed(): List<CsPluginData> =
        prefs.getString(PLUGINS_KEY, null)?.let { mapper.readValue<List<CsPluginData>>(it) } ?: emptyList()

    private fun saveInstalled(list: List<CsPluginData>) = synchronized(this) {
        prefs.edit().putString(PLUGINS_KEY, mapper.writeValueAsString(list)).apply()
    }

    private fun record(data: CsPluginData) = synchronized(this) {
        saveInstalled(installed().filter { it.internalName != data.internalName } + data)
    }

    private suspend fun loadOne(data: CsPluginData) = withContext(loading) {
        runCatching { android.os.Process.setThreadPriority(LOAD_PRIORITY) }
        try {
            val file = File(data.filePath)
            if (file.exists()) loadPlugin(file, data)
            else {
                // A restored backup lists extensions without their files: download each again.
                runCatching { redownload(data) }
                    .onSuccess { (f, d) -> failures.remove(data.internalName); loadPlugin(f, d) }
                    .onFailure {
                        failures[data.internalName] = IllegalStateException(
                            "Its file is missing and couldn't be downloaded again (${it.message ?: it}). Tap Reinstall."
                        )
                    }
            }
        } finally {
            runCatching { android.os.Process.setThreadPriority(CsEngine.EXTENSION_PRIORITY) }
        }
        _progress.value = _progress.value.let { it.copy(done = it.done + 1) }
    }

    /**
     * The file of an installed extension that isn't on this device (a restored backup):
     * from the address it was installed from, else from its repository's current list.
     */
    private suspend fun redownload(data: CsPluginData): Pair<File, CsPluginData> {
        val own = File(data.filePath).takeIf { it.absolutePath.startsWith(CsRepositoryManager.extensionsDir.absolutePath) }
        val target = own ?: CsRepositoryManager.pluginPath(data.internalName, data.repositoryUrl ?: "restored", "cs3")
        val direct = data.url?.let { url -> runCatching { CsRepositoryManager.download(url, target, null) } }
        if (direct?.isSuccess == true) {
            val moved = data.copy(filePath = target.absolutePath)
            if (moved != data) record(moved)
            return target to moved
        }
        // The address changed (a new version): find it in the repository again.
        val repo = CsRepositoryManager.getRepositories().firstOrNull { it.url == data.repositoryUrl }
            ?: throw (direct?.exceptionOrNull() ?: IllegalStateException("no download address"))
        val w = CsRepositoryManager.getRepoPlugins(repo)?.firstOrNull { it.plugin.internalName == data.internalName }
            ?: throw IllegalStateException("${repo.name} no longer lists it")
        val file = CsRepositoryManager.pluginPath(w.plugin.internalName, w.repositoryData.url, "cs3")
        CsRepositoryManager.download(w.plugin.url, file, w.plugin.fileHash)
        val fresh = CsPluginData(w.plugin.internalName, w.plugin.url, true, file.absolutePath, w.plugin.version, w.repositoryData.url, w.plugin.name)
        record(fresh)
        return file to fresh
    }

    /** The "Reinstall" button: downloads [internalName] again (as after a restore) and loads it. */
    suspend fun reinstall(internalName: String): Result<Unit> = runCatching {
        val data = installed().first { it.internalName == internalName }
        unloadPlugin(File(data.filePath).absolutePath)
        File(data.filePath).delete()
        val (file, fresh) = redownload(data)
        failures.remove(internalName)
        loadPlugin(file, fresh).getOrThrow()
        changed()
    }

    /**
     * Loads every installed plugin, in the official app's order: first the extension Home
     * shows, so Home appears at once ([onHomeLoaded], the official mainPluginsLoadedEvent),
     * then all the others.
     */
    suspend fun loadAll(onHomeLoaded: (Boolean) -> Unit = {}): Map<String, Throwable> = coroutineScope {
        val all = installed()
        _progress.value = CsLoadProgress(0, all.size)
        val home = all.firstOrNull()
        if (home != null) {
            loadOne(home)
            changed()
        }
        onHomeLoaded(home != null && loaded.containsKey(File(home.filePath).absolutePath))
        all.filter { it !== home }.map { data -> async(loading) { loadOne(data) } }.awaitAll()
        Log.i("cloudstream", "loaded ${loaded.size}/${all.size} extensions")
        changed()
        failures
    }

    /**
     * Port of upstream PluginManager.loadPlugin: a .cs3 is a dex file with a manifest.json,
     * loaded natively with its own class loader whose parent is the app, so the extension
     * links against this app's copy of the CloudStream library.
     */
    fun loadPlugin(file: File, data: CsPluginData): Result<CsLoadedPlugin> = runCatching {
        loaded[file.absolutePath]?.let { return@runCatching it }
        // Android 14+ refuses to load writable dex files.
        if (!file.setReadOnly()) Log.w("cloudstream", "Couldn't make ${file.name} read-only")

        val loader = PathClassLoader(file.absolutePath, CsApp.context!!.classLoader)
        val manifest = loader.getResourceAsStream("manifest.json")?.use {
            mapper.readValue<BasePlugin.Manifest>(it.readBytes())
        } ?: error("No manifest.json in ${file.name}")
        val className = manifest.pluginClassName ?: error("No plugin class in ${file.name}")

        val instance = loader.loadClass(className).getDeclaredConstructor().newInstance() as BasePlugin
        instance.filename = file.absolutePath
        if (manifest.requiresResources) (instance as? Plugin)?.resources = resourcesOf(file)

        // Like the official app, extensions get the main screen (an AppCompatActivity), not
        // the app: some (CNC Verse) show their own dialogs from load() and fail with
        // "CloudStreamApp cannot be cast to AppCompatActivity". At start-up extensions can
        // load before the screen exists: then they get it as soon as it's there.
        fun loadWith(context: android.content.Context) = synchronized(registerLock) {
            if (instance is Plugin) instance.load(context) else instance.load()
        }
        val screen = com.lagradost.cloudstream3.CommonActivity.activity
        try {
            loadWith(screen ?: CsApp.context!!)
        } catch (e: ClassCastException) {
            if (screen != null || "Activity" !in e.message.orEmpty()) throw e
            var waited = 0
            while (com.lagradost.cloudstream3.CommonActivity.activity == null && waited < 15_000) {
                Thread.sleep(100); waited += 100
            }
            loadWith(com.lagradost.cloudstream3.CommonActivity.activity ?: throw e)
        }

        CsLoadedPlugin(data.copy(version = manifest.version ?: data.version), manifest, instance, loader).also {
            loaded[file.absolutePath] = it
            failures.remove(data.internalName)
            changed()
        }
    }.onFailure {
        failures[data.internalName] = it
        Log.e("cloudstream", "Failed to load ${file.name}", it)
    }

    /** The extension's own resources (strings, layouts of its settings screen), as upstream loads them. */
    @Suppress("DEPRECATION")
    private fun resourcesOf(file: File): Resources? = runCatching {
        val assets = AssetManager::class.java.getDeclaredConstructor().newInstance()
        AssetManager::class.java.getMethod("addAssetPath", String::class.java).invoke(assets, file.absolutePath)
        val res = CsApp.context!!.resources
        Resources(assets, res.displayMetrics, res.configuration)
    }.getOrNull()

    /** For the official PluginManager.downloadPlugin: extensions that install other extensions. */
    suspend fun installFile(url: String, hash: String?, internalName: String, target: File, repositoryUrl: String?, load: Boolean): Boolean =
        runCatching {
            unloadPlugin(target.absolutePath)
            CsRepositoryManager.download(url, target, hash)
            val previous = installed().find { it.internalName == internalName }
            val data = CsPluginData(
                internalName, url, true, target.absolutePath, previous?.version ?: 0,
                repositoryUrl ?: previous?.repositoryUrl, previous?.name ?: internalName,
            )
            record(data)
            if (load) loadPlugin(target, data).getOrThrow()
            changed()
        }.isSuccess

    /** For the official PluginManager.deletePlugin. */
    fun deleteFile(file: File): Boolean {
        unloadPlugin(file.absolutePath)
        saveInstalled(installed().filter { File(it.filePath).absolutePath != file.absolutePath })
        val ok = file.delete() || !file.exists()
        changed()
        return ok
    }

    /** Port of upstream unloadPlugin: removes everything the plugin registered. */
    fun unloadPlugin(absolutePath: String) {
        val plugin = loaded.remove(absolutePath) ?: return
        runCatching { plugin.instance.beforeUnload() }
        val owner = plugin.instance.filename
        APIHolder.apis.filter { it.sourcePlugin == owner }.forEach { APIHolder.removePluginMapping(it) }
        APIHolder.allProviders.withLock { APIHolder.allProviders.removeAll { it.sourcePlugin == owner } }
        extractorApis.withLock { extractorApis.removeAll { it.sourcePlugin == owner } }
        com.lagradost.cloudstream3.actions.VideoClickActionHolder.removeFrom(owner)
        changed()
    }

    /** Downloads the .cs3 (Dalvik bytecode; the cross-platform .jar is for desktop JVMs) and loads it. */
    suspend fun install(wrapper: CsPluginWrapper): Result<CsLoadedPlugin> {
        val p = wrapper.plugin
        val target = CsRepositoryManager.pluginPath(p.internalName, wrapper.repositoryData.url, "cs3")
        installed().find { it.internalName == p.internalName }?.let { uninstall(it.internalName) }
        return runCatching {
            CsRepositoryManager.download(p.url, target, p.fileHash)
        }.mapCatching { file ->
            val data = CsPluginData(p.internalName, p.url, true, file.absolutePath, p.version, wrapper.repositoryData.url, p.name)
            record(data)
            loadPlugin(file, data).getOrThrow()
        }
    }

    /** Installs a local .cs3 file (e.g. picked from Downloads), like the official app's local plugins. */
    fun sideload(name: String, input: java.io.InputStream): Result<CsLoadedPlugin> = runCatching {
        require(name.endsWith(".cs3")) { "Expected a .cs3 file" }
        val target = File(CsRepositoryManager.extensionsDir, "local/$name")
        target.parentFile!!.mkdirs()
        unloadPlugin(target.absolutePath)
        target.delete()
        target.outputStream().use { input.copyTo(it) }
        val base = name.removeSuffix(".cs3")
        val data = CsPluginData(base, null, false, target.absolutePath, 0, null, base)
        record(data)
        loadPlugin(target, data).getOrThrow()
    }

    fun uninstall(internalName: String) {
        val data = installed().find { it.internalName == internalName } ?: return
        unloadPlugin(File(data.filePath).absolutePath)
        File(data.filePath).delete()
        saveInstalled(installed().filter { it.internalName != internalName })
        changed()
    }

    /**
     * Downloads installed extensions whose file is missing, and with [includeNew] every
     * extension of the added repositories that isn't installed yet (not broken ones, not
     * adult ones unless allowed, only the chosen languages). Returns their names.
     */
    suspend fun installMissing(includeNew: Boolean, languages: Set<String> = emptySet()): List<String> {
        val have = installed().associateBy { it.internalName }
        val done = mutableListOf<String>()
        for (repo in CsRepositoryManager.getRepositories()) {
            val available = CsRepositoryManager.getRepoPlugins(repo) ?: continue
            for (w in available) {
                val p = w.plugin
                val local = have[p.internalName]
                val missingFile = local != null && !File(local.filePath).exists()
                val wanted = local == null && includeNew && p.status != 0 &&
                    (p.tvTypes.orEmpty().none { it.equals("NSFW", true) } || CsSettings.allowAdult) &&
                    (languages.isEmpty() || p.language == null || p.language.lowercase() in languages)
                if ((missingFile || wanted) && install(w).isSuccess) done += p.name
            }
        }
        return done
    }

    /** Returns the plugins whose repository advertises a higher version, and installs them. */
    suspend fun updateAll(): List<String> {
        val byRepo = installed().filter { it.isOnline && it.repositoryUrl != null }.groupBy { it.repositoryUrl!! }
        val updated = mutableListOf<String>()
        for ((repoUrl, plugins) in byRepo) {
            val repoData = CsRepositoryManager.getRepositories().find { it.url == repoUrl } ?: continue
            val available = CsRepositoryManager.getRepoPlugins(repoData) ?: continue
            for (local in plugins) {
                val remote = available.find { it.plugin.internalName == local.internalName } ?: continue
                if (remote.plugin.version > local.version && install(remote).isSuccess) updated += local.internalName
            }
        }
        return updated
    }
}
