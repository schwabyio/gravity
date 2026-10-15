import {
  isReadStep,
  isWaitStep,
  readParam,
  readRequestLine,
  waitText,
  type VarValue,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import type { ReactNode } from 'react'
import type { RequestSetView } from '@shared/ipc.js'
import type { EditorState } from '../requestState.js'
import { referenceFor, resolveSet } from '../reuse.js'
import OpenInEditor from './OpenInEditor.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

/**
 * A use step (SPEC.md §2.5): in place of a request, the request set it runs
 * and the values it passes. The bar picks the set and runs it; the pane holds
 * the values. The step's own tests, run after the set's last request, are in
 * the scripts pane beside it. One of the set's requests, picked under the
 * step, is shown as its file has it, with a bar of its own.
 */

interface BarProps {
  request: EditorState
  sets: RequestSetView[]
  onChange: (changes: Partial<EditorState>) => void
  onOpenSet: (set: RequestSetView) => void
  running: boolean
  onRun: () => void
  onCancel: () => void
  /** Which of the set's requests the response panes show: the one its tests check. */
  shownChild: number
  /** The step's flags, as a chip beside Run. */
  chips?: ReactNode
}

export function UseBar(props: BarProps) {
  const reference = props.request.use ?? ''
  const set = resolveSet(props.sets, reference)
  const shown = set?.steps[props.shownChild]
  return (
    <form
      className="url-bar use-bar"
      onSubmit={(event) => {
        event.preventDefault()
        props.onRun()
      }}
    >
      <span className="method m-use">USE</span>
      <select
        className="use-set"
        aria-label="Reusable requests"
        value={set ? referenceFor(props.sets, set) : reference}
        onChange={(e) => props.onChange({ use: e.target.value })}
      >
        {!set && <option value={reference}>{reference} (not found)</option>}
        {props.sets.map((option) => (
          <option key={option.path} value={referenceFor(props.sets, option)}>
            {option.title} — {option.name}
            {option.source === 'global' ? ' (shared)' : ''}
          </option>
        ))}
      </select>
      {set && (
        <Tooltip text="Open the reusable requests file to edit its requests and params">
          <button type="button" onClick={() => props.onOpenSet(set)}>
            Open
          </button>
        </Tooltip>
      )}
      {/* The file itself, shared or not; a request picked under the step opens at it. */}
      {set && (
        <OpenInEditor
          className="collection-open-button"
          size={15}
          what={fileName(set)}
          target={{ path: set.path }}
        />
      )}
      {shown && set && set.steps.length > 1 && (
        <span
          className="use-shown"
          title="The response its tests check; pick a request under the step to see it"
        >
          Showing {props.shownChild + 1} of {set.steps.length} · {shown.label}
        </span>
      )}
      {props.chips}
      <button type="submit" className="send" disabled={props.running || !set}>
        {props.running ? 'Running…' : 'Run'}
      </button>
      {props.running && (
        <button type="button" className="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      )}
    </form>
  )
}

const fileName = (set: RequestSetView): string => set.path.split(/[\\/]/).pop() ?? set.path

interface ChildBarProps {
  set: RequestSetView
  /** Which of its requests: its place in the file's `steps`. */
  child: number
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  /** Open the file, at this request. */
  onOpenSet: (set: RequestSetView, child?: number) => void
  running: boolean
  onRun: () => void
  onCancel: () => void
}

/**
 * One request of a use step's reusable requests file, picked under the step:
 * its method and URL as the file has them, not edited here, and Open to change
 * it there. Run runs the use step, every request of it, as from the step.
 */
export function UseChildBar(props: ChildBarProps) {
  const { set, child } = props
  const entry = set.steps[child]
  if (!entry) return null
  const { step } = entry
  const line = isWaitStep(step)
    ? {
        method: 'WAIT',
        text: `waits ${typeof step.wait === 'number' ? waitText(step.wait) : step.wait}`
      }
    : isReadStep(step)
      ? { method: 'READ', text: `reads the connection ${step.connection}` }
      : null
  const request = line ? null : readRequestLine(step)
  const method = line?.method ?? request!.method
  return (
    <form
      className="url-bar use-child-bar"
      onSubmit={(event) => {
        event.preventDefault()
        props.onRun()
      }}
    >
      <span className={`method m-${method.toLowerCase()}`}>{method}</span>
      {request ? (
        <VariableInput
          className="url"
          value={request.url}
          onChange={() => {}}
          previews={props.previews}
          onCopy={props.onCopyVariable}
          ariaLabel="Request URL, as its file has it"
          readOnly
        />
      ) : (
        <span className="use-child-line">{line!.text}</span>
      )}
      <Tooltip text={`Open ${fileName(set)} at this request, to change it there`}>
        <button type="button" onClick={() => props.onOpenSet(set, child)}>
          Open
        </button>
      </Tooltip>
      <OpenInEditor
        className="collection-open-button"
        size={15}
        what={`${fileName(set)}, at ${entry.label}`}
        target={{ path: set.path, step: { list: 'steps', index: child } }}
      />
      <span className="use-shown" title="A request of the reusable requests file this step uses">
        {child + 1} of {set.steps.length} in {set.title}
      </span>
      <button type="submit" className="send" disabled={props.running}>
        {props.running ? 'Running…' : 'Run'}
      </button>
      {props.running && (
        <button type="button" className="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      )}
    </form>
  )
}

interface EditorProps {
  request: EditorState
  sets: RequestSetView[]
  onChange: (changes: Partial<EditorState>) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}

export function UseStepEditor(props: EditorProps) {
  const set = resolveSet(props.sets, props.request.use ?? '')
  const given = props.request.with
  const params = Object.entries(set?.params ?? {})
  const unknown = Object.keys(given).filter((key) => !(key in (set?.params ?? {})))

  const give = (key: string, value: VarValue | undefined) => {
    const next = { ...given }
    if (value === undefined) delete next[key]
    else next[key] = value
    props.onChange({ with: next })
  }

  return (
    <>
      <div className="tabs">
        <button className="active">
          With{' '}
          {Object.keys(given).length > 0 && (
            <span className="count">{Object.keys(given).length}</span>
          )}
        </button>
      </div>

      <div className="tab-body">
        <div className="use-with">
          {!set ? (
            <p className="setting-error" role="alert">
              There are no reusable requests called {props.request.use}.
            </p>
          ) : (
            <>
              {set.problem && (
                <p className="setting-error" role="alert">
                  {set.problem}
                </p>
              )}
              {params.length === 0 && <p className="hint">These requests take no params.</p>}
              {params.map(([key, spec]) => (
                <ParamField
                  key={key}
                  name={key}
                  spec={readParam(spec)}
                  value={given[key]}
                  onChange={(value) => give(key, value)}
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
              ))}
              {unknown.map((key) => (
                <p key={key} className="setting-error use-unknown" role="alert">
                  <code>{key}</code> is not a param of these requests, so a run stops here.
                  <button type="button" onClick={() => give(key, undefined)}>
                    Remove it
                  </button>
                </p>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * One param: text by default, true/false for a boolean one. A number typed for
 * a param whose default is a number is saved as a number, so the set's code
 * can compare it as one.
 */
function ParamField(props: {
  name: string
  spec: ReturnType<typeof readParam>
  value: VarValue | undefined
  onChange: (value: VarValue | undefined) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}) {
  const { name, spec, value } = props
  const fallback =
    spec.default === undefined
      ? spec.required
        ? 'required'
        : 'no default'
      : `default: ${String(spec.default)}`

  return (
    <div className="param-field">
      <label className="param-name">
        {name}
        {spec.required && (
          <span className="param-required" title="These requests need a value for this">
            *
          </span>
        )}
      </label>
      {typeof spec.default === 'boolean' ? (
        <select
          aria-label={`Value of param ${name}`}
          value={value === undefined ? '' : String(value)}
          onChange={(e) =>
            props.onChange(e.target.value === '' ? undefined : e.target.value === 'true')
          }
        >
          <option value="">Default ({String(spec.default)})</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <VariableInput
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(text) => {
            if (text === '') return props.onChange(undefined)
            const asNumber = Number(text)
            props.onChange(
              typeof spec.default === 'number' && text.trim() !== '' && Number.isFinite(asNumber)
                ? asNumber
                : text
            )
          }}
          previews={props.previews}
          onCopy={props.onCopyVariable}
          placeholder={fallback}
          ariaLabel={`Value of param ${name}`}
        />
      )}
      {spec.description && <p className="param-description">{spec.description}</p>}
    </div>
  )
}
