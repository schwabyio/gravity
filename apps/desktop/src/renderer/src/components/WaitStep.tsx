import { useState, type ReactNode } from 'react'
import {
  waitProblem,
  waitText,
  type RunResult,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import { useElapsed } from '../hooks/useElapsed.js'
import { waitValue, type EditorState } from '../requestState.js'
import { formatMs } from '../format.js'
import { waitLeft } from '../stepOutcome.js'
import DocsEditor from './DocsEditor.js'
import InfoTip from './InfoTip.js'
import Markdown from './Markdown.js'
import PencilIcon from './PencilIcon.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

/**
 * A wait step (SPEC.md §2.1): in place of a request, how long it waits before
 * the next step. Nothing is sent and there are no scripts, so there is no
 * response or scripts pane: how long, its last wait, and its docs.
 */

interface Props {
  request: EditorState
  onChange: (changes: Partial<EditorState>) => void
  /** The step's flags, as a chip beside Send. */
  chips?: ReactNode
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  result: RunResult | null
  error: string | null
  running: boolean
  onSend: () => void
  onCancel: () => void
  conflict: boolean
  onReloadFromDisk: () => void
  onKeepMine: () => void
}

export default function WaitView(props: Props) {
  const typed = props.request.wait ?? ''
  const value = waitValue(typed)
  const problem = typed.trim() === '' ? null : waitProblem(value)
  // How long, as far as it is known before a run: a variable's value as it stands now.
  const ms = typeof value === 'number' ? value : previewed(value, props.previews)

  return (
    <div className="request-view wait-view">
      {props.conflict && (
        <div className="banner" role="alert">
          <strong>Changed on disk.</strong> This step was modified outside the app while you had
          unsaved edits.
          <button type="button" onClick={props.onReloadFromDisk}>
            Reload
          </button>
          <button type="button" onClick={props.onKeepMine}>
            Keep mine
          </button>
        </div>
      )}

      <form
        className="url-bar wait-bar"
        onSubmit={(event) => {
          event.preventDefault()
          props.onSend()
        }}
      >
        <span className="method m-wait">WAIT</span>
        <VariableInput
          className="wait-ms"
          value={typed}
          onChange={(wait) => props.onChange({ wait })}
          previews={props.previews}
          onCopy={props.onCopyVariable}
          placeholder="milliseconds, or a {{variable}} holding them"
          ariaLabel="Milliseconds to wait"
        />
        <span className="wait-reading" aria-label="How long">
          {problem === null && ms !== null ? waitText(ms) : ''}
        </span>
        {props.chips}
        <button
          type="submit"
          className="send"
          disabled={props.running || typed.trim() === '' || problem !== null}
        >
          {props.running ? 'Waiting…' : 'Send'}
        </button>
        {props.running && (
          <button type="button" className="cancel" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </form>

      <div className="wait-body">
        {problem && (
          <p className="wait-problem" role="alert">
            {problem}
          </p>
        )}
        <section className="wait-status" aria-label="Wait" aria-live="polite">
          {props.running ? (
            <WaitClock ms={ms} />
          ) : props.error ? (
            <p className="wait-failed">{props.error}</p>
          ) : props.result?.status === 'pass' ? (
            <p className="wait-done">Waited {formatMs(props.result.durationMs)}</p>
          ) : props.result?.error ? (
            <p className="wait-failed">{props.result.error.message}</p>
          ) : props.result?.skipped ? (
            <p className="wait-skipped">Skipped: {props.result.skipped.reason}</p>
          ) : (
            <p className="hint">
              Waits{ms !== null && problem === null ? ` ${waitText(ms)}` : ''} before the next step.
              Nothing is sent.
            </p>
          )}
          <InfoTip
            about="waiting"
            text={
              <>
                A wait step pauses the run for this many milliseconds, up to 10 minutes, then goes
                on to the next step: for something to land first, such as a search index catching
                up. A <code>{'{{variable}}'}</code> is resolved when the step runs. Stop cuts it
                short. To wait until something is ready, a request that checks for it is quicker.
              </>
            }
          />
        </section>
        <WaitDocs request={props.request} onChange={props.onChange} />
      </div>
    </div>
  )
}

/** A variable's value as it stands now, when the wait is one variable holding milliseconds. */
function previewed(value: string, previews: VariablePreviews): number | null {
  const name = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(value)?.[1]
  const text = name ? previews[name]?.value : null
  return text && /^\d+$/.test(text) ? Number(text) : null
}

/** While it waits: how long it has left, and a bar filling as it goes; or, unknown, how long so far. */
export function WaitClock({ ms }: { ms: number | null }) {
  const elapsed = useElapsed()
  if (ms === null) return <p className="wait-running">Waiting · {formatMs(elapsed)}</p>
  return (
    <div className="wait-running">
      <p>Waiting · {waitLeft(ms, elapsed)}</p>
      <div className="wait-progress" aria-hidden="true">
        <span style={{ width: `${ms === 0 ? 100 : Math.min(100, (elapsed / ms) * 100)}%` }} />
      </div>
    </div>
  )
}

/** The step's docs: read, with a pencil to write them in place. */
function WaitDocs(props: {
  request: EditorState
  onChange: (changes: Partial<EditorState>) => void
}) {
  const [editing, setEditing] = useState(false)
  const docs = props.request.docs.trim() ? props.request.docs : null
  return (
    <section className="wait-docs docs-tab" aria-label="Step docs">
      <h3>Docs</h3>
      {editing ? (
        <>
          <DocsEditor
            value={props.request.docs}
            onChange={(next) => props.onChange({ docs: next })}
            label="Step docs"
            placeholder="Describe this step in markdown: what it waits for, and why."
            onDone={() => setEditing(false)}
          />
          <button type="button" className="docs-done" onClick={() => setEditing(false)}>
            Done
          </button>
        </>
      ) : (
        <div className="step-docs">
          <Tooltip text="Edit the step’s docs">
            <button
              type="button"
              className="docs-edit"
              onClick={() => setEditing(true)}
              aria-label="Edit the step’s docs"
            >
              <PencilIcon />
            </button>
          </Tooltip>
          {docs ? (
            <Markdown source={docs} />
          ) : (
            <p className="hint docs-empty">This step has no docs yet.</p>
          )}
        </div>
      )}
    </section>
  )
}
