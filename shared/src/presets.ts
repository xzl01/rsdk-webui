import type { Product } from './catalog.ts'
import { ProfileSchema, type Profile } from './schema.ts'

export function newId(): string {
  // short, filesystem/branch friendly
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  )
}

export type PackagePreset = {
  id: string
  name: string
  description: string
  packages: string[]
}

/** Curated starting points. Everything here is a plain apt package name. */
export const PACKAGE_PRESETS: PackagePreset[] = [
  {
    id: 'zh-cn',
    name: '中文环境',
    description: '中文字体、输入法、中文 manpage',
    packages: ['fonts-noto-cjk', 'fonts-noto-cjk-extra', 'ibus', 'ibus-libpinyin', 'manpages-zh'],
  },
  {
    id: 'dev-tools',
    name: '开发工具',
    description: '编译器、git、常用命令行工具',
    packages: ['build-essential', 'git', 'curl', 'wget', 'vim', 'tmux', 'jq', 'rsync', 'htop'],
  },
  {
    id: 'containers',
    name: '容器',
    description: 'Docker / Podman',
    packages: ['docker.io', 'docker-compose-plugin'],
  },
  {
    id: 'media',
    name: '媒体播放',
    description: 'ffmpeg / mpv / gstreamer 插件',
    packages: ['ffmpeg', 'mpv', 'gstreamer1.0-plugins-good', 'gstreamer1.0-plugins-bad', 'gstreamer1.0-libav'],
  },
  {
    id: 'headless-server',
    name: '无头服务器',
    description: '把 CLI 版本变成一台省心的服务器',
    packages: ['avahi-daemon', 'nftables', 'fail2ban', 'unattended-upgrades', 'smartmontools', 'ethtool'],
  },
  {
    id: 'kiosk',
    name: 'Kiosk / 数字标牌',
    description: '最小图形栈 + 自动登录的浏览器',
    packages: ['chromium', 'xserver-xorg', 'xinit', 'unclutter', 'xdotool'],
  },
  {
    id: 'debug',
    name: '调试工具',
    description: '排查启动 / 内核 / 网络问题',
    packages: ['strace', 'ltrace', 'gdb', 'tcpdump', 'iproute2', 'iw', 'pciutils', 'usbutils', 'lsof', 'sysstat'],
  },
]

export const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
]

export const LOCALES = [
  'en_US.UTF-8',
  'zh_CN.UTF-8',
  'zh_TW.UTF-8',
  'ja_JP.UTF-8',
  'ko_KR.UTF-8',
  'de_DE.UTF-8',
  'fr_FR.UTF-8',
  'ru_RU.UTF-8',
  'C.UTF-8',
]

export const KEYBOARD_LAYOUTS = ['us', 'cn', 'gb', 'de', 'fr', 'ru', 'jp', 'kr', 'es', 'it']

/**
 * radxa-deb 镜像。**只放实测同步了这个仓库的站点**：
 * rsdk 会拼成 `deb <mirror>/<suite> <suite> main`，站点没有这个仓库时
 * apt-get update 直接失败，构建在装包阶段就崩。
 *
 * 2026-09-28 实测（<mirror>/bookworm/dists/bookworm/Release 与 rk3588-bookworm 均 200）：
 *   aghost.cn / lzu.edu.cn / hust.edu.cn / mirror.nju.edu.cn
 * 当时 **USTC 与清华 TUNA 都没有 radxa-deb**（/radxa-deb/ 与 /radxa/ 都是 404），
 * 注意这两个站确实有 Debian 镜像，但那是 DISTRO_MIRRORS 那一栏，别混。
 *
 * 复核：./ops/check-mirrors.py
 */
export const RADXA_MIRRORS = [
  { label: '官方 radxa-deb (GitHub Pages)', value: '' },
  { label: 'mirrors.aghost.cn (radxa-deb)', value: 'https://mirrors.aghost.cn/radxa-deb' },
  { label: 'mirrors.lzu.edu.cn (radxa-deb)', value: 'https://mirrors.lzu.edu.cn/radxa-deb' },
  { label: 'mirrors.hust.edu.cn (radxa-deb)', value: 'https://mirrors.hust.edu.cn/radxa-deb' },
  { label: 'mirror.nju.edu.cn (radxa-deb)', value: 'https://mirror.nju.edu.cn/radxa-deb' },
]

/** 上面这些站点里实测可用的主机名 —— UI 拿它判断用户手填/旧方案里的地址。 */
export const RADXA_MIRROR_HOSTS = RADXA_MIRRORS.map((m) => m.value)
  .filter(Boolean)
  .map((v) => new URL(v).host)

export const DISTRO_MIRRORS = [
  { label: '上游默认 (deb.debian.org / ports.ubuntu.com)', value: '' },
  { label: 'mirrors.ustc.edu.cn', value: 'https://mirrors.ustc.edu.cn' },
  { label: 'mirrors.tuna.tsinghua.edu.cn', value: 'https://mirrors.tuna.tsinghua.edu.cn' },
  { label: 'mirrors.lzu.edu.cn', value: 'https://mirrors.lzu.edu.cn' },
  { label: 'mirrors.hust.edu.cn', value: 'https://mirrors.hust.edu.cn' },
  { label: 'mirror.nju.edu.cn', value: 'https://mirror.nju.edu.cn' },
  { label: 'mirror.nyist.edu.cn', value: 'https://mirror.nyist.edu.cn' },
]

/** Normalise `soc` (string in rsdk 0.1.0, array upstream) to a list. */
export function socList(product: Product | undefined): string[] {
  const soc = product?.soc
  if (!soc) return []
  return Array.isArray(soc) ? soc : [soc]
}

/** Normalise `sector_size` to a list of candidate sizes. */
export function sectorList(product: Product | undefined): number[] {
  const size = product?.sector_size
  if (size === undefined || size === null) return [512]
  return Array.isArray(size) ? size : [size]
}

export function defaultProduct(products: Product[]): Product | undefined {
  return products.find((p) => p.product === 'rock-5b') ?? products[0]
}

export function newProfile(opts: { product?: Product; image?: string; engine?: 'podman' | 'docker' } = {}): Profile {
  const product = opts.product
  const engine = opts.engine ?? 'podman'
  const raw = {
    version: 1 as const,
    id: newId(),
    meta: {
      name: product ? `${product.product_name ?? product.product}` : '新镜像',
      notes: '',
    },
    target: {
      product: product?.product ?? 'rock-5b',
      suite: product?.supported_suite?.[0] ?? 'bookworm',
      edition: product?.supported_edition?.[0] ?? 'kde',
      sectorSize: (sectorList(product)[0] ?? 512) as 512 | 4096,
      imageName: 'output.img',
      productOverride: '',
    },
    backend: {
      kind: 'local-docker' as const,
      engine,
      image: opts.image ?? 'rsdk-image:latest',
    },
  }
  return ProfileSchema.parse(raw)
}

/** Clamp a profile against the selected product's supported values. */
export function normalizeForProduct(p: Profile, product: Product | undefined): Profile {
  if (!product) return p
  const suites = product.supported_suite ?? []
  const editions = product.supported_edition ?? []
  const sectors = sectorList(product) as (512 | 4096)[]
  return {
    ...p,
    target: {
      ...p.target,
      suite: suites.includes(p.target.suite) ? p.target.suite : suites[0] ?? p.target.suite,
      edition: editions.includes(p.target.edition) ? p.target.edition : editions[0] ?? p.target.edition,
      sectorSize: sectors.includes(p.target.sectorSize) ? p.target.sectorSize : sectors[0] ?? 512,
    },
  }
}

export function profileFingerprint(p: Profile): string {
  return [
    p.target.product,
    p.target.suite,
    p.target.edition,
    p.target.sectorSize,
    p.repos.testRepo ? 'test' : 'stable',
  ].join('-')
}
