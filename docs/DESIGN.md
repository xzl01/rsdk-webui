# Design

## The problem

`rsdk build` is a good tool with a deliberately small surface: board, suite,
edition, mirrors, a handful of overrides. Everything else — extra packages,
config files, users, Wi-Fi — is *documented* as "edit `rootfs.jsonnet`", which is
fine for a maintainer working in a git checkout and terrible for anyone who just
wants "a Rock 5B image with Docker and my SSH key".

`rsdk-webui` is a thin, inspectable layer that turns those edits into data.

## What actually gets injected

`rsdk build` renders `rootfs.jsonnet` into a big jsonnet object and hands it to
`bdebstrap`, which forwards it to `mmdebstrap`. The object is assembled with the
jsonnet `+` operator, so appending one more term is enough to add anything:

```jsonnet
function(...) distro(...)
+ additional_repos(...)   // apt sources, `apt-get full-upgrade`, `autoremove --purge`
+ packages(...)           // the edition's package set
+ cleanup()               // cleanup hooks: resolv.conf, apt lists, machine-id
+ { mmdebstrap+: { "customize-hooks"+: [ "bash /rsdk-bundle/customize/install.sh \"$1\"" ] } }   // <- us
+ {                       // upstream's own trailing hooks
    mmdebstrap+: {
      "customize-hooks"+: [
        ...hostname in /etc/hosts, config.yaml, fingerprint,
        update-initramfs, u-boot-update, ESP remount, seed tarball
      ],
    },
  }
```

Two properties follow from that position, and both are the reason the insertion
point was chosen:

* **after** `additional_repos`' `apt-get full-upgrade` + `autoremove --purge` and
  after `cleanup()` → packages we install will not be auto-removed, and our apt
  sources are not wiped;
* **before** `update-initramfs` / `u-boot-update` → anything that touches kernel
  modules, firmware or bootloader content still ends up in the generated
  initramfs and boot image.

The anchor is the single occurrence of `+ cleanup()`. `ensureBuildTree()` asserts
that it appears exactly once; if upstream changes, the UI refuses to build with a
clear error instead of producing a silently unpatched image.

### How the patched tree gets into the build

`rsdk-build` reads `/usr/share/rsdk/build/rootfs.jsonnet` from the filesystem, not
from an argument. Instead of mutating anything, we:

1. export that directory (plus `configs/`) out of the container image once and
   cache it under `~/.local/share/rsdk-webui/rsdk-trees/<image-id>/`;
2. copy it into the build bundle and patch `rootfs.jsonnet` there;
3. bind-mount the patched copy over `/usr/share/rsdk/build:ro` when running the
   build container.

Nothing upstream is modified, and the exact jsonnet that produced an image is
part of the bundle.

### Why the hostname needs a second, different patch

`bdebstrap` turns the YAML `hostname:` field into

```python
cmd.append(f'--customize-hook=echo "{mmdebstrap["hostname"]}" > "$1/etc/hostname"')
```

and appends that hook **after** both `customize-hooks` and `cleanup-hooks`
(bdebstrap maps `cleanup-hooks` to plain `--customize-hook` arguments, and the
hostname hook comes last of all). No hook of ours can run after it, so writing
`/etc/hostname` from `install.sh` is silently reverted.

The only lever is the jsonnet value itself, which upstream hardcodes:

```jsonnet
hostname: product,          ->   hostname: "e25-lab",
```

`patchRootfsJsonnet()` therefore performs two anchored edits — the
`+ cleanup()` splice and, when a hostname is requested, this one-line
substitution. Both anchors are asserted to be unique; if either moves, the build
fails with a clear message instead of producing a subtly wrong image.

`/etc/hosts` still gets upstream's own `127.0.1.1 <product>` line appended
afterwards; `install.sh` writes `127.0.1.1 <hostname>` before that, and glibc
uses the first match, so name resolution is correct either way.

### Everything else lives in `customize/install.sh`

The jsonnet fragment contains exactly one hook, which calls a generated bash
script. That keeps the jsonnet diff trivial and the interesting logic readable:

```
customize/install.sh     apt sources, packages, files, users, ssh, wifi, hooks
customize/blobs/*        file contents installed into the rootfs
customize/apt/*.list     extra sources.list entries (+ keys)
customize/hooks/*.sh     user supplied scripts
```

Package installation uses mmdebstrap's own idiom rather than a raw `chroot`, so
it inherits the apt configuration bdebstrap already set up:

```bash
APT_CONFIG="$MMDEBSTRAP_APT_CONFIG" apt-get -oDPkg::Chroot-Directory="$ROOTFS" install -y …
```

with a `chroot` fallback when the variable is absent.

## The bundle is the API

Every backend consumes the same directory:

```
profile.json      the source of truth (re-importable by the UI)
run.sh            host driver: podman/docker run … bash /rsdk-bundle/inner.sh
inner.sh          container side: cd $HOME && rsdk build <args>
fetch-image.sh    downloads the official rsdk-image and loads it
host.env          engine + image defaults for this host
engine.args       engine global args (podman storage root, …)
rsdk-build/       patched copy of the image's jsonnet tree
customize/        the injection
work/             cwd; `work/out/<product>_<suite>_<edition>/` holds the result
```

`run.sh` reads its engine settings from the environment *first*
(`: "${RSDK_ENGINE:=podman}"`), so the same file works locally and on a GitHub
runner. The GitHub Actions workflow in the bundle is 40 lines because of this.

## Environment: why a container, and which one

`rsdk build` needs `bdebstrap`, `mmdebstrap`, `qemu-user-static`,
`libguestfs-tools`, `jsonnet`, `dosfstools`, `gdisk`, `parted`, `xz` … plus
`SYS_ADMIN` and `/dev`. Radxa already ships exactly this as a Debian package:

* `radxa-pkg/rsdk-image` builds a `debian:12-slim` image containing `rsdk` and
  `librtui` from source, and ships it as `/usr/share/rsdk-image/image.tar` inside
  a `.deb`;
* `ops/setup.sh` downloads that `.deb`, extracts `image.tar` and loads it.

So the local backend uses the *official* build environment, byte for byte, rather
than a hand-rolled one. Two consequences worth knowing:

* the image is pinned to whatever `rsdk` the release was cut with (0.1.0 at the
  time of writing, 40 boards; upstream HEAD has 43). Point
  `RSDK_WEBUI_IMAGE_VERSION` at a newer release when one appears, or build your
  own image from the `rsdk-image` Dockerfile and set `RSDK_WEBUI_IMAGE`.
* `rsdk build` always targets `arm64`, so on an x86_64 host the whole build runs
  under `qemu-user`. A CLI image takes tens of minutes; that is inherent, not a
  UI problem. It is also precisely why the preflight check exists.

### podman on btrfs

podman's default `overlay` driver cannot work when its graph root is on btrfs,
which is the default on many Arch installs. `detectEngine()` therefore probes:

1. the user's normal podman store → use it (no args);
2. a dedicated store under `~/.local/share/rsdk-webui/podman-root` with
   `--storage-driver btrfs` (or `zfs`, `overlay` depending on the filesystem);
3. `vfs` as a last resort;
4. then `docker`.

The dedicated store means rsdk-webui can never disturb the user's own images and
containers, at the cost of re-pulling/loading its own. All engine invocations are
serialised (`proc.ts: serialized`) because concurrent podman calls contend on the
store lock — which showed up in practice as "the image disappeared" when several
API requests arrived at once.

## Preflight

Upstream rsdk discovers a missing board package the slow way: it assembles the
whole base system, then fails in the `essential-hook` on
`apt-get install u-boot-<board> linux-headers-<board> …`. That is 6+ minutes and
several hundred MB of downloads spent to learn that
`linux-headers-rock-pi-s` was never published.

`POST /api/preflight` instead downloads the small `Packages.gz` indexes for the
candidate radxa repos (`<suite>`, `<soc>-<suite>`, each with and without the
`-test` suffix) and checks the four packages the essential hook will need. If
they are only present in the `-test` repo, the UI offers to flip that switch.

## Package index

For search, `POST /api/packages/index` pulls the arm64 `Packages.xz` of
main/contrib/non-free/non-free-firmware for the suite plus the radxa repos for
the board's SoC, and stores a compact JSON per `(suite, socs)` key. Radxa
packages win over Debian ones with the same name. Search is a scored substring
match over `name` and `description` — 64k entries, tens of milliseconds, no
external search engine needed.

## GitHub Actions backend

**The repository belongs to the user, not to the project.** The intended flow is
"fork this project (or *Use this template*), point the local web UI at your fork,
let it build there". Nothing outside a repository the user controls is ever
written to.

### What lives where

| | where | why |
|---|---|---|
| `.github/workflows/build.yml` | user's repo, **default branch** | one file, forever; profile independent |
| `build/<profile-id>` branch | user's repo, created per build | the complete, self-contained build description |
| `profile.json`, `run.sh`, `inner.sh`, `customize/`, `rsdk-build/` | that branch | what the workflow actually executes |
| artifacts | Actions artifact (+ optional Release) | |

The workflow reads `profile.json` with `jq` instead of being generated per
profile. That is what makes "fork once, build many images" work: the user's
default branch never needs to change again.

### Why a branch, not `repository_dispatch`

* the 64 KB dispatch payload limit never applies, so overlay blobs can be large;
* the branch *is* the build description — `git clone -b build/<id>` + `./run.sh`
  reproduces the image, which is the property the whole project is built around;
* the run is attributable to a commit and re-running it is one click;
* the same workflow file works for every profile and both `push` and manual
  `workflow_dispatch`.

### Forks start with Actions disabled

A fork does not inherit workflow runs: GitHub disables Actions in a forked
repository until the owner enables it. `POST /api/gh/repo/setup` therefore

1. creates the repository if the user asked for that (`gh repo create`),
2. commits `build.yml` + a README to the default branch,
3. calls `PUT /repos/{owner}/{repo}/actions/permissions` to turn Actions on,

and reports `needsManualActionEnable` when the token lacks admin rights, with the
URL to click. The review step refuses to start a build against a repository whose
Actions are still off, instead of pushing a branch that will never run.

The `rsdk-image` `.deb` (~480 MB) is cached on the runner with `actions/cache`;
the 2.2 GB `image.tar` is *not* cached (it would dominate the 10 GB cache
budget) and is re-extracted and re-loaded on each run.

## Why there is no "Login with GitHub"

The Pages build is a static site, so every GitHub call goes from the browser to
`api.github.com`. OAuth (and the device flow) would be the pleasant way to get a
token - except it cannot work here, and it is worth writing down why so nobody
re-implements it:

* the OAuth endpoints live on **github.com** (`/login/oauth/access_token`,
  `/login/device/code`), not on `api.github.com`;
* `api.github.com` sends `access-control-allow-origin: *`;
  **`github.com` sends no CORS headers at all**, so the browser refuses the
  response before any of our code runs. Verified with:

```
$ curl -sS -D - -o /dev/null https://api.github.com/zen -H 'Origin: https://xzl01.github.io'
access-control-allow-origin: *
$ curl -sS -D - -o /dev/null https://github.com/login/device/code -H 'Origin: ...'
HTTP/2 404        # no access-control-* headers
```

So obtaining a token needs a server-side hop, and this project deliberately has
none in that path. What is offered instead:

* a **pre-filled fine-grained token page** (name, owner, expiry and the four
  permissions are query parameters), so it is two clicks and the privilege is
  scoped to the one repository;
* the **local mode needs no token at all** - the Fastify server uses the machine's
  existing `gh` session, which is where a real OAuth device flow could live if
  someone registers an OAuth app.

Everything else (commits, runs, logs, artifacts) does go straight from the
browser to `api.github.com`, which is exactly what CORS allows.

## Operational invariants

A few properties are load-bearing, easy to break by accident, and each of them
was a bug first. They are worth keeping in mind when touching the surrounding
code:

* **The rootfs cache key carries a generator version.** `rsdk build` reuses an
  existing `rootfs.tar` wholesale, so a cache hit means the customize hook never
  runs again. `GENERATOR_VERSION` in `shared/src/render.ts` must be bumped
  whenever the *shape* of what `customize/install.sh` does changes, or builds keep
  producing images made by the previous version.
* **Job pruning must never touch a running job.** It deletes bundle directories,
  and a live build is writing into one.
* **Bundles are per submission, the working directory is per profile.** The
  bundle holds the job record and the exit-code file; `rootfs.tar` lives in the
  shared working directory because that is the expensive part that should
  survive.
* **Long-running polling must survive a hiccup.** A single failed `gh api` call
  used to end the watcher and leave a job "running" forever.
* **The container runs as the image's `rsdk` user (uid 1000)**, because
  `rsdk build` needs its passwordless sudo for bdebstrap. Anything on the host
  side that must read or write the working directory has to arrange for that
  (see `hand_over`/`take_back` in `run.sh`).
* **Nothing cross-origin may reach the HTTP API.** It is served same-origin, so
  the allowlist exists purely to refuse everyone else; browsers send `Origin` on
  same-origin non-GET requests too, which is why the server's own origin has to
  be allowed explicitly.
* **Generated values that reach a shell are validated, not escaped only.**
  `mode`, `owner`, `locale`, `hostname` and package names go through the zod
  schema in `shared/`, so the browser and the server reject the same input with
  the same message.

## Deliberate non-goals

* **No reimplementation of rsdk.** The UI never assembles a rootfs itself.
* **No silent fallbacks.** If the jsonnet anchor is missing, the engine is
  unavailable or a required package is absent, the build stops with an
  explanation.
* **No secrets management.** A password hash or Wi-Fi PSK ends up in the bundle
  by design; the UI warns and the user decides.
