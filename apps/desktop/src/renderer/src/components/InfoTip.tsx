import { useEffect, useRef, useState, type ReactNode } from 'react'
import Tooltip from './Tooltip.js'

interface Props {
  /** The explanation, in a line or a few: what is always true of the thing beside it. */
  text: ReactNode
  /** What it explains, for its name: `query parameters` makes it "About query parameters". */
  about: string
}

/**
 * An explanation kept out of the way until it is wanted: a small ⓘ beside what
 * it explains, its text on hover or keyboard focus, kept up by a click until a
 * click elsewhere or Escape. For what is always true of a thing, the kind of
 * text that helps once and is in the way every time after; what changes with
 * the state of things, a warning, or a next step to take stays in plain sight.
 */
export default function InfoTip({ text, about }: Props) {
  const [pinned, setPinned] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  // A click anywhere else puts it away, as a menu goes.
  useEffect(() => {
    if (!pinned) return
    const away = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node)) setPinned(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [pinned])

  return (
    <Tooltip text={text} wide pinned={pinned} onDismiss={() => setPinned(false)}>
      <button
        ref={button}
        type="button"
        className={`info-tip${pinned ? ' pinned' : ''}`}
        aria-label={`About ${about}`}
        onClick={(event) => {
          // Not a click on what it sits in, a heading's toggle say.
          event.stopPropagation()
          setPinned(!pinned)
        }}
      >
        <svg
          viewBox="0 0 16 16"
          width={14}
          height={14}
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v4" />
          <circle cx="8" cy="4.9" r=".35" fill="currentColor" />
        </svg>
      </button>
    </Tooltip>
  )
}
