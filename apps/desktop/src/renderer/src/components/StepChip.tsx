import { useEffect, useState, type ReactNode } from 'react'
import { useMenuDismiss } from '../hooks/useMenuDismiss.js'
import Tooltip from './Tooltip.js'

interface Props {
  /** What it says: the value set, or, unset, what adding one does: `+ flag`. */
  label: ReactNode
  /** Set: drawn solid, saying its value; unset: dashed, as `+ tag` is. */
  set: boolean
  /** Which chip: `step-flag-chip`, `step-repeat-chip`. */
  className: string
  /** How what is set stands: `holds`, `skip`, `error`. */
  tone?: string
  /** What it is, or what it does to the step, on hover. */
  tooltip: ReactNode
  /** The popover's heading and name: `Step feature flags`. */
  title: string
  /** The editor in the popover. */
  children: ReactNode
}

/**
 * A property of the selected step as a chip on its line — feature flags, a
 * list to repeat for — showing what is set at a glance, and opening a small
 * popover with its editor. It closes on a click anywhere else, as a menu does,
 * or on Escape; what is typed in it is kept as it is typed.
 */
export default function StepChip(props: Props) {
  const [open, setOpen] = useState(false)
  const menus = useMenuDismiss(open, () => setOpen(false))

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <span className="step-chip-wrap">
      <Tooltip text={props.tooltip}>
        <button
          type="button"
          className={`step-chip ${props.className}${props.set ? ' set' : ''}${props.tone ? ` ${props.tone}` : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation()
            if (!open) menus.opened()
            setOpen(!open)
          }}
        >
          {props.label}
        </button>
      </Tooltip>
      {open && (
        // Its own clicks stay its own: a click outside it is what closes it.
        <div
          className="step-chip-popover"
          role="dialog"
          aria-label={props.title}
          onClick={(event) => event.stopPropagation()}
        >
          <p className="step-chip-title">{props.title}</p>
          {props.children}
        </div>
      )}
    </span>
  )
}
