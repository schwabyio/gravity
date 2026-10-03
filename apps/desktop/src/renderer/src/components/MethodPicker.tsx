import { useEffect, useId, useRef, useState } from 'react'
import { useMenuDismiss } from '../hooks/useMenuDismiss.js'

interface Props<M extends string> {
  value: M
  methods: readonly M[]
  onChange: (method: M) => void
  /** The control's name, for screen readers and tests: `HTTP method`. */
  label: string
}

/**
 * The request's method, picked from a list the app draws itself, so each
 * method shows in its own color in the open list too — a system dropdown on
 * macOS opens the system's menu, which ignores colors.
 *
 * Used as a listbox: arrows, Home and End move through it, Enter or Space
 * picks, Escape or Tab closes, and a letter jumps to the next method starting
 * with it (P: POST, PUT, PATCH in turn). A click anywhere else closes it, as
 * does another menu opening.
 */
export default function MethodPicker<M extends string>(props: Props<M>) {
  const { value, methods } = props
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const menus = useMenuDismiss(open, () => setOpen(false))

  const show = () => {
    menus.opened()
    setActive(Math.max(0, methods.indexOf(value)))
    setOpen(true)
  }
  // Focused as soon as it is drawn, so the keys below reach it.
  useEffect(() => {
    if (open) list.current?.focus()
  }, [open])
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  const pick = (method: M) => {
    if (method !== value) props.onChange(method)
    close()
  }

  const onListKey = (event: React.KeyboardEvent) => {
    const last = methods.length - 1
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(active + 1, last),
      ArrowUp: () => Math.max(active - 1, 0),
      Home: () => 0,
      End: () => last
    }
    if (moves[event.key]) {
      event.preventDefault()
      setActive(moves[event.key]!())
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(methods[active]!)
    } else if (event.key === 'Escape') {
      // Only the list: a drawer underneath stays open.
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab') {
      setOpen(false)
    } else if (/^[a-z]$/i.test(event.key)) {
      const letter = event.key.toUpperCase()
      const next = [...methods.keys()]
        .map((offset) => (active + 1 + offset) % methods.length)
        .find((index) => methods[index]!.startsWith(letter))
      if (next !== undefined) setActive(next)
    }
  }

  return (
    <div className="method-picker">
      <button
        ref={button}
        type="button"
        className="method-picker-button"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={(event) => {
          // Its own click must not reach the window, which closes open menus.
          event.stopPropagation()
          if (open) close()
          else show()
        }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key) && !open) {
            event.preventDefault()
            show()
          }
        }}
      >
        <span className={`method m-${value.toLowerCase()}`}>{value}</span>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          className="method-picker-list"
          role="listbox"
          aria-label={props.label}
          aria-activedescendant={`${id}-${methods[active]}`}
          tabIndex={-1}
          onKeyDown={onListKey}
          onClick={(event) => event.stopPropagation()}
        >
          {methods.map((method, index) => (
            <li
              key={method}
              id={`${id}-${method}`}
              role="option"
              aria-selected={method === value}
              className={`${index === active ? 'active' : ''}${method === value ? ' chosen' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(method)}
            >
              <span className={`method m-${method.toLowerCase()}`}>{method}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
