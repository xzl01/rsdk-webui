#!/usr/bin/env python3
"""
Check every board / suite / edition combination the catalog offers, without
building anything.

Two independent things have to resolve for a build to work:

  1. the *package list* of the edition (base/core/desktop/vendor packages, which
     live in the jsonnet modules) - rendered here by running `jsonnet` over the
     very same tree the build will mount, so conditionals and suite-specific
     entries are evaluated exactly as `rsdk build` would; and
  2. the *essential-hook* packages, which are not in that list at all:
     `task-<product>`, `<bootloader>-<product>`, `linux-image-<k>`,
     `linux-headers-<k>` and `<bootloader>-<f>`.

Everything is checked against the package indexes that were exported at deploy
time (stable and *-test repositories), so no network and no guessing.

    python3 ops/check-boards.py [--json out.json] [--only product] [--test-repo]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path(
    os.environ.get("RSDK_WEBUI_DATA", pathlib.Path.home() / ".local/share/rsdk-webui")
)
INDEX = ROOT / "web/public/pkgindex"
CATALOG = ROOT / "web/public/catalog.json"
BUNDLE_MOUNT = "/rsdk-bundle"


def load_index(suite: str) -> dict[str, dict] | None:
    """the shipped index for a suite, or None when it was not deployed/empty"""
    path = INDEX / f"{suite}.json.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        records = json.load(handle)
    # 空索引按"没有索引"处理：当作数据去判缺包会把所有组合误判成 broken
    return {record["n"]: record for record in records} if records else None


# --- packages qualified with a suite (e.g. libegl-mesa0/bookworm-backports) ---
# apt resolves those against that specific suite, so the base index is not
# enough. The extra suites are small and cached on disk.
DISTRO_COMPONENTS = {
    "debian": ["main", "contrib", "non-free", "non-free-firmware"],
    "ubuntu": ["main", "universe", "multiverse", "restricted"],
}
UBUNTU_SUITES = {"focal", "jammy", "noble", "oracular", "plucky", "resolute"}
QUALIFIED_CACHE: dict[str, set[str]] = {}


def distro_of(suite: str) -> str:
    return "ubuntu" if suite in UBUNTU_SUITES else "debian"


def is_ubuntu(suite: str) -> bool:
    return suite in UBUNTU_SUITES


# rsdk rewrites the *-backports source of an EOL suite to the Debian archive
# (`sed -i "s|https*://.*/|http://archive.debian.org/|"`), which is what makes
# bullseye still resolvable even though the suite is gone from the mirrors.
ARCHIVE = "https://archive.debian.org/debian"

# 实时抓取（updates/security/backports/PPA）失败 → 这个 suite 的"缺包"结论
# 可能是网络抖动造出来的假阴性。记录下来，相关组合的 verdict 降级为 unknown。
NET_BAD_QUALIFIED: set[str] = set()
NET_BAD_PPA: set[tuple[str, str]] = set()
# curl 的纯网络错误码：解析失败/连不上/超时/TLS/接收中断 —— 与 HTTP 404 区分开
NET_RC = {6, 7, 28, 35, 47, 56}


def curl_head(url: str) -> int:
    probe = subprocess.run(["curl", "-fsS", "-o", "/dev/null", "--max-time", "60", "-I", url], capture_output=True)
    return probe.returncode


def release_exists(url: str) -> bool:
    return curl_head(url) == 0


def distro_component_url(suite: str, component: str) -> str | None:
    """
    The URL apt would actually fetch for (suite, component), after rsdk's setup
    hooks have rewritten things. None when nothing serves it.
    """
    distro = distro_of(suite)
    if distro == "ubuntu":
        base = "https://ports.ubuntu.com/ubuntu-ports"
        candidates = [f"{base}/dists/{suite}/{component}/binary-arm64/Packages.gz"]
    else:
        if suite.endswith("-backports"):
            candidates = [
                f"https://deb.debian.org/debian/dists/{suite}/{component}/binary-arm64/Packages.xz",
                f"{ARCHIVE}/dists/{suite}/{component}/binary-arm64/Packages.xz",
            ]
        else:
            base = "https://deb.debian.org/debian"
            candidates = [f"{base}/dists/{suite}/{component}/binary-arm64/Packages.xz"]
    for url in candidates:
        rc = curl_head(url)
        if rc == 0:
            return url
        if rc in NET_RC:
            # 探测本身因为网络问题失败 —— 这个 suite 的数据不全，不是"不存在"
            NET_BAD_QUALIFIED.add(suite)
    return None


# rsdk adds these on top of the distro + radxa repositories; a package that only
# lives in one of them is *available*, and missing it here would be a false
# "upstream cannot build this" claim.
LAUNCHPAD = "https://ppa.launchpadcontent.net"
ALWAYS_PPA = {"ubuntu": ["mozillateam/ppa"]}
PPA_CACHE: dict[tuple[str, str], set[str]] = {}


SUITE_SET_CACHE: dict[str, set[str]] = {}


def all_distro_names(suite: str) -> set[str]:
    """
    Everything apt could install by name for this suite: the base archive plus
    the updates/backports/security suites rsdk configures. A package with no
    suite qualifier can come from *any* of them, which is easy to forget and
    turns into a fabricated "missing package" report.
    """
    if suite in SUITE_SET_CACHE:
        return SUITE_SET_CACHE[suite]
    names: set[str] = set()
    for candidate in (suite, f"{suite}-updates", f"{suite}-backports", f"{suite}-security"):
        names |= qualified_index(candidate)
    SUITE_SET_CACHE[suite] = names
    return names


def product_ppas(product: dict, socs: list[dict], suite: str) -> list[str]:
    names = list(ALWAYS_PPA.get(distro_of(suite), []))
    for entry in socs:
        if set(entry.get("soc_list", [])) & set(product.get("soc", [])):
            for ppa in entry.get("extra_ppa") or []:
                names.append(ppa)
    return names


def ppa_index(ppa: str, suite: str) -> set[str]:
    key = (ppa, suite)
    if key in PPA_CACHE:
        return PPA_CACHE[key]
    owner, _, name = ppa.partition("/")
    url = f"{LAUNCHPAD}/{owner}/{name}/ubuntu/dists/{suite}/main/binary-arm64/Packages.gz"
    tmp = pathlib.Path("/tmp") / f"ppa-{owner}-{name}-{suite}.gz"
    names: set[str] = set()
    got = subprocess.run(["curl", "-fsSL", "--max-time", "180", "-o", str(tmp), url], capture_output=True)
    if got.returncode == 0:
        text = gzip.decompress(tmp.read_bytes()).decode("utf-8", "replace")
        for line in text.splitlines():
            if line.startswith("Package: "):
                names.add(line[9:].strip())
    else:
        print(f"   ! PPA 取不到: {ppa} ({suite})", file=sys.stderr)
        NET_BAD_PPA.add(key)
    tmp.unlink(missing_ok=True)
    PPA_CACHE[key] = names
    return names


def qualified_index(suite: str) -> set[str]:
    """package names available from a specific distro suite (backports/updates/…)"""
    if suite in QUALIFIED_CACHE:
        return QUALIFIED_CACHE[suite]
    names: set[str] = set()
    for component in DISTRO_COMPONENTS['ubuntu' if is_ubuntu(suite) else 'debian']:
        url = distro_component_url(suite, component)
        if url is None:
            continue
        tmp = pathlib.Path("/tmp") / f"q-{suite}-{component}.xz"
        if url.endswith(".gz"):
            got = subprocess.run(["curl", "-fsSL", "--max-time", "300", "-o", str(tmp), url], capture_output=True)
            if got.returncode != 0:
                continue
            text = gzip.decompress(tmp.read_bytes()).decode("utf-8", "replace")
        else:
            got = subprocess.run(["curl", "-fsSL", "--max-time", "300", "-o", str(tmp), url], capture_output=True)
            if got.returncode != 0:
                continue
            text = subprocess.run(["xz", "-dc", str(tmp)], capture_output=True).stdout.decode("utf-8", "replace")
        for line in text.splitlines():
            if line.startswith("Package: "):
                names.add(line[9:].strip())
        tmp.unlink(missing_ok=True)
    QUALIFIED_CACHE[suite] = names
    return names


def bootloader_prefix(product: dict, socs: list[dict]) -> str:
    for entry in socs:
        if set(entry.get("soc_list", [])) & set(product["soc"]):
            return entry.get("firmware_type") or "u-boot"
    return product.get("firmware_type") or "u-boot"


def required_essential(product: dict, boot: str, suite: str) -> list[str]:
    name = product["product"]
    return [
        f"task-{name}",
        f"{boot}-{name}",
        f"linux-image-{name}",
        f"linux-headers-{name}",
    ]


def find_build_tree() -> pathlib.Path | None:
    """a directory holding build/ and configs/, as the server caches them"""
    trees = CACHE / "rsdk-trees"
    if not trees.exists():
        return None
    for entry in sorted(trees.iterdir(), reverse=True):
        if (entry / "build" / "rootfs.jsonnet").exists():
            return entry
    return None


def engine_args() -> list[str]:
    """
    Same discovery the server does: podman's default store is unusable when its
    graph root sits on btrfs, so fall back to a dedicated one.
    """
    engine = os.environ.get("RSDK_WEBUI_ENGINE", "podman")
    if engine != "podman":
        return []
    try:
        subprocess.run(["podman", "info"], capture_output=True, timeout=20, check=True)
        return []
    except Exception:
        pass

    root, runroot = CACHE / "podman-root", CACHE / "podman-run"
    root.mkdir(parents=True, exist_ok=True)
    runroot.mkdir(parents=True, exist_ok=True)
    try:
        fs = subprocess.run(
            ["stat", "-f", "-c", "%T", str(CACHE)], capture_output=True, text=True
        ).stdout.strip()
    except Exception:
        fs = ""
    driver = fs if fs in ("btrfs", "zfs") else "overlay"
    candidate = ["--root", str(root), "--runroot", str(runroot), "--storage-driver", driver]
    try:
        subprocess.run(["podman", *candidate, "info"], capture_output=True, timeout=30, check=True)
        return candidate
    except Exception:
        return ["--root", str(root), "--runroot", str(runroot), "--storage-driver", "vfs"]


def extract_build_tree(dest: pathlib.Path) -> pathlib.Path:
    """pull build/ and configs/ out of the image, exactly like the server does"""
    engine = os.environ.get("RSDK_WEBUI_ENGINE", "podman")
    image = os.environ.get("RSDK_WEBUI_IMAGE", "rsdk-image:latest")
    probe = subprocess.run(
        [engine, *engine_args(), "image", "exists", image], capture_output=True
    )
    if probe.returncode != 0:
        sys.exit(f"{image} 未导入，先跑 ./ops/setup.sh")
    print(f"从 {image} 导出 rsdk jsonnet 树…")
    tar = dest / "build.tar"
    cmd = [
        engine, *engine_args(), "run", "--rm", "--entrypoint", "tar", image,
        "-cf", "-", "-C", "/usr/share/rsdk", "build", "configs",
    ]
    with open(tar, "wb") as handle:
        done = subprocess.run(cmd, stdout=handle, stderr=subprocess.PIPE, timeout=900)
    if done.returncode != 0:
        sys.exit(f"导出失败: {done.stderr.decode()[-400:]}")
    subprocess.run(["tar", "-xf", str(tar), "-C", str(dest)], check=True)
    tar.unlink(missing_ok=True)
    tree = dest / "build" / "rootfs.jsonnet"
    if not tree.exists():
        sys.exit("导出后仍找不到 build/rootfs.jsonnet")
    return dest


RENDER_SCRIPT = r"""
set -e
while IFS=$'\t' read -r product suite edition; do
  [ -z "$product" ] && continue
  if out=$(jsonnet \
      --tla-str "product=$product" --tla-str "suite=$suite" --tla-str "edition=$edition" \
      --tla-str "temp_dir=/tmp/rsdk-check" --tla-str "output_dir=/tmp/rsdk-check" \
      --tla-str "build_date=2026-01-01T00:00:00" --ext-code "sdboot=false" \
      /usr/share/rsdk/build/rootfs.jsonnet 2>/tmp/jsonnet-err); then
    printf '%s\t%s\t%s\t' "$product" "$suite" "$edition"
    printf '%s' "$out" | jq -c '[.mmdebstrap.packages[]] | unique'
  else
    printf '%s\t%s\t%s\tRENDER-ERROR: %s\n' "$product" "$suite" "$edition" "$(head -c 200 /tmp/jsonnet-err | tr '\n' ' ')"
  fi
done
"""


def render_package_lists(
    combos: list[tuple[str, str, str]],
    tree: pathlib.Path | None = None,
) -> dict[tuple[str, str, str], object]:
    if tree is None:
        tree = find_build_tree()
    if tree is None:
        # standalone use: pull the tree straight out of the image so this script
        # does not depend on the server having run first
        scratch = pathlib.Path("/tmp") / f"rsdk-tree-{os.getpid()}"
        scratch.mkdir(parents=True, exist_ok=True)
        tree = extract_build_tree(scratch)

    engine = os.environ.get("RSDK_WEBUI_ENGINE", "podman")

    payload = "\n".join("\t".join(combo) for combo in combos) + "\n"
    cmd = [
        engine, *engine_args(), "run", "--rm", "-i",
        "-v", f"{tree}/build:/usr/share/rsdk/build:ro",
        "-v", f"{tree}/configs:/usr/share/rsdk/configs:ro",
        "--entrypoint", "bash", os.environ.get("RSDK_WEBUI_IMAGE", "rsdk-image:latest"),
        "-c", RENDER_SCRIPT,
    ]
    result = subprocess.run(cmd, input=payload, capture_output=True, text=True, timeout=3600)
    if result.returncode != 0:
        sys.exit(f"rendering failed: {result.stderr[-2000:]}")

    out: dict[tuple[str, str, str], object] = {}
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        key = (parts[0], parts[1], parts[2])
        value = parts[3]
        if value.startswith("RENDER-ERROR"):
            out[key] = value
        else:
            out[key] = json.loads(value)
    return out


def _hint_for(row: dict) -> str:
    """one actionable sentence for the UI, per failure shape"""
    text = " ".join(row["problems"] + row["warnings"])
    if "firefox-esr" in text:
        return "上游的桌面包清单里有无条件的 firefox-esr，而 Ubuntu 不提供这个包（只有 firefox）。这是上游 jsonnet 的问题。"
    if "bullseye-backports" in text or "maliit-keyboard" in text:
        return "bullseye 已 EOL：网络相关的 backports 包已下架，而 maliit-keyboard 从 bookworm 才有。这是上游 jsonnet 与仓库状态不一致。"
    if "linux-image" in text and "都没有" in text:
        return "这块板子的内核包在稳定源和测试源里都没有发布过，无法构建。"
    if "只能用 test 源" in text:
        return "这块板子的内核包只在测试源 (-test) 里，需要打开「使用测试源」。"
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", help="also write the full result as JSON here")
    parser.add_argument(
        "--verdicts",
        help="write a compact per-combination verdict for the UI (web/public/boards.json)",
    )
    parser.add_argument("--only", help="check a single product")
    parser.add_argument(
        "--tree",
        help="目录，内含 build/ 与 configs/（默认用缓存里的，或从镜像里现抽）",
    )
    parser.add_argument("--quiet", action="store_true", help="only print problems")
    args = parser.parse_args()

    catalog = json.loads(CATALOG.read_text()) if CATALOG.exists() else None
    if catalog is None:
        sys.exit("web/public/catalog.json missing - run ./ops/emit-static-assets.sh")
    socs = catalog.get("socs") or []

    products = catalog["products"]
    if args.only:
        products = [p for p in products if p["product"] == args.only]

    combos: list[tuple[str, str, str]] = []
    for product in products:
        for suite in product["supported_suite"]:
            for edition in product["supported_edition"]:
                combos.append((product["product"], suite, edition))
    combos.sort()

    print(f"检查 {len(products)} 个板子 / {len(combos)} 个 (suite, edition) 组合\n")
    print("渲染各 edition 的软件包列表（在容器里跑 jsonnet）…")
    rendered = render_package_lists(combos, pathlib.Path(args.tree) if args.tree else None)
    print(f"  拿到 {len(rendered)} 份列表\n")

    indexes: dict[str, dict[str, dict] | None] = {}

    results = []
    for product in products:
        name = product["product"]
        boot = bootloader_prefix(product, socs)
        for suite in product["supported_suite"]:
            if suite not in indexes:
                indexes[suite] = load_index(suite)
            index = indexes[suite]

            for edition in product["supported_edition"]:
                key = (name, suite, edition)
                rendered_list = rendered.get(key)
                essential = required_essential(product, boot, suite)
                ppas = product_ppas(product, socs, suite)

                problems: list[str] = []
                warnings: list[str] = []

                ppa_names: set[str] = set()
                for ppa in ppas:
                    ppa_names |= ppa_index(ppa, suite)

                if index is None:
                    problems.append(f"没有 {suite} 的包索引")
                elif isinstance(rendered_list, str):
                    problems.append(rendered_list)
                else:
                    # editions: every entry has to resolve, including
                    # `pkg/suite` ones against that particular suite
                    known_suites = {
                        suite,
                        f"{suite}-backports",
                        f"{suite}-updates",
                        f"{suite}-security",
                    }
                    distro_names = all_distro_names(suite)
                    missing_edition = []
                    for pkg in rendered_list:
                        if "/" in pkg:
                            bare, _, qualifier = pkg.partition("/")
                            if qualifier not in known_suites:
                                missing_edition.append(f"{pkg}(未知 suite 限定)")
                            elif bare not in qualified_index(qualifier):
                                missing_edition.append(pkg)
                        elif pkg not in index and pkg not in ppa_names and pkg not in distro_names:
                            missing_edition.append(pkg)
                    # essential hook: counted against the stable repo, since that
                    # is the default; -test only packages are reported separately
                    def stable(name_: str) -> bool:
                        record = index.get(name_)
                        return (bool(record) and record.get("t") != 1) or name_ in ppa_names

                    def anywhere(name_: str) -> bool:
                        return name_ in index or name_ in ppa_names

                    missing_essential = [pkg for pkg in essential if not stable(pkg)]
                    test_only = [pkg for pkg in missing_essential if anywhere(pkg)]
                    hard_missing = [pkg for pkg in missing_essential if not anywhere(pkg)]

                    if missing_edition:
                        problems.append("edition 缺包: " + ", ".join(sorted(set(missing_edition))[:6]))
                    if hard_missing:
                        problems.append("stable/test 都没有: " + ", ".join(sorted(set(hard_missing))))
                    if test_only and not hard_missing:
                        warnings.append("只能用 test 源: " + ", ".join(sorted(set(test_only))))

                    # the soc-specific radxa repository does not have to exist,
                    # but if it does not, most of the board's packages are missing
                    soc_repos = [f"{soc}-{suite}" for soc in product["soc"]]

                results.append(
                    {
                        "product": name,
                        "suite": suite,
                        "edition": edition,
                        "boot": boot,
                        "packages": len(rendered_list) if isinstance(rendered_list, list) else 0,
                        "problems": problems,
                        "warnings": warnings,
                        # 有问题时若恰逢网络数据不全，verdict 会标 unknown 而非 broken
                        "netDegraded": bool(problems)
                        and (suite in NET_BAD_QUALIFIED or any((ppa, suite) in NET_BAD_PPA for ppa in ppas)),
                    }
                )

    ok = [r for r in results if not r["problems"]]
    warn = [r for r in results if not r["problems"] and r["warnings"]]
    bad = [r for r in results if r["problems"]]

    if not args.quiet:
        print("按板子汇总：")
        by_product: dict[str, list[dict]] = {}
        for r in results:
            by_product.setdefault(r["product"], []).append(r)
        for name, rows in sorted(by_product.items()):
            state = "OK  " if all(not r["problems"] for r in rows) else "FAIL"
            if all(not r["problems"] for r in rows) and any(r["warnings"] for r in rows):
                state = "TEST"
            detail = " ".join(f"{r['suite']}/{r['edition']}({r['packages']}包)" for r in rows)
            print(f"  {state} {name:26} {detail}")
        print()

    print(f"合计 {len(results)} 个组合：{len(ok) - len(warn)} 可直接构建，"
          f"{len(warn)} 需要 --test-repo，{len(bad)} 会失败\n")
    if args.quiet and bad:
        for r in bad:
            print(f"  FAIL {r['product']:24} {r['suite']}/{r['edition']:6} {'; '.join(r['problems'])[:110]}")

    if warn and not args.quiet:
        print("需要测试源 (-test)：")
        for r in warn:
            print(f"  {r['product']:26} {r['suite']}/{r['edition']:6} {r['warnings'][0]}")

    if bad and not args.quiet:
        print("\n会构建失败：")
        for r in bad:
            print(f"  {r['product']:26} {r['suite']}/{r['edition']:6} {'; '.join(r['problems'])}")

    if args.verdicts:
        combos_out: dict[str, dict] = {}
        for r in results:
            key = f"{r['product']}|{r['suite']}|{r['edition']}"
            if r["problems"]:
                if r.get("netDegraded"):
                    combos_out[key] = {
                        "status": "unknown",
                        "missing": r["problems"],
                        "hint": "部署体检时软件源/PPA 抓取失败，数据不全 —— 这个结论可能是网络抖动造成的误报，可以直接尝试构建。",
                    }
                else:
                    combos_out[key] = {
                        "status": "broken",
                        "missing": r["problems"],
                        "hint": _hint_for(r),
                    }
            elif r["warnings"]:
                combos_out[key] = {"status": "test", "missing": r["warnings"], "hint": _hint_for(r)}
            else:
                combos_out[key] = {"status": "ok"}
        payload = {
            "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
            "image": os.environ.get("RSDK_WEBUI_IMAGE", "rsdk-image:latest"),
            "rsdkVersion": catalog.get("rsdkVersion"),
            "combos": combos_out,
        }
        pathlib.Path(args.verdicts).write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        broken = sum(1 for v in combos_out.values() if v["status"] == "broken")
        test = sum(1 for v in combos_out.values() if v["status"] == "test")
        unknown = sum(1 for v in combos_out.values() if v["status"] == "unknown")
        print(
            f"\n体检表写入 {args.verdicts}：{len(combos_out) - broken - test - unknown} 可构建 / "
            f"{test} 需 test 源 / {broken} 会失败 / {unknown} 数据不全（unknown）"
        )

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(f"完整结果写入 {args.json}")

    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
