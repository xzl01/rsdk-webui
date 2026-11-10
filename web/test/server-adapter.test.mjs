import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 适配器始终以 application/json 提交,而 Fastify 会拒绝空 body,
// 因此所有写请求都必须带上一个 JSON body(路径里已有 id 时就是 {})。
const require = createRequire(fs.realpathSync(new URL('../node_modules/vite/package.json', import.meta.url)))
const { build } = require('esbuild')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-adapter-test-'))
await build({
  entryPoints: [new URL('../src/adapters/server.ts', import.meta.url).pathname],
  outfile: path.join(dir, 'server.mjs'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
})
const { ServerBackend } = await import(path.join(dir, 'server.mjs'))

const sent = []
globalThis.fetch = async (input, init = {}) => {
  sent.push({ url: String(input), method: init.method ?? 'GET', body: init.body })
  return new Response(
    JSON.stringify({ cancelled: true, dir: '/tmp/x', jobId: 'job-1', ok: true, engine: { ok: true } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const backend = new ServerBackend()
await backend.cancelJob('b-1')
await backend.downloadGha('b-1')
await backend.fetchImage()
await backend.refreshEnv()
await backend.deleteProfile('p-1')
await backend.job('b-1')

test('写请求即使没有参数也提交空 JSON body', () => {
  const writes = sent.filter((s) => s.method !== 'GET')
  assert.equal(writes.length, 5)
  for (const w of writes) {
    assert.equal(w.body, '{}', `${w.method} ${w.url} 必须带 body`)
  }
})

test('GET 不携带 body', () => {
  for (const g of sent.filter((s) => s.method === 'GET')) {
    assert.equal(g.body, undefined, `GET ${g.url} 不应有 body`)
  }
})
