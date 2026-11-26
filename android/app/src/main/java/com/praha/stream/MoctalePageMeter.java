package com.praha.stream;

import android.app.Activity;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/** Reads only the visible Meter on an exact Moctale title page. */
final class MoctalePageMeter {
    private static final String[] LABELS = { "Perfection", "Go for it", "Timepass", "Skip" };
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView page;
    private String activeUrl;

    static boolean isTitle(Uri uri) {
        return EmbedBlocklist.isPublicHttps(uri) && "www.moctale.in".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null
                && uri.getPath() != null && uri.getPath().matches("/content/[^/]+-\\d{4}");
    }

    static boolean isRequestedPage(String current, String target) {
        if (current == null || target == null) return false;
        Uri uri = Uri.parse(current);
        return isTitle(uri) && Uri.parse(target).getEncodedPath().equals(uri.getEncodedPath());
    }

    static String script(Activity activity, String target) throws Exception {
        try (BufferedReader asset = new BufferedReader(new InputStreamReader(
                activity.getAssets().open("moctale-meter.js"), StandardCharsets.UTF_8))) {
            return "(" + asset.lines().collect(Collectors.joining("\n")) + ")(" + JSONObject.quote(target) + ")";
        }
    }

    static JSONObject validate(String value, String target) throws Exception {
        JSONObject result = new JSONObject(value);
        JSONArray buckets = result.getJSONArray("buckets");
        if (buckets.length() != LABELS.length) throw new IllegalArgumentException();
        JSONArray scores = new JSONArray();
        double total = 0;
        for (int i = 0; i < LABELS.length; i++) {
            JSONObject bucket = buckets.getJSONObject(i);
            double percent = bucket.getDouble("percent");
            if (!LABELS[i].equals(bucket.getString("label")) || !Double.isFinite(percent)
                    || percent < 0 || percent > 100) throw new IllegalArgumentException();
            total += percent;
            scores.put(new JSONObject().put("label", LABELS[i]).put("percent", percent)
                    .put("lessThan", bucket.optBoolean("lessThan")));
        }
        if (total < 96 || total > 104) throw new IllegalArgumentException();
        JSONObject meter = new JSONObject().put("state", "ready").put("url", target)
                .put("buckets", scores).put("noReviews", result.optBoolean("noReviews"));
        int score = result.optInt("score", -1);
        int votes = result.optInt("votes", 0);
        if (score >= 0 && score <= 100 && votes > 0) meter.put("score", score).put("votes", votes);
        return meter;
    }

    void load(Activity activity, String url, Consumer<JSONObject> receive) {
        cancel(null);
        if (activity.isFinishing() || activity.isDestroyed()) return;
        try {
            String target = "https://www.moctale.in" + Uri.parse(url).getEncodedPath();
            String extractor = script(activity, target);
            WebView probe = new WebView(activity);
            page = probe;
            activeUrl = url;
            WebSettings settings = probe.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            probe.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            probe.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return request.isForMainFrame() && !isRequestedPage(request.getUrl().toString(), target);
                }

                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    if (EmbedBlocklist.isPublicHttps(request.getUrl())) return null;
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
            });
            float density = activity.getResources().getDisplayMetrics().density;
            int width = Math.round(400 * density);
            int height = Math.round(700 * density);
            probe.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
            probe.layout(0, 0, width, height);
            probe.loadUrl(target);
            long deadline = SystemClock.elapsedRealtime() + 10_000;
            handler.postDelayed(() -> poll(probe, target, extractor, deadline, receive), 500);
        } catch (Exception ignored) {
            cancel(null);
        }
    }

    private void poll(WebView probe, String target, String extractor, long deadline, Consumer<JSONObject> receive) {
        if (page != probe) return;
        if (SystemClock.elapsedRealtime() >= deadline) {
            cancel(null);
            return;
        }
        Runnable again = () -> poll(probe, target, extractor, deadline, receive);
        if (!isRequestedPage(probe.getUrl(), target)) {
            handler.postDelayed(again, 500);
            return;
        }
        probe.evaluateJavascript(extractor, value -> {
            if (page != probe) return;
            try {
                JSONObject result = validate(value, target);
                cancel(null);
                receive.accept(result);
            } catch (Exception ignored) {
                handler.postDelayed(again, 500);
            }
        });
    }

    void cancel(String url) {
        if (url != null && !url.equals(activeUrl)) return;
        handler.removeCallbacksAndMessages(null);
        WebView previous = page;
        page = null;
        activeUrl = null;
        if (previous == null) return;
        previous.stopLoading();
        previous.destroy();
    }
}
