import { useLayoutEffect, useRef, useState } from 'react'
import DocsEditor from './DocsEditor.js'
import Markdown from './Markdown.js'
import PencilIcon from './PencilIcon.js'
import Tooltip from './Tooltip.js'

interface Props {
  source: string
  /** Height in pixels shown before the panel offers to expand. */
  collapsedHeight?: number
  /** Where edits go; without it the docs are only read. */
  onChange?: (docs: string) => void
  /** Written in place rather than read: the text box instead of the rendered docs. */
  editing?: boolean
  onEditing?: (editing: boolean) => void
}

/**
 * Rendered docs, collapsed until they are worth the room.
 *
 * Docs on a collection run from a one-line objective to a couple of screens of
 * examples, and the step list and editor below need the vertical space more.
 * So the panel measures itself and only offers a toggle when there is actually
 * something hidden.
 */
export default function DocsPanel({
  source,
  collapsedHeight = 72,
  onChange,
  editing = false,
  onEditing
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return
    setOverflows(element.scrollHeight > collapsedHeight + 4)
  }, [source, collapsedHeight, editing])

  if (editing && onChange) {
    return (
      <section className="docs-panel editing">
        <DocsEditor
          value={source}
          onChange={onChange}
          label="Collection docs"
          placeholder="Describe this collection in markdown: what it covers, and anything a reader needs first."
          onDone={() => onEditing?.(false)}
        />
        <button type="button" className="docs-done" onClick={() => onEditing?.(false)}>
          Done
        </button>
      </section>
    )
  }
  if (source.trim() === '') return null

  return (
    <section className={`docs-panel${expanded ? ' expanded' : ''}${onChange ? ' editable' : ''}`}>
      {onChange && (
        <Tooltip text="Edit the collection’s docs">
          <button
            type="button"
            className="docs-edit"
            onClick={() => onEditing?.(true)}
            aria-label="Edit the collection’s docs"
          >
            <PencilIcon />
          </button>
        </Tooltip>
      )}
      <div
        ref={bodyRef}
        className="docs-body"
        style={expanded ? undefined : { maxHeight: collapsedHeight }}
      >
        <Markdown source={source} />
      </div>
      {overflows && (
        // Pinned to the panel's top edge, which does not move, so the button
        // stays under the pointer whichever way it was last clicked.
        <Tooltip text={expanded ? 'Show less' : 'Show more'}>
          <button
            type="button"
            className="docs-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Show less' : 'Show more'}
          >
            {/* One chevron, turned over when expanded, so it reads as a toggle. */}
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M3.5 6 8 10.5 12.5 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </Tooltip>
      )}
    </section>
  )
}
