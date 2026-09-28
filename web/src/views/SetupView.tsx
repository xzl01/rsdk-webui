import { useEffect, useRef, useState } from 'react'
import type { EnvStatus } from '@rsdk-webui/shared'
import { api, type Job } from '../api.ts'
import { Button, Card, Chip, Note, StatusPill, bytes } from '../ui.tsx'

export function SetupView({
  env,
  onRefresh,
  onOpenJob,
  mode,
  onGotoBackend,
}: {
  env: EnvStatus | null
  onRefresh: () => void
  onOpenJob: (id: string) => void
  mode: 'server' | 'static'
  onGotoBackend?: () => void
}) {
  const [job, setJob] = useState<Job | null>(null)
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offsetRef = useRef(0)

  const startFetch = async () => {
    setBusy(true)
    setError(null)
    setLog('')
    offsetRef.current = 0
    try {
      if (!api.fetchImage) throw new Error('当前模式（GitHub Pages）没有本地容器，构建由 Actions 完成')
      const { jobId } = await api.fetchImage()
      setJob(await api.job(jobId))
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!job) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const chunk = await api.log(job.id, offsetRef.current)
        if (stopped) return
        if (chunk.text) {
          offsetRef.current = chunk.offset
          setLog((prev) => prev + chunk.text)
        }
        const current = await api.job(job.id)
        if (stopped) return
        setJob(current)
        if (current.status === 'succeeded') {
          onRefresh()
          return
        }
        if (current.status === 'failed') return
      } catch {
        /* keep polling */
      }
      timer = setTimeout(poll, 1000)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id])

  if (mode === 'static') {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>构建仓库</h1>
            <p>静态模式（GitHub Pages）没有本机容器，构建全部在你的仓库里由 Actions 完成。</p>
          </div>
          <div className="spacer" />
          <Button onClick={onRefresh}>重新检测</Button>
        </div>
        <div className="grid-2">
          <Card title="仓库状态">
            <div className="body">
              <dl className="kv">
                <dt>仓库</dt>
                <dd>{env?.gh.repo?.repo ?? '（未设置）'}</dd>
                <dt>存在</dt>
                <dd>{env?.gh.repo?.exists ? '是' : '否'}</dd>
                <dt>可见性</dt>
                <dd>{env?.gh.repo?.private === undefined ? '—' : env.gh.repo.private ? '私有' : '公开'}</dd>
                <dt>fork</dt>
                <dd>{env?.gh.repo?.fork ? '是（Actions 默认关闭）' : '否'}</dd>
                <dt>Actions</dt>
                <dd>
                  {env?.gh.repo?.actionsEnabled === false
                    ? '已禁用'
                    : env?.gh.repo?.actionsEnabled
                      ? '已启用'
                      : '未知'}
                </dd>
                <dt>workflow</dt>
                <dd>{env?.gh.repo?.workflowOnDefaultBranch ? '已在默认分支' : '缺失'}</dd>
              </dl>
              {env?.gh.repo?.htmlUrl && (
                <div className="chips" style={{ marginTop: 12 }}>
                  <a className="btn sm" href={`${env.gh.repo.htmlUrl}/actions`} target="_blank" rel="noreferrer">
                    Actions 页面 ↗
                  </a>
                  <a className="btn sm" href={`${env.gh.repo.htmlUrl}/settings/pages`} target="_blank" rel="noreferrer">
                    Settings → Pages ↗
                  </a>
                  <a className="btn sm" href={`${env.gh.repo.htmlUrl}/actions/workflows/build.yml`} target="_blank" rel="noreferrer">
                    构建 workflow ↗
                  </a>
                  <a className="btn sm" href="https://github.com/settings/billing" target="_blank" rel="noreferrer">
                    Actions 用量 ↗
                  </a>
                </div>
              )}
              {(!env?.gh.repo?.exists || !env.gh.repo.workflowOnDefaultBranch) && (
                <div style={{ marginTop: 12 }}>
                  <Note tone="warn">
                    仓库还不可用。到「构建后端」点「准备仓库」：它会补上 workflow 并尝试打开 Actions。
                  </Note>
                  {onGotoBackend && (
                    <div style={{ marginTop: 10 }}>
                      <Button variant="primary" onClick={onGotoBackend}>
                        去构建后端
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card title="静态模式怎么工作">
            <div className="body">
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.8 }} className="dim">
                <li>
                  板子列表、jsonnet 树、包索引都在部署这个站点时从
                  <b>同一个 rsdk 镜像</b>里导出成静态文件，所以不会出现"UI 有但构建机没有"的情况。
                </li>
                <li>
                  浏览器里把你的方案组装成完整 bundle（含打过补丁的
                  <span className="mono"> rootfs.jsonnet</span>）。
                </li>
                <li>
                  用 Git Data API 把 bundle 提交到 <span className="mono">build/&lt;id&gt;</span> 分支 ——
                  这一步就触发了 workflow。
                </li>
                <li>
                  轮询 run 状态、拉日志、列举 artifact，全部直接调 api.github.com。
                </li>
              </ol>
              <div style={{ marginTop: 14 }}>
                <Note tone="info">
                  本机构建仍然可用：clone 仓库跑 <span className="mono">pnpm start</span>，换成 podman/docker 后端。
                </Note>
              </div>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>环境准备</h1>
          <p>
            rsdk build 需要 bdebstrap、qemu-user-static、libguestfs、jsonnet 和 SYS_ADMIN 权限。
            在本机用容器跑，就不会污染系统。
          </p>
        </div>
        <div className="spacer" />
        <Button onClick={onRefresh}>重新检测</Button>
      </div>

      <div className="grid-2">
        <Card title="容器运行时">
          <div className="body">
            <dl className="kv">
              <dt>引擎</dt>
              <dd>{env?.engine.ok ? `${env.engine.kind} (${env.engine.version})` : env?.engine.error ?? '检测中…'}</dd>
              <dt>rootless</dt>
              <dd>{env?.engine.rootless ? '是（--userns=keep-id）' : '否'}</dd>
              <dt>存储参数</dt>
              <dd>{env?.engine.args?.length ? env.engine.args.join(' ') : '默认存储'}</dd>
            </dl>
            {env?.engine.args && env.engine.args.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Note tone="info">
                  默认 podman 存储在 btrfs 上用不了 overlay 驱动，已自动给 rsdk-webui 单独一个 storage root
                  （<span className="mono">{env.engine.args.join(' ')}</span>），你原有的 podman 容器完全不受影响。
                </Note>
              </div>
            )}
            {env && !env.engine.ok && (
              <div style={{ marginTop: 12 }}>
                <Note tone="danger">没有找到可用的 podman 或 docker。请先安装其中之一。</Note>
              </div>
            )}
          </div>
        </Card>

        <Card title="rsdk 构建环境">
          <div className="body">
            <dl className="kv">
              <dt>镜像</dt>
              <dd>
                {env?.image.present ? (
                  <>
                    {env.image.ref} · {bytes(env.image.sizeBytes)}
                  </>
                ) : (
                  env?.image.ref ?? '—'
                )}
              </dd>
              <dt>rsdk 版本</dt>
              <dd>{env?.buildTree.rsdkVersion ?? '—'}</dd>
              <dt>jsonnet 树</dt>
              <dd>{env?.buildTree.ready ? env.buildTree.path : '不可用'}</dd>
              <dt>注入点</dt>
              <dd>{env?.buildTree.anchorOk ? '+ cleanup() 已确认' : '—'}</dd>
            </dl>
            {env?.buildTree.error && (
              <div style={{ marginTop: 12 }}>
                <Note tone="warn">{env.buildTree.error}</Note>
              </div>
            )}
            <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
              <Button variant="primary" disabled={busy || !env?.engine.ok} onClick={() => void startFetch()}>
                {env?.image.present ? '重新导入镜像' : '导入官方 rsdk 镜像'}
              </Button>
              <span className="faint" style={{ fontSize: 12 }}>
                下载 radxa-pkg/rsdk-image 的 .deb（约 480MB）并从中解出 image.tar
              </span>
            </div>
            {error && (
              <div style={{ marginTop: 10 }}>
                <Note tone="danger">{error}</Note>
              </div>
            )}
            {job && (
              <div style={{ marginTop: 12 }}>
                <div className="row tight" style={{ alignItems: 'center' }}>
                  <StatusPill status={job.status} />
                  <span className="faint mono">{job.id}</span>
                  <div style={{ flex: 1 }} />
                  <Button size="sm" variant="ghost" onClick={() => onOpenJob(job.id)}>
                    在构建页查看
                  </Button>
                </div>
                <pre className="code" style={{ maxHeight: 200, marginTop: 10 }}>
                  {log.split('\n').slice(-14).join('\n') || '准备中…'}
                </pre>
              </div>
            )}
          </div>
        </Card>

        <Card title="GitHub CLI">
          <div className="body">
            {env?.gh.available ? (
              <Note tone="ok">
                已登录为 <span className="mono">{env.gh.login}</span>，可以使用 GitHub Actions 后端。
              </Note>
            ) : (
              <Note tone="warn">
                未检测到可用的 gh 登录（{env?.gh.error ?? '未知'}）。执行 <span className="mono">gh auth login</span> 后
                点「重新检测」。需要 <span className="mono">repo</span> 与 <span className="mono">workflow</span> 权限。
              </Note>
            )}
          </div>
        </Card>

        <Card title="它是怎么工作的">
          <div className="body">
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }} className="dim">
              <li>
                从官方镜像里导出 <span className="mono">/usr/share/rsdk/build</span> 的 jsonnet 树（缓存起来）。
              </li>
              <li>
                在 <span className="mono">rootfs.jsonnet</span> 的 <span className="mono">+ cleanup()</span> 之后追加一项，
                指向我们自己生成的 <span className="mono">customize/install.sh</span>。
              </li>
              <li>
                构建时用这份打了补丁的树覆盖容器里的 <span className="mono">/usr/share/rsdk/build</span>（只读挂载），
                上游文件一个字节都不改。
              </li>
              <li>
                <span className="mono">install.sh</span> 在 bdebstrap 的 customize 阶段运行，负责装包、写文件、
                建用户、配置首次开机。
              </li>
              <li>
                产物落在 <span className="mono">work/out/&lt;product&gt;_&lt;suite&gt;_&lt;edition&gt;/</span>，整个
                bundle 目录可直接拷走离线重放。
              </li>
            </ol>
            <div style={{ marginTop: 12 }} className="chips">
              <Chip tone="accent">不改上游</Chip>
              <Chip>bundle 可审计</Chip>
              <Chip>本机 / Actions 同一条路径</Chip>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
