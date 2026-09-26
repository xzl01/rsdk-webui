#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runs *inside* the rsdk build container. Everything outside of it (podman/docker
# orchestration, GitHub Actions) only has to invoke this file.
# ---------------------------------------------------------------------------
set -euo pipefail

# rsdk's jsonnet shells out to tools that live in /usr/sbin (sgdisk, resize2fs,
# ...). A login shell would drop that directory for non-root users, so make the
# search path explicit instead of depending on how this script was invoked.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

cd "${HOME:-/home/rsdk}"

echo "== rsdk-webui build =="
echo "profile : E25 (GH, 修复后) (gh-e25-06)"
echo "target  : radxa-e25 bookworm cli sector=512"
echo "rsdk    : $(dpkg-query -W -f='${Version}' rsdk 2>/dev/null || echo unknown)"
echo "arch    : $(uname -m)"
echo "user    : $(id -un) uid=$(id -u) gid=$(id -g) home=${HOME:-?}"
if [[ ! -w "${HOME:-/home/rsdk}" ]]; then
  echo "!! ${HOME:-/home/rsdk} 不可写：宿主 uid 与容器 uid 不一致，见 run.sh 的 hand_over/take_back" >&2
fi

# arm64 runs through qemu-user + binfmt_misc. binfmt_misc is a kernel feature,
# so on a host that has no handler registered (a fresh GitHub runner) the
# container has to register one. We run --privileged precisely for this, and
# binfmt-support's update-binfmts mounts binfmt_misc for us if needed.
setup_binfmt() {
  local entry=/proc/sys/fs/binfmt_misc/qemu-aarch64
  if grep -q '^enabled' "$entry" 2>/dev/null; then
    echo "binfmt  : qemu-aarch64 已注册"
    return 0
  fi
  echo "==> 注册 qemu-aarch64 binfmt handler"
  if sudo update-binfmts --enable qemu-aarch64 >/dev/null 2>&1 && grep -q '^enabled' "$entry" 2>/dev/null; then
    echo "binfmt  : 已启用"
  else
    echo "!! 无法注册 qemu-aarch64：arm64 构建会失败（需要 --privileged 与镜像里的 qemu-user-static）" >&2
  fi
}
setup_binfmt

echo

ARGS=(build --sector-size 512 --image-name output.img radxa-e25 bookworm cli)

# Reuse the previous build's rootfs.tar only when nothing that lands in the
# rootfs changed. This file lives in the working directory, which the caller
# shares between submissions of the same profile - so the cache actually
# survives, and still invalidates the moment the profile changes.
KEY_FILE="${HOME:-/home/rsdk}/.rsdk-webui-rootfs-key"
WANT_KEY=ae8ba082
if [[ "${RSDK_FORCE_REBUILD:-0}" == "1" ]]; then
  echo "rootfs cache : disabled by RSDK_FORCE_REBUILD"
elif [[ -f "$KEY_FILE" && "$(cat "$KEY_FILE")" == "$WANT_KEY" ]]; then
  echo "rootfs cache : reuse (key $WANT_KEY)"
else
  echo "rootfs cache : stale inputs (want $WANT_KEY, have $(cat "$KEY_FILE" 2>/dev/null || echo none)) -> --no-cache"
  ARGS+=(--no-cache)
fi

# --debs is only meaningful when the packages actually travelled with the
# bundle (they are copied in, never symlinked)
if [[ " ${ARGS[*]} " == *" --debs "* ]]; then
  if [[ -d /rsdk-bundle/debs ]] && compgen -G '/rsdk-bundle/debs/*.deb' >/dev/null; then
    echo "debs    : $(ls -1 /rsdk-bundle/debs/*.deb | wc -l) 个本地包"
  else
    echo "debs    : 未随构建包携带，忽略 --debs"
    NEW=()
    for ((i = 0; i < ${#ARGS[@]}; i++)); do
      [[ "${ARGS[i]}" == "--debs" ]] && { ((i++)); continue; }
      NEW+=("${ARGS[i]}")
    done
    ARGS=("${NEW[@]}")
  fi
fi

echo "+ rsdk ${ARGS[*]}"
rsdk "${ARGS[@]}"

# the rootfs.tar is now known-good for these inputs
printf '%s\n' "$WANT_KEY" > "$KEY_FILE"
