import { useEffect, useRef, useState } from 'react'
import type { VariablePreview, VariablePreviews } from '@schwabyio/gravity-core/model'
import VariableCard from './VariableCard.js'

interface Props {
  value: string
  onChange: (value: string) => void
  previews: VariablePreviews
  /** Copies a variable's value; main resolves it so secrets stay out of here. */
  onCopy: (name: string) => Promise<boolean>
  placeholder?: string
  ariaLabel: string
  className?: string
  /** Shown, not typed in: its variables still say what they resolve to. */
  readOnly?: boolean
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

/** How a `{{name}}` stands, as its class: `resolved`, `secret`, or `unresolved`. */
export const variableState = (preview: VariablePreview | undefined): string =>
  preview === undefined ? 'unresolved' : preview.kind === 'secret' ? 'secret' : 'resolved'

/**
 * A text field that highlights `{{variables}}` and explains them on hover.
 *
 * A plain input cannot colour part of its own text, so the value is drawn twice:
 * the input holds the real text with `color: transparent` and keeps the caret,
 * selection and every editing behaviour a browser already gets right, and a
 * mirror layer on top paints the coloured copy. The mirror lets every pointer
 * event through, so a click or a drag lands in the input wherever it is — inside
 * a `{{variable}}` too — and the variable under the pointer is found by where
 * the pointer is.
 */
export default function VariableInput({
  value,
  onChange,
  previews,
  onCopy,
  placeholder,
  ariaLabel,
  className = '',
  readOnly = false
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<{ name: string; left: number } | null>(null)
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

  /**
   * Open the card of the variable under the pointer, if there is one. Moving off
   * it onto plain text leaves the card open, as leaving the field closes it; nor
   * does a drag selecting text open one.
   */
  const hoverAt = (event: React.MouseEvent) => {
    clearTimeout(closeTimer.current)
    if (event.buttons !== 0 || (event.target as HTMLElement).closest('.var-card')) return
    const mirror = mirrorRef.current
    for (const token of mirror?.querySelectorAll<HTMLElement>('.var-token') ?? []) {
      const box = token.getBoundingClientRect()
      const over =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      if (!over) continue
      const name = token.dataset.name ?? ''
      const left = token.offsetLeft - (mirror?.scrollLeft ?? 0)
      if (hovered?.name !== name || hovered.left !== left) setHovered({ name, left })
      return
    }
  }

  /**
   * Close only once the pointer leaves the whole field.
   *
   * Closing when it leaves the *token* left a dead zone: the card sits below the
   * input, so travelling to its copy button crossed input area that is not the
   * token, and the card vanished before it could be clicked. The card lives
   * inside this container, so a trip from token to button never leaves it.
   */
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHovered(null), 200)
  }

  return (
    <div className={`var-input ${className}`} onMouseLeave={scheduleClose} onMouseMove={hoverAt}>
      <div className="var-mirror" ref={mirrorRef} aria-hidden="true">
        {tokenize(value).map((segment, index) =>
          segment.name === undefined ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <span
              key={index}
              className={`var-token ${variableState(previews[segment.name])}`}
              data-name={segment.name}
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
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />

      {hovered && (
        <VariableCard
          name={hovered.name}
          preview={previews[hovered.name]}
          onCopy={onCopy}
          style={{ left: Math.max(0, hovered.left) }}
        />
      )}
    </div>
  )
}
