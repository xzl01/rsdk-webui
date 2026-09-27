import { useEffect, useRef, useState } from 'react'
import { renderRsdkArgs } from '@rsdk-webui/shared'
import { comboKey, type PreflightResult } from '@rsdk-webui/shared'
import { api } from '../api.ts'
import { Button, Card, Chip, Note, StatusPill, Toggle } from '../ui.tsx'
import type { StepProps } from './types.ts'

export function ReviewStep({ profile, patch, env, goto, mode, verdicts }: StepProps) {
  const [check, setCheck] = useState<PreflightResult | null>(null)
  const [ghCheck, setGhCheck] = useState<{ ok: boolean; message: string; url?: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [started, setStarted] = useState<string | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const preflightRequest = useRef(0)

  const runPreflight = async (force = false) => {
    const request = ++preflightRequest.current
    setChecking(true)
    setCheck(null)
    setPreflightError(null)
    try {
      const result = await api.preflight(profile, force)
      if (request === preflightRequest.current) setCheck(result)
    } catch (err) {
      if (request === preflightRequest.current) setPreflightError(String(err instanceof Error ? err.message : err))
    } finally {
      if (request === preflightRequest.current) setChecking(false)
    }
  }

  useEffect(() => {
    void runPreflight()
    return () => { preflightRequest.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.target.product, profile.target.suite, profile.repos.testRepo, profile.repos.radxaMirror, profile.packages.kernelOverride, profile.packages.firmwareOverride, profile.packages.localDebsDir, profile.packages.debsUrls])

  // the GitHub backend has its own set of prerequisites; check them before the
  // user waits for a push that would fail anyway
  useEffect(() => {
    setGhCheck(null)
    if (profile.backend.kind !== 'gh-actions') {
      return
    }
    const repo = profile.backend.repo
    if (!repo.includes('/')) {
      setGhCheck({ ok: false, message: '未填写构建仓库 (owner/name)' })
      return
    }
    let stale = false
    api
      .ghRepo(repo)
      .then((status: import('../api.ts').RepoStatus) => {
        if (stale) return
        if (!status.exists) {
          setGhCheck({ ok: false, message: `仓库 ${repo} 不存在或无权访问（可在「构建后端」点「准备仓库」创建）` })
        } else if (status.actionsEnabled === false) {
          setGhCheck({
            ok: false,
            message: '该仓库的 Actions 被禁用（fork 默认如此），请在「构建后端」点「准备仓库」启用',
            url: `${status.htmlUrl ?? `https://github.com/${repo}`}/actions`,
          })
        } else if (!status.workflowOnDefaultBranch) {
          setGhCheck({
            ok: false,
            message: `默认分支 ${status.defaultBranch} 上没有 .github/workflows/build.yml，「准备仓库」可以补上`,
          })
        } else {
          setGhCheck({ ok: true, message: `仓库就绪：${repo}（${status.private ? '私有' : '公开'}）` })
        }
      })
      .catch(() => !stale && setGhCheck({ ok: false, message: '无法查询仓库状态' }))
    return () => {
      stale = true
    }
  }, [profile.backend])

  const start = async () => {
    if (checking || submitting || !check || preflightError || blockers.length > 0) return
    setSubmitting(true)
    setStartError(null)
    try {
      const job = await api.startBuild(profile)
      setStarted(job.id)
      goto(`job:${job.id}`)
    } catch (err) {
      setStartError(String(err instanceof Error ? err.message : err))
    } finally {
      setSubmitting(false)
    }
  }

  // the prerequisites differ per backend: a local build needs a container
  // engine and the image, a GitHub build needs a usable repository. Checking
  // `engine.ok` unconditionally used to disable the start button for the whole
  // backend-less (Pages) mode, where there is no engine at all.
  const missingPackages = check?.missing.filter((name) => !check.localPackages?.provided.includes(name)) ?? []
  const blockers: string[] = []
  if (preflightError) blockers.push('软件源预检失败，请重新检查')
  else if (!check || checking) blockers.push('软件源预检尚未完成')
  else if (check.repos.length === 0) blockers.push('缺少软件包索引，无法完成构建前预检')
  else if (missingPackages.length > 0) blockers.push(`必需软件包缺失：${missingPackages.join(', ')}`)
  if (profile.backend.kind === 'local-docker') {
    if (!env?.engine.ok) blockers.push('没有可用的容器引擎')
    if (!env?.image.present) blockers.push('rsdk 容器镜像尚未导入')
  } else {
    if (!profile.backend.repo) blockers.push('未填写 GitHub 构建仓库')
    if (!env?.gh.available) {
      blockers.push(mode === 'static' ? '还没有连接 GitHub' : 'gh CLI 未登录')
    }
    if (!ghCheck) blockers.push('GitHub 构建仓库尚未检查完成')
    else if (!ghCheck.ok) blockers.push(ghCheck.message)
  }
  if (!env?.buildTree.ready) {
    blockers.push(env?.buildTree.error ?? 'rsdk jsonnet 树不可用')
  }
  const verdict = verdicts?.combos[comboKey(profile.target.product, profile.target.suite, profile.target.edition)]
  if (verdict?.status === 'broken') {
    blockers.push(verdict.hint ?? '这个组合上游无法构建（缺包），换一个 suite/edition 或板子')
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(320px,1fr)' }}>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Card
          title="构建前预检"
          hint={check ? new Date(check.checkedAt).toLocaleTimeString('zh-CN') : undefined}
          actions={
            <Button size="sm" variant="ghost" disabled={checking || submitting} onClick={() => void runPreflight(true)}>
              {checking ? '检查中…' : '重新检查'}
            </Button>
          }
        >
          <div className="body">
            {preflightError && <Note tone="danger">{preflightError}</Note>}
            {!check && !preflightError && <p className="faint" style={{ margin: 0 }}>正在检查软件源…</p>}
            {check && (
              <>
                <div className="chips" style={{ marginBottom: 12 }}>
                  {check.repos.map((r: PreflightResult['repos'][number]) => (
                    <Chip key={r.label} tone={r.exists ? 'accent' : 'danger'}>
                      {r.label} {r.exists ? `${r.packageCount} 包` : '不存在'}
                    </Chip>
                  ))}
                </div>
                {check.repos.length === 0 ? (
                  <Note tone="warn">{check.suggestion ?? '没有可用的软件包索引，无法完成构建前预检。'}</Note>
                ) : missingPackages.length === 0 ? (
                  <Note tone="ok">
                    必需的内核 / u-boot / 板级包都能在软件源或本地软件包中找到：
                    <span className="mono"> {check.required.join(', ')}</span>
                  </Note>
                ) : (
                  <>
                    <Note tone="danger">
                      以下必需软件包在当前软件源里找不到，构建会在组装完基础系统之后失败：
                      <div className="mono" style={{ marginTop: 4 }}>
                        {missingPackages.join(', ')}
                      </div>
                    </Note>
                    {check.suggestTestRepo && (
                      <div style={{ marginTop: 10 }}>
                        <Note tone="info">{check.suggestion}</Note>
                        <div style={{ marginTop: 8 }}>
                          <Toggle
                            checked={profile.repos.testRepo}
                            onChange={(v) => patch({ repos: { ...profile.repos, testRepo: v } })}
                            title="改用测试源 (-test)"
                            desc="rsdk build --test-repo"
                          />
                        </div>
                      </div>
                    )}
                    {!check.suggestTestRepo && check.suggestion && (
                      <div style={{ marginTop: 10 }}>
                        <Note tone="warn">{check.suggestion}</Note>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </Card>

        {profile.backend.kind === 'gh-actions' && (
          <Card title="GitHub 构建仓库">
            <div className="body">
              {!ghCheck && <p className="faint" style={{ margin: 0 }}>正在检查仓库…</p>}
              {ghCheck && (
                <Note tone={ghCheck.ok ? 'ok' : 'warn'}>
                  {ghCheck.message}
                  {ghCheck.url && (
                    <>
                      {' '}
                      <a href={ghCheck.url} target="_blank" rel="noreferrer">
                        打开 Actions 页面 ↗
                      </a>
                    </>
                  )}
                </Note>
              )}
            </div>
          </Card>
        )}

        <Card title="将要执行">
          <div className="body">
            <pre className="code wrap">{`rsdk ${renderRsdkArgs(profile).join(' ')}`}</pre>
            <p className="desc">
              {profile.backend.kind === 'local-docker'
                ? '这条命令会在 rsdk 容器里执行；外面再套一层 podman/docker run（–-privileged、挂载 /dev、独立 storage root）。'
                : '这条命令会在 GitHub Actions 的 ubuntu-latest 上执行，构建包先推送到仓库分支。'}
            </p>
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Card title="方案摘要">
          <div className="body">
            <dl className="kv">
              <dt>名称</dt>
              <dd>{profile.meta.name}</dd>
              <dt>板子</dt>
              <dd>{profile.target.product}</dd>
              <dt>系统</dt>
              <dd>
                {profile.target.suite} / {profile.target.edition}
              </dd>
              <dt>扇区</dt>
              <dd>{profile.target.sectorSize} B</dd>
              <dt>软件源</dt>
              <dd>
                {profile.repos.testRepo ? 'test' : 'stable'}
                {profile.repos.radxaMirror ? ' · 第三方镜像' : ''}
                {profile.repos.snapshot ? ` · snapshot ${profile.repos.snapshot}` : ''}
              </dd>
              <dt>额外软件包</dt>
              <dd>{profile.packages.install.length} 个</dd>
              <dt>移除软件包</dt>
              <dd>{profile.packages.purge.length} 个</dd>
              <dt>覆盖文件</dt>
              <dd>{profile.files.filter((f) => f.enabled).length} 个</dd>
              <dt>自定义脚本</dt>
              <dd>{profile.hooks.pre.filter((h) => h.enabled).length} 个</dd>
              <dt>用户</dt>
              <dd>{profile.system.user ? profile.system.user.name : '不创建'}</dd>
              <dt>Wi-Fi</dt>
              <dd>{profile.system.wifi ? profile.system.wifi.ssid : '不配置'}</dd>
              <dt>后端</dt>
              <dd>{profile.backend.kind === 'local-docker' ? `本机 ${profile.backend.engine}` : `GitHub ${profile.backend.repo}`}</dd>
            </dl>
          </div>
        </Card>

        <Card title="开始构建">
          <div className="body">
            {startError && <div style={{ marginBottom: 12 }}><Note tone="danger">{startError}</Note></div>}
            {blockers.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Note tone="warn">
                  以下条件尚未满足：
                  <ul style={{ margin: '5px 0 0 16px', padding: 0 }}>
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </Note>
              </div>
            )}
            <Button variant="primary" disabled={checking || submitting || blockers.length > 0} onClick={() => void start()}>
              {submitting ? '提交中…' : '开始构建'}
            </Button>
            {started && (
              <p className="desc">
                已提交 <span className="mono">{started}</span>
              </p>
            )}
            <hr className="sep" />
            <p className="desc" style={{ margin: 0 }}>
              {profile.backend.kind === 'local-docker' ? (
                <>提交后可以在「构建记录」查看实时日志。生成的 bundle 保存在{' '}
                  <span className="mono">{env?.server.dataDir}/builds/&lt;job-id&gt;</span>。</>
              ) : (
                <>提交后可以在「构建记录」查看进度，构建产物会出现在 GitHub Actions 的 artifact 中。</>
              )}
            </p>
          </div>
        </Card>

        <Card title="环境状态">
          <div className="body">
            <dl className="kv">
              {profile.backend.kind === 'local-docker' ? (
                <>
                  <dt>容器引擎</dt>
                  <dd>{env?.engine.ok ? `${env.engine.kind} ${env.engine.version.split(' ').pop()}` : '不可用'}</dd>
                  <dt>镜像</dt>
                  <dd>{env?.image.present ? env.image.ref : '未导入'}</dd>
                </>
              ) : (
                <>
                  <dt>构建位置</dt>
                  <dd>GitHub Actions</dd>
                  <dt>仓库</dt>
                  <dd>{profile.backend.repo || '未填写'}</dd>
                </>
              )}
              <dt>rsdk</dt>
              <dd>{env?.buildTree.rsdkVersion ?? '未知'}</dd>
              <dt>{mode === 'static' ? 'GitHub 授权' : 'gh CLI'}</dt>
              <dd>{env?.gh.available ? env.gh.login : '未登录'}</dd>
            </dl>
          </div>
        </Card>
      </div>
    </div>
  )
}
