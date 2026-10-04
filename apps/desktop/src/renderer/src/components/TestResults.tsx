import { useEffect, useRef, useState } from 'react'
import type { IgnoredPath, LogEntry, RunError, ScriptSource } from '@schwabyio/gravity-core/model'
import type { EditorTarget } from '@shared/ipc.js'
import { useExternalEditor } from '../externalEditor.js'
import type { Check } from '../testLinks.js'

interface Props {
  checks: Check[]
  selected: number | null
  onSelect: (index: number | null) => void
  onHover: (index: number | null) => void
  /** Point the Body tab at one path, from strict validation's leftovers. */
  onJump: (path: string) => void
  /** What the step's scripts wrote with `console`. */
  logs: LogEntry[]
  /** The error that stopped a `tests` script, if one did. */
  scriptError: RunError | null
  /** Body paths the tests ignored for strict validation: listed, never counted as checks. */
  ignored: IgnoredPath[]
  /** Whether strict validation was on, without which an ignore changes nothing. */
  strict: boolean
  /** Where a check came from, said as tags: nothing for the step's own. */
  tagsOf: (source: ScriptSource | undefined) => string[]
  /** Where a stopped script is written, to open at its line in the external editor. */
  errorTarget?: EditorTarget | null
}

const GROUPS: Array<{ target: Check['assertion']['target'] | 'other'; label: string }> = [
  { target: 'status', label: 'Status' },
  { target: 'header', label: 'Headers' },
  { target: 'body', label: 'Body' },
  { target: 'strict', label: 'Strict validation' },
  { target: 'custom', label: 'Tests' },
  { target: 'other', label: 'Other' }
]

/**
 * The step's assertions, under its Tests script in the scripts pane.
 *
 * Deliberately only the list: the lines and headers each assertion is about are
 * marked in the response tabs themselves, so whichever of Body or Headers is
 * open sits directly beside the results for it.
 */
export default function TestResults(props: Props) {
  const editor = useExternalEditor()
  const { checks, selected } = props
  const [failuresOnly, setFailuresOnly] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const failed = checks.filter((c) => c.assertion.status === 'fail').length
  const { logs, scriptError } = props
  const visible = checks.filter((c) => !failuresOnly || c.assertion.status === 'fail')

  // A selection made from the response side scrolls its assertion into view.
  useEffect(() => {
    if (selected === null) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-check="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <section className="test-results" aria-label="Test Results">
      <div className="test-results-head">
        <span className="test-results-title">Test Results</span>
        <span className={`test-results-summary ${failed === 0 && !scriptError ? 'ok' : 'client'}`}>
          {scriptError
            ? 'Tests stopped'
            : checks.length === 0
              ? 'No checks'
              : failed === 0
                ? `All ${checks.length} passed`
                : `${failed} of ${checks.length} failed`}
        </span>
      </div>
      <label className="test-filter">
        <input
          type="checkbox"
          checked={failuresOnly}
          onChange={(e) => setFailuresOnly(e.target.checked)}
          disabled={failed === 0}
        />
        Failures only
      </label>

      <div className="test-results-list" ref={listRef}>
        {scriptError && (
          <div className="script-error" role="alert">
            <strong>
              {scriptError.script === 'collection' ? "The collection's tests" : 'Tests'} stopped
              {scriptError.line !== undefined && ` at line ${scriptError.line}`}
            </strong>
            <code>{scriptError.message}</code>
            {(scriptError.script === 'step' || scriptError.script === 'use') &&
              scriptError.line !== undefined && <p>The line is marked in the script above.</p>}
            {checks.length > 0 && <p>Checks made before it are listed below.</p>}
            {editor && props.errorTarget && (
              <button type="button" onClick={() => editor.open(props.errorTarget!)}>
                {editor.label} at line {scriptError.line}
              </button>
            )}
          </div>
        )}
        {GROUPS.map(({ target, label }) => {
          const group = visible.filter((c) => (c.assertion.target ?? 'other') === target)
          if (group.length === 0) return null
          return (
            <div key={label} className="check-group">
              <h3>{label}</h3>
              <ul>
                {group.map((check) => (
                  <CheckRow
                    key={check.index}
                    check={check}
                    tags={props.tagsOf(check.assertion.source)}
                    selected={selected === check.index}
                    onSelect={() => props.onSelect(selected === check.index ? null : check.index)}
                    onHover={(on) => props.onHover(on ? check.index : null)}
                    onJump={props.onJump}
                  />
                ))}
              </ul>
            </div>
          )
        })}
        {props.ignored.length > 0 && !failuresOnly && (
          <div className="check-group ignored-group">
            <h3>Ignored</h3>
            <p className="ignored-note">
              {props.strict
                ? 'Counted as checked by strict validation, without a check.'
                : 'Strict validation is off, so ignoring changes nothing.'}
            </p>
            <ul>
              {props.ignored.map((entry, index) => (
                <li key={index} className="check ignored">
                  <button
                    type="button"
                    className="check-head"
                    onClick={() => props.onJump(entry.path)}
                    title="Show it in the response body"
                  >
                    <span className="check-icon" aria-label="Ignored">
                      –
                    </span>
                    <span className="check-name">{entry.path}</span>
                    <SourceTags tags={props.tagsOf(entry.source)} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {logs.length > 0 && !failuresOnly && (
          <div className="check-group console">
            <h3>Console</h3>
            <ol className="console-lines">
              {logs.map((entry, i) => (
                <li key={i} className={`log-${entry.level}`}>
                  {entry.phase === 'pre-request' && <span className="log-phase">before</span>}
                  <span className="log-message">{entry.message}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  )
}

/** Where a check or an ignore came from, when not the step's own script. */
function SourceTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null
  return (
    <span className="check-sources">
      {tags.map((tag) => (
        <span key={tag} className="check-source">
          {tag}
        </span>
      ))}
    </span>
  )
}

function CheckRow(props: {
  check: Check
  tags: string[]
  selected: boolean
  onSelect: () => void
  onHover: (on: boolean) => void
  onJump: (path: string) => void
}) {
  const { assertion, index } = props.check
  const pass = assertion.status === 'pass'
  const showDetail = !pass || props.selected

  return (
    <li
      data-check={index}
      className={`check ${pass ? 'pass' : 'fail'}${props.selected ? ' selected' : ''}`}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
    >
      <button
        type="button"
        className="check-head"
        onClick={props.onSelect}
        aria-expanded={props.selected}
      >
        <span className="check-icon" aria-label={pass ? 'Passed' : 'Failed'}>
          {pass ? '✓' : '✗'}
        </span>
        <span className="check-name">{assertion.name}</span>
        <SourceTags tags={props.tags} />
      </button>
      {showDetail && (
        <div className="check-detail">
          {assertion.message && <p className="check-message">{assertion.message}</p>}
          {assertion.target !== 'strict' &&
            (assertion.expected || assertion.actual !== undefined) && (
              <dl className="check-compare">
                <dt>Expected</dt>
                <dd>{assertion.expected ?? '—'}</dd>
                <dt>Actual</dt>
                <dd className={assertion.actual === undefined ? 'missing' : ''}>
                  {assertion.actual ?? 'not present'}
                </dd>
              </dl>
            )}
          {assertion.unasserted && assertion.unasserted.length > 0 && (
            <ul className="unasserted">
              {assertion.unasserted.map((path) => (
                <li key={path}>
                  <button type="button" onClick={() => props.onJump(path)}>
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
