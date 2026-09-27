import { useEffect, useState } from 'react'
import { api, type Job } from '../api.ts'
import { Button, Card, Chip, StatusPill, ago, duration } from '../ui.tsx'

export function JobsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    api
      .jobs()
      .then(setJobs)
      .catch((err) => setError(String(err instanceof Error ? err.message : err)))

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [])

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const done = jobs.filter((j) => !active.includes(j))

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>构建记录</h1>
          <p>本机容器与 GitHub Actions 的构建都记在这里，点击查看实时日志。</p>
        </div>
        <div className="spacer" />
        <Button onClick={() => void refresh()}>刷新</Button>
      </div>

      {error && <p className="faint">{error}</p>}

      {active.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <Card title="进行中">
            <div>
              {active.map((job) => (
                <JobRow key={job.id} job={job} onOpen={onOpen} />
              ))}
            </div>
          </Card>
        </div>
      )}

      <Card title="历史" hint={`${done.length} 条`}>
        {done.length === 0 ? (
          <div className="empty">还没有构建记录</div>
        ) : (
          <div>
            {done.map((job) => (
              <JobRow key={job.id} job={job} onOpen={onOpen} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function JobRow({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="job" onClick={() => onOpen(job.id)}>
      <StatusPill status={job.status} />
      <div className="title">
        <strong>{job.title}</strong>
        <span>
          {job.id} · {job.backend}
          {job.steps.length > 0 && ` · ${job.steps.at(-1)!.name}`}
        </span>
      </div>
      <Chip>{duration(job.startedAt, job.finishedAt)}</Chip>
      <span className="faint" style={{ fontSize: 11.5, minWidth: 70, textAlign: 'right' }}>
        {ago(job.createdAt)}
      </span>
    </button>
  )
}
