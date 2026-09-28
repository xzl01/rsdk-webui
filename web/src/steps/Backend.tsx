import type { EnvStatus, GhBackend, LocalBackend } from '@rsdk-webui/shared'
import { GhRepoPanel } from './GhRepoPanel.tsx'
import { Card, Chip, Field, Note, Select, TextInput, Toggle, bytes } from '../ui.tsx'
import { useBackendEnv } from '../useBackendEnv.ts'
import type { StepProps } from './types.ts'

export function BackendStep({ profile, patch, env: baseEnv, mode }: StepProps) {
  const env = useBackendEnv(profile.backend, baseEnv)
  const staticMode = mode === 'static'
  const gh = profile.backend.kind === 'gh-actions' ? (profile.backend as GhBackend) : null
  const local = profile.backend.kind === 'local-docker' ? (profile.backend as LocalBackend) : null

  const setGh = (p: Partial<GhBackend>) => patch({ backend: { ...(gh ?? defaultGh(baseEnv)), ...p } })
  const setLocal = (p: Partial<LocalBackend>) => patch({ backend: { ...(local ?? defaultLocal(baseEnv)), ...p } })

  const setKind = (kind: 'local-docker' | 'gh-actions') => {
    if (kind === 'gh-actions') setGh({})
    else setLocal({})
  }

  return (
    <div className="grid-2">
      <Card title="构建位置">
        <div className="body">
          <div className="chips" style={{ marginBottom: 14 }}>
            {!staticMode && (
              <button className={`btn${local ? ' primary' : ''}`} onClick={() => setKind('local-docker')}>
                本机容器
              </button>
            )}
            <button className={`btn${gh ? ' primary' : ''}`} onClick={() => setKind('gh-actions')}>
              GitHub Actions
            </button>
          </div>
          {staticMode && (
            <div style={{ marginBottom: 14 }}>
              <Note tone="info">
                静态站点没有本机容器，构建在你的仓库里由 Actions 跑。
                想本地构建就 clone 仓库跑 <span className="mono">pnpm start</span>。
              </Note>
            </div>
          )}

          {local ? (
            <>
              <Field label="容器引擎" desc="rsdk build 需要 SYS_ADMIN、/dev 与 qemu-user-static，官方镜像里都已就绪">
                <Select
                  value={local.engine}
                  onChange={(v) => setLocal({ engine: v as 'podman' | 'docker' })}
                  options={[
                    { label: 'podman', value: 'podman' },
                    { label: 'docker', value: 'docker' },
                  ]}
                />
              </Field>
              <Field label="镜像">
                <TextInput mono value={local.image} onChange={(v) => setLocal({ image: v })} />
              </Field>
              {env?.image.present ? (
                <Note tone="ok">
                  镜像已就绪：<span className="mono">{env.image.ref}</span> · {bytes(env.image.sizeBytes)}
                  {env.engine.args.length > 0 && (
                    <>
                      <br />
                      使用独立 storage root（<span className="mono">{env.engine.args.join(' ')}</span>），不影响你现有的 podman 容器
                    </>
                  )}
                </Note>
              ) : (
                <Note tone="warn">
                  本机还没有 <span className="mono">{env?.image.ref ?? 'rsdk-image:latest'}</span>，请先到「环境准备」导入。
                </Note>
              )}
            </>
          ) : null}

          {gh ? (
            <>
              <GhRepoPanel
                gh={gh}
                setGh={setGh}
                ghAvailable={!!env?.gh.available}
                ghLogin={env?.gh.login}
                onRepoChange={(v) => setGh({ repo: v })}
              />
              <hr className="sep" />
              <Field
                label="分支前缀"
                desc="每个方案一个分支，构建包推到 <前缀>/<方案id>。workflow 只监听 build/** 和 runs/**，只能二选一。"
              >
                <Select
                  value={gh.branchPrefix === 'runs' ? 'runs' : 'build'}
                  onChange={(v) => setGh({ branchPrefix: v })}
                  options={[
                    { label: 'build/', value: 'build' },
                    { label: 'runs/', value: 'runs' },
                  ]}
                />
              </Field>
              <div className="toggle-list">
                <Toggle
                  checked={gh.compress}
                  onChange={(v) => setGh({ compress: v })}
                  title="上传前 xz 压缩镜像"
                  desc="artifact 从 4.6GB 降到 ~1GB，多花几分钟"
                />
                <Toggle
                  checked={gh.publishRelease}
                  onChange={(v) => setGh({ publishRelease: v })}
                  title="同时发布为 Release"
                  desc="再建一个可长期下载的 Release"
                />
              </div>
              <div style={{ height: 10 }} />
              <Note tone="warn">
                构建包提交到 <span className="mono">{gh.branchPrefix}/&lt;id&gt;</span> 分支。
                profile 里有 Wi-Fi 密码就别用公开仓库。
              </Note>
            </>
          ) : null}
        </div>
      </Card>

      <Card title="两种后端对比">
        <div className="body">
          <dl className="kv" style={{ gridTemplateColumns: '92px 1fr' }}>
            {!staticMode && (
              <>
                <dt>本机容器</dt>
                <dd>
                  用官方 rsdk-image，等同 Radxa CI。arm64 走 qemu-user，
                  一个 CLI 镜像约 20–60 分钟。
                </dd>
              </>
            )}
            <dt>GitHub Actions</dt>
            <dd>
              你把本项目 <b>fork</b> 一份（或用 <span className="mono">Use this template</span> 建一个），
              webUI 只往<b>你自己那个仓库</b>推构建分支：<span className="mono">build/&lt;profile-id&gt;</span>。
              仓库里的 workflow 只是转手跑同一条 <span className="mono">run.sh</span>，代码、token 都不经过任何第三方仓库。
            </dd>
            <dt>产物</dt>
            <dd>
              两者都产出 <span className="mono">out/&lt;product&gt;_&lt;suite&gt;_&lt;edition&gt;/</span> 下的
              <span className="mono"> output.img</span>、<span className="mono">build-image</span>、
              <span className="mono">*.rootfs.tar</span>。
            </dd>
          </dl>
          <hr className="sep" />
          <div className="chips">
            <Chip tone="accent">同一份 bundle</Chip>
            <Chip>同一条 run.sh</Chip>
            <Chip>可离线重放</Chip>
            <Chip>只推你自己的仓库</Chip>
          </div>
          <div style={{ marginTop: 14 }}>
            <Note tone="info">
              构建完全由 bundle 目录里的纯文本描述。把它拷到任何机器上
              <span className="mono"> ./fetch-image.sh &amp;&amp; ./run.sh</span> 就能复现。
            </Note>
          </div>
        </div>
      </Card>
    </div>
  )
}

function defaultLocal(env: EnvStatus | null): LocalBackend {
  return {
    kind: 'local-docker',
    engine: env?.engine.kind === 'docker' ? 'docker' : 'podman',
    image: env?.image.ref ?? 'rsdk-image:latest',
  }
}

function defaultGh(env: EnvStatus | null): GhBackend {
  return {
    kind: 'gh-actions',
    repo: env?.gh.login ? `${env.gh.login}/rsdk-webui-build` : '',
    branchPrefix: 'build',
    publishRelease: false,
    compress: true,
    keepBranch: true,
  }
}
