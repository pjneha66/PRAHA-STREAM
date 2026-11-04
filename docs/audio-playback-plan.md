# Audio playback plan: Android and web

## Problem and scope

PRAHA currently plays direct media with the browser/WebView video element, hls.js, dash.js or mpegts.js. The reported silent stream was labelled Matroska (MKV) with Dolby Digital Plus (E-AC-3) / Atmos audio. That label is a clue, not proof of the codec in the file or of the cause. Browser and device codec support varies. Simply changing the HTML player controls or remuxing the file will not decode an unsupported audio track.

This is an implementation plan, **not an implemented decoder**. Do not put signed media URLs, addon credentials, or private headers into test fixtures, logs or documentation.

## Android: optional native playback

1. Add a selectable Android-only native player using AndroidX Media3 ExoPlayer. Keep WebView and external players as explicit fallbacks; embeds, YouTube and unresolved magnets retain their existing paths. Media3 supports Matroska as a container, but its default audio decoders are supplied by the device, so this alone does **not** guarantee E-AC-3 playback.
2. Prototype the Media3 FFmpeg audio decoder extension with `eac3` (and `ac3` if needed) as a software fallback. Build from the matching Media3 version's official instructions, including supported ABIs. Evaluate binary size, downmixing, performance, FFmpeg configuration and redistribution/licensing obligations before distribution. E-AC-3 JOC/Atmos spatial output must not be promised: verify the actual decoded output and fall back to ordinary audio where supported.
3. Define a narrow native bridge. Pass a resolved direct stream URL, allowed request headers, explicit format hints, title, resume position and subtitles without persisting or logging secrets. Use a lifecycle-aware activity/plugin and native networking that applies headers safely through redirects and adaptive playlist/segment requests. Do not expose an unauthenticated network proxy.
4. Return progress, duration, completion, selected audio track, errors and close events to the existing React session. Preserve profile history, resume, subtitle selection, next episode, Back, Android TV controls, PiP and audio focus. Allow users to choose audio tracks; report unsupported or unavailable audio rather than silently reporting success.
5. Roll out behind a preference. On failure, offer WebView, another source and external VLC rather than silently restarting or repeatedly switching engines.

References: [Media3 supported formats](https://developer.android.com/media/media3/exoplayer/supported-formats), [Media3 FFmpeg decoder instructions](https://github.com/androidx/media/tree/release/libraries/decoder_ffmpeg).

## Web: browser playback plus optional transcoding service

1. Retain the current direct player for compatible streams. Offer alternate audio tracks where the relevant playback engine exposes them, and explain that available tracks and codecs depend on the browser. Browser APIs do not reliably detect a video that is playing silently because an audio codec is unsupported.
2. For incompatible streams, prototype an **optional self-hosted** transcoding service. After explicit user action, inspect the source and produce short HLS segments with AAC audio; copy compatible video where possible and transcode video only when required. The browser plays the resulting same-origin HLS. Support seeking, track selection, cancellation, expired upstream URLs and cleanup of sessions/segments. A server is required; the current Vite dev server and static production build are not a production transcoder.
3. Protect the service against SSRF, redirect/DNS rebinding and access to private networks and metadata endpoints. Authenticate and authorize sessions; restrict upstream destinations, protocols and redirects; impose CPU, memory, bandwidth, process count and session limits; isolate FFmpeg; expire output and do not log or return credentials. Do not send signed URLs or request headers to a third party without explicit consent. Decide deployment, trust and retention policies before enabling it.
4. Evaluate browser-side streaming demux/decode as a separate experiment, not a promised fix. Full-file ffmpeg.wasm processing is a poor default for long videos due to memory, startup, performance and browser isolation constraints; it is not equivalent to a proven seekable streaming decoder. Codec availability and licensing need separate review.

## Acceptance and verification

- Use a licensed test fixture with known video, AAC, AC-3 and E-AC-3 tracks, including a multi-language MKV. Verify actual audible output and track changes on Android phones and Android TV, with and without platform E-AC-3 support, and in Chrome, Firefox and Safari where available.
- Test HLS/DASH/progressive playback, seek and resume, end/next episode, audio focus, orientation, subtitles, backgrounding, expired links, header-protected streams, and graceful fallback. Test service access controls, resource limits, redirects and cleanup separately.
- Test direct playback remains unchanged when the new features are disabled; do not claim Atmos passthrough or universal codec support without device-specific verification.
- An Android SDK/JDK, Android build dependencies and real devices are required. This workspace currently has neither a JDK nor Android SDK, and its network allowlist excludes Google's Maven repository. It cannot validate an Android player build or device audio here. A hosted or user-run backend is also not currently present for the web approach.
