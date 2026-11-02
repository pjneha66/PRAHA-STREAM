package com.praha.stream;

import android.content.Context;
import android.net.Uri;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Host-based filtering only, not the uBlock Origin extension or its filter engine. */
final class EmbedBlocklist {
    private final Set<String> blocked = new HashSet<>();

    EmbedBlocklist(Context context) throws java.io.IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("embed-block-hosts.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.startsWith("0.0.0.0 ")) continue;
                String domain = line.substring(8).trim().split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
                if (!domain.isEmpty() && !domain.equals("0.0.0.0")) blocked.add(domain);
            }
        }
        if (blocked.isEmpty()) throw new java.io.IOException("Embed blocklist is empty");
    }

    boolean blocks(String host) {
        if (host == null) return true;
        String domain = host.toLowerCase(Locale.ROOT);
        if (domain.endsWith(".")) domain = domain.substring(0, domain.length() - 1);
        while (!domain.isEmpty()) {
            if (blocked.contains(domain)) return true;
            int dot = domain.indexOf('.');
            if (dot < 0) break;
            domain = domain.substring(dot + 1);
        }
        return false;
    }

    /** Do not allow the untrusted player to access local files, LAN, or app-local proxy via URLs. */
    static boolean isPublicHttps(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return false;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local") || host.indexOf(':') >= 0) return false;
        // Deny IP literals rather than allowing private, loopback, or obscure numeric forms.
        if (host.matches("[0-9.]+") || host.startsWith("0x")) return false;
        return host.indexOf('.') > 0;
    }
}
