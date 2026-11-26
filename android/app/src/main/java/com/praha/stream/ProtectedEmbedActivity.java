package com.praha.stream;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.ByteArrayInputStream;
import java.util.Locale;

/** A separate, unprivileged WebView: never attach Capacitor or any JavaScript bridge here. */
public final class ProtectedEmbedActivity extends Activity {
    public static final String EXTRA_URL = "embed_url";
    public static final String EXTRA_ARCHIVE_LOAN = "archive_loan";
    private WebView web;
    private WebView popup;
    private View bookView;
    private BookFileReader reader;
    private Button closeButton;
    private LinearLayout siteActions;
    private FrameLayout content;
    private View fullScreen;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private EmbedBlocklist filter;
    private String initialHost;
    private String initialUrl;
    private boolean destroyed;
    private boolean archiveLoan;
    private boolean bookSite;
    private boolean comicSite;
    private boolean directBook;
    private boolean pageFailed;
    /** Shown until the player's first page finishes loading, then removed. */
    private TextView loading;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        initialUrl = getIntent().getStringExtra(EXTRA_URL);
        Uri target = initialUrl == null ? null : Uri.parse(initialUrl);
        if (!EmbedBlocklist.isPublicHttps(target) || initialUrl.length() > 4096) { finish(); return; }
        initialHost = target.getHost().toLowerCase(Locale.ROOT);
        archiveLoan = getIntent().getBooleanExtra(EXTRA_ARCHIVE_LOAN, false);
        directBook = initialHost.equals("archive.org") && target.getPath() != null
                && target.getPath().startsWith("/download/")
                && BookFileReader.isBookDownload(initialUrl, null, null);
        comicSite = hostMatches(initialHost, "comics-all.com", "comicsnake.com", "getcomics.org");
        bookSite = directBook || comicSite
                || hostMatches(initialHost, "annas-archive.gl", "theoceanofpdf.com", "oceanofpdf.com", "openlibrary.org");
        if (archiveLoan && !isArchiveItem(target)) { finish(); return; }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.BLACK);
        LinearLayout bar = new LinearLayout(this);
        closeButton = new Button(this);
        closeButton.setText("Close");
        closeButton.setOnClickListener(v -> { if (reader != null && !directBook) closeBook(); else finish(); });
        Button browser = new Button(this);
        browser.setText(isBookPage() ? "Open in browser" : "Browser (unfiltered)");
        browser.setOnClickListener(v -> {
            String currentUrl = web == null ? null : web.getUrl();
            openBrowser(currentUrl != null ? currentUrl : initialUrl);
        });
        siteActions = new LinearLayout(this);
        siteActions.addView(browser);
        bar.addView(closeButton);
        bar.addView(siteActions);
        if (isBookPage()) {
            Button reload = new Button(this);
            reload.setText("Reload");
            reload.setOnClickListener(v -> { if (web != null) web.reload(); });
            siteActions.addView(reload);
        }
        layout.addView(bar);
        content = new FrameLayout(this);
        layout.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        loading = new TextView(this);
        loading.setText(archiveLoan ? "Opening Internet Archive…" : bookSite ? "Opening book site…" : "Loading protected player…");
        loading.setTextColor(Color.WHITE);
        loading.setBackgroundColor(Color.BLACK);
        content.addView(loading);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(layout, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
        setContentView(layout);
        ViewCompat.requestApplyInsets(layout);
        if (isBookPage()) {
            openPlayer();
            return;
        }
        // Fail closed if the filter cannot be loaded; never start an unfiltered WebView by accident.
        new Thread(() -> {
            try {
                EmbedBlocklist loaded = new EmbedBlocklist(getApplicationContext());
                runOnUiThread(() -> {
                    if (destroyed || isFinishing()) return;
                    filter = loaded;
                    content.removeAllViews();
                    if (filter.blocks(initialHost)) { loading.setText("This player is blocked by the host list. Use Browser (unfiltered) if you trust it."); content.addView(loading); return; }
                    openPlayer();
                });
            } catch (Exception error) {
                runOnUiThread(() -> { if (!destroyed) loading.setText("Unable to load the ad block list. Protected player not opened."); });
            }
        }, "embed-blocklist").start();
    }

    private static boolean hostMatches(String host, String... domains) {
        for (String domain : domains) {
            if (host.equals(domain) || host.endsWith("." + domain)) return true;
        }
        return false;
    }

    private boolean isBookPage() {
        return archiveLoan || bookSite;
    }

    private boolean isReaderFile(String url, String disposition, String mime) {
        return BookFileReader.isBookDownload(url, disposition, mime)
                || (comicSite && BookFileReader.isComicArchive(url, disposition, mime));
    }

    private void openBrowser(String url) {
        Uri uri = Uri.parse(url);
        if (!EmbedBlocklist.isPublicHttps(uri)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception ignored) { }
    }

    static boolean isArchiveItem(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "archive.org".equalsIgnoreCase(uri.getHost())
                && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getPath() != null && uri.getPath().matches("/details/[A-Za-z0-9._-]+");
    }

    private void openPlayer() {
        web = new WebView(this); // No addJavascriptInterface or Capacitor bridge.
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        web.setDownloadListener((url, userAgent, disposition, mimetype, length) -> {
            if (!bookSite) return;
            if (isReaderFile(url, disposition, mimetype)) openBook(url, userAgent);
            else android.widget.Toast.makeText(this, comicSite ? "Choose a CBZ, CBR, ZIP, RAR, or PDF to read in PRAHA."
                    : "Choose a PDF, EPUB, or CBZ to read in PRAHA.", android.widget.Toast.LENGTH_SHORT).show();
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message resultMsg) {
                if (!bookSite || !gesture) return false;
                if (popup != null) popup.destroy();
                WebView child = new WebView(ProtectedEmbedActivity.this);
                popup = child;
                child.getSettings().setAllowFileAccess(false);
                child.getSettings().setAllowContentAccess(false);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                        if (request.isForMainFrame()) acceptBookLink(child, request.getUrl());
                        return true;
                    }
                    @Override public void onPageStarted(WebView source, String url, android.graphics.Bitmap favicon) {
                        if (!"about:blank".equals(url)) acceptBookLink(child, Uri.parse(url));
                    }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView source, WebResourceRequest request) {
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(child);
                resultMsg.sendToTarget();
                return true;
            }
            @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreen != null) { callback.onCustomViewHidden(); return; }
                fullScreen = view; fullScreenCallback = callback;
                web.setVisibility(View.GONE);
                content.addView(view, new FrameLayout.LayoutParams(-1, -1));
            }
            @Override public void onHideCustomView() { hideFullScreen(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isBookPage()) {
                    if (!EmbedBlocklist.isPublicHttps(uri)) return true;
                    if (!request.isForMainFrame()) return false;
                    String host = uri.getHost().toLowerCase(Locale.ROOT);
                    boolean sameSite = host.equals(initialHost) || host.endsWith("." + initialHost);
                    if (archiveLoan && (host.equals("openlibrary.org") || host.endsWith(".archive.org"))) return false;
                    if (bookSite && "GET".equals(request.getMethod())
                            && (sameSite || request.hasGesture() || request.isRedirect())) {
                        if (isReaderFile(uri.toString(), null, null)) {
                            openBook(uri.toString(), web.getSettings().getUserAgentString());
                            return true;
                        }
                        return false;
                    }
                    return !sameSite;
                }
                if (!EmbedBlocklist.isPublicHttps(uri) || filter.blocks(uri.getHost())) return true;
                // Prevent same-tab ad redirects from taking over the player, but
                // let the player itself work. Embed hosts routinely bounce the
                // main frame to a second host to reach the actual stream, and
                // blocking every cross-host navigation left those players blank.
                // Ads arrive as silent script redirects, so a real tap is what
                // separates them from a legitimate hand-off.
                if (request.isForMainFrame()) {
                    String host = uri.getHost().toLowerCase(Locale.ROOT);
                    if (host.equals(initialHost) || host.endsWith("." + initialHost)) return false;
                    return !request.hasGesture();
                }
                return false;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageFailed = false;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!pageFailed && loading.getParent() != null) content.removeView(loading);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && isBookPage()) showPageError();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame() && isBookPage()) showPageError();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!EmbedBlocklist.isPublicHttps(uri) || (!isBookPage() && filter.blocks(uri.getHost()))) {
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });
        content.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        if (directBook) openBook(initialUrl, settings.getUserAgentString());
        else web.loadUrl(initialUrl);
    }
    private void acceptBookLink(WebView child, Uri uri) {
        if (popup != child) return;
        popup = null;
        child.stopLoading();
        web.post(child::destroy);
        if (!EmbedBlocklist.isPublicHttps(uri)) return;
        if (isReaderFile(uri.toString(), null, null)) {
            openBook(uri.toString(), web.getSettings().getUserAgentString());
        } else {
            web.loadUrl(uri.toString());
        }
    }

    private void openBook(String url, String userAgent) {
        if (reader != null || url == null || !EmbedBlocklist.isPublicHttps(Uri.parse(url))) return;
        reader = new BookFileReader(this);
        TextView status = new TextView(this);
        status.setText(comicSite ? "Opening comic…" : "Opening book…");
        status.setTextColor(Color.WHITE);
        status.setGravity(android.view.Gravity.CENTER);
        status.setPadding(24, 24, 24, 24);
        status.setBackgroundColor(Color.BLACK);
        closeButton.setText(directBook ? "Back to PRAHA" : "Back to site");
        siteActions.setVisibility(View.GONE);
        String referer = web.getUrl();
        web.setVisibility(View.GONE);
        bookView = status;
        content.addView(status, new FrameLayout.LayoutParams(-1, -1));
        reader.open(url, userAgent, referer, view -> {
            content.removeView(status);
            bookView = view;
            content.addView(view, new FrameLayout.LayoutParams(-1, -1));
        }, status::setText);
    }

    private void closeBook() {
        if (reader == null) return;
        if (bookView != null) content.removeView(bookView);
        reader.close();
        reader = null;
        bookView = null;
        closeButton.setText("Close");
        siteActions.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.VISIBLE);
    }

    private void showPageError() {
        pageFailed = true;
        loading.setText("The site could not load. Tap Reload or Open in browser.");
        if (loading.getParent() == null) content.addView(loading);
    }

    private void hideFullScreen() {
        if (fullScreen == null) return;
        content.removeView(fullScreen); fullScreen = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        if (fullScreenCallback != null) { fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null; }
    }
    @Override public void onBackPressed() {
        if (reader != null) { if (directBook) finish(); else closeBook(); return; }
        if (fullScreen != null) { hideFullScreen(); return; }
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }
    @Override protected void onDestroy() {
        destroyed = true; hideFullScreen();
        closeBook();
        if (popup != null) { popup.destroy(); popup = null; }
        if (web != null) { content.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
