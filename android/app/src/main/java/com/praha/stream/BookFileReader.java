package com.praha.stream;

import android.content.Context;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import com.github.junrar.Archive;
import com.github.junrar.ArchiveOptions;
import com.github.junrar.exception.RarException;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Downloads a book into app cache and reads it in a separate, offline WebView. */
final class BookFileReader {
    private static final long MIB = 1024L * 1024;
    private static final long MAX_BYTES = 256 * MIB;
    private static final long MAX_PAGE_BYTES = 32 * MIB;
    private static final long MAX_EPUB_BYTES = 96 * MIB;
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
            .readTimeout(25, TimeUnit.SECONDS)
            .build();

    private static final Set<File> ACTIVE_COMIC_FILES = new HashSet<>();

    private final ProtectedEmbedActivity activity;
    private final boolean comicDownload;
    private volatile boolean closed;
    private volatile Call call;
    private volatile File file;
    private List<String> comicPages = List.of();
    private WebView view;

    BookFileReader(ProtectedEmbedActivity activity, boolean comicDownload) {
        this.activity = activity;
        this.comicDownload = comicDownload;
    }

    private static File comicCache(Context context) {
        return new File(context.getCacheDir(), "comicsnake-reader");
    }

    static boolean clearComicCache(Context context) {
        synchronized (ACTIVE_COMIC_FILES) {
            File directory = comicCache(context);
            if (!directory.exists()) return true;
            File[] files = directory.listFiles();
            if (files == null) return false;
            boolean cleared = true;
            for (File entry : files) {
                if (!ACTIVE_COMIC_FILES.contains(entry) && !entry.delete() && entry.exists()) cleared = false;
            }
            return cleared;
        }
    }

    private File newTemporaryFile(String prefix, String suffix) throws IOException {
        if (!comicDownload) return File.createTempFile(prefix, suffix, activity.getCacheDir());
        synchronized (ACTIVE_COMIC_FILES) {
            File directory = comicCache(activity);
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create comic cache");
            File entry = File.createTempFile(prefix, suffix, directory);
            ACTIVE_COMIC_FILES.add(entry);
            return entry;
        }
    }

    private void removeTemporaryFile(File entry) {
        if (entry == null) return;
        synchronized (ACTIVE_COMIC_FILES) {
            entry.delete();
            ACTIVE_COMIC_FILES.remove(entry);
        }
    }

    static boolean isBookDownload(String url, String disposition, String mime) {
        String filename = URLUtil.guessFileName(url, disposition, mime).toLowerCase(Locale.ROOT);
        String mediaType = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return filename.endsWith(".pdf") || filename.endsWith(".epub") || filename.endsWith(".cbz")
                || mediaType.equals("application/pdf") || mediaType.equals("application/epub+zip") || mediaType.equals("application/vnd.comicbook+zip");
    }

    static boolean isComicArchive(String url, String disposition, String mime) {
        String filename = URLUtil.guessFileName(url, disposition, mime).toLowerCase(Locale.ROOT);
        String mediaType = mime == null ? "" : mime.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return filename.matches(".*\\.(cbr|rar|zip)$") || mediaType.equals("application/vnd.comicbook-rar")
                || mediaType.equals("application/x-cbz") || mediaType.equals("application/x-cbr") || mediaType.equals("application/vnd.rar")
                || mediaType.equals("application/x-rar-compressed") || mediaType.equals("application/zip");
    }

    void open(String url, String userAgent, String referer, Consumer<WebView> onReady, Consumer<String> onError, Consumer<String> onProgress) {
        new Thread(() -> {
            File temporary = null;
            try {
                temporary = newTemporaryFile("praha-book-", ".download");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (var output = new DigestOutputStream(new FileOutputStream(temporary), digest)) {
                    download(url, userAgent, referer, output, onProgress);
                }
                String format = detectFormat(temporary);
                if (format.equals("epub") && temporary.length() > MAX_EPUB_BYTES) {
                    throw new BookError("The EPUB exceeds the 96 MB reader limit.");
                }
                if (format.equals("cbr")) {
                    progress(onProgress, "Preparing comic pages…");
                    File comic = newTemporaryFile("praha-comic-", ".cbz");
                    try {
                        convertComicArchive(temporary, comic);
                    } catch (Exception error) {
                        removeTemporaryFile(comic);
                        throw error;
                    }
                    removeTemporaryFile(temporary);
                    temporary = comic;
                    format = "cbz";
                }
                if (format.equals("cbz")) comicPages = listComicPages(temporary);
                String readerFormat = format;
                StringBuilder id = new StringBuilder(64);
                for (byte value : digest.digest()) id.append(String.format(Locale.ROOT, "%02x", value & 0xff));
                file = temporary;
                activity.runOnUiThread(() -> {
                    if (closed) { deleteFile(); return; }
                    view = createViewer(readerFormat);
                    onReady.accept(view);
                    view.loadUrl(ORIGIN + "/reader/book-reader.html#format=" + readerFormat + "&id=" + id);
                });
            } catch (Exception error) {
                removeTemporaryFile(temporary);
                String message = error instanceof BookError ? error.getMessage() : "The book could not be downloaded. Go back and try the link again.";
                activity.runOnUiThread(() -> { if (!closed) onError.accept(message); });
            }
        }, "praha-book-download").start();
    }

    private void progress(Consumer<String> action, String message) {
        activity.runOnUiThread(() -> { if (!closed) action.accept(message); });
    }

    private void download(String raw, String userAgent, String referer, DigestOutputStream output,
                          Consumer<String> onProgress) throws IOException {
        // FlorenFile free downloads can take over an hour near the reader size limit.
        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(comicDownload ? 120 : 5);
        long usable = activity.getCacheDir().getUsableSpace();
        long limit = Math.min(MAX_BYTES, Math.max(0, usable - 32 * MIB));
        HttpUrl url = HttpUrl.parse(raw);
        HttpUrl referringPage = referer == null ? null : HttpUrl.parse(referer);
        for (int attempt = 0; attempt < 6; attempt++) {
            if (closed) throw new IOException("Reader closed");
            if (url == null || !EmbedBlocklist.isPublicHttps(Uri.parse(url.toString()))) break;
            // Verified FlorenFile links use HTTPS on port 183 on their numbered file servers.
            boolean florenFileServer = comicDownload && url.port() == 183 && url.host().matches("s[0-9]+\\.florenfile\\.com");
            if (url.port() != 443 && !florenFileServer) break;
            Request.Builder request = new Request.Builder().url(url);
            if (userAgent != null && !userAgent.isEmpty()) request.header("User-Agent", userAgent);
            if (referringPage != null) {
                boolean sameHost = url.host().equals(referringPage.host());
                HttpUrl.Builder refererUrl = referringPage.newBuilder().fragment(null);
                if (!sameHost) refererUrl.encodedPath("/").query(null);
                request.header("Referer", refererUrl.build().toString());
                if (sameHost || (comicDownload && attempt == 0)) {
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
                long expected = body.contentLength();
                if (expected > limit) throw new BookError(largeFileMessage(limit));
                try (InputStream stream = body.byteStream()) {
                    byte[] buffer = new byte[32768];
                    long total = 0;
                    long lastUpdate = 0;
                    int size;
                    while (!closed && (size = stream.read(buffer)) != -1) {
                        total += size;
                        if (total > limit) throw new BookError(largeFileMessage(limit));
                        output.write(buffer, 0, size);
                        long now = System.nanoTime();
                        if (now - lastUpdate >= TimeUnit.SECONDS.toNanos(1)) {
                            lastUpdate = now;
                            progress(onProgress, expected > 0
                                    ? "Downloading… " + (total * 100 / expected) + "%"
                                    : "Downloading… " + (total / MIB) + " MB");
                        }
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

    private static String largeFileMessage(long limit) {
        return limit < MAX_BYTES ? "There isn’t enough free storage to open this file." : "This file exceeds the 256 MB reader limit.";
    }

    private static String detectFormat(File file) throws IOException {
        byte[] header = new byte[5];
        try (InputStream input = new FileInputStream(file)) {
            if (input.read(header) != header.length) throw new BookError("The site returned an empty or incomplete book.");
        }
        if (new String(header, StandardCharsets.US_ASCII).equals("%PDF-")) return "pdf";
        if (new String(header, StandardCharsets.US_ASCII).equals("Rar!\u001a")) return "cbr";
        if (header[0] == 'P' && header[1] == 'K') {
            try (ZipFile zip = new ZipFile(file)) {
                if (zip.size() > 10000) throw new BookError("This archive contains too many files.");
                boolean epub = zip.getEntry("META-INF/container.xml") != null;
                long expandedLimit = 3 * (epub ? MAX_EPUB_BYTES : MAX_BYTES);
                long expanded = 0;
                boolean images = false;
                var entries = zip.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    long size = entry.getSize();
                    if (size < 0 || size > expandedLimit - expanded) throw new BookError("This archive is too large to open.");
                    expanded += size;
                    images |= !entry.isDirectory() && isPageImage(entry.getName());
                }
                if (epub) return "epub";
                if (images) return "cbz";
            } catch (java.util.zip.ZipException error) {
                throw new BookError("This archive is incomplete or damaged.");
            }
        }
        throw new BookError("This link did not return a readable book or comic.");
    }

    private static boolean isPageImage(String name) {
        return name.toLowerCase(Locale.ROOT).matches(".*\\.(jpe?g|png|webp|gif|avif)$");
    }

    // Reuse the offline CBZ viewer. Archive entries are never extracted as paths.
    private void convertComicArchive(File source, File destination) throws IOException {
        var options = ArchiveOptions.builder().maxDictionarySize(32L * 1024 * 1024).build();
        try (Archive rar = new Archive(source, options);
             ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(destination))) {
            if (rar.getFileHeaders().size() > 10000) throw new BookError("This archive contains too many files.");
            byte[] buffer = new byte[32768];
            long remaining = Math.min(MAX_BYTES, Math.max(0, destination.getUsableSpace() - 32 * MIB));
            boolean hasPages = false;
            for (var entry : rar.getFileHeaders()) {
                if (closed) throw new IOException("Reader closed");
                String name = entry.getFileName().replace('\\', '/');
                if (entry.isDirectory() || name.startsWith("__MACOSX/") || !isPageImage(name)) continue;
                long size = entry.getFullUnpackSize();
                if (size < 0 || size > MAX_PAGE_BYTES || size > remaining) throw new BookError("This archive is too large to open.");
                if (entry.isEncrypted() || entry.isSplitBefore() || entry.isSplitAfter()) {
                    throw new BookError("Choose an unprotected comic archive in a single file.");
                }
                zip.putNextEntry(new ZipEntry(name));
                try (InputStream page = rar.getInputStream(entry)) {
                    int count;
                    while ((count = page.read(buffer)) != -1) {
                        if (closed) throw new IOException("Reader closed");
                        size -= count;
                        if (size < 0) throw new BookError("This archive is damaged.");
                        zip.write(buffer, 0, count);
                    }
                }
                if (size != 0) throw new BookError("This archive is incomplete.");
                remaining -= entry.getFullUnpackSize();
                zip.closeEntry();
                hasPages = true;
            }
            if (!hasPages) throw new BookError("This archive contains no comic pages.");
        } catch (BookError error) {
            throw error;
        } catch (IOException | RarException error) {
            throw new BookError("This comic archive is damaged or uses an unsupported format.");
        }
    }

    private static List<String> listComicPages(File document) throws IOException {
        List<String> pages = new ArrayList<>();
        try (ZipFile zip = new ZipFile(document)) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                String name = entry.getName();
                if (entry.isDirectory() || name.startsWith("__MACOSX/") || !isPageImage(name)) continue;
                if (entry.getSize() > MAX_PAGE_BYTES) throw new BookError("A comic page exceeds the 32 MB reader limit.");
                pages.add(name);
            }
        }
        if (pages.isEmpty()) throw new BookError("This archive contains no comic pages.");
        return pages;
    }

    private WebResourceResponse comicPage(File document, int index) throws IOException {
        if (index < 0 || index >= comicPages.size()) return null;
        String name = comicPages.get(index);
        ZipFile zip = new ZipFile(document);
        try {
            InputStream stream = zip.getInputStream(zip.getEntry(name));
            String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
            return new WebResourceResponse("image/" + (extension.equals("jpg") ? "jpeg" : extension), null,
                    new FilterInputStream(stream) {
                        @Override public void close() throws IOException {
                            try { super.close(); } finally { zip.close(); }
                        }
                    });
        } catch (IOException | RuntimeException error) {
            zip.close();
            throw error;
        }
    }

    private static WebResourceResponse pdfResponse(File document, String range) throws IOException {
        long length = document.length();
        Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        if (range == null) {
            headers.put("Content-Length", Long.toString(length));
            return new WebResourceResponse("application/pdf", null, 200, "OK", headers, new FileInputStream(document));
        }
        long start = -1;
        long end = -1;
        if (range.matches("bytes=[0-9]{1,10}-[0-9]{0,10}")) {
            String[] bounds = range.substring(6).split("-", -1);
            start = Long.parseLong(bounds[0]);
            end = bounds[1].isEmpty() ? length - 1 : Math.min(Long.parseLong(bounds[1]), length - 1);
        }
        if (start < 0 || start > end) {
            headers.put("Content-Range", "bytes */" + length);
            return new WebResourceResponse("application/pdf", null, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
        }
        long count = end - start + 1;
        headers.put("Content-Length", Long.toString(count));
        headers.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
        FileInputStream input = new FileInputStream(document);
        try {
            input.getChannel().position(start);
        } catch (IOException error) {
            input.close();
            throw error;
        }
        return new WebResourceResponse("application/pdf", null, 206, "Partial Content", headers, new FilterInputStream(input) {
            private long remaining = count;
            @Override public int read() throws IOException {
                if (remaining == 0) return -1;
                int value = in.read();
                if (value >= 0) remaining--;
                return value;
            }
            @Override public int read(byte[] buffer, int offset, int size) throws IOException {
                if (size == 0) return 0;
                if (remaining == 0) return -1;
                int read = in.read(buffer, offset, (int) Math.min(size, remaining));
                if (read > 0) remaining -= read;
                return read;
            }
            @Override public int available() throws IOException { return (int) Math.min(remaining, super.available()); }
            @Override public long skip(long size) throws IOException {
                long skipped = super.skip(Math.min(size, remaining));
                remaining -= skipped;
                return skipped;
            }
        });
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
                .build();
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
                Uri url = request.getUrl();
                File document = file;
                if (document != null && ORIGIN.equals(url.getScheme() + "://" + url.getEncodedAuthority())) {
                    String path = url.getPath();
                    try {
                        if ("/document/book".equals(path)) {
                            if (format.equals("pdf")) {
                                // WebView applies HTTP Range itself to intercepted InputStreams.
                                // Pass PDF.js offsets through the local query to avoid double seeking.
                                return pdfResponse(document, url.getQueryParameter("range"));
                            }
                            if (format.equals("epub")) return new WebResourceResponse("application/epub+zip", null, new FileInputStream(document));
                        }
                        if (format.equals("cbz") && path != null) {
                            if (path.equals("/document/pages")) {
                                byte[] names = new JSONArray(comicPages).toString().getBytes(StandardCharsets.UTF_8);
                                return new WebResourceResponse("application/json", "UTF-8", new ByteArrayInputStream(names));
                            }
                            if (path.matches("/document/page/[0-9]{1,5}")) {
                                WebResourceResponse page = comicPage(document, Integer.parseInt(url.getLastPathSegment()));
                                if (page != null) return page;
                            }
                        }
                    } catch (IOException ignored) { }
                }
                WebResourceResponse response = loader.shouldInterceptRequest(url);
                return response != null ? response : new WebResourceResponse("text/plain", "UTF-8", 404,
                        "Not found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
        });
        return reader;
    }

    private void deleteFile() {
        File document = file;
        removeTemporaryFile(document);
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
