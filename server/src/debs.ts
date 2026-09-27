/**
 * Minimal .deb inspection.
 *
 * Bringing your own kernel or bootloader means handing rsdk a directory of .deb
 * files (`--debs` publishes them as a local apt repository with pin 1999, so
 * they win over the repositories). Whether that actually replaces anything
 * depends entirely on the package *names* inside those files, so we read the
 * control metadata and check it against what the build is going to ask for -
 * instead of letting the user discover it 30 minutes into a build.
 *
 * A .deb is an `ar` archive:
 *   !<arch>\n
 *   debian-binary
 *   control.tar.{gz,xz,zst}   <- ./control has the metadata we want
 *   data.tar.{gz,xz,zst}
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export type DebPackage = {
  file: string
  package: string
  version: string
  architecture: string
  depends: string[]
  provides: string[]
  /** what apt/rsdk will actually call it: name or name:arch */
  size: number
}

export type DebDirReport = {
  dir: string
  packages: DebPackage[]
  totalBytes: number
  /** files that could not be read as .deb at all */
  failed: Array<{ file: string; error: string }>
}

function arMembers(buffer: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>()
  if (buffer.subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    throw new Error('not an ar archive')
  }
  let offset = 8
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60)
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/+$/, '')
    const size = Number.parseInt(header.subarray(48, 58).toString('ascii').trim(), 10)
    if (!Number.isFinite(size)) break
    const start = offset + 60
    members.set(name, buffer.subarray(start, start + size))
    offset = start + size + (size % 2) // entries are 2-byte aligned
  }
  return members
}

async function decompress(buffer: Buffer, name: string): Promise<Buffer> {
  if (name.endsWith('.gz')) return zlib.gunzipSync(buffer)
  const tool = name.endsWith('.xz') ? 'xz' : name.endsWith('.zst') ? 'zstd' : null
  if (!tool) return buffer
  return new Promise((resolve, reject) => {
    const child = spawn(tool, ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => chunks.push(data))
    child.stderr.on('data', (data) => (stderr += data.toString()))
    child.on('error', (err) => reject(new Error(`${tool}: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`${tool} exited ${code}: ${stderr.trim()}`))
    })
    child.stdin.end(buffer)
  })
}

/** pull one file out of an (uncompressed) tar */
function tarEntry(buffer: Buffer, wanted: string): Buffer | null {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const full = prefix ? `${prefix}/${name}` : name
    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(rawSize, 8) || 0
    const start = offset + 512
    if (full === wanted || full === `./${wanted}`) return buffer.subarray(start, start + size)
    offset = start + size + ((512 - (size % 512)) % 512)
  }
  return null
}

function parseControl(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let current: string | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (current) fields[current] += ` ${line.trim()}`
      continue
    }
    const index = line.indexOf(':')
    if (index < 0) continue
    current = line.slice(0, index)
    fields[current] = line.slice(index + 1).trim()
  }
  return fields
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim().split(/\s*[|(]/)[0].trim())
    .filter(Boolean)
}

export async function readDeb(file: string): Promise<DebPackage | null> {
  const buffer = fs.readFileSync(file)
  const members = arMembers(buffer)
  const controlName = [...members.keys()].find((name) => name.startsWith('control.tar'))
  if (!controlName) return null
  const tar = await decompress(members.get(controlName)!, controlName)
  const control = tarEntry(tar, 'control')
  if (!control) return null
  const fields = parseControl(control.toString('utf8'))
  const name = fields.Package
  if (!name) return null
  return {
    file: path.basename(file),
    package: name,
    version: fields.Version ?? '',
    architecture: fields.Architecture ?? '',
    depends: splitList(fields.Depends),
    provides: splitList(fields.Provides),
    size: buffer.length,
  }
}

export async function inspectDebDir(dir: string): Promise<DebDirReport> {
  const report: DebDirReport = { dir, packages: [], totalBytes: 0, failed: [] }
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    report.failed.push({ file: dir, error: `无法读取目录: ${String(err)}` })
    return report
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.deb')) continue
    const full = path.join(dir, entry)
    try {
      const parsed = await readDeb(full)
      if (!parsed) {
        report.failed.push({ file: entry, error: '读不出 control 元数据' })
        continue
      }
      report.packages.push(parsed)
      report.totalBytes += parsed.size
    } catch (err) {
      report.failed.push({ file: entry, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
