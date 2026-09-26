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
echo "profile : E25 (GitHub Actions) (gh-e25-01)"
echo "target  : radxa-e25 bookworm cli sector=512"
echo "rsdk    : $(dpkg-query -W -f='${Version}' rsdk 2>/dev/null || echo unknown)"
echo "arch    : $(uname -m)"
echo

ARGS=(build --sector-size 512 --image-name output.img radxa-e25 bookworm cli)

# reuse the previous rootfs.tar only when nothing that lands in the rootfs
# changed; otherwise force rsdk to rebuild it
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

echo "+ rsdk ${ARGS[*]}"
rsdk "${ARGS[@]}"

# the rootfs.tar is now known-good for these inputs
printf '%s\n' "$WANT_KEY" > "$KEY_FILE"
