/** Types shared by the two backends (local server, GitHub Pages). */
import type {
  Catalog,
  EnvStatus,
  PackageSearchHit,
  PreflightResult,
  Profile,
  RepoStatus,
} from '@rsdk-webui/shared'

export type { RepoStatus } from '@rsdk-webui/shared'

export type JobStep = { name: string; at: number }

export type Artifact = {
  name: string
  path: string
  size: number
  url: string
}

export type Job = {
  id: string
  kind: 'build' | 'fetch-image' | 'packages-index'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  title: string
  backend: 'local-docker' | 'gh-actions' | 'internal'
  profileId?: string
  profileName?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  dir?: string
  logPath?: string
  steps: JobStep[]
  error?: string
  ghRunId?: number
  ghRunUrl?: string
  ghBranch?: string
  ghRepo?: string
  artifacts?: Artifact[]
  remote?: { status?: string; conclusion?: string }
}

export type BundleFilePreview = { path: string; content: string; mode: number; binary?: boolean }

export type RenderResult = {
  files: BundleFilePreview[]
  command: string
  env: unknown
}

export type RepoSetupResult = {
  created: boolean
  pushedWorkflow: boolean
  actionsEnabled: boolean | null
  status: RepoStatus
  steps: string[]
  log?: string[]
}

/**
 * The surface the UI needs. Implemented once against the local Fastify server
 * and once against the GitHub REST API directly from the browser.
 */
export interface Backend {
  readonly mode: 'server' | 'static'

  env(): Promise<EnvStatus>
  refreshEnv(): Promise<EnvStatus>
  catalog(): Promise<Catalog>
  newProfile(product?: string): Promise<Profile>

  profiles(): Promise<Profile[]>
  saveProfile(profile: Profile): Promise<Profile>
  deleteProfile(id: string): Promise<void>

  render(profile: Profile): Promise<RenderResult>

  startBuild(profile: Profile, onProgress?: (text: string) => void): Promise<Job>
  jobs(): Promise<Job[]>
  job(id: string): Promise<Job>
  cancelJob(id: string): Promise<boolean>
  log(id: string, offset: number): Promise<{ text: string; offset: number; size: number }>

  /** local backend only */
  fetchImage?(): Promise<{ jobId: string }>
  /** local backend only: pull a finished GitHub run's artifacts with gh */
  downloadGha?(id: string): Promise<{ dir: string }>

  indexStatus(product: string, suite: string): Promise<{ key: string; meta: { count: number; builtAt: number } | null }>
  buildIndex?(product: string, suite: string, force?: boolean): Promise<{ key: string; jobId?: string; cached?: boolean }>
  searchPackages(
    product: string,
    suite: string,
    query: string,
    limit?: number,
  ): Promise<{ meta: { count: number } | null; hits: PackageSearchHit[] }>

  /** pre-build sanity check: are the packages the build will ask for available */
  preflight(profile: Profile, force?: boolean): Promise<PreflightResult>

  /** local .deb analysis; the static backend cannot read local files */
  inspectDebs?(profile: Profile): Promise<{
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
  }>

  ghRepo(repo: string): Promise<RepoStatus>
  ghSetup(repo: string, opts?: { create?: boolean; isPrivate?: boolean }): Promise<RepoSetupResult>
}
