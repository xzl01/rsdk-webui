import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { requiredKernelPackages, socList, type Product, type Profile } from '@rsdk-webui/shared'
import { inspectDebDir, type DebPackage } from './debs.ts'
import { config } from './config.ts'
import { tryRun } from './proc.ts'

export type RepoProbe = {
  label: string
  url: string
  exists: boolean
  packageCount: number
  has: Record<string, boolean>
}

/** what the build will ask apt to install for the kernel / bootloader */
export type LocalPackageReport = {
  source: 'dir' | 'urls' | 'both' | 'none'
  dir?: string
  urls: string[]
  packages: DebPackage[]
  totalBytes: number
  failed: Array<{ file: string; error: string }>
  /** required packages the local .debs would provide (pin 1999 makes them win) */
  provided: string[]
  /** required packages still coming from the repositories */
  fromRepos: string[]
  warnings: string[]
}

export type PreflightResult = {
  product: string
  suite: string
  testRepo: boolean
  required: string[]
  missing: string[]
  localPackages: LocalPackageReport
  repos: RepoProbe[]
  /** set when flipping `testRepo` would fix the missing packages */
  suggestTestRepo: boolean
  suggestion?: string
  cached: boolean
  checkedAt: number
}

const cache = new Map<string, PreflightResult>()

function radxaBase(mirror: string): string {
  return mirror ? mirror.replace(/\/+$/, '') : 'https://radxa-repo.github.io'
}

/**
 * Check the packages the user brought along: their *names* decide whether they
 * replace anything, and a missing half (e.g. headers but no image) is the most
 * common way to lose 30 minutes.
 */
export async function analyseLocalPackages(
  profile: Profile,
  required: string[],
): Promise<LocalPackageReport> {
  const urls = profile.packages.debsUrls ?? []
  const dir = profile.packages.localDebsDir
  const report: LocalPackageReport = {
    source: dir && urls.length ? 'both' : dir ? 'dir' : urls.length ? 'urls' : 'none',
    dir: dir || undefined,
    urls,
    packages: [],
    totalBytes: 0,
    failed: [],
    provided: [],
    fromRepos: [...required],
    warnings: [],
  }

  if (dir) {
    const inspected = await inspectDebDir(dir)
    report.packages = inspected.packages
    report.totalBytes = inspected.totalBytes
    report.failed = inspected.failed
    if (inspected.packages.length === 0 && inspected.failed.length === 0) {
      report.warnings.push(`${dir} 里没有 .deb 文件`)
    }
  }

  const names = new Set<string>()
  for (const pkg of report.packages) {
    names.add(pkg.package)
    for (const provided of pkg.provides) names.add(provided.split('=')[0].trim())
  }
  report.provided = required.filter((name) => names.has(name))
  report.fromRepos = required.filter((name) => !names.has(name))

  for (const pkg of report.packages) {
    if (pkg.architecture !== 'arm64' && pkg.architecture !== 'all') {
      report.warnings.push(`${pkg.file} 是 ${pkg.architecture}，目标镜像需要 arm64/all`)
    }
  }
  if (report.packages.length > 0 && report.provided.length === 0) {
    report.warnings.push(
      `自带包的包名（${[...names].slice(0, 4).join(', ')}${names.size > 4 ? '…' : ''}）` +
        `与本次构建需要的（${required.join(', ')}）都不匹配 —— 请确认它们是用来替换内核/引导的，` +
        '或用 -k/-f 改成实际的包名',
    )
  }
  const kernel = profile.packages.kernelOverride || profile.target.product
  if (
    report.provided.includes(`linux-image-${kernel}`) &&
    !report.provided.includes(`linux-headers-${kernel}`) &&
    required.includes(`linux-headers-${kernel}`)
  ) {
    report.warnings.push(
      `提供了 linux-image-${kernel} 但没提供 linux-headers-${kernel}：` +
        'headers 仍从仓库装，如果内核 ABI 不同会在后面失败，建议一并带上',
    )
  }
  if (report.source !== 'none' && urls.length > 0 && !dir) {
    report.warnings.push('自带包走 URL 下载，构建容器需要能访问这些地址')
  }
  return report
}

function candidateRepos(profile: Profile, product: Product | undefined, testRepo: boolean): Array<{ label: string; name: string }> {
  const suite = profile.target.suite
  const suffix = testRepo ? '-test' : ''
  const names = new Set<string>()
  names.add(`${suite}${suffix}`)
  for (const soc of socList(product)) names.add(`${soc}-${suite}${suffix}`)
  return [...names].map((name) => ({ label: name, name }))
}

async function probeRepo(base: string, name: string, required: string[]): Promise<RepoProbe> {
  const url = `${base}/${name}/dists/${name}/main/binary-arm64/Packages.gz`
  const probe: RepoProbe = { label: name, url, exists: false, packageCount: 0, has: {} }
  const tmp = path.join(config.cacheDir, `probe-${name}.gz`)
  fs.mkdirSync(config.cacheDir, { recursive: true })
  const r = await tryRun('curl', ['-fsSL', '--max-time', '60', '-o', tmp, url], { timeoutMs: 70_000 })
  if (r.code !== 0) return probe
  try {
    const text = zlib.gunzipSync(fs.readFileSync(tmp)).toString('utf8')
    probe.exists = true
    const wanted = new Set(required)
    for (const line of text.split('\n')) {
      if (!line.startsWith('Package: ')) continue
      probe.packageCount++
      const pkg = line.slice('Package: '.length).trim()
      if (wanted.has(pkg)) probe.has[pkg] = true
    }
  } catch {
    /* treat as missing */
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return probe
}

/**
 * Fast sanity check before a 30+ minute build.
 *
 * Upstream `rsdk` downloads the radxa-deb indexes during the build and only then
 * notices that e.g. `linux-headers-rock-pi-s` does not exist - after the base
 * system has already been assembled. We check the repo indexes up front instead.
 */
export { requiredKernelPackages }

export async function preflight(profile: Profile, product: Product | undefined, force = false): Promise<PreflightResult> {
  const testRepo = profile.repos.testRepo
  const key = JSON.stringify([
    profile.target.product,
    profile.target.suite,
    testRepo,
    profile.repos.radxaMirror,
    profile.packages.kernelOverride,
    profile.packages.firmwareOverride,
    profile.packages.localDebsDir,
    profile.packages.debsUrls,
  ])
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.checkedAt < 10 * 60_000) {
    return { ...hit, cached: true }
  }

  const base = radxaBase(profile.repos.radxaMirror)
  const required = requiredKernelPackages(profile, product)
  const repos = await Promise.all(candidateRepos(profile, product, testRepo).map((r) => probeRepo(base, r.name, required)))

  const found = new Set<string>()
  for (const repo of repos) for (const pkg of Object.keys(repo.has)) found.add(pkg)
  const missing = required.filter((pkg) => !found.has(pkg))

  let suggestTestRepo = false
  if (missing.length > 0 && !testRepo && !profile.repos.radxaMirror) {
    const altRepos = await Promise.all(
      candidateRepos(profile, product, true).map((r) => probeRepo(base, r.name, required)),
    )
    const altFound = new Set<string>()
    for (const repo of altRepos) for (const pkg of Object.keys(repo.has)) altFound.add(pkg)
    suggestTestRepo = missing.every((pkg) => altFound.has(pkg))
  }

  const localPackages = await analyseLocalPackages(profile, required)

  const result: PreflightResult = {
    product: profile.target.product,
    suite: profile.target.suite,
    testRepo,
    required,
    missing,
    localPackages,
    repos,
    suggestTestRepo,
    suggestion: suggestTestRepo
      ? '稳定源里缺少这些包，但测试源 (-test) 里有。把「软件源」里的「使用测试源」打开再构建。'
      : missing.length > 0
        ? '当前软件源里找不到这些包。请检查镜像地址，或确认该板子在这个 suite 下是否已发布。'
        : undefined,
    cached: false,
    checkedAt: Date.now(),
  }
  cache.set(key, result)
  return result
}
