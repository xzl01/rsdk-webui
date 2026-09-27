import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  defaultProduct,
  normalizeForProduct,
  type Catalog,
  type EnvStatus,
  type Profile,
} from '@rsdk-webui/shared'
import { comboKey, type BoardVerdicts } from '@rsdk-webui/shared'
import {
  api,
  currentMode,
  detectMode,
  disconnect,
  getSession,
  loadStoredSession,
  onSessionChange,
  resetBackend,
  type GhSession,
} from './api.ts'
import { Connect } from './views/Connect.tsx'
import { BackendStep } from './steps/Backend.tsx'
import { HooksStep } from './steps/Hooks.tsx'
import { PackagesStep } from './steps/Packages.tsx'
import { ReposStep } from './steps/Repos.tsx'
import { ReviewStep } from './steps/Review.tsx'
import { SystemStep } from './steps/System.tsx'
import { TargetStep } from './steps/Target.tsx'
import type { StepProps } from './steps/types.ts'
import { Button, Chip, Note, StatusPill } from './ui.tsx'
import { JobView } from './views/JobView.tsx'
import { JobsView } from './views/JobsView.tsx'
import { PreviewPanel } from './views/PreviewPanel.tsx'
import { SetupView } from './views/SetupView.tsx'

const STEPS = [
  { id: 'target', label: '开发板与系统', hint: '选板子' },
  { id: 'repos', label: '软件源', hint: '镜像' },
  { id: 'packages', label: '软件包', hint: '加包' },
  { id: 'system', label: '系统配置', hint: '用户' },
  { id: 'hooks', label: '覆盖与脚本', hint: '文件' },
  { id: 'backend', label: '构建后端', hint: '在哪跑' },
  { id: 'review', label: '确认构建', hint: '开始' },
]

type Route = { kind: 'wizard' } | { kind: 'jobs' } | { kind: 'job'; id: string } | { kind: 'setup' }

export default function App() {
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [step, setStep] = useState('target')
  const [route, setRoute] = useState<Route>({ kind: 'wizard' })
  const [preview, setPreview] = useState(false)
  const [saved, setSaved] = useState<Profile[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [mode, setMode] = useState<'server' | 'static' | null>(null)
  const [session, setSession] = useState<GhSession | null>(null)
  const [verdicts, setVerdicts] = useState<BoardVerdicts | null>(null)

  const refreshEnv = useCallback(async () => {
    try {
      const e = await api.env()
      setEnv(e)
      return e
    } catch (err) {
      setFatal(String(err instanceof Error ? err.message : err))
      return null
    }
  }, [])

  const bootstrap = useCallback(async () => {
    const e = await refreshEnv()
    try {
      const c = await api.catalog()
      setCatalog(c)
      const fresh = await api.newProfile(defaultProduct(c.products)?.product)
      setProfile((prev) => prev ?? fresh)
    } catch (err) {
      setFatal(String(err instanceof Error ? err.message : err))
    }
    void e
    api.profiles().then(setSaved).catch(() => undefined)
  }, [refreshEnv])

  useEffect(() => {
    void (async () => {
      const detected = await detectMode()
      setMode(detected)
      // deploy-time board verdicts (only the static build ships them)
      fetch('boards.json')
        .then((r) => (r.ok ? (r.json() as Promise<BoardVerdicts>) : null))
        .then(setVerdicts)
        .catch(() => undefined)
      if (detected === 'static') {
        setSession(loadStoredSession())
      }
    })()
  }, [])

  // static mode: everything depends on having a session, so (re)load when it
  // appears or disappears
  useEffect(() => {
    if (mode === null) return
    if (mode === 'static' && !session) {
      setProfile(null)
      setCatalog(null)
      return
    }
    void bootstrap()
  }, [mode, session, bootstrap])

  useEffect(() => onSessionChange(setSession), [])

  const patch = useCallback((p: Partial<Profile>) => {
    setProfile((prev) => (prev ? { ...prev, ...p } : prev))
  }, [])

  const setForProduct = useCallback((next: Profile) => {
    const product = catalog?.products.find((p) => p.product === next.target.product)
    return normalizeForProduct(next, product)
  }, [catalog])

  const removeProfile = async (target: Profile) => {
    if (!confirm(`删除方案「${target.meta.name}」？此操作不可撤销。`)) return
    try {
      await api.deleteProfile(target.id)
      setSaved(await api.profiles())
      // if it was the one being edited, start from a clean slate rather than
      // keeping an unsaved copy around
      if (profile?.id === target.id) {
        setProfile(setForProduct(await api.newProfile()))
        setStep('target')
      }
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    }
  }

  const save = async () => {
    if (!profile) return
    try {
      // the backend may normalise (e.g. clamp suite/edition to what the board
      // supports) - apply what it actually stored
      setProfile(await api.saveProfile(profile))
      setSaved(await api.profiles())
      setToast('方案已保存')
      setTimeout(() => setToast(null), 2200)
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    }
  }

  const statusChip = useMemo(() => {
    if (mode === 'static') {
      return session ? (
        <>
          <Chip tone="info">GitHub Pages</Chip>
          <Chip tone="accent">{session.repo}</Chip>
        </>
      ) : (
        <Chip>GitHub Pages</Chip>
      )
    }
    if (!env) return <Chip>检测中…</Chip>
    if (!env.engine.ok) return <Chip tone="danger">无容器引擎</Chip>
    if (!env.image.present) return <Chip tone="warn">镜像未导入</Chip>
    if (!env.buildTree.ready) return <Chip tone="danger">构建树不可用</Chip>
    return <Chip tone="accent">{env.engine.kind} · rsdk {env.buildTree.rsdkVersion ?? '?'}</Chip>
  }, [env, mode, session])

  useEffect(() => {
    if (route.kind === 'wizard' && window.innerWidth <= 860) {
      document.querySelector('.rail .step.active')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    }
  }, [step, route.kind, mode, session])

  if (mode === 'static' && !session) {
    return (
      <div className="app connect-app">
        <header className="topbar">
          <div className="brand">
            <span className="dot" />
            rsdk-webui
            <small>GitHub Pages · 静态模式</small>
          </div>
          <div className="spacer" />
          <Chip tone="info">无后端</Chip>
        </header>
        <nav className="rail" />
        <main className="main">
          <Connect
            onConnected={(next) => {
              resetBackend()
              setSession(next)
            }}
          />
        </main>
      </div>
    )
  }

  if (fatal && !catalog) {
    return (
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <span className="dot" />
            rsdk-webui
          </div>
        </div>
        <div className="rail" />
        <div className="main">
          <Note tone="danger">
            {fatal}
            <div style={{ marginTop: 10 }}>
              如果还没有导入 rsdk 容器镜像，先到「环境准备」执行导入。
            </div>
            <div style={{ marginTop: 12 }}>
              <Button onClick={() => void bootstrap()}>重试</Button>
              <Button variant="ghost" onClick={() => setRoute({ kind: 'setup' })}>
                打开环境准备
              </Button>
            </div>
          </Note>
          {route.kind === 'setup' && (
            <div style={{ marginTop: 16 }}>
              <SetupView
                mode={mode ?? 'server'}
                env={env}
                onRefresh={() => void refreshEnv()}
                onOpenJob={(id) => setRoute({ kind: 'job', id })}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  const stepProps: StepProps | null = profile
    ? {
        mode: mode ?? 'server',
        verdicts,
        profile,
        patch,
        catalog,
        env,
        goto: (target) => {
          if (target.startsWith('job:')) setRoute({ kind: 'job', id: target.slice(4) })
          else setStep(target)
        },
      }
    : null

  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const currentVerdict = profile
    ? verdicts?.combos[comboKey(profile.target.product, profile.target.suite, profile.target.edition)]
    : undefined

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          rsdk-webui
          <small>RadxaOS 镜像定制</small>
        </div>
        <div className="spacer" />
        {statusChip}
        <Button size="sm" variant={route.kind === 'wizard' ? 'primary' : 'ghost'} onClick={() => setRoute({ kind: 'wizard' })}>
          定制
        </Button>
        <Button size="sm" variant={route.kind === 'jobs' || route.kind === 'job' ? 'primary' : 'ghost'} onClick={() => setRoute({ kind: 'jobs' })}>
          构建记录
        </Button>
        <Button size="sm" variant={route.kind === 'setup' ? 'primary' : 'ghost'} onClick={() => setRoute({ kind: 'setup' })}>
          {mode === 'static' ? '构建仓库' : '环境准备'}
        </Button>
        {mode === 'static' && session && (
          <Button
            size="sm"
            variant="ghost"
            title={`已连接 ${session.login} · 点击断开`}
            onClick={() => {
              disconnect()
              resetBackend()
              setSession(null)
            }}
          >
            断开 {session.login}
          </Button>
        )}
        {route.kind === 'wizard' && (
          <Button size="sm" variant={preview ? 'primary' : 'ghost'} onClick={() => setPreview((v) => !v)}>
            预览生成物
          </Button>
        )}
      </header>

      <nav className="rail" aria-label="页面导航">
        {route.kind === 'wizard' ? (
          <>
            <h4>定制流程</h4>
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                className={`step${s.id === step ? ' active' : ''}`}
                aria-current={s.id === step ? 'step' : undefined}
                onClick={() => setStep(s.id)}
              >
                <span className="num">{i + 1}</span>
                <span className="label">{s.label}</span>
              </button>
            ))}
            <h4 style={{ marginTop: 18 }}>已保存方案</h4>
            <div className="rail-profile-actions">
              <Button
                size="sm"
                onClick={async () => {
                  const next = await api.newProfile()
                  setProfile(setForProduct(next))
                  setStep('target')
                }}
              >
                新建
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void save()} disabled={!profile}>
                保存
              </Button>
            </div>
            {saved.length === 0 && <p className="faint rail-empty">还没有保存过</p>}
            {saved.map((p) => (
              <div className="saved-profile-row" key={p.id}>
                <button
                  className={`step saved-profile${profile?.id === p.id ? ' active' : ''}`}
                  onClick={() => setProfile(setForProduct(p))}
                  title={`${p.meta.name} · ${p.target.product} · ${p.target.suite}/${p.target.edition}`}
                  aria-label={`打开方案 ${p.meta.name}，${p.target.product}，${p.target.suite}/${p.target.edition}`}
                >
                  <span className="num">◆</span>
                  <span className="profile-text"><span className="label">{p.meta.name}</span><small>{p.target.product} · {p.target.suite}</small></span>
                </button>
                <button
                  className="profile-delete"
                  title={`删除方案「${p.meta.name}」`}
                  aria-label={`删除方案 ${p.meta.name}`}
                  onClick={() => void removeProfile(p)}
                >
                  ×
                </button>
              </div>
            ))}
          </>
        ) : (
          <>
            <h4>导航</h4>
            <button className="step" onClick={() => setRoute({ kind: 'wizard' })}>
              <span className="num">←</span>
              <span className="label">返回定制</span>
            </button>
          </>
        )}
      </nav>

      <main className="main">
        {toast && (
          <div style={{ position: 'sticky', top: 0, zIndex: 5 }}>
            <Note tone="ok">{toast}</Note>
          </div>
        )}

        {currentVerdict && currentVerdict.status !== 'ok' && route.kind === 'wizard' && (
          <div style={{ marginBottom: 16 }}>
            <Note tone={currentVerdict.status === 'broken' ? 'danger' : 'warn'}>
              <b>
                {profile?.target.product} / {profile?.target.suite} / {profile?.target.edition}
                {currentVerdict.status === 'broken' ? ' 上游无法构建' : ' 需要测试源'}
              </b>
              <div style={{ marginTop: 4 }}>{currentVerdict.hint}</div>
              {currentVerdict.missing && currentVerdict.missing.length > 0 && (
                <div className="mono" style={{ marginTop: 4, fontSize: 11.5 }}>
                  {currentVerdict.missing.join(' · ').slice(0, 220)}
                </div>
              )}
            </Note>
          </div>
        )}

        {route.kind === 'setup' && (
          <SetupView
            mode={mode ?? 'server'}
            env={env}
            onRefresh={() => void refreshEnv()}
            onOpenJob={(id) => setRoute({ kind: 'job', id })}
            onGotoBackend={() => {
              setRoute({ kind: 'wizard' })
              setStep('backend')
            }}
          />
        )}

        {route.kind === 'jobs' && <JobsView onOpen={(id) => setRoute({ kind: 'job', id })} />}

        {route.kind === 'job' && <JobView jobId={route.id} onBack={() => setRoute({ kind: 'jobs' })} />}

        {route.kind === 'wizard' && stepProps && (
          <div className={`wizard-layout${preview ? ' with-preview' : ''}`}>
            <div>
              <div className="page-head">
                <div>
                  <h1>{STEPS[stepIndex]?.label}</h1>
                  <p>
                    {step === 'target' && '选择目标板子与系统版本，后续可选值会自动跟随该板子的 BSP 支持范围。'}
                    {step === 'repos' && '决定从哪里取包。国内网络建议换成 USTC / 清华镜像。'}
                    {step === 'packages' && '在 edition 预置集合之上增删软件包。建立索引后可以按包名和描述搜索。'}
                    {step === 'system' && '主机名、时区、首个用户、SSH 与 Wi-Fi，全部在构建时写进镜像。'}
                    {step === 'hooks' && '往 rootfs 里塞文件，或直接跑自己的脚本。'}
                    {step === 'backend' && '选择在本机容器里构建，还是丢给 GitHub Actions。'}
                    {step === 'review' && '最后检查一遍：预检会提前发现软件包缺失，避免白等半小时。'}
                  </p>
                </div>
              </div>

              {!profile && (
                <div className="card">
                  <div className="empty">
                    <span className="spin" style={{ width: 18, height: 18, borderWidth: 3 }} />
                    <div style={{ marginTop: 12 }}>正在读取 rsdk 元数据…</div>
                    <div className="faint" style={{ marginTop: 6, fontSize: 12 }}>
                      板子列表直接来自容器镜像里的 rsdk，第一次需要从镜像里导出 jsonnet 树。
                    </div>
                  </div>
                </div>
              )}

              {profile && (
                <>
                  {step === 'target' && <TargetStep {...stepProps!} />}
                  {step === 'repos' && <ReposStep {...stepProps!} />}
                  {step === 'packages' && <PackagesStep {...stepProps!} />}
                  {step === 'system' && <SystemStep {...stepProps!} />}
                  {step === 'hooks' && <HooksStep {...stepProps!} />}
                  {step === 'backend' && <BackendStep {...stepProps!} />}
                  {step === 'review' && <ReviewStep {...stepProps!} />}

                  <div className="actions">
                    <Button disabled={stepIndex === 0} onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].id)}>
                      ← 上一步
                    </Button>
                    <Button
                      variant="primary"
                      disabled={stepIndex >= STEPS.length - 1}
                      onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)].id)}
                    >
                      下一步 →
                    </Button>
                    <div className="spacer" />
                    <span className="faint mono" style={{ fontSize: 11.5 }}>
                      {profile.id} · {profile.target.product}/{profile.target.suite}/{profile.target.edition}
                    </span>
                  </div>
                </>
              )}
            </div>

            {preview && profile && <PreviewPanel profile={profile} onClose={() => setPreview(false)} />}
          </div>
        )}
      </main>
    </div>
  )
}
