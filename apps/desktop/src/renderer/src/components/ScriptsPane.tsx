import { useMemo } from 'react'
import type { LogEntry, RunError, RunResult } from '@schwabyio/gravity-core/model'
import { checkLines } from '../checkLines.js'
import type { PaneWidth } from '../hooks/usePaneWidth.js'
import type { InheritedLayer } from '../inheritance.js'
import type { EditorState } from '../requestState.js'
import { preRequestChip, testsChip, type ScriptChip } from '../scriptChips.js'
import type { Check } from '../testLinks.js'
import CodeEditor from './CodeEditor.js'
import InheritedScripts from './InheritedScripts.js'
import Resizer from './Resizer.js'
import TestResults from './TestResults.js'
import Tooltip from './Tooltip.js'

export type ScriptTab = 'pre-request' | 'tests'

interface Props {
  /** A use step has tests of its own, run after its set, and no pre-request script. */
  use: boolean
  request: EditorState
  onChange: (changes: Partial<EditorState>) => void
  tab: ScriptTab
  onTab: (tab: ScriptTab) => void

  /** The layers around the step whose scripts run with its own, and a way to each. */
  layers: InheritedLayer[]
  onOpenLayer: (kind: ScriptTab) => (layer: InheritedLayer) => void

  result: RunResult | null
  checks: Check[]
  logs: LogEntry[]
  /** The error that stopped a `tests` script, if one did. */
  scriptError: RunError | null
  /** Where the step's own scripts stopped, to mark in their editors. */
  errorLines: { 'pre-request': number | undefined; tests: number | undefined }
  selected: number | null
  onSelect: (index: number | null) => void
  onHover: (index: number | null) => void
  onJump: (path: string) => void

  pane: PaneWidth
  onHide: () => void
}

/**
 * The step's scripts, always beside the request and its response: Pre-request
 * and Tests, in the order they run, Tests open unless another is picked. A run
 * puts its results under the Tests script, which stays where it was, so a
 * failed check and the code that made it are read together. Each tab says what its script holds, or how it
 * went: `3 checks`, `✓ 3`, `✕ 1 of 3`; and each line of the Tests script a
 * check was made on is marked ✓ or ✕, a failure's message under it.
 */
export default function ScriptsPane(props: Props) {
  const { request, result, checks, logs, scriptError } = props
  const tab: ScriptTab = props.use ? 'tests' : props.tab
  // Checks a layer around the step makes, so its own empty script is not "none".
  const inheritedTests = props.layers.some((layer) => layer.used && (layer.tests ?? '').trim())
  const ignored = result?.ignored ?? []
  const showResults =
    result?.response != null &&
    (checks.length > 0 || logs.length > 0 || scriptError !== null || ignored.length > 0)
  // A ✓ or ✕ beside each line of the script a check was made on: a new array only for a
  // new result, so the marks follow their lines while the script is edited.
  const marks = useMemo(
    () => checkLines(result?.assertions ?? [], props.use ? 'use' : 'step', result?.ignored),
    [result, props.use]
  )

  return (
    <section className="scripts-pane" aria-label="Scripts">
      <Resizer pane={props.pane} label="Resize the scripts pane" edge="left" />
      <div className="tabs">
        {!props.use && (
          <button
            className={tab === 'pre-request' ? 'active' : ''}
            onClick={() => props.onTab('pre-request')}
          >
            Pre-request <Chip chip={preRequestChip(request.preRequest, result)} />
          </button>
        )}
        <button className={tab === 'tests' ? 'active' : ''} onClick={() => props.onTab('tests')}>
          Tests <Chip chip={testsChip(request.tests, result, inheritedTests)} />
        </button>
        <Tooltip text="Hide the scripts to give the response more room">
          <button
            type="button"
            className="pane-toggle"
            onClick={props.onHide}
            aria-label="Hide the scripts"
          >
            Hide ▸
          </button>
        </Tooltip>
      </div>

      {tab === 'tests' ? (
        <div className="scripts-body">
          <div className="script-editor">
            {props.use ? (
              <p className="hint">
                Runs after the set&rsquo;s last request, on its response — with <code>params</code>{' '}
                as this step passed them. Check files are there as <code>checks.&lt;file&gt;</code>.
              </p>
            ) : (
              <>
                <p className="hint">
                  Runs after the response. xtest is built in as <code>gta</code> — type{' '}
                  <code>gta.</code> for its functions — alongside any JavaScript, <code>res</code>{' '}
                  and <code>assert</code>.
                </p>
                <InheritedScripts
                  kind="tests"
                  layers={props.layers}
                  onOpen={props.onOpenLayer('tests')}
                />
              </>
            )}
            <CodeEditor
              kind="tests"
              value={request.tests}
              onChange={(tests) => props.onChange({ tests })}
              ariaLabel={props.use ? 'Tests after the set' : 'Tests'}
              placeholder={
                props.use
                  ? 'No tests of this step’s own — for example:\n  gta.expectResponseStatusCodeToBe(201)'
                  : "No tests for this step yet — for example:\n  gta.expectResponseStatusCodeToBe(200)\n  gta.expectResponseBodyToHaveProperty('id', 7)"
              }
              errorLine={props.errorLines.tests}
              checks={marks}
            />
          </div>
          {showResults && (
            <TestResults
              checks={checks}
              selected={props.selected}
              onSelect={props.onSelect}
              onHover={props.onHover}
              onJump={props.onJump}
              logs={logs}
              scriptError={scriptError}
              ignored={ignored}
              strict={checks.some((check) => check.assertion.target === 'strict')}
            />
          )}
        </div>
      ) : (
        <div className="scripts-body">
          <div className="script-editor">
            <p className="hint">
              Runs before the request is built. Set the variables the request uses with{' '}
              <code>gta.set(name, value)</code> — for example <code>gta.uuidv7()</code> or{' '}
              <code>gta.date(…)</code>.
            </p>
            <InheritedScripts
              kind="pre-request"
              layers={props.layers}
              onOpen={props.onOpenLayer('pre-request')}
            />
            <CodeEditor
              kind="pre-request"
              value={request.preRequest}
              onChange={(preRequest) => props.onChange({ preRequest })}
              ariaLabel="Pre-request script"
              placeholder={
                "No pre-request script for this step yet — for example:\n  gta.set('today', gta.date('%Y-%m-%d'))"
              }
              errorLine={props.errorLines['pre-request']}
            />
          </div>
        </div>
      )}
    </section>
  )
}

function Chip({ chip }: { chip: ScriptChip | null }) {
  if (!chip) return null
  return (
    <span className={`script-chip ${chip.tone}`} title={chip.title} aria-label={chip.title}>
      {chip.text}
    </span>
  )
}

/**
 * The scripts pane hidden: a strip along the right that says how the tests
 * went, and brings the pane back.
 */
export function ScriptsStrip(props: {
  checks: Check[]
  scriptError: RunError | null
  onShow: () => void
}) {
  const failed = props.checks.filter((c) => c.assertion.status === 'fail').length
  const total = props.checks.length
  return (
    <button
      type="button"
      className={`pane-strip scripts-strip${failed > 0 || props.scriptError ? ' failed' : ''}`}
      onClick={props.onShow}
      aria-label="Show the scripts"
    >
      <span>
        {props.scriptError
          ? '◂ Tests · stopped'
          : failed > 0
            ? `◂ Tests · ${failed} failed`
            : total > 0
              ? `◂ Tests · ${total}/${total}`
              : '◂ Tests'}
      </span>
    </button>
  )
}
