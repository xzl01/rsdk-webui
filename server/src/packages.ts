import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { socList, type PackageSearchHit, type Product } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { tryRun } from './proc.ts'

export type IndexSource = {
  label: string
  url: string
  kind: 'radxa' | 'distro'
}

export type IndexMeta = {
  key: string
  suite: string
  socs: string[]
  builtAt: number
  count: number
  sources: IndexSource[]
  warnings: string[]
}

type Record = { n: string; v: string; a: string; s: string; d: string; r: number }

const memory = new Map<string, { meta: IndexMeta; records: Record[]; search: string[] }>()
const running = new Map<string, Promise<IndexMeta>>()

export function indexKey(suite: string, socs: string[]): string {
  return `${suite}__${[...socs].sort().join('+')}`
}

function indexPath(key: string): string {
  return path.join(config.cacheDir, `pkgs-${key}.json.gz`)
}

function metaPath(key: string): string {
  return path.join(config.cacheDir, `pkgs-${key}.meta.json`)
}

export function readIndexMeta(key: string): IndexMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(key), 'utf8')) as IndexMeta
  } catch {
    return null
  }
}

function distroOf(suite: string): 'debian' | 'ubuntu' {
  return ['jammy', 'noble', 'resolute', 'oracular', 'plucky', 'focal'].includes(suite) ? 'ubuntu' : 'debian'
}

export function sourcesFor(product: Product | undefined, suite: string): IndexSource[] {
  const sources: IndexSource[] = []
  const debian = distroOf(suite)
  const distroBase = debian === 'debian' ? 'https://deb.debian.org/debian' : 'https://ports.ubuntu.com/ubuntu-ports'
  const comps = debian === 'debian' ? ['main', 'contrib', 'non-free', 'non-free-firmware'] : ['main', 'universe', 'multiverse', 'restricted']

  for (const comp of comps) {
    sources.push({
      label: `${debian}/${suite}/${comp}`,
      url: `${distroBase}/dists/${suite}/${comp}/binary-arm64/Packages.xz`,
      kind: 'distro',
    })
  }

  if (product) {
    const socs = socList(product)
    sources.push({
      label: `radxa/${suite}`,
      url: `https://radxa-repo.github.io/${suite}/dists/${suite}/main/binary-arm64/Packages.gz`,
      kind: 'radxa',
    })
    for (const soc of socs) {
      sources.push({
        label: `radxa/${soc}-${suite}`,
        url: `https://radxa-repo.github.io/${soc}-${suite}/dists/${soc}-${suite}/main/binary-arm64/Packages.gz`,
        kind: 'radxa',
      })
    }
  }
  return sources
}

function decompress(buf: Buffer, url: string): Promise<string> {
  if (url.endsWith('.gz')) return Promise.resolve(zlib.gunzipSync(buf).toString('utf8'))
  if (url.endsWith('.xz')) {
    return new Promise((resolve, reject) => {
      const child = spawn('xz', ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let err = ''
      child.stdout.on('data', (d: Buffer) => chunks.push(d))
      child.stderr.on('data', (d) => (err += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
        else reject(new Error(`xz failed: ${err}`))
      })
      child.stdin.end(buf)
    })
  }
  return Promise.resolve(buf.toString('utf8'))
}

async function fetchUrl(url: string, dest: string): Promise<boolean> {
  const r = await tryRun('curl', ['-fsSL', '--retry', '2', '--max-time', '300', '-o', dest, url], { timeoutMs: 320_000 })
  return r.code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0
}

function parsePackages(text: string, sourceRank: number, out: Record[]): void {
  for (const block of text.split(/\n\s*\n/)) {
    if (!block.trim()) continue
    let name = ''
    let version = ''
    let arch = ''
    let section = ''
    let desc = ''
    for (const line of block.split('\n')) {
      if (line.startsWith(' ') && desc) {
        desc += ' ' + line.trim()
        continue
      }
      const idx = line.indexOf(':')
      if (idx < 0) continue
      const key = line.slice(0, idx)
      const value = line.slice(idx + 1).trim()
      switch (key) {
        case 'Package': name = value; break
        case 'Version': version = value; break
        case 'Architecture': arch = value; break
        case 'Section': section = value; break
        case 'Description': desc = value; break
        default: break
      }
    }
    if (!name) continue
    if (arch !== 'arm64' && arch !== 'all') continue
    out.push({ n: name, v: version, a: arch, s: section, d: desc.split('\n')[0].slice(0, 220), r: sourceRank })
  }
}

export async function buildIndex(
  product: Product | undefined,
  suite: string,
  onProgress: (line: string) => void,
): Promise<IndexMeta> {
  const socs = socList(product)
  const key = indexKey(suite, socs)
  const existing = running.get(key)
  if (existing) return existing

  const task = (async () => {
    const sources = sourcesFor(product, suite)
    const records: Record[] = []
    const warnings: string[] = []
    const tmp = path.join(config.cacheDir, 'tmp-pkgs')
    fs.mkdirSync(tmp, { recursive: true })

    for (const source of sources) {
      const dest = path.join(tmp, path.basename(source.url).replace(/^Packages/, 'Packages'))
      onProgress(`下载 ${source.label} ...`)
      const ok = await fetchUrl(source.url, dest)
      if (!ok) {
        warnings.push(`跳过 ${source.label}`)
        onProgress(`  ! 无法下载 ${source.url}`)
        continue
      }
      const raw = fs.readFileSync(dest)
      const text = await decompress(raw, source.url)
      const before = records.length
      parsePackages(text, source.kind === 'radxa' ? 0 : 1, records)
      onProgress(`  ${source.label}: ${records.length - before} 个软件包`)
      fs.rmSync(dest, { force: true })
    }

    // prefer the radxa record when a package exists in both
    const seen = new Map<string, Record>()
    for (const record of records) {
      const prev = seen.get(record.n)
      if (!prev || record.r < prev.r) seen.set(record.n, record)
    }
    const final = [...seen.values()].sort((a, b) => a.n.localeCompare(b.n))

    const meta: IndexMeta = {
      key,
      suite,
      socs,
      builtAt: Date.now(),
      count: final.length,
      sources,
      warnings,
    }
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(final)), { level: 6 })
    fs.writeFileSync(indexPath(key), gz)
    fs.writeFileSync(metaPath(key), JSON.stringify(meta, null, 2))
    fs.rmSync(tmp, { recursive: true, force: true })
    onProgress(`索引完成: ${final.length} 个软件包`)
    return meta
  })().finally(() => running.delete(key))

  running.set(key, task)
  return task
}

function load(key: string): { meta: IndexMeta; records: Record[]; search: string[] } | null {
  const cached = memory.get(key)
  if (cached) return cached
  const meta = readIndexMeta(key)
  if (!meta) return null
  try {
    const records = JSON.parse(zlib.gunzipSync(fs.readFileSync(indexPath(key))).toString('utf8')) as Record[]
    const entry = {
      meta,
      records,
      search: records.map((r) => `${r.n} ${r.d}`.toLowerCase()),
    }
    memory.set(key, entry)
    return entry
  } catch {
    return null
  }
}

export function searchPackages(
  key: string,
  query: string,
  limit = 60,
): { meta: IndexMeta | null; hits: PackageSearchHit[] } {
  const entry = load(key)
  if (!entry) return { meta: null, hits: [] }
  const q = query.trim().toLowerCase()
  if (!q) {
    return {
      meta: entry.meta,
      hits: entry.records.slice(0, limit).map(toHit),
    }
  }
  const scored: Array<{ score: number; index: number }> = []
  for (let i = 0; i < entry.records.length; i++) {
    const name = entry.records[i].n.toLowerCase()
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (entry.search[i].includes(q)) score = 3
    if (score >= 0) scored.push({ score, index: i })
  }
  scored.sort((a, b) => a.score - b.score || entry.records[a.index].n.localeCompare(entry.records[b.index].n))
  return { meta: entry.meta, hits: scored.slice(0, limit).map((s) => toHit(entry.records[s.index])) }
}

function toHit(r: Record): PackageSearchHit {
  return {
    name: r.n,
    version: r.v,
    architecture: r.a,
    section: r.s,
    description: r.d,
    source: r.r === 0 ? 'radxa-deb' : 'debian/ubuntu',
    radxa: r.r === 0,
  }
}

export function resolvePackages(key: string, names: string[]): { found: string[]; missing: string[] } {
  const entry = load(key)
  if (!entry) return { found: names, missing: [] }
  const set = new Set(entry.records.map((r) => r.n))
  const found: string[] = []
  const missing: string[] = []
  for (const name of names) (set.has(name) ? found : missing).push(name)
  return { found, missing }
}
