/** Shapes of the upstream rsdk metadata files we consume. */

/**
 * rsdk 0.1.0 (the version inside the released container image) stores `soc` as a
 * plain string and `sector_size` as a single-element array; upstream HEAD uses
 * arrays for both. Always go through socList()/sectorList().
 */
export type Product = {
  product: string
  product_name?: string
  product_full_name?: string
  soc: string | string[]
  sector_size?: number | number[]
  supported_suite: string[]
  supported_edition: string[]
  /** 'u-boot' or 'edk2', derived from socs.json; the bootloader package prefix */
  firmware_type?: string
  override_kernel?: string
  override_firmware?: string
  override_product?: string
}

export type Soc = {
  soc: string
  soc_family?: string
  soc_name?: string
  [key: string]: unknown
}

export type Catalog = {
  /** where the metadata came from */
  source: 'image' | 'checkout'
  rsdkVersion: string
  product: string
  products: Product[]
  socs: Soc[]
  suites: string[]
  editions: string[]
  /** image reference used for local builds */
  image: string
}

export type PackageSearchHit = {
  name: string
  version: string
  architecture: string
  section: string
  description: string
  /** which repository the package came from */
  source: string
  /** true when the package is a Radxa vendor package */
  radxa?: boolean
}

export type RepoStatus = {
  repo: string
  owner: string
  name: string
  exists: boolean
  private?: boolean
  fork?: boolean
  /** the token can administer the repo (needed to enable Actions) */
  canAdmin?: boolean
  defaultBranch?: string
  workflowOnDefaultBranch?: boolean
  actionsEnabled?: boolean
  /** a Pages site exists (needed for a fork to serve its own copy of the UI) */
  hasPages?: boolean
  needsManualActionEnable?: boolean
  htmlUrl?: string
  error?: string
}

/**
 * A per-(board, suite, edition) verdict, computed at deploy time by
 * `ops/check-boards.py`: it renders the edition's package list with the same
 * jsonnet tree the build uses and checks it against the package index, so the UI
 * can warn about combinations upstream cannot actually build.
 */
export type ComboVerdict = {
  status: 'ok' | 'test' | 'broken'
  missing?: string[]
  hint?: string
}

export type BoardVerdicts = {
  generatedAt: string
  image?: string
  rsdkVersion?: string
  combos: Record<string, ComboVerdict>
}

export function comboKey(product: string, suite: string, edition: string): string {
  return `${product}|${suite}|${edition}`
}

export type PreflightRepoProbe = {
  label: string
  url?: string
  exists: boolean
  packageCount: number
}

/** what the "确认构建" step shows before letting you start a build */
export type PreflightResult = {
  product: string
  suite: string
  testRepo: boolean
  required: string[]
  missing: string[]
  repos: PreflightRepoProbe[]
  suggestTestRepo: boolean
  suggestion?: string
  /** only the local backend can inspect .deb files on disk */
  localPackages?: {
    source: string
    dir?: string
    urls: string[]
    packages: Array<{ file: string; package: string; version: string; architecture: string }>
    provided: string[]
    fromRepos: string[]
    warnings: string[]
    failed: Array<{ file: string; error: string }>
  }
  cached?: boolean
  checkedAt: number
}

export type EnvStatus = {
  server: { version: string; dataDir: string }
  engine: {
    kind: 'podman' | 'docker' | 'none'
    binary: string
    version: string
    /** global args needed to reach the dedicated storage root */
    args: string[]
    /** extra `run` args, e.g. --userns=keep-id */
    runExtra: string[]
    rootless: boolean
    ok: boolean
    error?: string
  }
  image: {
    ref: string
    present: boolean
    id?: string
    sizeBytes?: number
    createdAt?: string
  }
  /** the rsdk jsonnet tree extracted from the container image */
  buildTree: { ready: boolean; path: string; rsdkVersion?: string; anchorOk?: boolean; error?: string }
  gh: {
    available: boolean
    login?: string
    tokenPresent: boolean
    error?: string
    /** only in static (Pages) mode: the repository the session points at */
    repo?: RepoStatus
  }
}
