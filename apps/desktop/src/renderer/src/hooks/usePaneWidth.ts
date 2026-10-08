import { useCallback, useState } from 'react'

export interface PaneWidth {
  width: number
  /**
   * The width as laid out now, where `width` can lag a change of layout by a
   * frame: what a drag or an arrow key starts from.
   */
  measure?: () => number
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
 *
 * `max` can follow the room there is. The width asked for is kept as asked:
 * less room narrows the pane for as long as it lasts, and it is back at that
 * width once there is room again.
 */
export function usePaneWidth(key: string, initial: number, min: number, max: number): PaneWidth {
  const [stored, setStored] = useState(() => read(key) ?? initial)
  const width = clamp(stored, min, max)

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

/**
 * A pane that shares its room with the one beside it, by a share the user can
 * drag, remembered between launches. A share rather than a width, so a wider
 * window widens both in proportion, and the default can be an even split.
 *
 * `room` is the two panes' width together, as measured. The divider works in
 * pixels, so the share is given to it, and taken from it, as a width.
 * `measureRoom` reads that width from the layout as it is now: `room` is set
 * once a resize is observed, a frame or so after it, and a drag that starts
 * straight after the panes change size would otherwise start from the old one.
 */
export function usePaneShare(
  key: string,
  initial: number,
  room: number,
  min: number,
  measureRoom?: () => number
): PaneWidth & { share: number } {
  const [stored, setStored] = useState(() => {
    const share = read(key) ?? initial
    return share < 1 ? share : initial
  })
  const share = fitShare(stored, room, min)
  const roomNow = useCallback(() => measureRoom?.() || room, [measureRoom, room])

  const setWidth = useCallback(
    (next: number) => {
      const now = roomNow()
      if (now <= 0) return
      const share = fitShare(next / now, now, min)
      setStored(share)
      write(key, Number(share.toFixed(4)))
    },
    [key, roomNow, min]
  )

  const measure = useCallback(() => {
    const now = roomNow()
    return Math.round(fitShare(stored, now, min) * now)
  }, [roomNow, stored, min])

  const reset = useCallback(() => {
    setStored(initial)
    write(key, initial)
  }, [key, initial])

  return {
    share,
    width: Math.round(share * room),
    measure,
    setWidth,
    reset,
    min,
    max: Math.max(min, room - min)
  }
}

/**
 * A share of `room` that leaves each of the two panes `min` pixels at least:
 * what a narrower window, or a wider pane beside them, makes of one stored.
 */
export function fitShare(share: number, room: number, min: number): number {
  if (room <= 2 * min) return 0.5
  return Math.min(Math.max(share, min / room), 1 - min / room)
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
