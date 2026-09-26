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

mkdir -p "$HERE/work" "$HERE/work/home"

echo "engine : $ENGINE ${ARGS[*]}"
echo "image  : $IMAGE"
echo "bundle : $HERE"
echo

set -x
exec "$ENGINE" "${ARGS[@]}" run --rm \
  --name "rsdk-webui-$(basename "$HERE")" \
  --privileged \
  ${RUN_EXTRA[@]+"${RUN_EXTRA[@]}"} \
  "${TTY[@]}" \
  -h rsdk-webui \
  -e TERM=xterm-256color \
  -e HOME=/home/rsdk \
  -v /dev:/dev \
  -v "$HERE:/rsdk-bundle" \
  -v "$HERE/work:/home/rsdk" \
  -v "$HERE/rsdk-build:/usr/share/rsdk/build:ro" \
  -w /home/rsdk \
  --shm-size=1g \
  "$IMAGE" \
  bash /rsdk-bundle/inner.sh
