import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function envPath(name: string, fallback: string): string {
  const v = process.env[name]
  if (!v) return fallback
  return v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v
}

const dataDir = envPath('RSDK_WEBUI_DATA', path.join(os.homedir(), '.local', 'share', 'rsdk-webui'))

export const config = {
  host: process.env.RSDK_WEBUI_HOST ?? '127.0.0.1',
  port: Number(process.env.RSDK_WEBUI_PORT ?? 8787),

  /** everything persistent lives here */
  dataDir,
  cacheDir: path.join(dataDir, 'cache'),
  buildsDir: path.join(dataDir, 'builds'),
  logsDir: path.join(dataDir, 'logs'),
  rsdkTreesDir: path.join(dataDir, 'rsdk-trees'),
  profilesFile: path.join(dataDir, 'profiles.json'),
  jobsFile: path.join(dataDir, 'jobs.json'),

  /** pinned container image holding the official rsdk toolchain */
  image: process.env.RSDK_WEBUI_IMAGE ?? 'rsdk-image:latest',
  imageVersion: process.env.RSDK_WEBUI_IMAGE_VERSION ?? '0.1.0-1',

  /** force an engine: podman | docker | (unset = autodetect) */
  engineOverride: process.env.RSDK_WEBUI_ENGINE as 'podman' | 'docker' | undefined,

  /** podman storage root; 'standard' keeps podman's own default store */
  podmanRoot: envPath('RSDK_WEBUI_PODMAN_ROOT', path.join(dataDir, 'podman-root')),
  podmanRunRoot: envPath('RSDK_WEBUI_PODMAN_RUNROOT', path.join(dataDir, 'podman-run')),

  /** max number of jobs kept in the index */
  jobRetention: Number(process.env.RSDK_WEBUI_JOB_RETENTION ?? 100),
}

export function ensureDirs(): void {
  for (const dir of [
    config.dataDir,
    config.cacheDir,
    config.buildsDir,
    config.logsDir,
    config.rsdkTreesDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
