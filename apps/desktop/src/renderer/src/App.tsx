import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isUseStep,
  readParam,
  rowLabel,
  stepLabel,
  type VariablePreview,
  type CollectionRunSummary,
  type CollectionSummary,
  type RunResult,
  type Settings,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import type { EndpointView, ProjectView, RequestSetView } from '@shared/ipc.js'
import type { SettingsSection } from './components/CollectionSettings.js'
import CollectionView from './components/CollectionView.js'
import EnvironmentPicker from './components/EnvironmentPicker.js'
import EnvironmentsDrawer from './components/EnvironmentsDrawer.js'
import FlagsDrawer from './components/FlagsDrawer.js'
import DataDrawer from './components/DataDrawer.js'
import { useDataFileEditor } from './hooks/useDataFileEditor.js'
import {
  dataRowInput,
  iterationCounts,
  iterationName,
  rowName,
  type IterationCounts
} from './dataGrid.js'
import { useFlags } from './hooks/useFlags.js'
import GearIcon from './components/GearIcon.js'
import Resizer from './components/Resizer.js'
import RequestView from './components/RequestView.js'
import SaveStatus from './components/SaveStatus.js'
import SettingsPage from './components/SettingsPage.js'
import Tooltip from './components/Tooltip.js'
import ProjectSettingsDrawer from './components/ProjectSettingsDrawer.js'
import ChangesDrawer from './components/ChangesDrawer.js'
import ProjectSidebar from './components/ProjectSidebar.js'
import { useCollectionEditor } from './hooks/useCollectionEditor.js'
import { useEnvironmentEditor } from './hooks/useEnvironmentEditor.js'
import { usePaneWidth } from './hooks/usePaneWidth.js'
import { useSettings } from './hooks/useSettings.js'
import { useProjects } from './hooks/useProjects.js'
import {
  childKey,
  childResultsOf,
  referenceFor,
  resolveSet,
  summaryOfFile,
  summaryOfSet
} from './reuse.js'
import { filterSteps } from './tagFilter.js'

const NO_TAGS: string[] = []
const NO_FLAGS = {}
const NO_SETTINGS: Settings = {}
const NO_SETS: RequestSetView[] = []
const NO_ENDPOINTS: EndpointView[] = []

/** A failed call's message, or null — what the sidebar's name forms show. */
const messageOf = (result: { ok: boolean }) =>
  result.ok ? null : (result as unknown as { message: string }).message

let runCounter = 0
const nextRunId = (): string => `run-${Date.now()}-${++runCounter}`

const NO_RESULTS: Record<string, RunResult> = {}

export default function App() {
  const ws = useProjects()
  const sidebar = usePaneWidth('pane.sidebar', 300, 200, 560)
  const { settings, loaded: settingsLoaded, change: changeSettings } = useSettings()
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Until the real settings arrive, do not auto save on a default the person
  // may have turned off.
  const autoSave = useMemo(
    () => ({
      enabled: settingsLoaded && settings.editing.autoSave.enabled,
      delayMs: settings.editing.autoSave.delayMs
    }),
    [settingsLoaded, settings]
  )
  const editor = useCollectionEditor({ autoSave })
  const environmentEditor = useEnvironmentEditor(autoSave)
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [flagsOpen, setFlagsOpen] = useState(false)
  /** The project whose settings drawer is open, if any. */
  const [projectSettingsOpen, setProjectSettingsOpen] = useState<string | null>(null)
  /** The repository whose Changes drawer is open, by one of its projects, and on which tab. */
  const [changesFor, setChangesFor] = useState<{
    projectId: string
    tab: 'changes' | 'history'
  } | null>(null)
  /** A collection just created, opened once its project lists it. */
  const [openWhenListed, setOpenWhenListed] = useState<string | null>(null)
  const open = editor.session
  const doc = editor.displayDoc

  const [envOverride, setEnvOverride] = useState<Record<string, string | null>>({})
  const [previews, setPreviews] = useState<VariablePreviews>({})

  const [error, setError] = useState<string | null>(null)
  /**
   * Last result per step id, so results follow a step when steps move — one
   * set per data file row (SPEC.md §2.8); a collection without one uses row 0.
   */
  const [rowResults, setRowResults] = useState<Record<number, Record<string, RunResult>>>({})
  /** The row the run in flight started with, for the results it brings back. */
  const runRow = useRef(0)
  const [runningIndex, setRunningIndex] = useState<number | null>(null)
  const [runningAll, setRunningAll] = useState(false)
  const [summary, setSummary] = useState<CollectionRunSummary | null>(null)
  const activeRunId = useRef<string | null>(null)
  /** Step ids in run order, captured when a collection run starts. */
  const runIds = useRef<string[]>([])
  /** Their positions in the collection, so progress marks the right row. */
  const runIndexes = useRef<number[]>([])
  /** Tags the step list is filtered to, per collection file. */
  const [tagFilters, setTagFilters] = useState<Record<string, string[]>>({})
  /** The collection settings drawer: closed, or open at a section. */
  const [collectionSettingsOpen, setCollectionSettingsOpen] = useState<SettingsSection | null>(null)

  const stepIndex = editor.selectedIndex
  const tagFilter = (open && tagFilters[open.summary.path]) || NO_TAGS
  const tagSuggestions = useMemo(() => {
    const all = new Set<string>()
    for (const project of ws.state.projects) {
      for (const collection of project.collections) collection.tags.forEach((t) => all.add(t))
    }
    for (const tag of doc?.tags ?? []) all.add(tag)
    for (const step of doc?.steps ?? []) (step.tags ?? []).forEach((t) => all.add(t))
    return [...all].sort()
  }, [ws.state.projects, doc])
  const request = editor.request
  const pendingStep = editor.pendingStep

  /* ------------------------------------------------------- current context */

  const collectionPath = open?.summary.path ?? null
  const activeProject = ws.project(open?.projectId)

  /* ------------------------------------------------------------- data file */

  const data = useDataFileEditor(collectionPath, autoSave)
  const [dataOpen, setDataOpen] = useState(false)
  /** The data row chosen per collection file, remembered across restarts. */
  const [rowChoice, setRowChoice] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem('data.rows') ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })
  const rowCount = data.table?.rows.length ?? 0
  /** The row a single step runs with, and variables preview against. */
  const dataRow =
    collectionPath && rowCount > 0 ? Math.min(rowChoice[collectionPath] ?? 0, rowCount - 1) : 0
  const chooseRow = useCallback(
    (row: number) => {
      if (!collectionPath) return
      setRowChoice((current) => {
        const next = { ...current, [collectionPath]: row }
        try {
          window.localStorage.setItem('data.rows', JSON.stringify(next))
        } catch {
          // Only a convenience: without storage, the choice lasts the session.
        }
        return next
      })
    },
    [collectionPath]
  )
  /** The chosen row as a run takes it; null without a data file (or one that will not read). */
  const dataRowToRun = useMemo(
    () => (data.table && data.fileName ? dataRowInput(data.table, dataRow, data.fileName) : null),
    [data.table, data.fileName, dataRow]
  )

  /** The shown row's results: the step list and panes show one iteration at a time. */
  const results = useMemo(() => rowResults[dataRow] ?? NO_RESULTS, [rowResults, dataRow])
  const setResults = useCallback(
    (change: (current: Record<string, RunResult>) => Record<string, RunResult>) =>
      setRowResults((all) => ({ ...all, [runRow.current]: change(all[runRow.current] ?? {}) })),
    []
  )
  const rowNames = useMemo(
    () => data.table?.rows.map((values, row) => rowName(row, rowLabel(values))) ?? null,
    [data.table]
  )
  /** Each row's results, counted, for the iterations strip; null until a row has any. */
  const iterations: IterationCounts[] | null = useMemo(() => {
    if (!data.table || data.table.rows.length === 0) return null
    const counts = data.table.rows.map((_, row) => iterationCounts(rowResults[row]))
    return counts.some((c) => c.state !== null) ? counts : null
  }, [data.table, rowResults])
  /**
   * The open file's problems as the project lists them now, not as they were
   * when it was opened: fixing an id rescans the project, and the banner follows.
   */
  const openProblems = useMemo(() => {
    if (!open) return []
    const listed = activeProject?.collections.find((c) => c.path === open.summary.path)
    if (listed) return listed.problems
    const library = [
      ...(activeProject?.requestSets ?? []),
      ...(activeProject?.endpointFiles ?? []),
      ...(activeProject?.bases ?? [])
    ].find((file) => file.path === open.summary.path)
    if (library)
      return library.problem ? [{ path: open.summary.relativePath, message: library.problem }] : []
    return open.summary.problems
  }, [open, activeProject])

  /** The open collection's data file as the project lists it now: added or removed on disk, it follows. */
  const openDataFile = useMemo(() => {
    if (!open) return null
    const listed = activeProject?.collections.find((c) => c.path === open.summary.path)
    return (listed ?? open.summary).dataFile ?? null
  }, [open, activeProject])

  /**
   * The chosen environment belongs to the project: every collection in it
   * shares one answer to "which host am I pointing at", so opening a sibling
   * collection keeps the choice. Shown at once, before main has saved it.
   */
  const projectId = activeProject?.id ?? null
  const persistedEnvironment = activeProject?.selectedEnvironment ?? null
  const selectedEnvironment = projectId
    ? envOverride[projectId] !== undefined
      ? (envOverride[projectId] ?? null)
      : persistedEnvironment
    : null

  useEffect(() => {
    if (!projectId) return
    const pending = envOverride[projectId]
    if (pending !== undefined && pending === persistedEnvironment) {
      setEnvOverride(({ [projectId]: _dropped, ...rest }) => rest)
    }
  }, [projectId, envOverride, persistedEnvironment])

  // The chosen environment's files — the project's and its global project's —
  // and their unsaved edits, for a run to use.
  const environments = activeProject?.environments ?? open?.environments ?? []
  const selectedEnvironmentFiles = environments
    .filter((environment) => environment.name === selectedEnvironment)
    .map((environment) => environment.path)
  const selectedEnvironmentPath = selectedEnvironmentFiles[0] ?? null
  const overrides = environmentEditor.overridesFor(selectedEnvironmentFiles)
  const overridesKey = JSON.stringify(overrides)
  // Stable while nothing in them changes, so what depends on them does not churn.
  const environmentOverrides = useMemo(() => overrides, [overridesKey])

  // The flags runs use: fixed values, the environment's command, the app's overrides.
  const flags = useFlags(
    activeProject?.path ?? null,
    selectedEnvironment,
    environmentOverrides,
    activeProject
  )
  const flagValues = flags.view?.values ?? null

  // A renamed environment stays chosen: follow its file to its new name.
  const chosenFile = useRef<string | null>(null)
  useEffect(() => {
    if (selectedEnvironmentPath) {
      chosenFile.current = selectedEnvironmentPath
      return
    }
    const renamed = environments.find((env) => env.path === chosenFile.current)
    if (selectedEnvironment && renamed) chooseEnvironment(renamed.name)
    // Only when the list or the choice moves.
  }, [environments, selectedEnvironment, selectedEnvironmentPath])

  const chooseEnvironment = (environment: string | null) => {
    if (!projectId) return
    setEnvOverride((current) => ({ ...current, [projectId]: environment }))
    void window.desktop.projects.selectEnvironment(projectId, environment)
  }

  /* --------------------------------------------------------- navigation */

  useEffect(() => {
    if (!openWhenListed) return
    for (const project of ws.state.projects) {
      const summary = project.collections.find((collection) => collection.path === openWhenListed)
      if (summary) {
        setOpenWhenListed(null)
        void openCollection(project, summary)
        return
      }
    }
  }, [openWhenListed, ws.state.projects])

  const openCollection = useCallback(
    async (project: ProjectView, collectionSummary: CollectionSummary) => {
      try {
        await editor.openCollection(project, collectionSummary)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return
      }
      setRowResults({})
      setSummary(null)
      setError(null)
    },
    [editor]
  )

  const selectStep = useCallback(
    (index: number) => {
      const id = open?.ids[index]
      if (!id) return
      editor.select(id)
      setError(null)
    },
    [open, editor]
  )

  /* ------------------------------------------------ variable previews */

  const previewRequest = useMemo(
    () => ({
      step: pendingStep ?? {},
      collectionPath,
      environment: selectedEnvironment,
      // As edited, so a new variable previews before it is saved.
      collection: { vars: doc?.vars, script: doc?.before?.script, extends: doc?.extends },
      environmentOverrides,
      dataRow: dataRowToRun
    }),
    [
      pendingStep,
      collectionPath,
      selectedEnvironment,
      doc?.vars,
      doc?.before?.script,
      doc?.extends,
      environmentOverrides,
      dataRowToRun
    ]
  )

  useEffect(() => {
    let stale = false
    void window.desktop.variables.preview(previewRequest).then((result) => {
      if (!stale) setPreviews(result)
    })
    return () => {
      stale = true
    }
    // Deliberately narrow: `previewRequest` changes on every keystroke anywhere
    // in the step, and re-resolving the environment that often is waste.
  }, [
    collectionPath,
    stepIndex,
    selectedEnvironment,
    request?.url,
    JSON.stringify(request?.headers),
    JSON.stringify(doc?.vars),
    doc?.before?.script,
    doc?.extends,
    JSON.stringify(environmentOverrides),
    JSON.stringify(dataRowToRun),
    ws.state.projects
  ])

  // A request set's own requests read `{{params.name}}`: known, valued by default.
  const shownPreviews = useMemo(() => {
    if (!doc?.params) return previews
    const params = Object.entries(doc.params).map(([name, spec]) => {
      const fallback = readParam(spec).default
      return [
        `params.${name}`,
        {
          value: fallback === undefined || fallback === null ? null : String(fallback),
          origin: 'params',
          kind: fallback === undefined ? 'dynamic' : 'static'
        } satisfies VariablePreview
      ] as const
    })
    return { ...previews, ...Object.fromEntries(params) }
  }, [previews, doc?.params])

  const copyVariable = useCallback(
    (name: string) => window.desktop.variables.copy(previewRequest, name),
    [previewRequest]
  )

  // A file to upload is named from the project the open file belongs to.
  const openPath = open?.summary.path
  const pickUpload = useMemo(
    () =>
      openPath
        ? async () => {
            const picked = await window.desktop.projects.pickFile({
              kind: 'upload',
              collectionPath: openPath
            })
            if (!picked.ok) throw new Error(picked.message)
            return picked.path
          }
        : undefined,
    [openPath]
  )

  const saveEnvironments = environmentEditor.saveAll
  const closeEnvironments = useCallback(() => {
    setEnvironmentsOpen(false)
    // Leaving the drawer is a natural moment to save what was edited in it.
    if (autoSave.enabled) void saveEnvironments()
  }, [autoSave.enabled, saveEnvironments])

  /* ----------------------------------------------------------------- save */

  const save = useCallback(async () => {
    await Promise.all([editor.saveAll(), environmentEditor.saveAll(), data.flush()])
  }, [editor, environmentEditor, data])

  // Closing the window: with auto save on, save first; either way, report what
  // is still unsaved so main can ask rather than lose it.
  useEffect(
    () =>
      window.desktop.app.onBeforeClose(async ({ save: requested }) => {
        if (requested || autoSave.enabled) {
          await Promise.all([editor.saveAll(), environmentEditor.saveAll(), data.flush()])
        }
        return {
          unsaved: [
            ...editor.unsavedNames(),
            ...environmentEditor.unsavedNames(),
            ...(data.dirty && data.fileName ? [data.fileName] : [])
          ]
        }
      }),
    [editor, environmentEditor, data, autoSave.enabled]
  )

  /* ------------------------------------------------------------------ run */

  /** The row a data run's progress last showed, and a way to show another from the listener. */
  const followedRow = useRef<number | null>(null)
  const chooseRowRef = useRef(chooseRow)
  chooseRowRef.current = chooseRow

  // Per-step results stream in during a collection run rather than arriving all
  // at once at the end, so the list fills in as it goes.
  useEffect(
    () =>
      window.desktop.onRunProgress(({ runId, index, result, iteration }) => {
        if (runId !== activeRunId.current) return
        const id = runIds.current[index]
        // A use step reports once per request of its set, each under its own key.
        const key = id && result.use ? childKey(id, result.use.child) : id
        // A run over a data file reports which row; the list follows the row running.
        const row = iteration ? iteration.index - 1 : runRow.current
        if (iteration && row !== followedRow.current) {
          followedRow.current = row
          chooseRowRef.current(row)
        }
        if (key) {
          setRowResults((all) => ({ ...all, [row]: { ...(all[row] ?? {}), [key]: result } }))
        }
        if (!result.use || result.use.child === result.use.of - 1) {
          const next = runIndexes.current[index + 1]
          // At a row's last step, the next row starts again at the first.
          const again = iteration && iteration.index < iteration.of ? runIndexes.current[0] : -1
          setRunningIndex(next ?? again ?? -1)
        }
      }),
    []
  )

  const send = useCallback(async () => {
    const id = editor.selectedId
    if (!request || !id || runningIndex !== null || stepIndex < 0) return
    // A use step is its set's requests: it runs as a collection of one step.
    if (request.use !== null) return void runIndexesOf([stepIndex], false)
    if (request.url.trim() === '') return
    const runId = nextRunId()
    activeRunId.current = runId
    setRunningIndex(stepIndex)
    setError(null)

    if (!pendingStep || !doc) return
    runRow.current = dataRow
    const response = await window.desktop.runStart({
      runId,
      step: pendingStep,
      collection: doc,
      collectionPath,
      environment: selectedEnvironment,
      environmentOverrides,
      dataRow: dataRowToRun
    })

    if (activeRunId.current !== runId) return
    activeRunId.current = null
    setRunningIndex(null)
    if (response.ok) setResults((current) => ({ ...current, [id]: response.result }))
    else setError(response.message)
  }, [
    editor.selectedId,
    request,
    runningIndex,
    stepIndex,
    pendingStep,
    doc,
    collectionPath,
    selectedEnvironment,
    dataRow,
    dataRowToRun
  ])

  /** Run one step on its own, selecting it first so its response is visible. */
  const runStep = useCallback(
    (index: number) => {
      selectStep(index)
      // Selecting is state; the send below reads the step from the document
      // rather than the editor, so it does not have to wait for that state.
      const step = doc?.steps[index]
      const id = open?.ids[index]
      if (!step || !doc || !id) return
      if (isUseStep(step)) return void runIndexesOf([index], false)
      const runId = nextRunId()
      activeRunId.current = runId
      setRunningIndex(index)
      setError(null)
      runRow.current = dataRow
      void window.desktop
        .runStart({
          runId,
          step,
          collection: doc,
          collectionPath,
          environment: selectedEnvironment,
          environmentOverrides,
          dataRow: dataRowToRun
        })
        .then((response) => {
          if (activeRunId.current !== runId) return
          activeRunId.current = null
          setRunningIndex(null)
          if (response.ok) setResults((current) => ({ ...current, [id]: response.result }))
          else setError(response.message)
        })
    },
    [open, doc, collectionPath, selectedEnvironment, selectStep, dataRow, dataRowToRun]
  )

  /**
   * Run some steps in order, sharing one scope as a full run does: every step
   * for Run all, or one use step, whose set's requests run as a collection.
   */
  async function runIndexesOf(indexes: number[], all: boolean) {
    if (!open || !doc || indexes.length === 0) return
    const runId = nextRunId()
    activeRunId.current = runId
    runIds.current = indexes.map((index) => open.ids[index]!)
    runIndexes.current = indexes
    runRow.current = dataRow
    followedRow.current = null
    // Run all with a data file runs every row, as gta does (SPEC.md §2.8).
    const table = data.table
    const everyRow =
      all && table && data.fileName && table.rows.length > 0
        ? table.rows.map((_, row) => dataRowInput(table, row, data.fileName!)!)
        : null
    if (all && data.path && (data.problem || data.problems.length > 0)) {
      setError(`The data file cannot run: ${data.problem ?? data.problems[0]}`)
      return
    }
    if (all) setRowResults({})
    else {
      // Only these steps' old results go: the rest of the list keeps its own.
      const ids = new Set(runIds.current)
      setResults((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !ids.has(key.split('#')[0]!)))
      )
    }
    setSummary(null)
    setError(null)
    if (all) setRunningAll(true)
    setRunningIndex(indexes[0]!)

    const response = await window.desktop.runCollection({
      runId,
      // Only the chosen steps, in order, sharing one scope as a full run would.
      collection: { ...doc, steps: indexes.map((index) => doc.steps[index]!) },
      collectionPath,
      environment: selectedEnvironment,
      environmentOverrides,
      ...(everyRow ? { dataRows: everyRow } : { dataRow: dataRowToRun })
    })

    if (activeRunId.current !== runId) return
    activeRunId.current = null
    setRunningAll(false)
    setRunningIndex(null)
    if (response.ok) {
      if (all) setSummary(response.summary)
    } else setError(response.message)
  }

  /** Run every step, or with a tag filter on, just the steps it shows. */
  const runAll = useCallback(async () => {
    if (!open || !doc || runningIndex !== null) return
    await runIndexesOf(filterSteps(doc, tagFilter).indexes, true)
  }, [
    open,
    doc,
    runningIndex,
    collectionPath,
    selectedEnvironment,
    tagFilter,
    data,
    dataRow,
    dataRowToRun
  ])

  const cancel = () => {
    if (activeRunId.current) window.desktop.runCancel(activeRunId.current)
  }

  // Cmd/Ctrl+Enter sends, Cmd/Ctrl+S saves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === 'Enter') {
        event.preventDefault()
        void send()
      } else if (event.key === 's') {
        event.preventDefault()
        void save()
      } else if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [send, save])

  /** Results by position, for the list: they are kept by step id. */
  const resultsByIndex = useMemo(() => {
    const byIndex: Record<number, RunResult> = {}
    open?.ids.forEach((id, index) => {
      const result = results[id]
      if (result) byIndex[index] = result
    })
    return byIndex
  }, [open, results])

  /** Request sets a use step can run: the open project's, and its global project's. */
  const sets = activeProject?.requestSets ?? NO_SETS

  /** For each use step, its set's results, one per request, in order. */
  const childResults = useMemo(() => {
    const byIndex: Record<number, Array<RunResult | undefined>> = {}
    doc?.steps.forEach((step, index) => {
      const id = open?.ids[index]
      if (!id || !isUseStep(step)) return
      const set = resolveSet(sets, step.use)
      byIndex[index] = childResultsOf(results, id, set?.steps.length ?? 0)
    })
    return byIndex
  }, [doc, open, results, sets])

  // Which request of a use step the panes show; back to its first on another step.
  const [shownChild, setShownChild] = useState(0)
  /** A request asked for along with its step, shown once that step is selected. */
  const askedChild = useRef<number | null>(null)
  useEffect(() => {
    setShownChild(askedChild.current ?? 0)
    askedChild.current = null
  }, [editor.selectedId])

  /** The response shown beside the step list belongs to the selected step. */
  const selectedResult =
    (editor.selectedId &&
      (request?.use !== null && request?.use !== undefined
        ? (results[childKey(editor.selectedId, shownChild)] ?? results[editor.selectedId])
        : results[editor.selectedId])) ||
    null

  /** Whether the open file is one of the project's endpoints files, or bases. */
  const isLibraryOf = (home: 'endpoints' | 'bases') =>
    open?.summary.relativePath.startsWith(`${home}/`) ?? false

  /** Open an endpoints file or a base collection of the open project, by its path. */
  const openLibraryFile = (path: string) => {
    const project = activeProject
    if (!project) return
    const endpoints = project.endpointFiles.find((file) => file.path === path)
    const base = project.bases.find((file) => file.path === path)
    if (endpoints) void openCollection(project, summaryOfFile(endpoints, 'endpoints'))
    else if (base) void openCollection(project, summaryOfFile(base, 'bases'))
  }

  const openSet = (set: RequestSetView) => {
    const project = activeProject
    if (!project) return
    void openCollection(project, summaryOfSet(set))
  }
  // Where the selected step's last run stopped in one of the collection's scripts.
  const failed = selectedResult?.error?.script === 'collection' ? selectedResult.error : null
  const collectionErrorLines = {
    preRequest: failed?.phase === 'pre-request' ? failed.line : undefined,
    tests: failed?.phase === 'tests' ? failed.line : undefined
  }

  return (
    <div className="app">
      <header className="app-bar">
        <span className="app-title">Gravity</span>
        <span className="app-subtitle" title={open?.summary.path ?? ''}>
          {open?.summary.name ?? ''}
        </span>
        {editor.status && (
          <SaveStatus
            status={editor.status}
            autoSave={autoSave.enabled}
            onSave={() => void save()}
            onReload={editor.reloadFromDisk}
            onKeepMine={editor.keepMine}
          />
        )}
        <span className="spacer" />
        {open && (
          <EnvironmentPicker
            environments={environments}
            selected={selectedEnvironment}
            onChange={chooseEnvironment}
          />
        )}
        {open && (
          <Tooltip text="Edit environments: their names and variables">
            <button
              type="button"
              className="env-edit"
              onClick={() => setEnvironmentsOpen(true)}
              aria-label="Edit environments"
            >
              {environments.length === 0 ? '+ Environment' : 'Edit'}
              {environmentEditor.anyPending && (
                <span className="step-dirty" title="Unsaved changes">
                  •
                </span>
              )}
            </button>
          </Tooltip>
        )}
        {open && (
          <Tooltip
            text={
              flags.view?.error
                ? 'Feature flags: the command failed, so runs use fixed values and overrides only'
                : 'Feature flags: their values in this environment, and overrides'
            }
          >
            <button
              type="button"
              className={`flags-button${flags.view?.error || flags.failure ? ' warn' : ''}`}
              onClick={() => setFlagsOpen(true)}
              aria-label="Feature flags"
            >
              Flags
              <span className="count">{Object.keys(flagValues ?? {}).length}</span>
              {(flags.view?.error || flags.failure) && <span className="flags-warn">!</span>}
            </button>
          </Tooltip>
        )}
        <Tooltip text="App settings (⌘,)">
          <button
            type="button"
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="App settings"
          >
            <GearIcon />
          </button>
        </Tooltip>
      </header>

      {projectSettingsOpen && ws.project(projectSettingsOpen) && (
        <ProjectSettingsDrawer
          project={ws.project(projectSettingsOpen)!}
          autoSave={autoSave}
          previews={shownPreviews}
          onCopyVariable={copyVariable}
          onOpenChanges={() => {
            setChangesFor({ projectId: projectSettingsOpen, tab: 'changes' })
            setProjectSettingsOpen(null)
          }}
          onClose={() => setProjectSettingsOpen(null)}
        />
      )}

      {changesFor && ws.project(changesFor.projectId)?.isRepo && (
        <ChangesDrawer
          key={changesFor.projectId}
          project={ws.project(changesFor.projectId)!}
          initialTab={changesFor.tab}
          onClose={() => setChangesFor(null)}
        />
      )}

      {dataOpen && open && data.path && (
        <DataDrawer data={data} autoSave={autoSave.enabled} onClose={() => setDataOpen(false)} />
      )}

      {flagsOpen && open && (
        <FlagsDrawer
          view={flags.view}
          busy={flags.busy}
          failure={flags.failure}
          onRefresh={() => void flags.refresh()}
          onOverride={(name, value) => void flags.setOverride(name, value)}
          onEditEnvironment={() => {
            setFlagsOpen(false)
            setEnvironmentsOpen(true)
          }}
          onClose={() => setFlagsOpen(false)}
        />
      )}

      {environmentsOpen && open && (
        <EnvironmentsDrawer
          environments={environments}
          collectionPath={open.summary.path}
          selected={selectedEnvironment}
          editor={environmentEditor}
          autoSave={autoSave.enabled}
          onCreated={(name) => {
            if (!selectedEnvironment) chooseEnvironment(name)
          }}
          onDeleted={(name) => {
            if (selectedEnvironment === name) chooseEnvironment(null)
          }}
          previews={shownPreviews}
          onCopyVariable={copyVariable}
          onClose={closeEnvironments}
        />
      )}

      <div className="layout" style={{ gridTemplateColumns: `${sidebar.width}px 1fr` }}>
        <ProjectSidebar
          resizer={<Resizer pane={sidebar} label="Resize the collections pane" />}
          workspaces={ws.state.workspaces}
          active={ws.active}
          projects={ws.projects}
          selectedRoot={collectionPath}
          error={ws.error}
          onClearError={ws.clearError}
          notice={ws.notice}
          cloning={ws.cloning}
          onSelectCollection={(project, collectionSummary) =>
            void openCollection(project, collectionSummary)
          }
          onSetActive={(id) => void ws.setActive(id)}
          onCreateWorkspace={async (name) => messageOf(await ws.createWorkspace(name))}
          onRenameWorkspace={async (id, name) => messageOf(await ws.renameWorkspace(id, name))}
          onRemoveWorkspace={(id) => void ws.removeWorkspace(id)}
          onAddProject={() => void ws.addProject()}
          onClone={(url) => void ws.cloneUrl(url)}
          onRemoveProject={(id) => void ws.removeProject(id)}
          onFetch={ws.fetch}
          onPull={ws.pull}
          onPush={ws.push}
          onChanges={(projectId, tab) => setChangesFor({ projectId, tab })}
          onCreateDirectory={async (id, name) => messageOf(await ws.createDirectory(id, name))}
          onCreateCollection={async (id, directory, name, kind) => {
            const result = await ws.createCollection(id, directory, name, kind)
            if (result.ok) setOpenWhenListed(result.path)
            return messageOf(result)
          }}
          onProjectSettings={setProjectSettingsOpen}
          onReveal={(path) => void window.desktop.projects.reveal(path)}
        />

        <main className="workbench">
          {open && doc ? (
            <CollectionView
              name={open.summary.name}
              relativePath={open.summary.relativePath}
              problems={openProblems}
              dataFile={openDataFile}
              dataRows={rowNames}
              dataRow={dataRow}
              onDataRow={chooseRow}
              onOpenData={() => setDataOpen(true)}
              onCreateData={
                isLibraryOf('bases') || isLibraryOf('endpoints') || !doc
                  ? null
                  : async (column) => {
                      await data.create(column)
                      setDataOpen(true)
                    }
              }
              iterations={iterations}
              onFixId={editor.setCollectionId}
              collection={doc}
              selectedIndex={stepIndex}
              results={resultsByIndex}
              runningIndex={runningIndex}
              runningAll={runningAll}
              summary={summary}
              draftIndexes={editor.dirtyIndexes}
              onSelect={selectStep}
              onRunStep={runStep}
              onRunAll={() => void runAll()}
              onCancel={cancel}
              onAddStep={() =>
                editor.addStep(
                  editor.selectedId,
                  isLibraryOf('endpoints') ? { GET: '/path/{id}' } : undefined
                )
              }
              library={
                isLibraryOf('endpoints') ? 'endpoints' : isLibraryOf('bases') ? 'bases' : null
              }
              sets={sets}
              onAddUse={() => {
                const first = sets.find((set) => !set.problem) ?? sets[0]
                if (first) editor.addStep(editor.selectedId, { use: referenceFor(sets, first) })
              }}
              childResults={childResults}
              selectedChild={shownChild}
              onSelectChild={(index, child) => {
                if (open.ids[index] === editor.selectedId) setShownChild(child)
                else {
                  askedChild.current = child
                  selectStep(index)
                }
              }}
              onRenameStep={(index, name) => {
                const id = open.ids[index]
                if (id) editor.rename(id, name)
              }}
              onDuplicateStep={(index) => {
                const id = open.ids[index]
                if (id) editor.duplicateStep(id)
              }}
              onDeleteStep={(index) => {
                const id = open.ids[index]
                if (id) editor.removeStep(id)
              }}
              onMoveStep={(index, to) => {
                const id = open.ids[index]
                if (id) editor.moveStep(id, to)
              }}
              stepTags={request?.tags ?? NO_TAGS}
              onStepTags={(tags) => editor.patch({ tags })}
              onCollectionTags={editor.setCollectionTags}
              onStepTagsEnabled={editor.setStepTagsEnabled}
              onCollectionExcluded={editor.setCollectionExcluded}
              flagValues={flagValues}
              onCollectionFlags={editor.setCollectionFlags}
              stepFlags={request?.flags ?? NO_FLAGS}
              onStepFlags={(flags) => editor.patch({ flags: flags ?? {} })}
              onCollectionSettings={editor.setCollectionSettings}
              onCollectionHeaders={editor.setCollectionHeaders}
              onCollectionVars={editor.setCollectionVars}
              onCollectionParams={editor.setCollectionParams}
              bases={
                isLibraryOf('bases') || isLibraryOf('endpoints')
                  ? null
                  : (activeProject?.bases ?? [])
              }
              onExtends={editor.setCollectionExtends}
              onOpenBase={openLibraryFile}
              onCollectionPreRequest={editor.setCollectionPreRequest}
              onCollectionTests={editor.setCollectionTests}
              collectionErrorLines={collectionErrorLines}
              settingsOpen={collectionSettingsOpen}
              onSettingsOpen={setCollectionSettingsOpen}
              previews={shownPreviews}
              onCopyVariable={copyVariable}
              tagSuggestions={tagSuggestions}
              tagFilter={tagFilter}
              onTagFilter={(tags) =>
                setTagFilters((current) => ({ ...current, [open.summary.path]: tags }))
              }
            >
              {stepIndex >= 0 && request && (
                <RequestView
                  request={request}
                  collectionSettings={doc.settings ?? NO_SETTINGS}
                  collectionHeaders={doc.headers}
                  onEditCollectionHeaders={() => setCollectionSettingsOpen('headers')}
                  collectionScripts={{
                    preRequest: (doc.before?.script ?? '').trim() !== '',
                    tests: (doc.tests ?? '').trim() !== ''
                  }}
                  onEditCollectionScript={setCollectionSettingsOpen}
                  onChange={editor.patch}
                  docs={doc.steps[stepIndex]?.docs}
                  previews={shownPreviews}
                  onCopyVariable={copyVariable}
                  onPickFile={pickUpload}
                  result={selectedResult}
                  resultCaption={
                    rowNames && doc.steps[stepIndex]
                      ? iterationName(
                          stepLabel(doc.steps[stepIndex]!),
                          dataRow,
                          data.table ? rowLabel(data.table.rows[dataRow] ?? {}) : null
                        )
                      : null
                  }
                  error={error}
                  running={runningIndex === stepIndex}
                  onSend={() => void send()}
                  onCancel={cancel}
                  conflict={open.conflict !== null}
                  onReloadFromDisk={editor.reloadFromDisk}
                  onKeepMine={editor.keepMine}
                  sets={sets}
                  shownChild={shownChild}
                  onOpenSet={openSet}
                  endpoints={
                    // An endpoints file's own steps are the endpoints, under no base.
                    isLibraryOf('endpoints')
                      ? NO_ENDPOINTS
                      : (activeProject?.endpoints ?? NO_ENDPOINTS)
                  }
                  onOpenEndpoints={(endpoint) => openLibraryFile(endpoint.filePath)}
                />
              )}
            </CollectionView>
          ) : (
            <div className="placeholder">Choose a collection to see its steps.</div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsPage
          settings={settings}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
