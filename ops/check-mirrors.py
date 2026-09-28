#!/usr/bin/env python3
"""
rsdk-webui - 复核 shared/src/presets.ts 里的镜像 preset 是否真的可用。

为什么要单独一个脚本：preset 列表是「选了就能用」的承诺，但镜像站会加也会撤。
曾经踩过 —— 列表里同时列着 USTC 和清华 TUNA 的 radxa-deb，而这两个站根本没有
这个仓库，选中后 rsdk 拼出的 apt 源 404，构建在 apt-get update 阶段就崩了。

探测路径按 rsdk 自己的拼法（vendor/rsdk/.../mod/distro.libjsonnet +
additional_repos.libjsonnet）：

  radxa   deb <mirror>/<name> <name> main        name = <suite> 或 <soc>-<suite>
          -> <mirror>/<name>/dists/<name>/Release
  distro  (distro_mirror) + "/" + distro         distro = debian | ubuntu-ports
          -> <mirror>/debian/dists/<suite>/Release
          -> <mirror>/debian-security/dists/<suite>-security/Release

用法：
    ./ops/check-mirrors.py            # 全查
    ./ops/check-mirrors.py --json     # 机器可读
退出码：radxa preset 在基线 suite 上不可用 -> 1（这样以后可以挂进 CI 或发布流程）
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PRESETS = ROOT / "shared/src/presets.ts"

# 基线：默认 bookworm 的板子最多，这一档坏了就是真坏了
BASELINE_SUITE = "bookworm"
BASELINE_SOC = "rk3588"
# 其余 suite 只做展示（镜像站同步速度不一，缺 trixie 不该判失败）
EXTRA_SUITES = [("noble", "qcs6490"), ("trixie", "a311d")]


def parse_presets() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """从 presets.ts 读出两组 (label, value)，不重复维护一份 URL 列表。"""
    text = PRESETS.read_text(encoding="utf-8")

    def block(name: str) -> list[tuple[str, str]]:
        start = text.index(f"export const {name} = [")
        end = text.index("]", start)
        out: list[tuple[str, str]] = []
        for label, value in re.findall(r"\{\s*label:\s*'([^']*)',\s*value:\s*'([^']*)'\s*\}", text[start:end]):
            out.append((label, value))
        return out

    return block("RADXA_MIRRORS"), block("DISTRO_MIRRORS")


def probe(url: str, timeout: int = 30) -> tuple[bool, str]:
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "rsdk-webui-mirror-check"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200, str(response.status)
    except urllib.error.HTTPError as err:
        return False, str(err.code)
    except Exception as err:  # DNS / TLS / 超时
        return False, type(err).__name__


def radxa_urls(mirror: str, suite: str, soc: str) -> list[str]:
    base = mirror.rstrip("/")
    return [
        f"{base}/{suite}/dists/{suite}/Release",
        f"{base}/{soc}-{suite}/dists/{soc}-{suite}/Release",
    ]


def distro_urls(mirror: str) -> list[str]:
    base = mirror.rstrip("/")
    return [
        f"{base}/debian/dists/bookworm/Release",
        f"{base}/debian-security/dists/bookworm-security/Release",
        f"{base}/ubuntu-ports/dists/noble/Release",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    radxa, distro = parse_presets()
    report: dict = {"radxa": [], "distro": [], "broken": []}

    for label, mirror in radxa:
        if not mirror:
            report["radxa"].append({"label": label, "mirror": mirror, "ok": True, "paths": [("官方源", "skip")]})
            continue
        paths = radxa_urls(mirror, BASELINE_SUITE, BASELINE_SOC)
        results = [(url, probe(url)) for url in paths]
        ok = all(got for _, (got, _) in results)
        extra = []
        for suite, soc in EXTRA_SUITES:
            for url in radxa_urls(mirror, suite, soc)[:1]:
                extra.append((url, probe(url)))
        report["radxa"].append(
            {
                "label": label,
                "mirror": mirror,
                "ok": ok,
                "paths": [(url, str(code)) for url, (_, code) in results],
                "extra": [(url, str(code)) for url, (_, code) in extra],
            }
        )
        if not ok:
            report["broken"].append(mirror)

    for label, mirror in distro:
        if not mirror:
            report["distro"].append({"label": label, "mirror": mirror, "ok": True, "paths": [("上游默认", "skip")]})
            continue
        results = [(url, probe(url)) for url in distro_urls(mirror)]
        ok = all(got for _, (got, _) in results)
        report["distro"].append(
            {"label": label, "mirror": mirror, "ok": ok, "paths": [(url, str(code)) for url, (_, code) in results]}
        )
        if not ok:
            report["broken"].append(mirror)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"radxa-deb 镜像（基线 {BASELINE_SUITE}/{BASELINE_SOC}-{BASELINE_SUITE}）")
        for row in report["radxa"]:
            mark = "OK  " if row["ok"] else "BAD "
            print(f"  {mark}{row['label']}")
            for url, code in row["paths"]:
                print(f"       {code:>4}  {url}")
            for url, code in row.get("extra", []):
                print(f"       {code:>4}  {url}   (参考，不计入判定)")
        print("\n发行版镜像")
        for row in report["distro"]:
            mark = "OK  " if row["ok"] else "BAD "
            print(f"  {mark}{row['label']}")
            for url, code in row["paths"]:
                print(f"       {code:>4}  {url}")
        if report["broken"]:
            print("\n不可用：" + ", ".join(report["broken"]), file=sys.stderr)

    return 1 if report["broken"] else 0


if __name__ == "__main__":
    sys.exit(main())
