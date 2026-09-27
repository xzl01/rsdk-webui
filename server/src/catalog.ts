import fs from 'node:fs'
import path from 'node:path'
import type { Catalog, Product, Soc } from '@rsdk-webui/shared'
import { config } from './config.ts'
import { ensureBuildTree } from './rsdkTree.ts'

let cachedCatalog: Catalog | null = null

/**
 * socs.json maps a *list* of SoCs to a bootloader flavour ('u-boot' or 'edk2').
 * The bootloader package is `<firmware_type>-<product>`, so getting this wrong
 * makes the preflight look for a package that does not exist.
 */
function firmwareTypeFor(socs: string[], table: Array<Record<string, unknown>>): string | undefined {
  for (const entry of table) {
    const list = entry.soc_list
    if (!Array.isArray(list)) continue
    if (socs.some((soc) => list.includes(soc))) {
      const type = entry.firmware_type
      if (typeof type === 'string') return type
    }
  }
  return undefined
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

/**
 * The board/edition list comes straight from the rsdk tree that the build will
 * actually use, so the UI can never offer a board the toolchain does not know.
 */
export async function getCatalog(force = false): Promise<Catalog> {
  if (!force && cachedCatalog) return cachedCatalog

  const tree = await ensureBuildTree()
  if (!tree.ready) {
    throw new Error(tree.error ?? 'rsdk build tree 不可用')
  }

  let rawSocs: Array<Record<string, unknown>> = []
  try {
    rawSocs = readJson<Array<Record<string, unknown>>>(path.join(tree.path, 'configs', 'socs.json'))
  } catch {
    rawSocs = []
  }
  const products = readJson<Product[]>(path.join(tree.path, 'configs', 'products.json')).map((p) => ({
    ...p,
    soc: Array.isArray(p.soc) ? p.soc : p.soc ? [p.soc] : [],
    sector_size: p.sector_size === undefined ? [512] : Array.isArray(p.sector_size) ? p.sector_size : [p.sector_size],
    firmware_type: firmwareTypeFor(
      Array.isArray(p.soc) ? p.soc : p.soc ? [p.soc] : [],
      rawSocs,
    ),
  }))
  let socs: Soc[] = []
  try {
    const raw = readJson<unknown>(path.join(tree.path, 'configs', 'socs.json'))
    socs = Array.isArray(raw) ? (raw as Soc[]) : []
  } catch {
    socs = []
  }

  const suites = [...new Set(products.flatMap((p) => p.supported_suite ?? []))].sort()
  const editions = [...new Set(products.flatMap((p) => p.supported_edition ?? []))].sort()

  cachedCatalog = {
    source: 'image',
    rsdkVersion: tree.rsdkVersion ?? 'unknown',
    product: 'image',
    products: [...products].sort((a, b) => a.product.localeCompare(b.product)),
    socs,
    suites,
    editions,
    image: config.image,
  }
  return cachedCatalog
}

export async function findProduct(product: string): Promise<Product | undefined> {
  const catalog = await getCatalog()
  return catalog.products.find((p) => p.product === product)
}

export function invalidateCatalog(): void {
  cachedCatalog = null
}
