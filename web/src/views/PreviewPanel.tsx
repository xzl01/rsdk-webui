import { useEffect, useState } from 'react'
import type { Profile } from '@rsdk-webui/shared'
import { api, type RenderResult } from '../api.ts'
import { Button } from '../ui.tsx'

const TABS = ['命令', 'profile.json', 'install.sh', 'inner.sh', 'run.sh', 'rootfs.jsonnet 片段', 'README.md']

export function PreviewPanel({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [result, setResult] = useState<RenderResult | null>(null)
  const [tab, setTab] = useState(TABS[0])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stale = false
    setBusy(true)
    const timer = setTimeout(() => {
      api
        .render(profile)
        .then((r) => {
          if (!stale) {
            setResult(r)
            setError(null)
          }
        })
        .catch((err) => !stale && setError(String(err instanceof Error ? err.message : err)))
        .finally(() => !stale && setBusy(false))
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(profile)])

  const fileFor = (name: string) => result?.files.find((f) => f.path.endsWith(name))
  const content = (() => {
    if (!result) return '加载中…'
    switch (tab) {
      case '命令':
        return result.command
      case 'rootfs.jsonnet 片段':
        return (
          [
            '在 upstream rootfs.jsonnet 中，',
            '  + cleanup()',
            '被替换为',
            '  + cleanup()',
            '  + { mmdebstrap+: { "customize-hooks"+: [',
            `        "bash /rsdk-bundle/customize/install.sh \\"$1\\"",`,
            '    ] } }',
          ].join('\n')
        )
      default:
        return fileFor(tab)?.content ?? '（未生成）'
    }
  })()

  const download = () => {
    const blob = new Blob([JSON.stringify(profile, null, 2) + '\n'], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `profile-${profile.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <aside className="preview-panel">
      <header>
        <strong>生成物预览</strong>
        {busy && <span className="spin" />}
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={download}>
          导出 profile
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} title="关闭">
          ×
        </Button>
      </header>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab${t === tab ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {error && <p style={{ padding: '0 14px', color: 'var(--danger)', fontSize: 12.5 }}>{error}</p>}
      <pre className="code wrap">
        {content}
      </pre>
      <footer>
        这些文件就是提交构建时写进 bundle 的内容，与服务端生成的完全一致。
      </footer>
    </aside>
  )
}
