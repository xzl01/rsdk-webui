import { z } from 'zod'

/** Directory the generated bundle is mounted at inside the build container. */
export const BUNDLE_MOUNT = '/rsdk-bundle'
/** Path (inside the container) of the stock rsdk jsonnet tree that we shadow. */
export const RSDK_BUILD_MOUNT = '/usr/share/rsdk/build'

export const SUPPORTED_STEPS = ['target', 'repos', 'packages', 'system', 'hooks', 'backend'] as const

// ---------------------------------------------------------------------------
// apt / repos
// ---------------------------------------------------------------------------

export const ExtraAptRepoSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** base URL, e.g. https://deb.debian.org/debian */
  url: z.string().min(1),
  suite: z.string().min(1),
  components: z.array(z.string()).min(1).default(['main']),
  /** ASCII-armored key content, stored in the bundle. */
  keyArmored: z.string().default(''),
  /** alternative: fetch the key at build time */
  keyUrl: z.string().default(''),
  trusted: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

export const ReposSchema = z.object({
  /** radxa-deb mirror, '' = official */
  radxaMirror: z.string().default(''),
  /** debian/ubuntu mirror, '' = upstream default */
  distroMirror: z.string().default(''),
  /** build against the -test radxa repo */
  testRepo: z.boolean().default(false),
  /** embed Radxa pkgs.json metadata */
  usePkgsJson: z.boolean().default(true),
  /** snapshot.debian.org timestamp, e.g. 20240101T000000Z */
  snapshot: z.string().default(''),
  extra: z.array(ExtraAptRepoSchema).default([]),
})

// ---------------------------------------------------------------------------
// packages
// ---------------------------------------------------------------------------

export const PackagesSchema = z.object({
  /** install radxa vendor packages (metapackages that pull in kernel/uboot) */
  vendor: z.boolean().default(true),
  kernelOverride: z.string().default(''),
  firmwareOverride: z.string().default(''),
  /** extra packages installed by the customize hook, from any configured repo */
  install: z.array(z.string()).default([]),
  /** packages removed after the base system is built */
  purge: z.array(z.string()).default([]),
  /** apt --no-install-recommends is the default (smaller images) */
  installRecommends: z.boolean().default(false),
  /** host directory of locally built .deb files, passed to rsdk via --debs */
  localDebsDir: z.string().default(''),
  /**
   * .deb download URLs, fetched *inside the build container* before the build.
   * This is how a self-built kernel reaches a GitHub Actions build, where the
   * browser cannot read a local directory.
   */
  debsUrls: z.array(z.string()).default([]),
  /** append the installed kernel/bootloader package versions to the image */
  recordProvenance: z.boolean().default(true),
  /** always pass --no-cache, even when the rootfs inputs are unchanged */
  noCache: z.boolean().default(false),
})

// ---------------------------------------------------------------------------
// system / first boot
// ---------------------------------------------------------------------------

export const UserSpecSchema = z.object({
  name: z.string().min(1),
  /** crypt(3) sha512 hash. The plaintext password never leaves the browser session. */
  passwordHash: z.string().default(''),
  /** create the account, add to sudo */
  sudo: z.boolean().default(true),
  /** passwordless sudo */
  nopasswd: z.boolean().default(false),
  shell: z.string().default('/bin/bash'),
  sshKeys: z.array(z.string()).default([]),
})

export const SshSchema = z.object({
  enabled: z.boolean().default(true),
  passwordAuth: z.boolean().default(false),
  permitRootLogin: z.enum(['yes', 'no', 'prohibit-password']).default('prohibit-password'),
  rootAuthorizedKeys: z.array(z.string()).default([]),
})

export const WifiSchema = z.object({
  ssid: z.string().min(1),
  psk: z.string().default(''),
  hidden: z.boolean().default(false),
  country: z.string().default(''),
  autoconnect: z.boolean().default(true),
})

export const SystemSchema = z.object({
  hostname: z.string().default(''),
  timezone: z.string().default(''),
  locale: z.string().default(''),
  keyboard: z
    .object({
      model: z.string().default('pc105'),
      layout: z.string().default('us'),
      variant: z.string().default(''),
      options: z.string().default(''),
    })
    .default({ model: 'pc105', layout: 'us', variant: '', options: '' }),
  user: UserSpecSchema.nullable().default(null),
  ssh: SshSchema.default({}),
  wifi: WifiSchema.nullable().default(null),
  /** extra systemd units to enable, offline (systemctl --root) */
  enableServices: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// overlays & hooks
// ---------------------------------------------------------------------------

export const OverlayFileSchema = z.object({
  id: z.string(),
  /** absolute path inside the target rootfs */
  path: z.string().min(1),
  mode: z.string().default('0644'),
  owner: z.string().default('root:root'),
  /** inline content; see `encoding` */
  content: z.string().default(''),
  /** how to interpret `content` when materialising the blob */
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  /** OR a file in the bundle: customize/blobs/<blob> (binary-safe) */
  blob: z.string().default(''),
  enabled: z.boolean().default(true),
})

export const HookSchema = z.object({
  id: z.string(),
  name: z.string().default('hook'),
  script: z.string().default(''),
  enabled: z.boolean().default(true),
  /** run inside the new rootfs with chroot instead of on the build host */
  inRootfs: z.boolean().default(false),
})

export const HooksSchema = z.object({
  pre: z.array(HookSchema).default([]),
})

// ---------------------------------------------------------------------------
// target
// ---------------------------------------------------------------------------

export const TargetSchema = z.object({
  product: z.string().min(1),
  suite: z.string().min(1),
  edition: z.string().min(1),
  sectorSize: z.union([z.literal(512), z.literal(4096)]).default(512),
  imageName: z.string().default('output.img'),
  productOverride: z.string().default(''),
})

// ---------------------------------------------------------------------------
// backend
// ---------------------------------------------------------------------------

export const LocalBackendSchema = z.object({
  kind: z.literal('local-docker'),
  /** container image reference */
  image: z.string().default('localhost/rsdk-image:0.1.0-1'),
  engine: z.enum(['podman', 'docker']).default('podman'),
})

export const GhBackendSchema = z.object({
  kind: z.literal('gh-actions'),
  repo: z.string().default(''),
  /** branch prefix the bundle is pushed to */
  branchPrefix: z.string().default('build'),
  /** upload the resulting image to a GitHub Release */
  publishRelease: z.boolean().default(false),
  /** xz-compress the image before uploading */
  compress: z.boolean().default(true),
  keepBranch: z.boolean().default(true),
})

export const BackendSchema = z.discriminatedUnion('kind', [LocalBackendSchema, GhBackendSchema])

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

export const MetaSchema = z.object({
  name: z.string().min(1),
  notes: z.string().default(''),
})

export const ProfileSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  meta: MetaSchema,
  target: TargetSchema,
  repos: ReposSchema.default({}),
  packages: PackagesSchema.default({}),
  system: SystemSchema.default({}),
  files: z.array(OverlayFileSchema).default([]),
  hooks: HooksSchema.default({}),
  backend: BackendSchema,
})

export type ExtraAptRepo = z.infer<typeof ExtraAptRepoSchema>
export type Repos = z.infer<typeof ReposSchema>
export type Packages = z.infer<typeof PackagesSchema>
export type UserSpec = z.infer<typeof UserSpecSchema>
export type SshSpec = z.infer<typeof SshSchema>
export type WifiSpec = z.infer<typeof WifiSchema>
export type SystemSpec = z.infer<typeof SystemSchema>
export type OverlayFile = z.infer<typeof OverlayFileSchema>
export type Hook = z.infer<typeof HookSchema>
export type Target = z.infer<typeof TargetSchema>
export type Backend = z.infer<typeof BackendSchema>
export type LocalBackend = z.infer<typeof LocalBackendSchema>
export type GhBackend = z.infer<typeof GhBackendSchema>
export type Profile = z.infer<typeof ProfileSchema>

export function parseProfile(input: unknown): Profile {
  return ProfileSchema.parse(input)
}

export function safeParseProfile(input: unknown) {
  return ProfileSchema.safeParse(input)
}
