import type { ReactNode } from 'react'
import type { EditorState } from '../requestState.js'
import InfoTip from './InfoTip.js'

/**
 * Connections (SPEC.md §2.11): a request's event stream kept open under a
 * name, and steps that read it instead of sending a request.
 */

/** The names the collection's steps open, offered to a step reading one. */
const CONNECTION_LIST = 'connection-names'

/** A name as typed, kept to what a name may hold: letters, digits and `- _ .`. */
const nameOf = (typed: string): string => typed.replace(/[^A-Za-z0-9_.-]/g, '')

interface BarProps {
  request: EditorState
  /** Names the collection's steps open connections as. */
  names: string[]
  onChange: (changes: Partial<EditorState>) => void
  running: boolean
  onSend: () => void
  onCancel: () => void
  /** The step's flags, as a chip beside Send. */
  chips?: ReactNode
}

/** In place of a step's method and URL: the connection it reads. */
export function ReadBar(props: BarProps) {
  const name = props.request.reads ?? ''
  return (
    <form
      className="url-bar read-bar"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSend()
      }}
    >
      <span className="method m-read">READ</span>
      <input
        className="read-connection"
        aria-label="Connection to read"
        list={CONNECTION_LIST}
        value={name}
        placeholder="connection name"
        onChange={(e) => props.onChange({ reads: nameOf(e.target.value) })}
      />
      <datalist id={CONNECTION_LIST}>
        {props.names.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
      {props.chips}
      <button type="submit" className="send" disabled={props.running || name === ''}>
        {props.running ? 'Reading…' : 'Send'}
      </button>
      {props.running && (
        <button type="button" className="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      )}
    </form>
  )
}

/** For a request: keep the event stream it opens, as a connection later steps read. */
export function ConnectionField(props: { value: string; onChange: (connection: string) => void }) {
  return (
    <label className="connection-field">
      <span>Keep its event stream open as connection</span>
      <input
        type="text"
        aria-label="Connection this request opens"
        placeholder="none"
        value={props.value}
        onChange={(e) => props.onChange(nameOf(e.target.value))}
      />
      <InfoTip
        about="connections"
        text={
          <>
            Later steps read it with <code>connection:</code> and no method. It stays open until the
            run ends.
          </>
        }
      />
    </label>
  )
}
