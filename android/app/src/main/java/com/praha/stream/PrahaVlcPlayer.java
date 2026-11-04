package com.praha.stream;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Native LibVLC Player integration for PRAHA.
 * Provides complete audio track selection, embedded/external subtitle management,
 * Storage Access Framework loading, and seamless hardware-accelerated playback.
 */
public class PrahaVlcPlayer {
    private static final String TAG = "PrahaVlcPlayer";

    private final Activity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private LibVLC libVlc;
    private MediaPlayer mediaPlayer;
    private Media currentMedia;
    private VLCVideoLayout videoLayout;
    private WebView webView;

    private boolean isInitialized = false;
    private boolean isPlayingNative = false;
    private String currentUrl = "";
    private final ArrayList<JSONObject> externalSubtitles = new ArrayList<>();

    private static final Map<String, String> LANGUAGE_MAP = new HashMap<>();
    static {
        LANGUAGE_MAP.put("eng", "English");
        LANGUAGE_MAP.put("en", "English");
        LANGUAGE_MAP.put("hin", "Hindi");
        LANGUAGE_MAP.put("hi", "Hindi");
        LANGUAGE_MAP.put("jpn", "Japanese");
        LANGUAGE_MAP.put("ja", "Japanese");
        LANGUAGE_MAP.put("spa", "Spanish");
        LANGUAGE_MAP.put("es", "Spanish");
        LANGUAGE_MAP.put("fra", "French");
        LANGUAGE_MAP.put("fre", "French");
        LANGUAGE_MAP.put("fr", "French");
        LANGUAGE_MAP.put("deu", "German");
        LANGUAGE_MAP.put("ger", "German");
        LANGUAGE_MAP.put("de", "German");
        LANGUAGE_MAP.put("ita", "Italian");
        LANGUAGE_MAP.put("it", "Italian");
        LANGUAGE_MAP.put("por", "Portuguese");
        LANGUAGE_MAP.put("pt", "Portuguese");
        LANGUAGE_MAP.put("rus", "Russian");
        LANGUAGE_MAP.put("ru", "Russian");
        LANGUAGE_MAP.put("kor", "Korean");
        LANGUAGE_MAP.put("ko", "Korean");
        LANGUAGE_MAP.put("zho", "Chinese");
        LANGUAGE_MAP.put("chi", "Chinese");
        LANGUAGE_MAP.put("zh", "Chinese");
        LANGUAGE_MAP.put("ara", "Arabic");
        LANGUAGE_MAP.put("ar", "Arabic");
        LANGUAGE_MAP.put("tam", "Tamil");
        LANGUAGE_MAP.put("ta", "Tamil");
        LANGUAGE_MAP.put("tel", "Telugu");
        LANGUAGE_MAP.put("te", "Telugu");
        LANGUAGE_MAP.put("kan", "Kannada");
        LANGUAGE_MAP.put("kn", "Kannada");
        LANGUAGE_MAP.put("mal", "Malayalam");
        LANGUAGE_MAP.put("ml", "Malayalam");
        LANGUAGE_MAP.put("ben", "Bengali");
        LANGUAGE_MAP.put("bn", "Bengali");
        LANGUAGE_MAP.put("mar", "Marathi");
        LANGUAGE_MAP.put("mr", "Marathi");
        LANGUAGE_MAP.put("pan", "Punjabi");
        LANGUAGE_MAP.put("pa", "Punjabi");
        LANGUAGE_MAP.put("guj", "Gujarati");
        LANGUAGE_MAP.put("gu", "Gujarati");
        LANGUAGE_MAP.put("urd", "Urdu");
        LANGUAGE_MAP.put("ur", "Urdu");
        LANGUAGE_MAP.put("fas", "Persian");
        LANGUAGE_MAP.put("per", "Persian");
        LANGUAGE_MAP.put("fa", "Persian");
        LANGUAGE_MAP.put("vie", "Vietnamese");
        LANGUAGE_MAP.put("vi", "Vietnamese");
        LANGUAGE_MAP.put("tha", "Thai");
        LANGUAGE_MAP.put("th", "Thai");
        LANGUAGE_MAP.put("ind", "Indonesian");
        LANGUAGE_MAP.put("id", "Indonesian");
        LANGUAGE_MAP.put("msa", "Malay");
        LANGUAGE_MAP.put("may", "Malay");
        LANGUAGE_MAP.put("ms", "Malay");
        LANGUAGE_MAP.put("fil", "Filipino");
        LANGUAGE_MAP.put("tgl", "Tagalog");
        LANGUAGE_MAP.put("pol", "Polish");
        LANGUAGE_MAP.put("pl", "Polish");
        LANGUAGE_MAP.put("tur", "Turkish");
        LANGUAGE_MAP.put("tr", "Turkish");
        LANGUAGE_MAP.put("ukr", "Ukrainian");
        LANGUAGE_MAP.put("uk", "Ukrainian");
        LANGUAGE_MAP.put("nld", "Dutch");
        LANGUAGE_MAP.put("dut", "Dutch");
        LANGUAGE_MAP.put("nl", "Dutch");
        LANGUAGE_MAP.put("swe", "Swedish");
        LANGUAGE_MAP.put("sv", "Swedish");
        LANGUAGE_MAP.put("nor", "Norwegian");
        LANGUAGE_MAP.put("no", "Norwegian");
        LANGUAGE_MAP.put("dan", "Danish");
        LANGUAGE_MAP.put("da", "Danish");
        LANGUAGE_MAP.put("fin", "Finnish");
        LANGUAGE_MAP.put("fi", "Finnish");
        LANGUAGE_MAP.put("ell", "Greek");
        LANGUAGE_MAP.put("gre", "Greek");
        LANGUAGE_MAP.put("el", "Greek");
        LANGUAGE_MAP.put("ces", "Czech");
        LANGUAGE_MAP.put("cze", "Czech");
        LANGUAGE_MAP.put("cs", "Czech");
        LANGUAGE_MAP.put("hun", "Hungarian");
        LANGUAGE_MAP.put("hu", "Hungarian");
        LANGUAGE_MAP.put("ron", "Romanian");
        LANGUAGE_MAP.put("rum", "Romanian");
        LANGUAGE_MAP.put("ro", "Romanian");
        LANGUAGE_MAP.put("heb", "Hebrew");
        LANGUAGE_MAP.put("he", "Hebrew");
    }

    public PrahaVlcPlayer(Activity activity) {
        this.activity = activity;
    }

    public void init(VLCVideoLayout layout, WebView webView) {
        this.videoLayout = layout;
        this.webView = webView;
        try {
            ArrayList<String> options = new ArrayList<>();
            options.add("--no-drop-late-frames");
            options.add("--no-skip-frames");
            options.add("--audio-time-stretch");
            options.add("-vvv");
            libVlc = new LibVLC(activity, options);
            mediaPlayer = new MediaPlayer(libVlc);
            if (videoLayout != null) {
                mediaPlayer.attachViews(videoLayout, null, true, false);
            }
            setupListeners();
            isInitialized = true;
            Log.i(TAG, "LibVLC initialized successfully");
        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize LibVLC", e);
        }
    }

    private void setupListeners() {
        if (mediaPlayer == null) return;
        mediaPlayer.setEventListener(event -> {
            switch (event.type) {
                case MediaPlayer.Event.ESAdded:
                case MediaPlayer.Event.ESDeleted:
                case MediaPlayer.Event.ESSelected:
                    notifyTracksChanged();
                    break;
                case MediaPlayer.Event.TimeChanged:
                    notifyPlaybackProgress(event.getTimeChanged(), mediaPlayer.getLength());
                    break;
                case MediaPlayer.Event.LengthChanged:
                    notifyTracksChanged();
                    break;
                case MediaPlayer.Event.Playing:
                    notifyPlaybackState(true, false);
                    break;
                case MediaPlayer.Event.Paused:
                    notifyPlaybackState(false, false);
                    break;
                case MediaPlayer.Event.Stopped:
                case MediaPlayer.Event.EndReached:
                    notifyPlaybackState(false, false);
                    break;
                case MediaPlayer.Event.Buffering:
                    notifyBuffering(event.getBuffering());
                    break;
                case MediaPlayer.Event.EncounteredError:
                    notifyError("Playback encountered an error in LibVLC");
                    break;
            }
        });
    }

    public synchronized boolean play(String url, String headersJson, long resumeMs) {
        if (url == null || url.trim().isEmpty()) return false;
        if (!isInitialized || mediaPlayer == null) {
            if (videoLayout != null && webView != null) {
                init(videoLayout, webView);
            }
        }
        if (mediaPlayer == null) return false;

        try {
            stop();
            externalSubtitles.clear();
            currentUrl = url;

            Uri uri = Uri.parse(url);
            if ("content".equalsIgnoreCase(uri.getScheme())) {
                currentMedia = new Media(libVlc, uri);
            } else if ("file".equalsIgnoreCase(uri.getScheme()) || url.startsWith("/")) {
                String path = "file".equalsIgnoreCase(uri.getScheme()) ? uri.getPath() : url;
                currentMedia = new Media(libVlc, path);
            } else {
                currentMedia = new Media(libVlc, uri);
                if (headersJson != null && !headersJson.trim().isEmpty()) {
                    try {
                        JSONObject headers = new JSONObject(headersJson);
                        if (headers.has("User-Agent")) {
                            currentMedia.addOption(":http-user-agent=" + headers.getString("User-Agent"));
                        }
                        if (headers.has("Referer")) {
                            currentMedia.addOption(":http-referrer=" + headers.getString("Referer"));
                        }
                    } catch (Exception ignored) {}
                }
            }

            currentMedia.setHWDecoderEnabled(true, false);
            currentMedia.parse(Media.Parse.ParseNetwork | Media.Parse.FetchLocal);
            currentMedia.setEventListener(event -> {
                if (event.type == Media.Event.ParsedChanged) {
                    mainHandler.post(this::notifyTracksChanged);
                }
            });

            mediaPlayer.setMedia(currentMedia);
            currentMedia.release();

            if (videoLayout != null) {
                videoLayout.setVisibility(View.VISIBLE);
            }
            mediaPlayer.play();
            if (resumeMs > 0) {
                mediaPlayer.setTime(resumeMs);
            }
            isPlayingNative = true;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error playing with LibVLC", e);
            notifyError("Failed to open media with LibVLC: " + e.getMessage());
            return false;
        }
    }

    public synchronized void pause() {
        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        }
    }

    public synchronized void resume() {
        if (mediaPlayer != null && !mediaPlayer.isPlaying()) {
            mediaPlayer.play();
        }
    }

    public synchronized void stop() {
        isPlayingNative = false;
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) {}
        }
        if (videoLayout != null) {
            videoLayout.setVisibility(View.GONE);
        }
    }

    public synchronized void seek(long timeMs) {
        if (mediaPlayer != null) {
            mediaPlayer.setTime(Math.max(0, timeMs));
        }
    }

    public synchronized void setVolume(int volumePercent) {
        if (mediaPlayer != null) {
            mediaPlayer.setVolume(Math.max(0, Math.min(100, volumePercent)));
        }
    }

    public synchronized void setRate(float rate) {
        if (mediaPlayer != null && rate > 0) {
            mediaPlayer.setRate(rate);
        }
    }

    public boolean isPlaying() {
        return mediaPlayer != null && mediaPlayer.isPlaying();
    }

    public boolean isAvailable() {
        return isInitialized && mediaPlayer != null;
    }

    public long getTime() {
        return mediaPlayer != null ? mediaPlayer.getTime() : 0;
    }

    public long getLength() {
        return mediaPlayer != null ? mediaPlayer.getLength() : 0;
    }

    // --- Audio Track Manager APIs ---

    public synchronized String getAllAudioTracks() {
        JSONArray array = new JSONArray();
        if (mediaPlayer == null) return array.toString();

        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getAudioTracks();
        if (tracks == null || tracks.length == 0) return array.toString();

        int selectedId = mediaPlayer.getAudioTrack();
        int trackIndex = 1;

        for (MediaPlayer.TrackDescription desc : tracks) {
            if (desc.id == -1) continue; // Skip disable track from normal list
            try {
                JSONObject obj = new JSONObject();
                obj.put("id", desc.id);
                obj.put("trackNumber", trackIndex);

                // Extract metadata from Media.AudioTrack if available
                enrichAudioMetadata(desc.id, trackIndex, desc.name, obj);
                obj.put("selected", desc.id == selectedId);

                array.put(obj);
                trackIndex++;
            } catch (Exception ignored) {}
        }

        return array.toString();
    }

    public synchronized int getSelectedAudioTrack() {
        if (mediaPlayer == null) return -1;
        return mediaPlayer.getAudioTrack();
    }

    public synchronized boolean setAudioTrack(int id) {
        if (mediaPlayer == null) return false;
        boolean result = mediaPlayer.setAudioTrack(id);
        notifyTracksChanged();
        return result;
    }

    public synchronized boolean setAudioDelay(long delayMicros) {
        if (mediaPlayer == null) return false;
        return mediaPlayer.setAudioDelay(delayMicros);
    }

    public synchronized long getAudioDelay() {
        if (mediaPlayer == null) return 0;
        return mediaPlayer.getAudioDelay();
    }

    // --- Subtitle Track Manager APIs ---

    public synchronized String getAllSpuTracks() {
        JSONArray array = new JSONArray();
        if (mediaPlayer == null) return array.toString();

        MediaPlayer.TrackDescription[] tracks = mediaPlayer.getSpuTracks();
        int selectedId = mediaPlayer.getSpuTrack();
        int trackIndex = 1;

        if (tracks != null) {
            for (MediaPlayer.TrackDescription desc : tracks) {
                if (desc.id == -1) continue;
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("id", desc.id);
                    obj.put("trackNumber", trackIndex);
                    obj.put("isExternal", false);

                    enrichSubtitleMetadata(desc.id, trackIndex, desc.name, obj);
                    obj.put("selected", desc.id == selectedId);

                    array.put(obj);
                    trackIndex++;
                } catch (Exception ignored) {}
            }
        }

        // Add registered external subtitle tracks if any
        for (JSONObject ext : externalSubtitles) {
            try {
                JSONObject copy = new JSONObject(ext.toString());
                int extId = copy.optInt("id", -1);
                copy.put("selected", extId == selectedId);
                array.put(copy);
            } catch (Exception ignored) {}
        }

        return array.toString();
    }

    public synchronized int getSelectedSpuTrack() {
        if (mediaPlayer == null) return -1;
        return mediaPlayer.getSpuTrack();
    }

    public synchronized boolean setSpuTrack(int id) {
        if (mediaPlayer == null) return false;
        boolean result = mediaPlayer.setSpuTrack(id);
        notifyTracksChanged();
        return result;
    }

    public synchronized boolean addSlave(int type, String uriString, boolean select) {
        if (mediaPlayer == null || uriString == null || uriString.trim().isEmpty()) return false;
        try {
            Uri uri = Uri.parse(uriString);
            String finalPath = uriString;

            // Handle content:// URIs by caching locally for native LibVLC layer
            if ("content".equalsIgnoreCase(uri.getScheme())) {
                File cached = copyContentUriToCache(uri);
                if (cached != null && cached.exists()) {
                    finalPath = cached.getAbsolutePath();
                    uri = Uri.fromFile(cached);
                }
            }

            boolean ok = mediaPlayer.addSlave(type, uri, select);
            if (!ok && !finalPath.startsWith("http")) {
                ok = mediaPlayer.addSlave(type, finalPath, select);
            }

            if (ok) {
                String fileName = uri.getLastPathSegment();
                if (fileName == null) fileName = "External Subtitle";
                JSONObject extObj = new JSONObject();
                extObj.put("id", mediaPlayer.getSpuTrack());
                extObj.put("name", fileName);
                extObj.put("language", "External");
                extObj.put("languageName", "External");
                extObj.put("isExternal", true);
                extObj.put("selected", select);
                externalSubtitles.add(extObj);
                notifyTracksChanged();
            }
            return ok;
        } catch (Exception e) {
            Log.e(TAG, "Failed to add slave subtitle: " + uriString, e);
            return false;
        }
    }

    public synchronized boolean setSpuDelay(long delayMicros) {
        if (mediaPlayer == null) return false;
        return mediaPlayer.setSpuDelay(delayMicros);
    }

    public synchronized long getSpuDelay() {
        if (mediaPlayer == null) return 0;
        return mediaPlayer.getSpuDelay();
    }

    // --- Helper Methods & Metadata Enrichment ---

    private void enrichAudioMetadata(int trackId, int fallbackIndex, String descName, JSONObject target) {
        try {
            IMedia media = mediaPlayer != null ? mediaPlayer.getMedia() : null;
            IMedia.AudioTrack matchedAudio = null;

            if (media != null) {
                int count = media.getTrackCount();
                for (int i = 0; i < count; i++) {
                    IMedia.Track t = media.getTrack(i);
                    if (t.type == IMedia.Track.Type.Audio) {
                        if (t.id == trackId || matchedAudio == null) {
                            matchedAudio = (IMedia.AudioTrack) t;
                            if (t.id == trackId) break;
                        }
                    }
                }
            }

            String langCode = matchedAudio != null ? matchedAudio.language : null;
            String codec = matchedAudio != null ? matchedAudio.codec : null;
            int channels = matchedAudio != null ? matchedAudio.channels : 0;
            int bitrate = matchedAudio != null ? matchedAudio.bitrate : 0;

            String languageName = resolveLanguageName(langCode);

            // Construct honest label without fake languages
            String displayLabel;
            if (languageName != null && !languageName.isEmpty()) {
                displayLabel = languageName;
            } else if (descName != null && !descName.isEmpty() && !descName.startsWith("Track ")) {
                displayLabel = descName;
            } else {
                displayLabel = "Audio " + fallbackIndex;
            }

            String codecLabel = formatAudioCodec(codec, channels);

            target.put("name", displayLabel);
            target.put("language", langCode);
            target.put("languageName", languageName);
            target.put("codec", codec);
            target.put("codecLabel", codecLabel);
            target.put("channels", channels);
            target.put("bitrate", bitrate);
        } catch (Exception ignored) {}
    }

    private void enrichSubtitleMetadata(int trackId, int fallbackIndex, String descName, JSONObject target) {
        try {
            IMedia media = mediaPlayer != null ? mediaPlayer.getMedia() : null;
            IMedia.SubtitleTrack matchedSub = null;

            if (media != null) {
                int count = media.getTrackCount();
                for (int i = 0; i < count; i++) {
                    IMedia.Track t = media.getTrack(i);
                    if (t.type == IMedia.Track.Type.Text) {
                        if (t.id == trackId || matchedSub == null) {
                            matchedSub = (IMedia.SubtitleTrack) t;
                            if (t.id == trackId) break;
                        }
                    }
                }
            }

            String langCode = matchedSub != null ? matchedSub.language : null;
            String codec = matchedSub != null ? matchedSub.codec : null;
            String languageName = resolveLanguageName(langCode);

            String displayLabel;
            if (languageName != null && !languageName.isEmpty()) {
                displayLabel = languageName;
            } else if (descName != null && !descName.isEmpty() && !descName.startsWith("Subtitle ")) {
                displayLabel = descName;
            } else {
                displayLabel = "Subtitle " + fallbackIndex;
            }

            target.put("name", displayLabel);
            target.put("language", langCode);
            target.put("languageName", languageName);
            target.put("codec", codec);
            target.put("codecLabel", formatSubtitleCodec(codec));
        } catch (Exception ignored) {}
    }

    public static String resolveLanguageName(String langCode) {
        if (langCode == null || langCode.trim().isEmpty() || "und".equalsIgnoreCase(langCode)) {
            return null;
        }
        String clean = langCode.trim().toLowerCase(Locale.ROOT);
        if (LANGUAGE_MAP.containsKey(clean)) {
            return LANGUAGE_MAP.get(clean);
        }
        try {
            Locale loc = new Locale.Builder().setLanguage(clean).build();
            String display = loc.getDisplayLanguage(Locale.ENGLISH);
            if (display != null && !display.isEmpty() && !display.equalsIgnoreCase(clean)) {
                return display;
            }
        } catch (Exception ignored) {}
        return null;
    }

    public static String formatAudioCodec(String codec, int channels) {
        if (codec == null || codec.trim().isEmpty()) {
            return channels == 6 ? "5.1 Surround" : channels == 2 ? "Stereo" : "";
        }
        String c = codec.trim().toLowerCase(Locale.ROOT);
        String name;
        if (c.contains("mp4a") || c.contains("aac")) name = "AAC";
        else if (c.contains("eac3") || c.contains("ec-3")) name = "E-AC-3 (Dolby Digital+)";
        else if (c.contains("ac-3") || c.contains("ac3")) name = "AC-3 (Dolby Digital)";
        else if (c.contains("dts")) name = "DTS";
        else if (c.contains("truehd") || c.contains("mlp")) name = "TrueHD";
        else if (c.contains("opus")) name = "Opus";
        else if (c.contains("flac")) name = "FLAC";
        else if (c.contains("vorb")) name = "Vorbis";
        else if (c.contains("mp3")) name = "MP3";
        else name = codec.toUpperCase(Locale.ROOT);

        if (channels == 1) return name + " (Mono)";
        if (channels == 2) return name + " (Stereo)";
        if (channels == 6) return name + " (5.1)";
        if (channels == 8) return name + " (7.1)";
        return name;
    }

    public static String formatSubtitleCodec(String codec) {
        if (codec == null || codec.trim().isEmpty()) return "Subtitle";
        String c = codec.trim().toLowerCase(Locale.ROOT);
        if (c.contains("subt") || c.contains("srt")) return "SRT";
        if (c.contains("ssa") || c.contains("ass")) return "ASS/SSA";
        if (c.contains("vtt")) return "WebVTT";
        if (c.contains("pgs") || c.contains("bd_sub")) return "PGS";
        if (c.contains("spu") || c.contains("dvd")) return "VobSub";
        return codec.toUpperCase(Locale.ROOT);
    }

    private File copyContentUriToCache(Uri contentUri) {
        try (InputStream in = activity.getContentResolver().openInputStream(contentUri)) {
            if (in == null) return null;
            File dir = new File(activity.getCacheDir(), "praha_subtitles");
            if (!dir.exists()) dir.mkdirs();
            String name = contentUri.getLastPathSegment();
            if (name == null || name.isEmpty()) name = "sub_" + System.currentTimeMillis() + ".srt";
            File dest = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) != -1) {
                    out.write(buf, 0, len);
                }
            }
            return dest;
        } catch (Exception e) {
            Log.e(TAG, "Failed copying content URI to cache", e);
            return null;
        }
    }

    private void notifyTracksChanged() {
        mainHandler.post(() -> {
            if (webView == null) return;
            try {
                String audioTracksJson = getAllAudioTracks();
                String spuTracksJson = getAllSpuTracks();
                int selectedAudio = getSelectedAudioTrack();
                int selectedSpu = getSelectedSpuTrack();

                JSONObject detail = new JSONObject();
                detail.put("audioTracks", new JSONArray(audioTracksJson));
                detail.put("spuTracks", new JSONArray(spuTracksJson));
                detail.put("selectedAudio", selectedAudio);
                detail.put("selectedSpu", selectedSpu);

                String js = String.format("window.dispatchEvent(new CustomEvent('praha:vlc-tracks', { detail: %s }));", detail.toString());
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {}
        });
    }

    private void notifyPlaybackProgress(long time, long length) {
        mainHandler.post(() -> {
            if (webView == null) return;
            String js = String.format(Locale.ROOT,
                    "window.dispatchEvent(new CustomEvent('praha:vlc-time', { detail: { time: %d, duration: %d } }));",
                    time, length);
            webView.evaluateJavascript(js, null);
        });
    }

    private void notifyPlaybackState(boolean playing, boolean buffering) {
        mainHandler.post(() -> {
            if (webView == null) return;
            String js = String.format(Locale.ROOT,
                    "window.dispatchEvent(new CustomEvent('praha:vlc-state', { detail: { playing: %b, buffering: %b } }));",
                    playing, buffering);
            webView.evaluateJavascript(js, null);
        });
    }

    private void notifyBuffering(float buffer) {
        mainHandler.post(() -> {
            if (webView == null) return;
            String js = String.format(Locale.ROOT,
                    "window.dispatchEvent(new CustomEvent('praha:vlc-buffering', { detail: { buffer: %.1f } }));",
                    buffer);
            webView.evaluateJavascript(js, null);
        });
    }

    private void notifyError(String message) {
        mainHandler.post(() -> {
            if (webView == null) return;
            try {
                JSONObject obj = new JSONObject();
                obj.put("message", message);
                String js = String.format("window.dispatchEvent(new CustomEvent('praha:vlc-error', { detail: %s }));", obj.toString());
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {}
        });
    }

    public void release() {
        stop();
        if (mediaPlayer != null) {
            try {
                mediaPlayer.detachViews();
                mediaPlayer.release();
            } catch (Exception ignored) {}
            mediaPlayer = null;
        }
        if (libVlc != null) {
            try {
                libVlc.release();
            } catch (Exception ignored) {}
            libVlc = null;
        }
        isInitialized = false;
    }
}
