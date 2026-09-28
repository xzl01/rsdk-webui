import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProfileSchema } from '@rsdk-webui/shared'

// All engine, git and GitHub commands below are fixtures; no host containers or
// external repositories are changed. Each test process has its own data store.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-functional-'))
const bin = path.join(temp, 'bin')
fs.mkdirSync(bin)
process.env.RSDK_WEBUI_DATA = path.join(temp, 'data')
process.env.RSDK_WEBUI_NO_LISTEN = '1'
process.env.RSDK_WEBUI_LOG = 'silent'
process.env.RSDK_WEBUI_ENGINE = 'podman'
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.RSDK_TEST_DIR = temp
const executable = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 })
executable('git', `#!/bin/bash
printf '%s\\n' "$*" >> "$RSDK_TEST_DIR/git-calls"
case "$*" in
  'rev-parse HEAD') echo new-commit;;
  'remote get-url origin') exit 1;;
esac
`)
executable('gh', `#!/bin/bash
printf '%s\\n' "$*" >> "$RSDK_TEST_DIR/gh-calls"
case "$*" in
  'auth token') echo fixture-token;;
  'auth status'*) echo '{"hosts":{"github.com":[{"login":"owner"}]}}';;
  'repo view'*) echo '{"isPrivate":false,"isFork":false,"defaultBranchRef":{"name":"main"},"url":"https://fixture/repo","viewerPermission":"ADMIN"}';;
  *'/actions/permissions') echo '{"enabled":true}';;
  *'/contents/.github/workflows/build.yml'*) echo workflow-sha;;
  *'--jq .has_pages') echo false;;
  'run list'*)
    if [[ ! -f "$RSDK_TEST_DIR/polled" ]]; then
      touch "$RSDK_TEST_DIR/polled"
      echo '[{"databaseId":42,"headSha":"old-commit"}]'
    else
      echo '[{"databaseId":42,"headSha":"old-commit"},{"databaseId":43,"headSha":"new-commit","url":"https://fixture/run/43"}]'
    fi;;
  *'--log') sleep 1; echo 'FINAL LOG AFTER REMOTE COMPLETION';;
  'run view'*) echo '{"databaseId":43,"status":"completed","conclusion":"success","url":"https://fixture/run/43","headBranch":"build/review","headSha":"new-commit","createdAt":"2026-01-01T00:00:00Z"}';;
  *'/jobs') echo '{"jobs":[]}';;
  *'/artifacts') echo '{"artifacts":[{"name":"image","size_in_bytes":7}]}';;
  *) echo "Unexpected fixture command: $*" >&2; exit 1;;
esac
`)
// Export a small, distinguishable tree from each image.
for (const kind of ['docker', 'podman']) {
  executable(kind, `#!/bin/bash
printf '%s\\n' "${kind} $*" >> "$RSDK_TEST_DIR/engine-calls"
case "$*" in
  '--version') echo '${kind} fixture';;
  'info'*) echo true;;
  'images'*) echo 'custom/toolchain:review|custom123456789012|1MB|today'
             echo 'rsdk-image:latest|default123456789|1MB|today';;
  *'--entrypoint dpkg-query'*) echo fixture-version;;
  *'--entrypoint tar'*) tar -cf - -C "$RSDK_TEST_DIR/tree" build configs;;
  'ps'*) echo '';;
  'rm'*) exit 0;;
  'run'*)
    if [[ "$*" == *'/rsdk-bundle/run.sh'* || "$*" == *'/rsdk-bundle/inner.sh'* ]]; then
      mkdir -p "$RSDK_TEST_WORK/out/product"
      echo 'local image contents' > "$RSDK_TEST_WORK/out/product/output.img"
    fi;;
  *) echo "Unexpected fixture engine command: $*" >&2; exit 1;;
esac
`)
}
fs.mkdirSync(path.join(temp, 'tree', 'build'), { recursive: true })
fs.mkdirSync(path.join(temp, 'tree', 'configs'))
fs.writeFileSync(path.join(temp, 'tree', 'build', 'rootfs.jsonnet'), 'function() {} + cleanup()\n')
const { config } = await import('./config.ts')
const { newJob, updateJob, getJob } = await import('./store.ts')
const { listArtifacts, writeBundle } = await import('./bundle.ts')
const { cancelJob, startLocalBuild, reconcileJobsOnStartup } = await import('./jobs.ts')
const { runGhaBuild, watchRun } = await import('./backends/gha.ts')
const { buildServer } = await import('./index.ts')
const app = await buildServer()
const address = await app.listen({ host: '127.0.0.1', port: 0 })
after(async () => { await app.close(); fs.rmSync(temp, { recursive: true, force: true }) })
const localProfile = ProfileSchema.parse({ id: 'local-review', meta: { name: 'review' },
  target: { product: 'rock-pi-4c', suite: 'bookworm', edition: 'cli' },
  backend: { kind: 'local-docker', engine: 'docker', image: 'custom/toolchain:review' } })

test('local bundles use the chosen engine, image and image-specific build tree', async () => {
  const defaultTree = path.join(config.rsdkTreesDir, 'old-default')
  fs.mkdirSync(path.join(defaultTree, 'build'), { recursive: true })
  fs.writeFileSync(path.join(defaultTree, 'build', 'rootfs.jsonnet'), 'DEFAULT TREE + cleanup()')
  fs.writeFileSync(path.join(defaultTree, 'meta.json'), JSON.stringify({ image: config.image }))
  const dir = path.join(temp, 'bundle')
  const result = await writeBundle(localProfile, dir)
  assert.ok(result.treeDir.endsWith('custom123456789012'.slice(0, 16)))
  assert.ok(!fs.readFileSync(path.join(dir, 'rsdk-build', 'rootfs.jsonnet'), 'utf8').includes('DEFAULT TREE'))
  const hostEnv = fs.readFileSync(path.join(dir, 'host.env'), 'utf8')
  assert.match(hostEnv, /RSDK_ENGINE:=docker/)
  assert.match(hostEnv, /RSDK_IMAGE=custom\/toolchain:review/)
  assert.ok(!hostEnv.includes('--userns=keep-id'), 'Docker must not inherit Podman options')
  const env = await app.inject({ url: '/api/env?engine=docker&image=custom%2Ftoolchain%3Areview' })
  assert.equal(env.statusCode, 200)
  assert.equal(env.json().engine.kind, 'docker')
  assert.equal(env.json().image.present, true)
  assert.equal(env.json().image.ref, 'custom/toolchain:review')
  assert.equal(env.json().buildTree.ready, true)
})

test('concurrent environment/build probes share one image-tree extraction', async () => {
  const { detectEngine } = await import('./env.ts')
  const { ensureBuildTree } = await import('./rsdkTree.ts')
  const engine = (await detectEngine(false, 'docker'))!
  const before = fs.readFileSync(path.join(temp, 'engine-calls'), 'utf8')
    .split('\n').filter((line) => line.includes('--entrypoint tar')).length
  const [first, second] = await Promise.all([
    ensureBuildTree(true, { image: localProfile.backend.kind === 'local-docker' ? localProfile.backend.image : '', engine }),
    ensureBuildTree(true, { image: localProfile.backend.kind === 'local-docker' ? localProfile.backend.image : '', engine }),
  ])
  assert.equal(first.ready, true)
  assert.equal(second.path, first.path)
  const after = fs.readFileSync(path.join(temp, 'engine-calls'), 'utf8')
    .split('\n').filter((line) => line.includes('--entrypoint tar')).length
  assert.equal(after - before, 1)
})

test('cancelling a selected Docker job targets Docker despite the Podman host default', async () => {
  const job = newJob({ id: 'cancel-review', kind: 'build', title: 'fixture', backend: 'local-docker',
    dir: path.join(temp, 'cancel-review'), profile: localProfile })
  updateJob(job.id, { status: 'running' })
  assert.equal(await cancelJob(job.id), true)
  assert.equal(getJob(job.id)!.status, 'cancelled')
  assert.match(fs.readFileSync(path.join(temp, 'engine-calls'), 'utf8'), /docker rm -f rsdk-webui-cancel-review/)
})

test('shared working-directory artifacts are discovered, downloadable and contained', async () => {
  const dir = path.join(config.buildsDir, 'artifact-review')
  const work = path.join(config.buildsDir, '.work', 'profile')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(work, 'out', 'product'), { recursive: true })
  fs.writeFileSync(path.join(work, 'out', 'product', 'output.img'), 'generated image')
  const job = newJob({ id: 'artifact-review', kind: 'build', title: 'fixture', backend: 'local-docker', dir, workDir: work })
  const artifacts = listArtifacts(work, `/api/jobs/${job.id}/files`, true)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].path, 'out/product/output.img')
  const response = await app.inject({ url: artifacts[0].url })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body, 'generated image')
  fs.writeFileSync(path.join(temp, 'secret'), 'private')
  fs.symlinkSync(path.join(temp, 'secret'), path.join(work, 'out', 'escape.img'))
  assert.equal((await app.inject({ url: `/api/jobs/${job.id}/files/out/escape.img` })).statusCode, 400)
  const traversal = await app.inject({ url: `/api/jobs/${job.id}/files/%2E%2E%2Fsecret` })
  assert.equal(traversal.statusCode, 400)
  // A result recorded while the server was down must use the same output root.
  fs.writeFileSync(path.join(dir, '.exit-code'), '0')
  updateJob(job.id, { status: 'running' })
  await reconcileJobsOnStartup()
  assert.ok(getJob(job.id)!.artifacts!.some((artifact) => artifact.path === 'out/product/output.img'))
  // Pre-shared-work-dir bundles remain readable as well.
  const legacy = path.join(temp, 'legacy')
  fs.mkdirSync(path.join(legacy, 'work', 'out'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'work', 'out', 'old.img'), 'legacy image')
  assert.equal(listArtifacts(legacy, '/files')[0].path, 'work/out/old.img')
})

test('local runner launches the selected toolchain and lists its output', async () => {
  process.env.RSDK_TEST_WORK = path.join(config.buildsDir, '.work', localProfile.id)
  const job = await startLocalBuild(localProfile)
  for (let attempt = 0; attempt < 40 && getJob(job.id)?.status === 'running'; attempt++) await delay(100)
  const final = getJob(job.id)!
  assert.equal(final.status, 'succeeded', fs.readFileSync(final.logPath, 'utf8'))
  assert.ok(final.artifacts?.some((artifact) => artifact.name === 'output.img'))
  const commands = fs.readFileSync(path.join(temp, 'engine-calls'), 'utf8').split('\n')
  const launch = commands.find((line) => line.includes('/rsdk-bundle/inner.sh'))!
  assert.ok(launch.startsWith('docker '), launch)
  assert.ok(launch.includes('custom/toolchain:review'), launch)
  assert.ok(!launch.includes('--userns=keep-id'), launch)
  const downloaded = await app.inject({ url: final.artifacts!.find((artifact) => artifact.name === 'output.img')!.url! })
  assert.equal(downloaded.body, 'local image contents\n')
})

test('server GitHub submission ignores old runs and binds the pushed SHA', async () => {
  const profile = ProfileSchema.parse({ ...localProfile, id: 'review', backend: { kind: 'gh-actions', repo: 'owner/selected' } })
  const dir = path.join(temp, 'gh-bundle')
  fs.mkdirSync(dir)
  const job = newJob({ id: 'gh-review', kind: 'build', title: 'fixture', backend: 'gh-actions', dir, profile })
  updateJob(job.id, { status: 'running' })
  await runGhaBuild(job.id, profile, dir)
  assert.equal(getJob(job.id)!.ghRunId, 43)
  assert.equal(getJob(job.id)!.ghRepo, 'owner/selected')
  const commands = fs.readFileSync(path.join(temp, 'gh-calls'), 'utf8')
  assert.equal(commands.split('\n').filter((line) => line.startsWith('run list')).length, 2)
  assert.match(commands, /--workflow build.yml/)
  assert.match(commands, /headSha/)
})

test('SSE end arrives after final logs and artifacts have been stored', async () => {
  const dir = path.join(temp, 'sse-job')
  fs.mkdirSync(dir)
  const job = newJob({ id: 'sse-review', kind: 'build', title: 'fixture', backend: 'gh-actions', dir })
  updateJob(job.id, { status: 'running' })
  const stream = await fetch(`${address}/api/jobs/${job.id}/stream`, { signal: AbortSignal.timeout(10_000) })
  const body = stream.text()
  const watcher = watchRun(job.id, 'owner/selected', 43)
  await delay(800)
  assert.equal(getJob(job.id)!.status, 'running', 'the terminal state must wait for the delayed log command')
  const text = await body
  assert.match(text, /FINAL LOG AFTER REMOTE COMPLETION/)
  assert.match(text, /event: end/)
  assert.ok(text.indexOf('FINAL LOG') < text.indexOf('event: end'))
  const final = (await app.inject({ url: `/api/jobs/${job.id}` })).json()
  assert.equal(final.status, 'succeeded')
  assert.equal(final.artifacts.length, 1)
  await watcher
})
