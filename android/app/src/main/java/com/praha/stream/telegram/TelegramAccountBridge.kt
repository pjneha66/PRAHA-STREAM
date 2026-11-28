package com.praha.stream.telegram

import android.app.Activity
import android.os.Build
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.praha.stream.download.DownloadBridge
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

@UnstableApi
object TelegramAccountBridge {
    private val supported = Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "armeabi-v7a" }

    @JvmStatic
    fun dispatch(activity: Activity, method: String, args: JSONArray): Any {
        val profile = args.optString(0)
        require(profile.isNotBlank()) { "Select a PRAHA profile first." }
        val settings = Td.settings(activity)
        if (!supported) return JSONObject().put("state", "unsupported")
        val owner = settings.getString("profile", null)
        if (owner != null && owner != profile) return JSONObject().put("state", "otherProfile")
        Td.init(activity)
        return when (method) {
            "telegramAccountStatus" -> status()
            "telegramAccountCredentials" -> {
                val apiId = args.optString(1)
                val apiHash = args.optString(2)
                Td.keyProblem(apiId, apiHash)?.let { error(it) }
                val id = Td.apiIdOf(apiId) ?: error("Enter a valid Telegram API ID.")
                val hash = Td.apiHashOf(apiHash) ?: error("Enter a valid Telegram API hash.")
                check(settings.edit().putString("profile", profile).putInt("apiId", id).putString("apiHash", hash).commit()) {
                    "Could not save the Telegram settings."
                }
                Td.setCredentials(id, hash)
                status()
            }
            "telegramAccountAuth" -> {
                check(owner == profile) { "Connect a Telegram account first." }
                when (args.optString(1)) {
                    "phone" -> Td.submitPhone(args.optString(2))
                    "code" -> Td.submitCode(args.optString(2))
                    "password" -> Td.submitPassword(args.optString(2))
                    "refresh" -> Td.loadChats()
                    "restart" -> Td.signInAgain()
                    "signOut" -> Td.signOut()
                    else -> error("Unknown Telegram action.")
                }
                status()
            }
            "telegramAccountVideos" -> runBlocking {
                check(owner == profile && Td.isSignedIn()) { "Sign in to Telegram first." }
                withTimeout(25_000) {
                    val target = args.optString(1)
                    val chatId = target.toLongOrNull()
                        ?: Td.publicChatId(target.removePrefix("@"))
                        ?: error("Telegram could not find that channel.")
                    val cursor = args.optString(2).toLongOrNull() ?: 0
                    val search = args.optString(3)
                    if (search.isBlank()) {
                        val page = Td.chatVideosPage(chatId, cursor, 40)
                        videoPage(page.videos, if (page.more) page.nextCursor else 0)
                    } else {
                        val page = Td.searchChatVideos(chatId, search, Td.SearchIn.BOTH, cursor, 40)
                        videoPage(page.videos, if (page.exhausted) 0 else page.nextCursor)
                    }
                }
            }
            "telegramAccountPlay" -> {
                check(owner == profile && Td.isSignedIn()) { "Sign in to Telegram first." }
                val chat = args.optString(1).toLongOrNull() ?: error("Invalid Telegram chat.")
                val message = args.optString(2).toLongOrNull() ?: error("Invalid Telegram message.")
                val file = runBlocking { withTimeout(15_000) { Td.touchMessage(chat, message) } }
                check(file > 0) { "This Telegram video is unavailable." }
                val uri = TdFileDataSource.uriFor(file, chat, message)
                activity.runOnUiThread {
                    val factory = TdDataSourceFactory(DefaultDataSource.Factory(activity))
                    DownloadBridge.play(activity, android.net.Uri.parse(uri), DefaultMediaSourceFactory(factory))
                }
                true
            }
            else -> error("Unknown Telegram request.")
        }
    }

    private fun videoPage(items: List<Td.ChatVideo>, cursor: Long): JSONObject =
        JSONObject().put("before", cursor.toString()).put("videos", JSONArray(items.map { video ->
            JSONObject().put("chat", video.chatId.toString()).put("message", video.messageId.toString())
                .put("title", video.title).put("duration", video.duration).put("poster", video.thumb)
        }))

    private fun status(): JSONObject {
        val state = when (Td.auth.value) {
            Td.Auth.Idle -> "idle"
            Td.Auth.Starting -> "starting"
            Td.Auth.Unavailable -> "unsupported"
            Td.Auth.WaitPhone -> "phone"
            Td.Auth.WaitCode -> "code"
            is Td.Auth.WaitPassword -> "password"
            Td.Auth.Ready -> "ready"
            Td.Auth.Closed -> "closed"
            else -> "unsupportedLogin"
        }
        return JSONObject().put("state", state).put("busy", Td.busy.value)
            .put("error", Td.problem.value ?: Td.loadError)
            .put("chats", JSONArray(Td.chats.value.map { chat ->
                JSONObject().put("id", chat.id.toString()).put("title", chat.title).put("kind", chat.kind.name)
            }))
    }
}
