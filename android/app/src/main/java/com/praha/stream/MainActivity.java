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
import android.net.VpnService;
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
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebViewCompat.WebMessageListener;

import com.praha.stream.mpv.PrahaMpvPlugin;
import com.praha.stream.media3.PrahaMedia3Plugin;
import com.praha.stream.torr.PrahaTorrServerPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import android.view.View;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public class MainActivity extends com.lagradost.cloudstream3.MainActivity {
    private final PrahaStreamProxy streamProxy = new PrahaStreamProxy();
    // The full bridge instance used for RPC dispatch on the origin-gated path.
    // It is intentionally NOT injected into JavaScript on that path; only the
    // read-only wrapper is.
    private final PrahaJsBridge rpcBridge = new PrahaJsBridge();
    // Bounded pool: the bridge is reachable from JS and the proxy from any local
    // client, so an unbounded cached pool is a trivial thread/OOM DoS.
    // CallerRunsPolicy is forbidden here: onPostMessage (the bridge entry point)
    // runs on the Android UI thread, so a saturated pool would execute entire
    // HTTP requests on the main thread and freeze the whole app. Rejection is
    // answered with a fast error reply instead (see the httpRequest dispatch).
    private final ExecutorService httpExecutor = new ThreadPoolExecutor(
            6, 6, 30L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<Runnable>(96),
            new ThreadPoolExecutor.AbortPolicy());
    /**
     * Extension calls get their own pool. An extension can block for the whole
     * source timeout (45s by default, and several at once), so sharing
     * [httpExecutor] would let a few slow extensions starve the app's own HTTP
     * bridge. Small on purpose: extension work is already parallelised inside
     * CsEngine, this is only the bridge's fan-out.
     */
    private final ExecutorService csExecutor = new ThreadPoolExecutor(
            4, 4, 30L, TimeUnit.SECONDS,
            new LinkedBlockingQueue<Runnable>(64),
            new ThreadPoolExecutor.AbortPolicy());
    private ActivityResultLauncher<Intent> subtitlePickerLauncher;
    /**
     * Picking a .cs3 has to happen natively: the file lives behind a content://
     * uri that CsBridge.sideload reads through the content resolver, and a WebView
     * <input type="file"> cannot hand that uri over.
     */
    private ActivityResultLauncher<Intent> csPluginPickerLauncher;
    private ActivityResultLauncher<Intent> vpnConsentLauncher;
    /** Resolver to use once consent is granted. */
    private volatile String pendingVpnDns = "1.1.1.1";

    /**
     * Stream, addon and scraper URLs are attacker-controlled. Only absolute
     * http(s) URLs without embedded credentials may reach a native sink.
     * `allowHttp` stays true for playback (many CDNs and LAN IPTV portals are
     * still plain HTTP) and is false for APK downloads.
     */
    private boolean isAllowedRemoteUrl(String raw, boolean allowHttp) {
        if (raw == null || raw.trim().isEmpty()) return false;
        try {
            URI uri = new URI(raw.trim());
            String scheme = uri.getScheme();
            if (scheme == null) return false;
            String lower = scheme.toLowerCase();
            boolean schemeOk = allowHttp
                    ? (lower.equals("http") || lower.equals("https"))
                    : lower.equals("https");
            if (!schemeOk) return false;
            if (uri.getUserInfo() != null) return false;
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return false;
            // Block the cloud metadata endpoint and our own proxy port, which
            // would otherwise let a caller amplify requests through the app.
            if ("169.254.169.254".equals(host)) return false;
            int proxyPort = streamProxy.getPort();
            if (proxyPort > 0 && uri.getPort() == proxyPort
                    && ("127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host))) {
                return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Stricter sibling of {@link #isAllowedRemoteUrl} for third-party plugin code.
     *
     * The playback gate above must keep letting LAN addresses through: IPTV portals
     * and CDNs live on them. A plugin has no such need — it is JavaScript from a
     * repository the user pasted, and its only job is to read public web pages. So
     * here the host must also not *resolve* to this device, the LAN, or a reserved
     * range. VyseTV does the same lookup (`InternetAddress.lookup`) before every hop.
     *
     * WebView can only hand us a hostname, so the check is done twice: on the name
     * here, and on every resolved address below. A public name that points at
     * 127.0.0.1 is refused by the second half.
     */
    private boolean isPublicPluginUrl(String raw) {
        if (!isAllowedRemoteUrl(raw, true)) return false;
        String host;
        try {
            host = new URI(raw.trim()).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null || host.isEmpty()) return false;
        String lower = host.toLowerCase();
        if (lower.equals("localhost") || lower.endsWith(".localhost")
                || lower.endsWith(".local") || lower.endsWith(".internal")
                || lower.endsWith(".home.arpa")) {
            return false;
        }
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            if (addresses == null || addresses.length == 0) return false;
            for (InetAddress address : addresses) {
                if (isPrivateAddress(address)) return false;
            }
            return true;
        } catch (Exception e) {
            // A name that will not resolve cannot be fetched anyway.
            return false;
        }
    }

    /** This device, its network, and the addresses that only exist inside one. */
    private static boolean isPrivateAddress(InetAddress address) {
        if (address == null) return true;
        if (address.isAnyLocalAddress() || address.isLoopbackAddress()
                || address.isLinkLocalAddress() || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes != null && bytes.length == 4) {
            int a = bytes[0] & 0xff;
            int b = bytes[1] & 0xff;
            // 0/8, 172.16/12, and 100.64/10 (carrier NAT) which Java never calls site-local.
            if (a == 0) return true;
            if (a == 172 && b >= 16 && b <= 31) return true;
            if (a == 100 && b >= 64 && b <= 127) return true;
            // 240/4 reserved, including broadcast.
            if (a >= 224) return true;
        }
        return false;
    }

    private static String hostOf(String raw) {
        try {
            String host = new URI(raw.trim()).getHost();
            return host == null ? "" : host.toLowerCase();
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean looksLikeApk(String raw) {
        try {
            String path = new URI(raw.trim()).getPath();
            return path != null && path.toLowerCase().endsWith(".apk");
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BridgeActivity creates the bridge during super.onCreate, so add
        // the bundled plugins to its builder before that call.
        // On the ARM64 Android emulator, this FFmpeg build can abort while
        // probing SVE during dlopen. Let Media3 handle playback on that host.
        if (!("ranchu".equals(Build.HARDWARE) && "arm64-v8a".equals(Build.SUPPORTED_ABIS[0]))) {
            registerPlugin(PrahaMpvPlugin.class);
        }
        registerPlugin(PrahaMedia3Plugin.class);
        registerPlugin(PrahaTorrServerPlugin.class);
        super.onCreate(savedInstanceState);
        // Extensions get this activity for dialogs and toasts, and PluginManager
        // waits for it before calling a plugin's load(). Set before anything can
        // ask for it, and before the WebView is configured.
        com.lagradost.cloudstream3.CommonActivity.INSTANCE.setActivity(this);
        // An extension calling AppContextUtils.loadResult (open a title page)
        // navigates the web layer instead of an Android screen.
        com.lagradost.cloudstream3.utils.AppContextUtils.INSTANCE.setOpenDetails(
                (apiName, url, name) -> {
                    try {
                        pushCloudStreamEvent("details", new org.json.JSONObject()
                                .put("apiName", apiName)
                                .put("url", url)
                                .put("name", name));
                    } catch (Exception ignored) {
                        // A malformed title name must not break the extension's call.
                    }
                    return kotlin.Unit.INSTANCE;
                });
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

        // A .cs3 the user picked from storage. Installing it here (rather than
        // replying to a held-open RPC) keeps the bridge call synchronous with the
        // install and reports the outcome as an event.
        csPluginPickerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() != RESULT_OK || result.getData() == null) return;
                    Uri uri = result.getData().getData();
                    if (uri == null) return;
                    final String picked = uri.toString();
                    csExecutor.execute(() -> {
                        boolean ok = false;
                        String message = null;
                        try {
                            ok = com.praha.stream.cloudstream.CsBridge.INSTANCE.sideload(picked);
                            if (!ok) message = "The package could not be loaded.";
                        } catch (Exception e) {
                            message = e.getMessage() != null ? e.getMessage() : "The package could not be loaded.";
                        }
                        try {
                            pushCloudStreamEvent("install", new org.json.JSONObject()
                                    .put("ok", ok)
                                    .put("message", message == null ? org.json.JSONObject.NULL : message));
                        } catch (Exception ignored) { }
                    });
                }
        );

        // Android requires explicit user consent before any VpnService runs.
        // The reply to JS is deliberately not held open across the dialog:
        // setVpnEnabled() reports "not on yet" and the UI polls getVpnStatus()
        // once the user answers, which is also what happens if they decline.
        vpnConsentLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK) startDnsVpn(pendingVpnDns);
                }
        );

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#090A0C"));
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            // NOTE: mixed content stays ALWAYS_ALLOW because many provider
            // iframes and Xtream portals are still plain HTTP; tightening it
            // breaks playback. The staged migration is tracked in
            // res/xml/network_security_config.xml.
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setDomStorageEnabled(true);
            // The app never loads local files or file:// origins, so deny them.
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            // C-01 fix: the actuator surface (network, intents, APK install,
            // player control) is no longer reachable through
            // addJavascriptInterface, which injects into EVERY frame with no
            // origin check. It now lives behind an origin-gated
            // WebViewCompat.addWebMessageListener that only the app's own
            // main frame (https://localhost) can post to, and only in that
            // frame is the prahaNativeBridge object injected at all.
            // The synchronous PrahaNative object retains ONLY read-only,
            // side-effect-free accessors the UI needs during render.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                webView.addJavascriptInterface(new PrahaReadOnlyBridge(rpcBridge), "PrahaNative");
                WebViewCompat.addWebMessageListener(
                        webView,
                        "prahaNativeBridge",
                        java.util.Collections.singleton("https://localhost"),
                        (WebMessageListener) (view, message, sourceOrigin, isMainFrame, replyProxy) ->
                                handleBridgeMessage(message, isMainFrame, replyProxy));
            } else {
                // Very old WebView without WebMessageListener support: keep the
                // legacy full JS interface so the app still works. Devices on
                // Play-updated WebView (>=116) get the origin-gated path.
                webView.addJavascriptInterface(new PrahaJsBridge(), "PrahaNative");
            }

        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(
                            "document.dispatchEvent(new CustomEvent('praha:hardware-back', { bubbles: true, cancelable: true }));",
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
        // Do not leave extensions holding a destroyed activity.
        if (com.lagradost.cloudstream3.CommonActivity.INSTANCE.getActivity() == this) {
            com.lagradost.cloudstream3.CommonActivity.INSTANCE.setActivity(null);
        }
        streamProxy.stop();
        httpExecutor.shutdownNow();
        csExecutor.shutdownNow();
        super.onDestroy();
    }

    /**
     * Entry point for the origin-gated bridge (audit C-01). The WebView only
     * delivers messages posted by frames matching https://localhost, and we
     * additionally require the main frame — sandboxed embed iframes with
     * opaque origins can never reach this code.
     */
    private void handleBridgeMessage(WebMessageCompat message, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (message == null || !isMainFrame || message.getData() == null) return;
        String id = "";
        String method = "";
        JSONArray args;
        try {
            JSONObject envelope = new JSONObject(message.getData());
            id = envelope.optString("id", "");
            method = envelope.optString("method", "");
            args = envelope.optJSONArray("args");
        } catch (Exception e) {
            return; // Malformed envelope; nothing to correlate a reply with.
        }
        if (args == null) args = new JSONArray();
        final String replyId = id;
        final String fMethod = method;
        final JSONArray fArgs = args;

        Runnable invoke = () -> {
            Object result = null;
            String error = null;
            try {
                result = dispatchBridgeCall(fMethod, fArgs);
            } catch (Throwable t) {
                error = t.getMessage() != null ? t.getMessage() : String.valueOf(t);
            }
            JSONObject reply = new JSONObject();
            try {
                reply.put("id", replyId);
                reply.put("ok", error == null);
                if (result != null) reply.put("result", result);
                if (error != null) reply.put("error", error);
            } catch (Exception ignored) {}
            final String payload = reply.toString();
            runOnUiThread(() -> {
                try {
                    replyProxy.postMessage(payload);
                } catch (Exception ignored) {}
            });
        };

        // Network-bound calls must not occupy the WebView bridge thread.
        if ("httpRequest".equals(fMethod) || "pluginHttp".equals(fMethod) || fMethod.startsWith("cs")) {
            ExecutorService pool = fMethod.startsWith("cs") ? csExecutor : httpExecutor;
            try {
                pool.execute(invoke);
            } catch (RejectedExecutionException rejected) {
                // Pool and queue saturated: fail fast so JS falls back to
                // CapacitorHttp / browser fetch instead of waiting.
                JSONObject reply = new JSONObject();
                try {
                    reply.put("id", replyId);
                    reply.put("ok", false);
                    reply.put("error", "Native HTTP queue is saturated; request rejected.");
                } catch (Exception ignored) {}
                final String payload = reply.toString();
                runOnUiThread(() -> {
                    try {
                        replyProxy.postMessage(payload);
                    } catch (Exception ignored) {}
                });
            }
        } else {
            invoke.run();
        }
    }

    /**
     * Pushes an event from the extension host to the web layer. The listener is
     * optional (`&&`), so an event fired before the UI registered is dropped
     * rather than throwing — same shape as `deliverHttpCallback`.
     */
    void pushCloudStreamEvent(String type, JSONObject detail) {
        final String payload = detail == null ? "{}" : detail.toString();
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    String js = "window.__prahaCloudStreamEvent && window.__prahaCloudStreamEvent("
                            + JSONObject.quote(type) + ", " + payload + ");";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }
            } catch (Exception ignored) {
                // The WebView is gone; nothing to deliver to.
            }
        });
    }

    /** Opens the document picker for a .cs3; the result is installed on csExecutor. */
    private void launchPluginPicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "application/zip",
                    "application/octet-stream",
                    "application/vnd.android.package-archive",
            });
            csPluginPickerLauncher.launch(intent);
        } catch (Exception e) {
            try {
                pushCloudStreamEvent("install", new org.json.JSONObject()
                        .put("ok", false)
                        .put("message", "No file picker is available."));
            } catch (Exception ignored) { }
        }
    }

    /** Launches the DNS tunnel service; consent is assumed already granted. */
    private void startDnsVpn(String dnsServer) {
        try {
            Intent intent = new Intent(this, PrahaDnsVpnService.class);
            intent.setAction(PrahaDnsVpnService.ACTION_START);
            intent.putExtra(PrahaDnsVpnService.EXTRA_DNS,
                    (dnsServer == null || dnsServer.isEmpty()) ? "1.1.1.1" : dnsServer);
            startService(intent);
        } catch (Exception ignored) {
            // Service start refused (background restrictions); the toggle simply
            // stays off and getVpnStatus() keeps reporting false.
        }
    }

    private void stopDnsVpn() {
        try {
            Intent intent = new Intent(this, PrahaDnsVpnService.class);
            intent.setAction(PrahaDnsVpnService.ACTION_STOP);
            startService(intent);
        } catch (Exception ignored) {}
    }

    private Object dispatchBridgeCall(String method, JSONArray args) throws Exception {
        if (method == null || method.isEmpty()) throw new IllegalArgumentException("Missing bridge method");
        switch (method) {
            case "openBrowser":
                return rpcBridge.openBrowser(args.optString(0, ""));
            case "openProtectedEmbed":
                return rpcBridge.openProtectedEmbed(args.optString(0, ""));
            case "openArchiveLoan":
                return rpcBridge.openArchiveLoan(args.optString(0, ""));
            case "openPrivateDnsSettings":
                return rpcBridge.openPrivateDnsSettings();
            case "setVpnEnabled":
                return rpcBridge.setVpnEnabled(args.optBoolean(0, false), args.optString(1, "1.1.1.1"));
            case "getVpnStatus":
                return rpcBridge.getVpnStatus();
            case "httpRequest":
                return rpcBridge.executeHttpRequest(
                        args.optString(0, ""), args.optString(1, "GET"),
                        args.optString(2, ""), args.optString(3, ""),
                        (int) args.optLong(4, 18000)).toString();
            case "pluginHttp":
                return rpcBridge.executePluginHttpRequest(
                        args.optString(0, ""), args.optString(1, "GET"),
                        args.optString(2, ""), args.optString(3, ""),
                        (int) args.optLong(4, 12000)).toString();
            case "setImmersiveMode":
                rpcBridge.setImmersiveMode(args.optBoolean(0, false), args.optBoolean(1, true));
                return null;
            case "enterPip":
                return rpcBridge.enterPip();
            case "exitApp":
                rpcBridge.exitApp();
                return null;
            case "openExternalPlayer":
                return rpcBridge.openExternalPlayer(args.optString(0, ""), args.optString(1, ""),
                        args.optString(2, ""), args.optString(3, ""));
            case "shareText":
                return rpcBridge.shareText(args.optString(0, ""), args.optString(1, ""));
            case "downloadFile":
                return rpcBridge.downloadFile(args.optString(0, ""), args.optString(1, ""), args.optString(2, ""));
            case "downloadAndInstallUpdate":
                return rpcBridge.downloadAndInstallUpdate(args.optString(0, ""), args.optString(1, ""));
            case "openSubtitlePicker":
                return rpcBridge.openSubtitlePicker();
            case "addSlave":
                return rpcBridge.addSlave((int) args.optLong(0, 0), args.optString(1, ""), args.optBoolean(2, true));
            case "setAudioTrack":
                return rpcBridge.setAudioTrack((int) args.optLong(0, -1));
            case "setSpuTrack":
                return rpcBridge.setSpuTrack((int) args.optLong(0, -1));
            case "setSpuDelay":
                return rpcBridge.setSpuDelay(args.optLong(0, 0));
            case "setAudioDelay":
                return rpcBridge.setAudioDelay(args.optLong(0, 0));
            case "vlcPlay":
                return rpcBridge.vlcPlay(args.optString(0, ""), args.optString(1, ""), args.optLong(2, 0));
            case "vlcPause":
                rpcBridge.vlcPause();
                return null;
            case "vlcResume":
                rpcBridge.vlcResume();
                return null;
            case "vlcStop":
                rpcBridge.vlcStop();
                return null;
            case "vlcSeek":
                rpcBridge.vlcSeek(args.optLong(0, 0));
                return null;
            case "vlcSetVolume":
                rpcBridge.vlcSetVolume((int) args.optLong(0, 0));
                return null;
            case "vlcSetRate":
                rpcBridge.vlcSetRate((float) args.optDouble(0, 1.0));
                return null;
            case "vlcSetAspectRatio":
                return rpcBridge.vlcSetAspectRatio(args.optString(0, ""));

            // ── CloudStream extensions ────────────────────────────────────
            // Every one of these blocks on extension code, which is why they
            // run on the network pool (see the isLongRunning switch below),
            // not on the WebView's bridge thread.
            case "csRepositories":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.repositories().toString();
            case "csAddRepository":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.addRepository(args.getString(0)).toString();
            case "csRemoveRepository":
                com.praha.stream.cloudstream.CsBridge.INSTANCE.removeRepository(args.getString(0));
                return null;
            case "csRepoPlugins":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.repoPlugins(args.getString(0)).toString();
            case "csPlugins":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.plugins().toString();
            case "csInstallPlugin":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.installPlugin(args.getString(0), args.getString(1));
            case "csUninstallPlugin":
                com.praha.stream.cloudstream.CsBridge.INSTANCE.uninstallPlugin(args.getString(0));
                return null;
            case "csUpdatePlugins":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.updateAll().toString();
            case "csInstallMissing":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.installMissing(
                        args.optBoolean(0, false), args.optJSONArray(1)).toString();
            case "csSideload":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.sideload(args.getString(0));
            case "csPickPluginFile":
                runOnUiThread(this::launchPluginPicker);
                return true;
            case "csProviders":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.providers().toString();
            case "csHome":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.home(args.optJSONArray(0)).toString();
            case "csCatalogs":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.catalogs(args.optJSONArray(0)).toString();
            case "csSetCatalogEnabled":
                com.praha.stream.cloudstream.CsBridge.INSTANCE.setCatalogEnabled(
                        args.getString(0), args.getString(1), args.optBoolean(2, true));
                return null;
            case "csSearch":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.search(
                        args.getString(0), args.optJSONArray(1)).toString();
            case "csLoad":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.load(args.getString(0), args.getString(1)).toString();
            case "csLinks":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.links(args.getString(0), args.getString(1)).toString();
            case "csPrefetch":
                com.praha.stream.cloudstream.CsBridge.INSTANCE.prefetch(args.getString(0), args.getString(1));
                return null;
            case "csSettings":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.settings().toString();
            case "csSetSettings":
                com.praha.stream.cloudstream.CsBridge.INSTANCE.setSettings(args.getJSONObject(0));
                return null;
            case "csOpenPluginFile":
                return com.praha.stream.cloudstream.CsBridge.INSTANCE.pluginFile(args.getString(0));

            default:
                throw new IllegalArgumentException("Unknown bridge method: " + method);
        }
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

        @JavascriptInterface
        public boolean openArchiveLoan(String url) {
            if (url == null || url.length() > 4096 || !ProtectedEmbedActivity.isArchiveItem(Uri.parse(url))) return false;
            try {
                startActivity(new Intent(MainActivity.this, ProtectedEmbedActivity.class)
                        .putExtra(ProtectedEmbedActivity.EXTRA_URL, url)
                        .putExtra(ProtectedEmbedActivity.EXTRA_ARCHIVE_LOAN, true));
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

        /**
         * Starts or stops the DNS tunnel. Returns whether the tunnel is running
         * at the moment of return: the first call shows Android's consent
         * dialog, so it returns false and the caller polls getVpnStatus().
         */
        @JavascriptInterface
        public boolean setVpnEnabled(boolean enabled, String dnsServer) {
            if (!enabled) {
                stopDnsVpn();
                return false;
            }
            Intent consent = VpnService.prepare(MainActivity.this);
            if (consent == null) {
                // Already authorised; start immediately.
                startDnsVpn(dnsServer);
                return PrahaDnsVpnService.isActive();
            }
            pendingVpnDns = (dnsServer == null || dnsServer.isEmpty()) ? "1.1.1.1" : dnsServer;
            vpnConsentLauncher.launch(consent);
            return false;
        }

        @JavascriptInterface
        public boolean getVpnStatus() {
            return PrahaDnsVpnService.isActive();
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
            if (!isAllowedRemoteUrl(url, true)) return "";
            return streamProxy.buildProxyUrl(url, headersJson);
        }

        @JavascriptInterface
        public void httpRequestAsync(final String requestId, final String urlString, final String method, final String headersJson, final String body, final int timeoutMs) {
            httpExecutor.execute(() -> {
                JSONObject result = executeHttpRequest(urlString, method, headersJson, body, timeoutMs);
                deliverHttpCallback(requestId, result);
            });
        }

        JSONObject executeHttpRequest(String urlString, String method, String headersJson, String body, int timeoutMs) {
            HttpURLConnection conn = null;
            JSONObject result = new JSONObject();
            int redirects = 0;
            String currentUrl = urlString;
            int timeout = (timeoutMs > 0) ? timeoutMs : 15000;

            // Gate the whole redirect chain entry point once; each hop is
            // re-checked below before it is opened.
            if (!isAllowedRemoteUrl(urlString, true)) {
                try {
                    result.put("ok", false);
                    result.put("status", 0);
                    result.put("error", "Blocked non-HTTP URL");
                } catch (Exception ignored) {}
                return result;
            }

            while (redirects < 5) {
                // Re-gate every hop, not just the entry URL: an allowed host may
                // 30x-redirect to loopback / link-local / non-HTTP targets.
                if (!isAllowedRemoteUrl(currentUrl, true)) {
                    try {
                        result.put("ok", false);
                        result.put("status", 0);
                        result.put("error", "Blocked redirect target");
                    } catch (Exception ignored) {}
                    return result;
                }
                try {
                    URL url = new URL(currentUrl);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(timeout);
                    conn.setReadTimeout(timeout);
                    String verb = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
                    conn.setRequestMethod(verb);

                    boolean hasUa = false;
                    boolean hasAcceptEncoding = false;
                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject headers = new JSONObject(headersJson);
                        Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            String value = headers.optString(key, "");
                            if (!value.isEmpty()) {
                                conn.setRequestProperty(key, value);
                                if ("user-agent".equalsIgnoreCase(key)) hasUa = true;
                                if ("accept-encoding".equalsIgnoreCase(key)) hasAcceptEncoding = true;
                            }
                        }
                    }
                    if (!hasUa) {
                        conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                    }
                    if (!hasAcceptEncoding) {
                        conn.setRequestProperty("Accept-Encoding", "gzip, deflate");
                    }

                    if (body != null && !body.isEmpty() && ("POST".equals(verb) || "PUT".equals(verb) || "PATCH".equals(verb))) {
                        conn.setDoOutput(true);
                        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(payload);
                        }
                    }

                    int status = conn.getResponseCode();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (location != null && !location.isEmpty()) {
                            if (!location.startsWith("http://") && !location.startsWith("https://")) {
                                location = new URL(url, location).toString();
                            }
                            currentUrl = location;
                            redirects++;
                            continue;
                        }
                    }

                    InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    String text = "";
                    if (in != null) {
                        String encoding = conn.getContentEncoding();
                        if ("gzip".equalsIgnoreCase(encoding)) {
                            in = new java.util.zip.GZIPInputStream(in);
                        } else if ("deflate".equalsIgnoreCase(encoding)) {
                            in = new java.util.zip.InflaterInputStream(in);
                        }

                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        long total = 0;
                        // Cap the body: a runaway scraper response must not OOM
                        // the WebView process (freeze / crash).
                        final long MAX_BODY_BYTES = 8L * 1024 * 1024;
                        while ((n = in.read(buf)) != -1) {
                            total += n;
                            if (total > MAX_BODY_BYTES) {
                                bos.write(buf, 0, n);
                                try {
                                    result.put("ok", false);
                                    result.put("status", 0);
                                    result.put("error", "Native HTTP response exceeded 8 MB and was truncated.");
                                } catch (Exception ignored) {}
                                return result;
                            }
                            bos.write(buf, 0, n);
                        }
                        text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                    }

                    result.put("ok", status >= 200 && status < 300);
                    result.put("status", status);
                    result.put("body", text);
                    return result;
                } catch (Exception e) {
                    try {
                        result.put("ok", false);
                        result.put("status", 0);
                        result.put("error", e.getMessage() != null ? e.getMessage() : "Native HTTP error");
                    } catch (Exception ignored) {}
                    return result;
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }

            try {
                result.put("ok", false);
                result.put("status", 310);
                result.put("error", "Too many redirects");
            } catch (Exception ignored) {}
            return result;
        }

        /**
         * One hop of a plugin's `http()`, with redirects left to the caller.
         *
         * Publishing the redirect itself (`status` + `location`) instead of
         * following it is the whole point: the plugin host re-runs the host check
         * on the next door before opening it, so a public URL that 302s to
         * `http://192.168.1.1/` is refused at the second hop rather than being
         * waved through by this side. That is VyseTV's `followRedirects = false`.
         */
        JSONObject executePluginHttpRequest(String urlString, String method, String headersJson, String body, int timeoutMs) {
            HttpURLConnection conn = null;
            JSONObject result = new JSONObject();
            int timeout = (timeoutMs > 0) ? Math.min(timeoutMs, 20000) : 12000;
            if (!isPublicPluginUrl(urlString)) {
                try {
                    result.put("ok", false);
                    result.put("status", 0);
                    result.put("error", "Blocked: plugins may only reach public http(s) addresses.");
                } catch (Exception ignored) {}
                return result;
            }
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(timeout);
                conn.setReadTimeout(timeout);
                String verb = (method == null || method.isEmpty()) ? "GET" : method.toUpperCase();
                conn.setRequestMethod(verb);

                boolean hasUa = false;
                boolean hasAcceptEncoding = false;
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject headers = new JSONObject(headersJson);
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headers.optString(key, "");
                        if (!value.isEmpty()) {
                            conn.setRequestProperty(key, value);
                            if ("user-agent".equalsIgnoreCase(key)) hasUa = true;
                            if ("accept-encoding".equalsIgnoreCase(key)) hasAcceptEncoding = true;
                        }
                    }
                }
                if (!hasUa) {
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                }
                if (!hasAcceptEncoding) {
                    conn.setRequestProperty("Accept-Encoding", "gzip, deflate");
                }

                if (body != null && !body.isEmpty()
                        && ("POST".equals(verb) || "PUT".equals(verb) || "PATCH".equals(verb))) {
                    conn.setDoOutput(true);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(payload);
                    }
                }

                int status = conn.getResponseCode();
                result.put("status", status);
                String location = conn.getHeaderField("Location");
                if (location != null && !location.isEmpty()) result.put("location", location);
                String contentType = conn.getHeaderField("Content-Type");
                if (contentType != null) result.put("contentType", contentType);

                // A redirect is the answer here; its body is not worth reading.
                boolean redirect = status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
                if (redirect) {
                    result.put("ok", false);
                    return result;
                }

                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = "";
                if (in != null) {
                    String encoding = conn.getContentEncoding();
                    if ("gzip".equalsIgnoreCase(encoding)) {
                        in = new java.util.zip.GZIPInputStream(in);
                    } else if ("deflate".equalsIgnoreCase(encoding)) {
                        in = new java.util.zip.InflaterInputStream(in);
                    }
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    long total = 0;
                    final long MAX_BODY_BYTES = 8L * 1024 * 1024;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_BODY_BYTES) {
                            result.put("ok", false);
                            result.put("status", 0);
                            result.put("error", "Response exceeded 8 MB and was truncated.");
                            return result;
                        }
                        bos.write(buf, 0, n);
                    }
                    text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                }
                result.put("ok", status >= 200 && status < 300);
                result.put("body", text);
                return result;
            } catch (Exception e) {
                try {
                    result.put("ok", false);
                    result.put("status", 0);
                    result.put("error", e.getMessage() != null ? e.getMessage() : "Plugin HTTP error");
                } catch (Exception ignored) {}
                return result;
            } finally {
                if (conn != null) conn.disconnect();
            }
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
            JSONObject result = executeHttpRequest(urlString, method, headersJson, body, 18000);
            return result.toString();
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                final boolean[] ok = {false};
                final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
                runOnUiThread(() -> {
                    try {
                        PictureInPictureParams params = new PictureInPictureParams.Builder()
                                .setAspectRatio(new Rational(16, 9))
                                .build();
                        enterPictureInPictureMode(params);
                        ok[0] = true;
                    } catch (Exception ignored) {
                        ok[0] = false;
                    } finally {
                        latch.countDown();
                    }
                });
                try {
                    latch.await(2, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
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
            return "[]";
        }

        @JavascriptInterface
        public int getSelectedAudioTrack() {
            return -1;
        }

        @JavascriptInterface
        public boolean setAudioTrack(int id) {
            return false;
        }

        @JavascriptInterface
        public String getAllSpuTracks() {
            return "[]";
        }

        @JavascriptInterface
        public int getSelectedSpuTrack() {
            return -1;
        }

        @JavascriptInterface
        public boolean setSpuTrack(int id) {
            return false;
        }

        @JavascriptInterface
        public boolean addSlave(int type, String uri, boolean select) {
            return false;
        }

        @JavascriptInterface
        public boolean setSpuDelay(long delayMicros) {
            return false;
        }

        @JavascriptInterface
        public long getSpuDelay() {
            return 0;
        }

        @JavascriptInterface
        public boolean setAudioDelay(long delayMicros) {
            return false;
        }

        @JavascriptInterface
        public long getAudioDelay() {
            return 0;
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
            return false;
        }

        @JavascriptInterface
        public void vlcPause() {
        }

        @JavascriptInterface
        public void vlcResume() {
        }

        @JavascriptInterface
        public void vlcStop() {
        }

        @JavascriptInterface
        public void vlcSeek(long timeMs) {
        }

        @JavascriptInterface
        public void vlcSetVolume(int volume) {
        }

        @JavascriptInterface
        public void vlcSetRate(float rate) {
        }

        @JavascriptInterface
        public boolean vlcSetAspectRatio(String aspect) {
            return false;
        }

        @JavascriptInterface
        public String getAppVersionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "2.5.4";
            }
        }

        @JavascriptInterface
        public boolean isVlcAvailable() {
            return false;
        }

        @JavascriptInterface
        public boolean isVlcPlaying() {
            return false;
        }

        @JavascriptInterface
        /**
         * Saves a direct http(s) media file into the system Downloads folder
         * via DownloadManager (notification + progress handled by the system).
         * Returns the DownloadManager id, or -1 on rejection/failure.
         */
        public String downloadFile(final String url, final String title, final String headersJson) {
            if (url == null || url.isEmpty()) return "-1";
            if (!isAllowedRemoteUrl(url, false)) return "-1";
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                String safeTitle = (title == null || title.trim().isEmpty())
                        ? "PRAHA download"
                        : title.replaceAll("[\\/:*?\"<>|]", "_").trim();
                request.setTitle(safeTitle);
                request.setDescription("PRAHA STREAM download");
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "PRAHA/" + safeTitle);
                if (headersJson != null && !headersJson.trim().isEmpty()) {
                    try {
                        JSONObject headers = new JSONObject(headersJson);
                        java.util.Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String key = keys.next();
                            String value = headers.optString(key, "");
                            if (!key.isEmpty() && !value.isEmpty() && !"host".equalsIgnoreCase(key)) {
                                request.addRequestHeader(key, value);
                            }
                        }
                    } catch (Exception ignored) {}
                }
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) return "-1";
                long id = dm.enqueue(request);
                return String.valueOf(id);
            } catch (Exception e) {
                return "-1";
            }
        }

        @JavascriptInterface
        public boolean downloadAndInstallUpdate(final String apkUrl, final String versionName) {
            if (apkUrl == null || apkUrl.isEmpty()) return false;
            // Pin self-updates to the GitHub release feed over HTTPS and require
            // an .apk path. This closes the arbitrary-APK-install path that
            // otherwise turns any JS-reachable caller into a code-execution
            // primitive (audit C-02).
            if (!isAllowedRemoteUrl(apkUrl, false)) return false;
            if (!looksLikeApk(apkUrl)) return false;
            String apkHost = hostOf(apkUrl);
            if (!"github.com".equals(apkHost) && !apkHost.endsWith(".githubusercontent.com")) return false;
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        if (!getPackageManager().canRequestPackageInstalls()) {
                            try {
                                Intent allowIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                allowIntent.setData(Uri.parse("package:" + getPackageName()));
                                allowIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                startActivity(allowIntent);
                            } catch (Exception ignored) {}
                        }
                    }

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
                                try {
                                    unregisterReceiver(this);
                                } catch (Exception ignored) {}

                                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                                if (id == downloadId) {
                                    File file = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "praha-update.apk");
                                    if (file.exists() && file.length() > 0) {
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

    /**
     * The synchronous JS surface on the origin-gated path (audit C-01).
     * Exposes ONLY read-only, side-effect-free accessors that must stay
     * synchronous for the web UI. Every actuating method — network, intents,
     * APK install, player control, share, PiP, immersive mode — lives behind
     * the origin-gated WebMessageListener instead, so a malicious iframe
     * (opaque origin, sandboxed) cannot reach it even by calling the native
     * object directly.
     */
    public class PrahaReadOnlyBridge {
        private final PrahaJsBridge impl;

        PrahaReadOnlyBridge(PrahaJsBridge impl) {
            this.impl = impl;
        }

        @JavascriptInterface
        public boolean isAndroid() {
            return impl.isAndroid();
        }

        @JavascriptInterface
        public boolean isTelevision() {
            return impl.isTelevision();
        }

        @JavascriptInterface
        public int getProxyPort() {
            return impl.getProxyPort();
        }

        @JavascriptInterface
        public String proxyStreamUrl(String url, String headersJson) {
            return impl.proxyStreamUrl(url, headersJson);
        }

        @JavascriptInterface
        public String getAppVersionName() {
            return impl.getAppVersionName();
        }

        @JavascriptInterface
        public String getAllAudioTracks() {
            return impl.getAllAudioTracks();
        }

        @JavascriptInterface
        public int getSelectedAudioTrack() {
            return impl.getSelectedAudioTrack();
        }

        @JavascriptInterface
        public String getAllSpuTracks() {
            return impl.getAllSpuTracks();
        }

        @JavascriptInterface
        public int getSelectedSpuTrack() {
            return impl.getSelectedSpuTrack();
        }

        @JavascriptInterface
        public long getSpuDelay() {
            return impl.getSpuDelay();
        }

        @JavascriptInterface
        public long getAudioDelay() {
            return impl.getAudioDelay();
        }

        @JavascriptInterface
        public boolean isVlcAvailable() {
            return impl.isVlcAvailable();
        }

        @JavascriptInterface
        public boolean isVlcPlaying() {
            return impl.isVlcPlaying();
        }
    }
}
