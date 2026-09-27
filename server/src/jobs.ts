import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { renderFetchImageScript, shq, type Profile } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { detectEngine, engineRun } from './env.ts'
import { listArtifacts, writeBundle } from './bundle.ts'
import {
  getJob,
  jobDir,
  jobWorkDir,
  listJobs,
  newJob,
  newJobId,
  onJobChange,
  updateJob,
  type Job,
  type JobStep,
} from './store.ts'
import { cancelGhaRun, runGhaBuild, watchRun } from './backends/gha.ts'

const processes = new Map<string, ChildProcess>()
const watchers = new Map<string, NodeJS.Timeout>()

// ---------------------------------------------------------------------------
// log parsing -> timeline
// ---------------------------------------------------------------------------

const PHASE_PATTERNS: Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  { re: /^I: running apt-get update/m, label: () => '更新 apt 索引' },
  { re: /^I: downloading packages/m, label: () => '下载软件包' },
  { re: /^I: extracting archives/m, label: () => '解包' },
  { re: /^I: installing essential packages/m, label: () => '安装基础系统' },
  { re: /^I: installing packages/m, label: () => '安装基础软件包' },
  { re: /^I: running --setup-hook/m, label: () => '执行 setup 钩子' },
  { re: /^I: running --customize-hook/m, label: () => '执行 customize 钩子' },
  { re: /^I: running --cleanup-hook/m, label: () => '清理 rootfs' },
  { re: /^I: creating tarball/m, label: () => '打包 rootfs' },
  { re: /=== \[rsdk-webui\] (.+?) ===/m, label: (m) => `定制: ${m[1]}` },
  { re: /Building (\S+) (\S+) (\S+)\.\.\./m, label: (m) => `构建 ${m[1]} ${m[2]} ${m[3]}` },
  { re: /libguestfs|guestfish/i, label: () => '生成磁盘镜像' },
  { re: /^(?:I: )?done/i, label: () => '完成' },
]

function extractSteps(chunk: string, existing: JobStep[]): JobStep[] {
  const found: JobStep[] = []
  for (const line of chunk.split(/\r?\n/)) {
    for (const { re, label } of PHASE_PATTERNS) {
      const m = line.match(re)
      if (!m) continue
      const name = label(m)
      const last = existing.at(-1)?.name ?? found.at(-1)?.name
      if (name === last) continue
      if (found.some((s) => s.name === name)) continue
      found.push({ name, at: Date.now() })
      break
    }
  }
  return found
}

/** exit-code marker written next to the bundle by the wrapper shell */
export function exitCodeFile(dir: string): string {
  return path.join(dir, '.exit-code')
}

/**
 * Watch a job's log file and finalise it when its exit-code file appears.
 *
 * The build writes straight into the log file (no pipe), and reports its result
 * through a file rather than a process handle. That makes a running build
 * survive a restart of this server: on startup we simply re-attach a watcher.
 */
function watchJob(jobId: string): void {
  if (watchers.has(jobId)) return
  const started = getJob(jobId)
  if (!started?.dir) return

  const dir = started.dir
  const workDir = started.workDir ?? dir
  const exitFile = exitCodeFile(dir)
  let offset = 0
  let steps: JobStep[] = []

  const finish = (code: number) => {
    const current = getJob(jobId)
    const cancelled = current?.status === 'cancelled'
    updateJob(jobId, {
      status: cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed',
      finishedAt: Date.now(),
      exitCode: code,
      artifacts: listArtifacts(workDir, `/api/jobs/${jobId}/files`),
      ...(code === 0 || cancelled ? {} : { error: `run.sh 退出码 ${code}` }),
    })
  }

  const timer = setInterval(() => {
    const current = getJob(jobId)
    if (!current) return stop()
    if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return stop()

    const chunk = readLog(jobId, offset)
    if (chunk.text) {
      offset = chunk.offset
      const next = extractSteps(chunk.text, steps)
      if (next.length) {
        steps = [...steps, ...next]
        updateJob(jobId, { steps })
      }
    }

    if (fs.existsSync(exitFile)) {
      const raw = fs.readFileSync(exitFile, 'utf8').trim()
      const code = Number.parseInt(raw, 10)
      stop()
      finish(Number.isFinite(code) ? code : -1)
    }
  }, 900)

  const stop = () => {
    const t = watchers.get(jobId)
    if (t) clearInterval(t)
    watchers.delete(jobId)
  }

  watchers.set(jobId, timer)
}

// ---------------------------------------------------------------------------
// local container backend
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// local container backend
// ---------------------------------------------------------------------------

export async function startLocalBuild(profile: Profile, existingId?: string): Promise<Job> {
  const id = existingId ?? newJobId(`b-${profile.id}`)
  const job = newJob({
    id,
    kind: 'build',
    title: `${profile.meta.name} · ${profile.target.product}/${profile.target.suite}/${profile.target.edition}`,
    backend: 'local-docker',
    profileId: profile.id,
    profile,
    dir: jobDir(id),
    workDir: jobWorkDir(profile.id),
  })

  const dir = job.dir!
  fs.mkdirSync(job.workDir!, { recursive: true })
  updateJob(job.id, { status: 'running', startedAt: Date.now() })

  try {
    const result = await writeBundle(profile, dir)
    fs.appendFileSync(
      job.logPath,
      [
        `== rsdk-webui local build ==`,
        `bundle : ${dir}`,
        `rsdk   : ${result.rsdkVersion ?? 'unknown'}`,
        `cmd    : rsdk ${result.args.join(' ')}`,
        '',
      ].join('\n'),
    )
  } catch (err) {
    updateJob(job.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: String(err instanceof Error ? err.message : err),
    })
    return getJob(job.id)!
  }

  const engine = await detectEngine()
  if (!engine) {
    updateJob(job.id, { status: 'failed', finishedAt: Date.now(), error: '没有可用的容器引擎' })
    return getJob(job.id)!
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RSDK_ENGINE: engine.kind,
    RSDK_IMAGE: config.image,
    RSDK_ENGINE_ARGS: engine.args.join(' '),
    RSDK_RUN_EXTRA: engine.runExtra.join(' '),
    RSDK_NO_TTY: '1',
    // the rootfs cache lives here and is shared by every build of this profile
    RSDK_WORK_DIR: job.workDir,
  }

  // stdio goes straight to the log file: no pipe to break if this process dies,
  // and `run.sh` execs podman so the wrapper below is what records the result
  fs.rmSync(exitCodeFile(dir), { force: true })
  const logFd = fs.openSync(job.logPath, 'a')
  const wrapper = `set +e; bash run.sh; code=$?; printf '%s' "$code" > ${shq(exitCodeFile(dir))}; exit $code`
  const child = spawn('bash', ['-c', wrapper], {
    cwd: dir,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd)
  processes.set(job.id, child)
  child.on('close', () => processes.delete(job.id))
  watchJob(job.id)

  return getJob(job.id)!
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = getJob(id)
  if (!job || job.status !== 'running') return false

  // a GitHub Actions build is not ours to kill locally - ask GitHub to cancel
  // the run, or it keeps burning the user's minutes
  if (job.backend === 'gh-actions') {
    const cancelled = await cancelGhaRun(job).catch(() => false)
    updateJob(id, {
      status: 'cancelled',
      finishedAt: Date.now(),
      error: cancelled ? '已取消（已请求 GitHub 取消该 run）' : '已取消（本地标记；远程取消失败，请到 Actions 页面确认）',
    })
    return true
  }

  const child = processes.get(id)
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }

  const engine = await detectEngine()
  if (engine) {
    const name = `rsdk-webui-${path.basename(job.dir ?? '')}`
    await engineRun(['rm', '-f', name])
  }

  updateJob(id, { status: 'cancelled', finishedAt: Date.now(), error: '已取消' })
  return true
}

// ---------------------------------------------------------------------------
// environment preparation (fetch the official rsdk container image)
// ---------------------------------------------------------------------------

export async function startFetchImage(): Promise<Job> {
  // the download is ~500 MB into a fixed directory, so two of them at once
  // would just fight over the same files
  const running = listJobs().find((j) => j.kind === 'fetch-image' && (j.status === 'running' || j.status === 'queued'))
  if (running) return running

  const id = `setup-fetch-image`
  const dir = jobDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'fetch-image.sh'), renderFetchImageScript(), { mode: 0o755 })

  const job = newJob({
    id: `${id}-${Date.now().toString(36)}`,
    kind: 'fetch-image',
    title: `导入 rsdk 容器镜像 (${config.imageVersion})`,
    backend: 'internal',
    dir,
  })
  updateJob(job.id, { status: 'running', startedAt: Date.now() })

  const engine = await detectEngine()
  if (!engine) {
    updateJob(job.id, { status: 'failed', finishedAt: Date.now(), error: '没有可用的容器引擎' })
    return getJob(job.id)!
  }

  // same directory is reused on every re-import; a leftover exit-code file
  // would make the watcher report the previous run's result immediately
  fs.rmSync(exitCodeFile(dir), { force: true })

  const cache = path.join(config.cacheDir, `rsdk-image-${config.imageVersion}`)
  fs.mkdirSync(cache, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RSDK_ENGINE: engine.kind,
    RSDK_ENGINE_ARGS: engine.args.join(' '),
    RSDK_IMAGE: config.image,
    RSDK_IMAGE_VERSION: config.imageVersion,
  }
  const logFd = fs.openSync(job.logPath, 'a')
  const wrapper = `set +e; bash ${shq(path.join(dir, 'fetch-image.sh'))} ${shq(cache)} ${shq(config.image)}; code=$?; printf '%s' "$code" > ${shq(exitCodeFile(dir))}; exit $code`
  const child = spawn('bash', ['-c', wrapper], {
    cwd: dir,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd)
  processes.set(job.id, child)
  child.on('close', () => processes.delete(job.id))
  watchJob(job.id)
  return getJob(job.id)!
}

// ---------------------------------------------------------------------------
// github actions backend
// ---------------------------------------------------------------------------

export async function startGhaBuild(profile: Profile): Promise<Job> {
  const id = newJobId(`g-${profile.id}`)
  const job = newJob({
    id,
    kind: 'build',
    title: `${profile.meta.name} · ${profile.target.product}/${profile.target.suite}/${profile.target.edition}`,
    backend: 'gh-actions',
    profileId: profile.id,
    profile,
    dir: jobDir(id),
  })
  updateJob(job.id, { status: 'running', startedAt: Date.now() })

  // Pushing the bundle takes seconds but *watching* the run takes an hour, so
  // this must not be awaited by the HTTP request: the caller gets the job id
  // immediately and follows it on the job page.
  void (async () => {
    try {
      const result = await writeBundle(profile, job.dir!)
      fs.appendFileSync(
        job.logPath,
        [
          '== rsdk-webui GitHub Actions build ==',
          `bundle : ${job.dir}`,
          `cmd    : rsdk ${result.args.join(' ')}`,
          '',
        ].join('\n'),
      )
      await runGhaBuild(job.id, profile, job.dir!)
    } catch (err) {
      updateJob(job.id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: String(err instanceof Error ? err.message : err),
      })
    }
  })()

  return getJob(job.id)!
}

// ---------------------------------------------------------------------------
// startup reconciliation
// ---------------------------------------------------------------------------

/**
 * A build job is a live child process; a server restart loses it. Rather than
 * leaving a job stuck on "running" forever, mark the orphans and tell the user
 * how to find the container if it is still going.
 */
export async function reconcileJobsOnStartup(): Promise<{ adopted: number; orphaned: number }> {
  const pending = listJobs().filter((j) => j.status === 'running' || j.status === 'queued')
  if (pending.length === 0) return { adopted: 0, orphaned: 0 }

  const engine = await detectEngine()
  const containers = new Set<string>()
  if (engine) {
    const ps = await engineRun(['ps', '--format', '{{.Names}}'])
    for (const name of ps.stdout.split('\n')) containers.add(name.trim())
  }

  let adopted = 0
  let orphaned = 0
  for (const job of pending) {
    const dir = job.dir
    if (dir && fs.existsSync(exitCodeFile(dir))) {
      // it finished while we were down; pick up the result
      const code = Number.parseInt(fs.readFileSync(exitCodeFile(dir), 'utf8').trim(), 10)
      updateJob(job.id, {
        status: code === 0 ? 'succeeded' : 'failed',
        finishedAt: Date.now(),
        exitCode: code,
        artifacts: listArtifacts(dir, `/api/jobs/${job.id}/files`),
        ...(code === 0 ? {} : { error: `run.sh 退出码 ${code}（服务重启期间结束）` }),
      })
      adopted++
      continue
    }

    const container = dir ? `rsdk-webui-${path.basename(dir)}` : ''
    const alive = container !== '' && containers.has(container)
    const fresh = fs.existsSync(job.logPath) && Date.now() - fs.statSync(job.logPath).mtimeMs < 90_000

    // GitHub Actions builds are tracked by a polling loop in this process, not
    // by a child process, so a restart re-attaches by run id instead
    if (job.backend === 'gh-actions' && job.ghRunId && job.ghRepo) {
      fs.appendFileSync(job.logPath, '\n== rsdk-webui 已重启，重新接管这个 run ==\n')
      void watchRun(job.id, job.ghRepo, job.ghRunId, job.ghRunUrl).catch(() => undefined)
      adopted++
      continue
    }

    if (alive || fresh) {
      // still building - keep watching, just say who we are now
      fs.appendFileSync(job.logPath, '\n== rsdk-webui 已重启，重新接管这个构建 ==\n')
      watchJob(job.id)
      adopted++
      continue
    }

    updateJob(job.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: '服务重启，任务已中断',
    })
    orphaned++
  }
  return { adopted, orphaned }
}

// ---------------------------------------------------------------------------
// log reading (for SSE / polling)
// ---------------------------------------------------------------------------

export function readLog(id: string, offset = 0): { text: string; offset: number; size: number } {
  const job = getJob(id)
  if (!job) return { text: '', offset, size: 0 }
  try {
    const stat = fs.statSync(job.logPath)
    if (stat.size <= offset) return { text: '', offset: stat.size, size: stat.size }
    const fd = fs.openSync(job.logPath, 'r')
    const length = stat.size - offset
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, offset)
    fs.closeSync(fd)
    return { text: buffer.toString('utf8'), offset: stat.size, size: stat.size }
  } catch {
    return { text: '', offset, size: 0 }
  }
}

export { onJobChange }
