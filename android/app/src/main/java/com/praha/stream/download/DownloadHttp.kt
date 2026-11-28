package com.praha.stream.download

import com.praha.stream.MainActivity
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

internal object DownloadHttp {
    const val USER_AGENT = "PRAHA-STREAM"

    val client = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns { hostname ->
            Dns.SYSTEM.lookup(hostname).also { addresses ->
                if (addresses.any(MainActivity::isPrivateAddress)) throw UnknownHostException("Private download host")
            }
        }
        .addNetworkInterceptor { chain ->
            // Numeric hosts can skip the DNS callback.
            val request = chain.request()
            val address = chain.connection()?.route()?.socketAddress?.address
            if (MainActivity.isPrivateAddress(address) || request.url.username.isNotEmpty() ||
                request.url.password.isNotEmpty()) throw IOException("Blocked download address")
            chain.proceed(request)
        }
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
}
