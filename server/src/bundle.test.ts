/**
 * Integration tests for the parts that touch the real environment.
 *
 * These are skipped (not failed) when the official rsdk container image has not
 * been imported yet, so `pnpm test` still works on a fresh checkout.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ProfileSchema, requiredKernelPackages, socList, sectorList } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { detectEngine, engineRun } from './env.ts'
import { ensureBuildTree } from './rsdkTree.ts'
import { writeBundle } from './bundle.ts'
import { indexKey, sourcesFor } from './packages.ts'
import { requiredKernelPackages as requiredPackages } from '@rsdk-webui/shared'

const tree = await ensureBuildTree().catch(() => ({ ready: false, path: '', error: 'probe failed' }))
const skip = tree.ready ? false : `rsdk image not available (${tree.error ?? 'unknown'})`

test('the cached rsdk tree has the exact anchor we patch', { skip }, () => {
  const stock = fs.readFileSync(path.join(tree.path, 'build', 'rootfs.jsonnet'), 'utf8')
  assert.equal(stock.split('+ cleanup()').length - 1, 1)
})

test('writeBundle produces a bundle whose jsonnet still parses', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-bundle-'))
  const profile = ProfileSchema.parse({
    id: 'b-test',
    meta: { name: 'bundle test' },
    target: { product: 'radxa-e25', suite: 'bookworm', edition: 'cli' },
    packages: { install: ['nano'], purge: [] },
    system: { hostname: 'e25', user: { name: 'radxa', sshKeys: ['ssh-ed25519 AAAA t@h'] } },
    backend: { kind: 'local-docker', image: config.image, engine: (await detectEngine())?.kind ?? 'podman' },
  })

  try {
    const result = await writeBundle(profile, dir)
    assert.ok(result.files.length > 5)

    // the injection is present exactly once and upstream content is untouched
    const patched = fs.readFileSync(path.join(dir, 'rsdk-build', 'rootfs.jsonnet'), 'utf8')
    assert.equal(patched.split('/rsdk-bundle/customize/install.sh').length - 1, 1)
    const stock = fs.readFileSync(path.join(tree.path, 'build', 'rootfs.jsonnet'), 'utf8')
    assert.equal(patched.split('+ cleanup()').length - 1, 1)
    assert.ok(stock.length < patched.length)

    // every other jsonnet file is byte-identical to upstream
    for (const rel of ['build/mod/distro.libjsonnet', 'build/mod/packages.libjsonnet']) {
      assert.equal(
        fs.readFileSync(path.join(tree.path, rel), 'utf8'),
        fs.readFileSync(path.join(dir, 'rsdk-build', rel.replace('build/', '')), 'utf8'),
      )
    }

    // jsonnet must actually accept the patched file. Replicate the real mounts
    // (patched tree over /usr/share/rsdk/build, upstream configs untouched) so
    // the relative imports resolve exactly as they do during a build.
    const check = await engineRun(
      [
        'run', '--rm',
        '-v', `${dir}/rsdk-build:/usr/share/rsdk/build:ro`,
        '-v', `${tree.path}/configs:/usr/share/rsdk/configs:ro`,
        '-w', '/usr/share/rsdk/build',
        '--entrypoint', 'jsonnet', config.image,
        '--tla-str', 'product=radxa-e25', '--tla-str', 'suite=bookworm', '--tla-str', 'edition=cli',
        '--tla-str', 'temp_dir=/tmp/rsdk-test', '--tla-str', 'output_dir=/tmp/out',
        '--tla-str', 'build_date=2026-01-01T00:00:00', '--ext-code', 'sdboot=false',
        '/usr/share/rsdk/build/rootfs.jsonnet', '-o', '/dev/null',
      ],
      { timeoutMs: 120_000, retries: 2 },
    )
    assert.equal(check.code, 0, `jsonnet rejected the patched tree: ${check.stderr}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('requiredPackages follows the essential-hook package names', () => {
  const profile = ProfileSchema.parse({
    id: 'x',
    meta: { name: 'x' },
    target: { product: 'rock-5b', suite: 'bookworm', edition: 'kde' },
    backend: { kind: 'local-docker' },
  })
  assert.deepEqual(requiredPackages(profile, undefined).sort(), [
    'linux-headers-rock-5b',
    'linux-image-rock-5b',
    'task-rock-5b',
    'u-boot-rock-5b',
  ])
})

test('requiredPackages honours kernel/firmware overrides', () => {
  const profile = ProfileSchema.parse({
    id: 'x',
    meta: { name: 'x' },
    target: { product: 'rock-5b', suite: 'bookworm', edition: 'kde' },
    packages: { kernelOverride: 'linux-6.1', firmwareOverride: 'linux-firmware' },
    backend: { kind: 'local-docker' },
  })
  const required = requiredPackages(profile, undefined)
  assert.ok(required.includes('linux-image-linux-6.1'))
  assert.ok(required.includes('linux-headers-linux-6.1'))
  assert.ok(required.includes('u-boot-linux-firmware'))
})

test('the bootloader package prefix follows the board, not a hardcoded u-boot', () => {
  const profile = ProfileSchema.parse({
    id: 'x',
    meta: { name: 'x' },
    target: { product: 'radxa-orion-cix-p1', suite: 'bookworm', edition: 'gnome' },
    backend: { kind: 'local-docker' },
  })
  const product = {
    product: 'radxa-orion-cix-p1',
    soc: ['cd8180'],
    supported_suite: ['bookworm'],
    supported_edition: ['gnome'],
    firmware_type: 'edk2',
  }
  const required = requiredKernelPackages(profile, product)
  assert.ok(required.includes('edk2-radxa-orion-cix-p1'), required.join(','))
  assert.ok(!required.some((name) => name.startsWith('u-boot-')), 'edk2 boards have no u-boot package')
})

test('indexKey is stable regardless of order and handles string soc', () => {
  assert.equal(indexKey('bookworm', ['rk3588', 'rk3588s2']), indexKey('bookworm', ['rk3588s2', 'rk3588']))
  const product = { product: 'rock-5b', soc: 'rk3588', supported_suite: ['bookworm'], supported_edition: ['kde'] }
  assert.deepEqual(socList(product), ['rk3588'])
  assert.deepEqual(sectorList({ ...product, sector_size: 4096 }), [4096])
  const sources = sourcesFor(product, 'bookworm')
  assert.ok(sources.some((s) => s.url.includes('radxa-repo.github.io/rk3588-bookworm/')))
  assert.ok(sources.filter((s) => s.kind === 'distro').length >= 4)
})
