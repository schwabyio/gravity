import { useCallback, useState } from 'react'

export interface PaneWidth {
  width: number
  setWidth: (width: number) => void
  reset: () => void
  min: number
  max: number
}

/**
 * A pane width the user can drag, remembered between launches.
 *
 * Kept in `localStorage` rather than in the workspace registry: this is a
 * per-viewer convenience, not state anything else reads, and it must not be
 * something a missing file or a failed write can break. Every access is guarded,
 * because storage can be unavailable and the pane still has to render.
 */
export function usePaneWidth(key: string, initial: number, min: number, max: number): PaneWidth {
  const [width, setStored] = useState(() => clamp(read(key) ?? initial, min, max))

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clamp(next, min, max)
      setStored(clamped)
      write(key, clamped)
    },
    [key, min, max]
  )

  const reset = useCallback(() => setWidth(initial), [setWidth, initial])

  return { width, setWidth, reset, min, max }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.round(value), min), max)

function read(key: string): number | null {
  try {
    const stored = Number(window.localStorage.getItem(key))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

function write(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Private window, blocked storage: the pane still works, it just forgets.
  }
}
