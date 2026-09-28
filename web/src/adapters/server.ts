/**
 * Local backend: the Fastify server in `server/`, which drives a real
 * podman/docker build on this machine.
 */
import type { Catalog, EnvStatus, PackageSearchHit, PreflightResult, Profile } from '@rsdk-webui/shared'
import type { Backend, Job, RepoSetupResult, RepoStatus, RenderResult } from './types.ts'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string; issues?: unknown; jobId?: string }
      if (body.error) detail = body.error
      if (body.issues) detail += `: ${JSON.stringify(body.issues)}`
      ;(detail as unknown as { jobId?: string }) // keep tsc quiet about the extra field
    } catch {
      /* keep the status line */
    }
    throw Object.assign(new Error(detail), { jobId: undefined })
  }
  return (await res.json()) as T
}

export class ServerBackend implements Backend {
  readonly mode = 'server' as const

  env(backend?: Profile['backend']) {
    const query = backend?.kind === 'local-docker' ? '?' + new URLSearchParams({ engine: backend.engine, image: backend.image }) : ''
    return req<EnvStatus>('/api/env' + query)
  }

  async refreshEnv() {
    await req('/api/env/refresh', { method: 'POST' })
    return this.env()
  }

  catalog() {
    return req<Catalog>('/api/catalog')
  }

  newProfile(product?: string) {
    return req<Profile>(`/api/catalog/new-profile${product ? `?product=${encodeURIComponent(product)}` : ''}`)
  }

  profiles() {
    return req<Profile[]>('/api/profiles')
  }

  saveProfile(profile: Profile) {
    return req<Profile>(`/api/profiles/${profile.id}`, { method: 'PUT', body: JSON.stringify(profile) })
  }

  async deleteProfile(id: string) {
    await req(`/api/profiles/${id}`, { method: 'DELETE' })
  }

  render(profile: Profile) {
    return req<RenderResult>('/api/render', { method: 'POST', body: JSON.stringify(profile) })
  }

  startBuild(profile: Profile, onProgress?: (text: string) => void) {
    onProgress?.('提交构建')
    // the server dispatches in the background: for GitHub Actions the push plus
    // the polling used to keep this request open for the whole build
    return req<{ jobId: string; job: Job }>('/api/builds', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }).then((r) => r.job ?? this.job(r.jobId))
  }

  jobs() {
    return req<Job[]>('/api/jobs')
  }

  job(id: string) {
    return req<Job>(`/api/jobs/${id}`)
  }

  async cancelJob(id: string) {
    return (await req<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' })).cancelled
  }

  log(id: string, offset: number) {
    return req<{ text: string; offset: number; size: number }>(`/api/jobs/${id}/log?offset=${offset}`)
  }

  fetchImage() {
    return req<{ jobId: string }>('/api/setup/fetch-image', { method: 'POST' })
  }

  downloadGha(id: string) {
    return req<{ dir: string }>(`/api/jobs/${id}/download-gh`, { method: 'POST' })
  }

  indexStatus(product: string, suite: string) {
    return req<{ key: string; meta: { count: number; builtAt: number } | null }>(
      `/api/packages/index-status?product=${encodeURIComponent(product)}&suite=${encodeURIComponent(suite)}`,
    )
  }

  buildIndex(product: string, suite: string, force = false) {
    return req<{ key: string; jobId?: string; cached?: boolean }>('/api/packages/index', {
      method: 'POST',
      body: JSON.stringify({ product, suite, force }),
    })
  }

  searchPackages(product: string, suite: string, query: string, limit = 60) {
    return req<{ meta: { count: number } | null; hits: PackageSearchHit[] }>(
      `/api/packages/search?product=${encodeURIComponent(product)}&suite=${encodeURIComponent(suite)}` +
        `&q=${encodeURIComponent(query)}&limit=${limit}`,
    )
  }

  preflight(profile: Profile, force = false) {
    return req<PreflightResult>(`/api/preflight${force ? '?force=1' : ''}`, {
      method: 'POST',
      body: JSON.stringify(profile),
    })
  }

  inspectDebs(profile: Profile) {
    return req<{
      required: string[]
      bootloaderPrefix: string
      report: {
        source: string
        packages: Array<{ file: string; package: string; version: string; architecture: string }>
        provided: string[]
        fromRepos: string[]
        warnings: string[]
        failed: Array<{ file: string; error: string }>
      }
    }>('/api/debs/inspect', { method: 'POST', body: JSON.stringify(profile) })
  }

  ghRepo(repo: string) {
    return req<RepoStatus>(`/api/gh/repo?repo=${encodeURIComponent(repo)}`)
  }

  ghSetup(repo: string, opts: { create?: boolean; isPrivate?: boolean } = {}) {
    return req<RepoSetupResult>('/api/gh/repo/setup', {
      method: 'POST',
      body: JSON.stringify({ repo, ...opts }),
    })
  }
}
