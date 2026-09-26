#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fetch the official rsdk-image Debian package, extract its embedded container
# image and load it into the local engine. This is the exact environment
# Radxa ships for offline rsdk use.
#
#   ./fetch-image.sh [cache-dir] [target-tag]
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="${RSDK_IMAGE_VERSION:-0.1.0-1}"
CACHE="${1:-$PWD/.rsdk-cache}"
TAG="${2:-${RSDK_IMAGE:-rsdk-image:latest}}"
ENGINE="${RSDK_ENGINE:-docker}"
DEB="rsdk-image_${VERSION}_amd64.deb"
URL="https://github.com/radxa-pkg/rsdk-image/releases/download/${VERSION}/${DEB}"

extract_ar() { # <archive> <dest>
  if command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$1" -C "$2"
  else
    ( cd "$2" && ar x "$1" )
  fi
}

mkdir -p "$CACHE"
cd "$CACHE"

if [[ ! -s $DEB ]]; then
  echo "==> downloading $DEB"
  curl -fL --retry 3 --retry-delay 2 -o "$DEB.part" "$URL"
  mv "$DEB.part" "$DEB"
else
  echo "==> cached $DEB"
fi

if [[ ! -s image.tar ]]; then
  echo "==> extracting image.tar"
  rm -rf .x && mkdir .x
  extract_ar "$DEB" .x
  data="$(ls .x/data.tar.* | head -n 1)"
  tar -xf "$data" -C .x ./usr/share/rsdk-image/image.tar
  mv .x/usr/share/rsdk-image/image.tar .
  rm -rf .x
fi

echo "==> loading image into $ENGINE"
"$ENGINE" load -i image.tar
"$ENGINE" tag rsdk-image:latest "$TAG" 2>/dev/null || true
echo "==> done: $TAG"
