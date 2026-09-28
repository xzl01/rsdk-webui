#!/usr/bin/env python3
"""
Build the package index that the backend-less UI ships as a static asset.

One file per suite, containing every package the builder could install for that
suite: Debian/Ubuntu plus every radxa-deb repository relevant to it (the family
repo and each SoC-specific repo mentioned in the catalog). Entries are slimmed to
what the picker needs, and radxa packages win over same-named distro ones.

    python3 ops/pkgindex.py --suite bookworm --catalog web/public/catalog.json \
                            --out web/public/pkgindex/bookworm.json.gz
"""
from __future__ import annotations

import argparse
import gzip
import json
import lzma
import sys
import urllib.error
import urllib.request

RADXA_BASE = "https://radxa-repo.github.io"

DEBIAN_COMPONENTS = ["main", "contrib", "non-free", "non-free-firmware"]
UBUNTU_COMPONENTS = ["main", "universe", "multiverse", "restricted"]
UBUNTU_SUITES = {"focal", "jammy", "noble", "oracular", "plucky", "resolute"}


def distro_of(suite: str) -> str:
    return "ubuntu" if suite in UBUNTU_SUITES else "debian"


def sources(suite: str, socs: list[str]) -> list[tuple[str, str, bool, bool]]:
    """(label, url, is_radxa, is_test_repo)"""
    out: list[tuple[str, str, bool, bool]] = []
    if distro_of(suite) == "debian":
        base, comps = "https://deb.debian.org/debian", DEBIAN_COMPONENTS
    else:
        base, comps = "https://ports.ubuntu.com/ubuntu-ports", UBUNTU_COMPONENTS
    for comp in comps:
        out.append((f"{distro_of(suite)}/{suite}/{comp}", f"{base}/dists/{suite}/{comp}/binary-arm64/Packages.xz", False, False))
    # stable radxa repositories first, then their -test counterparts, so a
    # package present in both keeps the stable marking
    for suffix, is_test in (("", False), ("-test", True)):
        names = [f"{suite}{suffix}"] + [f"{soc}-{suite}{suffix}" for soc in socs]
        for name in names:
            out.append((f"radxa/{name}", f"{RADXA_BASE}/{name}/dists/{name}/main/binary-arm64/Packages.gz", True, is_test))
    return out


def fetch(url: str) -> bytes | None:
    try:
        with urllib.request.urlopen(url, timeout=180) as response:
            return response.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as err:
        print(f"   ! {url}: {err}", file=sys.stderr)
        return None


def decompress(raw: bytes, url: str) -> str:
    if url.endswith(".xz"):
        return lzma.decompress(raw).decode("utf-8", "replace")
    if url.endswith(".gz"):
        return gzip.decompress(raw).decode("utf-8", "replace")
    return raw.decode("utf-8", "replace")


def parse(text: str, is_radxa: bool, is_test: bool, out: dict[str, dict]) -> int:
    added = 0
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        name = version = arch = section = desc = ""
        field = ""
        for line in block.split("\n"):
            # 续行（以空格/Tab 开头）属于**上一个字段**，而不是「我们记住的那个字段」。
            # Tag: 也是多行字段，之前一律往 desc 上追加，结果一堆 debtags
            # （uitoolkit::sdl, …）被粘进了包描述里。
            if line[:1] in (" ", "\t") and field == "Description":
                desc += " " + line.strip()
                continue
            field, _, value = line.partition(":")
            value = value.strip()
            if field == "Package":
                name = value
            elif field == "Version":
                version = value
            elif field == "Architecture":
                arch = value
            elif field == "Section":
                section = value
            elif field == "Description":
                desc = value
        if not name or arch not in ("arm64", "all"):
            continue
        previous = out.get(name)
        if previous is not None:
            if previous["radxa"] and not is_radxa:
                continue  # radxa wins over the distro
            if not previous.get("t") and is_test:
                continue  # already known from a stable repository
            if previous.get("t") == 1 and not is_test and not previous["radxa"]:
                pass
        out[name] = {
            "n": name,
            "v": version,
            "a": arch,
            "s": section,
            "d": desc.split("\n")[0][:200],
            "radxa": is_radxa,
            **({"t": 1} if is_test else {}),
        }
        added += 1
    return added


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.catalog, encoding="utf-8") as handle:
        catalog = json.load(handle)

    # every SoC that appears for this suite, so one file serves any board
    socs: list[str] = []
    for product in catalog["products"]:
        if args.suite in product.get("supported_suite", []):
            for soc in product.get("soc", []):
                if soc not in socs:
                    socs.append(soc)

    print(f"   {args.suite}: {len(socs)} 个 SoC 仓库")
    packages: dict[str, dict] = {}
    distro_ok = False
    for label, url, is_radxa, is_test in sources(args.suite, socs):
        raw = fetch(url)
        if raw is None:
            continue
        if not is_radxa:
            distro_ok = True
        added = parse(decompress(raw, url), is_radxa, is_test, packages)
        print(f"   {label}: +{added}")

    # 一个空索引部署出去，UI 搜索和 check-boards 的体检会全错且毫无报错 ——
    # 发行版基础源（或全部源）抓取失败时宁可直接失败，也不要写空文件
    if not distro_ok:
        print(f"   !! {args.suite}: 发行版软件源全部抓取失败，拒绝生成空索引", file=sys.stderr)
        return 1
    if not packages:
        print(f"   !! {args.suite}: 没有解析到任何软件包", file=sys.stderr)
        return 1

    ordered = [packages[name] for name in sorted(packages)]
    payload = json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(args.out, "wb") as handle:
        with gzip.GzipFile(fileobj=handle, mode="wb", compresslevel=9) as gz:
            gz.write(payload)
    import os

    print(f"   -> {args.out}: {len(ordered)} 个包, {os.path.getsize(args.out) // 1024} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
