import type { EnvStatus } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { fsType, run, serialized, tryRun, which } from './proc.ts'

export type Engine = {
  kind: 'podman' | 'docker'
  binary: string
  version: string
  /** global engine args (before the `run` subcommand) */
  args: string[]
  /** extra args for `run` (uid mapping etc.) */
  runExtra: string[]
  rootless: boolean
}

let cachedEngine: Engine | null | undefined
let detecting: Promise<Engine | null> | null = null

async function probePodman(bin: string, args: string[]): Promise<boolean> {
  const r = await tryRun(bin, [...args, 'info', '--format', '{{.Host.Security.Rootless}}'], { timeoutMs: 30_000 })
  return r.code === 0
}

/**
 * Pick a container engine that actually works on this host.
 *
 * podman's default overlay driver does not work when the graph root lives on
 * btrfs, which is common on Arch installs. In that case we fall back to a
 * dedicated storage root using the native btrfs driver - isolated from the
 * user's own podman store, so we can never break their existing containers.
 */
export async function detectEngine(force = false): Promise<Engine | null> {
  if (!force && cachedEngine !== undefined) return cachedEngine
  // never probe twice in parallel: overlapping `podman info` calls can fail on
  // the storage lock and would make us think no engine is available
  if (!force && detecting) return detecting
  cachedEngine = undefined
  detecting = detect(force).finally(() => {
    detecting = null
  })
  return detecting
}

async function detect(force: boolean): Promise<Engine | null> {
  cachedEngine = null

  const order: Array<'podman' | 'docker'> = config.engineOverride
    ? [config.engineOverride]
    : ['podman', 'docker']

  for (const kind of order) {
    const bin = which(kind)
    if (!bin) continue
    const versionOut = await tryRun(bin, ['--version'])
    const version = versionOut.stdout.trim() || versionOut.stderr.trim()

    let args: string[] = []
    let ok = false

    if (kind === 'podman' && config.podmanRoot !== 'standard') {
      // 1) does the user's normal store work?
      ok = await probePodman(bin, [])
      if (!ok) {
        // 2) dedicated store, native driver for the backing filesystem
        const backing = await fsType(config.dataDir)
        const driver = backing === 'btrfs' ? 'btrfs' : backing === 'zfs' ? 'zfs' : 'overlay'
        const candidate = [
          '--root', config.podmanRoot,
          '--runroot', config.podmanRunRoot,
          '--storage-driver', driver,
        ]
        if (await probePodman(bin, candidate)) {
          args = candidate
          ok = true
        } else if (await probePodman(bin, ['--root', config.podmanRoot, '--runroot', config.podmanRunRoot, '--storage-driver', 'vfs'])) {
          // last resort: slow but works everywhere
          args = ['--root', config.podmanRoot, '--runroot', config.podmanRunRoot, '--storage-driver', 'vfs']
          ok = true
        }
      }
    } else {
      ok = await probePodman(bin, [])
    }

    if (!ok) continue

    const rootless = process.getuid?.() !== 0 && kind === 'podman'
    cachedEngine = {
      kind,
      binary: bin,
      version,
      args,
      // rootless podman needs the host uid kept inside the container so that
      // bind mounts stay writable
      runExtra: rootless ? ['--userns=keep-id'] : [],
      rootless,
    }
    return cachedEngine
  }

  return null
}

export async function engineStatus(): Promise<EnvStatus['engine']> {
  const engine = await detectEngine()
  if (!engine) {
    return {
      kind: 'none',
      binary: '',
      version: '',
      args: [],
      runExtra: [],
      rootless: false,
      ok: false,
      error: 'no working podman or docker found',
    }
  }
  return {
    kind: engine.kind,
    binary: engine.binary,
    version: engine.version,
    args: engine.args,
    runExtra: engine.runExtra,
    rootless: engine.rootless,
    ok: true,
  }
}

/** Run a command inside the engine with the global args already applied. */
export async function engineRun(
  args: string[],
  opts: Parameters<typeof run>[2] & { retries?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const engine = await detectEngine()
  if (!engine) return { code: -1, stdout: '', stderr: 'no container engine available' }
  const { retries = 0, ...runOpts } = opts
  let last: { code: number; stdout: string; stderr: string } = { code: -1, stdout: '', stderr: '' }
  for (let attempt = 0; attempt <= retries; attempt++) {
    // a running build holds podman's storage lock, so read-only queries can
    // fail transiently; give them a couple of chances before believing it
    last = await serialized(() => tryRun(engine.binary, [...engine.args, ...args], runOpts))
    if (last.code === 0) return last
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 600))
  }
  return last
}

/** `rsdk-image:latest` and `docker.io/library/rsdk-image:latest` are the same image */
function normalizeRef(ref: string): string {
  return ref
    .replace(/^docker\.io\/library\//, '')
    .replace(/^docker\.io\//, '')
    .replace(/^localhost\//, '')
    .replace(/:latest$/, '')
    .toLowerCase()
}

export type ImageStatus = {
  ref: string
  present: boolean
  id?: string
  sizeBytes?: number
  createdAt?: string
}

let lastImageStatus: ImageStatus | null = null

export async function imageStatus(): Promise<ImageStatus> {
  const engine = await detectEngine()
  if (!engine) return { ref: config.image, present: false }
  const ref = config.image
  const r = await engineRun(['images', '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}'], {
    retries: 3,
  })
  // A running build holds podman's storage lock; a failed probe must not make
  // the UI claim the image disappeared. Keep the last known good answer.
  if (r.code !== 0) return lastImageStatus ?? { ref, present: false }
  const want = normalizeRef(ref)
  for (const line of r.stdout.split('\n')) {
    const [name, id, size, ...rest] = line.split('|')
    if (!name) continue
    if (normalizeRef(name) !== want) continue
    lastImageStatus = {
      ref: name,
      present: true,
      id,
      sizeBytes: parseHumanSize(size),
      createdAt: rest.join('|'),
    }
    return lastImageStatus
  }
  lastImageStatus = { ref, present: false }
  return lastImageStatus
}

function parseHumanSize(v: string | undefined): number | undefined {
  if (!v) return undefined
  const m = v.trim().match(/^([\d.]+)\s*([kKMGTP]?i?B?)$/)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2].toUpperCase().replace('I', '').replace('B', '')
  const factors: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(n * (factors[unit] ?? 1))
}

export async function ghStatus(): Promise<EnvStatus['gh']> {
  const bin = which('gh')
  if (!bin) return { available: false, tokenPresent: false, error: 'gh CLI not found' }
  const auth = await tryRun(bin, ['auth', 'status', '--json', 'hosts'])
  const token = await tryRun(bin, ['auth', 'token'])
  const tokenPresent = token.code === 0 && token.stdout.trim().length > 0
  let login: string | undefined
  try {
    const parsed = JSON.parse(auth.stdout) as { hosts?: Record<string, Array<{ login?: string }>> }
    login = Object.values(parsed.hosts ?? {})[0]?.[0]?.login
  } catch {
    /* ignore */
  }
  if (!tokenPresent) {
    return { available: false, login, tokenPresent, error: auth.stderr.trim() || 'not logged in' }
  }
  return { available: true, login, tokenPresent }
}

export async function ghToken(): Promise<string> {
  const bin = which('gh')
  if (!bin) throw new Error('gh CLI not found')
  const r = await run(bin, ['auth', 'token'])
  const token = r.stdout.trim()
  if (!token) throw new Error('gh auth token returned nothing; run `gh auth login`')
  return token
}

export async function ghJson<T>(args: string[]): Promise<T> {
  const bin = which('gh')
  if (!bin) throw new Error('gh CLI not found')
  const r = await run(bin, args)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args.join(' ')} failed`)
  return JSON.parse(r.stdout) as T
}
