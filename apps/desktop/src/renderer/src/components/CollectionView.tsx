import { useCallback, useState } from 'react'
import {
  isUseStep,
  readRequestLine,
  stepLabel,
  type Collection,
  type FlagConditions,
  type FlagValue,
  type CollectionRunSummary,
  type Headers,
  type LoadProblem,
  type RunResult,
  type Settings,
  type VariablePreviews,
  type Vars
} from '@schwabyio/gravity-core/model'
import type { LibraryFileView, RequestSetView } from '@shared/ipc.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { filterSteps, stepTagsIn } from '../tagFilter.js'
import { conditionsState, showFlagValue, stepFlagState, type FlagState } from '../flagState.js'
import type { IterationCounts } from '../dataGrid.js'
import FlagConditionsEditor from './FlagConditionsEditor.js'
import CollectionSettings, { type SettingsSection } from './CollectionSettings.js'
import DocsPanel from './DocsPanel.js'
import GearIcon from './GearIcon.js'
import Resizer from './Resizer.js'
import StepList from './StepList.js'
import TagEditor from './TagEditor.js'
import Tooltip from './Tooltip.js'

interface Props {
  name: string
  relativePath: string
  /** What is wrong with the file: an id that is not its name, or one another file shares. */
  problems: LoadProblem[]
  /** Write the id the file must have. */
  onFixId: (id: string) => void
  /** Its data file (SPEC.md §2.8): gta runs it once per row; the app runs it with row 1. */
  dataFile: { relativePath: string; rows: number } | null
  /** The data file's rows by name, for the row picker; null without a usable one. */
  dataRows: string[] | null
  /** The row a single step runs with and variables preview against. */
  dataRow: number
  onDataRow: (row: number) => void
  onOpenData: () => void
  /** Create a data file with a first column; null where a collection cannot have one. */
  onCreateData: ((column: string) => Promise<void>) | null
  /** Each row's results from the last run over the data file; null before one. */
  iterations: IterationCounts[] | null
  collection: Collection
  selectedIndex: number
  results: Record<number, RunResult>
  runningIndex: number | null
  runningAll: boolean
  summary: CollectionRunSummary | null
  draftIndexes: Set<number>
  onSelect: (index: number) => void
  onRunStep: (index: number) => void
  onRunAll: () => void
  onCancel: () => void
  onAddStep: () => void
  /** Request sets a use step can run. */
  sets: RequestSetView[]
  onAddUse: () => void
  childResults: Record<number, Array<RunResult | undefined>>
  selectedChild: number
  onSelectChild: (index: number, child: number) => void
  onRenameStep: (index: number, name: string) => void
  onDuplicateStep: (index: number) => void
  onDeleteStep: (index: number) => void
  onMoveStep: (index: number, to: number) => void
  /** The selected step's own tags, as the editor holds them. */
  stepTags: string[]
  onStepTags: (tags: string[]) => void
  onCollectionTags: (tags: string[]) => void
  onStepTagsEnabled: (enabled: boolean) => void
  onCollectionExcluded: (excluded: boolean) => void
  /** The feature flag values runs use now (SPEC.md §2.9); null when none are known. */
  flagValues: Record<string, FlagValue> | null
  onCollectionFlags: (flags: FlagConditions | undefined) => void
  /** The selected step's own flag conditions, as the editor holds them. */
  stepFlags: FlagConditions
  onStepFlags: (flags: FlagConditions | undefined) => void
  onCollectionSettings: (settings: Settings) => void
  onCollectionHeaders: (headers: Headers | undefined) => void
  onCollectionVars: (vars: Vars | undefined) => void
  onCollectionParams: (params: Collection['params']) => void
  bases: LibraryFileView[] | null
  /** What this file is, when it is not a collection: its steps mean something else. */
  library: 'endpoints' | 'bases' | null
  onExtends: (base: string | undefined) => void
  onOpenBase: (path: string) => void
  onCollectionPreRequest: (script: string) => void
  onCollectionTests: (tests: string) => void
  /** Where the selected step's last run stopped in a collection script. */
  collectionErrorLines: { preRequest?: number | undefined; tests?: number | undefined }
  /** The collection settings drawer: closed, or open at a section. */
  settingsOpen: SettingsSection | null
  onSettingsOpen: (section: SettingsSection | null) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  /** Tags used across the workspace, offered while typing. */
  tagSuggestions: string[]
  /** Tags the step list is filtered to; empty shows every step. */
  tagFilter: string[]
  onTagFilter: (tags: string[]) => void
  children: React.ReactNode
}

/**
 * A collection and the step being edited, side by side.
 *
 * Nothing collapses and nothing navigates away: the list of steps stays put with
 * its results while the selected step's editor and response fill the rest.
 */
export default function CollectionView(props: Props) {
  const { summary } = props
  const steps = usePaneWidth('pane.steps', 260, 180, 560)
  const stepCount = props.collection.steps.length
  const collectionTags = props.collection.tags ?? []
  const stepTagsOn = props.collection.stepTags === true
  const { onSettingsOpen } = props
  const closeSettings = useCallback(() => onSettingsOpen(null), [onSettingsOpen])

  // Collection tags select every step, so only step tags narrow the list.
  const allTags = stepTagsIn(props.collection)
  const { active: filter, indexes } = filterSteps(props.collection, props.tagFilter)
  const visible = new Set(indexes)
  const selectedStep = props.collection.steps[props.selectedIndex]
  const selectedMethod = selectedStep
    ? isUseStep(selectedStep)
      ? 'USE'
      : readRequestLine(selectedStep).method
    : ''

  // The id a file must have is its name; `id:` in the editor may still say otherwise.
  const fileId = props.relativePath
    .split('/')
    .pop()!
    .replace(/\.yml$/, '')
  const idWrong = props.collection.id !== fileId

  // What each step's feature flags mean with the current values: skipped, or a flag nobody declared.
  const flagStates: Record<number, FlagState> = Object.fromEntries(
    props.collection.steps.map((_, index) => [
      index,
      stepFlagState(props.collection, index, props.flagValues)
    ])
  )
  const collectionFlags = Object.entries(props.collection.flags ?? {})

  return (
    <div className="collection-view">
      {props.problems.length > 0 && (
        <div className="banner id-banner" role="alert">
          <span className="id-problems">
            {props.problems.map((problem) => (
              <span key={problem.message}>{problem.message}</span>
            ))}
          </span>
          {idWrong && (
            <button type="button" onClick={() => props.onFixId(fileId)}>
              Set id to {fileId}
            </button>
          )}
        </div>
      )}
      <header className="collection-header">
        <div className="collection-title">
          <div className="collection-name-row">
            <h1 title={props.relativePath}>{props.name}</h1>
            <TagEditor
              owner="collection"
              tags={collectionTags}
              suggestions={props.tagSuggestions}
              onChange={props.onCollectionTags}
            />
            {props.collection.exclude === true && (
              <Tooltip text="Left out of gta all and directory runs; named on its own, it still runs">
                <button
                  type="button"
                  className="excluded-badge"
                  onClick={() => props.onSettingsOpen('general')}
                >
                  Excluded
                </button>
              </Tooltip>
            )}
            {collectionFlags.length > 0 && (
              <span className="flag-chips" role="group" aria-label="collection feature flags">
                {collectionFlags.map(([name, value]) => {
                  const state = conditionsState({ [name]: value }, props.flagValues)
                  return (
                    <Tooltip
                      key={name}
                      text={
                        state === null
                          ? `Runs: feature flag ${name} is ${showFlagValue(value)}`
                          : state.kind === 'skip'
                            ? `Every step is skipped: ${state.reason}`
                            : state.message
                      }
                    >
                      <button
                        type="button"
                        className={`flag-chip ${state === null ? 'holds' : state.kind}`}
                        onClick={() => props.onSettingsOpen('general')}
                      >
                        {name}: {showFlagValue(value)}
                      </button>
                    </Tooltip>
                  )
                })}
              </span>
            )}
            {props.dataFile && (
              <Tooltip
                text={`Run all runs this collection once per row of ${props.dataFile.relativePath.split('/').pop()}, as gta does. Open it to view and edit the rows.`}
              >
                <button
                  type="button"
                  className="data-badge"
                  aria-label={`data file, ${props.dataFile.rows} rows`}
                  aria-haspopup="dialog"
                  onClick={props.onOpenData}
                >
                  {props.dataFile.relativePath.split('/').pop()} · {props.dataFile.rows}{' '}
                  {props.dataFile.rows === 1 ? 'row' : 'rows'}
                </button>
              </Tooltip>
            )}
            {props.dataFile && props.dataRows && props.dataRows.length > 0 && (
              <Tooltip text="The row a single step runs with, and variables show the values of">
                <label className="data-row-picker">
                  Row
                  <select
                    aria-label="Data row"
                    value={props.dataRow}
                    onChange={(e) => props.onDataRow(Number(e.target.value))}
                  >
                    {props.dataRows.map((name, row) => (
                      <option key={row} value={row}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </Tooltip>
            )}
            {!props.dataFile && props.onCreateData && (
              <CreateDataFile onCreate={props.onCreateData} />
            )}
            <Tooltip text="Collection settings: group runs, step tags, headers, request settings, variables and scripts">
              <button
                type="button"
                className="collection-settings-button"
                onClick={() => props.onSettingsOpen('general')}
                aria-label="Collection settings"
                aria-haspopup="dialog"
              >
                <GearIcon size={16} />
              </button>
            </Tooltip>
          </div>
          {selectedStep && (
            <p className="collection-step">
              <span className="collection-step-seq">
                Step {props.selectedIndex + 1} of {stepCount}
              </span>
              <span className={`method m-${selectedMethod.toLowerCase()}`}>{selectedMethod}</span>
              <span className="collection-step-name">{stepLabel(selectedStep)}</span>
              {stepTagsOn && (
                <TagEditor
                  owner="step"
                  tags={props.stepTags}
                  suggestions={props.tagSuggestions}
                  onChange={props.onStepTags}
                />
              )}
            </p>
          )}
          {selectedStep && (
            <details className="step-flags" open={Object.keys(props.stepFlags).length > 0}>
              <summary>
                Step feature flags
                {Object.keys(props.stepFlags).length > 0 && (
                  <span className="count">{Object.keys(props.stepFlags).length}</span>
                )}
                {flagStates[props.selectedIndex] && (
                  <span className={`flag-state ${flagStates[props.selectedIndex]!.kind}`}>
                    {flagStates[props.selectedIndex]!.kind === 'skip'
                      ? `skipped: ${(flagStates[props.selectedIndex] as { reason: string }).reason}`
                      : 'unknown flag'}
                  </span>
                )}
              </summary>
              <FlagConditionsEditor
                owner="step"
                conditions={props.stepFlags}
                values={props.flagValues}
                onChange={props.onStepFlags}
                addLabel="+ Add a flag this step needs"
              />
            </details>
          )}
        </div>

        {summary && !props.runningAll && (
          <div className="run-summary" role="status">
            <span className="ok">{summary.passed} passed</span>
            {summary.failed > 0 && <span className="client">{summary.failed} failed</span>}
            {summary.errored > 0 && <span className="server">{summary.errored} errored</span>}
            {summary.skipped > 0 && <span className="idle">{summary.skipped} skipped</span>}
          </div>
        )}

        {props.runningAll ? (
          <button type="button" className="cancel" onClick={props.onCancel}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="send run-all"
            onClick={props.onRunAll}
            disabled={visible.size === 0 || props.runningIndex !== null}
          >
            {filter.length > 0
              ? `▶ Run ${visible.size} step${visible.size === 1 ? '' : 's'}`
              : '▶ Run all'}
            {/* Says it runs every row, as gta does; sending one step uses the Row picker's. */}
            {props.dataFile && props.dataFile.rows > 0
              ? ` · ${props.dataFile.rows} ${props.dataFile.rows === 1 ? 'row' : 'rows'}`
              : ''}
          </button>
        )}
      </header>

      {props.settingsOpen && (
        <CollectionSettings
          collection={props.collection}
          section={props.settingsOpen}
          onStepTags={props.onStepTagsEnabled}
          flagValues={props.flagValues}
          onFlags={props.onCollectionFlags}
          // Only a collection runs in a group; library files are run through others.
          onExcluded={
            props.library === null && !props.relativePath.startsWith('requests/')
              ? props.onCollectionExcluded
              : null
          }
          onHeaders={props.onCollectionHeaders}
          onSettings={props.onCollectionSettings}
          onVars={props.onCollectionVars}
          onParams={props.onCollectionParams}
          bases={props.bases}
          onExtends={props.onExtends}
          onOpenBase={props.onOpenBase}
          onPreRequest={props.onCollectionPreRequest}
          onTests={props.onCollectionTests}
          errorLines={props.collectionErrorLines}
          previews={props.previews}
          onCopyVariable={props.onCopyVariable}
          onClose={closeSettings}
        />
      )}

      {props.collection.docs && <DocsPanel source={props.collection.docs} />}

      {stepCount === 0 ? (
        <div className="hint empty">
          {props.library === 'bases' ? (
            <p>
              A base collection has no steps: its headers, settings, variables and scripts — in its
              settings (⚙) — go under every collection that extends it.
            </p>
          ) : (
            <>
              <p>
                {props.library === 'endpoints'
                  ? 'No endpoints yet. Each step here is one: a method and a path like /users/{id}, with the headers and checks every request to it gets.'
                  : 'This collection has no steps yet.'}
              </p>
              <button type="button" className="add-step" onClick={props.onAddStep}>
                {props.library === 'endpoints' ? '+ Add endpoint' : '+ Add step'}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="collection-body" style={{ gridTemplateColumns: `${steps.width}px 1fr` }}>
          {/* Outside the scrolling column: a divider inside it would scroll
              away with the steps and only be as tall as their content. */}
          <Resizer pane={steps} label="Resize the steps pane" offset={steps.width} />
          <aside className="steps-column">
            {allTags.length > 0 && (
              <div className="tag-filter" role="group" aria-label="Filter steps by tag">
                {allTags.map((tag) => {
                  const on = filter.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`tag filter${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        props.onTagFilter(on ? filter.filter((t) => t !== tag) : [...filter, tag])
                      }
                    >
                      {tag}
                    </button>
                  )
                })}
                {filter.length > 0 && (
                  <>
                    <span className="tag-filter-count">
                      {visible.size} of {stepCount}
                    </span>
                    <button
                      type="button"
                      className="tag-filter-clear"
                      onClick={() => props.onTagFilter([])}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
            {props.iterations && props.dataRows && (
              <IterationStrip
                iterations={props.iterations}
                names={props.dataRows}
                selected={props.dataRow}
                onSelect={props.onDataRow}
              />
            )}
            <StepList
              visible={visible}
              collection={props.collection}
              showTags={stepTagsOn}
              selectedIndex={props.selectedIndex}
              results={props.results}
              runningIndex={props.runningIndex}
              draftIndexes={props.draftIndexes}
              onSelect={props.onSelect}
              onRun={props.onRunStep}
              onAdd={props.onAddStep}
              sets={props.sets}
              onAddUse={props.onAddUse}
              childResults={props.childResults}
              selectedChild={props.selectedChild}
              onSelectChild={props.onSelectChild}
              onRename={props.onRenameStep}
              onDuplicate={props.onDuplicateStep}
              onDelete={props.onDeleteStep}
              onMove={props.onMoveStep}
              flagStates={flagStates}
            />
          </aside>
          <section className="step-detail">{props.children}</section>
        </div>
      )}
    </div>
  )
}

/** "+ Data file": a first column's name, then a CSV beside the collection. */
function CreateDataFile({ onCreate }: { onCreate: (column: string) => Promise<void> }) {
  const [column, setColumn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (column === null) {
    return (
      <Tooltip text="Add a CSV data file: Run all then runs the collection once per row">
        <button type="button" className="data-badge create" onClick={() => setColumn('')}>
          + Data file
        </button>
      </Tooltip>
    )
  }
  const create = async () => {
    try {
      await onCreate(column.trim())
      setColumn(null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <form
      className="data-create"
      onSubmit={(e) => {
        e.preventDefault()
        void create()
      }}
    >
      <input
        autoFocus
        value={column}
        placeholder="first column, e.g. userId"
        aria-label="First column name"
        spellCheck={false}
        onChange={(e) => setColumn(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setColumn(null)
        }}
      />
      <button type="submit" disabled={column.trim() === ''}>
        Create data file
      </button>
      <button type="button" onClick={() => setColumn(null)}>
        Cancel
      </button>
      {error && (
        <span className="data-create-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}

/** A run over a data file's rows: one chip per row, and every row's counts together. */
function IterationStrip(props: {
  iterations: IterationCounts[]
  names: string[]
  selected: number
  onSelect: (row: number) => void
}) {
  const total = props.iterations.reduce(
    (sum, c) => ({
      passed: sum.passed + c.passed,
      failed: sum.failed + c.failed + c.errored,
      skipped: sum.skipped + c.skipped
    }),
    { passed: 0, failed: 0, skipped: 0 }
  )
  const failedRows = props.iterations.filter((c) => c.state === 'failed').length
  return (
    <div className="iterations" role="group" aria-label="Iterations">
      <span className="iterations-all" aria-label="All iterations">
        All: {total.passed} passed
        {total.failed > 0 && `, ${total.failed} failed`}
        {total.skipped > 0 && `, ${total.skipped} skipped`}
        {failedRows > 0 && ` · ${failedRows} of ${props.iterations.length} rows failed`}
      </span>
      {props.iterations.map((counts, row) => (
        <Tooltip
          key={row}
          text={`${`Row ${props.names[row] ?? row + 1}`}: ${counts.passed} passed, ${counts.failed} failed, ${counts.errored} errored, ${counts.skipped} skipped`}
        >
          <button
            type="button"
            className={`iteration ${counts.state ?? 'none'}`}
            aria-pressed={row === props.selected}
            aria-label={`Iteration ${row + 1}${counts.state ? `, ${counts.state}` : ''}`}
            onClick={() => props.onSelect(row)}
          >
            <span className="iteration-name">{`Row ${props.names[row] ?? row + 1}`}</span>
            <span className="iteration-counts">
              {counts.passed > 0 && <span className="ok">{counts.passed}✓</span>}
              {counts.failed + counts.errored > 0 && (
                <span className="client">{counts.failed + counts.errored}✗</span>
              )}
              {counts.skipped > 0 && <span className="idle">{counts.skipped}–</span>}
            </span>
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
