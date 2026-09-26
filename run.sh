#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Host-side driver: run the build bundle in the rsdk container.
#
#   ./run.sh                     # use host.env / environment defaults
#   RSDK_ENGINE=docker ./run.sh  # override
#
# Environment:
#   RSDK_ENGINE              podman | docker        (default: docker)
#   RSDK_ENGINE_ARGS_FILE    file with one engine global arg per line
#   RSDK_ENGINE_ARGS         string with engine global args
#   RSDK_RUN_EXTRA           extra `run` args, e.g. "--userns=keep-id"
#   RSDK_IMAGE               container image (default: rsdk-image:latest)
#   RSDK_NO_TTY              set to 1 to omit -t
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$HERE/host.env" ]] && source "$HERE/host.env"

ENGINE="${RSDK_ENGINE:-docker}"
IMAGE="${RSDK_IMAGE:-rsdk-image:latest}"

# engine global args: the environment wins over the file, never both (they
# would be applied twice)
ARGS=()
if [[ -n "${RSDK_ENGINE_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  ARGS=($RSDK_ENGINE_ARGS)
elif [[ -n "${RSDK_ENGINE_ARGS_FILE:-}" && -f "$HERE/$RSDK_ENGINE_ARGS_FILE" ]]; then
  mapfile -t ARGS < "$HERE/$RSDK_ENGINE_ARGS_FILE"
fi

RUN_EXTRA=()
if [[ -n "${RSDK_RUN_EXTRA:-}" ]]; then
  # shellcheck disable=SC2206
  RUN_EXTRA=($RSDK_RUN_EXTRA)
fi

TTY=()
if [[ "${RSDK_NO_TTY:-0}" != "1" ]]; then TTY=(-t); fi

# The build must run as the image's rsdk user (uid 1000): rsdk build needs its
# passwordless sudo to run bdebstrap, and sudo is matched by user, not by uid.
# So when the host user is somebody else - GitHub runners are not always 1000 -
# we borrow the host sudo once before and once after the build to hand the
# working directory back and forth.
CONTAINER_UID=1000
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
HOST_SUDO="${RSDK_HOST_SUDO:-}"

# The working directory holds rsdk's rootfs cache, so the caller can point it at
# a location that is shared between submissions of the same profile.
WORK="${RSDK_WORK_DIR:-$HERE/work}"
mkdir -p "$WORK"

# libguestfs uses KVM to accelerate the appliance that builds the disk image.
# It checks access("/dev/kvm", R_OK|W_OK) and silently degrades to pure TCG
# emulation otherwise - much slower, plus a scary sounding warning. GitHub
# runners do expose /dev/kvm, but as root:kvm 0660 with a gid the container user
# is not in, so pass that group through when it is actually needed.
GROUP_ARGS=()
if [[ -c /dev/kvm ]]; then
  kvm_mode="$(stat -c '%a' /dev/kvm 2>/dev/null || true)"
  kvm_gid="$(stat -c '%g' /dev/kvm 2>/dev/null || true)"
  echo "kvm    : /dev/kvm mode=${kvm_mode:-?} gid=${kvm_gid:-?}"
  case "$kvm_mode" in
    *6|*7) ;; # already writable by group and others
    *)
      if [[ -n "$kvm_gid" ]]; then
        # rootless podman already forwards the caller's supplementary groups via
        # --userns=keep-id, and --group-add there would need a gid inside the
        # subuid range; docker needs to be told explicitly.
        if [[ "$ENGINE" == docker ]]; then
          GROUP_ARGS=(--group-add "$kvm_gid")
          echo "kvm    : 容器用户不在该组，补上 --group-add $kvm_gid"
        elif ! id -G | tr ' ' '
' | grep -qx "$kvm_gid"; then
          echo "kvm    : /dev/kvm 归 gid $kvm_gid 且当前用户不在组内，镜像阶段会退化成 TCG 模拟" >&2
        fi
      fi
      ;;
  esac
fi

echo "engine : $ENGINE ${ARGS[*]}"
echo "image  : $IMAGE"
echo "bundle : $HERE"
echo "work   : $WORK"
echo "host   : uid=$HOST_UID gid=$HOST_GID, container runs as uid $CONTAINER_UID"
echo

hand_over() {
  [[ "$HOST_UID" == "$CONTAINER_UID" ]] && return 0
  if [[ -z "$HOST_SUDO" ]]; then
    echo "run.sh: 容器以 uid $CONTAINER_UID 运行，而当前用户是 uid $HOST_UID。" >&2
    echo "run.sh: 设 RSDK_HOST_SUDO=sudo 让它接管 $WORK 的属主（CI 里都这么做）。" >&2
    return 0
  fi
  $HOST_SUDO chown -R "$CONTAINER_UID:$CONTAINER_UID" "$WORK"
}

take_back() {
  [[ "$HOST_UID" == "$CONTAINER_UID" ]] && return 0
  [[ -n "$HOST_SUDO" ]] || return 0
  $HOST_SUDO chown -R "$HOST_UID:$HOST_GID" "$WORK"
}

hand_over

set -x
"$ENGINE" "${ARGS[@]}" run --rm \
  --name "rsdk-webui-$(basename "$HERE")" \
  --privileged \
  --user "$CONTAINER_UID:$CONTAINER_UID" \
  ${GROUP_ARGS[@]+"${GROUP_ARGS[@]}"} \
  ${RUN_EXTRA[@]+"${RUN_EXTRA[@]}"} \
  "${TTY[@]}" \
  -h rsdk-webui \
  -e TERM=xterm-256color \
  -e HOME=/home/rsdk \
  -v /dev:/dev \
  -v "$HERE:/rsdk-bundle" \
  -v "$WORK:/home/rsdk" \
  -v "$HERE/rsdk-build:/usr/share/rsdk/build:ro" \
  -w /home/rsdk \
  --shm-size=1g \
  "$IMAGE" \
  bash /rsdk-bundle/inner.sh
RC=$?
set +x

take_back
exit "$RC"
