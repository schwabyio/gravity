import { useState } from 'react'

interface Props {
  /** Accessible name of the field, e.g. "New workspace name". */
  label: string
  placeholder: string
  initial?: string
  submitLabel: string
  /** Resolves to a message to show, or null when done. */
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
  children?: React.ReactNode
}

/**
 * A one-line form for naming something — a workspace, a folder, a
 * collection. Enter submits, Escape cancels; a refusal (a name already used,
 * one Windows would not allow) is shown under the field and the name kept.
 */
export default function NameForm(props: Props) {
  const [name, setName] = useState(props.initial ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="name-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() === '' || busy) return
        setBusy(true)
        void props.onSubmit(name.trim()).then((message) => {
          setBusy(false)
          setProblem(message)
        })
      }}
    >
      {props.children}
      <input
        autoFocus
        value={name}
        placeholder={props.placeholder}
        aria-label={props.label}
        aria-invalid={problem !== null}
        onChange={(e) => {
          setName(e.target.value)
          setProblem(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            props.onCancel()
          }
        }}
        spellCheck={false}
      />
      <div className="name-form-actions">
        <button type="submit" disabled={name.trim() === '' || busy}>
          {props.submitLabel}
        </button>
        <button type="button" className="quiet" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {problem && (
        <p className="name-form-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}
