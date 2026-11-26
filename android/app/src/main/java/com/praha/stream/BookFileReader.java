package com.praha.stream;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipFile;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Downloads a book into app cache and reads it in a separate, offline WebView. */
final class BookFileReader {
    private static final long MAX_BYTES = 96L * 1024 * 1024;
    private static final String ORIGIN = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN;
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .dns(host -> {
                var addresses = AppDns.client().dns().lookup(host);
                for (InetAddress address : addresses) {
                    byte[] bytes = address.getAddress();
                    if (MainActivity.isPrivateAddress(address) || (bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc)) {
                        throw new UnknownHostException("Book downloads must use a public host");
                    }
                }
                return addresses;
            })
            .followRedirects(false)
            .callTimeout(35, TimeUnit.SECONDS)
            .build();

    private final ProtectedEmbedActivity activity;
    private volatile boolean closed;
    private volatile Call call;
    private volatile File file;
    private WebView view;

    BookFileReader(ProtectedEmbedActivity activity) {
        this.activity = activity;
    }

    static boolean isBookDownload(String url, String disposition, String mime) {
        String filename = URLUtil.guessFileName(url, disposition, mime).toLowerCase(Locale.ROOT);
        String mediaType = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return filename.endsWith(".pdf") || filename.endsWith(".epub") || filename.endsWith(".cbz")
                || mediaType.equals("application/pdf") || mediaType.equals("application/epub+zip") || mediaType.equals("application/vnd.comicbook+zip");
    }

    void open(String url, String userAgent, String referer, Consumer<WebView> onReady, Consumer<String> onError) {
        new Thread(() -> {
            File temporary = null;
            try {
                temporary = File.createTempFile("praha-book-", ".download", activity.getCacheDir());
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (var output = new DigestOutputStream(new FileOutputStream(temporary), digest)) {
                    download(url, userAgent, referer, output);
                }
                String format = detectFormat(temporary);
                StringBuilder id = new StringBuilder(64);
                for (byte value : digest.digest()) id.append(String.format(Locale.ROOT, "%02x", value & 0xff));
                file = temporary;
                activity.runOnUiThread(() -> {
                    if (closed) { deleteFile(); return; }
                    view = createViewer(format);
                    onReady.accept(view);
                    view.loadUrl(ORIGIN + "/reader/book-reader.html#format=" + format + "&id=" + id);
                });
            } catch (Exception error) {
                if (temporary != null) temporary.delete();
                String message = error instanceof BookError ? error.getMessage() : "The book could not be downloaded. Go back and try the link again.";
                activity.runOnUiThread(() -> { if (!closed) onError.accept(message); });
            }
        }, "praha-book-download").start();
    }

    private void download(String raw, String userAgent, String referer, DigestOutputStream output) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        HttpUrl url = HttpUrl.parse(raw);
        HttpUrl referringPage = referer == null ? null : HttpUrl.parse(referer);
        for (int attempt = 0; attempt < 6; attempt++) {
            if (closed) throw new IOException("Reader closed");
            if (url == null || url.port() != 443 || !EmbedBlocklist.isPublicHttps(Uri.parse(url.toString()))) break;
            Request.Builder request = new Request.Builder().url(url);
            if (userAgent != null && !userAgent.isEmpty()) request.header("User-Agent", userAgent);
            if (referringPage != null) {
                boolean sameHost = url.host().equals(referringPage.host());
                HttpUrl.Builder refererUrl = referringPage.newBuilder().fragment(null);
                if (!sameHost) refererUrl.encodedPath("/").query(null);
                request.header("Referer", refererUrl.build().toString());
                if (sameHost) {
                    String cookies = CookieManager.getInstance().getCookie(url.toString());
                    if (cookies != null && !cookies.isEmpty()) request.header("Cookie", cookies);
                }
            }
            Call pending = HTTP.newCall(request.build());
            pending.timeout().deadlineNanoTime(deadline);
            call = pending;
            if (closed) pending.cancel();
            try (Response response = pending.execute()) {
                if (response.isRedirect()) {
                    String redirect = response.header("Location");
                    url = redirect == null ? null : url.resolve(redirect);
                    continue;
                }
                ResponseBody body = response.body();
                if (!response.isSuccessful() || body == null) throw new BookError("The site did not provide a readable file. Go back and try the link again.");
                if (body.contentLength() > MAX_BYTES) throw new BookError("This book is too large to open on this device.");
                try (InputStream stream = body.byteStream()) {
                    byte[] buffer = new byte[32768];
                    long total = 0;
                    int size;
                    while (!closed && (size = stream.read(buffer)) != -1) {
                        total += size;
                        if (total > MAX_BYTES) throw new BookError("This book is too large to open on this device.");
                        output.write(buffer, 0, size);
                    }
                }
                if (closed) throw new IOException("Reader closed");
                return;
            } finally {
                call = null;
            }
        }
        throw new BookError("This download link could not be opened.");
    }

    private static String detectFormat(File file) throws IOException {
        byte[] header = new byte[5];
        try (InputStream input = new FileInputStream(file)) {
            if (input.read(header) != header.length) throw new BookError("The site returned an empty or incomplete book.");
        }
        if (new String(header, StandardCharsets.US_ASCII).equals("%PDF-")) return "pdf";
        if (header[0] == 'P' && header[1] == 'K') {
            try (ZipFile zip = new ZipFile(file)) {
                if (zip.size() > 10000) throw new BookError("This archive contains too many files.");
                long expanded = 0;
                boolean images = false;
                var entries = zip.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    long size = entry.getSize();
                    if (size < 0 || size > 3 * MAX_BYTES - expanded) throw new BookError("This archive is too large to open.");
                    expanded += size;
                    images |= !entry.isDirectory() && entry.getName().toLowerCase(Locale.ROOT).matches(".*\\.(jpe?g|png|webp|gif|avif)$");
                }
                if (zip.getEntry("META-INF/container.xml") != null) return "epub";
                if (images) return "cbz";
            } catch (java.util.zip.ZipException error) {
                throw new BookError("This archive is incomplete or damaged.");
            }
        }
        throw new BookError("This link did not return a PDF, EPUB, or CBZ.");
    }

    private WebView createViewer(String format) {
        var assets = new WebViewAssetLoader.AssetsPathHandler(activity);
        var loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/reader/", path -> path.equals("book-reader.html") ? assets.handle("public/" + path) : null)
                .addPathHandler("/assets/", path -> {
                    if (!path.matches("(?:pdfjs/(?:cmaps|standard_fonts|iccs|wasm)/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*")) return null;
                    WebResourceResponse response = assets.handle("public/assets/" + path);
                    if (response != null && path.endsWith(".mjs")) response.setMimeType("text/javascript");
                    if (response != null && path.endsWith(".wasm")) response.setMimeType("application/wasm");
                    return response;
                })
                .addPathHandler("/document/", path -> {
                    File document = file;
                    if (!path.equals("book") || document == null) return null;
                    try {
                        String mime = switch (format) {
                            case "pdf" -> "application/pdf";
                            case "epub" -> "application/epub+zip";
                            default -> "application/vnd.comicbook+zip";
                        };
                        return new WebResourceResponse(mime, null, new FileInputStream(document));
                    } catch (IOException error) { return null; }
                }).build();
        WebView reader = new WebView(activity);
        var settings = reader.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        reader.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.isForMainFrame();
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = loader.shouldInterceptRequest(request.getUrl());
                return response != null ? response : new WebResourceResponse("text/plain", "UTF-8", 404,
                        "Not found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
        });
        return reader;
    }

    private void deleteFile() {
        File document = file;
        if (document != null) document.delete();
        file = null;
    }

    void close() {
        closed = true;
        Call pending = call;
        if (pending != null) pending.cancel();
        if (view != null) { view.stopLoading(); view.destroy(); view = null; }
        deleteFile();
    }

    private static final class BookError extends IOException {
        BookError(String message) { super(message); }
    }
}
