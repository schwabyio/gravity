import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cloneElement, type ReactElement, type ReactNode } from 'react'

/** How close a tooltip may come to the window's edge. */
const EDGE = 8

interface Props {
  /** What the control does, in a few words — or a title and a few lines, for a `wide` one. */
  text: ReactNode
  /** Room for a few lines of explanation, rather than a few words. */
  wide?: boolean
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
 * A hover and focus explanation for a control with no visible text, or one
 * whose few words cannot say all it does.
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
export default function Tooltip({ text, wide = false, children, delay = 350 }: Props) {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [position, setPosition] = useState<Position | null>(null)
  /**
   * Pressed with the pointer: neither the focus a click gives the control nor
   * the focus given back when a dialog it opened closes — a folder picker,
   * say — asks for the explanation. Until the pointer comes back to it, or
   * focus moves elsewhere in the window.
   */
  const pressed = useRef(false)

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

  // Placed before its size is known, a tooltip by the window's edge would run
  // off it: moved in from the side, or above its trigger, before it paints.
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !position) return
    const { left, right, bottom } = tip.getBoundingClientRect()
    const shift = Math.round(
      left < EDGE
        ? EDGE - left
        : right > window.innerWidth - EDGE
          ? window.innerWidth - EDGE - right
          : 0
    )
    const flip = !position.above && bottom > window.innerHeight - EDGE
    if (shift === 0 && !flip) return
    const trigger = triggerRef.current?.firstElementChild ?? triggerRef.current
    setPosition({
      left: position.left + shift,
      top: flip && trigger ? Math.round(trigger.getBoundingClientRect().top - 8) : position.top,
      above: position.above || flip
    })
  }, [position])

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
          pressed.current = false
          clearTimeout(timer.current)
          timer.current = setTimeout(show, delay)
        }}
        onPointerLeave={hide}
        // Pressing the button should act, not leave an explanation behind.
        onPointerDown={() => {
          pressed.current = true
          hide()
        }}
        onFocusCapture={() => {
          if (!pressed.current) show()
        }}
        onBlurCapture={() => {
          // The window losing focus to a dialog is not focus moving on.
          if (document.hasFocus()) pressed.current = false
          hide()
        }}
      >
        {cloneElement(children, { 'aria-describedby': id })}
      </span>

      {position && (
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`tooltip${wide ? ' wide' : ''}${position.above ? ' above' : ''}`}
          style={{ left: position.left, top: position.top }}
        >
          {text}
        </div>
      )}
    </>
  )
}
