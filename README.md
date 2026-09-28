# rsdk-webui

Interactive web UI for composing and building [RadxaOS](https://github.com/RadxaOS-SDK/rsdk)
system images, with the build running either in a **local container** (podman /
docker) or on **GitHub Actions**.

It is a thin layer over the official toolchain — `rsdk build`, the official
`rsdk-image` container, the upstream jsonnet tree — with no reimplementation of
the build engine. See [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit
together and why each decision was made.

```
┌ 定制流程 ──────┬──────────────────────────────────────────────┬─ 生成物预览 ─┐
│ 1 开发板与系统 │  选择开发板 (40 款，跟随 rsdk 的 BSP 支持)   │ rsdk build   │
│ 2 软件源       │  Radxa / Debian 镜像、test 源、快照           │  --sector…   │
│ 3 软件包       │  64k 包索引搜索 + 常用组合                   │ profile.json │
│ 4 系统配置     │  主机名、时区、用户、SSH、Wi-Fi、服务        │ install.sh   │
│ 5 覆盖与脚本   │  往 rootfs 塞文件 / 跑自己的脚本             │ inner.sh     │
│ 6 构建后端     │  本机容器 或 GitHub Actions                  │ run.sh       │
│ 7 确认构建     │  预检 + 实时日志 + 产物下载                  │              │
└────────────────┴──────────────────────────────────────────────┴──────────────┘
```

## Requirements

* Linux with podman (preferred) or docker
* Node.js ≥ 20 and pnpm
* ~8 GB free disk for the container image + one build
* the `gh` CLI logged in, only if you want the GitHub Actions backend

## Quick start

```bash
./ops/setup.sh      # download the official rsdk image (~480 MB) and load it
pnpm install
pnpm dev            # UI on http://127.0.0.1:5173, API on :8787
```

Single-process mode:

```bash
pnpm build          # build the web bundle
pnpm start          # serve UI + API on http://127.0.0.1:8787
```

Then open the UI, walk through the wizard, and hit **开始构建**. The first thing
worth doing is the **环境准备** page, which shows whether the engine, image and
rsdk tree are usable.

## Building an image is scriptable

Everything the UI does is also a directory of plain files:

```bash
# after a build, or via the preview panel's "导出 profile"
cd ~/.local/share/rsdk-webui/builds/<job-id>
./fetch-image.sh          # once
./run.sh                  # ~20-60 min for an arm64 image on x86_64
ls work/out/*/output.img
```

The bundle is self-contained: `profile.json` (re-importable by the UI),
`run.sh` / `inner.sh` (the build), `rsdk-build/` (the patched jsonnet tree) and
`customize/` (the actual customization). Copy it anywhere.

## Backends

| backend | requires | notes |
|---|---|---|
| `local-docker` | podman or docker + the `rsdk-image` container | `--privileged`, `/dev`, dedicated podman storage root; arm64 builds run under qemu-user |
| `gh-actions` | **your own** GitHub repo (fork / template copy) + `gh auth login` | the bundle is pushed to `build/<id>` in *your* repo, the workflow runs the same `run.sh`, artifacts land in Actions / Releases |

### The GitHub Actions model

The build runs in a repository **you** own — nothing is ever pushed to the
project's repository:

1. **Use this template** (recommended: an independent repo whose Actions are on by
   default) or **Fork this project**. A bare repository works too — it just cannot
   host its own copy of this UI, because the Pages job builds the app from `web/`.
2. In the wizard → 构建后端 → GitHub Actions, enter `your-name/<repo>` and hit
   **准备仓库**. That commits one profile-independent workflow to the default
   branch and enables Actions (forks ship with Actions disabled — this is the
   usual reason a first build "does nothing").
3. Build. The local instance commits a `build/<profile-id>` branch to your repo;
   the workflow runs `./run.sh` on `ubuntu-latest`.

Every build branch is self-contained, so you can also reproduce a build by hand:

```bash
git clone --branch build/<id> https://github.com/you/<repo>.git image && cd image
./fetch-image.sh && ./run.sh
```

Your token needs the `repo` and `workflow` scopes (`gh auth refresh -s workflow`).

## What can be customized

* **Target** — board, suite, edition, sector size, image name, product override
* **Repos** — Radxa mirror, Debian/Ubuntu mirror, `-test` repo, snapshot
  timestamp, `pkgs.json` embedding, arbitrary extra apt sources with keys
* **Packages** — extra packages from any configured repo (with a 64k-entry
  searchable index), packages to purge, `--no-vendor-packages`,
  `-k` / `-f` kernel & firmware overrides, local `.deb` directories
* **System** — hostname, timezone, locale, keyboard, first user (password hash
  computed in the browser), SSH (keys, password auth, root login), Wi-Fi via
  NetworkManager, systemd units to enable
* **Files & scripts** — overlay files (text or base64 binary) with mode/owner,
  and arbitrary shell hooks run either on the build host or inside the target

## Repository layout

```
shared/     zod profile schema + all renderers (shared by server and browser)
server/     Fastify API: catalog, profiles, package index, preflight, jobs, backends
web/        Vite + React wizard, live build log, history
ops/        setup.sh, build-rsdk-image.sh, emit-static-assets.sh, check-boards.py
docs/       DESIGN.md
```

## Troubleshooting

**Server exits with `拒绝启动`** — you set `RSDK_WEBUI_HOST` to a non-loopback
address. The API has no authentication (profiles may contain a Wi-Fi PSK), so it
refuses to bind to the network unless you explicitly set
`RSDK_WEBUI_ALLOW_REMOTE=1`, accepting the risk.

**`podman` fails with `kernel does not support overlay fs`** — the graph root is
on btrfs. `ops/setup.sh` and the server both detect this and switch to an
isolated storage root at `~/.local/share/rsdk-webui/podman-root` with the btrfs
driver. Your own podman store is untouched.

**The build fails in the `essential-hook` with `Unable to locate package
linux-headers-<board>`** — that board is only published in the `-test` repo (or
not at all for that suite). The **确认构建** page runs this check up front in a
couple of seconds; flip **使用测试源** and retry.

**`rm: cannot remove '.../boot/efi': Device or resource busy`** — fallout from an
earlier failure, not the cause. Scroll up in the log for the real error.

**I want a newer rsdk than the released image has** — `./ops/build-rsdk-image.sh`
builds one from upstream source, then run with
`RSDK_WEBUI_IMAGE=rsdk-webui/rsdk:latest pnpm start`.

## Development

```bash
pnpm -r typecheck
pnpm test                     # renderer unit tests + container-backed integration tests
node ops/ui-shot.mjs http://127.0.0.1:8787 /tmp/ui.png \
  --wait "document.querySelectorAll('.board').length > 0" \
  --eval "document.querySelectorAll('.rail .step')[3].click()"
```

`ops/ui-shot.mjs` drives headless Chrome over CDP: it waits for real conditions
and can run JS before capturing, which is how the UI is verified without a human
at the keyboard.

## Two ways to run it

### A. On GitHub Pages — no backend at all

Fork this repository, enable **Actions** (forks ship with them off) and
**Pages** (Settings → Pages → Source: *GitHub Actions*; the workflow also tries
to turn it on for you). That gives you `https://<you>.github.io/rsdk-webui/`,
which is a *static* build of this UI:

* the board catalog, the rsdk jsonnet tree and the package index are exported at
  deploy time **from the same container image builds use**, so the site can never
  offer something the builder does not have;
* the build bundle is assembled **in your browser** and committed through the Git
  Data API, which triggers the workflow in *your* repository;
* status, steps, logs and artifacts come straight from api.github.com.

You paste a **fine-grained PAT** (Contents RW, Actions RW, Workflows RW) limited
to that one repository. It lives in `localStorage` - the UI says so loudly,
because anything that can run script on the page can read it.

### B. Locally — real containers on your machine

```bash
git clone https://github.com/xzl01/rsdk-webui && cd rsdk-webui
./ops/setup.sh && pnpm install && pnpm start   # http://127.0.0.1:8787
```

No token, no Actions minutes: the UI drives podman/docker directly. You can still
push a build to GitHub from here when you want to.

Both modes share the same `profile` and generate the same bundle; the detection
is a runtime probe of `/api/health`, not a build flag, so one bundle serves both.
