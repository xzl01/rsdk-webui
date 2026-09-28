import { useEffect, useMemo, useState } from 'react'
import {
  bootloaderPrefix,
  requiredKernelPackages,
  type Catalog,
  type Profile,
} from '@rsdk-webui/shared'
import { api } from '../api.ts'
import { Button, Card, Chip, Field, Note, TextInput, Toggle } from '../ui.tsx'

type Inspection = {
  required: string[]
  bootloaderPrefix: string
  report: {
    source: string
    packages: Array<{ file: string; package: string; version: string; architecture: string }>
    provided: string[]
    fromRepos: string[]
    warnings: string[]
    failed: Array<{ file: string; error: string }>
  }
}

/**
 * Bring your own kernel / bootloader.
 *
 * rsdk has no "replace the kernel" switch - what it has is `--debs`, which
 * publishes your .deb files as a local apt repository pinned at 1999 so they win
 * over the repositories, plus `-k`/`-f` to change which package is requested in
 * the first place. Which of the two applies depends purely on the package names
 * inside your files, so this panel shows exactly what the build will ask for and
 * what your packages provide.
 */
export function KernelOverridePanel({
  profile,
  patch,
  catalog,
}: {
  profile: Profile
  patch: (p: Partial<Profile>) => void
  catalog: Catalog | null
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [error, setError] = useState<string | null>(null)

  const product = catalog?.products.find((p) => p.product === profile.target.product)
  const prefix = bootloaderPrefix(product)
  const required = useMemo(
    () => requiredKernelPackages(profile, product),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile.target.product, profile.packages.kernelOverride, profile.packages.firmwareOverride, product],
  )

  // pure local derivation, so the static (Pages) build gets the same list
  useEffect(() => {
    if (!api.inspectDebs) {
      setInspection(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      api
        .inspectDebs!(profile)
        .then((result) => !stale && setInspection(result))
        .catch((err) => !stale && setError(String(err instanceof Error ? err.message : err)))
    }, 300)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(profile.packages), profile.target.product])

  const setPackages = (p: Partial<Profile['packages']>) => patch({ packages: { ...profile.packages, ...p } })
  const report = inspection?.report
  const hasLocal = profile.packages.localDebsDir !== '' || profile.packages.debsUrls.length > 0

  return (
    <Card
      title="自带内核 / U-Boot"
      hint={hasLocal ? '使用你构建的包' : '使用官方包'}
      actions={
        <Chip tone={profile.packages.kernelOverride || profile.packages.firmwareOverride ? 'accent' : undefined}>
          {profile.packages.kernelOverride || profile.target.product}
        </Chip>
      }
    >
      <div className="body">
        <p className="desc" style={{ marginTop: 0 }}>
          给 .deb 就会用它顶掉仓库里的同名包。改了包名才需要在下面填名字。
        </p>
        <details className="help-details" style={{ marginBottom: 10 }}>
          <summary>它到底怎么生效的</summary>
          <p>
            rsdk 没有"替换内核"开关。机制是 <span className="mono">--debs</span>：把你给的 .deb 发布成
            本地 apt 源并钉在 <span className="mono">pin 1999</span>，所以同名包直接赢过仓库版本；
            改了名字再用 <span className="mono">-k</span> / <span className="mono">-f</span> 告诉构建
            该装哪个名字。
          </p>
        </details>

        <div className="row">
          <Field label={`内核包名 (-k)`} desc={`留空则装 linux-image-${profile.target.product}`}>
            <TextInput
              mono
              value={profile.packages.kernelOverride}
              onChange={(v) => setPackages({ kernelOverride: v })}
              placeholder={profile.target.product}
            />
          </Field>
          <Field label={`引导包名 (-f)`} desc={`留空则装 ${prefix}-${profile.target.product}`}>
            <TextInput
              mono
              value={profile.packages.firmwareOverride}
              onChange={(v) => setPackages({ firmwareOverride: v })}
              placeholder={profile.target.product}
            />
          </Field>
        </div>
      </div>

      <div className="body">
        <Field
          label="本地 .deb 目录"
          desc={
            api.inspectDebs
              ? '目录里的 .deb 会复制进构建包。通常是 make deb 的产物目录'
              : '只有本机构建能用，静态模式读不到你的磁盘。'
          }
        >
          <TextInput
            mono
            value={profile.packages.localDebsDir}
            onChange={(v) => setPackages({ localDebsDir: v })}
            placeholder="/home/me/linux/debs"
          />
        </Field>

        <Field
          label=".deb 下载地址（每行一个）"
          desc="在构建容器里下载。GitHub Actions 上只能靠它，例如内核仓库的 Release 附件"
        >
          <textarea
            rows={3}
            value={profile.packages.debsUrls.join('\n')}
            onChange={(e) => setPackages({ debsUrls: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
            placeholder={'https://github.com/you/linux/releases/download/v1/linux-image-mykernel_1.0_arm64.deb'}
          />
        </Field>

        <Toggle
          checked={profile.packages.recordProvenance}
          onChange={(v) => setPackages({ recordProvenance: v })}
          title="在镜像里记录实际装到的内核/引导版本"
          desc="写入 /etc/rsdk/webui-packages.txt 并打进日志，确认你的内核真被用上了"
        />
      </div>

      <div className="body">
        <strong style={{ fontSize: 12.5 }}>这次构建会要求这 4 个包</strong>
        <div className="chips" style={{ marginTop: 8 }}>
          {required.map((name) => {
            const provided = report?.provided.includes(name)
            const isKernel = name.startsWith('linux-')
            return (
              <Chip key={name} tone={provided ? 'accent' : isKernel ? undefined : 'info'}>
                {name}
                {provided ? ' ← 你的包' : ''}
              </Chip>
            )
          })}
        </div>
        {!api.inspectDebs && (
          <p className="desc">
            静态模式无法预读你本地的 .deb；构建容器会把实际装到的版本写进
            <span className="mono"> /etc/rsdk/webui-packages.txt</span>。
          </p>
        )}
      </div>

      {error && (
        <div className="body">
          <Note tone="danger">{error}</Note>
        </div>
      )}

      {report && hasLocal && (
        <div className="body">
          {report.failed.length > 0 && (
            <Note tone="danger">
              这些文件读不出 .deb 元数据：{report.failed.map((f) => `${f.file}（${f.error}）`).join('、')}
            </Note>
          )}
          {report.packages.length > 0 && (
            <>
              <div className="mono" style={{ fontSize: 12, marginBottom: 8 }}>
                {report.packages.length} 个自带包
                {report.provided.length > 0 ? `，其中 ${report.provided.length} 个会覆盖仓库版本` : '，都不匹配本次需要的包名'}
              </div>
              <div className="pkg-list" style={{ maxHeight: 180 }}>
                {report.packages.map((pkg) => (
                  <div className="pkg" key={pkg.file} style={{ cursor: 'default' }}>
                    <span className="name">{pkg.package}</span>
                    <span className="desc">
                      {pkg.version} · {pkg.architecture} · {pkg.file}
                    </span>
                    <span style={{ flex: 'none' }}>
                      {report.provided.includes(pkg.package) ? (
                        <Chip tone="accent">覆盖</Chip>
                      ) : (
                        <Chip>{pkg.architecture === 'arm64' || pkg.architecture === 'all' ? '附加' : '架构不符'}</Chip>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {report.warnings.map((warning) => (
            <div key={warning} style={{ marginTop: 10 }}>
              <Note tone="warn">{warning}</Note>
            </div>
          ))}
          {report.fromRepos.length > 0 && report.provided.length > 0 && (
            <p className="desc">
              仍然从仓库获取：<span className="mono">{report.fromRepos.join(', ')}</span>
              。换内核 ABI 时通常要一起给 headers。
            </p>
          )}
        </div>
      )}

      <div className="body">
        <p className="desc" style={{ margin: 0 }}>
          用 <span className="mono">make deb</span> 生成，把
          <span className="mono"> linux-image-*</span> / <span className="mono">linux-headers-*</span>（U-Boot 则是
          <span className="mono"> {prefix}-latest</span> 这类被依赖的包）一起放进目录或发到 Release。
          记得把<b>同一批</b>包都带上，只换一半会断依赖。
        </p>
      </div>
    </Card>
  )
}
