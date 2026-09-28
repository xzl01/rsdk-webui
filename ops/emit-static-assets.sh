#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rsdk-webui - generate the static assets a backend-less (GitHub Pages) build
# of the UI needs.
#
# Everything here is derived from the *same* container image that a build will
# use, so the Pages site can never offer a board or a jsonnet tree that the
# builder does not actually have:
#
#   web/public/catalog.json         boards, socs, suites, editions, rsdk version
#   web/public/rsdk-tree.json       the image's /usr/share/rsdk/build tree
#   web/public/pkgindex/<suite>.json.gz
#                                   Debian + radxa packages for that suite
#
# Usage:  ./ops/emit-static-assets.sh [--with-index] [--suites a,b,c]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${RSDK_WEBUI_DATA:-$HOME/.local/share/rsdk-webui}"
IMAGE="${RSDK_WEBUI_IMAGE:-rsdk-image:latest}"
OUT="$ROOT/web/public"
WITH_INDEX=0
SUITES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-index) WITH_INDEX=1; shift ;;
    --suites) SUITES="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- container engine (same discovery rules as the server) ------------------
ENGINE="${RSDK_WEBUI_ENGINE:-}"
if [[ -z $ENGINE ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else die "neither podman nor docker is installed"
  fi
fi
ENGINE_ARGS=()
if [[ $ENGINE == podman && "$(stat -f -c %T "$DATA" 2>/dev/null || echo unknown)" == btrfs ]]; then
  if ! podman info >/dev/null 2>&1; then
    ENGINE_ARGS=(--root "$DATA/podman-root" --runroot "$DATA/podman-run" --storage-driver btrfs)
  fi
fi
engine() { "$ENGINE" "${ENGINE_ARGS[@]}" "$@"; }

log "engine: $ENGINE ${ENGINE_ARGS[*]:-（默认存储）}"
if ! engine inspect "$IMAGE" >/dev/null 2>&1; then
  other=p
  [[ $ENGINE == podman ]] && other=docker || other=podman
  if command -v "$other" >/dev/null 2>&1 && "$other" inspect "$IMAGE" >/dev/null 2>&1; then
    die "$IMAGE 在 $other 的存储里，但当前用的是 $ENGINE；设 RSDK_WEBUI_ENGINE=$other 或重跑 ./ops/setup.sh"
  fi
  die "$IMAGE 未导入，先跑 ./ops/setup.sh"
fi

mkdir -p "$OUT"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- 1. pull configs + jsonnet tree out of the image ------------------------
log "从 $IMAGE 导出 configs 与 /usr/share/rsdk/build"
engine run --rm --entrypoint tar "$IMAGE" -cf - -C /usr/share/rsdk configs build | tar -xf - -C "$work"

# --- 2. catalog -------------------------------------------------------------
version="$(engine run --rm --entrypoint dpkg-query "$IMAGE" -W -f='${Version}' rsdk | tr -d '\r\n')"
python3 - "$work/configs/products.json" "$work/configs/socs.json" "$OUT/catalog.json" "$version" "$IMAGE" <<'PY'
import json, sys

products_path, socs_path, dest, version, image = sys.argv[1:6]
products = json.load(open(products_path, encoding="utf-8"))
socs = json.load(open(socs_path, encoding="utf-8"))

def firmware_type(names: list[str]) -> str | None:
    """socs.json maps a SoC *list* to 'u-boot' or 'edk2'"""
    for entry in socs:
        if set(socs_entry_soc(entry)) & set(names):
            return entry.get("firmware_type")
    return None


def socs_entry_soc(entry: dict) -> list[str]:
    value = entry.get("soc_list")
    return value if isinstance(value, list) else []


normalised = []
for product in products:
    soc = product.get("soc")
    sector = product.get("sector_size")
    soc_list = soc if isinstance(soc, list) else ([soc] if soc else [])
    normalised.append({
        **product,
        "firmware_type": firmware_type(soc_list),
        # rsdk 0.1.0 (in the released image) stores these as scalars,
        # upstream HEAD uses arrays - normalise once, here
        "soc": soc if isinstance(soc, list) else ([soc] if soc else []),
        "sector_size": sector if isinstance(sector, list) else ([sector] if sector is not None else [512]),
    })

catalog = {
    "source": "static",
    "rsdkVersion": version,
    "image": image,
    "product": "static",
    "products": sorted(normalised, key=lambda p: p["product"]),
    "socs": socs if isinstance(socs, list) else [],
    "suites": sorted({s for p in normalised for s in p.get("supported_suite", [])}),
    "editions": sorted({e for p in normalised for e in p.get("supported_edition", [])}),
}
with open(dest, "w", encoding="utf-8") as handle:
    json.dump(catalog, handle, ensure_ascii=False, indent=1)
print(f"   板子 {len(catalog['products'])} 款 · rsdk {version} · suites {','.join(catalog['suites'])}")
PY

# --- 3. the jsonnet tree the build mounts ----------------------------------
# Bundled as a {path: content} map so the browser can patch rootfs.jsonnet and
# commit the whole thing without needing a tar implementation.
log "导出 rsdk-tree.json"
python3 - "$work/build" "$OUT/rsdk-tree.json" <<'PY'
import json, os, sys

src, dest = sys.argv[1], sys.argv[2]
tree: dict[str, str] = {}
for root, _dirs, files in os.walk(src):
    for name in files:
        full = os.path.join(root, name)
        with open(full, encoding="utf-8") as handle:
            tree[os.path.relpath(full, src)] = handle.read()
with open(dest, "w", encoding="utf-8") as handle:
    json.dump(tree, handle, ensure_ascii=False, indent=1)
print(f"   {len(tree)} 个 jsonnet 文件, {os.path.getsize(dest) // 1024} KiB")
PY

# --- 4. package index ------------------------------------------------------
if [[ $WITH_INDEX == 1 ]]; then
  suites="${SUITES:-$(jq -r '.suites | join(",")' "$OUT/catalog.json")}"
  mkdir -p "$OUT/pkgindex"
  log "导出包索引: ${suites//,/ }"
  for suite in ${suites//,/ }; do
    python3 "$ROOT/ops/pkgindex.py" --suite "$suite" --catalog "$OUT/catalog.json" --out "$OUT/pkgindex/$suite.json.gz" \
      || die "suite $suite 的包索引生成失败（多半是软件源抓取失败），不要带着空索引部署"
  done
else
  log "跳过包索引（加 --with-index 生成）"
fi

# --- 5. per-combination verdicts -------------------------------------------
# Renders every (board, suite, edition) package list with the same jsonnet tree
# and checks it against the index we just built, so the UI can warn about a
# combination that upstream cannot actually build - instead of letting the user
# discover it 30 minutes into a build.
log "体检每个 (board, suite, edition) 组合"
python3 "$ROOT/ops/check-boards.py" --tree "$work" --verdicts "$OUT/boards.json" --quiet >/dev/null || \
  log "  体检未全部通过（boards.json 里会标出来）"

log "done"
ls -lh "$OUT/catalog.json" "$OUT/rsdk-tree.json" 2>/dev/null | awk '{print "   " $9, $5}'
[[ -d $OUT/pkgindex ]] && du -sh "$OUT/pkgindex" | awk '{print "   pkgindex/", $1}'
