import { useCallback, useEffect, useState } from 'react'
import { PACKAGE_PRESETS, type PackageSearchHit } from '@rsdk-webui/shared'
import { api, type Job } from '../api.ts'
import { Button, Card, Chip, Field, Note, StatusPill, TextInput, Toggle } from '../ui.tsx'
import { KernelOverridePanel } from './KernelOverridePanel.tsx'
import type { StepProps } from './types.ts'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

function usePackageIndex(product: string, suite: string) {
  const [meta, setMeta] = useState<{ count: number; builtAt: number } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.indexStatus(product, suite)
      setMeta(r.meta)
      return r.meta
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
      return null
    }
  }, [product, suite])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // poll the index job while it runs
  useEffect(() => {
    if (!jobId) return
    let stop = false
    const tick = async () => {
      try {
        const j = await api.job(jobId)
        if (stop) return
        setJob(j)
        if (j.status === 'succeeded') {
          setJobId(null)
          setJob(null)
          await refresh()
          return
        }
        if (j.status === 'failed') {
          setJobId(null)
          setError(j.error ?? '建立索引失败')
          return
        }
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(tick, 1200)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [jobId, refresh])

  const build = useCallback(
    async (force = false) => {
      setError(null)
      try {
        if (!api.buildIndex) throw new Error('当前模式不支持建立索引')
        const r = await api.buildIndex(product, suite, force)
        if (r.cached) await refresh()
        else setJobId(r.jobId ?? null)
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err))
      }
    },
    [product, suite, refresh],
  )

  return { meta, job, error, build, refresh }
}

export function PackagesStep({ profile, patch, catalog }: StepProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PackageSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [purgeInput, setPurgeInput] = useState('')
  const debounced = useDebounced(query, 220)

  const { meta, job, error: indexError, build } = usePackageIndex(profile.target.product, profile.target.suite)
  const install = profile.packages.install
  const purge = profile.packages.purge

  useEffect(() => {
    if (!meta) return
    let stale = false
    setSearching(true)
    api
      .searchPackages(profile.target.product, profile.target.suite, debounced, 80)
      .then((r) => {
        if (!stale) {
          setHits(r.hits)
          setSearchError(null)
        }
      })
      .catch((err) => !stale && setSearchError(String(err instanceof Error ? err.message : err)))
      .finally(() => !stale && setSearching(false))
    return () => {
      stale = true
    }
  }, [debounced, meta, profile.target.product, profile.target.suite])

  const setInstall = (list: string[]) => patch({ packages: { ...profile.packages, install: list } })
  const setPurge = (list: string[]) => patch({ packages: { ...profile.packages, purge: list } })

  const add = (name: string) => {
    if (install.includes(name)) return
    setInstall([...install, name].sort())
  }
  const remove = (name: string) => setInstall(install.filter((p) => p !== name))

  const applyPreset = (packages: string[]) => {
    setInstall([...new Set([...install, ...packages])].sort())
  }

  const addCustom = () => {
    const name = query.trim()
    if (!name || install.includes(name)) return
    add(name)
    setQuery('')
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Card
          title="附加软件包"
          hint={
            meta
              ? meta.count > 0
                ? `索引 ${meta.count} 个包`
                : '索引已部署（静态模式不预载数量）'
              : '尚未建立索引'
          }
          actions={
            !api.buildIndex ? (
              <Chip tone={meta ? 'accent' : 'warn'}>{meta ? '静态索引' : '索引未部署'}</Chip>
            ) : meta ? (
              <Button size="sm" variant="ghost" onClick={() => build(true)}>
                重建索引
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!!job} onClick={() => build(false)}>
                {job ? '建立中…' : '建立索引'}
              </Button>
            )
          }
        >
          <div className="body" style={{ paddingBottom: 10 }}>
            <div className="row tight">
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder={meta ? '搜索软件包名或描述…' : '建立索引后可按包名搜索'}
              />
              {query.trim() && (
                <div style={{ flex: 'none' }}>
                  <Button onClick={addCustom}>添加 “{query.trim()}”</Button>
                </div>
              )}
            </div>
            {meta && (
              <p className="desc" style={{ marginTop: 7 }}>
                索引来自 {profile.target.suite} 的 radxa-deb 与上游 arm64 仓库
                {meta.count > 0 && ` （${meta.count} 个包）`}
                {searching && <span className="spin" style={{ marginLeft: 8 }} />}
              </p>
            )}
            {!meta && !api.buildIndex && (
              <div style={{ marginTop: 10 }}>
                <Note tone="warn">
                  这个站点没有为 <span className="mono">{profile.target.suite}</span>{' '}
                  部署索引，只能手输包名。部署时加 <span className="mono">--with-index</span> 即可。
                </Note>
              </div>
            )}
            {indexError && (
              <div style={{ marginTop: 10 }}>
                <Note tone="danger">{indexError}</Note>
              </div>
            )}
            {job && (
              <div style={{ marginTop: 10 }}>
                <Note tone="info">
                  <StatusPill status={job.status} /> {job.steps.at(-1)?.name ?? '正在下载 Packages 索引（约 10–30MB）…'}
                </Note>
              </div>
            )}
          </div>

          <div className="body" style={{ paddingTop: 0 }}>
            {searchError && <Note tone="danger">{searchError}</Note>}
            {meta && hits.length === 0 && !searching && (
              <div className="empty">{query ? '没有匹配的软件包' : '输入关键词开始搜索'}</div>
            )}
            <div className="pkg-list">
              {hits.map((hit) => {
                const already = install.includes(hit.name)
                return (
                  <button
                    key={hit.name}
                    className={`pkg${hit.radxa ? ' radxa' : ''}`}
                    onClick={() => (already ? remove(hit.name) : add(hit.name))}
                  >
                    <span className="name">{hit.name}</span>
                    <span className="desc">{hit.description}</span>
                    <span style={{ flex: 'none' }}>
                      {already ? (
                        <Chip tone="accent">已选</Chip>
                      ) : (
                        <Chip tone={hit.source.startsWith('radxa-deb') ? 'info' : undefined}>
                          {hit.source === 'radxa-deb'
                            ? 'radxa'
                            : hit.source === 'radxa-deb (test)'
                              ? 'radxa test'
                              : 'debian'}
                        </Chip>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </Card>

        <Card title="常用组合">
          <div className="body">
            <div className="chips">
              {PACKAGE_PRESETS.map((preset) => (
                <button key={preset.id} className="btn sm" onClick={() => applyPreset(preset.packages)} title={preset.packages.join(' ')}>
                  + {preset.name}
                </button>
              ))}
            </div>
            <p className="desc" style={{ marginTop: 10 }}>
              把该组合里还没选的包一次加进来。
            </p>
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Card title="已选软件包" hint={`${install.length} 个`}>
          <div className="body">
            {install.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                还没加额外软件包。基础系统由 edition 决定。
              </p>
            ) : (
              <div className="chips">
                {install.map((name) => (
                  <span className="token" key={name}>
                    {name}
                    <button onClick={() => remove(name)} title="移除">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {install.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Button size="sm" variant="ghost" onClick={() => setInstall([])}>
                  全部清空
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card title="安装选项">
          <div className="body">
            <Toggle
              checked={profile.packages.installRecommends}
              onChange={(v) => patch({ packages: { ...profile.packages, installRecommends: v } })}
              title="安装推荐依赖 (Recommends)"
              desc="关（默认）只装必要依赖，镜像更小；开则少踩缺依赖的坑"
            />
            <div style={{ height: 8 }} />
            <Toggle
              checked={profile.packages.vendor}
              onChange={(v) => patch({ packages: { ...profile.packages, vendor: v } })}
              title="安装 Radxa 厂商包"
              desc="对应 rsdk --no-vendor-packages。自带内核/固件时才关"
            />
            <div style={{ height: 8 }} />
            <Toggle
              checked={profile.packages.noCache}
              onChange={(v) => patch({ packages: { ...profile.packages, noCache: v } })}
              title="总是重建 rootfs (--no-cache)"
              desc="默认复用上次的 rootfs.tar 省时间；配置一变会自动加 --no-cache。开了就每次重建"
            />
          </div>
        </Card>

        <KernelOverridePanel profile={profile} patch={patch} catalog={catalog} />

        <Card title="移除软件包">
          <div className="body">
            {purge.length > 0 && (
              <div className="chips" style={{ marginBottom: 12 }}>
                {purge.map((name) => (
                  <span className="token" key={name}>
                    {name}
                    <button onClick={() => setPurge(purge.filter((p) => p !== name))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="row tight">
              <TextInput value={purgeInput} onChange={setPurgeInput} placeholder="包名，回车添加" />
              <div style={{ flex: 'none' }}>
                <Button
                  onClick={() => {
                    const name = purgeInput.trim()
                    if (name && !purge.includes(name)) setPurge([...purge, name].sort())
                    setPurgeInput('')
                  }}
                >
                  添加
                </Button>
              </div>
            </div>
            <p className="desc">用 apt purge --auto-remove 卸载，例如去掉不用的桌面组件。</p>
          </div>
        </Card>
      </div>
    </div>
  )
}
