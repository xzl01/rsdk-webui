/**
 * The UI talks to one `Backend`, which is either
 *
 *   - `server`  the local Fastify server (real podman/docker builds), or
 *   - `static`  no server at all: the UI is a GitHub Pages site and talks
 *               straight to api.github.com with a token the user pastes in.
 *
 * Mode detection is a runtime probe, not a build flag, so the same bundle works
 * both ways: if `/api/health` answers, we are being served by the local server.
 */
import {
  comboKey,
  newId,
  newProfile as buildProfile,
  normalizeForProduct,
  renderBundle,
  renderRsdkArgs,
  requiredKernelPackages,
  safeParseProfile,
  type Catalog,
  type EnvStatus,
  type PreflightResult,
  type Profile,
} from '@rsdk-webui/shared'
import {
  GitHubAdapter,
  loadCatalog,
  loadVerdicts,
  repoStatus,
  prepareRepo,
  staticEnv,
  staticPackages,
  verifyToken,
  type GhSession,
} from './adapters/github.ts'
import { ServerBackend } from './adapters/server.ts'
import type { Backend, Job, RepoSetupResult, RepoStatus, RenderResult } from './adapters/types.ts'

export type { Job, RepoSetupResult, RepoStatus, RenderResult } from './adapters/types.ts'
export type { GhSession } from './adapters/github.ts'

// ---------------------------------------------------------------------------
// mode detection
// ---------------------------------------------------------------------------

let detected: 'server' | 'static' | null = null

export async function detectMode(): Promise<'server' | 'static'> {
  if (detected) return detected
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } })
    const body = response.ok ? ((await response.json()) as { ok?: boolean }) : null
    detected = body?.ok ? 'server' : 'static'
  } catch {
    detected = 'static'
  }
  return detected
}

export function currentMode(): 'server' | 'static' {
  return detected ?? 'static'
}

// ---------------------------------------------------------------------------
// session (static mode only)
// ---------------------------------------------------------------------------

const SESSION_KEY = 'rsdk-webui.session'
const PROFILES_KEY = 'rsdk-webui.profiles'

let session: GhSession | null = null
const sessionListeners = new Set<(s: GhSession | null) => void>()

export function loadStoredSession(): GhSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    session = raw ? (JSON.parse(raw) as GhSession) : null
  } catch {
    session = null
  }
  return session
}

export function getSession(): GhSession | null {
  return session
}

export function onSessionChange(listener: (s: GhSession | null) => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

function setSession(next: GhSession | null): void {
  session = next
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* private browsing */
  }
  for (const listener of sessionListeners) listener(next)
}

/** Validate a token and remember it together with the target repository. */
export async function connect(token: string, repo: string): Promise<GhSession> {
  const user = await verifyToken(token.trim())
  const next: GhSession = { token: token.trim(), login: user.login, name: user.name, repo: repo.trim() }
  setSession(next)
  return next
}

export function disconnect(): void {
  setSession(null)
}

// ---------------------------------------------------------------------------
// static backend
// ---------------------------------------------------------------------------

class StaticBackend implements Backend {
  readonly mode = 'static' as const

  private get adapter(): GitHubAdapter {
    if (!session) throw new Error('尚未连接 GitHub')
    return new GitHubAdapter(session)
  }

  async env(): Promise<EnvStatus> {
    return staticEnv(session)
  }

  refreshEnv(): Promise<EnvStatus> {
    return this.env()
  }

  catalog(): Promise<Catalog> {
    return loadCatalog()
  }

  async newProfile(product?: string) {
    const catalog = await this.catalog()
    const selected = product
      ? catalog.products.find((p) => p.product === product)
      : catalog.products.find((p) => p.product === 'rock-5b') ?? catalog.products[0]
    return {
      ...buildProfile({ product: selected }),
      backend: {
        kind: 'gh-actions' as const,
        repo: session?.repo ?? '',
        branchPrefix: 'build',
        publishRelease: false,
        compress: true,
        keepBranch: true,
      },
    }
  }

  async profiles(): Promise<Profile[]> {
    try {
      const raw = localStorage.getItem(PROFILES_KEY)
      return raw ? (JSON.parse(raw) as Profile[]) : []
    } catch {
      return []
    }
  }

  async saveProfile(profile: Profile): Promise<Profile> {
    const catalog = await this.catalog().catch(() => null)
    const product = catalog?.products.find((p) => p.product === profile.target.product)
    const normalised = product ? normalizeForProduct(profile, product) : profile
    const all = await this.profiles()
    const index = all.findIndex((p) => p.id === normalised.id)
    if (index >= 0) all[index] = normalised
    else all.push(normalised)
    localStorage.setItem(PROFILES_KEY, JSON.stringify(all))
    return normalised
  }

  async deleteProfile(id: string): Promise<void> {
    const all = (await this.profiles()).filter((p) => p.id !== id)
    localStorage.setItem(PROFILES_KEY, JSON.stringify(all))
  }

  /** preview only - the real bundle is assembled when the build starts */
  async render(profile: Profile): Promise<RenderResult> {
    return {
      files: renderBundle(profile).map((file: { path: string; content: string | Uint8Array; mode: number }) =>
        typeof file.content === 'string'
          ? { path: file.path, content: file.content, mode: file.mode, binary: false }
          : { path: file.path, content: `<binary, ${file.content.byteLength} bytes>`, mode: file.mode, binary: true },
      ),
      command: `rsdk ${renderRsdkArgs(profile).join(' ')}`,
      env: await this.env(),
    }
  }

  startBuild(profile: Profile, onProgress?: (text: string) => void): Promise<Job> {
    return this.adapter.startBuild(profile, onProgress)
  }

  /** build branches of the target repository, newest first */
  async jobs(): Promise<Job[]> {
    if (!session) return []
    const runs = await fetch(
      `https://api.github.com/repos/${session.repo}/actions/runs?per_page=30`,
      { headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json' } },
    )
      .then((r) => (r.ok ? r.json() : { workflow_runs: [] }))
      .catch(() => ({ workflow_runs: [] }))
    return (runs.workflow_runs as Array<{ id: number; head_branch: string; status: string; conclusion: string | null; created_at: string; html_url: string }>)
      .filter((run) => run.head_branch.startsWith('build/'))
      .map((run) => ({
        id: String(run.id),
        kind: 'build' as const,
        status:
          run.status === 'completed'
            ? run.conclusion === 'success'
              ? ('succeeded' as const)
              : run.conclusion === 'cancelled'
                ? ('cancelled' as const)
                : ('failed' as const)
            : ('running' as const),
        title: run.head_branch.replace(/^build\//, ''),
        backend: 'gh-actions' as const,
        createdAt: new Date(run.created_at).getTime(),
        steps: [],
        ghRunUrl: run.html_url,
        ghRunId: run.id,
        ghBranch: run.head_branch,
        remote: { status: run.status, conclusion: run.conclusion ?? undefined },
      }))
  }

  job(id: string): Promise<Job> {
    return this.adapter.getJob(id)
  }

  cancelJob(id: string): Promise<boolean> {
    return this.adapter.cancel(id)
  }

  log(id: string, offset: number) {
    return this.adapter.readLog(id, offset)
  }

  /**
   * The static build cannot probe the repositories (they send no CORS headers),
   * but it does not need to: the package index shipped with the site already
   * contains every package of the stable *and* test repositories for that
   * suite, so the check is a lookup.
   */
  async preflight(profile: Profile): Promise<PreflightResult> {
    const catalog = await this.catalog().catch(() => null)
    const product = catalog?.products.find((p) => p.product === profile.target.product)
    const required = requiredKernelPackages(profile, product)

    // Deploy-time verdicts beat a lookup: they were computed by rendering the
    // edition's *whole* package list, not just the four essential packages.
    const verdicts = await loadVerdicts().catch(() => null)
    const verdict = verdicts?.combos[comboKey(profile.target.product, profile.target.suite, profile.target.edition)]
    if (verdict && verdict.status !== 'ok') {
      const needsTest = verdict.status === 'test'
      return {
        product: profile.target.product,
        suite: profile.target.suite,
        testRepo: profile.repos.testRepo,
        required,
        missing: verdict.missing ?? [],
        repos: [],
        suggestTestRepo: needsTest && !profile.repos.testRepo,
        suggestion: verdict.hint ?? (needsTest ? '这个组合需要打开「使用测试源」。' : '这个组合上游无法构建。'),
        checkedAt: Date.now(),
      }
    }
    const index = await staticPackages.load(profile.target.suite)
    const checkedAt = Date.now()
    if (!index) {
      return {
        product: profile.target.product,
        suite: profile.target.suite,
        testRepo: profile.packages.vendor && profile.repos.testRepo,
        required,
        missing: [],
        repos: [],
        suggestTestRepo: false,
        suggestion: `站点没有为 ${profile.target.suite} 部署包索引，无法预检（部署时加 --with-index）。`,
        checkedAt,
      }
    }

    const byName = new Map(index.records.map((record) => [record.n, record]))

    // a package that only exists in the *-test repository does not count when
    // the profile is building against the stable one - that build would fail
    const testRepo = profile.repos.testRepo
    const usable = (name: string) => {
      const record = byName.get(name)
      if (!record) return false
      return testRepo || record.t !== 1
    }
    const missing = required.filter((name) => !usable(name))
    const suggestTestRepo =
      !testRepo && missing.length > 0 && missing.every((name) => byName.get(name)?.t === 1)

    return {
      product: profile.target.product,
      suite: profile.target.suite,
      testRepo: profile.repos.testRepo,
      required,
      missing,
      repos: [{ label: `${profile.target.suite}（站点静态索引）`, exists: true, packageCount: index.meta.count }],
      suggestTestRepo,
      suggestion:
        missing.length === 0
          ? undefined
          : suggestTestRepo
            ? '这些包只在测试源 (-test) 里。把「软件源」里的「使用测试源」打开再构建。'
            : '当前软件源的索引里找不到这些包。请检查镜像地址，或确认该板子在这个 suite 下是否已发布。',
      checkedAt,
    }
  }

  indexStatus(suiteProduct: string, suite: string) {
    return staticPackages.indexStatus(suite)
  }

  searchPackages(_product: string, suite: string, query: string, limit = 60) {
    return staticPackages.search(suite, query, limit)
  }

  ghRepo(repo: string): Promise<RepoStatus> {
    if (!session) return Promise.reject(new Error('尚未连接 GitHub'))
    return repoStatus({ ...session, repo })
  }

  ghSetup(repo: string, opts: { create?: boolean; isPrivate?: boolean } = {}): Promise<RepoSetupResult> {
    if (!session) return Promise.reject(new Error('尚未连接 GitHub'))
    const next = { ...session, repo }
    setSession(next)
    return prepareRepo(next, opts.isPrivate ?? true)
  }
}

// ---------------------------------------------------------------------------
// facade
// ---------------------------------------------------------------------------

let backend: Backend | null = null

export async function getBackend(): Promise<Backend> {
  if (backend) return backend
  const mode = await detectMode()
  backend = mode === 'server' ? new ServerBackend() : new StaticBackend()
  return backend
}

/** re-create the backend after connecting/disconnecting (static mode) */
export function resetBackend(): void {
  backend = null
}

export const newProfileId = newId
export { safeParseProfile }

/**
 * Convenience proxy so components can keep writing `api.env()`, `api.startBuild(p)`
 * while the concrete backend is resolved lazily (and may be replaced when the
 * user connects/disconnects in static mode).
 */
export const api: Backend = new Proxy({} as Backend, {
  get(_target, prop: string) {
    return async (...args: unknown[]) => {
      const resolved = await getBackend()
      const member = (resolved as unknown as Record<string, unknown>)[prop]
      if (typeof member !== 'function') {
        throw new Error(`当前模式（${resolved.mode}）不支持 ${prop}()`)
      }
      return (member as (...a: unknown[]) => unknown).apply(resolved, args)
    }
  },
})
