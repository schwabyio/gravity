import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { cloneElement, type ReactElement } from 'react'

interface Props {
  /** What the control does, in a few words. */
  text: string
  /** The control itself. Its accessible name is left alone. */
  children: ReactElement<Record<string, unknown>>
  /** Milliseconds of hover before it appears. Focus shows it at once. */
  delay?: number
}

interface Position {
  left: number
  top: number
  above: boolean
}

/**
 * A hover and focus explanation for a control with no visible text.
 *
 * Preferred over the native `title` attribute, which waits about a second,
 * renders in the OS style regardless of theme, and never appears for keyboard
 * users at all.
 *
 * The bubble is `position: fixed` and placed from the trigger's own rectangle,
 * so it is never clipped by a scrolling pane or an `overflow: hidden` ancestor —
 * which every place one of these buttons lives happens to have.
 *
 * It describes rather than names: the control keeps its `aria-label`, and this
 * is attached with `aria-describedby`, so screen readers hear the name first and
 * the explanation after.
 */
export default function Tooltip({ text, children, delay = 350 }: Props) {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [position, setPosition] = useState<Position | null>(null)

  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setPosition(null)
  }, [])

  const show = useCallback(() => {
    const trigger = triggerRef.current?.firstElementChild ?? triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const above = rect.bottom + 46 > window.innerHeight
    setPosition({
      left: Math.round(rect.left + rect.width / 2),
      top: Math.round(above ? rect.top - 8 : rect.bottom + 8),
      above
    })
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  // A tooltip left hanging over the page is worse than none, so anything that
  // takes attention elsewhere dismisses it.
  useEffect(() => {
    if (!position) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [position, hide])

  return (
    <>
      <span
        ref={triggerRef}
        className="tooltip-trigger"
        onPointerEnter={() => {
          clearTimeout(timer.current)
          timer.current = setTimeout(show, delay)
        }}
        onPointerLeave={hide}
        // Pressing the button should act, not leave an explanation behind.
        onPointerDown={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
      >
        {cloneElement(children, { 'aria-describedby': id })}
      </span>

      {position && (
        <div
          id={id}
          role="tooltip"
          className={`tooltip${position.above ? ' above' : ''}`}
          style={{ left: position.left, top: position.top }}
        >
          {text}
        </div>
      )}
    </>
  )
}
