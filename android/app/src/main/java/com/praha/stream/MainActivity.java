package com.praha.stream;

import android.app.DownloadManager;
import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;
import org.videolan.libvlc.util.VLCVideoLayout;

import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private final PrahaStreamProxy streamProxy = new PrahaStreamProxy();
    private final ExecutorService httpExecutor = Executors.newCachedThreadPool();
    private PrahaVlcPlayer vlcPlayer;
    private VLCVideoLayout vlcVideoLayout;
    private ActivityResultLauncher<Intent> subtitlePickerLauncher;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        streamProxy.start();

        subtitlePickerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                        Intent data = result.getData();
                        Uri uri = data.getData();
                        if (uri != null) {
                            try {
                                final int takeFlags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                getContentResolver().takePersistableUriPermission(uri, takeFlags);
                            } catch (Exception ignored) {}
                            if (vlcPlayer != null) {
                                vlcPlayer.addSlave(0, uri.toString(), true);
                            }
                            if (getBridge() != null && getBridge().getWebView() != null) {
                                try {
                                    JSONObject obj = new JSONObject();
                                    obj.put("uri", uri.toString());
                                    String name = uri.getLastPathSegment();
                                    obj.put("name", name != null ? name : "External Subtitle");
                                    String js = String.format("window.dispatchEvent(new CustomEvent('praha:vlc-subtitle-picked', { detail: %s }));", obj.toString());
                                    getBridge().getWebView().evaluateJavascript(js, null);
                                } catch (Exception ignored) {}
                            }
                        }
                    }
                }
        );

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#090A0C"));
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setDomStorageEnabled(true);
            webView.addJavascriptInterface(new PrahaJsBridge(), "PrahaNative");

            FrameLayout root = findViewById(android.R.id.content);
            if (root != null) {
                vlcVideoLayout = new VLCVideoLayout(this);
                vlcVideoLayout.setLayoutParams(new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                ));
                vlcVideoLayout.setVisibility(View.GONE);
                root.addView(vlcVideoLayout, 0);
                vlcPlayer = new PrahaVlcPlayer(this);
                vlcPlayer.init(vlcVideoLayout, webView);
            }
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
    public void onPause() {
        super.onPause();
        if (vlcPlayer != null && vlcPlayer.isPlaying()) {
            vlcPlayer.pause();
        }
    }

    @Override
    public void onDestroy() {
        if (vlcPlayer != null) {
            vlcPlayer.release();
        }
        streamProxy.stop();
        httpExecutor.shutdownNow();
        super.onDestroy();
    }

    public class PrahaJsBridge {
        @JavascriptInterface
        public boolean isAndroid() {
            return true;
        }

        /** Open third-party embeds in a separate WebView without the native bridge. */
        @JavascriptInterface
        public boolean openProtectedEmbed(String url) {
            try {
                if (url == null || url.length() > 4096 || !EmbedBlocklist.isPublicHttps(Uri.parse(url))) return false;
                Intent intent = new Intent(MainActivity.this, ProtectedEmbedActivity.class);
                intent.putExtra(ProtectedEmbedActivity.EXTRA_URL, url);
                startActivity(intent);
                return true;
            } catch (Exception ignored) { return false; }
        }

        /** Open system settings; only the user can change Android Private DNS. */
        @JavascriptInterface
        public boolean openPrivateDnsSettings() {
            String[] actions = {
                    "android.settings.PRIVATE_DNS_SETTINGS",
                    android.provider.Settings.ACTION_WIRELESS_SETTINGS,
                    android.provider.Settings.ACTION_SETTINGS
            };
            for (String action : actions) {
                try {
                    startActivity(new Intent(action));
                    return true;
                } catch (Exception ignored) {
                    // Some Android and TV variants do not expose a Private DNS page.
                }
            }
            return false;
        }

        @JavascriptInterface
        public boolean openBrowser(String url) {
            try {
                Uri uri = Uri.parse(url);
                if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) return false;
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                startActivity(intent);
                return true;
            } catch (Exception ignored) { return false; }
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
        public void httpRequestAsync(final String requestId, final String urlString, final String method, final String headersJson, final String body, final int timeoutMs) {
            httpExecutor.execute(() -> {
                HttpURLConnection conn = null;
                JSONObject result = new JSONObject();
                try {
                    URL url = new URL(urlString);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(true);
                    int timeout = (timeoutMs > 0) ? timeoutMs : 15000;
                    conn.setConnectTimeout(timeout);
                    conn.setReadTimeout(timeout);
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

                    result.put("ok", status >= 200 && status < 300);
                    result.put("status", status);
                    result.put("body", text);
                } catch (Exception e) {
                    try {
                        result.put("ok", false);
                        result.put("status", 0);
                        result.put("error", e.getMessage() != null ? e.getMessage() : "Native HTTP error");
                    } catch (Exception ignored) {}
                } finally {
                    if (conn != null) conn.disconnect();
                }

                deliverHttpCallback(requestId, result);
            });
        }

        private void deliverHttpCallback(final String requestId, final JSONObject result) {
            runOnUiThread(() -> {
                try {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        String js = "window.__prahaNativeHttpCallback && window.__prahaNativeHttpCallback(" 
                            + JSONObject.quote(requestId) + ", " 
                            + JSONObject.quote(result.toString()) + ");";
                        getBridge().getWebView().evaluateJavascript(js, null);
                    }
                } catch (Exception e) {
                    android.util.Log.e("PrahaBridge", "Error delivering HTTP callback", e);
                }
            });
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
        public String getAllAudioTracks() {
            if (vlcPlayer == null) return "[]";
            return vlcPlayer.getAllAudioTracks();
        }

        @JavascriptInterface
        public int getSelectedAudioTrack() {
            if (vlcPlayer == null) return -1;
            return vlcPlayer.getSelectedAudioTrack();
        }

        @JavascriptInterface
        public boolean setAudioTrack(int id) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.setAudioTrack(id);
        }

        @JavascriptInterface
        public String getAllSpuTracks() {
            if (vlcPlayer == null) return "[]";
            return vlcPlayer.getAllSpuTracks();
        }

        @JavascriptInterface
        public int getSelectedSpuTrack() {
            if (vlcPlayer == null) return -1;
            return vlcPlayer.getSelectedSpuTrack();
        }

        @JavascriptInterface
        public boolean setSpuTrack(int id) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.setSpuTrack(id);
        }

        @JavascriptInterface
        public boolean addSlave(int type, String uri, boolean select) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.addSlave(type, uri, select);
        }

        @JavascriptInterface
        public boolean setSpuDelay(long delayMicros) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.setSpuDelay(delayMicros);
        }

        @JavascriptInterface
        public long getSpuDelay() {
            if (vlcPlayer == null) return 0;
            return vlcPlayer.getSpuDelay();
        }

        @JavascriptInterface
        public boolean setAudioDelay(long delayMicros) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.setAudioDelay(delayMicros);
        }

        @JavascriptInterface
        public long getAudioDelay() {
            if (vlcPlayer == null) return 0;
            return vlcPlayer.getAudioDelay();
        }

        @JavascriptInterface
        public boolean openSubtitlePicker() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    String[] mimeTypes = new String[]{
                            "text/*",
                            "application/x-subrip",
                            "application/octet-stream",
                            "text/vtt",
                            "text/plain"
                    };
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
                    subtitlePickerLauncher.launch(intent);
                } catch (Exception ignored) {}
            });
            return true;
        }

        @JavascriptInterface
        public boolean vlcPlay(String url, String headersJson, long resumeMs) {
            if (vlcPlayer == null) return false;
            runOnUiThread(() -> {
                boolean ok = vlcPlayer.play(url, headersJson, resumeMs);
                if (ok && getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
                }
            });
            return true;
        }

        @JavascriptInterface
        public void vlcPause() {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.pause();
            });
        }

        @JavascriptInterface
        public void vlcResume() {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.resume();
            });
        }

        @JavascriptInterface
        public void vlcStop() {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.stop();
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().setBackgroundColor(Color.parseColor("#090A0C"));
                }
            });
        }

        @JavascriptInterface
        public void vlcSeek(long timeMs) {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.seek(timeMs);
            });
        }

        @JavascriptInterface
        public void vlcSetVolume(int volume) {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.setVolume(volume);
            });
        }

        @JavascriptInterface
        public void vlcSetRate(float rate) {
            runOnUiThread(() -> {
                if (vlcPlayer != null) vlcPlayer.setRate(rate);
            });
        }

        @JavascriptInterface
        public boolean vlcSetAspectRatio(String aspect) {
            if (vlcPlayer == null) return false;
            return vlcPlayer.setAspectRatio(aspect);
        }

        @JavascriptInterface
        public String getAppVersionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "2.5.2";
            }
        }

        @JavascriptInterface
        public boolean isVlcAvailable() {
            return vlcPlayer != null && vlcPlayer.isAvailable();
        }

        @JavascriptInterface
        public boolean isVlcPlaying() {
            return vlcPlayer != null && vlcPlayer.isPlaying();
        }

        @JavascriptInterface
        public boolean downloadAndInstallUpdate(final String apkUrl, final String versionName) {
            if (apkUrl == null || apkUrl.isEmpty()) return false;
            runOnUiThread(() -> {
                try {
                    File downloadDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (downloadDir != null) {
                        File stale = new File(downloadDir, "praha-update.apk");
                        if (stale.exists()) {
                            stale.delete();
                        }
                    }

                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Uri uri = Uri.parse(apkUrl);
                    DownloadManager.Request request = new DownloadManager.Request(uri);
                    request.setTitle("PRAHA Stream " + (versionName != null ? versionName : "Update"));
                    request.setDescription("Downloading latest release APK...");
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalFilesDir(MainActivity.this, Environment.DIRECTORY_DOWNLOADS, "praha-update.apk");
                    request.setMimeType("application/vnd.android.package-archive");
                    final long downloadId = dm.enqueue(request);

                    BroadcastReceiver onComplete = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context ctxt, Intent intent) {
                            try {
                                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                                if (id == downloadId) {
                                    File file = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "praha-update.apk");
                                    if (file.exists() && file.length() > 0) {
                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                            if (!getPackageManager().canRequestPackageInstalls()) {
                                                Intent allowIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                                allowIntent.setData(Uri.parse("package:" + getPackageName()));
                                                allowIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                                startActivity(allowIntent);
                                            }
                                        }

                                        Uri apkUri = FileProvider.getUriForFile(
                                                MainActivity.this,
                                                getPackageName() + ".fileprovider",
                                                file
                                        );
                                        Intent install = new Intent(Intent.ACTION_VIEW);
                                        install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                                        install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                        startActivity(install);
                                    }
                                }
                            } catch (Exception e) {
                                openBrowser(apkUrl);
                            }
                        }
                    };
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_EXPORTED);
                    } else {
                        registerReceiver(onComplete, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
                    }
                } catch (Exception e) {
                    openBrowser(apkUrl);
                }
            });
            return true;
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
