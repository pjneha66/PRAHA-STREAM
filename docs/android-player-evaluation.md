# Android-native player evaluation

## Recommendation

Prototype AndroidX Media3 / ExoPlayer as an **optional Android-only** player, retaining the current WebView player for web and as a fallback. This is an evaluation, not an implementation or a guarantee that any particular source will play. PRAHA currently plays HTML5, HLS.js, dash.js and mpegts.js inside WebView and can hand streams to external players. A native engine may improve device codec access, adaptive playback and Android TV behavior, but actual codec, container and audio support depends on the device and source.

## Integration work

1. Add an Android native player activity or Capacitor plugin and a user-selectable player preference. Do not replace web playback or silently switch external/embedded/YouTube streams.
2. Pass only the selected stream, title, allowed request headers, resume position and subtitle tracks through a controlled bridge. Preserve the existing header proxy semantics, including redirects and adaptive manifests, without exposing headers or tokens in diagnostics. Define stream-format hints rather than relying only on URL suffixes.
3. Return progress, duration, completion, errors and close events to React. Preserve per-profile history, resume, next episode, subtitles, intro skipping and source fallback. Handle Android lifecycle, Back, orientation, PiP, audio focus and TV remote navigation.
4. Use Media3's supported HLS, DASH and progressive media modules and track-selection APIs. DRM, protected streams, custom request headers, subtitle formats, and network redirects need explicit design and device testing; do not promise universal compatibility.
5. On initialization or playback failure, offer retry, another source, the current WebView player, or an external player. Avoid automatic switching loops or accidental playback of another source.

## Validation before release

Build and test an APK on real phones and Android TV: HLS (including protected headers/segments), DASH, MP4, MPEG-TS, subtitles, audio tracks, pause/resume, seek, source switching, progress, next episode, PiP and orientation. Test slow/offline networks, expired URLs, failed requests, app backgrounding, and resume after process death. Measure startup time, rebuffering and dropped frames against WebView using the same authorized streams. Verify provider terms and dependency licenses before shipping. Android SDK and physical devices are required; a web build alone cannot validate the native path.
