package com.praha.stream.torr

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the TorrServer subprocess alive while the app is in the background.
 *
 * Ported from VyseTV's `TorrServerForegroundService.kt`. The service itself
 * does not spawn the binary — `PrahaTorrServerPlugin` owns the Process so the
 * REST client can reach it from JS — it only provides the mandatory ongoing
 * notification and raises the process' importance.
 */
class PrahaTorrForegroundService : Service() {

    companion object {
        private const val CHANNEL_ID = "praha_torrserver_streaming"
        private const val NOTIFICATION_ID = 8090
        private const val ACTION_START = "com.praha.stream.torr.START"
        private const val ACTION_STOP = "com.praha.stream.torr.STOP"

        fun start(context: Context) {
            val intent = Intent(context, PrahaTorrForegroundService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, PrahaTorrForegroundService::class.java).setAction(ACTION_STOP)
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("TorrServer active")
            .setContentText("Torrent streaming engine is running")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "TorrServer streaming",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Keeps the torrent streaming engine alive during playback" }
            getSystemService(Context.NOTIFICATION_SERVICE)
                .let { it as? NotificationManager }
                ?.createNotificationChannel(channel)
        }
    }
}
