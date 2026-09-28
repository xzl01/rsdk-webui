#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rsdk-webui - host preparation
#
# Downloads the official rsdk-image Debian package, extracts the container image
# it carries and loads it into a container engine. On filesystems where podman's
# overlay driver cannot work (btrfs), it sets up an isolated storage root that
# rsdk-webui uses exclusively, so your own podman store is never touched.
#
#   ./ops/setup.sh [--engine podman|docker] [--force]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${RSDK_WEBUI_DATA:-$HOME/.local/share/rsdk-webui}"
VERSION="${RSDK_WEBUI_IMAGE_VERSION:-0.1.0-1}"
IMAGE="${RSDK_WEBUI_IMAGE:-rsdk-image:latest}"
ENGINE="${RSDK_WEBUI_ENGINE:-}"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$DATA/cache" "$DATA/podman-root" "$DATA/podman-run"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- pick an engine -------------------------------------------------------
if [[ -z $ENGINE ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else die "neither podman nor docker is installed"
  fi
fi
command -v "$ENGINE" >/dev/null 2>&1 || die "$ENGINE not found"

ENGINE_ARGS=()
if [[ $ENGINE == podman && "$(stat -f -c %T "$DATA" 2>/dev/null || echo unknown)" == btrfs ]]; then
  # podman's overlay driver does not work on btrfs; use an isolated btrfs store
  if ! podman info >/dev/null 2>&1; then
    log "podman default store unusable (btrfs/overlay), switching to an isolated storage root"
    ENGINE_ARGS=(--root "$DATA/podman-root" --runroot "$DATA/podman-run" --storage-driver btrfs)
  fi
fi

engine() { "$ENGINE" "${ENGINE_ARGS[@]}" "$@"; }

log "engine: $ENGINE ${ENGINE_ARGS[*]:-（默认存储）}"

# --- fetch the image ------------------------------------------------------
CACHE="$DATA/cache"
DEB="rsdk-image_${VERSION}_amd64.deb"
cd "$CACHE"

# 下载 (~480MB) + 解包 (~2.2GB image.tar) + 导入 (~3GB) 都吃磁盘；写满才知道
# 不够就太晚了，而且半截产物会让后续判断（! -s image.tar）变得含糊
if [[ $FORCE == 1 || ! -s $DEB || ! -s image.tar ]]; then
  avail_kb="$(df -Pk "$DATA" | awk 'NR==2 {print $4}')"
  if [[ -n $avail_kb ]] && (( avail_kb < 8 * 1024 * 1024 )); then
    die "磁盘空间不足：$DATA 所在卷可用约 $(( avail_kb / 1024 / 1024 )) GiB，下载+解包+导入需要 ~8 GiB，请先清理"
  fi
fi

if [[ $FORCE == 1 || ! -s $DEB ]]; then
  log "downloading $DEB (~480 MB)"
  curl -fL --retry 3 --retry-delay 2 -o "$DEB.part" \
    "https://github.com/radxa-pkg/rsdk-image/releases/download/${VERSION}/${DEB}"
  mv "$DEB.part" "$DEB"
else
  log "using cached $DEB"
fi

if [[ $FORCE == 1 || ! -s image.tar ]]; then
  log "extracting image.tar"
  rm -rf .x && mkdir .x
  if command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$DEB" -C .x
  else
    ( cd .x && ar x "../$DEB" )
  fi
  data_archive="$(ls .x/data.tar.* | head -n 1)"
  tar -xf "$data_archive" -C .x ./usr/share/rsdk-image/image.tar
  mv .x/usr/share/rsdk-image/image.tar .
  rm -rf .x
fi

log "loading into $ENGINE"
engine load -i image.tar
engine tag rsdk-image:latest "$IMAGE" >/dev/null 2>&1 || true

log "verifying"
engine run --rm --entrypoint bash "$IMAGE" -lc 'echo -n "rsdk "; dpkg-query -W -f="${Version}\n" rsdk'
engine images --format '{{.Repository}}:{{.Tag}} {{.Size}}' "$IMAGE"
echo "image.tar checksum: $(du -h image.tar | cut -f1)"

cat <<EOF

$(printf '\033[1;32mdone\033[0m')

  engine args : ${ENGINE_ARGS[*]:-(none)}
  image       : $IMAGE
  data dir    : $DATA

Start the UI with:

  pnpm install && pnpm dev

EOF
