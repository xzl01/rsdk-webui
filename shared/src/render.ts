/**
 * Pure renderers: Profile -> the files that make up a build bundle.
 *
 * Deliberately dependency-free (no node APIs) so the browser can preview the
 * exact same output the server is going to write.
 */
import {
  BUNDLE_MOUNT,
  type Hook,
  type OverlayFile,
  type Profile,
} from './schema.ts'

export type BundleFile = {
  /** path relative to the bundle root */
  path: string
  /** utf-8 text, or raw bytes for binary overlays */
  content: string | Uint8Array
  mode: number
}

/** POSIX single-quote a string for safe interpolation into shell. */
export function shq(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'item'
  )
}

/** decode base64 without depending on the Buffer global (works in the browser) */
export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * NetworkManager keyfile（GKeyFile 语法）的值：双引号包裹并转义。
 * 裸写 ssid/psk 时，`#`、`;`、引号或换行都会让 NM 解析出错 —— Wi-Fi 静默失效。
 */
export function nmKeyfileValue(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '')
    .replaceAll('\t', '\\t')}"`
}

// ---------------------------------------------------------------------------
// rsdk CLI arguments
// ---------------------------------------------------------------------------

export function renderRsdkArgs(p: Profile): string[] {
  const args: string[] = ['build']
  const { repos, packages, target } = p

  if (repos.testRepo) args.push('--test-repo')
  if (repos.radxaMirror) args.push('-M', repos.radxaMirror)
  else if (!repos.usePkgsJson) args.push('--no-pkgs-json')
  if (repos.distroMirror) args.push('-m', repos.distroMirror)
  if (repos.snapshot) args.push('--snapshot', repos.snapshot)
  if (!packages.vendor) args.push('--no-vendor-packages')
  if (packages.kernelOverride) args.push('--override-kernel', packages.kernelOverride)
  if (packages.firmwareOverride) args.push('--override-firmware', packages.firmwareOverride)
  if (target.productOverride) args.push('--override-product', target.productOverride)
  if (packages.noCache) args.push('--no-cache')
  args.push('--sector-size', String(target.sectorSize))
  args.push('--image-name', target.imageName || 'output.img')
  args.push(target.product, target.suite, target.edition)
  return args
}

export function renderRsdkCommand(p: Profile): string {
  return ['rsdk', ...renderRsdkArgs(p)].map(shq).join(' ')
}

/**
 * Stable hash of everything that ends up inside the rootfs.
 *
 * `rsdk build` happily reuses `out/<...>/rootfs.tar` when it exists, which is a
 * huge time saver - and a silent correctness bug the moment you change a
 * package list or a mirror. The bundle records the key it was built with and
 * asks rsdk for `--no-cache` as soon as the key changes.
 */
/**
 * Bump this whenever the *shape* of what `customize/install.sh` does changes.
 *
 * `rsdk build` reuses an existing rootfs.tar wholesale, so a cache hit means the
 * old hook never runs again. Without this the generated script could change and
 * builds would keep producing images built by the previous version.
 *
 * v3: NM keyfile 值转义 + step/echo 行统一 shq（第五轮评审）
 */
export const GENERATOR_VERSION = 3

export function rootfsCacheKey(p: Profile): string {
  const relevant = {
    target: {
      product: p.target.product,
      suite: p.target.suite,
      edition: p.target.edition,
      productOverride: p.target.productOverride,
    },
    repos: p.repos,
    packages: { ...p.packages, noCache: false },
    system: p.system,
    files: p.files,
    hooks: p.hooks,
    generator: GENERATOR_VERSION,
  }
  return djb2(JSON.stringify(relevant))
}

function djb2(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// jsonnet injection
// ---------------------------------------------------------------------------

/** Stable anchor inside the upstream rootfs.jsonnet we append our module to. */
export const ROOTFS_ANCHOR = '+ cleanup()'

/**
 * Upstream hardcodes the hostname as `hostname: <product>`, and bdebstrap turns
 * that into the *last* `--customize-hook` it passes to mmdebstrap
 * (`--customize-hook=echo "<hostname>" > "$1/etc/hostname"`, appended after even
 * the cleanup-hooks). No hook of ours can run later, so the only way to change
 * the hostname is to change this value.
 */
export const HOSTNAME_ANCHOR = 'hostname: product,'

/**
 * The jsonnet object appended to upstream `rootfs.jsonnet`.
 *
 * It lands *after* `+ cleanup()` and therefore *before* the trailing
 * `customize-hooks` of the upstream file (hostname/config.yaml/fingerprint,
 * `update-initramfs`, `u-boot-update`).  That ordering is what we want: our
 * packages and files are in place before initramfs and the bootloader are
 * regenerated, and after `apt-get full-upgrade` / `autoremove --purge` have
 * already run in `additional_repos.libjsonnet`.
 */
export function renderJsonnetFragment(profile: Profile): string {
  const hook = `bash ${BUNDLE_MOUNT}/customize/install.sh "$1"`
  return [
    '{',
    '    mmdebstrap+: {',
    '        "customize-hooks"+: [',
    `            ${JSON.stringify(hook)},`,
    '        ],',
    '    },',
    '}',
    // keep the profile id discoverable from the generated tree
    `// rsdk-webui profile: ${profile.id} (${profile.meta.name})`,
    '',
  ].join('\n')
}

/**
 * Insert the fragment into a stock `rootfs.jsonnet`.
 * Throws when the upstream file no longer looks like what we expect.
 */
export function patchRootfsJsonnet(stock: string, profile: Profile): string {
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
  if (count(stock, ROOTFS_ANCHOR) !== 1) {
    throw new Error(
      `cannot patch rootfs.jsonnet: expected exactly one ${JSON.stringify(ROOTFS_ANCHOR)}, found ${count(stock, ROOTFS_ANCHOR)}. ` +
        'The upstream rsdk layout changed; update ROOTFS_ANCHOR in shared/src/render.ts.',
    )
  }

  let patched = stock.replace(ROOTFS_ANCHOR, `${ROOTFS_ANCHOR}\n+ ${renderJsonnetFragment(profile)}`)

  const hostname = profile.system.hostname.trim()
  if (hostname) {
    if (count(patched, HOSTNAME_ANCHOR) !== 1) {
      throw new Error(
        `cannot set hostname: expected exactly one ${JSON.stringify(HOSTNAME_ANCHOR)} in rootfs.jsonnet. ` +
          'The upstream rsdk layout changed; update HOSTNAME_ANCHOR in shared/src/render.ts.',
      )
    }
    patched = patched.replace(HOSTNAME_ANCHOR, `hostname: ${JSON.stringify(hostname)},`)
  }

  return patched
}

// ---------------------------------------------------------------------------
// blobs referenced by the install script
// ---------------------------------------------------------------------------

const blob = (id: string, content: string | Uint8Array): BundleFile => ({
  path: `customize/blobs/${id}`,
  content,
  mode: 0o644,
})

function renderSshdConfig(p: Profile): string {
  return [
    '## generated by rsdk-webui',
    `PasswordAuthentication ${p.system.ssh.passwordAuth ? 'yes' : 'no'}`,
    `PermitRootLogin ${p.system.ssh.permitRootLogin}`,
    '',
  ].join('\n')
}

function renderNmConnection(p: Profile): string {
  const w = p.system.wifi!
  const lines = [
    '## generated by rsdk-webui',
    '[connection]',
    `id=${nmKeyfileValue(w.ssid)}`,
    'type=wifi',
    `autoconnect=${w.autoconnect ? 'true' : 'false'}`,
    '',
    '[wifi]',
    'mode=infrastructure',
    `ssid=${nmKeyfileValue(w.ssid)}`,
    ...(w.hidden ? ['hidden=true'] : []),
    '',
  ]
  if (w.psk) {
    lines.push('[wifi-security]', 'key-mgmt=wpa-psk', `psk=${nmKeyfileValue(w.psk)}`, '')
  }
  lines.push('[ipv4]', 'method=auto', '', '[ipv6]', 'method=auto', 'may-fail=true', '')
  return lines.join('\n')
}

function renderKeyboard(p: Profile): string {
  const kb = p.system.keyboard
  return [
    '## generated by rsdk-webui',
    `XKBMODEL="${kb.model}"`,
    `XKBLAYOUT="${kb.layout}"`,
    `XKBVARIANT="${kb.variant}"`,
    `XKBOPTIONS="${kb.options}"`,
    '',
  ].join('\n')
}

export type BundleContext = {
  /** resolver for user-uploaded binary blobs: returns the bundle-relative path */
  resolveBlob?: (file: OverlayFile) => { path: string; mode: number } | undefined
}

// ---------------------------------------------------------------------------
// the customize hook itself
// ---------------------------------------------------------------------------

export function renderInstallScript(p: Profile, ctx: BundleContext = {}): {
  script: string
  blobs: BundleFile[]
} {
  const blobs: BundleFile[] = []
  const rootfsFiles: string[] = []
  const aptCommands: string[] = []
  const steps: string[] = []
  const s = p.system

  // ---- apt sources -------------------------------------------------------
  const extraRepos = p.repos.extra.filter((r) => r.enabled)
  if (extraRepos.length > 0) {
    const lines: string[] = ['step "添加额外 APT 源"']
    for (const repo of extraRepos) {
      const id = slug(repo.name || repo.id)
      lines.push(
        `install -D -m 0644 "$BUNDLE/customize/apt/${id}.list" "$ROOTFS/etc/apt/sources.list.d/90-rsdk-webui-${id}.list"`,
      )
      if (repo.keyUrl) {
        lines.push(
          'install -d -m 0755 "$ROOTFS/etc/apt/keyrings"',
          `curl -fsSL -o "$ROOTFS/etc/apt/keyrings/rsdk-webui-${id}.asc" ${shq(repo.keyUrl)}`,
          `chmod 0644 "$ROOTFS/etc/apt/keyrings/rsdk-webui-${id}.asc"`,
        )
      } else if (repo.keyArmored.trim()) {
        lines.push(
          `install -D -m 0644 "$BUNDLE/customize/apt/${id}.key" "$ROOTFS/etc/apt/keyrings/rsdk-webui-${id}.asc"`,
        )
      }
    }
    steps.push(lines.join('\n'))
  }

  // ---- apt update / install / purge -------------------------------------
  if (extraRepos.length > 0 || p.packages.install.length > 0 || p.packages.purge.length > 0) {
    aptCommands.push('step "apt-get update"', 'apt_root update')
  }
  if (p.packages.install.length > 0) {
    const flag = p.packages.installRecommends ? '' : '--no-install-recommends '
    // sorted so that the same profile always yields byte-identical output
    const packages = [...p.packages.install].sort()
    aptCommands.push(
      `step "安装 ${packages.length} 个附加软件包"`,
      `apt_root install -y ${flag}${packages.map(shq).join(' ')}`,
    )
  }
  if (p.packages.purge.length > 0) {
    const packages = [...p.packages.purge].sort()
    aptCommands.push(
      `step "移除 ${packages.length} 个软件包"`,
      `apt_root purge -y --auto-remove ${packages.map(shq).join(' ')}`,
    )
  }
  if (aptCommands.length > 0) {
    aptCommands.push('apt_root clean')
    steps.push(aptCommands.join('\n'))
  }

  // ---- overlay files -----------------------------------------------------
  const overlays = p.files.filter((f) => f.enabled)
  if (overlays.length > 0) {
    const lines: string[] = [`step "写入 ${overlays.length} 个覆盖文件"`]
    overlays.forEach((file, index) => {
      const resolved = ctx.resolveBlob?.(file)
      let source: string
      if (resolved) {
        source = `$BUNDLE/${resolved.path}`
      } else {
        const id = `overlay-${String(index).padStart(2, '0')}-${slug(file.path.split('/').pop() ?? 'file')}`
        blobs.push(blob(id, file.encoding === 'base64' ? base64ToBytes(file.content) : file.content))
        source = `$BUNDLE/customize/blobs/${id}`
      }
      lines.push(`install -D -m ${file.mode} "${source}" "$ROOTFS${file.path}"`)
      // resolve the owner inside the *target* rootfs, not in the build
      // container, where e.g. www-data may not exist
      if (file.owner && file.owner !== 'root:root' && file.owner !== '0:0') {
        lines.push(`in_root chown ${shq(file.owner)} ${shq(file.path)}`)
      }
    })
    steps.push(lines.join('\n'))
  }

  // ---- hostname ----------------------------------------------------------
  // /etc/hostname itself is written by bdebstrap's own last customize hook, so
  // patchRootfsJsonnet() changes the value it writes. Here we only keep
  // /etc/hosts in sync; upstream appends its own "127.0.1.1 <product>" line
  // afterwards (glibc uses the first match, so ours wins).
  if (s.hostname) {
    steps.push(
      [
        `step "设置主机名: ${s.hostname} (通过 jsonnet hostname 字段)"`,
        'sed -i -e "/^127\\.0\\.1\\.1[[:space:]]/d" "$ROOTFS/etc/hosts"',
        `printf '127.0.1.1\\t%s\\n' ${shq(s.hostname)} >> "$ROOTFS/etc/hosts"`,
      ].join('\n'),
    )
  }

  // ---- timezone / locale / keyboard -------------------------------------
  const region: string[] = []
  if (s.timezone) {
    region.push(
      `step "设置时区: ${s.timezone}"`,
      `ln -sf ${shq(`/usr/share/zoneinfo/${s.timezone}`)} "$ROOTFS/etc/localtime"`,
      `printf '%s\\n' ${shq(s.timezone)} > "$ROOTFS/etc/timezone"`,
    )
  }
  if (s.locale) {
    const loc = s.locale.split('.')[0]
    region.push(
      `step "设置区域: ${s.locale}"`,
      'install -d -m 0755 "$ROOTFS/etc/default"',
      `sed -i -E "s|^#[[:space:]]*(${loc}\\.UTF-8[[:space:]]+UTF-8)|\\1|" "$ROOTFS/etc/locale.gen"`,
      `grep -qE "^${loc}\\.UTF-8" "$ROOTFS/etc/locale.gen" || printf '%s\\n' ${shq(`${loc}.UTF-8 UTF-8`)} >> "$ROOTFS/etc/locale.gen"`,
      `printf 'LANG=%s\\n' ${shq(s.locale)} > "$ROOTFS/etc/default/locale"`,
      'in_root locale-gen',
    )
  }
  if (s.keyboard.layout) {
    region.push('install -D -m 0644 "$BUNDLE/customize/blobs/keyboard" "$ROOTFS/etc/default/keyboard"')
  }
  if (region.length > 0) steps.push(region.join('\n'))

  // ---- user --------------------------------------------------------------
  if (s.user) {
    const u = s.user
    const lines: string[] = [`step ${shq(`创建用户: ${u.name}`)}`]
    lines.push(
      `if in_root id -u ${shq(u.name)} >/dev/null 2>&1; then`,
      `  in_root usermod -s ${shq(u.shell)} ${shq(u.name)}`,
      'else',
      `  in_root useradd -m -s ${shq(u.shell)} -U ${shq(u.name)}`,
      'fi',
    )
    if (u.sudo) lines.push(`in_root usermod -aG sudo ${shq(u.name)}`)
    if (u.passwordHash) {
      lines.push(
        `printf '%s:%s\\n' ${shq(u.name)} ${shq(u.passwordHash)} | in_root chpasswd -e`,
      )
    } else {
      lines.push(`in_root passwd -d ${shq(u.name)} || true`)
    }
    if (u.sudo && u.nopasswd) {
      const id = `sudoers-${slug(u.name)}`
      blobs.push(blob(id, `${u.name} ALL=(ALL:ALL) NOPASSWD:ALL\n`))
      lines.push(
        `install -D -m 0440 "$BUNDLE/customize/blobs/${id}" "$ROOTFS/etc/sudoers.d/90-rsdk-webui-${slug(u.name)}"`,
      )
    }
    if (u.sshKeys.length > 0) {
      const id = `authorized_keys-${slug(u.name)}`
      blobs.push(blob(id, u.sshKeys.map((k) => k.trim()).filter(Boolean).join('\n') + '\n'))
      lines.push(
        `install -d -m 0700 "$ROOTFS/home/${u.name}/.ssh"`,
        `install -D -m 0600 "$BUNDLE/customize/blobs/${id}" "$ROOTFS/home/${u.name}/.ssh/authorized_keys"`,
        `in_root chown -R ${shq(u.name)}:${shq(u.name)} /home/${u.name}/.ssh`,
      )
    }
    steps.push(lines.join('\n'))
  }

  // ---- ssh ---------------------------------------------------------------
  if (s.ssh.enabled) {
    const lines: string[] = ['step "配置 SSH"']
    blobs.push(blob('sshd_config.d.conf', renderSshdConfig(p)))
    lines.push(
      'install -D -m 0644 "$BUNDLE/customize/blobs/sshd_config.d.conf" "$ROOTFS/etc/ssh/sshd_config.d/90-rsdk-webui.conf"',
    )
    if (s.ssh.rootAuthorizedKeys.length > 0) {
      blobs.push(blob('authorized_keys-root', s.ssh.rootAuthorizedKeys.map((k) => k.trim()).filter(Boolean).join('\n') + '\n'))
      lines.push(
        'install -d -m 0700 "$ROOTFS/root/.ssh"',
        'install -D -m 0600 "$BUNDLE/customize/blobs/authorized_keys-root" "$ROOTFS/root/.ssh/authorized_keys"',
      )
    }
    lines.push(
      'if [[ -e "$ROOTFS/usr/sbin/sshd" ]]; then enable_unit ssh.service || true; else echo "warn: sshd not installed" >&2; fi',
    )
    steps.push(lines.join('\n'))
  }

  // ---- wifi --------------------------------------------------------------
  if (s.wifi) {
    const nm = `nm-${slug(s.wifi.ssid)}.nmconnection`
    blobs.push(blob(nm, renderNmConnection(p)))
    const lines: string[] = [
      `step ${shq(`配置 WiFi: ${s.wifi.ssid}`)}`,
      `install -D -m 0600 "$BUNDLE/customize/blobs/${nm}" "$ROOTFS/etc/NetworkManager/system-connections/${nm}"`,
      'enable_unit NetworkManager.service || true',
    ]
    if (s.wifi.country) {
      lines.push(
        'install -d -m 0755 "$ROOTFS/etc/default"',
        `printf 'REGDOMAIN=%s\\n' ${shq(s.wifi.country)} > "$ROOTFS/etc/default/crda"`,
      )
    }
    steps.push(lines.join('\n'))
  }

  // ---- extra services ----------------------------------------------------
  if (s.enableServices.length > 0) {
    const lines = ['step "启用 systemd 服务"']
    for (const unit of s.enableServices) lines.push(`enable_unit ${shq(unit)} || true`)
    steps.push(lines.join('\n'))
  }

  // ---- kernel / bootloader provenance ------------------------------------
  // Bringing your own kernel is only meaningful if you can tell afterwards that
  // it actually made it into the image, and which version won.
  if (p.packages.recordProvenance) {
    steps.push(
      `step "记录内核与引导版本"
mkdir -p "$ROOTFS/etc/rsdk"
{
  echo "# installed kernel / bootloader packages, recorded by rsdk-webui"
  in_root dpkg-query -W 'linux-image-*' 'linux-headers-*' 'u-boot-*' 'edk2-*' 2>/dev/null || true
} > "$ROOTFS/etc/rsdk/webui-packages.txt"
tail -n +2 "$ROOTFS/etc/rsdk/webui-packages.txt" | sed 's/^/          /'`,
    )
  }

  // ---- user hooks --------------------------------------------------------
  const hooks = p.hooks.pre.filter((h) => h.enabled && h.script.trim())
  hooks.forEach((h, i) => {
    steps.push(renderHookStep(h, i))
  })

  // ---- assemble ----------------------------------------------------------
  if (s.keyboard.layout) blobs.push(blob('keyboard', renderKeyboard(p)))

  const header = `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rsdk-webui customize hook for profile "${p.meta.name}" (${p.id})
#
# Executed by bdebstrap as a \`customize-hook\` *inside the build container*,
# with \$1 = path to the freshly built rootfs.
#
# It is inserted into the upstream rootfs.jsonnet right after \`+ cleanup()\`,
# so it runs before upstream's own trailing hooks (fingerprint, update-initramfs,
# u-boot-update).
#
# Generated file - edit the profile in the web UI, not this file.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOTFS="\${1:?usage: install.sh <rootfs-path>}"
BUNDLE="\${RSDK_BUNDLE:-${BUNDLE_MOUNT}}"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_SUSPEND=1

step() { printf '\\n\\033[1;36m=== [rsdk-webui] %s\\033[0m\\n' "$*"; }

# apt operating on the target rootfs, using mmdebstrap's apt config when present
apt_root() {
  if [[ -n "\${MMDEBSTRAP_APT_CONFIG:-}" ]]; then
    APT_CONFIG="\$MMDEBSTRAP_APT_CONFIG" apt-get -oDPkg::Chroot-Directory="\$ROOTFS" "\$@"
  else
    chroot "\$ROOTFS" env DEBIAN_FRONTEND=noninteractive apt-get "\$@"
  fi
}

in_root() { chroot "\$ROOTFS" "\$@"; }

# enable a systemd unit offline, without needing a running systemd
enable_unit() {
  local unit="\${1:-}" target="" dir
  for dir in usr/lib/systemd/system lib/systemd/system; do
    if [[ -e "\$ROOTFS/\$dir/\$unit" ]]; then
      target="/\$dir/\$unit"
      break
    fi
  done
  if [[ -z "\$target" ]]; then
    printf 'warn: systemd unit %s not found in rootfs\\n' "\$unit" >&2
    return 1
  fi
  install -d -m 0755 "\$ROOTFS/etc/systemd/system/multi-user.target.wants"
  ln -sf "\$target" "\$ROOTFS/etc/systemd/system/multi-user.target.wants/\$unit"
}
`

  const body = steps.length > 0 ? '\n' + steps.join('\n\n') + '\n' : '\nstep "no customization requested"\n'
  const footer = '\nstep "customization finished"\n'

  return { script: header + body + footer, blobs }
}

function renderHookStep(h: Hook, index: number): string {
  const name = `customize/hooks/${String(index + 1).padStart(2, '0')}-${slug(h.name)}.sh`
  if (h.inRootfs) {
    return [
      `step ${shq(`自定义脚本 (rootfs 内): ${h.name}`)}`,
      `install -D -m 0755 "$BUNDLE/${name}" "$ROOTFS/tmp/rsdk-webui-hook-${index + 1}.sh"`,
      `in_root bash /tmp/rsdk-webui-hook-${index + 1}.sh`,
      `rm -f "$ROOTFS/tmp/rsdk-webui-hook-${index + 1}.sh"`,
    ].join('\n')
  }
  return [
    `step ${shq(`自定义脚本 (构建主机): ${h.name}`)}`,
    `ROOTFS="$ROOTFS" BUNDLE="$BUNDLE" bash "$BUNDLE/${name}"`,
  ].join('\n')
}

export function renderHookFiles(p: Profile): BundleFile[] {
  return p.hooks.pre
    .filter((h) => h.enabled && h.script.trim())
    .map((h, index) => ({
      path: `customize/hooks/${String(index + 1).padStart(2, '0')}-${slug(h.name)}.sh`,
      content: h.script.endsWith('\n') ? h.script : h.script + '\n',
      mode: 0o755,
    }))
}

export function renderAptRepoFiles(p: Profile): BundleFile[] {
  const files: BundleFile[] = []
  for (const repo of p.repos.extra.filter((r) => r.enabled)) {
    const id = slug(repo.name || repo.id)
    const signedBy = repo.keyUrl || repo.keyArmored.trim()
      ? ` [signed-by="/etc/apt/keyrings/rsdk-webui-${id}.asc"]`
      : repo.trusted
        ? ' [trusted=yes]'
        : ''
    files.push({
      path: `customize/apt/${id}.list`,
      content: `## generated by rsdk-webui\ndeb${signedBy} ${repo.url.replace(/\/+$/, '')} ${repo.suite} ${repo.components.join(' ')}\n`,
      mode: 0o644,
    })
    if (repo.keyArmored.trim()) {
      files.push({
        path: `customize/apt/${id}.key`,
        content: repo.keyArmored.endsWith('\n') ? repo.keyArmored : repo.keyArmored + '\n',
        mode: 0o644,
      })
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// container-side script
// ---------------------------------------------------------------------------

export function renderInnerScript(p: Profile): string {
  const args = renderRsdkArgs(p)
  const cacheKey = rootfsCacheKey(p)
  // always emit a syntactically valid list, even when there is nothing to fetch
  const urlList = p.packages.debsUrls.length > 0 ? p.packages.debsUrls.map(shq).join(' ') : "''"
  // '' when the profile has no local packages, so the whole block is inert
  const debsNeeded = p.packages.localDebsDir || p.packages.debsUrls.length > 0 ? '1' : ''
  return `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Runs *inside* the rsdk build container. Everything outside of it (podman/docker
# orchestration, GitHub Actions) only has to invoke this file.
# ---------------------------------------------------------------------------
set -euo pipefail

# rsdk's jsonnet shells out to tools that live in /usr/sbin (sgdisk, resize2fs,
# ...). A login shell would drop that directory for non-root users, so make the
# search path explicit instead of depending on how this script was invoked.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\${PATH:+:\$PATH}"

cd "\${HOME:-/home/rsdk}"

echo "== rsdk-webui build =="
echo ${shq(`profile : ${p.meta.name} (${p.id})`)}
echo ${shq(`target  : ${p.target.product} ${p.target.suite} ${p.target.edition} sector=${p.target.sectorSize}`)}
echo "rsdk    : \$(dpkg-query -W -f='\${Version}' rsdk 2>/dev/null || echo unknown)"
echo "arch    : \$(uname -m)"
echo "user    : \$(id -un) uid=\$(id -u) gid=\$(id -g) home=\${HOME:-?}"
if [[ ! -w "\${HOME:-/home/rsdk}" ]]; then
  echo "!! \${HOME:-/home/rsdk} 不可写：宿主 uid 与容器 uid 不一致，见 run.sh 的 hand_over/take_back" >&2
fi

# arm64 runs through qemu-user + binfmt_misc. binfmt_misc is a kernel feature,
# so on a host that has no handler registered (a fresh GitHub runner) the
# container has to register one. We run --privileged precisely for this, and
# binfmt-support's update-binfmts mounts binfmt_misc for us if needed.
setup_binfmt() {
  local entry=/proc/sys/fs/binfmt_misc/qemu-aarch64
  if grep -q '^enabled' "\$entry" 2>/dev/null; then
    echo "binfmt  : qemu-aarch64 已注册"
    return 0
  fi
  echo "==> 注册 qemu-aarch64 binfmt handler"
  if sudo update-binfmts --enable qemu-aarch64 >/dev/null 2>&1 && grep -q '^enabled' "\$entry" 2>/dev/null; then
    echo "binfmt  : 已启用"
  else
    echo "!! 无法注册 qemu-aarch64：arm64 构建会失败（需要 --privileged 与镜像里的 qemu-user-static）" >&2
  fi
}
setup_binfmt

echo

ARGS=(${args.map(shq).join(' ')})

# Reuse the previous build's rootfs.tar only when nothing that lands in the
# rootfs changed. This file lives in the working directory, which the caller
# shares between submissions of the same profile - so the cache actually
# survives, and still invalidates the moment the profile changes.
KEY_FILE="\${HOME:-/home/rsdk}/.rsdk-webui-rootfs-key"
WANT_KEY=${shq(cacheKey)}
if [[ "\${RSDK_FORCE_REBUILD:-0}" == "1" ]]; then
  echo "rootfs cache : disabled by RSDK_FORCE_REBUILD"
elif [[ -f "\$KEY_FILE" && "\$(cat "\$KEY_FILE")" == "\$WANT_KEY" ]]; then
  echo "rootfs cache : reuse (key \$WANT_KEY)"
else
  echo "rootfs cache : stale inputs (want \$WANT_KEY, have \$(cat "\$KEY_FILE" 2>/dev/null || echo none)) -> --no-cache"
  ARGS+=(--no-cache)
fi

# Self-built kernels / bootloaders arrive as ordinary .deb files. 'rsdk build
# --debs' publishes them as a local apt repository with pin 1999, so any package
# name they provide wins over the repository version - that is the whole
# override mechanism. They come from two places: whatever travelled inside the
# bundle (a local-docker build copies them in) and any URLs listed in the
# profile (the only way a GitHub Actions build can get them).
collect_debs() {
  local target="$1"
  local found=0
  rm -rf "$target"
  mkdir -p "$target"
  if compgen -G ${shq(`${BUNDLE_MOUNT}/debs/*.deb`)} >/dev/null 2>&1; then
    cp ${shq(`${BUNDLE_MOUNT}/debs/*.deb`)} "$target/"
  fi
  local url
  for url in ${urlList}; do
    [[ -n "$url" ]] || continue
    echo "==> 下载 \$(basename "$url")"
    if ! curl -fL --retry 3 -o "$target/\$(basename "$url")" "$url"; then
      echo "!! 下载失败: $url" >&2
      exit 1
    fi
  done
}

# fetched (or copied) only when the profile asks for local packages at all
if [[ -n '${debsNeeded}' ]]; then
  collect_debs "\${HOME:-/home/rsdk}/debs"
fi

# The packages were copied/fetched into \${HOME:-/home/rsdk}/debs above. Point
# rsdk at it only when there is something there: it errors out on a missing
# directory, and a bundle built in the browser cannot carry any.
if compgen -G "\${HOME:-/home/rsdk}/debs/*.deb" >/dev/null 2>&1; then
  ARGS+=(--debs "\${HOME:-/home/rsdk}/debs")
  echo "debs    : \$(ls -1 "\${HOME:-/home/rsdk}/debs"/*.deb | wc -l) 个自带包（本地源 pin 1999，会覆盖仓库版本）"
  for pkg in "\${HOME:-/home/rsdk}/debs"/*.deb; do
    printf '          %s\n' "\$(basename "$pkg")"
  done
fi

echo "+ rsdk \${ARGS[*]}"
rsdk "\${ARGS[@]}"

# the rootfs.tar is now known-good for these inputs
printf '%s\\n' "\$WANT_KEY" > "\$KEY_FILE"
`
}

export function renderRunScript(): string {
  return `#!/usr/bin/env bash
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
#   RSDK_RUN_EXTRA           extra \`run\` args, e.g. "--userns=keep-id"
#   RSDK_IMAGE               container image (default: rsdk-image:latest)
#   RSDK_NO_TTY              set to 1 to omit -t
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$HERE/host.env" ]] && source "$HERE/host.env"

ENGINE="\${RSDK_ENGINE:-docker}"
IMAGE="\${RSDK_IMAGE:-rsdk-image:latest}"

# engine global args: the environment wins over the file, never both (they
# would be applied twice)
ARGS=()
if [[ -n "\${RSDK_ENGINE_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  ARGS=(\$RSDK_ENGINE_ARGS)
elif [[ -n "\${RSDK_ENGINE_ARGS_FILE:-}" && -f "$HERE/\$RSDK_ENGINE_ARGS_FILE" ]]; then
  mapfile -t ARGS < "$HERE/\$RSDK_ENGINE_ARGS_FILE"
fi

RUN_EXTRA=()
if [[ -n "\${RSDK_RUN_EXTRA:-}" ]]; then
  # shellcheck disable=SC2206
  RUN_EXTRA=(\$RSDK_RUN_EXTRA)
fi

TTY=()
if [[ "\${RSDK_NO_TTY:-0}" != "1" ]]; then TTY=(-t); fi

# The build must run as the image's rsdk user (uid 1000): rsdk build needs its
# passwordless sudo to run bdebstrap, and sudo is matched by user, not by uid.
# So when the host user is somebody else - GitHub runners are not always 1000 -
# we borrow the host sudo once before and once after the build to hand the
# working directory back and forth.
CONTAINER_UID=1000
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
HOST_SUDO="\${RSDK_HOST_SUDO:-}"

# The working directory holds rsdk's rootfs cache, so the caller can point it at
# a location that is shared between submissions of the same profile.
WORK="\${RSDK_WORK_DIR:-$HERE/work}"
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
  echo "kvm    : /dev/kvm mode=\${kvm_mode:-?} gid=\${kvm_gid:-?}"
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
        elif ! id -G | tr ' ' '\n' | grep -qx "$kvm_gid"; then
          echo "kvm    : /dev/kvm 归 gid $kvm_gid 且当前用户不在组内，镜像阶段会退化成 TCG 模拟" >&2
        fi
      fi
      ;;
  esac
fi

echo "engine : \$ENGINE \${ARGS[*]}"
echo "image  : \$IMAGE"
echo "bundle : \$HERE"
echo "work   : \$WORK"
echo "host   : uid=\$HOST_UID gid=\$HOST_GID, container runs as uid \$CONTAINER_UID"
echo

hand_over() {
  [[ "\$HOST_UID" == "\$CONTAINER_UID" ]] && return 0
  if [[ -z "\$HOST_SUDO" ]]; then
    echo "run.sh: 容器以 uid \$CONTAINER_UID 运行，而当前用户是 uid \$HOST_UID。" >&2
    echo "run.sh: 设 RSDK_HOST_SUDO=sudo 让它接管 \$WORK 的属主（CI 里都这么做）。" >&2
    return 0
  fi
  \$HOST_SUDO chown -R "\$CONTAINER_UID:\$CONTAINER_UID" "$WORK"
}

take_back() {
  [[ "\$HOST_UID" == "\$CONTAINER_UID" ]] && return 0
  [[ -n "\$HOST_SUDO" ]] || return 0
  \$HOST_SUDO chown -R "\$HOST_UID:\$HOST_GID" "$WORK"
}

hand_over

set -x
"\$ENGINE" "\${ARGS[@]}" run --rm \\
  --name "rsdk-webui-$(basename "$HERE")" \\
  --privileged \\
  --user "\$CONTAINER_UID:\$CONTAINER_UID" \\
  \${GROUP_ARGS[@]+"\${GROUP_ARGS[@]}"} \\
  \${RUN_EXTRA[@]+"\${RUN_EXTRA[@]}"} \\
  "\${TTY[@]}" \\
  -h rsdk-webui \\
  -e TERM=xterm-256color \\
  -e HOME=/home/rsdk \\
  -v /dev:/dev \\
  -v "$HERE:/rsdk-bundle" \\
  -v "$WORK:/home/rsdk" \\
  -v "$HERE/rsdk-build:/usr/share/rsdk/build:ro" \\
  -w /home/rsdk \\
  --shm-size=1g \\
  "$IMAGE" \\
  bash /rsdk-bundle/inner.sh
RC=$?
set +x

take_back
exit "\$RC"
`
}

export function renderFetchImageScript(): string {
  return `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fetch the official rsdk-image Debian package, extract its embedded container
# image and load it into the local engine. This is the exact environment
# Radxa ships for offline rsdk use.
#
#   ./fetch-image.sh [cache-dir] [target-tag]
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="\${RSDK_IMAGE_VERSION:-0.1.0-1}"
CACHE="\${1:-\$PWD/.rsdk-cache}"
TAG="\${2:-\${RSDK_IMAGE:-rsdk-image:latest}}"
ENGINE="\${RSDK_ENGINE:-docker}"
DEB="rsdk-image_\${VERSION}_amd64.deb"
URL="https://github.com/radxa-pkg/rsdk-image/releases/download/\${VERSION}/\${DEB}"

extract_ar() { # <archive> <dest-dir>
  local archive="$1" dest="$2"
  # the fallback runs from inside $dest, so the archive must be absolute
  [[ "$archive" = /* ]] || archive="$PWD/$archive"
  if command -v ar >/dev/null 2>&1; then
    ( cd "$dest" && ar x "$archive" )
  elif command -v bsdtar >/dev/null 2>&1; then
    bsdtar -xf "$archive" -C "$dest"
  else
    echo "neither ar nor bsdtar is available" >&2
    return 1
  fi
}

mkdir -p "$CACHE"
cd "$CACHE"

if [[ ! -s \$DEB ]]; then
  echo "==> downloading \$DEB"
  curl -fL --retry 3 --retry-delay 2 -o "\$DEB.part" "\$URL"
  mv "\$DEB.part" "\$DEB"
else
  echo "==> cached \$DEB"
fi

if [[ ! -s image.tar ]]; then
  echo "==> extracting image.tar"
  rm -rf .x && mkdir .x
  extract_ar "\$CACHE/\$DEB" .x
  data="\$(ls .x/data.tar.* | head -n 1)"
  tar -xf "\$data" -C .x ./usr/share/rsdk-image/image.tar
  mv .x/usr/share/rsdk-image/image.tar .
  rm -rf .x
fi

echo "==> loading image into \$ENGINE"
"\$ENGINE" load -i image.tar
"\$ENGINE" tag rsdk-image:latest "\$TAG" 2>/dev/null || true
echo "==> done: \$TAG"
`
}

// ---------------------------------------------------------------------------
// GitHub Actions wiring
// ---------------------------------------------------------------------------

/**
 * The GitHub Actions workflow.
 *
 * Deliberately *profile independent*: it reads `profile.json` from the checked
 * out branch. That is what makes the "fork once, build many images" model work -
 * the user's repository needs exactly one workflow file forever, and every build
 * branch carries its own copy of it.
 */
export function renderGhWorkflow(): string {
  return `# ---------------------------------------------------------------------------
# rsdk-webui - build a RadxaOS image from a pushed build bundle.
#
# Triggered by branches that a local rsdk-webui instance pushes to this
# repository. Everything the build needs is in that branch: profile.json,
# run.sh, inner.sh, customize/ and rsdk-build/. Nothing else is required.
#
# This file is generated by rsdk-webui; \`rsdk-webui\` keeps it up to date on the
# default branch. See the repository README.
# ---------------------------------------------------------------------------
name: rsdk-webui build

on:
  push:
    branches:
      - 'build/**'
      - 'runs/**'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: rsdk-webui-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - uses: actions/checkout@v4

      - name: Read the build profile
        id: profile
        run: |
          set -euo pipefail
          echo "runner identity: $(id -un) uid=$(id -u) gid=$(id -g)"
          board=$(jq -r '.target.product' profile.json)
          suite=$(jq -r '.target.suite' profile.json)
          edition=$(jq -r '.target.edition' profile.json)
          bundle="\${board}_\${suite}_\${edition}"
          compress=$(jq -r '.backend | if .kind == "gh-actions" then (.compress|tostring) else "true" end' profile.json)
          release=$(jq -r '.backend | if .kind == "gh-actions" then (.publishRelease|tostring) else "false" end' profile.json)
          printf 'bundle=%s\\ncompress=%s\\nrelease=%s\\n' "$bundle" "$compress" "$release" >> "$GITHUB_OUTPUT"

          {
            echo "## \$bundle"
            echo
            echo "| | |"
            echo "|---|---|"
            echo "| 方案 | \`$(jq -r '.meta.name' profile.json)\` |"
            echo "| 板子 | \`$board\` |"
            echo "| 系统 | \`$suite\` / \`$edition\` |"
            echo "| 扇区 | \`$(jq -r '.target.sectorSize' profile.json)\` |"
            echo "| 额外软件包 | $(jq -r '.packages.install | length' profile.json) 个 |"
            echo "| 覆盖文件 | $(jq -r '[.files[] | select(.enabled)] | length' profile.json) 个 |"
            echo
            echo "构建包来自分支 \`$GITHUB_REF_NAME\`，可用下面的命令在本地完整复现。"
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Cache the rsdk container package
        uses: actions/cache@v4
        with:
          path: .rsdk-cache/rsdk-image_*.deb
          key: rsdk-image-deb-0.1.0-1

      - name: Free disk space
        run: |
          sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc
          sudo rm -rf /opt/hostedtoolcache/CodeQL /usr/local/share/boost
          df -h /

      - name: Prepare the build container
        env:
          RSDK_ENGINE: docker
        run: ./fetch-image.sh "$PWD/.rsdk-cache" rsdk-image:latest

      - name: Build the image
        env:
          RSDK_ENGINE: docker
          RSDK_IMAGE: rsdk-image:latest
          RSDK_NO_TTY: '1'
          # the container always runs as the image's rsdk user (uid 1000), so
          # run.sh needs the runner's sudo to hand the working directory over
          RSDK_HOST_SUDO: sudo
        run: ./run.sh

      - name: Compress the image
        if: steps.profile.outputs.compress == 'true'
        run: |
          set -euo pipefail
          shopt -s nullglob
          cd work/out/*/
          for f in *.img *.tar; do
            echo "compressing $f"
            xz -T0 "$f"
          done

      - name: Checksums
        run: |
          set -euo pipefail
          cd work/out/*/
          find . -maxdepth 1 -type f -exec sha512sum {} \\; | tee SHA512SUMS

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: \${{ steps.profile.outputs.bundle }}
          path: work/out/**
          if-no-files-found: error
          compression-level: 0
          retention-days: 14

      - name: Publish a release
        if: steps.profile.outputs.release == 'true'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: \${{ steps.profile.outputs.bundle }}-\${{ github.run_number }}
          name: \${{ steps.profile.outputs.bundle }} (\${{ github.run_number }})
          body_path: README.md
          files: work/out/**/*
`
}

/** README committed to the user's repository (the one they fork / create). */
export function renderTemplateReadme(owner = '<your-account>', repo = 'rsdk-webui-builds'): string {
  return `# rsdk-webui build repository

This repository is the **build worker** for [rsdk-webui](https://github.com/xzl01/rsdk-webui).
It exists so that image builds run on GitHub's runners instead of your laptop.

You do not edit anything here by hand. The local rsdk-webui instance:

1. picks this repository,
2. commits a *build bundle* to a branch named \`build/<profile-id>\`,
3. lets the workflow in \`.github/workflows/build.yml\` build it,
4. shows the live status and lets you download the result.

## One-time setup

Either:

* **Fork the rsdk-webui project** (or press *Use this template* on it) and point
  the local instance at your copy — its default branch already carries
  \`.github/workflows/build.yml\`, so nothing else is needed, **or**
* **Let rsdk-webui create the repository for you** — 构建后端 → GitHub Actions →
  「准备仓库」 creates \`${owner}/${repo}\` (private by default), commits the
  workflow and the README you are reading, and makes sure Actions is enabled.

> [!IMPORTANT]
> GitHub disables workflows in **forks** until you enable them. rsdk-webui tries
> to enable them through the API; if your token lacks admin rights, open
> \`https://github.com/${owner}/${repo}/actions\` once and click the button.

The token needs the \`repo\` and \`workflow\` scopes: \`gh auth refresh -s workflow\`.

## What a build branch contains

Every \`build/<id>\` branch is a self-contained description of one image:

\`\`\`
profile.json          the source of truth
inner.sh              what runs inside the container: rsdk build ...
run.sh                host driver (podman/docker)
fetch-image.sh        downloads the official rsdk-image container
rsdk-build/           the image's jsonnet tree with our hook appended
customize/install.sh  the actual customization
customize/blobs/      files written into the rootfs
work/out/<board>_<suite>_<edition>/
                      the resulting image (ignored by git, uploaded as an artifact)
\`\`\`

So any branch can be reproduced anywhere:

\`\`\`bash
git clone --branch build/<id> https://github.com/${owner}/${repo}.git image && cd image
./fetch-image.sh
./run.sh
\`\`\`

## Requirements

* GitHub Actions enabled for the repository
* the default branch containing \`.github/workflows/build.yml\`
* nothing else - the runner installs the toolchain inside a container
`
}

// ---------------------------------------------------------------------------
// README inside the bundle
// ---------------------------------------------------------------------------

export function renderBundleReadme(p: Profile): string {
  const args = renderRsdkArgs(p)
  const extra = p.packages.install
  const lines = [
    `# ${p.meta.name}`,
    '',
    `Generated by rsdk-webui · profile \`${p.id}\` · ${new Date().toISOString()}`,
    '',
    '| | |',
    '|---|---|',
    `| board | \`${p.target.product}\` |`,
    `| suite / edition | \`${p.target.suite}\` / \`${p.target.edition}\` |`,
    `| sector size | ${p.target.sectorSize} |`,
    `| image name | \`${p.target.imageName}\` |`,
    `| backend | \`${p.backend.kind}\` |`,
    `| extra packages | ${extra.length} |`,
    `| overlay files | ${p.files.filter((f) => f.enabled).length} |`,
    `| custom hooks | ${p.hooks.pre.filter((h) => h.enabled).length} |`,
    '',
    '## Layout',
    '',
    '```',
    'profile.json             the source of truth, re-importable by the web UI',
    'inner.sh                 runs inside the container: `rsdk build ...`',
    'run.sh                   host-side driver (podman/docker)',
    'fetch-image.sh           downloads the official rsdk-image container',
    'host.env                 engine + image defaults for this host',
    'engine.args              engine global args (podman storage root, ...)',
    "rsdk-build/              copy of the image's /usr/share/rsdk/build, with",
    '                         rootfs.jsonnet patched to call our hook',
    'customize/install.sh     bdebstrap customize-hook (the actual injection)',
    'customize/blobs/         file contents written into the rootfs',
    'customize/apt/           extra apt sources + keys',
    'customize/hooks/         user supplied scripts',
    'work/                    build cwd; `work/out/<product>_<suite>_<edition>/`',
    '                         holds the resulting image',
    '```',
    '',
    '## How the injection works',
    '',
    'Upstream `rsdk build` renders `rootfs.jsonnet` and hands it to `bdebstrap`.',
    'We shadow `/usr/share/rsdk/build` with a copy of that tree in which exactly',
    'one term was added to the jsonnet sum:',
    '',
    '```jsonnet',
    '+ cleanup()',
    '+ { mmdebstrap+: { "customize-hooks "+: [ "bash /rsdk-bundle/customize/install.sh \\"$1\\"" ] } }',
    '```',
    '',
    'Nothing upstream is modified on disk, and everything the build does is',
    'readable in `customize/`.',
    '',
    '## Reproduce',
    '',
    '```bash',
    './fetch-image.sh          # once',
    './run.sh',
    '```',
    '',
    'Equivalent manual command:',
    '',
    '```bash',
    `rsdk ${args.map(shq).join(' ')}`,
    '```',
    '',
  ]
  if (p.backend.kind === 'gh-actions' && (p.system.wifi?.psk || p.system.user?.passwordHash)) {
    lines.push(
      '> [!WARNING]',
      '> This bundle contains credentials (WiFi PSK and/or a password hash).',
      '> Do not push it to a public repository.',
      '',
    )
  }
  return lines.join('\n')
}

export function renderHostEnv(p: Profile): string {
  const gh = p.backend.kind === 'gh-actions' ? p.backend : undefined
  const local = p.backend.kind === 'local-docker' ? p.backend : undefined
  return `# generated by rsdk-webui - defaults only, override via the environment
: "\${RSDK_ENGINE:=${local?.engine ?? (gh ? 'docker' : 'podman')}}"
: "\${RSDK_ENGINE_ARGS_FILE:=engine.args}"
: "\${RSDK_IMAGE:=${local?.image ?? 'rsdk-image:latest'}}"
: "\${RSDK_RUN_EXTRA:=${local?.engine === 'podman' || !local ? '--userns=keep-id' : ''}}"
`
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function renderBundle(
  p: Profile,
  ctx: BundleContext & { includeGhWorkflow?: boolean; includeGhExtras?: boolean } = {},
): BundleFile[] {
  const { script, blobs } = renderInstallScript(p, ctx)
  const files: BundleFile[] = [
    { path: 'customize/install.sh', content: script, mode: 0o755 },
    ...blobs,
    ...renderAptRepoFiles(p),
    ...renderHookFiles(p),
    { path: 'inner.sh', content: renderInnerScript(p), mode: 0o755 },
    { path: 'run.sh', content: renderRunScript(), mode: 0o755 },
    { path: 'fetch-image.sh', content: renderFetchImageScript(), mode: 0o755 },
    { path: 'host.env', content: renderHostEnv(p), mode: 0o644 },
    { path: 'profile.json', content: JSON.stringify(p, null, 2) + '\n', mode: 0o644 },
    { path: 'README.md', content: renderBundleReadme(p), mode: 0o644 },
  ]
  // always ship the workflow: the branch is then a complete, re-runnable
  // description of the build, independent of the repository's default branch
  files.push({ path: '.github/workflows/build.yml', content: renderGhWorkflow(), mode: 0o644 })
  return files
}
