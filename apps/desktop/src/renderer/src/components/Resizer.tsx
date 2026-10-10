import { useEffect, useRef } from 'react'
import type { PaneWidth } from '../hooks/usePaneWidth.js'

interface Props {
  pane: PaneWidth
  label: string
  /**
   * Distance from the container's left edge, when the divider cannot live
   * inside the pane it resizes — a pane that scrolls, for instance.
   */
  offset?: number
  /**
   * Which edge of its pane the divider sits on. On the left edge — a pane
   * docked to the right — dragging left widens the pane; on the top edge — a
   * pane docked to the bottom, whose `width` is its height — dragging up
   * makes it taller.
   */
  edge?: 'right' | 'left' | 'top'
}

/** How far an arrow key moves the divider. */
const STEP = 16

/** The arrow keys that move a divider, by which way it moves, and how far. */
const ARROWS: Record<'columns' | 'rows', Partial<Record<string, number>>> = {
  columns: { ArrowLeft: -STEP, ArrowRight: STEP },
  rows: { ArrowUp: -STEP, ArrowDown: STEP }
}

/**
 * A draggable divider between two panes.
 *
 * Pointer capture rather than window listeners, so a fast drag that outruns the
 * cursor still tracks, and releasing outside the window still ends cleanly.
 * Width is derived from the distance dragged rather than from the pointer's
 * absolute position, so the divider never jumps to meet the cursor on grab.
 *
 * The drag ends when the capture does, not on a pointerup: a release the
 * window never sees — let go over another app, say — has no pointerup, and
 * Chromium ends the capture at the next move instead. Waiting for a pointerup
 * left the resize cursor on everywhere.
 *
 * Keyboard-operable and double-click to reset, because a divider dragged to a
 * useless width should not need a fresh install to undo.
 */
export default function Resizer({ pane, label, offset, edge = 'right' }: Props) {
  const sign = edge === 'right' ? 1 : -1
  const rows = edge === 'top'
  const origin = useRef<{ at: number; width: number } | null>(null)
  const at = (event: React.PointerEvent) => (rows ? event.clientY : event.clientX)

  // While dragging, the whole window shows the resize cursor and stops
  // selecting text — otherwise a drag across the editor highlights it.
  useEffect(() => () => document.body.classList.remove('resizing', 'resizing-rows'), [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { at: at(event), width: pane.measure?.() ?? pane.width }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing')
    if (rows) document.body.classList.add('resizing-rows')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    pane.setWidth(origin.current.width + sign * (at(event) - origin.current.at))
  }

  // A pointerup or a pointercancel releases the capture on its own.
  const end = () => {
    origin.current = null
    document.body.classList.remove('resizing', 'resizing-rows')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const move = ARROWS[rows ? 'rows' : 'columns'][event.key]
    if (move !== undefined) {
      event.preventDefault()
      pane.setWidth((pane.measure?.() ?? pane.width) + sign * move)
    } else if (event.key === 'Home') {
      event.preventDefault()
      pane.setWidth(pane.min)
    } else if (event.key === 'End') {
      event.preventDefault()
      pane.setWidth(pane.max)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pane.reset()
    }
  }

  return (
    <div
      className={`resizer${offset === undefined ? '' : ' resizer-offset'}${edge === 'right' ? '' : ` resizer-${edge}`}`}
      style={offset === undefined ? undefined : { left: offset - 3 }}
      role="separator"
      aria-orientation={rows ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={pane.width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={end}
      onDoubleClick={pane.reset}
      onKeyDown={onKeyDown}
      title="Drag to resize · double-click to reset"
    />
  )
}
