import { useEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (docs: string) => void
  /** For screen readers and tests: `Step docs`, `Collection docs`. */
  label: string
  placeholder: string
  /** Leave editing for the rendered docs; Escape does the same. */
  onDone?: () => void
}

/**
 * Docs written in place: markdown in a plain text box, saved as the file's
 * `docs:` as it is typed, with the rest of the edits. Focused as it opens, so
 * asking to edit means typing straight away.
 */
export default function DocsEditor(props: Props) {
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  return (
    <textarea
      ref={box}
      className="docs-editor"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && props.onDone) {
          event.preventDefault()
          event.stopPropagation()
          props.onDone()
        }
      }}
      placeholder={props.placeholder}
      aria-label={props.label}
      spellCheck
    />
  )
}
