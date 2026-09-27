import { useEffect, useMemo, useRef, useState } from 'react'
import { api, currentMode, type Job } from '../api.ts'
import { Button, Card, Chip, Note, StatusPill, ago, bytes, duration } from '../ui.tsx'

const MAX_CHARS = 400_000
const VISIBLE_LINES = 2000

export function JobView({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [log, setLog] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)
  const offsetRef = useRef(0)

  useEffect(() => {
    offsetRef.current = 0
    setLog('')
    setJob(null)
  }, [jobId])

  // static (GitHub Pages) mode has no server to stream from: poll instead
  useEffect(() => {
    if (currentMode() !== 'static') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const current = await api.job(jobId)
        if (stopped) return
        setJob(current)
        const chunk = await api.log(jobId, offsetRef.current)
        if (stopped) return
        if (chunk.text) {
          offsetRef.current = chunk.offset
          setLog((prev) => {
            const next = prev + chunk.text
            return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next
          })
        }
        if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return
      } catch {
        /* keep polling */
      }
      timer = setTimeout(tick, 4000)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [jobId])

  useEffect(() => {
    if (currentMode() === 'static') return
    let source: EventSource | null = null
    let stopped = false
    let attempts = 0

    const connect = () => {
      source = new EventSource(`/api/jobs/${jobId}/stream?offset=${offsetRef.current}`)
      source.addEventListener('log', (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { text: string; offset: number }
        offsetRef.current = data.offset
        setLog((prev) => {
          const next = prev + data.text
          return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next
        })
      })
      source.addEventListener('status', (event) => {
        setJob(JSON.parse((event as MessageEvent).data) as Job)
      })
      source.addEventListener('end', () => {
        source?.close()
        void api.job(jobId).then(setJob).catch(() => undefined)
      })
      // a bounded number of reconnects: the job may have been pruned, in which
      // case the SSE endpoint answers 404 forever
      source.onerror = () => {
        source?.close()
        if (!stopped && attempts++ < 5) setTimeout(connect, 2000)
      }
    }

    void api.job(jobId).then(setJob).catch(() => undefined)
    connect()
    return () => {
      stopped = true
      source?.close()
    }
  }, [jobId])

  const lines = useMemo(() => {
    const all = log.split('\n')
    return all.length > VISIBLE_LINES ? all.slice(all.length - VISIBLE_LINES) : all
  }, [log])

  useEffect(() => {
    if (autoScroll && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [lines.length, autoScroll])

  const running = job?.status === 'running' || job?.status === 'queued'
  const isGh = job?.backend === 'gh-actions'
  const isStatic = currentMode() === 'static'

  return (
    <div className="grid-2 job-view" style={{ gridTemplateColumns: 'minmax(0,1fr) 320px' }}>
      <Card
        className="job-log"
        title={job ? job.title : '加载中…'}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onBack}>
              返回列表
            </Button>
            {running && (
              <Button size="sm" variant="danger" onClick={() => void api.cancelJob(jobId)}>
                取消
              </Button>
            )}
          </>
        }
      >
        <div className="body" style={{ paddingBottom: 0 }}>
          <div className="row tight" style={{ alignItems: 'center', marginBottom: 12 }}>
            {job && <StatusPill status={job.status} />}
            {job && <Chip>{job.backend}</Chip>}
            {job && <Chip>{job.id}</Chip>}
            <div style={{ flex: 1 }} />
            <label className="toggle" style={{ padding: '3px 9px', width: 'auto' }}>
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              <span className="box">{autoScroll ? '✓' : ''}</span>
              <span className="text">
                <strong>自动滚动</strong>
              </span>
            </label>
          </div>
          {job?.error && <Note tone={job.status === 'cancelled' ? 'warn' : 'danger'}>{job.error}</Note>}
          {log.length > MAX_CHARS && (
            <p className="desc">日志过长，仅保留最后 {Math.round(MAX_CHARS / 1000)}K 字符（完整日志见 bundle）。</p>
          )}
        </div>
        <div className="body" style={{ paddingTop: 10 }}>
          {!log && running && isStatic && (
            <div style={{ marginBottom: 12 }}>
              <Note tone="info">
                GitHub 只在 run <b>结束之后</b>才提供日志，所以构建期间这里是空的。
                进度看「进度」时间线（直接从 run 的步骤同步），或者
                {job?.ghRunUrl ? (
                  <>
                    {' '}
                    <a href={job.ghRunUrl} target="_blank" rel="noreferrer">
                      打开 Actions 页面看实时输出 ↗
                    </a>
                  </>
                ) : (
                  ' 到 Actions 页面看实时输出'
                )}
                。
              </Note>
            </div>
          )}
          {log ? (
            <pre className="code log" ref={preRef}>{lines.join('\n')}</pre>
          ) : (
            <div className="log-placeholder">{running ? '等待构建日志…' : '这次构建没有日志'}</div>
          )}
        </div>
      </Card>

      <div className="job-sidebar">
        {job && (job.steps.length > 0 || running) && <Card title="进度" className="job-progress">
          <div className="body">
            {job && job.steps.length > 0 ? (
              <div className="timeline">
                {job.steps.slice(-14).map((step) => (
                  <div className="tl-item" key={step.name + step.at}>
                    <span className="bullet" />
                    <span>{step.name}</span>
                    <span className="time">{new Date(step.at).toLocaleTimeString('zh-CN')}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                {job?.status === 'queued'
                  ? '构建正在排队，开始后会显示阶段。'
                  : job?.status === 'running'
                    ? '正在等待首个构建阶段。'
                    : '这次运行没有阶段记录。'}
              </p>
            )}
          </div>
        </Card>}

        <Card title="详情">
          <div className="body">
            <dl className="kv">
              <dt>创建</dt>
              <dd>{job ? ago(job.createdAt) : '—'}</dd>
              <dt>耗时</dt>
              <dd>{job ? duration(job.startedAt, job.finishedAt) : '—'}</dd>
              <dt>退出码</dt>
              <dd>{job?.exitCode ?? '—'}</dd>
              {job?.dir && (
                <>
                  <dt>Bundle</dt>
                  <dd style={{ fontSize: 11 }}>{job.dir}</dd>
                </>
              )}
              {job?.ghRunUrl && (
                <>
                  <dt>Workflow</dt>
                  <dd>
                    <a href={job.ghRunUrl} target="_blank" rel="noreferrer">
                      查看运行
                    </a>
                  </dd>
                </>
              )}
              {job?.ghBranch && (
                <>
                  <dt>分支</dt>
                  <dd>{job.ghBranch}</dd>
                </>
              )}
            </dl>
          </div>
        </Card>

        {isGh && job?.status === 'succeeded' && (
          <Card title="Actions Artifacts">
            <div className="body">
              {(job.artifacts?.length ?? 0) === 0 ? (
                <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                  没有 artifact。
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {job.artifacts!.map((a) => (
                    <li key={a.name}>
                      <a href={a.url} target="_blank" rel="noreferrer">
                        {a.name}
                      </a>{' '}
                      <span className="faint mono">{bytes(a.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {api.downloadGha && (
                <div style={{ marginTop: 10 }}>
                  <Button
                    size="sm"
                    onClick={() =>
                      void api.downloadGha!(jobId).then(
                        (r: { dir: string }) => alert(`已下载到 ${r.dir}`),
                        (err: unknown) => alert(String(err)),
                      )
                    }
                  >
                    用 gh 下载到本机
                  </Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {(job?.artifacts?.length ?? 0) > 0 && job?.backend === 'local-docker' && (
          <Card title="产物">
            <div className="body">
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {job.artifacts!.map((a) => (
                  <li key={a.path}>
                    <a href={a.url}>{a.name}</a> <span className="faint mono">{bytes(a.size)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
