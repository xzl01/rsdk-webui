import { useMemo, useState } from 'react'
import { Button, Card, Chip, Field, Note, TextInput } from '../ui.tsx'
import { connect, type GhSession } from '../api.ts'

/** Where the project lives - overridable so a fork can point at itself. */
const UPSTREAM = import.meta.env.VITE_UPSTREAM_REPO ?? 'xzl01/rsdk-webui'
const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? 'https://xzl01.github.io/rsdk-webui/'

const PERMISSIONS = [
  ['Contents', 'Read and write', '提交 build/<id> 分支（里面是完整的构建包）'],
  ['Actions', 'Read and write', '触发、取消、读取 run 与 artifact'],
  ['Workflows', 'Read and write', '提交 .github/workflows/build.yml'],
  ['Pages', 'Read and write', '帮你在仓库里把 Pages 打开，不用手点 Settings'],
  ['Metadata', 'Read-only', 'GitHub 强制要求的，用于读取仓库信息'],
] as const

/**
 * First screen of the backend-less (GitHub Pages) build.
 *
 * There is no server here, so the browser talks to api.github.com directly.
 * Note what is *not* possible: GitHub's OAuth endpoints live on github.com,
 * which sends no CORS headers (api.github.com does), so a static page cannot
 * run OAuth or the device flow. A pasted token is the only option - so the job
 * here is to make that two clicks and to keep the privilege as small as
 * possible.
 */
export function Connect({
  onConnected,
  clientId,
}: {
  onConnected: (session: GhSession) => void
  /** set when a local OAuth app is configured; the device flow then works */
  clientId?: string
}) {
  const [token, setToken] = useState('')
  const [repo, setRepo] = useState(() => localStorage.getItem('rsdk-webui.last-repo') ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const owner = repo.includes('/') ? repo.split('/')[0] : ''

  // GitHub's token page accepts the name, owner, expiry and permissions as
  // query parameters, so this lands on a form that is already filled in.
  const tokenUrl = useMemo(() => {
    const params = new URLSearchParams({
      name: `rsdk-webui (${repo || 'build worker'})`,
      description: `提交构建分支并触发 Actions，来源 ${PAGES_URL}`,
      expires_in: '90',
      contents: 'write',
      actions: 'write',
      workflows: 'write',
      pages: 'write',
      metadata: 'read',
    })
    if (owner) params.set('target_name', owner)
    return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`
  }, [owner, repo])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await connect(token, repo)
      localStorage.setItem('rsdk-webui.last-repo', session.repo)
      onConnected(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = token.trim().length > 0 && /^[^/\s]+\/[^/\s]+$/.test(repo.trim())

  return (
    <div className="connect-screen">
      <div className="page-head">
        <div>
          <h1>连接你的 GitHub 仓库</h1>
          <p>
            纯静态页面，没有后端。构建跑在你自己的仓库里，token 只发往
            <span className="mono"> api.github.com</span>。
          </p>
        </div>
      </div>

      <div className="connect-steps">
        <Card title="① 准备一个你自己的仓库" hint="二选一">
          <div className="body">
            <div className="chips" style={{ marginBottom: 14 }}>
              <a className="btn" href={`https://github.com/${UPSTREAM}/generate`} target="_blank" rel="noreferrer">
                用模板创建（推荐）↗
              </a>
              <a className="btn" href={`https://github.com/${UPSTREAM}/fork`} target="_blank" rel="noreferrer">
                Fork 一份 ↗
              </a>
            </div>
            <p className="desc" style={{ margin: '0 0 12px' }}>
              模板：Actions 直接可用。Fork：要手动启用 Actions。
            </p>
            <Field label="仓库名（owner/name）" desc="就是你刚创建的那个">
              <TextInput mono value={repo} onChange={setRepo} placeholder="your-name/rsdk-webui" />
            </Field>
          </div>
        </Card>

        <Card title="② 创建一个只授权这个仓库的 token">
          <div className="body">
            <p className="desc" style={{ marginTop: 0 }}>
              用 <b>fine-grained token</b>，别用 classic（那是整个账号的权限）。
              下面的链接已填好仓库、权限和有效期，点 <span className="mono">Generate token</span>。
            </p>
            <div className="chips" style={{ margin: '12px 0' }}>
              <a className="btn primary" href={tokenUrl} target="_blank" rel="noreferrer">
                打开预填好的 token 页面 ↗
              </a>
              <a
                className="btn ghost"
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
              >
                或手动新建 ↗
              </a>
            </div>
            <p className="desc" style={{ marginBottom: 0 }}>
              确认只授权这个仓库，有效期尽量短。
            </p>
            <details className="help-details">
              <summary>查看所需权限与 token 保存说明</summary>
              <p className="desc">如果权限没有预填，请按下表勾选：</p>
              <div className="table-scroll"><table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr className="faint">
                  <th style={{ textAlign: 'left', padding: '4px 0' }}>权限</th>
                  <th style={{ textAlign: 'left' }}>级别</th>
                  <th style={{ textAlign: 'left' }}>用途</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map(([name, level, why]) => (
                  <tr key={name}>
                    <td className="mono" style={{ padding: '3px 0' }}>
                      {name}
                    </td>
                    <td>{level}</td>
                    <td className="faint">{why}</td>
                  </tr>
                ))}
              </tbody>
              </table></div>
            <div style={{ marginTop: 12 }}>
              <Note tone="warn">
                token 存在浏览器 <span className="mono">localStorage</span> 里，能打开这个站点的人都能读走。
                所以：只用细粒度 token、只勾这一个仓库、有效期设短一点。不用了去
                <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
                  {' '}
                  设置里撤销 ↗
                </a>
                。
              </Note>
            </div>
            </details>
            {clientId && (
              <div style={{ marginTop: 12 }}>
                <Note tone="info">
                  这个部署配置了 OAuth App，也可以用设备码授权（免粘贴）—— 见下方「用 GitHub 授权登录」。
                </Note>
              </div>
            )}
          </div>
        </Card>

        <Card title="③ 粘贴并连接">
          <div className="body">
            <Field label="Fine-grained token">
              <TextInput type="password" mono value={token} onChange={setToken} placeholder="github_pat_…" />
            </Field>
            {error && (
              <div style={{ marginTop: 12 }}>
                <Note tone="danger">{error}</Note>
              </div>
            )}
            <div className="actions" style={{ marginTop: 16, borderTop: 'none', paddingTop: 0 }}>
              <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
                {busy ? '验证中…' : '连接'}
              </Button>
              <div className="spacer" />
              <div className="chips">
                <Chip tone="accent">无需后端</Chip>
                <Chip>token 只发给 api.github.com</Chip>
              </div>
            </div>
          </div>
        </Card>

        <Card title="不想碰 token？在本地跑">
          <div className="body">
            <p className="desc" style={{ marginTop: 0 }}>
              clone 下来跑 <span className="mono">pnpm start</span>，就换成用你机器的 podman/docker
              直接构建：<b>不需要任何 token</b>（直接用你本机已登录的 <span className="mono">gh</span>），
              也不消耗 GitHub 的 Actions 分钟数。两种模式共用同一份 <span className="mono">profile</span>。
            </p>
            <pre className="code wrap">{`git clone https://github.com/${UPSTREAM}
cd ${UPSTREAM.split('/')[1]} && ./ops/setup.sh && pnpm install && pnpm start`}</pre>
          </div>
        </Card>

        <Card title="常见问题">
          <div className="body">
            <dl className="kv" style={{ gridTemplateColumns: '190px minmax(0,1fr)' }}>
              <dt>为什么不能用 GitHub 账号授权直接登录？</dt>
              <dd>
                GitHub 的 OAuth 端点在 <span className="mono">github.com</span> 上，而它
                <b>不返回 CORS 头</b>（只有 <span className="mono">api.github.com</span> 返回），
                所以纯静态页面无法完成换 token 的请求 —— 这条只能靠一个后端中转。本地模式是有的。
              </dd>
              <dt>Pushed branch 是什么？</dt>
              <dd>
                每次构建会推一个 <span className="mono">build/&lt;profile-id&gt;</span> 分支，
                里面是完整的构建描述（profile.json / run.sh / customize/ / rsdk-build/）。
                因为仓库是公开的，<b>不要在里面放 Wi-Fi 密码或密码哈希</b>。
              </dd>
              <dt>Actions 分钟数够吗？</dt>
              <dd>
                公开仓库不限量。私有仓库每月免费 2000 分钟，而一次 arm64 构建约 60–90 分钟 —— 大约一天一次。
                <a href="https://github.com/settings/billing" target="_blank" rel="noreferrer">
                  {' '}
                  查看用量 ↗
                </a>
              </dd>
              <dt>Pages 需要手动开吗？</dt>
              <dd>
                如果用「Use this template」，<span className="mono">pages.yml</span> 会自动跑；
                但创建 Pages 站点需要仓库管理员权限，Actions 的 token 没有 ——
                报错里会给出去
                <a href={`https://github.com/${UPSTREAM}/settings/pages`} target="_blank" rel="noreferrer">
                  {' '}
                  Settings → Pages{' '}
                </a>
                打开一次。
              </dd>
            </dl>
          </div>
        </Card>
      </div>
    </div>
  )
}
