import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type RunResult = {
  code: number
  stdout: string
  stderr: string
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, opts.timeoutMs)
    }
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

export async function tryRun(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  try {
    return await run(cmd, args, opts)
  } catch (err) {
    return { code: -1, stdout: '', stderr: String(err) }
  }
}

export function which(bin: string): string | undefined {
  const extra = process.env.PATH ?? ''
  for (const dir of extra.split(':')) {
    if (!dir) continue
    const full = path.join(dir, bin)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

export async function fsType(target: string): Promise<string> {
  const r = await tryRun('stat', ['-f', '-c', '%T', target])
  return r.stdout.trim() || 'unknown'
}

/**
 * Serialise container-engine invocations.
 *
 * podman takes an exclusive lock on its storage; two overlapping calls (e.g.
 * two parallel API requests) make one of them fail with a storage error, which
 * then looks like "the image disappeared". Queue them instead.
 */
let engineChain: Promise<unknown> = Promise.resolve()

export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = engineChain.then(fn, fn)
  engineChain = next.catch(() => undefined)
  return next
}
