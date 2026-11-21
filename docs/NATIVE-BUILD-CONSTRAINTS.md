# Native build constraints on this machine — read before Phase 3/4

_Measured 2026-11-20 on the phone host. These are facts, not guesses._

## The host is aarch64

```
uname -m  →  aarch64
```

## Google's NDK has no aarch64 host toolchain

I downloaded the full `android-ndk-r28c-linux.zip` (722,261,334 bytes) and listed its
toolchain directories:

```
android-ndk-r28c/toolchains/llvm/prebuilt/linux-x86_64/     ← the only one
```

`repository2-3.xml` confirms it: NDK 28.2.13676358 ships `linux`, `macosx`, `windows`
archives, and every `linux` archive is x86_64. There is no `linux-aarch64` NDK.

**Consequence:** any Gradle module that runs `externalNativeBuild`/CMake
(`:libass`, `dovi_bridge.cpp`, `media3_ffmpeg_decoder`) **cannot be compiled here**.
`qemu-x86_64-static` exists on the box but an NDK cross-compile under emulation is
both extremely slow and known to fail on clang's response-file handling.

## But we do not need to compile anything

`libmpv.so` in the prebuilt AAR already contains both native libraries that Phase 1.5
and 1.7 were going to build:

```
$ grep -a -o 'ass_renderer_init|ass_set_fonts|libass' jni/arm64-v8a/libmpv.so
ass_renderer_init
ass_set_fonts
libass

$ grep -a -o 'dovi_[a-z_]*|DOVI' jni/arm64-v8a/libmpv.so
dovi_alloc
dovi_find_level
dovi_reshape
dovi_rpu
```

The AAR's `assets/licenses/` also lists `libass`, `libdovi`, `libplacebo`, `harfbuzz`,
`fribidi`, `freetype`, `libunibreak`, `dav1d`, `lua`, `openssl` — all statically linked
into `libmpv.so`.

So the revised plan:

| Original task | Revised |
|---|---|
| 1.2 CMake + NDK | **dropped** — nothing compiles |
| 1.5 libdovi via `downloadLibdovi` | **dropped** — inside `libmpv.so` |
| 1.7 `:libass` module (21 Kotlin + 1,146 C) | **dropped** — inside `libmpv.so` |
| 1.8 `dovi_bridge.cpp`, `media3_ffmpeg_decoder` | **dropped** — mpv handles DV; Media3 uses platform decoders |

What remains, and all of it is prebuilt:

| Task | Artifact | Resolves |
|---|---|---|
| mpv AAR | `edde746:mpv-android:d633bbc71269@aar` (Ivy from GitHub release) | 53,934,545 B, sha256 `4bf8a972…9df7` |
| Media3 | `androidx.media3:media3-*:1.11.0` | all 7 verified 200 on Google Maven |
| cronet | `org.chromium.net:cronet-embedded:143.7445.0` | 200 |
| TorrServer | prebuilt arm64 + armv7 binaries | verified earlier |

## Trade-off to be aware of

Media3 without the FFmpeg adapter falls back to **platform** decoders only. That means
no software-decoded DTS/TrueHD audio in the Media3 engine. mpv still handles those
(its own FFmpeg is bundled), so the fallback path stays lossless — you just get it from
mpv rather than Media3. Since both engines ship, nothing is lost in practice.

Dolby Vision: mpv's `dovi_*` symbols mean DV profile 5/8 reshaping works through mpv.
Media3 on a DV-capable panel uses the platform decoder, which is the normal path anyway.

## What this means for the phases

Phases 3 and 4 lose the "copy the C/C++ in" steps and keep the Kotlin/TS porting, which
was always the bulk of the work (5,273 + 1,343 Kotlin LOC for mpv; 12,878 for Media3).
Net saving is roughly 3 days, and the build becomes a plain Java/Kotlin assemble.
