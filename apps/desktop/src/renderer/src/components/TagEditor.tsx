import { useEffect, useMemo, useRef, useState } from 'react'
import { TAG_PATTERN } from '@schwabyio/gravity-core/model'

interface Props {
  /** Tags this editor owns. */
  tags: string[]
  /** Tags used elsewhere, offered as you type. */
  suggestions: string[]
  onChange: (tags: string[]) => void
  /** What these tags belong to, for labels: "step", "collection". */
  owner: string
}

/**
 * Tags as chips, with an inline field to add one.
 *
 * Enter or a comma adds, × or Backspace in an empty field removes, Escape
 * abandons. A tag that is not letters, digits and `- _ . :` is refused as you
 * type, not when the file is saved.
 */
export default function TagEditor({ tags, suggestions, onChange, owner }: Props) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [highlight, setHighlight] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) input.current?.focus()
  }, [adding])

  const present = useMemo(() => new Set(tags), [tags])
  const matches = useMemo(() => {
    const query = draft.trim().toLowerCase()
    return suggestions
      .filter((tag) => !present.has(tag) && tag.toLowerCase().includes(query))
      .slice(0, 8)
  }, [suggestions, present, draft])
  const invalid = draft.trim() !== '' && !TAG_PATTERN.test(draft.trim())

  const add = (tag: string) => {
    const value = tag.trim()
    if (value === '' || !TAG_PATTERN.test(value)) return
    if (!present.has(value)) onChange([...tags, value])
    setDraft('')
    setHighlight(0)
  }

  const close = () => {
    setAdding(false)
    setDraft('')
    setHighlight(0)
  }

  return (
    <span className="tag-editor" role="group" aria-label={`${owner} tags`}>
      {tags.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button
            type="button"
            className="tag-remove"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag} from ${owner}`}
          >
            ×
          </button>
        </span>
      ))}

      {adding ? (
        <span className="tag-input-wrap">
          <input
            ref={input}
            className={`tag-input${invalid ? ' invalid' : ''}`}
            value={draft}
            placeholder="tag"
            aria-label={`Add a tag to ${owner}`}
            aria-invalid={invalid}
            onChange={(e) => {
              // A comma ends a tag, the way it does in most tag fields.
              const value = e.target.value
              if (value.endsWith(',')) add(value.slice(0, -1))
              else {
                setDraft(value)
                setHighlight(0)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const typed = draft.trim()
                const exact = matches.find((m) => m === typed)
                add(exact ?? (typed === '' ? (matches[highlight] ?? '') : typed))
              } else if (e.key === 'Escape') {
                close()
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                onChange(tags.slice(0, -1))
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlight((h) => Math.min(h + 1, matches.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlight((h) => Math.max(h - 1, 0))
              }
            }}
            onBlur={() => {
              // Let a click on a suggestion land before the list goes away.
              setTimeout(() => {
                if (draft.trim() !== '' && TAG_PATTERN.test(draft.trim())) add(draft)
                close()
              }, 120)
            }}
          />
          {invalid && (
            <span className="tag-error" role="alert">
              Letters, digits and - _ . : only
            </span>
          )}
          {!invalid && matches.length > 0 && (
            <ul className="tag-suggestions" role="listbox" aria-label="Tag suggestions">
              {matches.map((tag, i) => (
                <li
                  key={tag}
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? 'active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(tag)
                  }}
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </span>
      ) : (
        <button
          type="button"
          className="tag-add"
          onClick={() => setAdding(true)}
          aria-label={`Add a tag to ${owner}`}
        >
          + tag
        </button>
      )}
    </span>
  )
}
