import { useEffect, useState } from 'react'
import type { EnvStatus, Profile } from '@rsdk-webui/shared'
import { api } from './api.ts'

export function useBackendEnv(backend: Profile['backend'], fallback: EnvStatus | null) {
  const key = backend.kind === 'local-docker' ? JSON.stringify([backend.engine, backend.image]) : ''
  const [checked, setChecked] = useState<{ key: string; env: EnvStatus | null }>({ key: '', env: null })
  useEffect(() => {
    if (!key) return
    let stale = false
    const timer = setTimeout(() => {
      void api.env(backend).then((env) => {
        if (!stale) setChecked({ key, env })
      }).catch(() => { if (!stale) setChecked({ key, env: null }) })
    }, 250)
    return () => { stale = true; clearTimeout(timer) }
  }, [key, fallback])
  return key ? (checked.key === key ? checked.env : null) : fallback
}
