#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build a fresh rsdk container image from upstream source.
#
# The released radxa-pkg/rsdk-image .deb carries an rsdk frozen at the release
# date (0.1.0 -> 40 boards). Use this when you want the current upstream rsdk
# (43 boards, newer packages) instead:
#
#   ./ops/build-rsdk-image.sh && RSDK_WEBUI_IMAGE=rsdk-webui/rsdk:latest pnpm start
#
# Uses the rsdk-image Dockerfile verbatim - only the tag is ours.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${RSDK_WEBUI_DATA:-$HOME/.local/share/rsdk-webui}"
TAG="${1:-rsdk-webui/rsdk:latest}"
SRC="${RSDK_IMAGE_SRC:-$ROOT/vendor/rsdk-image}"
RSDK_REF="${RSDK_REF:-main}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

if [[ ! -f $SRC/Dockerfile ]]; then
  log "cloning rsdk-image"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 https://github.com/radxa-pkg/rsdk-image.git "$SRC"
fi

ENGINE="${RSDK_WEBUI_ENGINE:-podman}"
ENGINE_ARGS=()
if [[ $ENGINE == podman && "$(stat -f -c %T "$DATA" 2>/dev/null || echo unknown)" == btrfs ]]; then
  if ! podman info >/dev/null 2>&1; then
    ENGINE_ARGS=(--root "$DATA/podman-root" --runroot "$DATA/podman-run" --storage-driver btrfs)
  fi
fi

log "building $TAG from $SRC (rsdk $RSDK_REF)"
# The Dockerfile clones RadxaOS-SDK/rsdk at its default branch; patch the ref if
# a specific one was requested.
if [[ $RSDK_REF != main ]]; then
  tmp="$(mktemp -d)"
  cp -a "$SRC"/. "$tmp"/
  sed -i "s#RadxaOS-SDK/rsdk.git#RadxaOS-SDK/rsdk.git -b $RSDK_REF#" "$tmp/Dockerfile"
  SRC="$tmp"
  trap 'rm -rf "$tmp"' EXIT
fi

"$ENGINE" "${ENGINE_ARGS[@]}" build -t "$TAG" "$SRC"

log "verifying"
"$ENGINE" "${ENGINE_ARGS[@]}" run --rm --entrypoint bash "$TAG" -lc \
  'dpkg-query -W -f="${Package} ${Version}\n" rsdk librtui; jq length /usr/share/rsdk/configs/products.json'

cat <<EOF

done. Start the UI against it with:

  RSDK_WEBUI_IMAGE=$TAG pnpm start

EOF
