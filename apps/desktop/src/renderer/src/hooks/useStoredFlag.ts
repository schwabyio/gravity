import { useCallback, useState } from 'react'

/**
 * A boolean the user sets, remembered between launches — whether a pane is
 * hidden, say. Guarded like `usePaneWidth`: storage may be unavailable, and the
 * flag then simply resets to `false` next time.
 */
export function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === 'true'
    } catch {
      return false
    }
  })

  const set = useCallback(
    (next: boolean) => {
      setValue(next)
      try {
        window.localStorage.setItem(key, String(next))
      } catch {
        // The pane still works; it just forgets.
      }
    },
    [key]
  )

  return [value, set]
}
