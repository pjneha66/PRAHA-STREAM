#!/usr/bin/env bash
# Fetches the pinned upstream sources that android/cloudstream-lib is compiled from.
#
# CloudStream's `library` module *is* the API that real .cs3 extensions are compiled
# against, so it is built from source at a pinned commit rather than resolved from
# JitPack: JitPack is unreachable from CI, and a moving branch would silently change
# the ABI that installed extensions were linked to.
#
# The checkout lands in android/upstream/ (gitignored). Run this before building the
# Android app; the Gradle build fails with a clear message if it is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

CS_COMMIT="${CS_COMMIT:-a7ac454af8fbd64574c96847a936905855911720}"
NICEHTTP_TAG="${NICEHTTP_TAG:-0.4.18}"
DEST="android/upstream"

fetch() { # url dir ref
  if [ ! -d "$DEST/$2/.git" ]; then
    mkdir -p "$DEST"
    git init -q "$DEST/$2"
    git -C "$DEST/$2" remote add origin "$1"
  fi
  git -C "$DEST/$2" fetch -q --depth 1 origin "$3"
  git -C "$DEST/$2" checkout -q FETCH_HEAD
  echo "$DEST/$2 @ $(git -C "$DEST/$2" rev-parse --short HEAD)"
}

fetch https://github.com/recloudstream/cloudstream.git cloudstream "$CS_COMMIT"
fetch https://github.com/Blatzar/NiceHttp.git nicehttp "refs/tags/$NICEHTTP_TAG"
