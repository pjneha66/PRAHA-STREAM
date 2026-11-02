package com.praha.stream;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.util.Locale;

/** A separate, unprivileged WebView: never attach Capacitor or any JavaScript bridge here. */
public final class ProtectedEmbedActivity extends Activity {
    public static final String EXTRA_URL = "embed_url";
    private WebView web;
    private FrameLayout content;
    private View fullScreen;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private EmbedBlocklist filter;
    private String initialHost;
    private String initialUrl;
    private boolean destroyed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        initialUrl = getIntent().getStringExtra(EXTRA_URL);
        Uri target = initialUrl == null ? null : Uri.parse(initialUrl);
        if (!EmbedBlocklist.isPublicHttps(target) || initialUrl.length() > 4096) { finish(); return; }
        initialHost = target.getHost().toLowerCase(Locale.ROOT);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.BLACK);
        LinearLayout bar = new LinearLayout(this);
        Button close = new Button(this); close.setText("Close"); close.setOnClickListener(v -> finish());
        Button browser = new Button(this); browser.setText("Browser (unfiltered)");
        browser.setOnClickListener(v -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(initialUrl)).addCategory(Intent.CATEGORY_BROWSABLE)); } catch (Exception ignored) { } });
        bar.addView(close); bar.addView(browser);
        layout.addView(bar);
        content = new FrameLayout(this);
        layout.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        TextView loading = new TextView(this); loading.setText("Loading protected player…"); loading.setTextColor(Color.WHITE); content.addView(loading);
        setContentView(layout);
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
        web.setDownloadListener((url, userAgent, disposition, mimetype, length) -> { });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message resultMsg) { return false; }
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
                if (!EmbedBlocklist.isPublicHttps(uri) || filter.blocks(uri.getHost())) return true;
                // Prevent same-tab ad redirects from taking over the player.
                if (request.isForMainFrame()) {
                    String host = uri.getHost().toLowerCase(Locale.ROOT);
                    return !(host.equals(initialHost) || host.endsWith("." + initialHost));
                }
                return false;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!EmbedBlocklist.isPublicHttps(uri) || filter.blocks(uri.getHost())) {
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(initialUrl);
    }
    private void hideFullScreen() {
        if (fullScreen == null) return;
        content.removeView(fullScreen); fullScreen = null;
        if (web != null) web.setVisibility(View.VISIBLE);
        if (fullScreenCallback != null) { fullScreenCallback.onCustomViewHidden(); fullScreenCallback = null; }
    }
    @Override public void onBackPressed() {
        if (fullScreen != null) { hideFullScreen(); return; }
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }
    @Override protected void onDestroy() {
        destroyed = true; hideFullScreen();
        if (web != null) { content.removeView(web); web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
