import fs from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import {
  newProfile,
  normalizeForProduct,
  renderRsdkArgs,
  bootloaderPrefix,
  requiredKernelPackages,
  safeParseProfile,
  socList,
  type EnvStatus,
  type Profile,
} from '@rsdk-webui/shared'
import { config, ensureDirs } from './config.ts'
import { findProduct, getCatalog, invalidateCatalog } from './catalog.ts'
import { buildTreeStatus, ensureBuildTree, type BuildTree } from './rsdkTree.ts'
import { engineStatus, ghStatus, imageStatus } from './env.ts'
import { previewBundle } from './bundle.ts'
import {
  cancelJob,
  readLog,
  reconcileJobsOnStartup,
  startFetchImage,
  startGhaBuild,
  startLocalBuild,
} from './jobs.ts'
import {
  deleteProfile,
  getJob,
  getProfile,
  listJobs,
  listProfiles,
  newJob,
  saveProfile,
  updateJob,
} from './store.ts'
import { buildIndex, indexKey, readIndexMeta, searchPackages } from './packages.ts'
import { analyseLocalPackages, preflight } from './preflight.ts'
import { downloadGhaArtifacts, repoStatus, setupRepo } from './backends/gha.ts'

const webRoot = path.resolve(import.meta.dirname, '../../web/dist')

export async function buildServer() {
  ensureDirs()
  const recovered = await reconcileJobsOnStartup().catch(() => ({ adopted: 0, orphaned: 0 }))
  const app = Fastify({ logger: { level: process.env.RSDK_WEBUI_LOG ?? 'info' } })
  if (recovered.adopted > 0 || recovered.orphaned > 0) {
    app.log.info({ ...recovered }, 'recovered jobs from a previous run')
  }

  // -------------------------------------------------------------------------
  // origin guard
  //
  // This process can read build profiles (which may contain a Wi-Fi PSK or a
  // password hash) and start builds that run arbitrary shell in a container.
  // It must therefore only ever answer the UI that we serve ourselves.
  //
  // In production the UI is served from this same origin, and in development
  // Vite proxies /api, so cross-origin access is never needed. Anything else is
  // refused outright - including "simple" cross-origin POSTs, which the browser
  // sends *without* a preflight and which would otherwise execute here even
  // though the attacker cannot read the reply.
  // -------------------------------------------------------------------------
  const allowedOrigins = new Set(
    (process.env.RSDK_WEBUI_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    // browsers send Origin on every non-GET request, including same-origin
    // ones, so "our own origin" has to be allowed explicitly
    const host = request.headers.host
    const sameOrigin = !!host && (origin === `http://${host}` || origin === `https://${host}`)
    if (origin && !sameOrigin && !allowedOrigins.has(origin)) {
      request.log.warn({ origin, url: request.url }, 'rejected cross-origin request')
      return reply.code(403).send({ error: `origin ${origin} is not allowed` })
    }
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Headers', 'Content-Type')
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
    if (request.method === 'OPTIONS') return reply.code(204).send()
  })

  // -------------------------------------------------------------------------
  // environment
  // -------------------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }))

  app.get('/api/env', async (): Promise<EnvStatus> => {
    const [engine, image, initialTree, gh] = await Promise.all([
      engineStatus(),
      imageStatus().catch(() => ({ ref: config.image, present: false })),
      buildTreeStatus().catch(
        (err): BuildTree => ({ ready: false, path: '', error: String(err instanceof Error ? err.message : err) }),
      ),
      ghStatus(),
    ])
    // only go back to the engine if we have neither a cached tree nor one on disk
    const tree = initialTree.ready ? initialTree : await buildTreeStatus(true).catch(() => initialTree)
    return {
      server: { version: '0.1.0', dataDir: config.dataDir },
      engine,
      image,
      buildTree: {
        ready: !!tree.ready,
        path: tree.path ?? '',
        rsdkVersion: tree.rsdkVersion,
        anchorOk: tree.anchorOk,
        error: tree.error,
      },
      gh,
    }
  })

  app.post('/api/env/refresh', async () => {
    invalidateCatalog()
    const [engine, image, tree, gh] = await Promise.all([
      engineStatus(),
      imageStatus(),
      ensureBuildTree(true).catch(
        (err): BuildTree => ({ ready: false, path: '', error: String(err instanceof Error ? err.message : err) }),
      ),
      ghStatus(),
    ])
    invalidateCatalog()
    return { engine, image, tree, gh }
  })

  app.post('/api/setup/fetch-image', async (request, reply) => {
    // 镜像导入（podman load）与构建（podman run）同样争抢存储锁：构建进行中
    // 就不要开始导入，免得两边一起报"镜像消失"
    const busy = listJobs().find(
      (j) => j.backend === 'local-docker' && (j.status === 'running' || j.status === 'queued'),
    )
    if (busy) {
      return reply.code(409).send({ error: `本地构建 ${busy.id} 进行中，导入镜像会争抢容器存储锁，请等它结束`, jobId: busy.id })
    }
    const job = await startFetchImage()
    return { jobId: job.id }
  })

  // -------------------------------------------------------------------------
  // github actions repository (the user's own fork / template copy)
  // -------------------------------------------------------------------------

  app.get('/api/gh/repo', async (request) => {
    const repo = (request.query as { repo?: string }).repo ?? ''
    if (!repo) return { error: 'repo query parameter required' }
    return repoStatus(repo)
  })

  app.post('/api/gh/repo/setup', async (request, reply) => {
    const { repo, create, isPrivate } = request.body as { repo?: string; create?: boolean; isPrivate?: boolean }
    if (!repo) return reply.code(400).send({ error: 'repo required' })
    const lines: string[] = []
    try {
      const result = await setupRepo(repo, { create, isPrivate }, (line) => lines.push(line))
      return { ...result, log: lines }
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err), log: lines })
    }
  })

  // -------------------------------------------------------------------------
  // catalog
  // -------------------------------------------------------------------------

  app.get('/api/catalog', async (request, reply) => {
    try {
      return await getCatalog()
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  app.get('/api/catalog/new-profile', async (request, reply) => {
    try {
      const { product } = request.query as { product?: string }
      const catalog = await getCatalog()
      const selected = product
        ? catalog.products.find((p) => p.product === product)
        : catalog.products.find((p) => p.product === 'rock-5b') ?? catalog.products[0]
      const env = await engineStatus()
      return newProfile({ product: selected, image: config.image, engine: env.kind === 'docker' ? 'docker' : 'podman' })
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) })
    }
  })

  // -------------------------------------------------------------------------
  // profiles
  // -------------------------------------------------------------------------

  app.get('/api/profiles', async () => listProfiles())

  app.get('/api/profiles/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const profile = getProfile(id)
    if (!profile) return reply.code(404).send({ error: 'not found' })
    return profile
  })

  app.put('/api/profiles/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = safeParseProfile({ ...(request.body as object), id })
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues })
    }
    const product = await findProduct(parsed.data.target.product).catch(() => undefined)
    return saveProfile(normalizeForProduct(parsed.data, product))
  })

  app.delete('/api/profiles/:id', async (request) => {
    const { id } = request.params as { id: string }
    return { deleted: deleteProfile(id) }
  })

  // -------------------------------------------------------------------------
  // preview / render
  // -------------------------------------------------------------------------

  app.post('/api/render', async (request, reply) => {
    const parsed = safeParseProfile(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues })
    const profile = parsed.data
    const env = await engineStatus()
    return {
      files: previewBundle(profile).map(serialiseFile),
      command: `rsdk ${renderRsdkArgs(profile).join(' ')}`,
      env,
    }
  })

  // -------------------------------------------------------------------------
  // preflight + crypto helpers
  // -------------------------------------------------------------------------

  app.post('/api/preflight', async (request, reply) => {
    const parsed = safeParseProfile(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues })
    const product = await findProduct(parsed.data.target.product).catch(() => undefined)
    return preflight(parsed.data, product, (request.query as { force?: string }).force === '1')
  })

  /**
   * Analyse the .deb files a profile brings along: which of the packages the
   * build will ask for they actually provide, and what is still coming from the
   * repositories. Cheap (no network), so the package step can call it as the
   * user types.
   */
  app.post('/api/debs/inspect', async (request, reply) => {
    const parsed = safeParseProfile(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues })
    const product = await findProduct(parsed.data.target.product).catch(() => undefined)
    const required = requiredKernelPackages(parsed.data, product)
    return { required, bootloaderPrefix: bootloaderPrefix(product), report: await analyseLocalPackages(parsed.data, required) }
  })

  // -------------------------------------------------------------------------
  // builds
  // -------------------------------------------------------------------------

  app.get('/api/jobs', async () => listJobs().map(stripHeavy))

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const job = getJob(id)
    if (!job) return reply.code(404).send({ error: 'not found' })
    return stripHeavy(job)
  })

  app.post('/api/builds', async (request, reply) => {
    const body = request.body as { profile?: Profile; profileId?: string; dryRun?: boolean }
    let profile = body.profile
    if (!profile && body.profileId) profile = getProfile(body.profileId)
    if (!profile) return reply.code(400).send({ error: 'profile or profileId required' })

    const parsed = safeParseProfile(profile)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid profile', issues: parsed.error.issues })
    const p = parsed.data
    saveProfile(p)

    // one build per profile at a time: they share a bundle directory (which is
    // what makes rootfs.tar caching work) and a container name
    const running = listJobs().find(
      (j) => (j.profileId === p.id || j.profile?.id === p.id) && (j.status === 'running' || j.status === 'queued'),
    )
    if (running) {
      return reply.code(409).send({ error: `该方案已有构建在进行中 (${running.id})`, jobId: running.id })
    }

    // local builds run `podman run` for the better part of an hour, outside the
    // serialized() queue that protects the short engine calls - two of them in
    // parallel contend on podman's storage lock and fail with "the image
    // disappeared". Only one local-engine job may run at a time; GitHub Actions
    // builds are independent repos/branches and are not affected.
    if (p.backend.kind === 'local-docker') {
      const busy = listJobs().find(
        (j) => (j.backend === 'local-docker' || j.kind === 'fetch-image') && (j.status === 'running' || j.status === 'queued'),
      )
      if (busy) {
        const what = busy.kind === 'fetch-image' ? '镜像导入' : `构建 ${busy.id}`
        return reply.code(409).send({
          error: `已有本地容器任务在进行中（${what}）—— podman 存储锁互斥，等它结束再开始新的构建`,
          jobId: busy.id,
        })
      }
    }

    if (body.dryRun) {
      const tree = await ensureBuildTree()
      return { dryRun: true, files: previewBundle(p), buildTree: tree }
    }

    const job = p.backend.kind === 'gh-actions' ? await startGhaBuild(p) : await startLocalBuild(p)
    return { jobId: job.id, job: stripHeavy(job) }
  })

  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string }
    return { cancelled: await cancelJob(id) }
  })

  app.post('/api/jobs/:id/download-gh', async (request) => {
    const { id } = request.params as { id: string }
    const dir = await downloadGhaArtifacts(id)
    return { dir }
  })

  app.get('/api/jobs/:id/log', async (request) => {
    const { id } = request.params as { id: string }
    const { offset } = request.query as { offset?: string }
    return readLog(id, Number(offset ?? 0))
  })

  /** SSE stream of the job log + status */
  app.get('/api/jobs/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string }
    const job = getJob(id)
    if (!job) return reply.code(404).send({ error: 'not found' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // SSE is written straight to the socket; Fastify must not touch the reply
    reply.hijack()

    let offset = Number((request.query as { offset?: string }).offset ?? 0)
    let timer: NodeJS.Timeout | undefined
    let closed = false

    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }

    const send = (event: string, data: unknown) => {
      if (closed) return
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const close = () => {
      stop()
      if (!closed) {
        closed = true
        reply.raw.end()
      }
    }

    const tick = () => {
      if (closed) return
      const current = getJob(id)
      if (!current) return close()

      const chunk = readLog(id, offset)
      if (chunk.text) {
        offset = chunk.offset
        send('log', { text: chunk.text, offset })
      }
      send('status', stripHeavy(current))
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        send('end', { status: current.status })
        close()
      }
    }

    request.raw.on('close', close)
    request.raw.on('error', close)

    // prime the stream, then poll; log files are small and this keeps the whole
    // thing stateless (a reconnecting client just passes its offset again)
    tick()
    timer = setInterval(tick, 700)
  })

  /** raw artifact download */
  app.get('/api/jobs/:id/files/*', async (request, reply) => {
    const { id } = request.params as { id: string; '*': string }
    const job = getJob(id)
    if (!job?.dir) return reply.code(404).send({ error: 'not found' })
    const rel = (request.params as Record<string, string>)['*']
    const root = path.resolve(job.dir)
    const target = path.resolve(root, rel)
    // `startsWith` alone would let /a/bc through when the root is /a/b
    const inside = path.relative(root, target)
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return reply.code(400).send({ error: 'invalid path' })
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      return reply.code(404).send({ error: 'not found' })
    }
    // 词法检查不解析符号链接：构建产物目录里可能有指向宿主任意文件的链接
    // （自定义脚本/overlay 造的）。realpath 之后再确认一次才允许读。
    const realRoot = fs.realpathSync(root)
    const realTarget = fs.realpathSync(target)
    if (realTarget !== realRoot && path.relative(realRoot, realTarget).startsWith('..')) {
      return reply.code(400).send({ error: 'invalid path' })
    }
    reply.header('Content-Disposition', `attachment; filename="${path.basename(target).replace(/["\\\r\n]/g, '_')}"`)
    return reply.send(fs.createReadStream(realTarget))
  })

  // -------------------------------------------------------------------------
  // package index
  // -------------------------------------------------------------------------

  app.get('/api/packages/index-status', async (request) => {
    const { product, suite } = request.query as { product?: string; suite?: string }
    if (!suite) return { exists: false }
    const p = product ? await findProduct(product).catch(() => undefined) : undefined
    const key = indexKey(suite, socList(p))
    return { key, meta: readIndexMeta(key) }
  })

  app.post('/api/packages/index', async (request, reply) => {
    const { product, suite } = request.body as { product?: string; suite?: string }
    if (!suite) return reply.code(400).send({ error: 'suite required' })
    const p = product ? await findProduct(product).catch(() => undefined) : undefined
    const key = indexKey(suite, socList(p))
    const existing = readIndexMeta(key)
    if (existing && !(request.body as { force?: boolean }).force) {
      return { key, meta: existing, cached: true }
    }
    const job = newJob({
      id: `pkgindex-${key}-${Date.now().toString(36)}`,
      kind: 'packages-index',
      title: `建立 ${suite} 软件包索引`,
      backend: 'internal',
    })
    updateJob(job.id, { status: 'running', startedAt: Date.now() })
    const log = (line: string) => fs.appendFileSync(job.logPath, line + '\n')
    void buildIndex(p, suite, log)
      .then((meta) => {
        updateJob(job.id, { status: 'succeeded', finishedAt: Date.now(), steps: [{ name: `${meta.count} 个软件包`, at: Date.now() }] })
      })
      .catch((err) => {
        log(`错误: ${String(err)}`)
        updateJob(job.id, { status: 'failed', finishedAt: Date.now(), error: String(err) })
      })
    return { key, jobId: job.id }
  })

  app.get('/api/packages/search', async (request) => {
    const { q, suite, product, limit } = request.query as Record<string, string | undefined>
    if (!suite) return { meta: null, hits: [] }
    const p = product ? await findProduct(product).catch(() => undefined) : undefined
    const key = indexKey(suite, socList(p))
    // 封顶：limit=100000 不该把整份 64k 条目的索引一次吐回去
    const capped = Math.min(500, Math.max(1, Number(limit ?? 60) || 60))
    return { key, ...searchPackages(key, q ?? '', capped) }
  })

  // -------------------------------------------------------------------------
  // static web app
  // -------------------------------------------------------------------------

  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  } else {
    app.get('/', async () => ({
      message: 'web/dist not built yet - run `pnpm -F @rsdk-webui/web dev` for the dev server, or `pnpm build` first',
    }))
  }

  return app
}

/** JSON-safe view of a generated bundle file */
function serialiseFile(file: { path: string; content: string | Uint8Array; mode: number }) {
  if (typeof file.content === 'string') return { ...file, binary: false }
  return {
    path: file.path,
    mode: file.mode,
    content: `<binary, ${file.content.byteLength} bytes>`,
    binary: true,
  }
}

function stripHeavy<T extends { profile?: Profile; logPath?: string }>(job: T) {
  const { profile, logPath, ...rest } = job
  return { ...rest, profileName: profile?.meta.name, profileId: profile?.id }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

if (process.env.RSDK_WEBUI_NO_LISTEN !== '1') {
  // 这个 API 没有认证（profile 里可能存着 Wi-Fi PSK 与密码哈希），安全性完全
  // 押在"只听回环"上。非回环绑定必须是显式决定，而不是一个 env 变顺手改的。
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && process.env.RSDK_WEBUI_ALLOW_REMOTE !== '1') {
    console.error(
      `拒绝启动：RSDK_WEBUI_HOST=${config.host} 会把这个无认证的 API 暴露给网络\n` +
        `（任何同网段主机都能读到 profile 内容、启动容器构建）。\n` +
        `确实需要远程访问时，设置 RSDK_WEBUI_ALLOW_REMOTE=1 并自行承担风险。`,
    )
    process.exit(1)
  }
  const app = await buildServer()
  try {
    await app.listen({ host: config.host, port: config.port })
    app.log.info(`rsdk-webui ready on http://${config.host}:${config.port}`)
    app.log.info(`data dir: ${config.dataDir}`)
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      app.log.warn(`绑定在 ${config.host} 上，API 无认证 —— 已由 RSDK_WEBUI_ALLOW_REMOTE=1 确认`)
    }
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
