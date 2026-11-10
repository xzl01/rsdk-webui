import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 引擎探测的夹具：每个测试进程自己造一份 PATH，不碰宿主容器。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-env-'))
const bin = path.join(temp, 'bin')
fs.mkdirSync(bin)
process.env.RSDK_WEBUI_DATA = path.join(temp, 'data')
process.env.RSDK_WEBUI_ENGINE = ''
delete process.env.RSDK_WEBUI_ENGINE
process.env.RSDK_TEST_DIR = temp
process.env.PATH = `${bin}:${process.env.PATH}`

const executable = (name: string, source: string) =>
  fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 })

// 真实 docker 的 info 模板里没有 .Host 字段，遇到 podman 专用模板会渲染失败退出 1，
// 但普通 `docker info` 是通的（守护进程可用）。
executable('docker', `#!/bin/bash
printf '%s\\n' "$*" >> "$RSDK_TEST_DIR/docker-calls"
case "$*" in
  '--version') echo 'Docker version 29.9.2, build a82e528';;
  'info --format {{.Host.Security.Rootless}}')
    echo 'template: :1:7: executing "" at <.Host.Security.Rootless>: can'"'"'t evaluate field Host in type system.dockerInfo' >&2
    exit 1;;
  'info') exit 0;;
esac
`)

// podman 认得同一个模板，并且顺带把 rootless 标志打印出来。
executable('podman', `#!/bin/bash
printf '%s\\n' "$*" >> "$RSDK_TEST_DIR/podman-calls"
case "$*" in
  '--version') echo 'podman version 5.2.0';;
  'info'*) echo true;;
esac
`)

after(() => fs.rmSync(temp, { recursive: true, force: true }))

const { detectEngine, engineStatus } = await import('./env.ts')

test('docker 引擎在 info 模板不兼容时仍然可用', async () => {
  const engine = await detectEngine(true, 'docker')
  assert.ok(engine, 'docker 已安装且 `docker info` 可通，必须被选中')
  assert.equal(engine.kind, 'docker')
  const status = await engineStatus('docker')
  assert.equal(status.ok, true)
  assert.equal(status.error, undefined)
  const calls = fs.readFileSync(path.join(temp, 'docker-calls'), 'utf8')
  assert.match(calls, /^info$/m, 'docker 应该用不带 podman 模板的 info 探测')
})

test('podman 探测仍走带 rootless 标志的 info 模板', async () => {
  const engine = await detectEngine(true, 'podman')
  assert.ok(engine)
  assert.equal(engine.kind, 'podman')
  const calls = fs.readFileSync(path.join(temp, 'podman-calls'), 'utf8')
  assert.match(calls, /info --format \{\{\.Host\.Security\.Rootless\}\}/)
})
