import { useEffect, useRef, useState } from 'react'
import type { VariablePreview, VariablePreviews } from '@schwabyio/gravity-core/model'

interface Props {
  value: string
  onChange: (value: string) => void
  previews: VariablePreviews
  /** Copies a variable's value; main resolves it so secrets stay out of here. */
  onCopy: (name: string) => Promise<boolean>
  placeholder?: string
  ariaLabel: string
  className?: string
}

interface Segment {
  text: string
  /** Set when the segment is a `{{name}}` reference. */
  name?: string
}

const REFERENCE = /\{\{\s*([^{}\s]+)\s*\}\}/g

/** Split a value into plain text and variable references, in order. */
export function tokenize(value: string): Segment[] {
  const segments: Segment[] = []
  let index = 0

  for (const match of value.matchAll(REFERENCE)) {
    const at = match.index ?? 0
    if (at > index) segments.push({ text: value.slice(index, at) })
    segments.push({ text: match[0], name: match[1] })
    index = at + match[0].length
  }
  if (index < value.length) segments.push({ text: value.slice(index) })
  return segments
}

const stateOf = (preview: VariablePreview | undefined): string =>
  preview === undefined ? 'unresolved' : preview.kind === 'secret' ? 'secret' : 'resolved'

/**
 * A text field that highlights `{{variables}}` and explains them on hover.
 *
 * A plain input cannot colour part of its own text, so the value is drawn twice:
 * the input holds the real text with `color: transparent` and keeps the caret,
 * selection and every editing behaviour a browser already gets right, and a
 * mirror layer on top paints the coloured copy. The mirror ignores pointer
 * events except on the tokens themselves, so hovering a variable works while
 * clicking anywhere else still lands in the input.
 */
export default function VariableInput({
  value,
  onChange,
  previews,
  onCopy,
  placeholder,
  ariaLabel,
  className = ''
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<{ name: string; left: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The mirror has to follow the input when a long value scrolls sideways.
  useEffect(() => {
    const input = inputRef.current
    const mirror = mirrorRef.current
    if (!input || !mirror) return
    const sync = () => {
      mirror.scrollLeft = input.scrollLeft
    }
    sync()
    input.addEventListener('scroll', sync)
    return () => input.removeEventListener('scroll', sync)
  }, [value])

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  /**
   * Drop the card when its token stops existing.
   *
   * Editing the text does not move the pointer, so nothing would otherwise close
   * a card describing a variable the value no longer contains.
   */
  useEffect(() => {
    if (hovered && !tokenize(value).some((segment) => segment.name === hovered.name)) {
      setHovered(null)
    }
  }, [value, hovered])

  const openTooltip = (name: string, element: HTMLElement) => {
    clearTimeout(closeTimer.current)
    setCopied(false)
    setHovered({ name, left: element.offsetLeft - (mirrorRef.current?.scrollLeft ?? 0) })
  }

  /**
   * Close only once the pointer leaves the whole field.
   *
   * Closing when it leaves the *token* left a dead zone: the card sits below the
   * input, so travelling to its Copy button crossed input area that is not the
   * token, and the card vanished before it could be clicked. The card lives
   * inside this container, so a trip from token to button never leaves it.
   */
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHovered(null), 200)
  }

  const preview = hovered ? previews[hovered.name] : undefined

  const copy = async () => {
    if (!hovered) return
    if (await onCopy(hovered.name)) setCopied(true)
  }

  return (
    <div
      className={`var-input ${className}`}
      onMouseLeave={scheduleClose}
      onMouseEnter={() => clearTimeout(closeTimer.current)}
    >
      <div className="var-mirror" ref={mirrorRef} aria-hidden="true">
        {tokenize(value).map((segment, index) =>
          segment.name === undefined ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <span
              key={index}
              className={`var-token ${stateOf(previews[segment.name])}`}
              onMouseEnter={(event) => openTooltip(segment.name as string, event.currentTarget)}
            >
              {segment.text}
            </span>
          )
        )}
        {/* A trailing space keeps the caret column measurable at end of line. */}
        <span>&nbsp;</span>
      </div>

      <input
        ref={inputRef}
        className="var-field"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />

      {hovered && (
        <div className="var-card" role="tooltip" style={{ left: Math.max(0, hovered.left) }}>
          <div className="var-card-name">{hovered.name}</div>

          {preview === undefined ? (
            <div className="var-card-value unresolved">Not defined in this environment</div>
          ) : preview.kind === 'dynamic' ? (
            <div className="var-card-value muted">Generated for each request</div>
          ) : preview.kind === 'secret' ? (
            <div className="var-card-value muted">Secret — hidden here; Copy still works</div>
          ) : (
            <div className="var-card-value">{preview.value === '' ? '(empty)' : preview.value}</div>
          )}

          <div className="var-card-foot">
            <span className="var-card-origin">{preview?.origin ?? 'unresolved'}</span>
            {preview !== undefined && preview.kind !== 'dynamic' && (
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
