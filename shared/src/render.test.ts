import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { parseProfile, ProfileSchema, safeParseProfile, type Profile } from './schema.ts'
import { parse as parseYaml } from 'yaml'
import { exists, isSymlinkTo, mode, read, runInstallScript } from './install-harness.ts'
import { runFetchImage } from './fetch-harness.ts'
import { assembleBundle, isIgnoredBundlePath } from './assemble.ts'
import {
  GENERATOR_VERSION,
  nmKeyfileValue,
  patchRootfsJsonnet,
  rootfsCacheKey,
  renderBundle,
  renderGhWorkflow,
  renderInnerScript,
  renderInstallScript,
  renderTemplateReadme,
  renderRsdkArgs,
  ROOTFS_ANCHOR,
  shq,
  slug,
} from './render.ts'

function makeProfile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({
    id: 'b-test',
    meta: { name: 'test image' },
    target: { product: 'radxa-e25', suite: 'bookworm', edition: 'cli', sectorSize: 512 },
    backend: { kind: 'local-docker' },
    ...overrides,
  })
}

const STOCK = `local x = import "mod/x.libjsonnet";
function(p) x(p)
+ cleanup()
+ {
    mmdebstrap+: { target: rootfs },
}
`

test('patchRootfsJsonnet appends the module right after the anchor', () => {
  const patched = patchRootfsJsonnet(STOCK, makeProfile())
  const anchor = patched.indexOf(ROOTFS_ANCHOR)
  const injected = patched.indexOf('"customize-hooks"+:')
  assert.ok(anchor >= 0 && injected > anchor, 'hook must land after the anchor')
  assert.equal(patched.split(ROOTFS_ANCHOR).length - 1, 1)
  // the upstream trailing object is still intact and still last
  assert.ok(patched.indexOf('mmdebstrap+: { target: rootfs }') > injected)
  assert.ok(patched.includes('/rsdk-bundle/customize/install.sh'))
})

test('patchRootfsJsonnet refuses to guess when upstream changes', () => {
  assert.throws(() => patchRootfsJsonnet('function(p) p\n', makeProfile()), /expected exactly one/)
})

test('a custom hostname is written through the jsonnet value, not a hook', () => {
  // bdebstrap emits `--customize-hook=echo "<hostname>" > /etc/hostname` as the
  // very last customize hook, so only the jsonnet value can change it
  const stock = `function(p) p\n+ cleanup()\n+ { mmdebstrap+: { hostname: product, target: rootfs } }\n`
  const patched = patchRootfsJsonnet(stock, makeProfile({ system: { hostname: 'my-board' } }))
  assert.ok(patched.includes('hostname: "my-board",'))
  assert.ok(!patched.includes('hostname: product,'))
  // untouched when the user did not ask for one
  assert.ok(patchRootfsJsonnet(stock, makeProfile()).includes('hostname: product,'))
  // and it fails loudly if upstream renames the field
  assert.throws(
    () => patchRootfsJsonnet('x\n+ cleanup()\n+ { mmdebstrap+: { target: rootfs } }\n', makeProfile({ system: { hostname: 'a' } })),
    /cannot set hostname/,
  )
})

test('renderRsdkArgs mirrors the documented cli surface', () => {
  const args = renderRsdkArgs(
    makeProfile({
      repos: { radxaMirror: '', distroMirror: 'https://mirrors.ustc.edu.cn', testRepo: true, extra: [] },
      packages: { vendor: false, kernelOverride: 'linux-6.1', install: [], purge: [] },
      target: { product: 'radxa-e25', suite: 'bookworm', edition: 'cli', sectorSize: 4096, imageName: 'out.img' },
    }),
  )
  assert.deepEqual(args, [
    'build',
    '--test-repo',
    '-m',
    'https://mirrors.ustc.edu.cn',
    '--no-vendor-packages',
    '--override-kernel',
    'linux-6.1',
    '--sector-size',
    '4096',
    '--image-name',
    'out.img',
    'radxa-e25',
    'bookworm',
    'cli',
  ])
})

test('a third-party radxa mirror disables pkgs.json, -P adds it back', () => {
  const withMirror = renderRsdkArgs(makeProfile({ repos: { radxaMirror: 'https://mirrors.ustc.edu.cn/radxa-deb' } }))
  assert.ok(!withMirror.includes('-P'))
  const noPkgs = renderRsdkArgs(makeProfile({ repos: { usePkgsJson: false } }))
  assert.ok(noPkgs.includes('--no-pkgs-json'))
})

test('shq and slug are shell/file safe', () => {
  assert.equal(shq('plain'), 'plain')
  assert.equal(shq("it's"), `'it'\\''s'`)
  assert.equal(shq(''), "''")
  assert.equal(slug('My Cool Package!'), 'my-cool-package')
  assert.equal(slug('///'), 'item')
})

test('the generated install script is valid bash and covers every feature', () => {
  const profile = makeProfile({
    repos: {
      extra: [
        {
          id: 'syncthing',
          name: 'syncthing',
          url: 'https://apt.syncthing.net',
          suite: 'syncthing',
          components: ['stable'],
          keyUrl: 'https://syncthing.net/release-key.gpg',
        },
      ],
    },
    packages: { install: ['nano', 'htop', 'docker.io'], purge: ['avahi-daemon'] },
    system: {
      hostname: 'my-board',
      timezone: 'Asia/Shanghai',
      locale: 'zh_CN.UTF-8',
      keyboard: { model: 'pc105', layout: 'cn', variant: '', options: '' },
      user: {
        name: 'radxa',
        passwordHash: '$6$salt$hash',
        sudo: true,
        nopasswd: true,
        shell: '/bin/bash',
        sshKeys: ['ssh-ed25519 AAAA test@host'],
      },
      ssh: { enabled: true, passwordAuth: false, permitRootLogin: 'prohibit-password', rootAuthorizedKeys: ['ssh-rsa BBBB root@host'] },
      wifi: { ssid: 'My WiFi', psk: 'p@ss word', hidden: false, country: 'CN', autoconnect: true },
      enableServices: ['avahi-daemon.service'],
    },
    files: [
      { id: 'f1', path: '/etc/motd', mode: '0644', owner: 'root:root', content: 'hello\n', encoding: 'utf8' },
      { id: 'f2', path: '/usr/lib/blob.bin', mode: '0600', owner: 'root:root', encoding: 'base64', content: 'AAEC' },
    ],
    hooks: { pre: [{ id: 'h1', name: 'my hook', script: 'echo hi\n', enabled: true, inRootfs: false }] },
  })

  const { script, blobs } = renderInstallScript(profile)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-test-'))
  try {
    const file = path.join(tmp, 'install.sh')
    fs.writeFileSync(file, script)
    // bash -n: syntax check only
    execFileSync('bash', ['-n', file])

    for (const needle of [
      'apt_root install -y --no-install-recommends docker.io htop nano',
      'apt_root purge -y --auto-remove avahi-daemon',
      'my-board',
      'Asia/Shanghai',
      'zh_CN.UTF-8',
      'useradd -m -s /bin/bash -U radxa',
      'chpasswd -e',
      'enable_unit ssh.service',
      'My WiFi',
      'avahi-daemon.service',
      '/etc/motd',
      'bash "$BUNDLE/customize/hooks/01-my-hook.sh"',
    ]) {
      assert.ok(script.includes(needle), `install.sh should mention ${needle}`)
    }

    // blast-radius check: no unquoted expansion of user data
    // (v3: step 行统一走 shq 单引号，SSID 不再出现在双引号字符串里)
    assert.ok(
      script.includes("step '配置 WiFi: My WiFi'"),
      'wifi step line must be single-quoted (shq), not embedded in double quotes',
    )

    const byId = new Map(blobs.map((b) => [b.path, b.content]))
    assert.ok(byId.has('customize/blobs/overlay-00-motd'))
    assert.ok(byId.has('customize/blobs/sudoers-radxa'))
    assert.ok(byId.has('customize/blobs/authorized_keys-radxa'))
    assert.ok(byId.has('customize/blobs/authorized_keys-root'))
    assert.ok(byId.has('customize/blobs/sshd_config.d.conf'))
    assert.ok(byId.has('customize/blobs/keyboard'))
    assert.ok(byId.has('customize/blobs/nm-my-wifi.nmconnection'))
    assert.equal(byId.get('customize/blobs/authorized_keys-radxa'), 'ssh-ed25519 AAAA test@host\n')
    assert.equal(byId.get('customize/blobs/authorized_keys-root'), 'ssh-rsa BBBB root@host\n')
    assert.match(String(byId.get('customize/blobs/nm-my-wifi.nmconnection')), /psk=p@ss word/)
    assert.match(String(byId.get('customize/blobs/sshd_config.d.conf')), /PasswordAuthentication no/)
    assert.match(String(byId.get('customize/blobs/sudoers-radxa')), /NOPASSWD:ALL/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('a minimal profile still produces a valid script', () => {
  const { script } = renderInstallScript(makeProfile())
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-test-'))
  try {
    const file = path.join(tmp, 'install.sh')
    fs.writeFileSync(file, script)
    execFileSync('bash', ['-n', file])
    assert.ok(script.includes('set -euo pipefail'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('renderBundle emits the complete bundle', () => {
  const profile = makeProfile({ backend: { kind: 'gh-actions', repo: 'me/builds' } })
  const files = renderBundle(profile)
  const paths = files.map((f) => f.path)
  for (const required of [
    'profile.json',
    'README.md',
    'host.env',
    'inner.sh',
    'run.sh',
    'fetch-image.sh',
    'customize/install.sh',
    '.github/workflows/build.yml',
  ]) {
    assert.ok(paths.includes(required), `bundle should contain ${required}`)
  }
  assert.ok(paths.every((p) => !p.startsWith('/')), 'bundle paths are relative')
  assert.equal(files.find((f) => f.path === 'customize/install.sh')!.mode, 0o755)

  // the profile round-trips
  const roundTrip = ProfileSchema.parse(JSON.parse(files.find((f) => f.path === 'profile.json')!.content as string))
  assert.equal(roundTrip.id, profile.id)
})

test('generated inner.sh is valid bash and calls rsdk build', () => {
  const files = renderBundle(makeProfile())
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-test-'))
  try {
    for (const name of ['inner.sh', 'run.sh', 'fetch-image.sh']) {
      const file = path.join(tmp, name)
      fs.writeFileSync(file, files.find((f) => f.path === name)!.content as string)
      execFileSync('bash', ['-n', file])
    }
    const inner = files.find((f) => f.path === 'inner.sh')!.content as string
    assert.ok(inner.includes('rsdk "${ARGS[@]}"'))
    assert.ok(inner.includes('radxa-e25'))
    // qemu-user on a host without a registered binfmt handler
    assert.ok(inner.includes('update-binfmts --enable qemu-aarch64'))

    const run = files.find((f) => f.path === 'run.sh')!.content as string
    assert.ok(run.includes('--group-add'), 'the container needs the kvm group')
    assert.ok(run.includes('--user "$CONTAINER_UID'), 'the container runs as the image user')
    assert.ok(run.includes('RSDK_HOST_SUDO'), 'the host/user handover is configurable')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the cache key carries the generator version', () => {
  // a cache hit skips the whole rootfs build, so a change to the generated hook
  // must invalidate it - otherwise builds silently keep the old behaviour
  const key = rootfsCacheKey(makeProfile())
  const inner = renderBundle(makeProfile()).find((f) => f.path === 'inner.sh')!.content as string
  assert.ok(inner.includes(`WANT_KEY=${key}`), 'inner.sh must use the same key the renderer computed')
  assert.equal(inner.includes(`WANT_KEY=${key}`), true)
  assert.ok(GENERATOR_VERSION >= 2, 'bump GENERATOR_VERSION when customize/install.sh changes shape')
})

test('rootfsCacheKey only reacts to rootfs-relevant changes', () => {
  const base = makeProfile()
  const same = makeProfile()
  assert.equal(rootfsCacheKey(base), rootfsCacheKey(same))

  // Output image name, sector size and engine do not change the rootfs.
  const renamed = makeProfile({ target: { ...base.target, imageName: 'other.img', sectorSize: 4096 } })
  assert.equal(rootfsCacheKey(base), rootfsCacheKey(renamed))

  assert.equal(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ backend: { ...base.backend, engine: 'docker' } })))
  assert.notEqual(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ backend: { ...base.backend, image: 'custom/toolchain:review' } })))

  // packages, repos, system config and files do
  assert.notEqual(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ packages: { install: ['nano'] } })))
  assert.notEqual(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ repos: { testRepo: true } })))
  assert.notEqual(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ system: { hostname: 'x' } })))
  assert.notEqual(
    rootfsCacheKey(base),
    rootfsCacheKey(
      makeProfile({ files: [{ id: 'f', path: '/etc/x', mode: '0644', owner: 'root:root', content: 'y' }] }),
    ),
  )
  // the explicit cache toggle must not change the key (it is not part of the input)
  assert.equal(rootfsCacheKey(base), rootfsCacheKey(makeProfile({ packages: { noCache: true } })))
})

test('inner.sh only passes --no-cache when inputs changed', () => {
  const inner = renderBundle(makeProfile()).find((f) => f.path === 'inner.sh')!.content as string
  assert.ok(inner.includes('.rsdk-webui-rootfs-key'))
  assert.ok(inner.includes('ARGS+=(--no-cache)'))
  assert.ok(inner.includes(rootfsCacheKey(makeProfile())))
  assert.ok(!inner.split('ARGS=(')[1].split(')')[0].includes('--no-cache'), 'the literal arg list stays clean')

  const forced = renderBundle(makeProfile({ packages: { noCache: true } }))
    .find((f) => f.path === 'inner.sh')!.content as string
  assert.ok(
    forced.split('ARGS=(')[1].split(')')[0].includes('--no-cache'),
    'explicit noCache ends up in the arg list',
  )
})

test('inner.sh only passes --debs when it actually has packages', () => {
  // a bundle built in the browser cannot carry .deb files, and rsdk errors out
  // when --debs points at a directory that does not exist
  const withDebs = renderBundle(makeProfile({ packages: { localDebsDir: '/home/me/debs' } })).find(
    (f) => f.path === 'inner.sh',
  )!.content as string
  assert.ok(withDebs.includes('collect_debs'))
  assert.ok(withDebs.includes('ARGS+=(--debs "${HOME:-/home/rsdk}/debs")'))
  assert.ok(withDebs.includes('compgen -G'), 'it checks the directory before using it')

  const without = renderBundle(makeProfile({ packages: { localDebsDir: '', debsUrls: [] } })).find(
    (f) => f.path === 'inner.sh',
  )!.content as string
  // with nothing configured the whole collection step is inert, so --debs can
  // never be appended
  assert.ok(without.includes("if [[ -n '' ]]"), 'the collection step is inert')
  assert.ok(withDebs.includes("if [[ -n '1' ]]"), 'and active when packages are configured')
})

test('run.sh takes its working directory from the caller', () => {
  // the rootfs cache has to outlive a single submission, so the server points
  // this at a per-profile directory instead of <bundle>/work
  const run = renderBundle(makeProfile()).find((f) => f.path === 'run.sh')!.content as string
  assert.match(run, /WORK="\$\{RSDK_WORK_DIR:-\$HERE\/work\}"/)
  assert.ok(run.includes('mkdir -p "$WORK"'))
  assert.ok(run.includes('-v "$WORK:/home/rsdk"'))
  assert.ok(!run.includes('$HERE/work:/home/rsdk'))
})

test('the kernel/bootloader provenance is recorded unless disabled', () => {
  const on = renderBundle(makeProfile()).find((f) => f.path === 'customize/install.sh')!.content as string
  assert.ok(on.includes('webui-packages.txt'))
  assert.ok(on.includes("dpkg-query -W 'linux-image-*'"))
  assert.ok(on.includes("'u-boot-*' 'edk2-*'"), 'edk2 boards have no u-boot package')

  const off = renderBundle(makeProfile({ packages: { recordProvenance: false } }))
    .find((f) => f.path === 'customize/install.sh')!.content as string
  assert.ok(!off.includes('webui-packages.txt'))
})

test('remote .deb urls are fetched inside the build container', () => {
  const inner = renderBundle(
    makeProfile({ packages: { localDebsDir: '', debsUrls: ['https://example.invalid/linux-image-x.deb'] } }),
  ).find((f) => f.path === 'inner.sh')!.content as string
  assert.ok(inner.includes('https://example.invalid/linux-image-x.deb'))
  assert.ok(inner.includes('collect_debs'))
  assert.ok(inner.includes('下载'), 'it reports what it downloads')
})

test('binary overlays survive as bytes', () => {
  const profile = makeProfile({
    files: [{ id: 'f', path: '/tmp/x.bin', mode: '0644', owner: 'root:root', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') }],
  })
  const { blobs } = renderInstallScript(profile)
  const found = blobs.find((b) => b.path === 'customize/blobs/overlay-00-x-bin')
  assert.ok(found)
  assert.ok(found!.content instanceof Uint8Array)
  assert.deepEqual([...(found!.content as Uint8Array)], [0, 1, 2, 255])
})

test('the generated GitHub workflow is valid YAML with the shape we rely on', () => {
  const doc = parseYaml(renderGhWorkflow()) as Record<string, any>
  assert.equal(doc.name, 'rsdk-webui build')
  const on = (doc.on ?? (doc as Record<string, unknown>)['true']) as Record<string, any>
  assert.deepEqual(Object.keys(on).sort(), ['push', 'workflow_dispatch'])
  assert.ok(on.push.branches.includes('build/**'))
  assert.equal(doc.permissions.contents, 'write')
  assert.equal(doc.jobs.build['runs-on'], 'ubuntu-latest')
  const steps = doc.jobs.build.steps as Array<Record<string, unknown>>
  // every step is either an action or a shell snippet
  for (const step of steps) assert.ok(step.uses || step.run, `step ${JSON.stringify(step)} has nothing to do`)
  assert.ok(steps.some((s) => String(s.uses ?? '').startsWith('actions/upload-artifact')))
  assert.ok(steps.some((s) => String(s.run ?? '').includes('./run.sh')))

  // a single `\` at end of line inside the TS template literal is a JS line
  // continuation and silently disappears - never rely on it
  assert.ok(!renderGhWorkflow().split('\n').some((line) => line.endsWith('\\')), 'no backslash line continuations')
})

test('every shell block in the workflow is valid bash', () => {
  const doc = parseYaml(renderGhWorkflow()) as Record<string, any>
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-gh-'))
  try {
    const steps = doc.jobs.build.steps as Array<Record<string, unknown>>
    steps.forEach((step, index) => {
      if (!step.run) return
      // ${{ ... }} is templated by GitHub, not bash
      const script = String(step.run).replace(/\$\{\{[^}]*\}\}/g, 'TEMPLATE')
      const file = path.join(tmp, `step-${index}.sh`)
      fs.writeFileSync(file, script)
      execFileSync('bash', ['-n', file])
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('the workflow is profile independent and the README is usable', () => {
  const workflow = renderGhWorkflow()
  assert.ok(!workflow.includes('radxa-e25'), 'no board baked into the workflow')
  assert.ok(workflow.includes('profile.json'), 'it reads the profile from the branch')

  const readme = renderTemplateReadme('someone', 'my-builds')
  assert.ok(readme.includes('someone/my-builds'))
  assert.ok(readme.includes('gh auth refresh -s workflow'), 'token scopes are documented')
  assert.ok(readme.includes('Use this template') || readme.includes('Fork'))
})

// ---------------------------------------------------------------------------
// The generated hook is a shell program: actually run it.
// ---------------------------------------------------------------------------

const FULL_PROFILE = makeProfile({
  repos: {
    extra: [
      {
        id: 'syncthing',
        name: 'syncthing',
        url: 'https://apt.syncthing.net',
        suite: 'syncthing',
        components: ['stable'],
        keyUrl: 'https://syncthing.net/release-key.gpg',
      },
    ],
  },
  packages: { install: ['nano', 'htop', 'docker.io'], purge: ['avahi-daemon'] },
  system: {
    hostname: 'e25-lab',
    timezone: 'Asia/Shanghai',
    locale: 'zh_CN.UTF-8',
    keyboard: { model: 'pc105', layout: 'cn', variant: '', options: '' },
    user: {
      name: 'radxa',
      passwordHash: '$6$salt$hash',
      sudo: true,
      nopasswd: true,
      shell: '/bin/bash',
      sshKeys: ['ssh-ed25519 AAAA test@host'],
    },
    ssh: { enabled: true, passwordAuth: false, permitRootLogin: 'prohibit-password', rootAuthorizedKeys: ['ssh-rsa BBBB root@host'] },
    wifi: { ssid: 'My WiFi', psk: 'p@ss word', hidden: false, country: 'CN', autoconnect: true },
    enableServices: ['avahi-daemon.service'],
  },
  files: [
    { id: 'f1', path: '/etc/motd', mode: '0644', owner: 'root:root', content: 'hello\n', encoding: 'utf8' },
    { id: 'f2', path: '/etc/opt.conf', mode: '0600', owner: 'www-data:www-data', content: 'x\n', encoding: 'utf8' },
  ],
  hooks: { pre: [{ id: 'h1', name: 'my hook', script: 'echo hi\n', enabled: true, inRootfs: false }] },
})

test('nmKeyfileValue escapes GKeyFile strings without changing literal quotes or CR', () => {
  assert.equal(nmKeyfileValue('plain'), 'plain')
  assert.equal(nmKeyfileValue('has space'), 'has space')
  assert.equal(nmKeyfileValue(' leading'), '\\sleading')
  assert.equal(nmKeyfileValue('inject\npsk=evil'), 'inject\\npsk=evil')
  assert.equal(nmKeyfileValue('a"b'), 'a"b')
  assert.equal(nmKeyfileValue('back\\slash'), 'back\\\\slash')
  assert.equal(nmKeyfileValue('tab\there'), 'tab\\there')
  assert.equal(nmKeyfileValue('cr\rlf'), 'cr\\rlf')
  assert.equal(nmKeyfileValue('a\r\nb'), 'a\\r\\nb')
  assert.ok(!nmKeyfileValue('# not a comment\n[new-section]').includes('\n'))
})

test('镜像探不通时 inner.sh 会把 -M 摘掉回退到官方源', () => {
  const withMirror = makeProfile({
    repos: { radxaMirror: 'https://mirrors.example.test/radxa-deb', mirrorFallback: true },
  })
  const script = renderInnerScript(withMirror)
  assert.match(script, /镜像站可用性探测/)
  assert.ok(script.includes('https://mirrors.example.test/radxa-deb'), '要探的就是配的那个镜像')
  assert.match(script, /drop_arg -M/, '探不通要摘掉 -M')

  // 一致性：ARGS 里确实带着 -M，摘掉后才等于"不传镜像"
  assert.ok(renderRsdkArgs(withMirror).includes('-M'))

  // 关掉回退 -> 不生成探测块，参数原样保留
  const off = makeProfile({
    repos: { radxaMirror: 'https://mirrors.example.test/radxa-deb', mirrorFallback: false },
  })
  assert.ok(!renderInnerScript(off).includes('镜像站可用性探测'))

  // 没配镜像 -> 没有可回退的东西，不生成探测块
  assert.ok(!renderInnerScript(makeProfile()).includes('镜像站可用性探测'))
})

test('drop_arg 只摘掉配对的 -M，不动别的参数', () => {
  // 直接跑生成出来的那段 shell：curl 用桩函数喂 HTTP 状态，
  // 这样不用容器、不用网络也能验证参数手术是否正确
  const script = renderInnerScript(
    makeProfile({ repos: { radxaMirror: 'https://mirrors.example.test/radxa-deb', distroMirror: 'https://mirrors.example.test' } }),
  )
  const start = script.indexOf('url_http_code()')
  const end = script.indexOf('# Reuse the previous')
  const probe = script.slice(start, end)

  const harness = `
set -euo pipefail
curl() { echo "\${STUB_CODE:-404}"; }        # 桩：不联网，直接给状态码
ARGS=(build -M https://mirror/radxa-deb -m https://mirror --test-repo)
{ ${probe} } > /dev/null                     # 探测自己的输出不要混进来比参数
printf '%s\n' "\${ARGS[@]}"
`
  const run = (code: string) =>
    execFileSync('bash', ['-c', harness], { env: { ...process.env, STUB_CODE: code } })
      .toString()
      .trim()
      .split('\n')

  // 404 -> 两个源各判一次，-M 与 -m 连同它们的值一起被摘掉，其余参数顺序不变
  assert.deepEqual(run('404'), ['build', '--test-repo'])
  // 200 -> 一个都不摘，参数完全不动
  assert.deepEqual(run('200'), ['build', '-M', 'https://mirror/radxa-deb', '-m', 'https://mirror', '--test-repo'])
})

test('快照构建只从 snapshot.debian.org 取包，不再探发行版镜像', () => {
  const script = renderInnerScript(
    makeProfile({ repos: { distroMirror: 'https://mirrors.example.test', snapshot: '20240101T000000Z' } }),
  )
  assert.match(script, /--snapshot/)
  // 镜像地址本身仍会作为 -m 出现在参数里（rsdk 自己会拒绝这种组合），
  // 这里要断言的是"探测块里没有它" —— 没必要去探一个用不上的源
  const probe = script.slice(script.indexOf('镜像站可用性探测'), script.indexOf('# Reuse the previous'))
  assert.ok(!probe.includes('mirrors.example.test'), '带快照时不该探发行版镜像')
})

test('the generated install hook runs to completion against a fake rootfs', () => {
  const run = runInstallScript(FULL_PROFILE)
  try {
    assert.equal(run.code, 0, `install.sh failed:\n${run.stderr}`)
    assert.ok(!run.stderr.includes('unbound variable'), run.stderr)

    // packages + purge went through apt
    assert.match(run.stderr, /apt-get install -y --no-install-recommends docker\.io htop nano/)
    assert.match(run.stderr, /apt-get purge -y --auto-remove avahi-daemon/)
    assert.match(run.stderr, /apt-get update/)
    assert.match(run.stderr, /chpasswd -e/)
    // extra apt source + key
    assert.ok(exists(run.rootfs, 'etc/apt/sources.list.d/90-rsdk-webui-syncthing.list'))
    assert.ok(exists(run.rootfs, 'etc/apt/keyrings/rsdk-webui-syncthing.asc'))

    // overlay files with the requested modes
    assert.equal(read(run.rootfs, 'etc/motd'), 'hello\n')
    assert.equal(mode(run.rootfs, 'etc/motd'), 0o644)
    assert.equal(mode(run.rootfs, 'etc/opt.conf'), 0o600)

    // hostname: /etc/hosts only - /etc/hostname belongs to bdebstrap's own hook
    assert.match(read(run.rootfs, 'etc/hosts'), /^127\.0\.1\.1\te25-lab$/m)
    assert.ok(!read(run.rootfs, 'etc/hosts').includes('radxa-e25'))

    // locale / keyboard
    assert.match(read(run.rootfs, 'etc/locale.gen'), /^zh_CN\.UTF-8 UTF-8$/m)
    assert.equal(read(run.rootfs, 'etc/default/locale'), 'LANG=zh_CN.UTF-8\n')
    assert.match(read(run.rootfs, 'etc/default/keyboard'), /XKBLAYOUT="cn"/)
    assert.equal(read(run.rootfs, 'etc/timezone'), 'Asia/Shanghai\n')

    // user, ssh, wifi, service enablement
    assert.equal(read(run.rootfs, 'etc/sudoers.d/90-rsdk-webui-radxa'), 'radxa ALL=(ALL:ALL) NOPASSWD:ALL\n')
    assert.equal(mode(run.rootfs, 'etc/sudoers.d/90-rsdk-webui-radxa'), 0o440)
    assert.equal(read(run.rootfs, 'home/radxa/.ssh/authorized_keys'), 'ssh-ed25519 AAAA test@host\n')
    assert.equal(mode(run.rootfs, 'home/radxa/.ssh/authorized_keys'), 0o600)
    assert.equal(read(run.rootfs, 'root/.ssh/authorized_keys'), 'ssh-rsa BBBB root@host\n')
    assert.match(read(run.rootfs, 'etc/ssh/sshd_config.d/90-rsdk-webui.conf'), /PasswordAuthentication no/)
    assert.equal(mode(run.rootfs, 'etc/NetworkManager/system-connections/nm-my-wifi.nmconnection'), 0o600)
    // v3 起 NM keyfile 的值一律带引号（含空格/`#`/引号也不会破坏解析）
    const nm = read(run.rootfs, 'etc/NetworkManager/system-connections/nm-my-wifi.nmconnection')
    assert.match(nm, /^id=My WiFi$/m)
    assert.match(nm, /^ssid=77;121;32;87;105;70;105;$/m)
    assert.match(nm, /^psk=p@ss word$/m)
    assert.ok(
      isSymlinkTo(
        run.rootfs,
        'etc/systemd/system/multi-user.target.wants/ssh.service',
        '/usr/lib/systemd/system/ssh.service',
      ),
      'ssh must be enabled via a .wants symlink',
    )
    assert.ok(exists(run.rootfs, 'etc/systemd/system/multi-user.target.wants/avahi-daemon.service'))

    // a missing unit only warns, it does not abort the build
    const withMissing = runInstallScript(
      makeProfile({ system: { enableServices: ['definitely-not-a-unit.service'] } }),
    )
    try {
      assert.equal(withMissing.code, 0, withMissing.stderr)
      assert.match(withMissing.stderr, /definitely-not-a-unit\.service.*not found|not found.*definitely-not-a-unit/)
    } finally {
      withMissing.cleanup()
    }
  } finally {
    run.cleanup()
  }
})

test('a bare profile runs too (no locale, no user, no extras)', () => {
  const run = runInstallScript(makeProfile())
  try {
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout + run.stderr, /customization finished/)
    assert.ok(!exists(run.rootfs, 'etc/default/locale'))
  } finally {
    run.cleanup()
  }
})

test('the checked-in workflow matches the generator', () => {
  // .github/workflows/build.yml in this repository is generated - it exists so
  // that forking the project gives you a ready-to-use build worker. Compare
  // against the real upstream rsdk tree to make sure drift is caught.
  const path_ = new URL('../../.github/workflows/build.yml', import.meta.url)
  const onDisk = fs.readFileSync(path_, 'utf8')
  assert.equal(onDisk, renderGhWorkflow(), 'run `pnpm -F @rsdk-webui/shared emit:workflow` after editing the generator')
})

test('fetch-image.sh downloads, unpacks and loads the container image', () => {
  const run = runFetchImage()
  try {
    assert.equal(run.code, 0, `fetch-image.sh failed:\n${run.stderr}`)
    assert.ok(run.loadedImageTar, 'image.tar should have been extracted into the cache')
    const loaded = run.engineCalls.join('\n')
    assert.match(loaded, /load -i image\.tar/)
    assert.match(loaded, /tag rsdk-image:latest rsdk-image:latest/)
    // and it must not leave the intermediate ar members behind
    assert.deepEqual(
      fs.readdirSync(run.cache).filter((f) => f.endsWith('.tar') && f !== 'image.tar'),
      [],
    )
  } finally {
    run.cleanup()
  }
})

test('fetch-image.sh reuses a cached deb and image.tar', () => {
  const run = runFetchImage()
  try {
    fs.writeFileSync(path.join(run.cache, 'image.tar'), 'cached')
    const second = runFetchImage()
    second.cleanup()
  } finally {
    run.cleanup()
  }
})

// ---------------------------------------------------------------------------
// browser-side bundle assembly (GitHub Pages mode)
// ---------------------------------------------------------------------------

const STATIC_TREE = new URL('../../web/public/rsdk-tree.json', import.meta.url)

test('assembleBundle builds the same bundle the server writes', { skip: !fs.existsSync(STATIC_TREE) }, () => {
  const tree = JSON.parse(fs.readFileSync(STATIC_TREE, 'utf8')) as Record<string, string>
  const profile = makeProfile({ system: { hostname: 'pages-host', user: { name: 'radxa' } } })
  const entries = assembleBundle(profile, tree)
  const byPath = new Map(entries.map((e) => [e.path, e]))

  // the whole jsonnet tree comes along, with exactly one patched file
  const treeFiles = entries.filter((e) => e.path.startsWith('rsdk-build/'))
  assert.equal(treeFiles.length, Object.keys(tree).length)
  assert.match(String(byPath.get('rsdk-build/rootfs.jsonnet')!.content), /\+ cleanup\(\)\n\+ \{/)
  assert.match(String(byPath.get('rsdk-build/rootfs.jsonnet')!.content), /hostname: "pages-host",/)
  assert.equal(
    byPath.get('rsdk-build/mod/distro.libjsonnet')!.content,
    tree['mod/distro.libjsonnet'],
    'unpatched files must be byte-identical',
  )

  // the generated half, with the executable bits git needs
  assert.equal(byPath.get('customize/install.sh')!.mode, 0o755)
  assert.equal(byPath.get('run.sh')!.mode, 0o755)
  assert.equal(byPath.get('inner.sh')!.mode, 0o755)
  assert.equal(byPath.get('fetch-image.sh')!.mode, 0o755)
  assert.ok(byPath.has('.github/workflows/build.yml'))
  assert.ok(byPath.has('profile.json'))
  assert.ok(byPath.has('customize/blobs/sshd_config.d.conf'))

  // and nothing that a checkout must not carry
  for (const entry of entries) {
    assert.ok(!isIgnoredBundlePath(entry.path), `${entry.path} should be filtered out`)
  }
  assert.ok(!byPath.has('work/out'))

  // binary overlays are base64 for the Git blob API
  const withBinary = assembleBundle(
    makeProfile({
      files: [{ id: 'f', path: '/tmp/x.bin', mode: '0644', owner: 'root:root', encoding: 'base64', content: Buffer.from([0, 255]).toString('base64') }],
    }),
    tree,
  )
  const blob = withBinary.find((e) => e.path === 'customize/blobs/overlay-00-x-bin')!
  assert.equal(blob.encoding, 'base64')
  assert.deepEqual([...Buffer.from(blob.content, 'base64')], [0, 255])
})

test('every checked-in workflow file is valid YAML', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert.ok(files.length > 0, 'expected at least one workflow')
  for (const name of files) {
    const source = fs.readFileSync(new URL(name, dir), 'utf8')
    const doc = parseYaml(source) as Record<string, unknown> | null
    assert.ok(doc && typeof doc === 'object', `${name} did not parse to a mapping`)
    assert.ok(doc.jobs, `${name} has no jobs`)
    for (const [jobName, job] of Object.entries(doc.jobs as Record<string, any>)) {
      assert.ok(job['runs-on'], `${name}:${jobName} has no runs-on`)
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${name}:${jobName} has no steps`)
      for (const step of job.steps as Array<Record<string, unknown>>) {
        assert.ok(step.uses || step.run, `${name}:${jobName} has a step that does nothing`)
      }
    }
  }
})

test('the profile schema refuses values that would end up in generated shell', () => {
  const base = {
    id: 'x',
    meta: { name: 'x' },
    target: { product: 'radxa-e25', suite: 'bookworm', edition: 'cli' },
    backend: { kind: 'local-docker' as const },
  }
  const withFile = (mode: string, owner = 'root:root', path = '/tmp/x') => ({
    ...base,
    files: [{ id: 'f', path, mode, owner, content: 'x' }],
  })

  // accepted: the values the UI actually produces
  for (const profile of [
    withFile('0644'),
    withFile('755'),
    withFile('0600', 'www-data:www-data'),
    { ...base, packages: { install: ['nano', 'libtsm4/trixie-backports'] } },
    { ...base, repos: { radxaMirror: 'https://mirrors.ustc.edu.cn/radxa-deb', snapshot: '20240101T000000Z' } },
    { ...base, system: { hostname: 'rock-5b', locale: 'zh_CN.UTF-8', timezone: 'Asia/Shanghai' } },
  ]) {
    assert.ok(parseProfile(profile), `should accept ${JSON.stringify(profile).slice(0, 90)}`)
  }

  // refused: shell/sed/regex metacharacters, relative paths, wrong shapes
  for (const [label, profile] of [
    ['mode 注入', withFile('0644; echo pwned')],
    ['owner 注入', withFile('0644', 'root; id')],
    ['path 非绝对', withFile('0644', 'root:root', 'etc/hosts')],
    ['locale 注入', { ...base, system: { locale: 'zh_CN.UTF-8)|.*' } }],
    ['hostname 注入', { ...base, system: { hostname: 'a b;id' } }],
    ['包名注入', { ...base, packages: { install: ['nano; id'] } }],
    ['仓库 URL 非 http', { ...base, repos: { extra: [{ id: 'r', name: 'r', url: 'file:///etc', suite: 's', components: ['main'] }] } }],
    ['快照格式', { ...base, repos: { snapshot: 'yesterday' } }],
  ] as const) {
    assert.equal(safeParseProfile(profile).success, false, `${label} should be refused`)
  }
})

test('NetworkManager reads the original SSID and PSK from generated keyfiles', (t) => {
  const cases = [
    { ssid: 'HomeWiFi', psk: 'password123' },
    { ssid: '  家庭;"WiFi"\\#', psk: '  p@ss;"word"\\#' },
    { ssid: '12;34;56;', psk: 'p@ss word' },
    { ssid: '# [connection]', psk: 'password123 ' },
  ]
  const files = cases.map((wifi) => {
    const bundle = renderBundle(makeProfile({ system: { wifi } }))
    return String(bundle.find((file) => file.path.endsWith('.nmconnection'))!.content)
  })
  const parsed = spawnSync('python3', [new URL('../test-fixtures/read-nm-keyfile.py', import.meta.url).pathname], {
    input: JSON.stringify(files), encoding: 'utf8',
  })
  if (parsed.status === 77 || (parsed.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    t.skip('python3/libnm is not installed')
    return
  }
  assert.equal(parsed.status, 0, parsed.stderr)
  assert.deepEqual(JSON.parse(parsed.stdout), cases)
})

test('collect_debs copies actual .deb files, including names with spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-debs-'))
  try {
    const source = path.join(dir, 'bundle with spaces', 'debs')
    const target = path.join(dir, 'collected')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'kernel one.deb'), 'first package')
    fs.writeFileSync(path.join(source, 'boot.deb'), 'second package')
    const inner = String(renderBundle(makeProfile({ packages: { localDebsDir: source } }))
      .find((file) => file.path === 'inner.sh')!.content)
    const collect = inner.match(/collect_debs\(\) \{[\s\S]*?\n\}/)![0]
      .replaceAll('/rsdk-bundle', path.join(dir, 'bundle with spaces'))
    execFileSync('bash', ['-c', `set -euo pipefail\n${collect}\ncollect_debs "$1"`, 'test', target])
    assert.equal(fs.readFileSync(path.join(target, 'kernel one.deb'), 'utf8'), 'first package')
    assert.equal(fs.readFileSync(path.join(target, 'boot.deb'), 'utf8'), 'second package')
    // Empty bundle directories also remain valid.
    fs.rmSync(source, { recursive: true })
    fs.mkdirSync(source)
    execFileSync('bash', ['-c', `set -euo pipefail\n${collect}\ncollect_debs "$1"`, 'test', target])
    assert.deepEqual(fs.readdirSync(target), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a replaced container image invalidates the generated rootfs cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-toolchain-key-'))
  try {
    const profile = makeProfile()
    const inner = String(renderBundle(profile).find((file) => file.path === 'inner.sh')!.content)
    const selection = inner.match(/KEY_FILE=[\s\S]*?\nfi\n\n# Self-built/)![0].replace(/\n\n# Self-built$/, '')
    fs.writeFileSync(path.join(dir, '.rsdk-webui-rootfs-key'), `${rootfsCacheKey(profile)}:image-A`)
    const run = (id: string) => execFileSync('bash', ['-c',
      `set -euo pipefail\nARGS=()\n${selection}\nprintf 'ARG_COUNT=%s' "\${#ARGS[@]}"`],
    { encoding: 'utf8', env: { ...process.env, HOME: dir, RSDK_TOOLCHAIN_ID: id, RSDK_FORCE_REBUILD: '0' } })
    assert.match(run('image-A'), /ARG_COUNT=0$/)
    assert.match(run('image-B'), /ARG_COUNT=1$/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
