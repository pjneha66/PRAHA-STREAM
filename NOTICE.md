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

## Code ported from CloudStream

The CloudStream extension host is a direct port of **CloudStream 3**
([recloudstream/cloudstream](https://github.com/recloudstream/cloudstream)),
distributed under GPL-3.0. Copyright in that original work remains with the
CloudStream authors and contributors. Two kinds of code are involved:

- **The extension API itself.** `android/cloudstream-lib` compiles CloudStream's
  `library` module from source at the pinned commit
  `a7ac454af8fbd64574c96847a936905855911720`, plus the NiceHttp dependency at
  tag `0.4.18`. It is not modified in substance; it is built from the upstream
  tree so installed `.cs3` extensions link against a matching ABI. The upstream
  sources are fetched by `scripts/fetch-cloudstream-upstream.sh` and are not
  committed to this repository.
- **The app-side host.** The classes under
  `android/app/src/main/java/com/lagradost/cloudstream3/` reimplement the parts
  of CloudStream's `app` module that extensions call into — `CloudStreamApp`,
  `CommonActivity`, `Plugin`, `DataStore`, `Event`, `UiText`, `VideoClickAction`,
  `ResultEpisode` and the settings/repository records — and the files under
  `com/praha/stream/cloudstream/` port upstream's `PluginManager`,
  `RepositoryManager` and the home/catalog plumbing onto PRAHA's bridge.

These are ports, not the upstream application: they are cut down to the surface
extensions actually use, and the player, UI and download machinery are PRAHA's
own. Where a ported file differs from upstream, the difference is a deliberate
reduction rather than an unmarked change. The complete corresponding source for
both the library and the host is available from this repository.

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

## Code ported from Hikari

The extension-ecosystem support — the Sora module, SkyStream plugin, Zangetsu
provider and AnymeX (Mangayomi-format) extension runtimes, their installers,
and the boot harnesses those ecosystems' plugins are written against — is a
port of **Hikari** ([codegeasse1/hikari](https://github.com/codegeasse1/hikari)),
which is distributed under GPL-3.0. Copyright in that original work remains
with its author (Copyright (C) 2026 Codegeasse) and contributors. The ported
files are `services/ecosystems/` and the pieces of `services/pluginRuntime.ts`,
`services/nuvioWorker.ts` and `components/EcosystemsPanel.tsx` that carry the
ecosystem call and storage plumbing. QuickJS-only parts of upstream's engines
(the timer pumps and native crypto bridges) are dropped where the browser
runtime already provides the equivalent, and the native-only embed-extractor
stack answers empty; everything else follows the reference behaviour,
including the response envelopes, caps and error strings.

This notice is provided for information only and is not legal advice.

The Android video download engine and Media3 dialogue-cut processor also come
from Hikari. PRAHA adapts their queue, network transport and playback controls
to its Android host. The Telegram public preview and authenticated TDLib
client and streaming data source are adapted from Hikari's Telegram modules.
PRAHA includes TDLib's JNI binaries and Java bindings from that revision under
the Boost Software License 1.0. See the bundled TDLib licence.
The offline Piper voice setup uses sherpa-onnx 1.13.8 from its
[official release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8).
Piper voice packs are installed separately from their upstream release and
retain the licence supplied with each model.
The Telegram JNI build and its TLS libraries come from Telegram X 0.29.0.1813,
as documented by Hikari. The APK bundles the OpenSSL licence alongside the
TDLib licence. The Telegram build uses PRAHA's packaged Android C++ runtime.
