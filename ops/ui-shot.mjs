#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ops/ui-shot.mjs - headless screenshot of the rsdk-webui SPA.
//
// Plain Node (no deps): drives Chrome over the DevTools Protocol so we can wait
// for the app to actually finish loading, run a few steps, and only then take
// the picture.
//
//   node ops/ui-shot.mjs <url> <out.png> [options]
//
//   --wait "<js>"        wait until this expression is truthy (repeatable)
//   --eval "<js>"        run after --wait, before capture (repeatable)
//   --timeout <ms>       overall timeout for the waits (default 30000)
//   --width/--height     viewport size (default 1680x1050)
//   --port <n>           debug port (default 9333)
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const url = args.shift()
const out = args.shift() ?? '/tmp/ui.png'

// --wait and --eval are kept in the order given: "click, then wait for the
// result, then click again" has to behave that way.
const opt = { steps: [], timeout: 30_000, width: 1680, height: 1050, port: 9333, dump: false }
while (args.length) {
  const flag = args.shift()
  switch (flag) {
    case '--wait': opt.steps.push({ kind: 'wait', value: args.shift() }); break
    case '--eval': opt.steps.push({ kind: 'eval', value: args.shift() }); break
    case '--timeout': opt.timeout = Number(args.shift()); break
    case '--width': opt.width = Number(args.shift()); break
    case '--height': opt.height = Number(args.shift()); break
    case '--port': opt.port = Number(args.shift()); break
    case '--dump': opt.dump = true; break
    case '--scheme': opt.scheme = args.shift(); break
    default: throw new Error(`unknown flag ${flag}`)
  }
}
if (!url) throw new Error('usage: ui-shot.mjs <url> <out.png> [--wait js] [--eval js] ...')

const chromeBin = process.env.CHROME ?? 'google-chrome-stable'

/**
 * 静态模式要访问 api.github.com：直连不通时必须走代理，否则请求会一直挂着，
 * 界面停在半路，测出来的结果就不作数。但如果代理端口没在监听，硬加
 * --proxy-server 反而把本来直连能通的站点也弄坏，所以先探测端口。
 */
function proxyArgs() {
  const raw = process.env.PROXY ?? 'http://127.0.0.1:7897'
  try {
    const url = new URL(raw)
    const probe = spawnSync('bash', [
      '-c',
      `timeout 2 bash -c '</dev/tcp/${url.hostname}/${url.port}' 2>/dev/null`,
    ])
    if (probe.status !== 0) return []
    return [`--proxy-server=${raw}`, '--proxy-bypass-list=localhost;127.0.0.1']
  } catch {
    return []
  }
}
const profile = fs.mkdtempSync('/tmp/ui-shot-profile-')

const chrome = spawn(
  chromeBin,
  [
    '--remote-debugging-port=' + opt.port,
    '--headless=new',
    ...proxyArgs(),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${opt.width},${opt.height}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function debuggerUrl() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${opt.port}/json/version`)
      const json = await res.json()
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('chrome did not expose a debugging endpoint')
}

function cdp(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
      else resolve(msg.result)
    }
  })
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const messageId = ++id
      pending.set(messageId, { resolve, reject })
      ws.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
}

let exitCode = 0
try {
  const ws = new WebSocket(await debuggerUrl())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = cdp(ws)

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Emulation.setDeviceMetricsOverride', {
    width: opt.width,
    height: opt.height,
    deviceScaleFactor: 1,
    mobile: false,
  }, sessionId)
  if (opt.scheme) {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: opt.scheme }],
    }, sessionId)
  }
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  // surface page errors instead of silently screenshotting a blank app
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      console.error('page error:', msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params?.type)) {
      console.error(`console.${msg.params.type}:`, msg.params.args?.map((a) => a.value ?? a.description).join(' '))
    }
  })
  await send('Page.navigate', { url }, sessionId)

  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (result.exceptionDetails) throw new Error(`eval failed: ${result.exceptionDetails.text}`)
    return result.result.value
  }

  // let the bundle boot
  for (let i = 0; i < 40; i++) {
    if (await evalJs('!!document.querySelector("#root > *")').catch(() => false)) break
    await sleep(150)
  }

  for (const step of opt.steps) {
    if (step.kind === 'wait') {
      const deadline = Date.now() + opt.timeout
      for (;;) {
        const ok = await evalJs(`(() => { try { return !!(${step.value}) } catch (e) { return false } })()`).catch(
          () => false,
        )
        if (ok) break
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${step.value}`)
        await sleep(200)
      }
    } else {
      const value = await evalJs(`(() => { ${step.value} })()`)
      if (value !== undefined) console.error('eval ->', JSON.stringify(value))
      await sleep(350)
    }
  }

  if (opt.dump) {
    const text = await evalJs('document.body.innerText')
    console.error('--- body text ---\n' + text)
  }
  await sleep(400)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.error(`wrote ${out}`)
} catch (err) {
  console.error(`error: ${err.message}`)
  exitCode = 1
} finally {
  try {
    process.kill(-chrome.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(exitCode)
