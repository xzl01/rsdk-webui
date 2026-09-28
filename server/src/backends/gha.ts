/**
 * GitHub Actions backend plumbing.
 *
 * The intended model: the user owns a repository (a fork, a "use this template"
 * copy, or one we create for them). rsdk-webui only ever:
 *   - commits the workflow + README to its default branch (one-time),
 *   - pushes a `build/<id>` branch per build,
 *   - reads back run status and artifacts.
 *
 * Nothing is ever written to anybody else's repository.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderGhWorkflow,
  renderTemplateReadme,
  type GhBackend,
  type Profile,
  type RepoStatus,
} from '@rsdk-webui/shared'
import { ghToken } from '../env.ts'
import { tryRun, which } from '../proc.ts'
import { getJob, updateJob } from '../store.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function ghBin(): string {
  const bin = which('gh')
  if (!bin) throw new Error('gh CLI not found; install it and run `gh auth login`')
  return bin
}

async function ghJson<T>(args: string[]): Promise<T> {
  const r = await tryRun(ghBin(), args)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args.join(' ')} failed`)
  return JSON.parse(r.stdout) as T
}

/**
 * Turn the two failures users actually hit into something actionable: a token
 * without the `workflow` scope cannot touch .github/workflows, and a missing
 * `repo` scope cannot push at all.
 */
function explainGitFailure(stderr: string): string {
  if (/workflow.*scope|refusing to allow a Personal Access Token/i.test(stderr)) {
    return (
      `${stderr}\n\n提示：token 缺少 Workflows 权限 —— 构建包里有 .github/workflows/build.yml。` +
      '请在 fine-grained token 上勾选 Workflows: Read and write（classic token 则需要 workflow scope）。'
    )
  }
  if (/Authentication failed|403|could not read Username/i.test(stderr)) {
    return (
      `${stderr}\n\n提示：token 认证失败或权限不足。fine-grained token 需要 Contents: Read and write，` +
      '且 Repository access 要包含这个仓库。'
    )
  }
  return `推送失败: ${stderr}`
}

/**
 * git 认证：token 写进一个 0700 的临时 GIT_ASKPASS 脚本，用完即删。
 * 之前用 `-c credential.helper=...password=<token>`，token 作为 argv 元素
 * 对同机所有能读 ps 的进程可见；askpass 让它只存在于文件系统的一小段时间。
 */
function askpassScript(token: string): string {
  const safe = token.replaceAll("'", `'\\''`)
  return [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) echo x-access-token ;;',
    `  *) printf '%s\\n' '${safe}' ;;`,
    'esac',
    '',
  ].join('\n')
}

async function git(args: string[], cwd: string, token: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-askpass-'))
  const script = path.join(dir, 'askpass.sh')
  fs.writeFileSync(script, askpassScript(token), { mode: 0o700 })
  try {
    return await tryRun(which('git')!, args, {
      cwd,
      env: { GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: '0' },
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function appendLog(jobId: string, text: string): void {
  const job = getJob(jobId)
  if (!job) return
  fs.appendFileSync(job.logPath, text.endsWith('\n') ? text : text + '\n')
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function repoStatus(repo: string): Promise<RepoStatus> {
  const [owner, name] = repo.split('/')
  const status: RepoStatus = { repo, owner: owner ?? '', name: name ?? '', exists: false }
  if (!owner || !name) {
    status.error = '仓库格式应为 owner/name'
    return status
  }

  const json = await tryRun(ghBin(), [
    'repo', 'view', repo,
    '--json', 'isPrivate,isFork,defaultBranchRef,url,viewerPermission',
  ])
  if (json.code !== 0) {
    status.error = json.stderr.trim().split('\n')[0] || '仓库不存在'
    return status
  }

  const info = JSON.parse(json.stdout) as {
    isPrivate: boolean
    isFork: boolean
    defaultBranchRef: { name: string } | null
    url: string
    viewerPermission: string
  }
  status.exists = true
  status.private = info.isPrivate
  status.fork = info.isFork
  status.defaultBranch = info.defaultBranchRef?.name ?? 'main'
  status.htmlUrl = info.url
  status.canAdmin = ['ADMIN', 'MAINTAINER'].includes(info.viewerPermission)

  // `gh repo view --json` has its own field allowlist and rejects unknown
  // names, so has_pages has to come from the REST API directly
  const pages = await tryRun(ghBin(), ['api', `repos/${repo}`, '--jq', '.has_pages'])
  if (pages.code === 0) status.hasPages = pages.stdout.trim() === 'true'

  // Actions enabled? (a fork starts with them disabled)
  const perms = await tryRun(ghBin(), ['api', `repos/${repo}/actions/permissions`])
  if (perms.code === 0) {
    try {
      status.actionsEnabled = (JSON.parse(perms.stdout) as { enabled?: boolean }).enabled !== false
    } catch {
      status.actionsEnabled = true
    }
  }

  // is the workflow on the default branch?
  const file = await tryRun(ghBin(), [
    'api', `repos/${repo}/contents/.github/workflows/build.yml?ref=${status.defaultBranch}`,
    '--jq', '.sha',
  ])
  status.workflowOnDefaultBranch = file.code === 0 && !!file.stdout.trim()

  status.needsManualActionEnable = status.exists && status.actionsEnabled === false && status.canAdmin !== true
  return status
}

// ---------------------------------------------------------------------------
// one-time setup
// ---------------------------------------------------------------------------

export type SetupResult = {
  created: boolean
  pushedWorkflow: boolean
  actionsEnabled: boolean | null
  pagesEnabled: boolean | null
  status: RepoStatus
  steps: string[]
}

/**
 * Make `repo` a usable build worker: create it if needed, commit the workflow +
 * README to its default branch, and turn Actions on.
 */
export async function setupRepo(
  repo: string,
  opts: { create?: boolean; isPrivate?: boolean } = {},
  log: (line: string) => void = () => undefined,
): Promise<SetupResult> {
  const steps: string[] = []
  const bin = ghBin()
  let before = await repoStatus(repo)
  let created = false

  if (!before.exists) {
    if (!opts.create) throw new Error(`仓库 ${repo} 不存在（可以勾选「自动创建」）`)
    log(`==> 创建仓库 ${repo}`)
    const create = await tryRun(bin, [
      'repo', 'create', repo,
      opts.isPrivate === false ? '--public' : '--private',
      '--description', 'rsdk-webui build worker (generated)',
    ])
    if (create.code !== 0) throw new Error(`创建仓库失败: ${create.stderr.trim()}`)
    created = true
    steps.push(`创建仓库 ${repo}`)
    for (let i = 0; i < 10 && !before.exists; i++) {
      await sleep(1500)
      before = await repoStatus(repo)
    }
  }

  // Commit the workflow + README to the default branch.
  //
  // Never force-push: the repository may be the user's fork of the whole
  // project, whose default branch holds real code. We only add or update the
  // two files we own, and treat "nothing to commit" as success.
  let pushedWorkflow = false
  if (!before.workflowOnDefaultBranch || before.fork) {
    const token = await ghToken()
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdk-webui-gh-'))
    const checkout = path.join(work, 'repo')
    const branch = before.defaultBranch || 'main'
    try {
      log('==> 检出默认分支')
      const clone = await git(['clone', '--depth', '1', `https://github.com/${repo}.git`, checkout], work, token)
      if (clone.code !== 0) {
        // brand new, empty repository
        fs.mkdirSync(checkout, { recursive: true })
        await git(['init', '-q', '-b', branch], checkout, token)
        await git(['remote', 'add', 'origin', `https://github.com/${repo}.git`], checkout, token)
      }

      const workflowPath = path.join(checkout, '.github', 'workflows', 'build.yml')
      const readmePath = path.join(checkout, 'README.md')
      const workflowBody = renderGhWorkflow()
      const readmeBody = renderTemplateReadme(before.owner || 'you', before.name || 'rsdk-webui-builds')

      const changed: string[] = []
      for (const [file, body] of [
        [workflowPath, workflowBody],
        [readmePath, readmeBody],
      ] as const) {
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
        if (current === body) continue
        // a fork may hold real code in README.md; only replace ours or add ours
        if (current !== null && !current.includes('rsdk-webui') && path.basename(file) === 'README.md') {
          log(`==> 保留已有的 README.md（不是我们生成的）`)
          continue
        }
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
        changed.push(path.relative(checkout, file))
      }

      if (changed.length === 0) {
        log('==> workflow 已是最新，无需提交')
        pushedWorkflow = before.workflowOnDefaultBranch === true
        steps.push('workflow 已是最新')
      } else {
        log(`==> 提交 ${changed.join(', ')}`)
        await git(['add', ...changed], checkout, token)
        const commit = await git(
          ['-c', 'user.email=rsdk-webui@localhost', '-c', 'user.name=rsdk-webui', 'commit', '-q', '-m', 'chore: rsdk-webui build workflow'],
          checkout,
          token,
        )
        if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          throw new Error(`提交失败: ${commit.stderr.trim() || commit.stdout.trim()}`)
        }
        const push = await git(['push', 'origin', `HEAD:${branch}`], checkout, token)
        if (push.code !== 0) throw new Error(`推送失败: ${push.stderr.trim()}`)
        pushedWorkflow = true
        steps.push(`提交 ${changed.join(', ')} 到 ${branch}`)
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }

  // turn Actions on (forks start with them disabled)
  let actionsEnabled: boolean | null = null
  if (before.actionsEnabled === false) {
    log('==> 尝试启用 Actions（fork 默认关闭）')
    const enable = await tryRun(bin, [
      'api', '-X', 'PUT', `repos/${repo}/actions/permissions`,
      '-f', 'enabled=true', '-f', 'allowed_actions=all',
    ])
    if (enable.code === 0) {
      actionsEnabled = true
      steps.push('已启用 GitHub Actions')
      log('    已启用')
    } else {
      actionsEnabled = false
      steps.push('需要手动启用 Actions')
      log(`    失败: ${enable.stderr.trim().split('\n')[0]}`)
      log(`    请打开 https://github.com/${repo}/actions 点一次确认`)
    }
  } else if (before.actionsEnabled === true) {
    actionsEnabled = true
  }

  const status = await repoStatus(repo)

  // A Pages site is only useful when this repository *is* a copy of the project
  // (fork or "use this template"): the Pages workflow builds the UI from web/,
  // which a bare repository does not have. A bare repository is still a perfectly
  // good build worker - it just uses the upstream site as its interface.
  const hasUi = await Promise.all(
    ['web/package.json', '.github/workflows/pages.yml'].map((file) =>
      tryRun(ghBin(), ['api', `repos/${repo}/contents/${file}?ref=${status.defaultBranch}`]).then(
        (result) => result.code === 0,
      ),
    ),
  ).then((found) => found.every(Boolean))

  let pagesEnabled: boolean | null = status.hasPages ?? null
  if (!hasUi) {
    steps.push('未部署自有 UI（仓库里没有 web/ 源码，用上游站点即可）')
    log('==> 这个仓库没有 UI 源码（web/），跳过 Pages；用上游的站点作为界面')
  } else if (status.hasPages === false && status.canAdmin) {
    log('==> 尝试启用 GitHub Pages')
    const enable = await tryRun(bin, ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'build_type=workflow'])
    if (enable.code === 0) {
      pagesEnabled = true
      steps.push('已启用 GitHub Pages')
    } else {
      pagesEnabled = false
      steps.push('需要手动启用 Pages')
      log(`    失败: ${enable.stderr.trim().split('\n')[0]}`)
      log(`    打开 https://github.com/${repo}/settings/pages ，Source 选 GitHub Actions`)
    }
  }

  // nudge the Pages workflow: it may have run (and failed) before Pages existed,
  // e.g. right after "Use this template"
  if (hasUi && pagesEnabled !== false && status.workflowOnDefaultBranch) {
    const dispatch = await tryRun(bin, [
      'api', '-X', 'POST', `repos/${repo}/actions/workflows/pages.yml/dispatches`,
      '-f', `ref=${status.defaultBranch ?? 'main'}`,
    ])
    if (dispatch.code === 0) {
      steps.push('已触发 Pages 部署')
      log('==> 已触发 Pages 部署')
    } else {
      log(`（Pages 部署未触发: ${dispatch.stderr.trim().split('\n')[0]}）`)
    }
  }

  const finalStatus = await repoStatus(repo)
  return { created, pushedWorkflow, actionsEnabled, pagesEnabled, status: finalStatus, steps }
}

// ---------------------------------------------------------------------------
// build: push a bundle to a branch, then watch the run
// ---------------------------------------------------------------------------

type RunInfo = {
  databaseId: number
  status: string
  conclusion: string | null
  url: string
  headBranch: string
  headSha: string
  createdAt: string
}

export async function runGhaBuild(jobId: string, profile: Profile, dir: string): Promise<void> {
  const gh = profile.backend as GhBackend
  if (!gh.repo) throw new Error('未配置 GitHub 仓库 (owner/name)')

  const bin = ghBin()
  const token = await ghToken()
  const branch = `${gh.branchPrefix}/${profile.id}`

  const repoInfo = await repoStatus(gh.repo)
  if (!repoInfo.exists) throw new Error(`仓库 ${gh.repo} 不存在或无权访问`)
  if (repoInfo.actionsEnabled === false) {
    throw new Error(
      `仓库 ${gh.repo} 的 Actions 被禁用（fork 的默认行为）。在「构建后端」点「准备仓库」启用，` +
        `或手动打开 https://github.com/${gh.repo}/actions`,
    )
  }

  appendLog(jobId, `==> 推送构建包到 ${gh.repo}:${branch}`)
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })
  await git(['init', '-q', '-b', branch], dir, token)
  await git(['config', 'user.email', 'rsdk-webui@localhost'], dir, token)
  await git(['config', 'user.name', 'rsdk-webui'], dir, token)
  await git(['add', '-A'], dir, token)
  await git(['-c', 'user.email=rsdk-webui@localhost', '-c', 'user.name=rsdk-webui', 'commit', '-q', '-m', `build: ${profile.meta.name} (${profile.id})`], dir, token)
  const hasOrigin = await tryRun(which('git')!, ['remote', 'get-url', 'origin'], { cwd: dir })
  if (hasOrigin.code === 0) await git(['remote', 'set-url', 'origin', `https://github.com/${gh.repo}.git`], dir, token)
  else await git(['remote', 'add', 'origin', `https://github.com/${gh.repo}.git`], dir, token)

  const head = await git(['rev-parse', 'HEAD'], dir, token)
  if (head.code !== 0) throw new Error('无法读取构建 commit')
  const commit = head.stdout.trim()
  const push = await git(['push', '--force', 'origin', branch], dir, token)
  if (push.code !== 0) throw new Error(explainGitFailure(push.stderr.trim()))
  updateJob(jobId, { ghBranch: branch, ghRepo: gh.repo })

  appendLog(jobId, '==> 等待 workflow 启动')
  let run: RunInfo | undefined
  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    const runs = await ghJson<RunInfo[]>([
      'run', 'list', '--repo', gh.repo, '--branch', branch, '--workflow', 'build.yml', '--commit', commit, '--event', 'push', '--limit', '30',
      '--json', 'databaseId,status,conclusion,url,headBranch,headSha,createdAt',
    ])
    const matching = runs.find((candidate) => candidate.headSha === commit)
    if (matching) {
      run = matching
      break
    }
  }
  if (!run) {
    throw new Error(
      '未找到对应的 workflow run。请确认默认分支上有 .github/workflows/build.yml，' +
        '且仓库的 Actions 已启用（fork 默认关闭）。',
    )
  }

  appendLog(jobId, `==> run #${run.databaseId} ${run.url}`)
  updateJob(jobId, { ghRunId: run.databaseId, ghRunUrl: run.url })
  await watchRun(jobId, gh.repo, run.databaseId, run.url)
}

/**
 * Poll a run until it finishes. Separate from runGhaBuild() so a server restart
 * can re-attach to a run that is already going - the polling lives in this
 * process, and a build takes the better part of an hour.
 */
export async function watchRun(jobId: string, repo: string, runId: number, runUrl?: string): Promise<void> {
  const bin = ghBin()
  let url = runUrl
  let lastStatus = ''
  let failures = 0
  let queuedSince: number | null = null
  let queuedHinted = false

  for (;;) {
    const current = getJob(jobId)
    if (!current || current.status === 'cancelled') return

    const info = await ghJson<RunInfo>([
      'run', 'view', String(runId), '--repo', repo,
      '--json', 'databaseId,status,conclusion,url,headBranch,headSha,createdAt',
    ]).catch((err: unknown) => {
      failures += 1
      appendLog(
        jobId,
        `==> 读取 run 状态失败（第 ${failures} 次）: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    })

    if (!info) {
      // A single hiccup (network, rate limit) used to end the watcher for good,
      // leaving the job "running" forever. Retry, then say so explicitly.
      if (failures >= 10) {
        updateJob(jobId, {
          status: 'failed',
          finishedAt: Date.now(),
          error: `连续 ${failures} 次无法读取 run 状态，已停止跟踪；请到 Actions 页面查看：${url ?? ''}`,
        })
        return
      }
      await sleep(15_000)
      continue
    }
    failures = 0
    url = info.url

    if (info.status !== lastStatus) {
      lastStatus = info.status
      appendLog(jobId, `==> workflow 状态: ${info.status}`)
      updateJob(jobId, { remote: { status: info.status, conclusion: info.conclusion ?? undefined } })
    }

    // A run that never leaves "queued" is almost always an Actions billing or
    // policy problem, and it is completely silent otherwise.
    if (info.status === 'queued') {
      queuedSince ??= Date.now()
      if (!queuedHinted && Date.now() - queuedSince > 10 * 60_000) {
        queuedHinted = true
        appendLog(
          jobId,
          '!! run 已在队列里超过 10 分钟仍未开始。常见原因：GitHub Actions 分钟数/额度用尽，' +
            '或仓库的 Actions 策略限制。请查看 https://github.com/settings/billing 。',
        )
      }
    } else {
      queuedSince = null
    }

    // mirror the run's steps into the job timeline, so a GitHub build shows the
    // same progress list a local build does
    const steps = await ghJson<{ jobs: Array<{ steps?: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null }> }> }>([
      'api', `repos/${repo}/actions/runs/${runId}/jobs`,
    ]).catch(() => null)
    if (steps) {
      const timeline: Array<{ name: string; at: number }> = []
      for (const job of steps.jobs ?? []) {
        for (const step of job.steps ?? []) {
          if (step.status !== 'completed') continue
          if (step.conclusion === 'skipped') continue
          timeline.push({
            name: step.conclusion === 'success' ? step.name : `${step.name} (${step.conclusion})`,
            at: step.started_at ? new Date(step.started_at).getTime() : Date.now(),
          })
        }
      }
      if (timeline.length > 0) updateJob(jobId, { steps: timeline })
    }

    if (info.status === 'completed') {
      const ok = info.conclusion === 'success'

      const logs = await tryRun(bin, ['run', 'view', String(runId), '--repo', repo, '--log'], {
        timeoutMs: 180_000,
      })
      if (logs.stdout.trim()) {
        appendLog(jobId, logs.stdout.split('\n').slice(-4000).join('\n'))
      } else if (logs.stderr.trim()) {
        appendLog(jobId, `(日志获取失败: ${logs.stderr.trim()})`)
      }

      const artifacts = await tryRun(bin, ['api', `repos/${repo}/actions/runs/${runId}/artifacts`])
      if (artifacts.code === 0) {
        try {
          const parsed = JSON.parse(artifacts.stdout) as {
            artifacts: Array<{ name: string; size_in_bytes: number }>
          }
          updateJob(jobId, {
            artifacts: parsed.artifacts.map((a) => ({
              name: a.name,
              path: '',
              size: a.size_in_bytes,
              url: `${url}/artifacts`,
            })),
          })
        } catch {
          /* ignore */
        }
      }
      if (getJob(jobId)?.status === 'cancelled') return
      updateJob(jobId, {
        status: ok ? 'succeeded' : 'failed',
        finishedAt: Date.now(),
        remote: { status: info.status, conclusion: info.conclusion ?? undefined },
        ...(ok ? {} : { error: `workflow 结束: ${info.conclusion}` }),
      })
      return
    }
    await sleep(15_000)
  }
}

/**
 * Ask GitHub to cancel a run. Without this a "cancelled" build keeps running in
 * the user's repository and keeps consuming their Actions minutes.
 */
export async function cancelGhaRun(job: { ghRepo?: string; ghRunId?: number }): Promise<boolean> {
  if (!job.ghRepo || !job.ghRunId) return false
  const result = await tryRun(ghBin(), ['run', 'cancel', String(job.ghRunId), '--repo', job.ghRepo])
  return result.code === 0
}

/** Download the run's artifacts into the job directory. */
export async function downloadGhaArtifacts(jobId: string): Promise<string> {
  const job = getJob(jobId)
  if (!job?.ghRunId || !job.ghRepo) throw new Error('该任务没有关联的 GitHub Actions run')
  const target = path.join(job.dir ?? '', 'gh-artifacts')
  fs.mkdirSync(target, { recursive: true })
  const r = await tryRun(ghBin(), ['run', 'download', String(job.ghRunId), '--repo', job.ghRepo, '--dir', target], {
    timeoutMs: 900_000,
  })
  if (r.code !== 0) throw new Error(r.stderr.trim())
  return target
}
