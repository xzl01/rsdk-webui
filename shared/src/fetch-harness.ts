/**
 * Execute the generated `fetch-image.sh` for real.
 *
 * The local machine has `bsdtar`, GitHub runners do not - which is exactly how
 * a bug in the `ar` fallback survived until the first Actions run. So the test
 * builds a real (tiny) `.deb`, stubs `curl` and the container engine, and runs
 * the script end to end.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderFetchImageScript } from './render.ts'

export type FetchRun = {
  code: number
  stdout: string
  stderr: string
  cache: string
  /** what the stubbed engine was asked to do */
  engineCalls: string[]
  /** whether the artifact the fake deb contained is present */
  loadedImageTar: boolean
  cleanup: () => void
}

/** build a minimal but real .deb (ar archive with debian-binary/control/data) */
function makeFakeDeb(dir: string, version: string): string {
  const stage = path.join(dir, 'stage')
  fs.mkdirSync(path.join(stage, 'data', 'usr', 'share', 'rsdk-image'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'data', 'usr', 'share', 'rsdk-image', 'image.tar'), 'FAKE-IMAGE-TAR\n')
  fs.mkdirSync(path.join(stage, 'control'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'control', 'control'), 'Package: rsdk-image\nVersion: 0.1.0-1\n')
  fs.writeFileSync(path.join(stage, 'debian-binary'), '2.0\n')

  // real debs use a compressed member name (`data.tar.xz`); the script globs for
  // `data.tar.*`, so use a compressed one here too
  const dataTar = path.join(stage, 'data.tar.gz')
  const controlTar = path.join(stage, 'control.tar.gz')
  const run = (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`)
  }
  run('tar', ['-czf', dataTar, '-C', path.join(stage, 'data'), '.'], dir)
  run('tar', ['-czf', controlTar, '-C', path.join(stage, 'control'), '.'], dir)

  const deb = path.join(dir, `rsdk-image_${version}_amd64.deb`)
  run('ar', ['-q', deb, path.join(stage, 'debian-binary'), controlTar, dataTar], dir)
  return deb
}

export function runFetchImage(version = '0.1.0-1'): FetchRun {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-fetch-'))
  const cache = path.join(tmp, 'cache')
  const stubBin = path.join(tmp, 'bin')
  fs.mkdirSync(cache, { recursive: true })
  fs.mkdirSync(stubBin, { recursive: true })

  const deb = makeFakeDeb(tmp, version)
  const engineCalls: string[] = []

  // stub `curl`: pretend the network returned our fake deb / no key
  fs.writeFileSync(
    path.join(stubBin, 'curl'),
    `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
if [ -n "$out" ]; then cp "${deb}" "$out"; fi
exit 0
`,
  )

  // stub the container engine, recording what it was asked to do
  const engine = `#!/bin/sh
printf '%s\\n' "$*" >> ${path.join(tmp, 'engine-calls.txt')}
exit 0
`
  fs.writeFileSync(path.join(stubBin, 'docker'), engine)
  fs.writeFileSync(path.join(stubBin, 'podman'), engine)

  for (const file of ['curl', 'docker', 'podman']) fs.chmodSync(path.join(stubBin, file), 0o755)

  const script = path.join(tmp, 'fetch-image.sh')
  fs.writeFileSync(script, renderFetchImageScript(), { mode: 0o755 })

  const result = spawnSync('bash', [script, cache, 'rsdk-image:latest'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // our stubs first, then the real system (ar/tar/gzip needed)
      PATH: `${stubBin}:/usr/bin:/bin`,
      RSDK_ENGINE: 'docker',
      RSDK_IMAGE_VERSION: version,
      RSDK_IMAGE: 'rsdk-image:latest',
    },
  })

  const callsFile = path.join(tmp, 'engine-calls.txt')
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    cache,
    engineCalls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n') : [],
    loadedImageTar: fs.existsSync(path.join(cache, 'image.tar')),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}
