import { useCallback, useEffect, useRef, useState } from 'react'
import type { FlagValue } from '@schwabyio/gravity-core/model'
import type { EnvironmentOverride, FlagsView } from '@shared/ipc.js'

/**
 * The open project's feature flags for the chosen environment, as main
 * resolves them — fixed values, the environment's command, the app's
 * overrides — and the ways to refresh and override them.
 *
 * Reloaded when the project, the environment or its unsaved edits change, and
 * whenever `rescan` does (a project's view is replaced on every rescan, so an
 * environment file changed on disk is picked up). The command itself only
 * runs again on `refresh`, or when it is edited.
 */
export function useFlags(
  root: string | null,
  environment: string | null,
  environmentOverrides: EnvironmentOverride[],
  rescan: unknown
) {
  const [view, setView] = useState<FlagsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(
    async (refresh: boolean) => {
      if (!root) {
        setView(null)
        return
      }
      const mine = ++request.current
      setBusy(true)
      const result = await window.desktop.flags.get(root, environment, {
        refresh,
        environmentOverrides
      })
      if (mine !== request.current) return
      setBusy(false)
      if (result.ok) {
        setView(result.flags)
        setFailure(null)
      } else {
        setFailure(result.message)
      }
    },
    [root, environment, environmentOverrides]
  )

  useEffect(() => {
    void load(false)
  }, [load, rescan])

  const setOverride = useCallback(
    async (name: string, value: FlagValue | null) => {
      if (!root) return
      const result = await window.desktop.flags.setOverride(root, environment, name, value)
      if (result.ok) {
        // A change of override is a fresh view; reload to keep unsaved environment edits in it.
        await load(false)
      } else {
        setFailure(result.message)
      }
    },
    [root, environment, load]
  )

  return {
    view,
    busy,
    /** Why the flags could not be read at all — separate from a command's failure, in `view.error`. */
    failure,
    refresh: useCallback(() => load(true), [load]),
    setOverride
  }
}
