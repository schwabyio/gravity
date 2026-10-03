import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isUseStep,
  readParam,
  rowLabel,
  stepLabel,
  STEP_LISTS,
  type VariablePreview,
  type Collection,
  type CollectionRunSummary,
  type CollectionSummary,
  type RunResult,
  type Step,
  type StepList,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import type {
  ConnectionView,
  EndpointView,
  LibraryFileView,
  ProjectView,
  RequestSetView
} from '@shared/ipc.js'
import type { SettingsSection } from './components/CollectionSettings.js'
import CollectionView, { connectionNames } from './components/CollectionView.js'
import type { LiveView } from './components/ResponsePane.js'
import BottomPanel from './components/BottomPanel.js'
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
import { idsOf, stepsOf, useCollectionEditor } from './hooks/useCollectionEditor.js'
import { useEnvironmentEditor } from './hooks/useEnvironmentEditor.js'
import { usePaneWidth } from './hooks/usePaneWidth.js'
import { useSettings } from './hooks/useSettings.js'
import { useProjects } from './hooks/useProjects.js'
import {
  childKey,
  childResultsOf,
  itemKey,
  itemResultsOf,
  referenceFor,
  resolveSet,
  stepOfKey,
  summaryOfFile,
  summaryOfSet
} from './reuse.js'
import { filterSteps } from './tagFilter.js'
import { changesSince } from './stepChanges.js'

const NO_TAGS: string[] = []
const NO_FLAGS = {}
const NO_SETS: RequestSetView[] = []
const NO_ENDPOINTS: EndpointView[] = []
const NO_BASES: LibraryFileView[] = []
const NO_CONNECTIONS: ConnectionView[] = []

/** A failed call's message, or null — what the sidebar's name forms show. */
const messageOf = (result: { ok: boolean }) =>
  result.ok ? null : (result as unknown as { message: string }).message

let runCounter = 0
const nextRunId = (): string => `run-${Date.now()}-${++runCounter}`

const NO_RESULTS: Record<string, RunResult> = {}

/** The step ids a run covers, per list, and the list a result with no `stage` is from. */
interface RunPlan {
  ids: Record<StepList, string[]>
  /** `steps` for a run of the collection; the list of the step run on its own, otherwise. */
  list: StepList
}

/** The collection without setup or teardown: running some of its steps runs neither. */
function withoutStages(doc: Collection): Collection {
  const copy = { ...doc }
  delete copy.setup
  delete copy.teardown
  return copy
}

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
  /** Setup and teardown steps' results: they run once, not per row (SPEC.md §2.10). */
  const [stageResults, setStageResults] = useState<Record<string, RunResult>>({})
  /** The row the run in flight started with, for the results it brings back. */
  const runRow = useRef(0)
  /** The step running now; '' while a run is in flight with no step to mark; null when idle. */
  const [runningId, setRunningId] = useState<string | null>(null)
  const [runningAll, setRunningAll] = useState(false)
  const [summary, setSummary] = useState<CollectionRunSummary | null>(null)
  const activeRunId = useRef<string | null>(null)
  /**
   * The run results belong to: the one in flight, or the last one to finish,
   * whose final results can arrive after its answer does.
   */
  const resultsRunId = useRef<string | null>(null)
  /** Step ids per list, captured when a collection run starts, so progress marks the right row. */
  const runPlan = useRef<RunPlan>({ ids: { setup: [], steps: [], teardown: [] }, list: 'steps' })
  /** The event stream the run in flight reads now, as it is read; null between streams. */
  const [live, setLive] = useState<LiveView | null>(null)
  /** The connections each collection's Sends hold open (SPEC.md §2.11), by its path. */
  const [held, setHeld] = useState<Record<string, ConnectionView[]>>({})
  /** Tags the step list is filtered to, per collection file. */
  const [tagFilters, setTagFilters] = useState<Record<string, string[]>>({})
  /** The collection settings drawer: closed, or open at a section. */
  const [collectionSettingsOpen, setCollectionSettingsOpen] = useState<SettingsSection | null>(null)

  const stepIndex = editor.selectedIndex
  const stepList = editor.selectedList
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

  /**
   * The shown row's results: the step list and panes show one iteration at a
   * time. Setup and teardown ran once, so theirs show whatever the row.
   */
  const results = useMemo(
    () => ({ ...stageResults, ...(rowResults[dataRow] ?? NO_RESULTS) }),
    [stageResults, rowResults, dataRow]
  )
  /** Change one list's results: the run's row for steps, the one set for setup and teardown. */
  const changeResults = useCallback(
    (list: StepList, change: (current: Record<string, RunResult>) => Record<string, RunResult>) =>
      list === 'steps'
        ? setRowResults((all) => ({
            ...all,
            [runRow.current]: change(all[runRow.current] ?? {})
          }))
        : setStageResults(change),
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
      setStageResults({})
      setSummary(null)
      setError(null)
    },
    [editor]
  )

  const selectStep = useCallback(
    (list: StepList, index: number) => {
      const id = open ? idsOf(open, list)[index] : undefined
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
    editor.selectedId,
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
  // A forEach step's read `{{item}}`: known, valued only as it runs.
  const repeats = (request?.forEach ?? '').trim() !== ''
  const shownPreviews = useMemo((): VariablePreviews => {
    const item: VariablePreviews = repeats
      ? { item: { value: null, origin: 'forEach', kind: 'dynamic' } }
      : {}
    if (!doc?.params) return { ...previews, ...item }
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
    return { ...previews, ...Object.fromEntries(params), ...item }
  }, [previews, doc?.params, repeats])

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

  /* ------------------------------------------------------- since git */

  /**
   * The open file as its last commit has it, to mark what changed since:
   * read again whenever the file is saved or its project's git state moves.
   */
  const [committed, setCommitted] = useState<{ path: string; doc: Collection | null } | null>(null)
  const savedSource = open?.source
  const projectGit = activeProject?.git
  useEffect(() => {
    if (!collectionPath) return
    let stale = false
    void window.desktop.collection.committed(collectionPath).then((result) => {
      if (!stale) setCommitted({ path: collectionPath, doc: result.ok ? result.doc : null })
    })
    return () => {
      stale = true
    }
  }, [collectionPath, savedSource, projectGit])
  /** What changed of the open file since then, as it is on disk; unsaved edits have their own •. */
  const sinceCommit = useMemo(
    () =>
      open && committed?.path === open.summary.path && committed.doc
        ? changesSince(committed.doc, open.doc)
        : null,
    [open, committed]
  )

  /* ----------------------------------------------------- collection files */

  /** What a new scratch pad is called unless renamed: the first name no scratch pad's folder has. */
  const scratchPadName = useMemo(() => {
    const taken = new Set(
      ws.state.projects
        .filter((project) => project.scratch)
        .map((project) => (project.path.split(/[\\/]/).pop() ?? '').toLowerCase())
    )
    for (let n = 1; ; n++) {
      const name = n === 1 ? 'Scratch pad' : `Scratch pad ${n}`
      if (!taken.has(name.toLowerCase())) return name
    }
  }, [ws.state.projects])

  /** Before a collection's file is renamed, copied or moved: its edits saved, so they go with it. */
  const savedFirst = async (collection: CollectionSummary): Promise<string | null> => {
    const saved = await editor.flush(collection.path)
    if (collection.path === collectionPath) await data.flush()
    return saved
      ? null
      : `${collection.name} has edits that could not be saved: save it, or reload it from disk, first`
  }

  /** A collection's file went elsewhere, or away: let go of it, and follow it if it was open. */
  const followFile = (from: string, to: string | null) => {
    const wasOpen = collectionPath === from
    editor.forget(from)
    if (wasOpen && to) setOpenWhenListed(to)
  }

  /** The project a collection of the sidebar is in. */
  const projectOf = (collection: CollectionSummary) =>
    ws.state.projects.find((project) =>
      project.collections.some((candidate) => candidate.path === collection.path)
    ) ?? null

  /**
   * A step a collection's menu asked for, added once that collection is open:
   * adding goes through the editor of the open file, and opening takes a moment.
   */
  const [toAdd, setToAdd] = useState<{ path: string; step?: Step } | null>(null)
  useEffect(() => {
    if (!toAdd || !open || collectionPath !== toAdd.path) return
    setToAdd(null)
    // At the end of its steps, and selected, ready to edit.
    editor.addStep(null, toAdd.step)
  }, [toAdd, open, collectionPath, editor])

  /** Open a collection for a step to be added to it, unless it is open already. */
  const addTo = async (collection: CollectionSummary, step?: Step) => {
    const project = projectOf(collection)
    if (!project) return
    if (collectionPath !== collection.path) await openCollection(project, collection)
    setToAdd({ path: collection.path, ...(step ? { step } : {}) })
  }

  const collectionActions = {
    onRename: async (collection: CollectionSummary, id: string) => {
      const unsaved = await savedFirst(collection)
      if (unsaved) return unsaved
      const result = await window.desktop.collection.rename(collection.path, id)
      if (!result.ok) return result.message
      if (result.path !== collection.path) followFile(collection.path, result.path)
      return null
    },
    onTransfer: async (
      collection: CollectionSummary,
      projectId: string,
      directory: string | null,
      move: boolean
    ) => {
      const unsaved = await savedFirst(collection)
      if (unsaved) return unsaved
      const result = await window.desktop.collection.copy(
        collection.path,
        projectId,
        directory,
        move
      )
      if (!result.ok) return result.message
      if (move) followFile(collection.path, result.path)
      ws.notify(
        `${move ? 'Moved' : 'Copied'} ${collection.name} to ${ws.project(projectId)?.name ?? 'the project'}.`
      )
      return null
    },
    onMoveToFolder: async (collection: CollectionSummary, folder: string | null) => {
      const unsaved = await savedFirst(collection)
      if (unsaved) return unsaved
      const result = await window.desktop.collection.moveToFolder(collection.path, folder)
      if (!result.ok) return result.message
      followFile(collection.path, result.path)
      return null
    },
    onNewRequest: (collection: CollectionSummary) => void addTo(collection),
    onNewRequestSet: async (collection: CollectionSummary, id: string) => {
      const project = projectOf(collection)
      if (!project) return 'That collection is not in a project here any more'
      const created = await ws.createCollection(project.id, null, id, 'set')
      if (!created.ok) return created.message
      // Used by the id it was made with: its file name.
      const set = created.path
        .split(/[\\/]/)
        .pop()!
        .replace(/\.yml$/, '')
      await addTo(collection, { use: set })
      return null
    },
    onDelete: async (collection: CollectionSummary) => {
      const what = collection.dataFile ? ' and its data file' : ''
      if (
        !window.confirm(`Delete the collection “${collection.name}”${what}? It goes to the Trash.`)
      ) {
        return
      }
      const result = await window.desktop.collection.remove(collection.path)
      if (!result.ok) return ws.showError(result.message)
      followFile(collection.path, null)
    }
  }

  /** Rename a scratch pad: what is open of it saved first, and followed to its new folder. */
  const renameScratchPad = async (projectId: string, name: string) => {
    const before = ws.project(projectId)
    if (!before) return 'That scratch pad is not here any more'
    for (const collection of before.collections) {
      const unsaved = await savedFirst(collection)
      if (unsaved) return unsaved
    }
    const result = await window.desktop.projects.renameScratchPad(projectId, name)
    if (!result.ok) return result.message
    const shown = collectionPath?.startsWith(before.path) ? collectionPath : null
    editor.forgetProject(projectId)
    if (shown) setOpenWhenListed(result.path + shown.slice(before.path.length))
    return null
  }

  /** A project's collections in one folder of its `collections/`, all of them, filtered or not. */
  const inFolder = (projectId: string, folder: string) =>
    ws.project(projectId)?.collections.filter((collection) => collection.directory === folder) ?? []

  /** Rename a folder: what is in it saved first, and an open collection followed into it. */
  const renameFolder = async (projectId: string, folder: string, name: string) => {
    const inside = inFolder(projectId, folder)
    for (const collection of inside) {
      const unsaved = await savedFirst(collection)
      if (unsaved) return unsaved
    }
    const result = await window.desktop.projects.renameFolder(projectId, folder, name)
    if (!result.ok) return result.message
    const shown = inside.find((collection) => collection.path === collectionPath)
    for (const collection of inside) editor.forget(collection.path)
    if (shown) {
      // The same file, in the folder under its new name.
      const file = Math.max(shown.path.lastIndexOf('/'), shown.path.lastIndexOf('\\'))
      setOpenWhenListed(result.path + shown.path.slice(file))
    }
    return null
  }

  /** Delete a folder and everything in it, once confirmed; what was open of it closes. */
  const deleteFolder = async (projectId: string, folder: string) => {
    const inside = inFolder(projectId, folder)
    const what =
      inside.length === 0
        ? ''
        : ` and its ${inside.length} collection${inside.length === 1 ? '' : 's'}`
    if (
      !window.confirm(`Delete the folder “${folder}”${what}? Everything in it goes to the Trash.`)
    ) {
      return
    }
    const result = await window.desktop.projects.deleteFolder(projectId, folder)
    if (!result.ok) return ws.showError(result.message)
    for (const collection of inside) editor.forget(collection.path)
  }

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
        if (runId !== resultsRunId.current) return
        const plan = runPlan.current
        // Setup and teardown say so; anything else is a step of the list the run was of.
        const from: StepList = result.stage ?? 'steps'
        const id = plan.ids[from][index]
        // A use step reports once per request of its set, a forEach step once
        // per item, each under its own key.
        const key =
          id && result.use
            ? childKey(id, result.use.child)
            : id && result.forEach
              ? itemKey(id, result.forEach.index)
              : id
        // A run over a data file reports which row; the list follows the row running.
        const row = iteration ? iteration.index - 1 : runRow.current
        if (iteration && row !== followedRow.current) {
          followedRow.current = row
          chooseRowRef.current(row)
        }
        if (key) {
          if (result.stage || plan.list !== 'steps') {
            setStageResults((all) => ({ ...all, [key]: result }))
          } else {
            setRowResults((all) => ({ ...all, [row]: { ...(all[row] ?? {}), [key]: result } }))
          }
        }
        const more =
          (result.use && result.use.child < result.use.of - 1) ||
          (result.forEach && result.forEach.index < result.forEach.of - 1)
        // A result after the run's answer only fills in its row: nothing is running.
        if (!more && runId === activeRunId.current) {
          // Setup, then the steps — again from the first for each row — then teardown.
          const next =
            plan.ids[from][index + 1] ??
            (from === 'setup'
              ? (plan.ids.steps[0] ?? plan.ids.teardown[0])
              : from === 'steps'
                ? iteration && iteration.index < iteration.of
                  ? plan.ids.steps[0]
                  : plan.ids.teardown[0]
                : undefined)
          setRunningId(next ?? '')
        }
      }),
    []
  )

  // An event stream as it is read, for the run in flight: each new stream starts afresh.
  useEffect(
    () =>
      window.desktop.onRunLive(({ runId, live: update }) => {
        if (runId !== activeRunId.current) return
        if (update.kind === 'open') {
          setLive({ status: update.status, statusText: update.statusText, events: [], count: 0 })
          return
        }
        setLive((current) =>
          current
            ? {
                ...current,
                // The latest events are enough to watch; the result has them all.
                events: [...current.events, { event: update.event, at: update.at }].slice(-200),
                count: current.count + 1
              }
            : current
        )
      }),
    []
  )
  useEffect(
    () =>
      window.desktop.onConnections(({ collectionPath: path, connections }) =>
        setHeld((current) => ({ ...current, [path]: connections }))
      ),
    []
  )
  // A stream belongs to the step reading it: the next step, or none, starts with nothing.
  useEffect(() => setLive(null), [runningId])

  /** Stop reading the stream the run in flight reads: its checks run on what came. */
  const stopStream = () => {
    if (activeRunId.current) window.desktop.runStop(activeRunId.current)
  }

  const send = useCallback(async () => {
    const id = editor.selectedId
    if (!request || !id || runningId !== null || stepIndex < 0) return
    // A use step is its set's requests, and a forEach step one request per
    // item: each runs as a collection of one step.
    if (request.use !== null || request.forEach.trim() !== '') {
      return void runIndexesOf(stepList, [stepIndex], false)
    }
    if (request.reads === null ? request.url.trim() === '' : request.reads === '') return
    const runId = nextRunId()
    activeRunId.current = runId
    resultsRunId.current = runId
    setRunningId(id)
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
    setRunningId(null)
    if (response.ok) changeResults(stepList, (current) => ({ ...current, [id]: response.result }))
    else setError(response.message)
  }, [
    editor.selectedId,
    request,
    runningId,
    stepIndex,
    stepList,
    pendingStep,
    doc,
    collectionPath,
    selectedEnvironment,
    dataRow,
    dataRowToRun
  ])

  /** Run one step on its own, selecting it first so its response is visible. */
  const runStep = useCallback(
    (list: StepList, index: number) => {
      selectStep(list, index)
      // Selecting is state; the send below reads the step from the document
      // rather than the editor, so it does not have to wait for that state.
      const step = doc ? stepsOf(doc, list)[index] : undefined
      const id = open ? idsOf(open, list)[index] : undefined
      if (!step || !doc || !id) return
      if (isUseStep(step) || step.forEach) return void runIndexesOf(list, [index], false)
      const runId = nextRunId()
      activeRunId.current = runId
      resultsRunId.current = runId
      setRunningId(id)
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
          setRunningId(null)
          if (response.ok) changeResults(list, (current) => ({ ...current, [id]: response.result }))
          else setError(response.message)
        })
    },
    [open, doc, collectionPath, selectedEnvironment, selectStep, dataRow, dataRowToRun]
  )

  /**
   * Run some steps of one list in order, sharing one scope as a full run does:
   * every step for Run all, with setup and teardown around them, or one use
   * or forEach step, which runs as a collection of one step — without them.
   */
  async function runIndexesOf(list: StepList, indexes: number[], all: boolean) {
    if (!open || !doc || (indexes.length === 0 && !all)) return
    const runId = nextRunId()
    activeRunId.current = runId
    resultsRunId.current = runId
    const listIds = idsOf(open, list)
    const chosen = indexes.map((index) => listIds[index]!)
    runPlan.current = all
      ? {
          ids: { setup: open.stageIds.setup, steps: chosen, teardown: open.stageIds.teardown },
          list: 'steps'
        }
      : { ids: { setup: [], steps: chosen, teardown: [] }, list }
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
    if (all) {
      setRowResults({})
      setStageResults({})
    } else {
      // Only these steps' old results go: the rest of the list keeps its own.
      const ids = new Set(chosen)
      changeResults(list, (current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !ids.has(stepOfKey(key))))
      )
    }
    setSummary(null)
    setError(null)
    if (all) setRunningAll(true)
    const plan = runPlan.current.ids
    setRunningId(plan.setup[0] ?? plan.steps[0] ?? plan.teardown[0] ?? '')

    const steps = stepsOf(doc, list)
    const response = await window.desktop.runCollection({
      runId,
      // Only the chosen steps, in order, sharing one scope as a full run would.
      collection: all
        ? { ...doc, steps: indexes.map((index) => steps[index]!) }
        : { ...withoutStages(doc), steps: indexes.map((index) => steps[index]!) },
      collectionPath,
      environment: selectedEnvironment,
      environmentOverrides,
      ...(everyRow ? { dataRows: everyRow } : { dataRow: dataRowToRun }),
      // Steps run on their own use the connections Sends hold; Run all has its own.
      keepConnections: !all
    })

    if (activeRunId.current !== runId) return
    activeRunId.current = null
    setRunningAll(false)
    setRunningId(null)
    if (response.ok) {
      if (all) setSummary(response.summary)
    } else setError(response.message)
  }

  /** Run every step, or with a tag filter on, just the steps it shows. */
  const runAll = useCallback(async () => {
    if (!open || !doc || runningId !== null) return
    await runIndexesOf('steps', filterSteps(doc, tagFilter).indexes, true)
  }, [
    open,
    doc,
    runningId,
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

  /** Results by list and position, for the lists: they are kept by step id. */
  const resultsByIndex = useMemo(() => {
    const byList = { setup: {}, steps: {}, teardown: {} } as Record<
      StepList,
      Record<number, RunResult>
    >
    if (!open) return byList
    for (const list of STEP_LISTS) {
      idsOf(open, list).forEach((id, index) => {
        const result = results[id]
        if (result) byList[list][index] = result
      })
    }
    return byList
  }, [open, results])

  /** Request sets a use step can run: the open project's, and its global project's. */
  const sets = activeProject?.requestSets ?? NO_SETS

  /** For each use step, its set's results, one per request, in order. */
  const childResults = useMemo(() => {
    const byList = { setup: {}, steps: {}, teardown: {} } as Record<
      StepList,
      Record<number, Array<RunResult | undefined>>
    >
    if (!open || !doc) return byList
    for (const list of STEP_LISTS) {
      stepsOf(doc, list).forEach((step, index) => {
        const id = idsOf(open, list)[index]
        if (!id || !isUseStep(step)) return
        const set = resolveSet(sets, step.use)
        byList[list][index] = childResultsOf(results, id, set?.steps.length ?? 0)
      })
    }
    return byList
  }, [doc, open, results, sets])

  /** For each forEach step, its results, one per item, in order. */
  const itemResults = useMemo(() => {
    const byList = { setup: {}, steps: {}, teardown: {} } as Record<
      StepList,
      Record<number, RunResult[]>
    >
    if (!open) return byList
    for (const list of STEP_LISTS) {
      idsOf(open, list).forEach((id, index) => {
        const items = itemResultsOf(results, id)
        if (items.length > 0) byList[list][index] = items
      })
    }
    return byList
  }, [open, results])

  // Which request of a use step the panes show; back to its first on another step.
  const [shownChild, setShownChild] = useState(0)
  /** A request asked for along with its step, shown once that step is selected. */
  const askedChild = useRef<number | null>(null)
  useEffect(() => {
    setShownChild(askedChild.current ?? 0)
    askedChild.current = null
  }, [editor.selectedId])

  /**
   * The response shown beside the step list belongs to the selected step: for
   * a use step, the request of its set chosen; for a forEach step, the last item.
   */
  const selectedResult =
    (editor.selectedId &&
      (request?.use !== null && request?.use !== undefined
        ? (results[childKey(editor.selectedId, shownChild)] ?? results[editor.selectedId])
        : (itemResultsOf(results, editor.selectedId).at(-1) ?? results[editor.selectedId]))) ||
    null
  const selectedDocStep = doc ? stepsOf(doc, stepList)[stepIndex] : undefined

  /** Where the step running now is, for its list to mark it. */
  const runningAt = useMemo(() => {
    if (!open || !runningId) return null
    for (const list of STEP_LISTS) {
      const index = idsOf(open, list).indexOf(runningId)
      if (index >= 0) return { list, index }
    }
    return null
  }, [open, runningId])

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
          onRemoveWorkspace={async (id) => {
            const scratch = ws.projects.filter((project) => project.scratch)
            await ws.removeWorkspace(id)
            for (const project of scratch) editor.forgetProject(project.id)
          }}
          onAddProject={() => void ws.addProject()}
          onCreateScratchPad={ws.createScratchPad}
          scratchPadName={scratchPadName}
          collectionActions={collectionActions}
          onRenameFolder={renameFolder}
          onDropRefused={ws.showError}
          onRenameScratchPad={renameScratchPad}
          onDeleteFolder={(projectId, folder) => void deleteFolder(projectId, folder)}
          onClone={(url) => void ws.cloneUrl(url)}
          onRemoveProject={async (id) => {
            const scratch = ws.project(id)?.scratch ?? false
            const result = await ws.removeProject(id)
            // A scratch pad's files went with it: nothing of it stays open.
            if (result.ok && scratch) editor.forgetProject(id)
          }}
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
              selectedList={stepList}
              selectedIndex={stepIndex}
              results={resultsByIndex}
              runningAt={runningAt}
              busy={runningId !== null}
              runningAll={runningAll}
              summary={summary}
              draftIndexes={editor.dirtyIndexes}
              changes={sinceCommit}
              onSelect={selectStep}
              onRunStep={runStep}
              onRunAll={() => void runAll()}
              onCancel={cancel}
              onAddStep={(list) =>
                editor.addStep(
                  editor.selectedId,
                  isLibraryOf('endpoints') ? { GET: '/path/{id}' } : undefined,
                  list
                )
              }
              library={
                isLibraryOf('endpoints') ? 'endpoints' : isLibraryOf('bases') ? 'bases' : null
              }
              sets={sets}
              onAddUse={(list) => {
                const first = sets.find((set) => !set.problem) ?? sets[0]
                if (first) {
                  editor.addStep(editor.selectedId, { use: referenceFor(sets, first) }, list)
                }
              }}
              onAddRead={(list) => {
                const [first] = connectionNames(doc)
                if (first) editor.addStep(editor.selectedId, { connection: first }, list)
              }}
              connections={(collectionPath && held[collectionPath]) || NO_CONNECTIONS}
              onCloseConnection={(name) => {
                if (collectionPath) window.desktop.closeConnection(collectionPath, name)
              }}
              childResults={childResults}
              itemResults={itemResults}
              selectedChild={shownChild}
              onSelectChild={(list, index, child) => {
                if (idsOf(open, list)[index] === editor.selectedId) setShownChild(child)
                else {
                  askedChild.current = child
                  selectStep(list, index)
                }
              }}
              onRenameStep={(list, index, name) => {
                const id = idsOf(open, list)[index]
                if (id) editor.rename(id, name)
              }}
              onDuplicateStep={(list, index) => {
                const id = idsOf(open, list)[index]
                if (id) editor.duplicateStep(id)
              }}
              onDeleteStep={(list, index) => {
                const id = idsOf(open, list)[index]
                if (id) editor.removeStep(id)
              }}
              onMoveStep={(list, index, to) => {
                const id = idsOf(open, list)[index]
                if (id) editor.moveStep(id, to)
              }}
              stepTags={request?.tags ?? NO_TAGS}
              onStepTags={(tags) => editor.patch({ tags })}
              stepForEach={request?.forEach ?? ''}
              onStepForEach={(forEach) => editor.patch({ forEach })}
              stepUseTests={request?.useTests ?? false}
              onStepUseTests={(useTests) => editor.patch({ useTests })}
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
                  collection={doc}
                  onEditCollectionHeaders={() => setCollectionSettingsOpen('headers')}
                  onEditCollectionScript={setCollectionSettingsOpen}
                  bases={activeProject?.bases ?? NO_BASES}
                  onOpenBase={openLibraryFile}
                  onChange={editor.patch}
                  docs={selectedDocStep?.docs}
                  previews={shownPreviews}
                  onCopyVariable={copyVariable}
                  onPickFile={pickUpload}
                  result={selectedResult}
                  resultCaption={
                    // Setup and teardown run once, not with a row.
                    rowNames && selectedDocStep && stepList === 'steps'
                      ? iterationName(
                          stepLabel(selectedDocStep),
                          dataRow,
                          data.table ? rowLabel(data.table.rows[dataRow] ?? {}) : null
                        )
                      : null
                  }
                  error={error}
                  running={runningId !== null && runningId === editor.selectedId}
                  onSend={() => void send()}
                  onCancel={cancel}
                  live={live}
                  onStop={stopStream}
                  connectionNames={connectionNames(doc)}
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

      <BottomPanel />

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
