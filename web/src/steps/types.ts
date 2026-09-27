import type { BoardVerdicts, Catalog, EnvStatus, Profile } from '@rsdk-webui/shared'

export type StepProps = {
  /** 'static' = GitHub Pages, no local container */
  mode: 'server' | 'static'
  profile: Profile
  /** shallow-merge a patch into the profile */
  patch: (p: Partial<Profile>) => void
  catalog: Catalog | null
  env: EnvStatus | null
  /** deploy-time per-combination verdicts, when available */
  verdicts: BoardVerdicts | null
  /** navigate to another step */
  goto: (step: string) => void
}
