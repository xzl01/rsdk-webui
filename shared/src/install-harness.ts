/**
 * Execute the generated customize hook for real.
 *
 * `bash -n` only proves the script parses - it happily accepts an unbound
 * variable that `set -u` will abort on the first time the branch runs. So this
 * test builds a throwaway bundle + rootfs, stubs the tools that would need root
 * or the network, and asserts the side effects.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderAptRepoFiles, renderHookFiles, renderInstallScript } from './render.ts'
import type { Profile } from './schema.ts'

export type InstallRun = {
  code: number
  stdout: string
  stderr: string
  rootfs: string
  bundle: string
  cleanup: () => void
}

/** tools that must not run for real in a test */
const STUBS: Record<string, string> = {
  'apt-get': `#!/bin/sh\necho "stub apt-get $*" >&2\nexit 0\n`,
  chroot: `#!/bin/sh\necho "stub chroot $*" >&2\nexit 0\n`,
  curl: `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then mkdir -p "$(dirname "$out")"; printf 'stub-key\\n' > "$out"; fi
exit 0
`,
}

export function runInstallScript(profile: Profile): InstallRun {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-install-'))
  const bundle = path.join(tmp, 'bundle')
  const rootfs = path.join(tmp, 'rootfs')
  const stubDir = path.join(tmp, 'bin')

  // --- the bundle, exactly as writeBundle() would lay it out -----------------
  const { script, blobs } = renderInstallScript(profile)
  const files = [
    { path: 'customize/install.sh', content: script as string | Uint8Array, mode: 0o755 },
    ...blobs,
    ...renderAptRepoFiles(profile),
    ...renderHookFiles(profile),
  ]
  for (const file of files) {
    const target = path.join(bundle, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, typeof file.content === 'string' ? file.content : Buffer.from(file.content))
    fs.chmodSync(target, file.mode)
  }

  // --- a minimal plausibly-shaped target rootfs ------------------------------
  const mk = (rel: string, content = '') => {
    const target = path.join(rootfs, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  mk('etc/hosts', '127.0.0.1\tlocalhost\n::1\tlocalhost\n')
  mk('etc/locale.gen', '# zh_CN.UTF-8 UTF-8\n# en_US.UTF-8 UTF-8\n')
  mk('etc/hostname', 'radxa-e25\n')
  mk('usr/lib/systemd/system/ssh.service', '[Unit]\nDescription=ssh\n')
  mk('usr/lib/systemd/system/NetworkManager.service', '[Unit]\nDescription=nm\n')
  mk('usr/lib/systemd/system/avahi-daemon.service', '[Unit]\nDescription=avahi\n')
  mk('usr/sbin/sshd', '')
  mk('etc/apt/sources.list.d/existing.list', 'deb http://example.invalid/debian bookworm main\n')

  // --- stubs -----------------------------------------------------------------
  fs.mkdirSync(stubDir, { recursive: true })
  for (const [name, body] of Object.entries(STUBS)) {
    const target = path.join(stubDir, name)
    fs.writeFileSync(target, body)
    fs.chmodSync(target, 0o755)
  }

  const result = spawnSync('bash', [path.join(bundle, 'customize', 'install.sh'), rootfs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      RSDK_BUNDLE: bundle,
      // MMDEBSTRAP_APT_CONFIG intentionally unset: exercise the chroot fallback
      MMDEBSTRAP_APT_CONFIG: '',
    },
  })

  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    rootfs,
    bundle,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

export function exists(rootfs: string, rel: string): boolean {
  return fs.existsSync(path.join(rootfs, rel))
}

export function read(rootfs: string, rel: string): string {
  return fs.readFileSync(path.join(rootfs, rel), 'utf8')
}

export function mode(rootfs: string, rel: string): number {
  return fs.statSync(path.join(rootfs, rel)).mode & 0o777
}

export function isSymlinkTo(rootfs: string, rel: string, target: string): boolean {
  const full = path.join(rootfs, rel)
  if (!fs.lstatSync(full).isSymbolicLink()) return false
  return fs.readlinkSync(full) === target
}
