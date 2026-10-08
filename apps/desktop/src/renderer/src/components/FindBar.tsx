import { useEffect, type RefObject } from 'react'
import { findCount, findKey, type FindState, type Found } from '../bodyFind.js'
import Tooltip from './Tooltip.js'

interface Props {
  find: FindState
  onFind: (changes: Partial<FindState>) => void
  found: Found
  /** The match shown as the current one, by its place among them. */
  current: number
  /** Go to the next match, or the previous one. */
  onStep: (by: 1 | -1) => void
  /** The field, for ⌘F to focus and select what it holds. */
  inputRef: RefObject<HTMLInputElement | null>
}

const MAC = navigator.userAgent.includes('Mac')
const NEXT_KEY = MAC ? '⌘G' : 'F3'
const PREVIOUS_KEY = MAC ? '⇧⌘G' : 'Shift+F3'

/**
 * Find in the response body: what to look for, Match case, how many were
 * found, and the way from one match to the next. Enter and ⌘G (F3 off a Mac)
 * go on, with Shift back; Escape in the field closes it.
 */
export default function FindBar({ find, onFind, found, current, onStep, inputRef }: Props) {
  // ⌘G and F3 go on from wherever focus is while the bar is open; CodeMirror keeps its own.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const key = findKey(event)
      if (key !== 'next' && key !== 'previous') return
      event.preventDefault()
      onStep(key === 'next' ? 1 : -1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onStep])

  const none = found.matches.length === 0

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        type="text"
        value={find.query}
        placeholder="Find in body"
        aria-label="Find in the response body"
        spellCheck={false}
        onChange={(event) => onFind({ query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onFind({ open: false })
          }
        }}
      />
      <Tooltip text="Match case">
        <button
          type="button"
          className="find-case"
          aria-label="Match case"
          aria-pressed={find.matchCase}
          onClick={() => onFind({ matchCase: !find.matchCase })}
        >
          Aa
        </button>
      </Tooltip>
      {find.query !== '' && (
        <span className={`find-count${none ? ' none' : ''}`} aria-live="polite">
          {findCount(found, current)}
        </span>
      )}
      <Tooltip text={`Previous match (${PREVIOUS_KEY})`}>
        <button
          type="button"
          aria-label="Previous match"
          disabled={none}
          onClick={() => onStep(-1)}
        >
          ↑
        </button>
      </Tooltip>
      <Tooltip text={`Next match (Enter, ${NEXT_KEY})`}>
        <button type="button" aria-label="Next match" disabled={none} onClick={() => onStep(1)}>
          ↓
        </button>
      </Tooltip>
      <Tooltip text="Close (Escape)">
        <button
          type="button"
          className="find-close"
          aria-label="Close find"
          onClick={() => onFind({ open: false })}
        >
          ×
        </button>
      </Tooltip>
    </div>
  )
}
