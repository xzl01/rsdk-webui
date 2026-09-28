import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOTFS_ANCHOR } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { detectEngine, engineRun, imageStatus, type Engine } from './env.ts'
import { serialized, tryRun } from './proc.ts'

export type BuildTree = {
  ready: boolean
  path: string
  rsdkVersion?: string
  anchorOk?: boolean
  error?: string
}

const trees = new Map<string, BuildTree>()
const extractions = new Map<string, Promise<BuildTree>>()

function treeDirFor(imageId: string): string {
  return path.join(config.rsdkTreesDir, imageId.replace(/^sha256:/, '').slice(0, 16))
}

/** stream a command's stdout straight into a file (binary safe) */
function runToFile(cmd: string, args: string[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest)
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.pipe(out)
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    out.on('error', reject)
    child.on('close', (code) => {
      out.end(() => {
        if (code === 0) resolve()
        else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`))
      })
    })
  })
}

/**
 * Extract (and cache) the rsdk jsonnet tree from the container image.
 *
 * We shadow the image's `/usr/share/rsdk/build` with a patched copy at build
 * time, so we need the exact tree the image would have used - not whatever
 * version happens to be checked out somewhere on the host.
 */
/** A previously extracted tree, usable without touching the container engine. */
function fromDisk(imageRef: string): BuildTree | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(config.rsdkTreesDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const dir = path.join(config.rsdkTreesDir, entry)
    const rootfs = path.join(dir, 'build', 'rootfs.jsonnet')
    if (!fs.existsSync(rootfs)) continue
    let rsdkVersion: string | undefined
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { rsdkVersion?: string; image?: string }
      if (meta.image !== imageRef) continue
      rsdkVersion = meta.rsdkVersion
    } catch {
      continue // An unidentified tree must never stand in for another image.
    }
    const anchorOk = fs.readFileSync(rootfs, 'utf8').split(ROOTFS_ANCHOR).length - 1 === 1
    return {
      ready: anchorOk,
      path: dir,
      rsdkVersion,
      anchorOk,
      ...(anchorOk
        ? {}
        : { error: `rootfs.jsonnet 中找不到唯一的 ${JSON.stringify(ROOTFS_ANCHOR)}，上游 rsdk 结构可能已变更` }),
    }
  }
  return null
}

export async function ensureBuildTree(force = false, options: { image?: string; engine?: Engine } = {}): Promise<BuildTree> {
  const imageRef = options.image ?? config.image
  const cacheKey = JSON.stringify([options.engine?.binary, options.engine?.args, imageRef])
  let cached = trees.get(cacheKey)
  const remember = (tree: BuildTree) => { trees.set(cacheKey, tree); return tree }
  if (!force && !options.engine && cached?.ready) return remember(cached)

  // The tree only changes when the container image changes, so prefer whatever
  // is already on disk: catalog/profile requests then work even while a build
  // holds podman's storage lock, or with no container engine at all.
  if (!force && !options.engine) {
    const disk = fromDisk(imageRef)
    if (disk) {
      cached = disk
      return remember(disk)
    }
  }

  const engine = options.engine ?? await detectEngine()
  if (!engine) {
    cached = { ready: false, path: '', error: '没有可用的容器引擎 (podman/docker)' }
    return remember(cached)
  }

  const image = await imageStatus(imageRef, engine)
  if (!image.present) {
    cached = { ready: false, path: '', error: `容器镜像 ${imageRef} 尚未导入，请先执行环境准备` }
    return remember(cached)
  }

  // Requests for the same image may arrive from environment checks and builds
  // together. Share extraction so one request cannot delete another's tar file.
  const imageId = image.id ?? imageRef
  let pending = extractions.get(imageId)
  if (!pending) {
    pending = extractTree(engine, imageRef, imageId, force).finally(() => extractions.delete(imageId))
    extractions.set(imageId, pending)
  }
  return remember(await pending)
}

async function extractTree(engine: Engine, imageRef: string, imageId: string, force: boolean): Promise<BuildTree> {
  const key = imageId.replace(/^sha256:/, '').slice(0, 16)
  const dir = treeDirFor(imageId)

  const versionOut = await engineRun([
    'run', '--rm', '--entrypoint', 'dpkg-query', imageRef,
    '-W', '-f=${Version}', 'rsdk',
  ], { engine })
  const rsdkVersion = versionOut.stdout.trim() || undefined

  const rootfs = path.join(dir, 'build', 'rootfs.jsonnet')
  if (force || !fs.existsSync(rootfs)) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const tarPath = path.join(dir, 'build.tar')
    try {
      await serialized(() =>
        runToFile(engine.binary, [
          ...engine.args, 'run', '--rm', '--entrypoint', 'tar', imageRef,
          '-cf', '-', '-C', '/usr/share/rsdk', 'build', 'configs',
        ], tarPath),
      )
      const untar = await tryRun('tar', ['-xf', tarPath, '-C', dir])
      if (untar.code !== 0) throw new Error(`tar extraction failed: ${untar.stderr}`)
      fs.rmSync(tarPath, { force: true })
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ key, rsdkVersion, image: imageRef }, null, 2))
    } catch (err) {
      return { ready: false, path: dir, error: `导出 rsdk jsonnet 失败: ${String(err)}` }
    }
  }

  const stock = fs.readFileSync(rootfs, 'utf8')
  const anchorOk = stock.split(ROOTFS_ANCHOR).length - 1 === 1
  if (!anchorOk) {
    return {
      ready: false,
      path: dir,
      rsdkVersion,
      anchorOk,
      error: `rootfs.jsonnet 中找不到唯一的 ${JSON.stringify(ROOTFS_ANCHOR)}，上游 rsdk 结构可能已变更`,
    }
  }

  return { ready: true, path: dir, rsdkVersion, anchorOk }
}

export async function buildTreeStatus(force = false): Promise<BuildTree> {
  return ensureBuildTree(force)
}
