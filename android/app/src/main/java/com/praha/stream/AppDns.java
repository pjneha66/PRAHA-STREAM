package com.praha.stream;

import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.util.concurrent.TimeUnit;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.dnsoverhttps.DnsOverHttps;

final class AppDns {
    private static final OkHttpClient BASE = new OkHttpClient.Builder().followRedirects(false).build();
    private static final OkHttpClient BOOTSTRAP = BASE.newBuilder()
            .proxy(Proxy.NO_PROXY)
            .callTimeout(4500, TimeUnit.MILLISECONDS)
            .build();
    private static volatile Config active = new Config("system", true);
    private AppDns() {}

    static boolean configure(String provider, boolean fallback) {
        if (active.provider.equals(provider) && active.fallback == fallback) return true;
        try {
            active = new Config(provider, fallback);
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static OkHttpClient client() { return active.client; }

    static boolean probe(String provider) throws UnknownHostException {
        return !resolver(provider).lookup("example.com").isEmpty();
    }

    private static Dns resolver(String provider) throws UnknownHostException {
        if ("system".equals(provider)) return Dns.SYSTEM;
        String endpoint;
        String primary;
        String secondary;
        switch (provider) {
            case "cloudflare": endpoint = "https://cloudflare-dns.com/dns-query"; primary = "1.1.1.1"; secondary = "1.0.0.1"; break;
            case "google": endpoint = "https://dns.google/dns-query"; primary = "8.8.8.8"; secondary = "8.8.4.4"; break;
            case "adguard": endpoint = "https://dns.adguard-dns.com/dns-query"; primary = "94.140.14.14"; secondary = "94.140.15.15"; break;
            case "quad9": endpoint = "https://dns.quad9.net/dns-query"; primary = "9.9.9.9"; secondary = "149.112.112.112"; break;
            default: throw new IllegalArgumentException("Unknown DNS provider");
        }
        return new DnsOverHttps.Builder()
                .client(BOOTSTRAP)
                .url(HttpUrl.get(endpoint))
                .bootstrapDnsHosts(InetAddress.getByName(primary), InetAddress.getByName(secondary))
                .build();
    }

    private static final class Config {
        final String provider;
        final boolean fallback;
        final OkHttpClient client;

        Config(String provider, boolean fallback) {
            this.provider = provider;
            this.fallback = fallback;
            if ("system".equals(provider)) {
                client = BASE;
                return;
            }
            final Dns dns;
            try {
                dns = resolver(provider);
            } catch (UnknownHostException error) {
                throw new IllegalArgumentException(error);
            }
            client = BASE.newBuilder().proxy(Proxy.NO_PROXY).dns(host -> {
                if (!host.contains(".") || host.endsWith(".local") || host.endsWith(".local.")) return Dns.SYSTEM.lookup(host);
                try {
                    return dns.lookup(host);
                } catch (UnknownHostException error) {
                    if (fallback) return Dns.SYSTEM.lookup(host);
                    throw new UnknownHostException("Encrypted DNS could not resolve " + host);
                }
            }).build();
        }
    }
}
