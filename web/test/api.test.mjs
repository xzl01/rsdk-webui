import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

// Use the same bundler as Vite so browser-only import.meta.env works in Node.
const require = createRequire(fs.realpathSync(new URL('../node_modules/vite/package.json', import.meta.url)))
const { build } = require('esbuild')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-web-test-'))
await build({ entryPoints: [new URL('../src/api.ts', import.meta.url).pathname],
  outfile: path.join(dir, 'api.mjs'), bundle: true, platform: 'browser', format: 'esm',
  define: { 'import.meta.env.BASE_URL': JSON.stringify('/') } })
const originalFetch = globalThis.fetch
const originalTimer = globalThis.setTimeout
const storage = new Map([['rsdk-webui.session', JSON.stringify({ token: 'fixture-token', login: 'owner', repo: 'owner/original' })]])
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
globalThis.window = { location: { origin: 'http://fixture.local' } }
const calls = []
let runPolls = 0
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const run = (id, sha) => ({ id, head_sha: sha, status: 'completed', conclusion: 'success',
  html_url: `https://fixture/run/${id}`, head_branch: 'build/review', created_at: '2026-01-01T00:00:00Z' })
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  calls.push({ url, method: init.method ?? 'GET' })
  if (url === '/api/health') return json({}, 404)
  if (url.endsWith('/catalog.json')) return json({ products: [{ product: 'rock-pi-4c', soc: ['rk3399'],
    supported_suite: ['bookworm'], supported_edition: ['cli', 'kde'] }],
    rsdkVersion: 'fixture', image: 'fixture', socs: [], suites: ['bookworm'], editions: ['cli', 'kde'] })
  if (url.endsWith('/boards.json')) return json({ generatedAt: 'fixture', combos: {
    'rock-pi-4c|bookworm|cli': { status: 'test', missing: ['linux-image-rock-pi-4c'], hint: '需要测试源' },
    'rock-pi-4c|bookworm|kde': { status: 'broken', missing: ['desktop-missing'] },
  } })
  if (url.endsWith('/rsdk-tree.json')) return json({ 'rootfs.jsonnet': 'function() {} + cleanup()' })
  if (url.endsWith('/pkgindex/bookworm.json.gz')) return new Response(gzipSync(JSON.stringify([
    'task-rock-pi-4c', 'u-boot-rock-pi-4c', 'linux-image-rock-pi-4c', 'linux-headers-rock-pi-4c',
  ].map((n) => ({ n, v: '1', a: 'arm64', s: '', d: '', radxa: true, t: 1 })))))
  if (url.includes('/actions/workflows/build.yml/runs?')) {
    runPolls++
    return json({ workflow_runs: runPolls === 1 ? [run(42, 'old-commit')] : [run(42, 'old-commit'), run(43, 'new-commit')] })
  }
  if (url.endsWith('/actions/runs/43/jobs')) return json({ jobs: [] })
  if (url.endsWith('/actions/runs/43/artifacts')) return json({ artifacts: [] })
  if (url.endsWith('/actions/runs/43')) return json(run(43, 'new-commit'))
  if (url.includes('/git/ref/')) return json({ object: { sha: 'old-commit' } })
  if (url.includes('/git/blobs')) return json({ sha: 'blob' })
  if (url.includes('/git/trees')) return json({ sha: 'tree' })
  if (url.includes('/git/commits')) return json({ sha: 'new-commit' })
  if (url.includes('/git/refs/')) return new Response(null, { status: 204 })
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ default_branch: 'main' })
  throw new Error(`Unexpected mocked request: ${url}`)
}
const module = await import(path.join(dir, 'api.mjs'))
await module.detectMode()
module.loadStoredSession()
const profile = await module.api.newProfile('rock-pi-4c')
profile.id = 'review'
profile.backend.repo = 'owner/selected'
after(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalTimer
  delete globalThis.localStorage
  delete globalThis.window
  fs.rmSync(dir, { recursive: true, force: true })
})

test('enabling the suggested test source completes the static preflight', async () => {
  const stable = await module.api.preflight(profile)
  assert.equal(stable.suggestTestRepo, true)
  assert.equal(stable.verified, true, 'deployment verdict is a completed check, not a missing index')
  profile.repos.testRepo = true
  const testing = await module.api.preflight(profile)
  assert.deepEqual(testing.missing, [])
  assert.equal(testing.suggestTestRepo, false)
  assert.ok(testing.repos.length > 0)
  const desktop = await module.api.preflight({ ...profile, target: { ...profile.target, edition: 'kde' } })
  assert.deepEqual(desktop.missing, ['desktop-missing'])
})

test('build submission uses the profile repo and waits for the pushed commit', async () => {
  globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 3000 ? 1 : ms, ...args)
  const job = await module.api.startBuild(profile)
  assert.equal(job.id, '43')
  assert.equal(runPolls, 2, 'the completed run from the previous commit must be ignored')
  const writes = calls.filter((call) => ['POST', 'PATCH'].includes(call.method))
  assert.ok(writes.length > 0)
  assert.ok(writes.every((call) => call.url.startsWith('https://api.github.com/repos/owner/selected/')))
  assert.equal(module.getSession().repo, 'owner/selected')
  // Switching repositories later must still allow the previous job to be read.
  storage.set('rsdk-webui.session', JSON.stringify({ token: 'fixture-token', login: 'owner', repo: 'owner/another' }))
  module.loadStoredSession()
  const begin = calls.length
  assert.equal((await module.api.job(job.id)).id, '43')
  assert.ok(calls.slice(begin).every((call) => call.url.includes('/repos/owner/selected/')))
})
