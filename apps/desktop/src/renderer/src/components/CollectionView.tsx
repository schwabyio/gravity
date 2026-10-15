import { useCallback, useEffect, useState } from 'react'
import {
  isReadStep,
  isUseStep,
  stepLabel,
  stepMethod,
  STEP_LISTS,
  type Collection,
  type FlagConditions,
  type FlagValue,
  type CollectionRunSummary,
  type Headers,
  type LoadProblem,
  type RuleFinding,
  type RunResult,
  type Settings,
  type StepList as ListName,
  type VariablePreviews,
  type Vars
} from '@schwabyio/gravity-core/model'
import type { ConnectionView, LibraryFileView, RequestSetView } from '@shared/ipc.js'
import { stepsOf } from '../hooks/useCollectionEditor.js'
import { resolveSet } from '../reuse.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { filterSteps, stepsToRunAll, stepTagsIn } from '../tagFilter.js'
import { conditionsState, showFlagValue, stepFlagState, type FlagState } from '../flagState.js'
import type { IterationCounts } from '../dataGrid.js'
import CollectionSettings, { type SettingsSection } from './CollectionSettings.js'
import DocsPanel from './DocsPanel.js'
import OpenInEditor from './OpenInEditor.js'
import GearIcon from './GearIcon.js'
import Resizer from './Resizer.js'
import StepList, { type AddAction } from './StepList.js'
import StepSectionHead from './StepSectionHead.js'
import TagEditor from './TagEditor.js'
import Tooltip from './Tooltip.js'
import type { CollectionChanges } from '../stepChanges.js'
import { fileFindings, findingText, stepFindings } from '../ruleFindings.js'

interface Props {
  /** Back to the step this file was opened from — a use step's Open — while there is one. */
  back: { label: string; onBack: () => void } | null
  name: string
  relativePath: string
  /** The collection's file, for "Open in …". */
  path: string
  /** What is wrong with the file: an id that is not its name, or one another file shares. */
  problems: LoadProblem[]
  /**
   * Where the file breaks its project's rules (SPEC.md §1.4): the file's own
   * findings shown above it, each step's on its row. Nothing stops it running.
   */
  findings: RuleFinding[]
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
  /** Stop was pressed during Run all, and teardown is cleaning up after it. */
  stoppingAll?: boolean
  summary: CollectionRunSummary | null
  draftIndexes: Record<ListName, Set<number>>
  /** What changed since the last commit: its steps, and the rest of it; null with nothing to compare. */
  changes: CollectionChanges | null
  onSelect: (list: ListName, index: number) => void
  onRunAll: () => void
  /** Stop showing it: its edits are kept, and with auto save on it is saved. */
  onClose: () => void
  onCancel: () => void
  /** Add a step to a list: after the step at `after`, or at its end. */
  onAddStep: (list: ListName, after?: number) => void
  /** Request sets a use step can run. */
  sets: RequestSetView[]
  onAddUse: (list: ListName, after?: number) => void
  /** Add a step reading a connection the collection's steps open (SPEC.md §2.11). */
  onAddRead: (list: ListName, after?: number) => void
  /** Add a step that waits before the next one (SPEC.md §2.1). */
  onAddWait: (list: ListName, after?: number) => void
  /** The connections this collection's Sends hold open, and a way to close them. */
  connections: ConnectionView[]
  onCloseConnection: (name: string) => void
  childResults: Record<ListName, Record<number, Array<RunResult | undefined>>>
  /** Each list's `forEach` steps' results, one per item. */
  itemResults: Record<ListName, Record<number, RunResult[]>>
  /** The request of the selected use step picked under it; null for the step itself. */
  selectedChild: number | null
  onSelectChild: (list: ListName, index: number, child: number) => void
  onRenameStep: (list: ListName, index: number, name: string) => void
  onDuplicateStep: (list: ListName, index: number) => void
  onDeleteStep: (list: ListName, index: number) => void
  onDeleteSteps: (list: ListName, indexes: number[]) => void
  onMoveStep: (list: ListName, index: number, to: number) => void
  /** Leave a step out of group runs, or put it back (SPEC.md §2.4). */
  onExcludeStep: (list: ListName, index: number, excluded: boolean) => void
  /** The selected step's own tags, as the editor holds them. */
  stepTags: string[]
  onStepTags: (tags: string[]) => void
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
  // Held as the path written, so another collection reads from its first render: reset
  // in an effect, it rendered once with the editor open on the new collection's docs.
  const [editingDocsOf, setEditingDocsOf] = useState<string | null>(null)
  useEffect(() => setEditingDocsOf(null), [props.relativePath])
  const editingDocs = editingDocsOf === props.relativePath
  const setEditingDocs = (editing: boolean) => setEditingDocsOf(editing ? props.relativePath : null)
  const { summary } = props
  // Wide enough for a name beside its status, time and verdict.
  const steps = usePaneWidth('pane.steps', 320, 180, 560)
  const setupSteps = stepsOf(props.collection, 'setup')
  const teardownSteps = stepsOf(props.collection, 'teardown')
  const hasStages = setupSteps.length > 0 || teardownSteps.length > 0
  const stepsTitle = props.library === 'endpoints' ? 'Endpoints' : 'Steps'
  const anySteps = STEP_LISTS.some((list) => stepsOf(props.collection, list).length > 0)
  // Only a collection has setup and teardown: not a request set, a base or endpoints.
  const canHaveStages = props.library === null && !props.collection.params
  // Only a collection runs in a group; library files are run through others.
  const runsInGroups = props.library === null && !props.relativePath.startsWith('requests/')
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
  const selectedMethod = selectedStep ? stepMethod(selectedStep) : ''
  // The connections the collection's steps open, for steps to read.
  const opened = connectionNames(props.collection)

  const fileName = props.relativePath.split('/').pop()!
  // The id a file must have is its name; `id:` in the editor may still say otherwise.
  const fileId = fileName.replace(/\.yml$/, '')
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

  /** Why reusable requests cannot be added yet, when they cannot. */
  const noSets =
    props.sets.length === 0
      ? 'No reusable requests yet: make a file of them from the project’s ⋯ menu'
      : null
  /**
   * What can be added to a list: at its end, from its heading's +, or below the
   * step at `after`, from that step's ⋯. Reading a connection, once a step opens
   * one; a wait, except among an endpoints file's endpoints.
   */
  const addsTo = (list: ListName, after?: number): AddAction[] => {
    const below = after === undefined ? '' : ' below'
    return [
      {
        icon: 'new',
        label: `Add ${props.library === 'endpoints' ? 'endpoint' : 'step'}${below}`,
        onClick: () => props.onAddStep(list, after)
      },
      {
        icon: 'use',
        label: `Use reusable requests${below}`,
        onClick: () => props.onAddUse(list, after),
        ...(noSets ? { disabled: true, note: noSets } : {})
      },
      ...(opened.length > 0
        ? [
            {
              icon: 'read' as const,
              label: `Read a connection${below}`,
              onClick: () => props.onAddRead(list, after)
            }
          ]
        : []),
      ...(props.library !== 'endpoints'
        ? [
            {
              icon: 'wait' as const,
              label: `Add wait${below}`,
              onClick: () => props.onAddWait(list, after)
            }
          ]
        : [])
    ]
  }
  /** The steps' + also starts setup and teardown, until each has a step. */
  const stagesToAdd: AddAction[] = canHaveStages
    ? [
        ...(setupSteps.length === 0
          ? [
              {
                icon: 'new' as const,
                label: 'Add setup step',
                onClick: () => props.onAddStep('setup')
              }
            ]
          : []),
        ...(teardownSteps.length === 0
          ? [
              {
                icon: 'new' as const,
                label: 'Add teardown step',
                onClick: () => props.onAddStep('teardown')
              }
            ]
          : [])
      ]
    : []

  const listOf = (list: ListName) => {
    const listSteps = stepsOf(props.collection, list)
    return (
      <StepList
        list={list}
        path={props.path}
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
        addsBelow={(index) => addsTo(list, index)}
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
        // Setup and teardown run whenever the collection does; a request set wherever it is used.
        canExclude={runsInGroups && canHaveStages && list === 'steps'}
        onExclude={(index, excluded) => props.onExcludeStep(list, index, excluded)}
        flagStates={flagStatesOf(list)}
        findings={stepFindings(props.findings, list)}
      />
    )
  }
  // Run all runs the steps the tag filter shows, less those excluded from group runs;
  // setup and teardown come along, unless every step is left out.
  const toRun = stepsToRunAll(props.collection, props.tagFilter)
  const nothingToRun =
    toRun.indexes.length === 0 && (filter.length > 0 || toRun.excluded > 0 || !hasStages)
  const runAllButton = (
    <button
      type="button"
      className="send run-all"
      onClick={props.onRunAll}
      disabled={nothingToRun || props.busy}
    >
      {filter.length > 0
        ? `▶ Run ${toRun.indexes.length} step${toRun.indexes.length === 1 ? '' : 's'}`
        : '▶ Run all'}
      {/* Says it runs every row, as gta does; sending one step uses the Row picker's. */}
      {props.dataFile && props.dataFile.rows > 0
        ? ` · ${props.dataFile.rows} ${props.dataFile.rows === 1 ? 'row' : 'rows'}`
        : ''}
    </button>
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
      {fileFindings(props.findings).length > 0 && (
        <div className="banner rule-banner" role="note" aria-label="Rule findings">
          <span className="rule-mark" aria-hidden="true">
            △
          </span>
          <span className="rule-banner-text">
            {fileFindings(props.findings).map((finding, index) => (
              <span key={index}>{findingText(finding)}</span>
            ))}
          </span>
        </div>
      )}
      <header className="collection-header">
        <div className="collection-title">
          {props.back && (
            <button
              type="button"
              className="came-from"
              onClick={props.back.onBack}
              aria-label={`Back to ${props.back.label}`}
            >
              ← {props.back.label}
            </button>
          )}
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
            {/* The file itself; the selected step's own opens beside its name, below. */}
            <OpenInEditor
              className="collection-open-button"
              size={15}
              what={fileName}
              target={{ path: props.path }}
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
            <div className="collection-step">
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
              {/* One of a use step's requests picked: it is what is shown. */}
              {isUseStep(selectedStep) && props.selectedChild !== null && (
                <span className="collection-step-child">
                  › {resolveSet(props.sets, selectedStep.use)?.steps[props.selectedChild]?.label}
                </span>
              )}
              <OpenInEditor
                what={`${fileName}, at ${stepLabel(selectedStep)}`}
                target={{
                  path: props.path,
                  step: { list: props.selectedList, index: props.selectedIndex }
                }}
              />
              {stepTagsOn && props.selectedList === 'steps' && (
                <TagEditor
                  owner="step"
                  tags={props.stepTags}
                  suggestions={props.tagSuggestions}
                  onChange={props.onStepTags}
                />
              )}
            </div>
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
          // Stopped, the run still cleans up after itself; a second Stop stops that too.
          <Tooltip
            text={
              props.stoppingAll
                ? 'Teardown is cleaning up after the stopped run: stop it too'
                : teardownSteps.length > 0
                  ? 'Stop the run: teardown still cleans up after it'
                  : 'Stop the run'
            }
          >
            <button type="button" className="cancel" onClick={props.onCancel}>
              {props.stoppingAll ? 'Stop teardown' : 'Stop'}
            </button>
          </Tooltip>
        ) : toRun.excluded > 0 ? (
          <Tooltip
            text={
              toRun.indexes.length === 0
                ? `Every step${filter.length > 0 ? ' shown' : ''} is excluded from group runs; Send still sends one`
                : `Leaves out ${toRun.excluded} excluded step${toRun.excluded === 1 ? '' : 's'}, as gta all does; Send still sends one`
            }
          >
            {runAllButton}
          </Tooltip>
        ) : (
          runAllButton
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
          onExcluded={runsInGroups ? props.onCollectionExcluded : null}
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
          // Every collection opens with its docs closed.
          key={props.relativePath}
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
                <StepSectionHead
                  title="Setup"
                  groups={[addsTo('setup')]}
                  info={`Runs once before the steps${props.dataFile ? ', not once per row' : ''}, and stops at its first failing step. What it sets lasts the whole run.`}
                />
                {listOf('setup')}
              </section>
            )}
            {/* Named always, setup and teardown or not; an endpoints file's steps are its endpoints. */}
            <section className="step-section steps" aria-label={stepsTitle}>
              <StepSectionHead title={stepsTitle} groups={[addsTo('steps'), stagesToAdd]} />
              {listOf('steps')}
            </section>
            {teardownSteps.length > 0 && (
              <section className="step-section teardown" aria-label="Teardown">
                <StepSectionHead
                  title="Teardown"
                  groups={[addsTo('teardown')]}
                  info="Runs once after the steps, even when one of them failed or the run was stopped."
                />
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
