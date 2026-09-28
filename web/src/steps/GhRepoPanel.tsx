import { useCallback, useEffect, useState } from 'react'
import type { GhBackend } from '@rsdk-webui/shared'
import { api, type RepoSetupResult, type RepoStatus } from '../api.ts'
import { Button, Chip, Field, Note, Select, TextInput, Toggle } from '../ui.tsx'

/**
 * The GitHub Actions "build worker" repository.
 *
 * The model: the user owns the repository (their fork, a template copy, or one
 * we create for them). We only ever commit the workflow to its default branch
 * and push `build/<id>` branches into it.
 */
export function GhRepoPanel({
  gh,
  setGh,
  ghAvailable,
  ghLogin,
  onRepoChange,
}: {
  gh: GhBackend
  setGh: (p: Partial<GhBackend>) => void
  ghAvailable: boolean
  ghLogin?: string
  onRepoChange: (repo: string) => void
}) {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState<RepoSetupResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [create, setCreate] = useState(false)
  const [isPrivate, setIsPrivate] = useState(true)

  const refresh = useCallback(async (repo: string) => {
    if (!repo.includes('/')) {
      setStatus(null)
      return
    }
    try {
      setStatus(await api.ghRepo(repo))
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    }
  }, [])

  useEffect(() => {
    setSetup(null)
    setError(null)
    const timer = setTimeout(() => void refresh(gh.repo), 250)
    return () => clearTimeout(timer)
  }, [gh.repo, refresh])

  const runSetup = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.ghSetup(gh.repo, { create, isPrivate })
      setSetup(result)
      setStatus(result.status)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const healthy =
    status?.exists && status.actionsEnabled !== false && status.workflowOnDefaultBranch === true

  return (
    <>
      <Field
        label="构建仓库 (owner/name)"
        desc="fork 本项目、用模板建一个，或点下面的按钮创建。构建包只推到它自己的分支"
      >
        <TextInput mono value={gh.repo} onChange={(v) => onRepoChange(v)} placeholder="your-name/rsdk-webui-builds" />
      </Field>

      <div className="row tight" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <Toggle
          checked={create}
          onChange={setCreate}
          title="不存在时自动创建"
          desc="用 gh CLI 在你的账号下新建一个私有仓库"
        />
        <div style={{ flex: 'none', minWidth: 150 }}>
          <Field label="可见性">
            <Select
              value={isPrivate ? 'private' : 'public'}
              onChange={(v) => setIsPrivate(v === 'private')}
              options={[
                { label: '私有（推荐）', value: 'private' },
                { label: '公开', value: 'public' },
              ]}
            />
          </Field>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant={healthy ? 'default' : 'primary'} disabled={busy || !gh.repo.includes('/') || !ghAvailable} onClick={() => void runSetup()}>
          {busy ? '处理中…' : healthy ? '重新同步 workflow' : '准备仓库'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh(gh.repo)}>
          重新检测
        </Button>
        {status?.htmlUrl && (
          <a href={status.htmlUrl} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12 }}>
            打开仓库 ↗
          </a>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <Note tone="danger">{error}</Note>
        </div>
      )}

      {status && (
        <div style={{ marginTop: 12 }}>
          <div className="chips">
            <Chip tone={status.exists ? 'accent' : 'danger'}>{status.exists ? '仓库存在' : '仓库不存在'}</Chip>
            {status.exists && <Chip>{status.private ? '私有' : '公开'}</Chip>}
            {status.fork && <Chip tone="info">fork</Chip>}
            <Chip tone={status.actionsEnabled === false ? 'danger' : 'accent'}>
              Actions {status.actionsEnabled === false ? '已禁用' : status.actionsEnabled ? '已启用' : '未知'}
            </Chip>
            <Chip tone={status.workflowOnDefaultBranch ? 'accent' : 'warn'}>
              workflow {status.workflowOnDefaultBranch ? '已就位' : '缺失'}
            </Chip>
            <Chip tone={status.hasPages === false ? 'warn' : 'accent'}>
              Pages {status.hasPages === false ? '未开启' : status.hasPages ? '已开启' : '未知'}
            </Chip>
          </div>
          {status.needsManualActionEnable && (
            <div style={{ marginTop: 8 }}>
              <Note tone="warn">
                这是 fork 仓库，GitHub 默认关闭它的 Actions。你的 token 没有管理员权限，无法代你开启：
                请打开 <span className="mono">{status.htmlUrl}/actions</span> 点一次确认按钮。
              </Note>
            </div>
          )}
        </div>
      )}

      {setup && (
        <div style={{ marginTop: 12 }}>
          <Note tone={setup.status.actionsEnabled === false ? 'warn' : 'ok'}>
            <div className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {setup.steps.length > 0 ? setup.steps.map((s) => `· ${s}`).join('\n') : '无需改动'}
            </div>
            {setup.log && setup.log.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer' }}>详细日志</summary>
                <pre className="code" style={{ marginTop: 6, maxHeight: 180 }}>
                  {setup.log.join('\n')}
                </pre>
              </details>
            )}
          </Note>
        </div>
      )}

      {ghAvailable ? (
        <div style={{ marginTop: 12 }}>
          <Note tone="info">
            gh CLI 已登录为 <span className="mono">{ghLogin}</span>。需要 <span className="mono">repo</span> 与{' '}
            <span className="mono">workflow</span> 两个 scope：<span className="mono">gh auth refresh -s workflow</span>
          </Note>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <Note tone="danger">gh CLI 不可用或未登录，先执行 gh auth login。</Note>
        </div>
      )}
    </>
  )
}
