package com.praha.stream;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
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
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.ByteArrayInputStream;
import org.json.JSONObject;
import java.util.Locale;

/** A separate, unprivileged WebView: never attach Capacitor or any JavaScript bridge here. */
public final class ProtectedEmbedActivity extends Activity {
    static final String EXTRA_MOCTALE_METER = "moctale_meter";
    public static final String EXTRA_DIRECT_BOOK = "direct_book";
    public static final String EXTRA_URL = "embed_url";
    public static final String EXTRA_ARCHIVE_LOAN = "archive_loan";
    private WebView web;
    private WebView popup;
    private View bookView;
    private BookFileReader reader;
    private Button closeButton;
    private LinearLayout toolbar;
    private final Runnable pageTimeout = () -> {
        if (web != null) web.stopLoading();
        showPageError();
    };
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
    private boolean moctaleSite;
    private boolean moctaleMeterReturned;
    private boolean pageFailed;
    /** Shown until the player's first page finishes loading, then removed. */
    private TextView loading;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        initialUrl = getIntent().getStringExtra(EXTRA_URL);
        Uri target = initialUrl == null ? null : Uri.parse(initialUrl);
        if (!EmbedBlocklist.isPublicHttps(target) || initialUrl.length() > 4096) { finish(); return; }
        initialHost = target.getHost().toLowerCase(Locale.ROOT);
        moctaleSite = MoctalePageMeter.isTitle(target);
        archiveLoan = getIntent().getBooleanExtra(EXTRA_ARCHIVE_LOAN, false);
        directBook = getIntent().getBooleanExtra(EXTRA_DIRECT_BOOK, false)
                || (initialHost.equals("archive.org") && target.getPath() != null
                    && target.getPath().startsWith("/download/")
                    && BookFileReader.isBookDownload(initialUrl, null, null));
        comicSite = hostMatches(initialHost, "comics-all.com", "getcomics.org");
        bookSite = directBook || comicSite
                || hostMatches(initialHost, "annas-archive.gl", "theoceanofpdf.com", "oceanofpdf.com", "openlibrary.org");
        if (archiveLoan && !isArchiveItem(target)) { finish(); return; }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.BLACK);
        toolbar = new LinearLayout(this);
        toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        toolbar.setBackgroundColor(0xff15171b);
        closeButton = actionButton();
        closeButton.setText("Close");
        closeButton.setOnClickListener(v -> { if (fullScreen != null) hideFullScreen(); else if (reader != null && !directBook) closeBook(); else finish(); });
        Button browser = actionButton();
        browser.setText("Browser");
        browser.setOnClickListener(v -> {
            String currentUrl = web == null ? null : web.getUrl();
            openBrowser(currentUrl != null ? currentUrl : initialUrl);
        });
        siteActions = new LinearLayout(this);
        siteActions.addView(browser);
        toolbar.addView(closeButton);
        toolbar.addView(siteActions);
        if (!directBook && !moctaleSite) {
            Button reload = actionButton();
            reload.setText("Reload");
            reload.setOnClickListener(v -> {
                if (web == null) {
                    if (isBookPage() || filter != null) openPlayer();
                    else recreate();
                } else if (web.getUrl() == null) web.loadUrl(initialUrl);
                else web.reload();
            });
            siteActions.addView(reload);
        }
        if (moctaleSite) {
            Button title = actionButton();
            title.setText("Title");
            title.setOnClickListener(v -> { if (web != null) web.loadUrl(initialUrl); else openPlayer(); });
            siteActions.addView(title);
            Button meter = actionButton();
            meter.setText("Use Meter");
            meter.setOnClickListener(v -> readMoctaleMeter(0, true));
            siteActions.addView(meter);
        }
        layout.addView(toolbar);
        content = new FrameLayout(this);
        layout.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        loading = new TextView(this);
        loading.setText(moctaleSite ? "Opening Moctale…" : archiveLoan ? "Opening Internet Archive…" : bookSite ? "Opening book site…" : "Loading protected player…");
        loading.setTextColor(Color.WHITE);
        loading.setGravity(android.view.Gravity.CENTER);
        loading.setPadding(dp(18), dp(18), dp(18), dp(18));
        loading.setBackgroundColor(Color.BLACK);
        content.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(layout, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
        setContentView(layout);
        ViewCompat.requestApplyInsets(layout);
        if (isBookPage() || moctaleSite) {
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
                    if (filter.blocks(initialHost)) { loading.setText("This player is blocked by the host list. Choose another provider or use Browser."); content.addView(loading); return; }
                    openPlayer();
                });
            } catch (Exception error) {
                runOnUiThread(() -> { if (!destroyed) loading.setText("Unable to load the ad block list. Protected player not opened."); });
            }
        }, "embed-blocklist").start();
    }

    private int dp(int size) {
        return Math.round(size * getResources().getDisplayMetrics().density);
    }

    private Button actionButton() {
        Button button = new Button(this, null, android.R.attr.borderlessButtonStyle);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        return button;
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
        web.setBackgroundColor(Color.BLACK);
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
                web.setVisibility(View.INVISIBLE);
                toolbar.setVisibility(View.GONE);
                content.addView(view, new FrameLayout.LayoutParams(-1, -1));
            }
            @Override public void onHideCustomView() { hideFullScreen(); }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (moctaleSite) {
                    if (!EmbedBlocklist.isPublicHttps(uri)) return true;
                    return request.isForMainFrame() && !hostMatches(uri.getHost(), "moctale.in");
                }
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
                view.removeCallbacks(pageTimeout);
                view.postDelayed(pageTimeout, 25_000);
                loading.setText(moctaleSite ? "Opening Moctale…" : isBookPage() ? "Opening listing…" : "Loading player…");
                if (loading.getParent() == null) content.addView(loading, new FrameLayout.LayoutParams(-1, -1));
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                view.removeCallbacks(pageTimeout);
                if (!pageFailed && loading.getParent() != null) content.removeView(loading);
            }
            @Override public void onPageFinished(WebView view, String url) {
                view.removeCallbacks(pageTimeout);
                if (!pageFailed && loading.getParent() != null) content.removeView(loading);
                if (moctaleSite && MoctalePageMeter.isRequestedPage(url, initialUrl)) readMoctaleMeter(10, false);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { view.removeCallbacks(pageTimeout); showPageError(); }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) {
                    view.removeCallbacks(pageTimeout);
                    showPageError();
                }
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                view.removeCallbacks(pageTimeout);
                hideFullScreen();
                content.removeView(view);
                view.destroy();
                if (view == web) web = null;
                if (reader == null) showPageError();
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!EmbedBlocklist.isPublicHttps(uri) || (!isBookPage() && !moctaleSite && filter.blocks(uri.getHost()))) {
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
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(android.view.Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.setBackgroundColor(0xff101113);
        ProgressBar spinner = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        spinner.setMax(100);
        spinner.setIndeterminate(true);
        spinner.setProgressTintList(android.content.res.ColorStateList.valueOf(0xffffd364));
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xffffd364));
        panel.addView(spinner, new LinearLayout.LayoutParams(dp(220), dp(8)));
        TextView status = new TextView(this);
        boolean comic = comicSite || BookFileReader.isComicArchive(url, null, null);
        status.setText(comic ? "Opening comic…" : "Opening book…");
        status.setTextColor(Color.WHITE);
        status.setTypeface(android.graphics.Typeface.SANS_SERIF);
        status.setTextSize(16);
        status.setGravity(android.view.Gravity.CENTER);
        status.setPadding(0, dp(16), 0, dp(16));
        panel.addView(status);
        Button retry = actionButton();
        retry.setText("Retry");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> {
            closeBook();
            if (web != null) openBook(url, userAgent);
            else openPlayer();
        });
        panel.addView(retry);
        closeButton.setText(directBook ? "Back to PRAHA" : "Back to site");
        closeButton.setTypeface(android.graphics.Typeface.SANS_SERIF);
        siteActions.setVisibility(View.GONE);
        String referer = web.getUrl();
        web.removeCallbacks(pageTimeout);
        web.setVisibility(View.GONE);
        if (loading.getParent() != null) content.removeView(loading);
        bookView = panel;
        content.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        reader.open(url, userAgent, referer, view -> {
            content.removeView(panel);
            bookView = view;
            content.addView(view, new FrameLayout.LayoutParams(-1, -1));
        }, message -> {
            status.setText(message);
            spinner.setVisibility(View.GONE);
            retry.setVisibility(View.VISIBLE);
        }, message -> {
            status.setText(message);
            if (message.endsWith("%")) {
                String value = message.substring(message.lastIndexOf(' ') + 1, message.length() - 1);
                spinner.setIndeterminate(false);
                spinner.setProgress(Integer.parseInt(value));
            } else {
                spinner.setIndeterminate(true);
            }
        });
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

    private void readMoctaleMeter(int retries, boolean manual) {
        if (web == null || destroyed || moctaleMeterReturned) return;
        if (!MoctalePageMeter.isRequestedPage(web.getUrl(), initialUrl)) {
            if (manual) notifyMoctale("Open the title after signing in.");
            return;
        }

        String target = "https://www.moctale.in" + Uri.parse(initialUrl).getEncodedPath();
        try {
            web.evaluateJavascript(MoctalePageMeter.script(this, target), value -> {
                try {
                    JSONObject meter = MoctalePageMeter.validate(value, target);
                    if (destroyed || moctaleMeterReturned) return;
                    moctaleMeterReturned = true;
                    setResult(RESULT_OK, new Intent().putExtra(EXTRA_MOCTALE_METER, meter.toString()));
                    finish();
                } catch (Exception ignored) {
                    if (retries > 0 && web != null) web.postDelayed(() -> readMoctaleMeter(retries - 1, false), 650);
                    else if (manual) notifyMoctale("Moctale hasn’t shown all four percentages on this page yet.");
                }
            });
        } catch (Exception ignored) {
            if (manual) notifyMoctale("Could not read the Moctale Meter.");
        }
    }

    private void notifyMoctale(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show();
    }

    private void showPageError() {
        pageFailed = true;
        loading.setText(moctaleSite ? "Moctale could not load. Tap Title to retry or open it in Browser."
                : isBookPage() ? "The listing could not load. Tap Reload to retry or open it in Browser."
                : "The player could not load. Tap Reload, or close it and choose another provider.");
        if (loading.getParent() == null) content.addView(loading, new FrameLayout.LayoutParams(-1, -1));
    }

    private void hideFullScreen() {
        if (fullScreen == null) return;
        content.removeView(fullScreen); fullScreen = null;
        toolbar.setVisibility(View.VISIBLE);
        if (web != null) web.setVisibility(View.VISIBLE);
        if (fullScreenCallback != null) { fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null; }
    }
    @Override public void onBackPressed() {
        if (reader != null) { if (directBook) finish(); else closeBook(); return; }
        if (fullScreen != null) { hideFullScreen(); return; }
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }
    @Override protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }
    @Override protected void onDestroy() {
        destroyed = true; hideFullScreen();
        closeBook();
        if (popup != null) { popup.destroy(); popup = null; }
        if (web != null) { web.removeCallbacks(pageTimeout); content.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
