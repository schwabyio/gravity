import { useEffect, useRef, useState } from 'react'
import type { LibraryFileView } from '@shared/ipc.js'
import type {
  Collection,
  FlagConditions,
  FlagValue,
  Headers,
  Settings,
  VariablePreviews,
  Vars
} from '@schwabyio/gravity-core/model'
import { headerRows, toHeaders, type HeaderRow } from '../requestState.js'
import { testsRuleText, useTestsRule } from '../testsRule.js'
import CodeEditor from './CodeEditor.js'
import FlagConditionsEditor from './FlagConditionsEditor.js'
import KeyValueEditor from './KeyValueEditor.js'
import ParamsEditor from './ParamsEditor.js'
import SettingsTab from './SettingsTab.js'

/** How `extends:` names a base: plain, or `global:` when the project has one of the same name. */
function referenceOf(bases: LibraryFileView[], base: LibraryFileView): string {
  if (base.source === 'project') return base.name
  const shadowed = bases.some((other) => other.source === 'project' && other.name === base.name)
  return shadowed ? `global:${base.name}` : base.name
}
import VariablesEditor from './VariablesEditor.js'

type Tab = 'general' | 'params' | 'variables' | 'pre-request' | 'tests'

/** Where the drawer opens: a tab, or the headers on the General tab. */
export type SettingsSection = Tab | 'headers'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'params', label: 'Params' },
  { id: 'variables', label: 'Variables' },
  { id: 'pre-request', label: 'Pre-request' },
  { id: 'tests', label: 'Tests' }
]

interface Props {
  collection: Collection
  section: SettingsSection
  onStepTags: (enabled: boolean) => void
  /** Null when this file is not run in groups: a base, an endpoints file, a request set. */
  onExcluded: ((excluded: boolean) => void) | null
  /** The feature flag values runs use now, to show whether each condition holds. */
  flagValues: Record<string, FlagValue> | null
  onFlags: (flags: FlagConditions | undefined) => void
  /** Base collections to extend; null when this file cannot extend one (a base, endpoints). */
  bases: LibraryFileView[] | null
  onExtends: (base: string | undefined) => void
  onOpenBase: (path: string) => void
  onHeaders: (headers: Headers | undefined) => void
  onSettings: (settings: Settings) => void
  onVars: (vars: Vars | undefined) => void
  onParams: (params: Collection['params']) => void
  onPreRequest: (script: string) => void
  onTests: (tests: string) => void
  /** Where the last run of the selected step stopped in one of these scripts. */
  errorLines: { preRequest?: number | undefined; tests?: number | undefined }
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  onClose: () => void
}

/**
 * The collection's own settings, in a drawer over the right of the window.
 *
 * General: whether it is left out of group runs, whether its steps may carry
 * tags, and the headers and request settings every step inherits. Variables: its `vars`. Pre-request and Tests:
 * the scripts that run around every step, ahead of each step's own. Escape
 * or × closes it; edits save like any other.
 */
export default function CollectionSettings(props: Props) {
  const testsRule = useTestsRule()
  const { collection, onStepTags, onSettings, onClose, section } = props
  const panel = useRef<HTMLElement>(null)
  const headersSection = useRef<HTMLElement>(null)
  const [tab, setTab] = useState<Tab>(section === 'headers' ? 'general' : section)

  useEffect(() => {
    setTab(section === 'headers' ? 'general' : section)
    if (section === 'headers') headersSection.current?.scrollIntoView({ block: 'start' })
  }, [section])

  // Focus the drawer once, on opening — never again on a re-render, or typing
  // would lose its field whenever a save lands.
  useEffect(() => panel.current?.focus(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape in a code editor closes its completions, not the drawer.
      const inEditor = event.target instanceof Element && event.target.closest('.cm-editor')
      if (event.key === 'Escape' && !inEditor) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stepTagsOn = collection.stepTags === true
  const tagged = collection.steps.filter((step) => (step.tags ?? []).length > 0).length

  const toggleStepTags = (enabled: boolean) => {
    if (
      !enabled &&
      tagged > 0 &&
      !window.confirm(`Remove the tags from ${tagged} step${tagged === 1 ? '' : 's'}?`)
    ) {
      return
    }
    onStepTags(enabled)
  }

  const varCount = Object.keys(collection.vars ?? {}).length
  const has = {
    'pre-request': (collection.before?.script ?? '').trim() !== '',
    tests: (collection.tests ?? '').trim() !== ''
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        ref={panel}
        className="drawer"
        role="dialog"
        aria-label="Collection settings"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>Collection settings</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <nav className="tabs drawer-tabs" aria-label="Collection settings sections">
          {TABS.filter(
            // Params belong to a request set; a set has none of its own vars.
            ({ id }) =>
              (id !== 'params' || collection.params !== undefined) &&
              (id !== 'variables' || collection.params === undefined)
          ).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? 'active' : ''}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
              {id === 'variables' && varCount > 0 && <span className="count">{varCount}</span>}
              {(id === 'pre-request' || id === 'tests') && has[id] && (
                <span className="count dot">•</span>
              )}
            </button>
          ))}
        </nav>

        <div
          className={`drawer-body${tab === 'pre-request' || tab === 'tests' ? ' has-code' : ''}`}
        >
          {tab === 'general' && (
            <>
              {props.bases && (
                <section aria-labelledby="collection-extends-title">
                  <h3 id="collection-extends-title">Extends</h3>
                  <p className="hint">
                    A base collection&rsquo;s headers, settings, variables and scripts, under this
                    one&rsquo;s own. Bases live in <code>bases/</code>.
                  </p>
                  <div className="extends-row">
                    <select
                      aria-label="Base collection"
                      value={collection.extends ?? ''}
                      onChange={(e) => props.onExtends(e.target.value || undefined)}
                    >
                      <option value="">None</option>
                      {collection.extends &&
                        !props.bases.some(
                          (base) => referenceOf(props.bases!, base) === collection.extends
                        ) && (
                          <option value={collection.extends}>
                            {collection.extends} (not found)
                          </option>
                        )}
                      {props.bases.map((base) => (
                        <option key={base.path} value={referenceOf(props.bases!, base)}>
                          {base.title}
                          {base.source === 'global' ? ' (shared)' : ''}
                          {base.problem ? ` — ${base.problem}` : ''}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const chosen = props.bases.find(
                        (base) => referenceOf(props.bases!, base) === collection.extends
                      )
                      return (
                        chosen && (
                          <button type="button" onClick={() => props.onOpenBase(chosen.path)}>
                            Open
                          </button>
                        )
                      )
                    })()}
                  </div>
                </section>
              )}
              {props.onExcluded && (
                <section aria-labelledby="collection-runs-title">
                  <h3 id="collection-runs-title">Group runs</h3>
                  <div className="setting-row">
                    <div className="setting-text">
                      <label htmlFor="collection-exclude">Exclude from group runs</label>
                      <p>
                        Leave this collection out of <code>gta all</code> and of a run of its
                        folder. Named on its own it still runs, and so does Run all here.
                      </p>
                    </div>
                    <input
                      id="collection-exclude"
                      type="checkbox"
                      role="switch"
                      className="switch"
                      checked={collection.exclude === true}
                      onChange={(e) => props.onExcluded?.(e.target.checked)}
                    />
                  </div>
                </section>
              )}
              <section aria-labelledby="collection-flags-title">
                <h3 id="collection-flags-title">Feature flags</h3>
                <p className="hint">
                  Flags the whole collection needs: when one does not have its value, every step is
                  skipped and reported so. A flag the environment does not declare is an error.
                </p>
                <FlagConditionsEditor
                  owner="collection"
                  conditions={collection.flags}
                  values={props.flagValues}
                  onChange={props.onFlags}
                />
              </section>
              <section aria-labelledby="collection-steps-title">
                <h3 id="collection-steps-title">Steps</h3>
                <div className="setting-row">
                  <div className="setting-text">
                    <label htmlFor="collection-step-tags">Step tags</label>
                    <p>
                      Let each step carry its own tags, so a tag run can pick out single steps.
                      Leave off for a collection whose steps only work together: its tags select all
                      of it.
                    </p>
                  </div>
                  <input
                    id="collection-step-tags"
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={stepTagsOn}
                    onChange={(e) => toggleStepTags(e.target.checked)}
                  />
                </div>
              </section>

              <section ref={headersSection} aria-labelledby="collection-headers-title">
                <h3 id="collection-headers-title">Headers</h3>
                <p className="hint">
                  Sent with every step. A step header with the same name, in any case, replaces one
                  of these for that step.
                </p>
                <HeadersEditor
                  headers={collection.headers}
                  onChange={props.onHeaders}
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
              </section>

              <section aria-labelledby="collection-requests-title">
                <h3 id="collection-requests-title">Request settings</h3>
                <SettingsTab
                  level="collection"
                  own={collection.settings ?? {}}
                  onChange={onSettings}
                />
              </section>
            </>
          )}

          {tab === 'params' && (
            <section aria-label="Params">
              <p className="hint">
                This collection is a request set: a step elsewhere runs it with <code>use:</code>,
                passing these as <code>with:</code>. Its requests read them as{' '}
                <code>{'{{params.name}}'}</code>, its code as <code>params.name</code>. Run on its
                own, it takes the defaults.
              </p>
              <ParamsEditor params={collection.params} onChange={props.onParams} />
            </section>
          )}

          {tab === 'variables' && (
            <section aria-label="Variables">
              <p className="hint">
                In scope for every step, as <code>{'{{name}}'}</code> or <code>gta.get(name)</code>.
                The environment overrides them. Plain values only: compute anything else in the
                pre-request script with <code>gta.set</code>.
              </p>
              <VariablesEditor
                vars={collection.vars}
                // No Secret type here, so every value is a plain one.
                onChange={(vars) => props.onVars(vars as Vars | undefined)}
                previews={props.previews}
                onCopyVariable={props.onCopyVariable}
              />
            </section>
          )}

          {tab === 'pre-request' && (
            <div className="script-editor">
              <p className="hint">
                Runs before every step, ahead of the step&rsquo;s own pre-request script. A value
                set here with <code>gta.set</code> is fresh for each step.
              </p>
              <CodeEditor
                kind="pre-request"
                value={collection.before?.script ?? ''}
                onChange={props.onPreRequest}
                ariaLabel="Collection pre-request script"
                placeholder={
                  "No pre-request script for the collection yet — for example:\n  gta.set('traceId', gta.uuidv7())"
                }
                errorLine={props.errorLines.preRequest}
              />
            </div>
          )}

          {tab === 'tests' && (
            <div className="script-editor">
              <p className="hint">
                Runs after every step&rsquo;s response, ahead of the step&rsquo;s own tests.{' '}
                <code>gta</code> is built in — type <code>gta.</code> for its functions.
                {testsRule && (
                  <>
                    {' '}
                    This project&rsquo;s rules allow {testsRuleText(testsRule)} here (
                    <code>tests.only</code> in {testsRule.source}).
                  </>
                )}
              </p>
              <CodeEditor
                kind="tests"
                value={collection.tests ?? ''}
                onChange={props.onTests}
                ariaLabel="Collection tests"
                placeholder={
                  "No tests for the collection yet — for example:\n  gta.expectResponseToHaveHeader('Content-Type')"
                }
                errorLine={props.errorLines.tests}
              />
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

/**
 * The collection's headers as editable rows. The rows are held here — with their
 * ids, the blank row to type in, and a name typed twice — and each change is
 * handed up as the map it saves as. A change from outside (a reload) resets them.
 */
function HeadersEditor(props: {
  headers: Headers | undefined
  onChange: (headers: Headers | undefined) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}) {
  const { headers } = props
  const [rows, setRows] = useState<HeaderRow[]>(() => headerRows(headers))
  useEffect(() => {
    setRows((current) =>
      same(toHeaders(current, headers), headers) ? current : headerRows(headers)
    )
  }, [headers])

  return (
    <div className="collection-headers">
      <KeyValueEditor
        rows={rows}
        onChange={(next) => {
          setRows(next)
          props.onChange(toHeaders(next, headers))
        }}
        previews={props.previews}
        onCopyVariable={props.onCopyVariable}
      />
    </div>
  )
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
