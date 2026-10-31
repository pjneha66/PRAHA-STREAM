package com.praha.stream;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lightweight local loopback HTTP proxy (`127.0.0.1`) that injects custom
 * upstream headers (Referer, Origin, User-Agent, Cookie, Authorization),
 * forwards HTTP Range requests for instant seeking, and rewrites HLS `.m3u8`
 * manifests so WebView `<video>` and `hls.js` play protected streams natively.
 */
public class PrahaStreamProxy {
    private static final Pattern URI_ATTR_PATTERN = Pattern.compile("URI=\"([^\"]+)\"");

    private ServerSocket serverSocket;
    private ExecutorService executor;
    private volatile boolean running = false;
    private int port = 0;

    public synchronized void start() {
        if (running) return;
        try {
            serverSocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
            port = serverSocket.getLocalPort();
            running = true;
            executor = Executors.newCachedThreadPool();
            executor.execute(this::acceptLoop);
        } catch (IOException ignored) {
            running = false;
            port = 0;
        }
    }

    public synchronized void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        port = 0;
    }

    public int getPort() {
        return port;
    }

    public String buildProxyUrl(String targetUrl, String headersJson) {
        if (!running || port <= 0 || targetUrl == null || targetUrl.isEmpty()) {
            return targetUrl;
        }
        try {
            String encUrl = URLEncoder.encode(targetUrl, "UTF-8");
            String encHeaders = URLEncoder.encode(headersJson == null ? "{}" : headersJson, "UTF-8");
            return "http://127.0.0.1:" + port + "/stream?url=" + encUrl + "&headers=" + encHeaders;
        } catch (Exception e) {
            return targetUrl;
        }
    }

    private void acceptLoop() {
        while (running && serverSocket != null && !serverSocket.isClosed()) {
            try {
                final Socket client = serverSocket.accept();
                if (executor != null && !executor.isShutdown()) {
                    executor.execute(() -> handleClient(client));
                } else {
                    client.close();
                }
            } catch (IOException ignored) {
                if (!running) break;
            }
        }
    }

    private void handleClient(Socket socket) {
        HttpURLConnection upstream = null;
        try {
            socket.setSoTimeout(25000);
            InputStream rawIn = socket.getInputStream();
            OutputStream rawOut = new BufferedOutputStream(socket.getOutputStream());
            BufferedReader reader = new BufferedReader(new InputStreamReader(rawIn, StandardCharsets.ISO_8859_1));

            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase(Locale.US);
            String pathAndQuery = parts[1];

            Map<String, String> clientHeaders = new HashMap<>();
            String headerLine;
            while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
                int colon = headerLine.indexOf(':');
                if (colon > 0) {
                    String k = headerLine.substring(0, colon).trim().toLowerCase(Locale.US);
                    String v = headerLine.substring(colon + 1).trim();
                    clientHeaders.put(k, v);
                }
            }

            if ("OPTIONS".equals(method)) {
                writeHeaders(rawOut, 204, "No Content", "text/plain", 0, null, null);
                rawOut.flush();
                return;
            }

            Map<String, String> query = parseQuery(pathAndQuery);
            String targetUrl = query.get("url");
            String headersJson = query.get("headers");
            if (targetUrl == null || targetUrl.isEmpty()) {
                writeHeaders(rawOut, 400, "Bad Request", "text/plain", 0, null, null);
                rawOut.flush();
                return;
            }

            upstream = openFollowRedirects(targetUrl, method, headersJson, clientHeaders.get("range"));
            int status = upstream.getResponseCode();
            String statusText = upstream.getResponseMessage();
            if (statusText == null || statusText.isEmpty()) statusText = "OK";
            String contentType = upstream.getContentType();
            if (contentType == null || contentType.isEmpty()) contentType = "application/octet-stream";

            String finalUrl = upstream.getURL().toString();
            boolean isHlsManifest = isPlaylist(finalUrl, contentType);

            InputStream upstreamStream = status >= 400 ? upstream.getErrorStream() : upstream.getInputStream();
            if (upstreamStream == null) {
                writeHeaders(rawOut, status, statusText, contentType, 0, null, null);
                rawOut.flush();
                return;
            }

            if (isHlsManifest && status >= 200 && status < 300) {
                String playlist = readTextStream(upstreamStream);
                if (playlist.trim().startsWith("#EXTM3U")) {
                    String rewritten = rewriteHlsManifest(playlist, finalUrl, headersJson);
                    byte[] payload = rewritten.getBytes(StandardCharsets.UTF_8);
                    writeHeaders(rawOut, 200, "OK", "application/vnd.apple.mpegurl; charset=utf-8", payload.length, null, null);
                    if (!"HEAD".equals(method)) {
                        rawOut.write(payload);
                    }
                    rawOut.flush();
                    return;
                } else {
                    byte[] payload = playlist.getBytes(StandardCharsets.ISO_8859_1);
                    writeHeaders(rawOut, status, statusText, contentType, payload.length, null, null);
                    if (!"HEAD".equals(method)) {
                        rawOut.write(payload);
                    }
                    rawOut.flush();
                    return;
                }
            }

            long contentLength = upstream.getContentLengthLong();
            String contentRange = upstream.getHeaderField("Content-Range");
            String acceptRanges = upstream.getHeaderField("Accept-Ranges");
            writeHeaders(rawOut, status, statusText, contentType, contentLength, contentRange, acceptRanges);

            if (!"HEAD".equals(method)) {
                BufferedInputStream bufferedIn = new BufferedInputStream(upstreamStream, 32 * 1024);
                byte[] buffer = new byte[32 * 1024];
                int read;
                while ((read = bufferedIn.read(buffer)) != -1) {
                    rawOut.write(buffer, 0, read);
                }
            }
            rawOut.flush();
        } catch (Exception ignored) {
        } finally {
            if (upstream != null) upstream.disconnect();
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private HttpURLConnection openFollowRedirects(String targetUrl, String method, String headersJson, String rangeHeader) throws Exception {
        String currentUrl = targetUrl;
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(currentUrl).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(25000);
            conn.setRequestMethod("HEAD".equals(method) ? "HEAD" : "GET");

            if (rangeHeader != null && !rangeHeader.isEmpty()) {
                conn.setRequestProperty("Range", rangeHeader);
            }

            boolean hasUserAgent = false;
            if (headersJson != null && !headersJson.isEmpty()) {
                try {
                    JSONObject obj = new JSONObject(headersJson);
                    Iterator<String> keys = obj.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = obj.optString(key, "");
                        if (!value.isEmpty()) {
                            conn.setRequestProperty(key, value);
                            if ("user-agent".equalsIgnoreCase(key)) hasUserAgent = true;
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            if (!hasUserAgent) {
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
            }

            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.isEmpty()) return conn;
                currentUrl = new URI(currentUrl).resolve(location).toString();
                continue;
            }
            return conn;
        }
        throw new IOException("Too many redirects");
    }

    private boolean isPlaylist(String url, String contentType) {
        String ct = contentType.toLowerCase(Locale.US);
        if (ct.contains("mpegurl") || ct.contains("x-mpegurl")) return true;
        String cleanUrl = url.split("\\?")[0].toLowerCase(Locale.US);
        return cleanUrl.endsWith(".m3u8") || cleanUrl.endsWith(".m3u");
    }

    private String rewriteHlsManifest(String manifest, String baseUrl, String headersJson) {
        URI baseUri;
        try {
            baseUri = new URI(baseUrl);
        } catch (Exception e) {
            return manifest;
        }

        StringBuilder out = new StringBuilder(manifest.length() + 512);
        String[] lines = manifest.replace("\r\n", "\n").split("\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                out.append("\n");
                continue;
            }
            if (trimmed.startsWith("#")) {
                Matcher matcher = URI_ATTR_PATTERN.matcher(line);
                StringBuffer sb = new StringBuffer();
                while (matcher.find()) {
                    String rawUri = matcher.group(1);
                    String resolved = resolveUri(baseUri, rawUri);
                    String proxied = buildProxyUrl(resolved, headersJson);
                    matcher.appendReplacement(sb, Matcher.quoteReplacement("URI=\"" + proxied + "\""));
                }
                matcher.appendTail(sb);
                out.append(sb).append("\n");
            } else {
                String resolved = resolveUri(baseUri, trimmed);
                out.append(buildProxyUrl(resolved, headersJson)).append("\n");
            }
        }
        return out.toString();
    }

    private String resolveUri(URI base, String ref) {
        try {
            if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
            return base.resolve(ref).toString();
        } catch (Exception e) {
            return ref;
        }
    }

    private String readTextStream(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private Map<String, String> parseQuery(String pathAndQuery) {
        Map<String, String> map = new HashMap<>();
        int qIdx = pathAndQuery.indexOf('?');
        if (qIdx < 0 || qIdx == pathAndQuery.length() - 1) return map;
        String query = pathAndQuery.substring(qIdx + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq > 0) {
                    String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    map.put(k, v);
                }
            } catch (Exception ignored) {
            }
        }
        return map;
    }

    private void writeHeaders(
            OutputStream out,
            int status,
            String statusText,
            String contentType,
            long contentLength,
            String contentRange,
            String acceptRanges
    ) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(" ").append(statusText).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: *\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
        sb.append("Content-Type: ").append(contentType).append("\r\n");
        if (contentLength >= 0) {
            sb.append("Content-Length: ").append(contentLength).append("\r\n");
        }
        if (contentRange != null && !contentRange.isEmpty()) {
            sb.append("Content-Range: ").append(contentRange).append("\r\n");
        }
        sb.append("Accept-Ranges: ").append(acceptRanges != null ? acceptRanges : "bytes").append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }
}
