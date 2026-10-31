package com.praha.stream;

import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private final PrahaStreamProxy streamProxy = new PrahaStreamProxy();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        streamProxy.start();

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#090A0C"));
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setDomStorageEnabled(true);
            webView.addJavascriptInterface(new PrahaJsBridge(), "PrahaNative");
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('praha:hardware-back'));",
                            null
                    );
                } else {
                    finish();
                }
            }
        });
    }

    @Override
    public void onDestroy() {
        streamProxy.stop();
        super.onDestroy();
    }

    public class PrahaJsBridge {
        @JavascriptInterface
        public boolean isAndroid() {
            return true;
        }

        @JavascriptInterface
        public boolean isTelevision() {
            UiModeManager uiModeManager = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
            return uiModeManager != null
                    && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        }

        @JavascriptInterface
        public int getProxyPort() {
            return streamProxy.getPort();
        }

        @JavascriptInterface
        public String proxyStreamUrl(String url, String headersJson) {
            return streamProxy.buildProxyUrl(url, headersJson);
        }

        @JavascriptInterface
        public String httpRequest(String urlString, String method, String headersJson, String body) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(18000);
                conn.setReadTimeout(22000);
                String verb = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
                conn.setRequestMethod(verb);

                boolean hasUa = false;
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headers.optString(key, "");
                        if (!value.isEmpty()) {
                            conn.setRequestProperty(key, value);
                            if ("user-agent".equalsIgnoreCase(key)) hasUa = true;
                        }
                    }
                }
                if (!hasUa) {
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                }

                if (body != null && !body.isEmpty() && ("POST".equals(verb) || "PUT".equals(verb) || "PATCH".equals(verb))) {
                    conn.setDoOutput(true);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(payload);
                    }
                }

                int status = conn.getResponseCode();
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = "";
                if (in != null) {
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        bos.write(buf, 0, n);
                    }
                    text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                }

                JSONObject result = new JSONObject();
                result.put("ok", status >= 200 && status < 300);
                result.put("status", status);
                result.put("body", text);
                return result.toString();
            } catch (Exception e) {
                try {
                    JSONObject err = new JSONObject();
                    err.put("ok", false);
                    err.put("status", 0);
                    err.put("error", e.getMessage() != null ? e.getMessage() : "Native HTTP error");
                    return err.toString();
                } catch (Exception ignored) {
                    return "{\"ok\":false,\"status\":0,\"error\":\"Native HTTP error\"}";
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @JavascriptInterface
        public void setImmersiveMode(final boolean immersive, final boolean lockLandscape) {
            runOnUiThread(() -> {
                try {
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                    if (immersive) {
                        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        if (controller != null) {
                            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                            controller.hide(WindowInsetsCompat.Type.systemBars());
                        }
                        if (lockLandscape) {
                            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                        }
                    } else {
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        if (controller != null) {
                            controller.show(WindowInsetsCompat.Type.systemBars());
                        }
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    }
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public boolean enterPip() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                final boolean[] ok = {false};
                runOnUiThread(() -> {
                    try {
                        PictureInPictureParams params = new PictureInPictureParams.Builder()
                                .setAspectRatio(new Rational(16, 9))
                                .build();
                        enterPictureInPictureMode(params);
                    } catch (Exception ignored) {
                    }
                });
                ok[0] = true;
                return ok[0];
            }
            return false;
        }

        @JavascriptInterface
        public boolean openExternalPlayer(String url, String title, String packageName, String headersJson) {
            if (url == null || url.isEmpty()) return false;
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                Uri uri = Uri.parse(url);
                if (url.startsWith("magnet:")) {
                    intent.setData(uri);
                } else {
                    intent.setDataAndType(uri, "video/*");
                }
                if (title != null && !title.isEmpty()) {
                    intent.putExtra("title", title);
                    intent.putExtra(Intent.EXTRA_TITLE, title);
                }
                if (headersJson != null && !headersJson.isEmpty()) {
                    try {
                        JSONObject hdrs = new JSONObject(headersJson);
                        List<String> flat = new ArrayList<>();
                        Iterator<String> keys = hdrs.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            String v = hdrs.optString(k, "");
                            if (!v.isEmpty()) {
                                flat.add(k);
                                flat.add(v);
                            }
                        }
                        if (!flat.isEmpty()) {
                            intent.putExtra("headers", flat.toArray(new String[0]));
                        }
                    } catch (Exception ignored) {
                    }
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                if (packageName != null && !packageName.isEmpty()) {
                    intent.setPackage(packageName);
                    try {
                        startActivity(intent);
                        return true;
                    } catch (Exception ignored) {
                        intent.setPackage(null);
                    }
                }

                Intent chooser = Intent.createChooser(intent, "Play with");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean shareText(String filename, String content) {
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("application/json");
                send.putExtra(Intent.EXTRA_SUBJECT, filename != null ? filename : "praha-backup.json");
                send.putExtra(Intent.EXTRA_TEXT, content);
                Intent chooser = Intent.createChooser(send, "Export PRAHA Backup");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    finishAndRemoveTask();
                } else {
                    finish();
                }
            });
        }
    }
}
