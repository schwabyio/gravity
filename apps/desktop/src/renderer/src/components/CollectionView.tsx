import { useCallback, useEffect, useState } from 'react'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  stepLabel,
  STEP_LISTS,
  type Collection,
  type FlagConditions,
  type FlagValue,
  type CollectionRunSummary,
  type Headers,
  type LoadProblem,
  type RunResult,
  type Settings,
  type StepList as ListName,
  type VariablePreviews,
  type Vars
} from '@schwabyio/gravity-core/model'
import type { ConnectionView, LibraryFileView, RequestSetView } from '@shared/ipc.js'
import { stepsOf } from '../hooks/useCollectionEditor.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { filterSteps, stepTagsIn } from '../tagFilter.js'
import { conditionsState, showFlagValue, stepFlagState, type FlagState } from '../flagState.js'
import type { IterationCounts } from '../dataGrid.js'
import FlagConditionsEditor from './FlagConditionsEditor.js'
import CollectionSettings, { type SettingsSection } from './CollectionSettings.js'
import DocsPanel from './DocsPanel.js'
import OpenInEditor from './OpenInEditor.js'
import GearIcon from './GearIcon.js'
import Resizer from './Resizer.js'
import StepList, { type AddAction } from './StepList.js'
import TagEditor from './TagEditor.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'
import type { CollectionChanges } from '../stepChanges.js'

interface Props {
  name: string
  relativePath: string
  /** The collection's file, for "Open in …". */
  path: string
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
  /** The selected step's list — `steps`, or `setup` or `teardown` — and its place there. */
  selectedList: ListName
  selectedIndex: number
  /** Each list's last result per step index. */
  results: Record<ListName, Record<number, RunResult>>
  /** The step executing now, during a run. */
  runningAt: { list: ListName; index: number } | null
  /** A run is in flight: nothing else may start. */
  busy: boolean
  runningAll: boolean
  summary: CollectionRunSummary | null
  draftIndexes: Record<ListName, Set<number>>
  /** What changed since the last commit: its steps, and the rest of it; null with nothing to compare. */
  changes: CollectionChanges | null
  onSelect: (list: ListName, index: number) => void
  onRunAll: () => void
  /** Stop showing it: its edits are kept, and with auto save on it is saved. */
  onClose: () => void
  onCancel: () => void
  onAddStep: (list: ListName) => void
  /** Request sets a use step can run. */
  sets: RequestSetView[]
  onAddUse: (list: ListName) => void
  /** Add a step reading a connection the collection's steps open (SPEC.md §2.11). */
  onAddRead: (list: ListName) => void
  /** The connections this collection's Sends hold open, and a way to close them. */
  connections: ConnectionView[]
  onCloseConnection: (name: string) => void
  childResults: Record<ListName, Record<number, Array<RunResult | undefined>>>
  /** Each list's `forEach` steps' results, one per item. */
  itemResults: Record<ListName, Record<number, RunResult[]>>
  selectedChild: number
  onSelectChild: (list: ListName, index: number, child: number) => void
  onRenameStep: (list: ListName, index: number, name: string) => void
  onDuplicateStep: (list: ListName, index: number) => void
  onDeleteStep: (list: ListName, index: number) => void
  onDeleteSteps: (list: ListName, indexes: number[]) => void
  onMoveStep: (list: ListName, index: number, to: number) => void
  /** The selected step's own tags, as the editor holds them. */
  stepTags: string[]
  onStepTags: (tags: string[]) => void
  /** The selected step's `forEach`, as the editor holds it (SPEC.md §2.1). */
  stepForEach: string
  onStepForEach: (forEach: string) => void
  /** In a request set: whether the use step's tests check the selected step (SPEC.md §2.5). */
  stepUseTests: boolean
  onStepUseTests: (useTests: boolean) => void
  onCollectionTags: (tags: string[]) => void
  /** Where the collection's docs are edited; without it they are only read. */
  onCollectionDocs?: (docs: string) => void
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
/**
 * Up and down the steps from the keyboard: with a step focused, the arrows
 * select the one above or below — across setup, steps and teardown, as they
 * are listed — and Home and End the first and last. A step's row is a button,
 * so a click leaves it focused and the arrows work straight away; typing in a
 * rename, or anywhere else, is left alone.
 */
function moveBetweenSteps(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement
  if (!target.classList.contains('step-open')) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.step-open')]
  const at = rows.indexOf(target as HTMLButtonElement)
  const to =
    event.key === 'ArrowDown'
      ? at + 1
      : event.key === 'ArrowUp'
        ? at - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : null
  if (to === null) return
  event.preventDefault()
  const row = rows[to]
  if (!row || row === target) return
  row.focus()
  row.click()
}

export default function CollectionView(props: Props) {
  const collectionDocs = (props.collection.docs ?? '').trim() !== ''
  // Writing the collection's docs in place; another collection opens to read its own.
  const [editingDocs, setEditingDocs] = useState(false)
  useEffect(() => setEditingDocs(false), [props.relativePath])
  const { summary } = props
  // Wide enough for a name beside its status, time and verdict.
  const steps = usePaneWidth('pane.steps', 320, 180, 560)
  const setupSteps = stepsOf(props.collection, 'setup')
  const teardownSteps = stepsOf(props.collection, 'teardown')
  const hasStages = setupSteps.length > 0 || teardownSteps.length > 0
  const anySteps = STEP_LISTS.some((list) => stepsOf(props.collection, list).length > 0)
  // Only a collection has setup and teardown: not a request set, a base or endpoints.
  const canHaveStages = props.library === null && !props.collection.params
  const collectionTags = props.collection.tags ?? []
  const stepTagsOn = props.collection.stepTags === true
  const { onSettingsOpen } = props
  const closeSettings = useCallback(() => onSettingsOpen(null), [onSettingsOpen])

  // Collection tags select every step, so only step tags narrow the list.
  const allTags = stepTagsIn(props.collection)
  const { active: filter, indexes } = filterSteps(props.collection, props.tagFilter)
  const visible = new Set(indexes)
  const selectedSteps = stepsOf(props.collection, props.selectedList)
  const stepCount = selectedSteps.length
  const selectedStep = selectedSteps[props.selectedIndex]
  const selectedMethod = selectedStep
    ? isUseStep(selectedStep)
      ? 'USE'
      : isReadStep(selectedStep)
        ? 'READ'
        : readRequestLine(selectedStep).method
    : ''
  // The connections the collection's steps open, for steps to read.
  const opened = connectionNames(props.collection)

  // The id a file must have is its name; `id:` in the editor may still say otherwise.
  const fileId = props.relativePath
    .split('/')
    .pop()!
    .replace(/\.yml$/, '')
  const idWrong = props.collection.id !== fileId

  // What each step's feature flags mean with the current values: skipped, or a flag nobody declared.
  const flagStatesOf = (list: ListName): Record<number, FlagState> => {
    const listSteps = stepsOf(props.collection, list)
    return Object.fromEntries(
      listSteps.map((_, index) => [
        index,
        stepFlagState({ flags: props.collection.flags, steps: listSteps }, index, props.flagValues)
      ])
    )
  }
  const flagStates = flagStatesOf(props.selectedList)

  const useSetTooltip = (where: string) =>
    props.sets.length > 0
      ? `Run a request set here${where}, with values of your own`
      : 'No request sets yet: make one from the project’s ⋯ menu'
  /** Once a step opens a connection: a step reading it. */
  const readFor = (list: ListName): AddAction[] =>
    opened.length > 0
      ? [
          {
            label: '+ Read a connection',
            onClick: () => props.onAddRead(list),
            tooltip: 'A step that sends nothing: it checks the events a connection holds'
          }
        ]
      : []
  /** The buttons under each list that add to it. */
  const addsFor = (list: ListName): AddAction[] => {
    if (list !== 'steps') {
      return [
        { label: `+ Add ${list} step`, onClick: () => props.onAddStep(list) },
        {
          label: `+ Use a request set in ${list}`,
          onClick: () => props.onAddUse(list),
          disabled: props.sets.length === 0,
          tooltip: useSetTooltip(` in ${list}`)
        },
        ...readFor(list)
      ]
    }
    return [
      { label: '+ Add step', onClick: () => props.onAddStep('steps') },
      {
        label: '+ Use a request set',
        onClick: () => props.onAddUse('steps'),
        disabled: props.sets.length === 0,
        tooltip: useSetTooltip('')
      },
      ...readFor('steps'),
      // A list with steps has its own add buttons, above or below.
      ...(canHaveStages && setupSteps.length === 0
        ? [
            {
              label: '+ Add setup step',
              onClick: () => props.onAddStep('setup'),
              tooltip:
                'Setup runs once before the steps, and before every row of a data file; what it sets lasts the whole run'
            }
          ]
        : []),
      ...(canHaveStages && teardownSteps.length === 0
        ? [
            {
              label: '+ Add teardown step',
              onClick: () => props.onAddStep('teardown'),
              tooltip: 'Teardown runs once after the steps, even when one of them failed'
            }
          ]
        : [])
    ]
  }

  const listOf = (list: ListName) => {
    const listSteps = stepsOf(props.collection, list)
    return (
      <StepList
        list={list}
        steps={listSteps}
        visible={list === 'steps' ? visible : new Set(listSteps.map((_, index) => index))}
        showTags={stepTagsOn && list === 'steps'}
        selectedIndex={props.selectedList === list ? props.selectedIndex : -1}
        results={props.results[list]}
        runningIndex={props.runningAt?.list === list ? props.runningAt.index : null}
        draftIndexes={props.draftIndexes[list]}
        changes={props.changes?.steps[list]}
        removed={props.changes?.removed[list] ?? 0}
        onSelect={(index) => props.onSelect(list, index)}
        adds={addsFor(list)}
        sets={props.sets}
        childResults={props.childResults[list]}
        itemResults={props.itemResults[list]}
        selectedChild={props.selectedChild}
        onSelectChild={(index, child) => props.onSelectChild(list, index, child)}
        onRename={(index, name) => props.onRenameStep(list, index, name)}
        onDuplicate={(index) => props.onDuplicateStep(list, index)}
        onDelete={(index) => props.onDeleteStep(list, index)}
        onDeleteMany={(indexes) => props.onDeleteSteps(list, indexes)}
        onMove={(index, to) => props.onMoveStep(list, index, to)}
        flagStates={flagStatesOf(list)}
      />
    )
  }
  // Run all with a tag filter runs the steps it shows; setup and teardown come along.
  const nothingToRun = visible.size === 0 && (filter.length > 0 || !hasStages)
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
              <Tooltip text="Left out of gta all and folder runs; named on its own, it still runs">
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
            {!collectionDocs && !editingDocs && props.onCollectionDocs && (
              <Tooltip text="Describe this collection in markdown, shown above its steps">
                <button type="button" className="add-docs" onClick={() => setEditingDocs(true)}>
                  + Docs
                </button>
              </Tooltip>
            )}
            <OpenInEditor
              className="collection-open-button"
              size={15}
              what={`${props.relativePath.split('/').pop()}${selectedStep ? `, at ${stepLabel(selectedStep)}` : ''}`}
              target={{
                path: props.path,
                ...(selectedStep
                  ? { step: { list: props.selectedList, index: props.selectedIndex } }
                  : {})
              }}
            />
            <Tooltip
              text={`Collection settings: group runs, step tags, headers, request settings, variables and scripts${props.changes?.collection ? ' — changed since the last commit' : ''}`}
            >
              <button
                type="button"
                className="collection-settings-button"
                onClick={() => props.onSettingsOpen('general')}
                aria-label="Collection settings"
                aria-haspopup="dialog"
              >
                <GearIcon size={16} />
                {props.changes?.collection && (
                  <span className="git-mark modified dot settings-changed" aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </div>
          {selectedStep && (
            <p className="collection-step">
              <span className="collection-step-seq">
                {props.selectedList === 'setup'
                  ? 'Setup step'
                  : props.selectedList === 'teardown'
                    ? 'Teardown step'
                    : 'Step'}{' '}
                {props.selectedIndex + 1} of {stepCount}
              </span>
              <span className={`method m-${selectedMethod.toLowerCase()}`}>{selectedMethod}</span>
              <span className="collection-step-name">{stepLabel(selectedStep)}</span>
              {stepTagsOn && props.selectedList === 'steps' && (
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
          {selectedStep &&
            !isUseStep(selectedStep) &&
            !isReadStep(selectedStep) &&
            selectedStep.connection === undefined &&
            props.library === null && (
              <ForEachEditor
                key={`${props.selectedList}:${props.selectedIndex}`}
                value={props.stepForEach}
                onChange={props.onStepForEach}
                previews={props.previews}
                onCopyVariable={props.onCopyVariable}
              />
            )}
          {selectedStep && props.collection.params && props.selectedList === 'steps' && (
            <UseTestsToggle
              on={props.stepUseTests}
              onChange={props.onStepUseTests}
              markedElsewhere={props.collection.steps.findIndex(
                (step, index) => step.useTests === true && index !== props.selectedIndex
              )}
            />
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
            disabled={nothingToRun || props.busy}
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
        {/* In the header's top right corner, above Run all. */}
        <div className="collection-close-corner">
          <Tooltip
            text={props.busy ? 'Close this collection, stopping its run' : 'Close this collection'}
          >
            <button
              type="button"
              className="collection-close"
              onClick={props.onClose}
              aria-label="Close the collection"
            >
              ×
            </button>
          </Tooltip>
        </div>
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

      {(collectionDocs || editingDocs) && (
        <DocsPanel
          source={props.collection.docs ?? ''}
          {...(props.onCollectionDocs ? { onChange: props.onCollectionDocs } : {})}
          editing={editingDocs}
          onEditing={setEditingDocs}
        />
      )}

      {!anySteps ? (
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
              <button type="button" className="add-step" onClick={() => props.onAddStep('steps')}>
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
          <aside className="steps-column" onKeyDown={moveBetweenSteps}>
            {props.connections.length > 0 && (
              <div className="connections-bar" role="status" aria-label="Open connections">
                {props.connections.map((connection) => (
                  <span key={connection.name} className="connection">
                    <strong>{connection.name}</strong>
                    <span className="connection-state">
                      {connection.open ? 'open' : 'closed by the server'} · {connection.held} held
                    </span>
                    <button
                      type="button"
                      onClick={() => props.onCloseConnection(connection.name)}
                      aria-label={`Close connection ${connection.name}`}
                    >
                      Close
                    </button>
                  </span>
                ))}
              </div>
            )}
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
                      {visible.size} of {props.collection.steps.length}
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
            {setupSteps.length > 0 && (
              <section className="step-section setup" aria-label="Setup">
                <h2 className="step-section-title">Setup</h2>
                <p className="step-section-note">
                  Runs once before the steps{props.dataFile ? ', not once per row' : ''}. What it
                  sets lasts the whole run.
                </p>
                {listOf('setup')}
              </section>
            )}
            {hasStages ? (
              <section className="step-section steps" aria-label="Steps">
                <h2 className="step-section-title">Steps</h2>
                {listOf('steps')}
              </section>
            ) : (
              listOf('steps')
            )}
            {teardownSteps.length > 0 && (
              <section className="step-section teardown" aria-label="Teardown">
                <h2 className="step-section-title">Teardown</h2>
                <p className="step-section-note">
                  Runs once after the steps, even when one of them failed.
                </p>
                {listOf('teardown')}
              </section>
            )}
          </aside>
          <section className="step-detail">{props.children}</section>
        </div>
      )}
    </div>
  )
}

/**
 * In a request set, which step's response a use step's own tests check
 * (SPEC.md §2.5): this one, when ticked, else the set's last. One step at a
 * time, so it cannot be ticked while another step has it.
 */
function UseTestsToggle(props: {
  on: boolean
  onChange: (on: boolean) => void
  /** Another step that has it, by index; -1 for none. */
  markedElsewhere: number
}) {
  const taken = props.markedElsewhere >= 0 && !props.on
  return (
    <label className="step-use-tests">
      <input
        type="checkbox"
        checked={props.on}
        disabled={taken}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      A use step’s tests check this response
      <span className="hint">
        {taken
          ? ` — step ${props.markedElsewhere + 1} has this; untick it there first`
          : props.on
            ? ''
            : ' — otherwise they check the last step’s'}
      </span>
    </label>
  )
}

/**
 * A step's `forEach` (SPEC.md §2.1): the list it sends its request once per
 * item of. Open while it has one, and while it is being edited.
 */
function ForEachEditor(props: {
  value: string
  onChange: (value: string) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(props.value.trim() !== '')
  return (
    <details
      className="step-foreach"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {props.value.trim() !== '' ? (
          <>
            for each <code>{props.value}</code>
          </>
        ) : (
          '+ Repeat for each item of a list'
        )}
      </summary>
      <div className="foreach-field">
        <VariableInput
          value={props.value}
          onChange={props.onChange}
          previews={props.previews}
          onCopy={props.onCopyVariable}
          placeholder="{{items}}, a variable holding a JSON array, or one written here"
          ariaLabel="Repeat for each item of"
        />
        <p className="hint">
          The request is sent once per item, read as <code>{'{{item}}'}</code> and as{' '}
          <code>item</code> in code. Empty: once.
        </p>
      </div>
    </details>
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

/** The names a collection's steps open connections as, in the order they first appear. */
export function connectionNames(collection: Collection): string[] {
  const names = STEP_LISTS.flatMap((list) =>
    stepsOf(collection, list).flatMap((step) =>
      step.connection !== undefined && !isReadStep(step) ? [step.connection] : []
    )
  )
  return [...new Set(names)]
}
