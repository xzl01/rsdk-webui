/**
 * Backend-less (GitHub Pages) adapters.
 *
 * Everything the local Fastify server does over HTTP, done from the browser
 * against api.github.com with a personal access token the user pastes in:
 *
 *   - the catalog, the jsonnet tree and the package index are static assets
 *     generated at deploy time from the same container image (`ops/emit-static-assets.sh`)
 *   - the build bundle is assembled in the browser and committed with the Git
 *     Data API, which triggers the repository's own workflow
 *   - status, step list, logs and artifacts come from the Actions API
 *
 * The token never leaves localStorage and is only ever sent to api.github.com.
 */
import {
  assembleBundle,
  isIgnoredBundlePath,
  renderGhWorkflow,
  rootfsCacheKey,
  comboKey,
  type BoardVerdicts,
  type Catalog,
  type EnvStatus,
  type PackageSearchHit,
  type Profile,
} from '@rsdk-webui/shared'
import type { Job, JobStep, RepoStatus } from './types.ts'

const API = 'https://api.github.com'

export type GhSession = {
  token: string
  login: string
  repo: string
  /** avatar/name for the header */
  name?: string
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly scopes?: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function request<T>(
  session: Pick<GhSession, 'token'> | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (session?.token) headers.Authorization = `Bearer ${session.token}`
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json'

  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, { ...init, headers })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { message?: string; errors?: unknown }
      if (body.message) detail = body.message
      if (body.errors) detail += ` (${JSON.stringify(body.errors)})`
    } catch {
      /* keep the status line */
    }
    throw new GitHubError(detail, response.status, response.headers.get('x-oauth-scopes') ?? undefined)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// static assets
// ---------------------------------------------------------------------------

let catalogCache: Catalog | null = null
let treeCache: Record<string, string> | null = null
let verdictsCache: BoardVerdicts | null = null

function asset(name: string): string {
  // assets are copied verbatim by Vite from web/public
  return new URL(`${import.meta.env.BASE_URL}${name}`, window.location.origin).toString()
}

export async function loadCatalog(): Promise<Catalog> {
  if (catalogCache) return catalogCache
  const response = await fetch(asset('catalog.json'))
  if (!response.ok) {
    throw new Error(
      `catalog.json 读取失败 (${response.status})：静态模式需要在部署时运行 ops/emit-static-assets.sh`,
    )
  }
  catalogCache = (await response.json()) as Catalog
  return catalogCache
}

/** deploy-time verdicts, or null when the site did not ship them */
export async function loadVerdicts(): Promise<BoardVerdicts | null> {
  if (verdictsCache) return verdictsCache
  const response = await fetch(asset('boards.json')).catch(() => null)
  if (!response || !response.ok) return null
  verdictsCache = (await response.json()) as BoardVerdicts
  return verdictsCache
}

export async function loadRsdkTree(): Promise<Record<string, string>> {
  if (treeCache) return treeCache
  const response = await fetch(asset('rsdk-tree.json'))
  if (!response.ok) throw new Error(`rsdk-tree.json 读取失败 (${response.status})`)
  treeCache = (await response.json()) as Record<string, string>
  return treeCache
}

/** package index: one gzipped file per suite, decompressed in the browser */
const indexCache = new Map<string, { meta: { count: number; builtAt: number }; records: SlimPackage[] }>()

type SlimPackage = {
  n: string
  v: string
  a: string
  s: string
  d: string
  radxa: boolean
  /** 1 when the package only exists in the *-test repository */
  t?: 1
}

async function loadIndex(suite: string) {
  const cached = indexCache.get(suite)
  if (cached) return cached
  const response = await fetch(asset(`pkgindex/${suite}.json.gz`))
  if (!response.ok) return null
  const stream = response.body!.pipeThrough(new DecompressionStream('gzip'))
  const records = JSON.parse(await new Response(stream).text()) as SlimPackage[]
  const entry = { meta: { count: records.length, builtAt: Date.now() }, records }
  indexCache.set(suite, entry)
  return entry
}

export const staticPackages = {
  /** the whole index for a suite, or null when the site did not ship one */
  load: loadIndex,

  async indexStatus(suite: string) {
    const body = await fetch(asset(`pkgindex/${suite}.json.gz`), { method: 'HEAD' })
    return { key: suite, meta: body.ok ? { count: -1, builtAt: 0 } : null }
  },

  async search(suite: string, query: string, limit = 60): Promise<{ meta: { count: number } | null; hits: PackageSearchHit[] }> {
    const index = await loadIndex(suite)
    if (!index) return { meta: null, hits: [] }
    const q = query.trim().toLowerCase()
    const toHit = (p: SlimPackage): PackageSearchHit => ({
      name: p.n,
      version: p.v,
      architecture: p.a,
      section: p.s,
      description: p.d,
      source: p.radxa ? (p.t === 1 ? 'radxa-deb (test)' : 'radxa-deb') : 'debian/ubuntu',
      radxa: p.radxa,
    })
    if (!q) return { meta: index.meta, hits: index.records.slice(0, limit).map(toHit) }

    const scored: Array<{ score: number; p: SlimPackage }> = []
    for (const p of index.records) {
      const name = p.n.toLowerCase()
      let score = -1
      if (name === q) score = 0
      else if (name.startsWith(q)) score = 1
      else if (name.includes(q)) score = 2
      else if (p.d.toLowerCase().includes(q)) score = 3
      if (score >= 0) scored.push({ score, p })
    }
    scored.sort((a, b) => a.score - b.score || a.p.n.localeCompare(b.p.n))
    return { meta: index.meta, hits: scored.slice(0, limit).map((s) => toHit(s.p)) }
  },
}

// ---------------------------------------------------------------------------
// session / environment
// ---------------------------------------------------------------------------

export async function verifyToken(token: string): Promise<{ login: string; scopes: string; name?: string }> {
  const user = await request<{ login: string; name?: string }>({ token }, '/user')
  // scopes are only returned for classic tokens; fine-grained ones report none
  const scopes = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.headers.get('x-oauth-scopes') ?? '')
    .catch(() => '')
  return { login: user.login, name: user.name, scopes }
}

export async function staticEnv(session: GhSession | null): Promise<EnvStatus> {
  const catalog = await loadCatalog().catch(() => null)
  const repo = session ? await repoStatus(session).catch(() => null) : null
  return {
    server: { version: 'pages', dataDir: '（浏览器 localStorage）' },
    engine: {
      kind: 'none',
      binary: '',
      version: '',
      args: [],
      runExtra: [],
      rootless: false,
      ok: false,
      error: '静态模式（GitHub Pages）不提供本地容器构建；构建由 GitHub Actions 完成',
    },
    image: { ref: catalog?.image ?? 'rsdk-image:latest', present: false },
    buildTree: {
      ready: (await loadRsdkTree().then(() => true).catch(() => false)),
      path: 'rsdk-tree.json',
      rsdkVersion: catalog?.rsdkVersion,
    },
    gh: {
      available: !!session,
      login: session?.login,
      tokenPresent: !!session,
      error: session ? undefined : '尚未连接 GitHub',
      repo: repo ?? undefined,
    },
  }
}

export async function repoStatus(session: GhSession): Promise<RepoStatus> {
  const [owner, name] = session.repo.split('/')
  const status: RepoStatus = { repo: session.repo, owner: owner ?? '', name: name ?? '', exists: false }
  if (!owner || !name) {
    status.error = '仓库格式应为 owner/name'
    return status
  }
  try {
    const info = await request<{
      private: boolean
      fork: boolean
      default_branch: string
      html_url: string
      has_pages?: boolean
      permissions?: { admin?: boolean; push?: boolean }
    }>(session, `/repos/${session.repo}`)
    status.exists = true
    status.private = info.private
    status.fork = info.fork
    status.defaultBranch = info.default_branch
    status.htmlUrl = info.html_url
    status.canAdmin = info.permissions?.admin === true
    status.hasPages = info.has_pages === true
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
    return status
  }

  const [actions, workflow] = await Promise.all([
    request<{ enabled?: boolean; allowed_actions?: string }>(session, `/repos/${session.repo}/actions/permissions`).catch(
      () => null,
    ),
    request<{ sha: string }>(session, `/repos/${session.repo}/contents/.github/workflows/build.yml?ref=${status.defaultBranch}`)
      .then(() => true)
      .catch(() => false),
  ])
  status.actionsEnabled = actions ? actions.enabled !== false : undefined
  status.workflowOnDefaultBranch = workflow
  status.needsManualActionEnable = status.exists && status.actionsEnabled === false && status.canAdmin !== true
  return status
}

/** Commit the workflow + README to the default branch (never force-pushes). */
export async function prepareRepo(session: GhSession, isPrivate = true): Promise<{
  created: boolean
  pushedWorkflow: boolean
  actionsEnabled: boolean | null
  pagesEnabled: boolean | null
  status: RepoStatus
  steps: string[]
  log: string[]
}> {
  const log: string[] = []
  const steps: string[] = []
  let before = await repoStatus(session)

  if (!before.exists) {
    if (!before.error?.includes('Not Found') && !before.error?.includes('404')) {
      throw new Error(before.error ?? '仓库不可访问')
    }
    log.push(`==> 创建仓库 ${session.repo}`)
    const [owner, name] = session.repo.split('/')
    await request(session, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, private: isPrivate, description: 'rsdk-webui build worker', auto_init: true }),
    })
    steps.push(`创建仓库 ${session.repo}`)
    for (let i = 0; i < 8 && !before.exists; i++) {
      await sleep(1200)
      before = await repoStatus(session)
    }
    if (!before.exists) throw new Error(`仓库 ${session.repo} 创建后仍不可访问（owner 要写对）`)
  }

  let pushedWorkflow = false
  const workflowBody = renderGhWorkflow()
  if (!before.workflowOnDefaultBranch) {
    log.push('==> 提交 .github/workflows/build.yml 到默认分支')
    const branch = before.defaultBranch ?? 'main'
    await commitFiles(
      session,
      branch,
      [{ path: '.github/workflows/build.yml', content: workflowBody, encoding: 'utf-8', mode: 0o644 }],
      'chore: rsdk-webui build workflow',
      undefined,
      // 在默认分支现有树之上增量提交：仓库可能是用户的 fork 或复用的既有仓库，
      // 整树替换会把分支顶端的其他文件全部抹掉
      { inheritTree: true },
    )
    pushedWorkflow = true
    steps.push(`提交 workflow 到 ${branch}`)
  } else {
    log.push('==> workflow 已就位')
  }

  let actionsEnabled: boolean | null = before.actionsEnabled ?? null
  if (before.actionsEnabled === false) {
    log.push('==> 尝试启用 Actions（fork 默认关闭）')
    try {
      await request(session, `/repos/${session.repo}/actions/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true, allowed_actions: 'all' }),
      })
      actionsEnabled = true
      steps.push('已启用 GitHub Actions')
    } catch (err) {
      actionsEnabled = false
      steps.push('需要你手动启用 Actions')
      log.push(`    失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  const status = await repoStatus(session)

  // A Pages site only makes sense when this repository is a copy of the project
  // (fork / "use this template"): the Pages workflow builds the UI from web/,
  // which a bare repository does not carry. A bare repository is still a good
  // build worker - it just uses the upstream site as its interface.
  const hasUi = await Promise.all(
    ['web/package.json', '.github/workflows/pages.yml'].map((file) =>
      request(session, `/repos/${session.repo}/contents/${file}?ref=${status.defaultBranch}`)
        .then(() => true)
        .catch(() => false),
    ),
  ).then((found) => found.every(Boolean))

  let pagesEnabled: boolean | null = status.hasPages ?? null
  if (!hasUi) {
    steps.push('未部署自有 UI（仓库里没有 web/ 源码，用上游站点即可）')
    log.push('==> 这个仓库没有 UI 源码（web/），跳过 Pages；用上游的站点作为界面')
  } else if (status.hasPages === false && status.canAdmin) {
    log.push('==> 尝试启用 GitHub Pages')
    try {
      await request(session, `/repos/${session.repo}/pages`, {
        method: 'POST',
        body: JSON.stringify({ build_type: 'workflow' }),
      })
      pagesEnabled = true
      steps.push('已启用 GitHub Pages')
      log.push('    已启用')
    } catch (err) {
      pagesEnabled = false
      steps.push('需要你手动启用 Pages')
      log.push(`    失败: ${err instanceof Error ? err.message : err}`)
      log.push(`    打开 https://github.com/${session.repo}/settings/pages ，Source 选 GitHub Actions`)
    }
  } else if (status.hasPages === true) {
    steps.push('GitHub Pages 已启用')
  }

  if (hasUi && pagesEnabled !== false && status.workflowOnDefaultBranch) {
    try {
      await request(session, `/repos/${session.repo}/actions/workflows/pages.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: status.defaultBranch ?? 'main' }),
      })
      steps.push('已触发 Pages 部署')
      log.push('==> 已触发 Pages 部署')
    } catch (err) {
      log.push(`（Pages 部署未触发: ${err instanceof Error ? err.message : err}）`)
    }
  }

  return {
    created: steps.some((s) => s.startsWith('创建仓库')),
    pushedWorkflow,
    actionsEnabled,
    pagesEnabled,
    status,
    steps,
    log,
  }
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

type FileSpec = { path: string; content: string; encoding: 'utf-8' | 'base64'; mode: number }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        out[index] = await fn(items[index], index)
      }
    }),
  )
  return out
}

/**
 * Create a commit on `branch` with exactly these files (creating the branch if needed).
 *
 * By default the new tree contains *only* `files` (整树替换 —— build/<id> 分支
 * 是自包含构建包，这是预期行为). Pass `opts.inheritTree` to build on top of the
 * branch's existing tree instead (用于往默认分支增量提交单个文件).
 */
export async function commitFiles(
  session: GhSession,
  branch: string,
  files: FileSpec[],
  message: string,
  onProgress?: (done: number, total: number) => void,
  opts: { inheritTree?: boolean } = {},
): Promise<{ commit: string; branch: string }> {
  const repo = session.repo
  const baseBranch = await request<{ default_branch?: string }>(session, `/repos/${repo}`).then(
    (r) => r.default_branch ?? 'main',
  )

  let parent: string | undefined
  try {
    const ref = await request<{ object: { sha: string } }>(session, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
    parent = ref.object.sha
  } catch {
    const head = await request<{ object: { sha: string } }>(
      session,
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    ).catch(() => null)
    parent = head?.object.sha
  }

  // inheritTree: 以分支当前树为 base_tree，把 files 合并进去而不是替换整棵树
  let baseTree: string | undefined
  if (opts.inheritTree && parent) {
    const parentCommit = await request<{ tree: { sha: string } }>(session, `/repos/${repo}/git/commits/${parent}`).catch(
      () => null,
    )
    baseTree = parentCommit?.tree.sha
  }

  let done = 0
  const blobs = await mapLimit(files, 6, async (file) => {
    const blob = await request<{ sha: string }>(session, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: file.encoding }),
    })
    onProgress?.(++done, files.length)
    return { path: file.path, mode: file.mode === 0o755 ? '100755' : '100644', type: 'blob', sha: blob.sha }
  })

  const tree = await request<{ sha: string }>(session, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify(baseTree ? { tree: blobs, base_tree: baseTree } : { tree: blobs }),
  })

  const commit = await request<{ sha: string }>(session, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: parent ? [parent] : [] }),
  })

  try {
    await request(session, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      // inheritTree 的父提交就是当前 head，本就是 fast-forward；不 force，
      // 万一并发有人推了新提交，这里会失败而不是悄悄覆盖别人的东西
      body: JSON.stringify({ sha: commit.sha, force: !opts.inheritTree }),
    })
  } catch {
    await request(session, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    })
  }

  return { commit: commit.sha, branch }
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

type Run = {
  id: number
  status: string
  conclusion: string | null
  html_url: string
  head_branch: string
  run_started_at?: string
  created_at: string
}

type RunJob = {
  id: number
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  steps?: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }>
}

const runByBranch = new Map<string, number>()

function jobFromRun(run: Run, steps: JobStep[]): Job {
  const finished = run.status === 'completed'
  const ok = run.conclusion === 'success'
  return {
    id: String(run.id),
    kind: 'build',
    status: finished ? (ok ? 'succeeded' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed') : 'running',
    title: `${run.head_branch}`,
    backend: 'gh-actions',
    createdAt: new Date(run.created_at).getTime(),
    startedAt: run.run_started_at ? new Date(run.run_started_at).getTime() : undefined,
    steps,
    ghRunUrl: run.html_url,
    ghRunId: run.id,
    ghBranch: run.head_branch,
    dir: undefined,
    logPath: '',
    remote: { status: run.status, conclusion: run.conclusion ?? undefined },
    ...(finished && !ok ? { error: `workflow ${run.conclusion}` } : {}),
  }
}

export class GitHubAdapter {
  constructor(private session: GhSession) {}

  async startBuild(profile: Profile, onProgress?: (text: string) => void): Promise<Job> {
    const tree = await loadRsdkTree()
    let entries
    try {
      entries = assembleBundle(profile, tree).filter((e) => !isIgnoredBundlePath(e.path))
    } catch (err) {
      // assembleBundle 会先过一遍 zod —— 把校验失败翻成可读的中文
      const issues = (err as { issues?: Array<{ path?: (string | number)[]; message: string }> })?.issues
      if (Array.isArray(issues)) {
        const detail = issues.map((i) => `${(i.path ?? []).join('.')} ${i.message}`).join('；')
        throw new Error(`方案数据不合法：${detail}`)
      }
      throw err
    }
    onProgress?.(`组装构建包：${entries.length} 个文件（含 rsdk jsonnet 树）`)

    const gh = profile.backend.kind === 'gh-actions' ? profile.backend : null
    const prefix = (gh?.branchPrefix || 'build').replace(/^\/+|\/+$/g, '') || 'build'
    const branch = `${prefix}/${profile.id}`
    const { commit } = await commitFiles(
      this.session,
      branch,
      entries.map((e) => ({ ...e })),
      `build: ${profile.meta.name} (${profile.id})\ncache-key: ${rootfsCacheKey(profile)}`,
      (done, total) => onProgress?.(`上传文件 ${done}/${total}`),
    )
    onProgress?.(`已推送到 ${this.session.repo}:${branch} @ ${commit.slice(0, 7)}，等待 workflow`)

    let run: Run | undefined
    for (let i = 0; i < 40; i++) {
      await sleep(3000)
      const runs = await request<{ workflow_runs: Run[] }>(
        this.session,
        `/repos/${this.session.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`,
      )
      // 不要依赖列表的默认排序假设：显式按 created_at 挑最新的一条
      run = [...runs.workflow_runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
      if (run) break
    }
    if (!run) {
      const status = await repoStatus(this.session)
      if (status.actionsEnabled === false) {
        throw new Error(
          `仓库 ${this.session.repo} 的 Actions 被禁用（fork 默认如此）。` +
            `请到「构建后端」点「准备仓库」，或直接打开 ${status.htmlUrl}/actions 启用。`,
        )
      }
      if (!status.workflowOnDefaultBranch) {
        throw new Error(`默认分支上没有 .github/workflows/build.yml，点「准备仓库」补上。`)
      }
      throw new Error('推送成功但没有出现 workflow run，请检查仓库的 Actions 页面')
    }
    runByBranch.set(branch, run.id)
    return jobFromRun(run, [])
  }

  async getJob(id: string): Promise<Job> {
    const run = await request<Run>(this.session, `/repos/${this.session.repo}/actions/runs/${id}`)
    const steps: JobStep[] = []
    const jobs = await request<{ jobs: RunJob[] }>(
      this.session,
      `/repos/${this.session.repo}/actions/runs/${id}/jobs`,
    ).catch(() => ({ jobs: [] as RunJob[] }))
    for (const job of jobs.jobs) {
      for (const step of job.steps ?? []) {
        if (step.status !== 'completed' || step.conclusion === 'skipped') continue
        steps.push({
          name: step.conclusion === 'success' ? step.name : `${step.name} (${step.conclusion})`,
          at: step.started_at ? new Date(step.started_at).getTime() : Date.now(),
        })
      }
    }

    const job = jobFromRun(run, steps)
    if (run.status === 'completed') {
      const artifacts = await request<{ artifacts: Array<{ name: string; size_in_bytes: number; expired: boolean }> }>(
        this.session,
        `/repos/${this.session.repo}/actions/runs/${id}/artifacts`,
      ).catch(() => ({ artifacts: [] }))
      job.artifacts = artifacts.artifacts.map((a) => ({
        name: a.name,
        path: '',
        size: a.size_in_bytes,
        url: `${run.html_url}/artifacts`,
      }))
    }
    return job
  }

  async cancel(id: string): Promise<boolean> {
    try {
      await request(this.session, `/repos/${this.session.repo}/actions/runs/${id}/cancel`, { method: 'POST' })
      return true
    } catch {
      return false
    }
  }

  /**
   * Run logs. GitHub only exposes them as a zip once the run is finished, so we
   * fetch it once, remember the offset, and hand out slices like the server
   * adapter's streaming endpoint does.
   */
  private logCache = new Map<string, string>()
  private logOffset = new Map<string, number>()
  /** when the "are logs available yet" question was last asked, per run */
  private logGate = new Map<string, number>()

  async readLog(id: string, offset: number): Promise<{ text: string; offset: number; size: number }> {
    const cached = this.logCache.get(id)
    if (cached === undefined) {
      // GitHub only serves a run's log once it is finished, and the UI polls
      // every few seconds: asking every time would burn a large part of the
      // 5000/h API budget on a long build.
      const last = this.logGate.get(id) ?? 0
      if (Date.now() - last < 60_000) return { text: '', offset, size: 0 }
      this.logGate.set(id, Date.now())
      const run = await request<Run>(this.session, `/repos/${this.session.repo}/actions/runs/${id}`)
      if (run.status !== 'completed') return { text: '', offset, size: 0 }
      const response = await fetch(`${API}/repos/${this.session.repo}/actions/runs/${id}/logs`, {
        headers: { Authorization: `Bearer ${this.session.token}`, Accept: 'application/vnd.github+json' },
        redirect: 'follow',
      })
      if (!response.ok) {
        return { text: `(日志获取失败: ${response.status})\n`, offset, size: 0 }
      }
      const { unzipSync } = await import('fflate')
      const zip = new Uint8Array(await response.arrayBuffer())
      const files = unzipSync(zip)
      const parts = Object.keys(files)
        .sort()
        .map((name) => `===== ${name} =====\n${new TextDecoder().decode(files[name])}`)
      this.logCache.set(id, parts.join('\n'))
    }
    const full = this.logCache.get(id) ?? ''
    if (offset >= full.length) return { text: '', offset: full.length, size: full.length }
    this.logOffset.set(id, full.length)
    return { text: full.slice(offset), offset: full.length, size: full.length }
  }
}
