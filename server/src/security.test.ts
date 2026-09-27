/**
 * The API can read build profiles (Wi-Fi PSK, password hashes) and start builds
 * that execute arbitrary shell. It must only ever answer the UI we serve.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.RSDK_WEBUI_NO_LISTEN = '1'
process.env.RSDK_WEBUI_LOG = 'silent'

const { buildServer } = await import('./index.ts')
const app = await buildServer()

before(() => {
  assert.ok(app)
})

after(async () => {
  await app.close()
})

test('a third-party page cannot reach the API', async () => {
  for (const method of ['POST', 'PUT', 'DELETE'] as const) {
    const res = await app.inject({
      method,
      url: '/api/jobs/some-id/cancel',
      headers: { origin: 'https://evil.example' },
      payload: method === 'POST' ? {} : undefined,
    })
    assert.equal(res.statusCode, 403, `${method} should be refused`)
    assert.match(res.json<{ error: string }>().error, /not allowed/)
  }
  // ...including a "simple" request, which the browser sends with no preflight
  const simple = await app.inject({
    method: 'POST',
    url: '/api/jobs/some-id/cancel',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    payload: 'x',
  })
  assert.equal(simple.statusCode, 403)
  assert.equal(simple.headers['access-control-allow-origin'], undefined)
})

test('the UI served by this process is allowed (same origin, Origin header set)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs/nope/cancel',
    headers: { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' },
    payload: {},
  })
  // the route itself answers 200 {cancelled:false}; what matters is that the
  // origin guard let it through
  assert.notEqual(res.statusCode, 403)
})

test('the vite dev server origin is allowed, with a preflight', async () => {
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/builds',
    headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'POST' },
  })
  assert.equal(preflight.statusCode, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://127.0.0.1:5173')
  assert.match(String(preflight.headers['access-control-allow-methods']), /POST/)
})

test('requests without an Origin (curl) still work', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, version: '0.1.0' })
})
