# PRAHA STREAM — Notices and third-party components

PRAHA STREAM is free software licensed under the **GNU General Public License,
version 3** (see [`LICENSE`](LICENSE)). The project is distributed in source
form; the GPL-3.0 also applies to the release APKs built from this repository.

## Code ported from VyseTV

A substantial part of the Android feature set is a clean-room-free, direct port
of **VyseTV** (Flutter/Dart), which is distributed under GPL-3.0. Copyright in
that original work remains with the VyseTV authors and contributors. The ported
areas include:

- the 39 film/TV scrapers and the Movy source list (`services/filmSources.ts`);
- the mpv player integration and mpv-android AAR wiring;
- the Media3/ExoPlayer engine adapted into a Capacitor plugin;
- Live TV helpers (EPG, match finder, portal browser, group trees, playlists);
- the manga chapter reader (webtoon and paged modes);
- the audiobook source adapters and music client;
- the tuned TorrServer settings profile and foreground-service model.

Where a file carries an original GPL header or a "ported from" comment, that
notice has been preserved.

## Bundled native components

| Component | Licence | Notes |
|---|---|---|
| **TorrServer** — [YouROK/TorrServer](https://github.com/YouROK/TorrServer) | GPL-3.0 | Prebuilt Go binaries (`torrserver-android-*`) shipped in `android/app/src/main/jniLibs/<abi>/libtorrserver.so`. Launched as a separate process and contacted over `127.0.0.1` HTTP. Its full licence is included in `LICENSE`; upstream source is available at the URL above. |
| **mpv / mpv-android** — [mpv-player/mpv](https://github.com/mpv-player/mpv), AAR by [edde746/mpv-build](https://github.com/edde746/mpv-build) | GPL-2.0-or-later (libmpv LGPL-2.1+ where applicable) | `libmpv.so`, FFmpeg, libass and libdovi are statically linked in the AAR. The AAR is fetched by checksum from its upstream release, not modified. |
| **AndroidX Media3 / ExoPlayer** | Apache-2.0 | Used through the standard Android dependencies. |
| **Cronet** | BSD-style (Chromium) | `org.chromium.net:cronet-embedded`. |
| **Capacitor, React, Vite, React Native community packages** | MIT / Apache-2.0 / respective licences | See each package's own licence in `node_modules`. |

## Other upstream projects

PRAHA also integrates Nuvio, Stremio and PlayTorrio addon sources, Sanka and
Comick comic sources, WeebCentral manga, InnerTube-based music, and the public
trackers list from [ngosang/trackerslist](https://github.com/ngosang/trackerslist).
Those services are contacted at runtime; no third-party source code other than
the components listed above is redistributed in the APK.

## Source availability

The complete corresponding source for this application — including the
Capacitor native plugins, the native build scripts and the web application — is
available from the repository from which these builds were made. If you received
a release APK without a repository link, contact the distributor for the source.

This notice is provided for information only and is not legal advice.
