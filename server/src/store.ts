import fs from 'node:fs'
import path from 'node:path'
import type { Profile } from '@rsdk-webui/shared'
import { config } from './config.ts'

export type JobKind = 'build' | 'fetch-image' | 'packages-index'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type JobStep = { name: string; at: number }

export type Artifact = {
  name: string
  path: string
  size: number
  /** downloadable through the API */
  url: string
}

export type Job = {
  id: string
  kind: JobKind
  status: JobStatus
  title: string
  backend: 'local-docker' | 'gh-actions' | 'internal'
  profileId?: string
  /** snapshot of the profile at submit time, so history stays meaningful */
  profile?: Profile
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  dir?: string
  /**
   * The shared per-profile working directory: `rsdk build` keeps its rootfs
   * cache there, so it must outlive the (per submission) bundle directory.
   */
  workDir?: string
  logPath: string
  steps: JobStep[]
  error?: string
  /** github actions */
  ghRunId?: number
  ghRunUrl?: string
  ghBranch?: string
  ghRepo?: string
  artifacts?: Artifact[]
  remote?: { status?: string; conclusion?: string }
}

type Db = {
  jobs: Job[]
}

function readDb(): Db {
  try {
    return JSON.parse(fs.readFileSync(config.jobsFile, 'utf8')) as Db
  } catch {
    return { jobs: [] }
  }
}

let db: Db | null = null
const listeners = new Set<(job: Job) => void>()

function load(): Db {
  if (!db) db = readDb()
  return db
}

function persist(): void {
  const data = load()
  const tmp = config.jobsFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, config.jobsFile)
}

export function listJobs(): Job[] {
  return [...load().jobs].sort((a, b) => b.createdAt - a.createdAt)
}

export function getJob(id: string): Job | undefined {
  return load().jobs.find((j) => j.id === id)
}

export function upsertJob(job: Job): Job {
  const data = load()
  const index = data.jobs.findIndex((j) => j.id === job.id)
  if (index >= 0) data.jobs[index] = job
  else data.jobs.unshift(job)

  if (data.jobs.length > config.jobRetention) {
    // Never drop a job that is still writing into its bundle directory; only
    // finished ones may be pruned (this can temporarily exceed the retention).
    const live = (j: Job) => j.status === 'running' || j.status === 'queued'
    const kept: Job[] = []
    const dropped: Job[] = []
    data.jobs.forEach((j, index) => {
      if (index < config.jobRetention || live(j)) kept.push(j)
      else dropped.push(j)
    })
    for (const j of dropped) {
      if (j.dir) fs.rmSync(j.dir, { recursive: true, force: true })
    }
    data.jobs = kept
  }
  persist()
  for (const listener of listeners) listener(job)
  return job
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = getJob(id)
  if (!job) return undefined
  return upsertJob({ ...job, ...patch })
}

export function onJobChange(listener: (job: Job) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function jobDir(id: string): string {
  return path.join(config.buildsDir, id)
}

/**
 * `rsdk build` keeps its expensive artefact (rootfs.tar) under the directory it
 * runs in and reuses it when the inputs are unchanged. That cache has to survive
 * across builds of the same profile, while the bundle and its job record must be
 * per submission - otherwise a rebuild destroys the cache and overwrites the
 * previous job's history.
 */
export function jobWorkDir(profileId: string): string {
  return path.join(config.buildsDir, '.work', profileId)
}

/** unique per submission, so history is never overwritten */
export function newJobId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}

export function jobLogPath(id: string): string {
  return path.join(config.logsDir, `${id}.log`)
}

export function newJob(input: Omit<Job, 'createdAt' | 'status' | 'steps' | 'logPath'> & Partial<Job>): Job {
  const id = input.id
  const job: Job = {
    status: 'queued',
    createdAt: Date.now(),
    steps: [],
    logPath: jobLogPath(id),
    ...input,
  }
  fs.mkdirSync(config.logsDir, { recursive: true })
  fs.writeFileSync(job.logPath, '')
  return upsertJob(job)
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

type ProfileDb = { profiles: Profile[] }

function readProfiles(): ProfileDb {
  try {
    return JSON.parse(fs.readFileSync(config.profilesFile, 'utf8')) as ProfileDb
  } catch {
    return { profiles: [] }
  }
}

let profileDb: ProfileDb | null = null

function loadProfiles(): ProfileDb {
  if (!profileDb) profileDb = readProfiles()
  return profileDb
}

function persistProfiles(): void {
  const data = loadProfiles()
  const tmp = config.profilesFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, config.profilesFile)
}

export function listProfiles(): Profile[] {
  return [...loadProfiles().profiles].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

export function getProfile(id: string): Profile | undefined {
  return loadProfiles().profiles.find((p) => p.id === id)
}

export function saveProfile(profile: Profile): Profile {
  const data = loadProfiles()
  const index = data.profiles.findIndex((p) => p.id === profile.id)
  if (index >= 0) data.profiles[index] = profile
  else data.profiles.push(profile)
  persistProfiles()
  return profile
}

export function deleteProfile(id: string): boolean {
  const data = loadProfiles()
  const before = data.profiles.length
  data.profiles = data.profiles.filter((p) => p.id !== id)
  persistProfiles()
  return data.profiles.length !== before
}
