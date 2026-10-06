import { readParam, type VarValue, type VariablePreviews } from '@schwabyio/gravity-core/model'
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
 * the scripts pane beside it.
 */

interface BarProps {
  request: EditorState
  sets: RequestSetView[]
  onChange: (changes: Partial<EditorState>) => void
  onOpenSet: (set: RequestSetView) => void
  running: boolean
  onRun: () => void
  onCancel: () => void
  /** Which of the set's requests the response panes show. */
  shownChild: number
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
      {/* The file itself, shared or not: at the request shown, the one to change. */}
      {set && (
        <OpenInEditor
          className="collection-open-button"
          size={15}
          what={shown ? `${fileName(set)}, at ${shown.label}` : fileName(set)}
          target={{
            path: set.path,
            ...(shown ? { step: { list: 'steps', index: props.shownChild } } : {})
          }}
        />
      )}
      {shown && set && set.steps.length > 1 && (
        <span className="use-shown" title="Pick another in the step list">
          Showing {props.shownChild + 1} of {set.steps.length} · {shown.label}
        </span>
      )}
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
              <p className="hint">
                The values this run of <strong>{set.title}</strong> gets, as{' '}
                <code>{'{{params.name}}'}</code> in its requests and <code>params.name</code> in its
                code. Empty takes the default. A value can use <code>{'{{variables}}'}</code>,
                resolved as the first request starts, after the collection’s{' '}
                <code>before.script</code>.
              </p>
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
