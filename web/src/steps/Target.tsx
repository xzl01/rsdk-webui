import { useMemo, useState } from 'react'
import { comboKey, sectorList, socList, type BoardVerdicts, type Product } from '@rsdk-webui/shared'
import { Card, Chip, Field, Select, TextInput } from '../ui.tsx'
import type { StepProps } from './types.ts'

export function TargetStep({ profile, patch, catalog, verdicts }: StepProps) {
  const [query, setQuery] = useState('')

  const products = useMemo(() => {
    const all = catalog?.products ?? []
    const q = query.trim().toLowerCase()
    if (!q) return [...all].sort((a, b) => Number(b.product === profile.target.product) - Number(a.product === profile.target.product))
    return all.filter((p) =>
      [p.product, p.product_name, p.product_full_name, ...socList(p)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [catalog, query, profile.target.product])

  const selected: Product | undefined = catalog?.products.find((p) => p.product === profile.target.product)

  /** 「cli」→「cli ⚠ 需要测试源」… so a broken combination is visible before it is picked */
  const labelForVerdict = (
    edition: string,
    verdicts: BoardVerdicts | null | undefined,
    product: string,
    suite: string,
    value: string,
  ): string => {
    const verdict = verdicts?.combos[comboKey(product, suite, value)]
    if (!verdict || verdict.status === 'ok') return value
    return verdict.status === 'broken' ? `${value} ✕ 上游无法构建` : `${value} ⚠ 需要测试源`
  }

  const currentVerdict = selected
    ? verdicts?.combos[comboKey(selected.product, profile.target.suite, profile.target.edition)]
    : undefined

  const pick = (product: Product) => {
    patch({
      target: {
        ...profile.target,
        product: product.product,
        suite: product.supported_suite?.[0] ?? 'bookworm',
        edition: product.supported_edition?.[0] ?? 'cli',
        sectorSize: (sectorList(product)[0] ?? 512) as 512 | 4096,
      },
      meta: {
        ...profile.meta,
        name: profile.meta.name === '' || /^新镜像$/.test(profile.meta.name)
          ? product.product_name ?? product.product
          : profile.meta.name,
      },
    })
  }

  return (
    <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1.35fr) minmax(320px,1fr)' }}>
      <Card
        title="选择开发板"
        hint={
          catalog
            ? `${catalog.products.length} 款 · rsdk ${catalog.rsdkVersion}` +
              (verdicts
                ? ` · 组合体检 ${Object.values(verdicts.combos).filter((v) => v.status === 'ok').length}/${
                    Object.keys(verdicts.combos).length
                  } 可直接构建`
                : '')
            : '加载中…'
        }
      >
        <div className="body" style={{ paddingBottom: 10 }}>
          <TextInput value={query} onChange={setQuery} placeholder="搜索板子 / SoC，例如 rock-5b、rk3588" />
        </div>
        <div className="body scroll-y" style={{ paddingTop: 0, maxHeight: '52vh' }}>
          <div className="board-grid">
            {products.map((p) => (
              <button
                key={p.product}
                className={`board${p.product === profile.target.product ? ' on' : ''}`}
                onClick={() => pick(p)}
              >
                <strong>{p.product_name ?? p.product_full_name ?? p.product}</strong>
                <div className="sub">{p.product}</div>
                <div className="badges">
                  {socList(p).map((s) => (
                    <span className="badge" key={s}>
                      {s}
                    </span>
                  ))}
                  {sectorList(p).map((s) => (
                    <span className="badge" key={s}>
                      {s}B
                    </span>
                  ))}
                </div>
              </button>
            ))}
            {products.length === 0 && <div className="empty">没有匹配的板子</div>}
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <Card title="系统与版本">
          <div className="body">
            <Field label="发行版版本 (suite)" desc="由该板子的 BSP 支持情况决定">
              <Select
                value={profile.target.suite}
                onChange={(v) => patch({ target: { ...profile.target, suite: v } })}
                options={(selected?.supported_suite ?? [profile.target.suite]).map((s) => ({ label: s, value: s }))}
              />
            </Field>
            <Field label="版本 (edition)" desc="决定预装的桌面环境与软件集合">
              <Select
                value={profile.target.edition}
                onChange={(v) => patch({ target: { ...profile.target, edition: v } })}
                options={(selected?.supported_edition ?? [profile.target.edition]).map((s) => ({
                  label: labelForVerdict(s, verdicts, profile.target.product, profile.target.suite, s),
                  value: s,
                }))}
              />
            </Field>
            <Field label="扇区大小" desc="eMMC/UFS 使用 4096，SD 卡与多数设备使用 512">
              <Select
                value={String(profile.target.sectorSize) as '512' | '4096'}
                onChange={(v) => patch({ target: { ...profile.target, sectorSize: Number(v) as 512 | 4096 } })}
                options={sectorList(selected).map((s) => ({ label: `${s} 字节`, value: String(s) as '512' | '4096' }))}
              />
            </Field>
            <Field label="输出文件名">
              <TextInput
                mono
                value={profile.target.imageName}
                onChange={(v) => patch({ target: { ...profile.target, imageName: v } })}
              />
            </Field>
          </div>
          <div className="body">
            <div className="chips">
              <Chip tone="accent">{profile.target.product}</Chip>
              <Chip>{profile.target.suite}</Chip>
              <Chip>{profile.target.edition}</Chip>
              <Chip>{profile.target.sectorSize}B</Chip>
            </div>
          </div>
        </Card>

        <Card title="构建标识">
          <div className="body">
            <Field label="方案名称" desc="用于区分不同的定制方案">
              <TextInput value={profile.meta.name} onChange={(v) => patch({ meta: { ...profile.meta, name: v } })} />
            </Field>
            <Field label="备注">
              <TextInput
                value={profile.meta.notes}
                onChange={(v) => patch({ meta: { ...profile.meta, notes: v } })}
                placeholder="这块镜像打算给谁用、装在哪台设备上"
              />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  )
}
