/**
 * Assemble a build bundle entirely in memory.
 *
 * `writeBundle()` on the server writes the same files to disk; this variant is
 * for the backend-less (GitHub Pages) UI, where the bundle is committed straight
 * through the GitHub Git Data API from the browser.
 *
 * Inputs are the profile plus the rsdk jsonnet tree, which the Pages build
 * exports out of the container image (`ops/emit-static-assets.sh`) so that the
 * tree always matches the image the build will run in.
 */
import { patchRootfsJsonnet, renderBundle, type BundleFile } from './render.ts'
import { ProfileSchema, type Profile } from './schema.ts'

export type BundleEntry = {
  path: string
  content: string
  /** 'base64' for binary overlays, 'utf-8' otherwise */
  encoding: 'utf-8' | 'base64'
  mode: number
}

/** paths that a git checkout should not carry (mirrors the bundle .gitignore) */
const IGNORED = ['.rsdk-cache/', 'work/', 'host.env', 'engine.args']

export function isIgnoredBundlePath(path: string): boolean {
  return IGNORED.some((entry) => path === entry || path.startsWith(entry))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * @param tree the image's /usr/share/rsdk/build, as {relative path: content}
 */
export function assembleBundle(profile: Profile, tree: Record<string, string>): BundleEntry[] {
  // 单一入口兜底：服务端路由在校验后进来，但静态模式（浏览器 startBuild）的
  // profile 直接来自表单 state / localStorage，这里不过一遍 schema 就可能把
  // 未校验的值渲染进构建脚本
  const p = ProfileSchema.parse(profile)
  const entries: BundleEntry[] = []

  // 1. the jsonnet tree, with our hook spliced into rootfs.jsonnet
  let patchedRootfs: string | null = null
  for (const [rel, content] of Object.entries(tree)) {
    if (rel === 'rootfs.jsonnet') {
      patchedRootfs = patchRootfsJsonnet(content, p)
      continue
    }
    entries.push({ path: `rsdk-build/${rel}`, content, encoding: 'utf-8', mode: 0o644 })
  }
  if (patchedRootfs === null) {
    throw new Error('rsdk-build/rootfs.jsonnet is missing from the bundled tree')
  }
  entries.push({ path: 'rsdk-build/rootfs.jsonnet', content: patchedRootfs, encoding: 'utf-8', mode: 0o644 })

  // 2. everything we generate
  const files: BundleFile[] = renderBundle(p)
  for (const file of files) {
    if (isIgnoredBundlePath(file.path)) continue
    entries.push(
      typeof file.content === 'string'
        ? { path: file.path, content: file.content, encoding: 'utf-8', mode: file.mode }
        : { path: file.path, content: toBase64(file.content), encoding: 'base64', mode: file.mode },
    )
  }

  return entries
}
