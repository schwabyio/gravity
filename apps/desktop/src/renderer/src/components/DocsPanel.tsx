import { useState } from 'react'
import ChevronIcon from './ChevronIcon.js'
import DocsEditor from './DocsEditor.js'
import Markdown from './Markdown.js'
import PencilIcon from './PencilIcon.js'
import Tooltip from './Tooltip.js'

interface Props {
  source: string
  /** Where edits go; without it the docs are only read. */
  onChange?: (docs: string) => void
  /** Written in place rather than read: the text box instead of the rendered docs. */
  editing?: boolean
  onEditing?: (editing: boolean) => void
}

/**
 * A collection's docs, under a heading of their own, closed until asked for.
 *
 * Docs on a collection run from a one-line objective to a couple of screens of
 * examples, and the step list and editor below need the vertical space more.
 * So only the heading shows until it is clicked, and each collection opens with
 * its docs closed.
 */
export default function DocsPanel({ source, onChange, editing = false, onEditing }: Props) {
  const [open, setOpen] = useState(false)
  const writing = editing && onChange !== undefined
  const shown = open || writing

  // Docs just written stay open, to read as they will be read.
  const done = () => {
    setOpen(true)
    onEditing?.(false)
  }
  // The heading closes them while they are written too: what was typed is kept.
  const toggle = () => {
    if (writing) onEditing?.(false)
    setOpen(!shown)
  }

  if (!writing && source.trim() === '') return null

  return (
    <section className={`docs-panel${shown ? ' open' : ''}`}>
      {/* The pencil beside the title it edits; the row past it opens and closes them too,
          from the mouse, the toggle being the way there from the keyboard. */}
      <div
        className="docs-head"
        onClick={(event) => {
          if (event.target === event.currentTarget) toggle()
        }}
      >
        <button type="button" className="docs-toggle" aria-expanded={shown} onClick={toggle}>
          <ChevronIcon open={shown} />
          <span className="docs-title">Docs</span>
        </button>
        {onChange && !writing && (
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
      </div>
      {writing ? (
        <div className="docs-writing">
          <DocsEditor
            value={source}
            onChange={onChange}
            label="Collection docs"
            placeholder="Describe this collection in markdown: what it covers, and anything a reader needs first."
            onDone={done}
          />
          <button type="button" className="docs-done" onClick={done}>
            Done
          </button>
        </div>
      ) : (
        open && (
          <div className="docs-body">
            <Markdown source={source} />
          </div>
        )
      )}
    </section>
  )
}
