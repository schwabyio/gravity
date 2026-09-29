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
   * docked to the right — dragging left widens the pane.
   */
  edge?: 'right' | 'left'
}

/** How far an arrow key moves the divider. */
const STEP = 16

/**
 * A draggable divider between two panes.
 *
 * Pointer capture rather than window listeners, so a fast drag that outruns the
 * cursor still tracks, and releasing outside the window still ends cleanly.
 * Width is derived from the distance dragged rather than from the pointer's
 * absolute position, so the divider never jumps to meet the cursor on grab.
 *
 * Keyboard-operable and double-click to reset, because a divider dragged to a
 * useless width should not need a fresh install to undo.
 */
export default function Resizer({ pane, label, offset, edge = 'right' }: Props) {
  const sign = edge === 'left' ? -1 : 1
  const origin = useRef<{ x: number; width: number } | null>(null)

  // While dragging, the whole window shows the resize cursor and stops
  // selecting text — otherwise a drag across the editor highlights it.
  useEffect(() => () => document.body.classList.remove('resizing'), [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    origin.current = { x: event.clientX, width: pane.width }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    pane.setWidth(origin.current.width + sign * (event.clientX - origin.current.x))
  }

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    document.body.classList.remove('resizing')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const move = { ArrowLeft: -STEP, ArrowRight: STEP }[event.key]
    if (move !== undefined) {
      event.preventDefault()
      pane.setWidth(pane.width + sign * move)
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
      className={`resizer${offset === undefined ? '' : ' resizer-offset'}${edge === 'left' ? ' resizer-left' : ''}`}
      style={offset === undefined ? undefined : { left: offset - 3 }}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={pane.width}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={pane.reset}
      onKeyDown={onKeyDown}
      title="Drag to resize · double-click to reset"
    />
  )
}
