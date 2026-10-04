import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  STEP_LISTS,
  type Collection,
  type Headers,
  type Settings,
  type Vars,
  type CollectionSummary,
  type EnvironmentRef,
  type Stage,
  type Step,
  type StepList
} from '@schwabyio/gravity-core/model'
import type { CollectionEdit, CollectionField, ProjectView } from '@shared/ipc.js'
import { fromStep, mergeIntoStep, type EditorState } from '../requestState.js'

/**
 * Editing collections and getting the edits onto disk.
 *
 * Every collection the app has open for editing is a session: the document as
 * last read or written, the exact text it came from (the base every write is
 * checked against), a stable id per step, and the edits not yet on disk keyed by
 * those ids — so reordering or inserting steps never attaches an edit to the
 * wrong one.
 *
 * Writing is `flush`: every edited step of a file in one `applyEdits` call that
 * only succeeds if the file still reads what the edits were made against.
 * Auto save is just `flush` on a quiet timer; Cmd+S and the Save button are the
 * same call now.
 */

export interface Session {
  summary: CollectionSummary
  /** The project it belongs to. */
  projectId: string
  /** The document as last read or written. */
  doc: Collection
  /** The file's text at that moment: the base every write is checked against. */
  source: string
  environments: EnvironmentRef[]
  environmentsPath: string | null
  /** A stable id per step, parallel to `doc.steps`. */
  ids: string[]
  /** The same for `doc.setup` and `doc.teardown` (SPEC.md §2.10). */
  stageIds: Record<Stage, string[]>
  /** Editor state per step id, for steps touched since they were last saved. */
  drafts: Record<string, EditorState>
  /** Collection-level fields edited since they were last saved. */
  collectionDraft: CollectionDraft | null
  /** The file changed on disk while this session had edits. */
  conflict: { doc: Collection; source: string } | null
  save: { state: 'idle' | 'saving' | 'failed'; message?: string }
}

/** Collection-level fields the editor changes; `undefined` means "remove it". */
export type { CollectionField }
export type CollectionDraft = Partial<Pick<Collection, CollectionField>>

export type SaveStatus =
  | { kind: 'saved' }
  | { kind: 'unsaved'; count: number }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict' }

/** Collection-level fields whose edited value differs from what is on disk. */
const collectionChanges = (session: Session): Array<[CollectionField, unknown]> =>
  Object.entries(session.collectionDraft ?? {})
    .filter(([key, value]) => !same(value, session.doc[key as CollectionField]))
    .map(([key, value]) => [key as CollectionField, value])

const collectionDirty = (session: Session): boolean => collectionChanges(session).length > 0

/** Apply collection-level values to a document; `undefined` removes the key. */
function withCollectionFields(doc: Collection, fields: CollectionDraft): Collection {
  const next: Record<string, unknown> = { ...doc }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as Collection
}

/** An empty list or object is written as no key at all. */
const emptyToUndefined = <T>(value: T): T | undefined =>
  (Array.isArray(value) && value.length === 0) ||
  (value !== null && typeof value === 'object' && Object.keys(value).length === 0)
    ? undefined
    : value

let idCounter = 0
const newId = () => `step-${++idCounter}`
const freshIds = (count: number) => Array.from({ length: count }, newId)

/** A collection's steps in one of its lists: `steps`, or `setup` or `teardown`. */
export const stepsOf = (doc: Collection, list: StepList): Step[] =>
  list === 'steps' ? doc.steps : (doc[list] ?? [])

/** A session's step ids for one list, parallel to `stepsOf` its document. */
export const idsOf = (session: Session, list: StepList): string[] =>
  list === 'steps' ? session.ids : session.stageIds[list]

/** Setup and teardown ids for a document: the ones given while each list keeps its length. */
const stageIdsFor = (doc: Collection, keep?: Record<Stage, string[]>): Record<Stage, string[]> => ({
  setup:
    keep && keep.setup.length === (doc.setup?.length ?? 0)
      ? keep.setup
      : freshIds(doc.setup?.length ?? 0),
  teardown:
    keep && keep.teardown.length === (doc.teardown?.length ?? 0)
      ? keep.teardown
      : freshIds(doc.teardown?.length ?? 0)
})

/** Whether a document's lists are as long as a session's ids, so the ids still fit. */
const sameShape = (session: Session, doc: Collection): boolean =>
  STEP_LISTS.every((list) => idsOf(session, list).length === stepsOf(doc, list).length)

/** Where a step id is: its list, its place there, and the step as on disk. */
export function locate(
  session: Session,
  id: string
): { list: StepList; index: number; step: Step } | null {
  for (const list of STEP_LISTS) {
    const index = idsOf(session, list).indexOf(id)
    const step = index >= 0 ? stepsOf(session.doc, list)[index] : undefined
    if (step) return { list, index, step }
  }
  return null
}

/** A step edit's `list`, written only when it is not `steps`. */
const listOf = (list: StepList) => (list === 'steps' ? {} : { list })
/**
 * Structural equality that ignores key order: re-merging an edit moves the
 * method key, and that alone must not count as a change.
 */
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted((value as Record<string, unknown>)[key])])
        )
      : value

export function useCollectionEditor({
  autoSave
}: {
  autoSave: { enabled: boolean; delayMs: number }
}) {
  const [sessions, setSessions] = useState<Record<string, Session>>({})
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Bumped by every edit, so auto save can wait for a quiet moment. */
  const [editVersion, setEditVersion] = useState(0)

  /**
   * The sessions as of now. Async work (saves, disk events) reads and writes
   * through this rather than a render's snapshot, and `commit` keeps React's
   * copy in step — so code awaiting a save sees its result immediately.
   */
  const latest = useRef(sessions)
  const commit = useCallback((next: Record<string, Session>) => {
    latest.current = next
    setSessions(next)
  }, [])
  /** Editor state derived from a step, cached so it keeps its row ids. */
  const baselines = useRef(new Map<string, { step: Step; state: EditorState }>())

  const update = useCallback(
    (path: string, change: (session: Session) => Session) => {
      const session = latest.current[path]
      if (session) commit({ ...latest.current, [path]: change(session) })
    },
    [commit]
  )

  const baselineFor = useCallback((id: string, step: Step): EditorState => {
    const cached = baselines.current.get(id)
    if (cached && cached.step === step) return cached.state
    const state = fromStep(step)
    baselines.current.set(id, { step, state })
    return state
  }, [])

  /** Whether this step's editor state differs from what is on disk. */
  const isDirty = useCallback((session: Session, id: string): boolean => {
    const draft = session.drafts[id]
    const step = locate(session, id)?.step
    return !!draft && !!step && !same(mergeIntoStep(step, draft), step)
  }, [])

  const dirtyIds = useCallback(
    (session: Session) => Object.keys(session.drafts).filter((id) => isDirty(session, id)),
    [isDirty]
  )

  /** Edits not on disk: dirty steps, plus the collection's own fields as one. */
  const pendingCount = useCallback(
    (session: Session) => dirtyIds(session).length + (collectionDirty(session) ? 1 : 0),
    [dirtyIds]
  )

  /* ------------------------------------------------------------ opening -- */

  const load = useCallback(async (path: string) => {
    const read = await window.desktop.collection.read(path)
    if (!read.ok) throw new Error(read.message)
    return read
  }, [])

  const session = openPath ? (sessions[openPath] ?? null) : null

  // Select the first step once a session is on screen with nothing selected.
  useEffect(() => {
    if (!session) return
    if (selectedId && locate(session, selectedId)) return
    setSelectedId(
      session.ids[0] ?? session.stageIds.setup[0] ?? session.stageIds.teardown[0] ?? null
    )
  }, [session, selectedId])

  /* ------------------------------------------------------------ editing -- */

  const selected = session && selectedId ? locate(session, selectedId) : null
  /** The selected step's list, and its place in that list. */
  const selectedList: StepList = selected?.list ?? 'steps'
  const selectedIndex = selected?.index ?? -1
  const selectedStep = selected?.step

  const request: EditorState | null = useMemo(() => {
    if (!session || !selectedId || !selectedStep) return null
    return session.drafts[selectedId] ?? baselineFor(selectedId, selectedStep)
  }, [session, selectedId, selectedStep, baselineFor])

  /** Change the selected step's editor state. */
  const patch = useCallback(
    (changes: Partial<EditorState>) => {
      if (!openPath || !selectedId) return
      update(openPath, (current) => {
        const step = locate(current, selectedId)?.step
        if (!step) return current
        const base = current.drafts[selectedId] ?? baselineFor(selectedId, step)
        return { ...current, drafts: { ...current.drafts, [selectedId]: { ...base, ...changes } } }
      })
      setEditVersion((v) => v + 1)
    },
    [openPath, selectedId, update, baselineFor]
  )

  /** Rename any step, selected or not. */
  const rename = useCallback(
    (id: string, name: string) => {
      if (!openPath) return
      update(openPath, (current) => {
        const step = locate(current, id)?.step
        if (!step) return current
        const base = current.drafts[id] ?? baselineFor(id, step)
        return { ...current, drafts: { ...current.drafts, [id]: { ...base, name } } }
      })
      setEditVersion((v) => v + 1)
    },
    [openPath, update, baselineFor]
  )

  /** The document as it will be once saved: what the list and a run should show. */
  const displayDoc: Collection | null = useMemo(() => {
    if (!session) return null
    const merged = (list: StepList) =>
      stepsOf(session.doc, list).map((step, index) => {
        const draft = session.drafts[idsOf(session, list)[index]!]
        return draft ? mergeIntoStep(step, draft) : step
      })
    return withCollectionFields(
      {
        ...session.doc,
        steps: merged('steps'),
        ...(session.doc.setup ? { setup: merged('setup') } : {}),
        ...(session.doc.teardown ? { teardown: merged('teardown') } : {})
      },
      session.collectionDraft ?? {}
    )
  }, [session])

  /** Change a collection-level field. An empty list or object removes it. */
  const setCollectionField = useCallback(
    <K extends CollectionField>(key: K, value: Collection[K], keepEmpty = false) => {
      if (!openPath) return
      update(openPath, (current) => ({
        ...current,
        collectionDraft: {
          ...current.collectionDraft,
          [key]: keepEmpty ? value : emptyToUndefined(value)
        }
      }))
      setEditVersion((v) => v + 1)
    },
    [openPath, update]
  )

  /**
   * Allow or stop allowing step tags. Stopping removes every step's tags in the
   * same save, so the file never holds tags nothing will use.
   */
  const setStepTagsEnabled = useCallback(
    (enabled: boolean) => {
      if (!openPath) return
      update(openPath, (current) => {
        const drafts = { ...current.drafts }
        if (!enabled) {
          current.doc.steps.forEach((step, index) => {
            const id = current.ids[index]!
            const base = drafts[id] ?? baselineFor(id, step)
            if (base.tags.length > 0) drafts[id] = { ...base, tags: [] }
          })
        }
        return {
          ...current,
          drafts,
          collectionDraft: { ...current.collectionDraft, stepTags: enabled ? true : undefined }
        }
      })
      setEditVersion((v) => v + 1)
    },
    [openPath, update, baselineFor]
  )

  /* ------------------------------------------------------------- saving -- */

  const inFlight = useRef(new Map<string, Promise<boolean>>())

  /**
   * Write every edited step of one file. Resolves true when the file ends up
   * with nothing unsaved.
   */
  const flush = useCallback(
    async (path: string, extra: CollectionEdit[] = []): Promise<boolean> => {
      // One flush per file at a time; a second waits and then saves what is left.
      const running = inFlight.current.get(path)
      if (running) await running

      const attempt = (async () => {
        const start = latest.current[path]
        if (!start || start.conflict) return !start
        const ids = dirtyIds(start)
        const collectionSnapshot = start.collectionDraft
        const fieldChanges = collectionChanges(start)
        if (ids.length === 0 && extra.length === 0 && fieldChanges.length === 0) return true

        const snapshot = Object.fromEntries(ids.map((id) => [id, start.drafts[id]!]))
        const merged = ids.map((id) => {
          const { list, index, step } = locate(start, id)!
          return { id, list, index, step: mergeIntoStep(step, snapshot[id]!) }
        })
        const edits: CollectionEdit[] = [
          // Every edit is checked as it is applied, so order matters: allowing step
          // tags must come before a step gains one, and removing them from the
          // steps must come before the collection stops allowing them.
          ...fieldChanges
            .filter(([key, value]) => key === 'stepTags' && value === true)
            .map(([key, value]) => ({ type: 'editCollection' as const, key, value })),
          ...merged.map(({ list, index, step }) => ({
            type: 'editStep' as const,
            index,
            step,
            ...listOf(list)
          })),
          ...fieldChanges
            .filter(([key, value]) => !(key === 'stepTags' && value === true))
            .map(([key, value]) => ({ type: 'editCollection' as const, key, value })),
          ...extra
        ]

        update(path, (current) => ({ ...current, save: { state: 'saving' } }))
        const result = await window.desktop.collection.applyEdits(path, start.source, edits)

        if (!result.ok) {
          update(path, (current) => ({
            ...current,
            save: { state: 'failed', message: result.message }
          }))
          return false
        }
        if (result.conflict) {
          const read = await load(path).catch(() => null)
          update(path, (current) => ({
            ...current,
            conflict: read ? { doc: read.doc, source: read.source } : current.conflict,
            save: { state: 'idle' }
          }))
          return false
        }

        update(path, (current) => {
          const lists = {
            setup: current.doc.setup ? [...current.doc.setup] : undefined,
            steps: [...current.doc.steps],
            teardown: current.doc.teardown ? [...current.doc.teardown] : undefined
          }
          const drafts = { ...current.drafts }
          for (const { id, list, index, step } of merged) {
            const steps = lists[list]
            if (steps) steps[index] = step
            // The saved state becomes the baseline, keeping the editor's row ids
            // stable while someone is still typing in it.
            baselines.current.set(id, { step, state: snapshot[id]! })
            if (drafts[id] === snapshot[id]) delete drafts[id]
          }
          const doc = withCollectionFields(
            {
              ...current.doc,
              steps: lists.steps,
              ...(lists.setup ? { setup: lists.setup } : {}),
              ...(lists.teardown ? { teardown: lists.teardown } : {})
            },
            Object.fromEntries(fieldChanges) as CollectionDraft
          )
          return {
            ...current,
            doc,
            source: result.source,
            drafts,
            collectionDraft:
              current.collectionDraft === collectionSnapshot ? null : current.collectionDraft,
            save: { state: 'idle' }
          }
        })
        return pendingCount(latest.current[path]!) === 0
      })()

      inFlight.current.set(path, attempt)
      try {
        return await attempt
      } finally {
        if (inFlight.current.get(path) === attempt) inFlight.current.delete(path)
      }
    },
    [dirtyIds, pendingCount, update, load]
  )

  /** Save every file with edits. */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const paths = Object.keys(latest.current)
    const results = await Promise.all(paths.map((path) => flush(path)))
    return results.every(Boolean)
  }, [flush])

  // Auto save: a quiet timer, restarted by every edit.
  useEffect(() => {
    if (!autoSave.enabled || editVersion === 0) return
    const timer = setTimeout(() => void saveAll(), autoSave.delayMs)
    return () => clearTimeout(timer)
  }, [editVersion, autoSave.enabled, autoSave.delayMs, saveAll])

  // And straight away when the window loses focus: the person is going elsewhere.
  useEffect(() => {
    if (!autoSave.enabled) return
    const onBlur = () => void saveAll()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [autoSave.enabled, saveAll])

  /** Collection names with edits that are not on disk. */
  const unsavedNames = useCallback(
    () =>
      Object.values(latest.current)
        .filter((s) => pendingCount(s) > 0 || s.conflict !== null)
        .map((s) => s.summary.name),
    [pendingCount]
  )

  const openCollection = useCallback(
    async (project: ProjectView, summary: CollectionSummary) => {
      // Leaving a collection is a natural moment to save it.
      if (openPath && openPath !== summary.path && autoSave.enabled) void flush(openPath)

      const path = summary.path
      const existing = latest.current[path]
      const read = await load(path)
      const fresh = (): Session => ({
        summary,
        projectId: project.id,
        doc: read.doc,
        source: read.source,
        environments: read.environments,
        environmentsPath: read.environmentsPath,
        ids: freshIds(read.doc.steps.length),
        stageIds: stageIdsFor(read.doc),
        drafts: {},
        collectionDraft: null,
        conflict: null,
        save: { state: 'idle' }
      })

      if (!existing) {
        commit({ ...latest.current, [path]: fresh() })
      } else if (read.source === existing.source) {
        // Coming back to a collection: keep its edits and its ids.
        update(path, (s) => ({
          ...s,
          summary,
          environments: read.environments,
          environmentsPath: read.environmentsPath
        }))
      } else if (pendingCount(existing) > 0) {
        // Changed on disk while it held edits: put that to the person.
        update(path, (s) => ({ ...s, summary, conflict: { doc: read.doc, source: read.source } }))
      } else {
        commit({ ...latest.current, [path]: fresh() })
      }
      setOpenPath(path)
    },
    [openPath, autoSave.enabled, flush, load, update, pendingCount, commit]
  )

  /**
   * Stop showing the open file. Its edits are kept, as when another file is
   * opened, so reopening it brings them back — and with auto save on, leaving
   * it saves it, as leaving for another does.
   */
  const close = useCallback(() => {
    if (openPath && autoSave.enabled) void flush(openPath)
    setOpenPath(null)
  }, [openPath, autoSave.enabled, flush])

  /**
   * Let go of a file the editor had open: renamed, moved or deleted. What it
   * held goes with it; a rename or move is saved first by whoever asked.
   */
  const forget = useCallback(
    (path: string) => {
      const { [path]: _gone, ...rest } = latest.current
      commit(rest)
      setOpenPath((current) => (current === path ? null : current))
    },
    [commit]
  )

  /** Let go of every file of a project whose files are gone: a scratch pad deleted. */
  const forgetProject = useCallback(
    (projectId: string) => {
      const kept = Object.entries(latest.current).filter(([, s]) => s.projectId !== projectId)
      commit(Object.fromEntries(kept))
      setOpenPath((current) =>
        current && kept.some(([path]) => path === current) ? current : null
      )
    },
    [commit]
  )

  /* --------------------------------------------------- step structure -- */

  /**
   * Add, duplicate, delete or move a step: written at once, with the file's
   * other pending edits, and re-read so the document matches disk exactly.
   * `nextIds` gives the ids of the list the edit is to.
   */
  const structural = useCallback(
    async (
      edit: CollectionEdit | CollectionEdit[],
      list: StepList,
      nextIds: (ids: string[]) => string[],
      select?: string
    ) => {
      if (!openPath) return false
      const before = latest.current[openPath]?.source
      const ok = await flush(openPath, Array.isArray(edit) ? edit : [edit])
      // The batch is written whole or not at all; an unchanged base means not.
      if (latest.current[openPath]?.source === before) return false
      const read = await load(openPath).catch(() => null)
      if (!read) return false
      update(openPath, (current) => {
        const ids = nextIds(idsOf(current, list))
        return {
          ...current,
          doc: read.doc,
          source: read.source,
          ...(list === 'steps' ? { ids } : { stageIds: { ...current.stageIds, [list]: ids } })
        }
      })
      if (select) setSelectedId(select)
      return ok
    },
    [openPath, flush, load, update]
  )

  /**
   * Add a step to a list — after `afterId` when that step is in it, else at
   * its end: a new request, or `template`.
   */
  const addStep = useCallback(
    (
      afterId: string | null,
      template: Step = { name: 'New step', GET: '' },
      list: StepList = 'steps'
    ) => {
      if (!session) return
      const after = afterId ? locate(session, afterId) : null
      const at = after && after.list === list ? after.index + 1 : idsOf(session, list).length
      const id = newId()
      void structural(
        { type: 'insertStep', index: at, step: template, ...listOf(list) },
        list,
        (ids) => [...ids.slice(0, at), id, ...ids.slice(at)],
        id
      )
      return id
    },
    [session, structural]
  )

  const duplicateStep = useCallback(
    (id: string) => {
      if (!session || !displayDoc) return
      const found = locate(session, id)
      if (!found) return
      const { list, index } = found
      const step = stepsOf(displayDoc, list)[index]
      if (!step) return
      const copy = newId()
      void structural(
        {
          type: 'insertStep',
          index: index + 1,
          step: { ...step, name: `${step.name ?? 'Step'} copy` },
          ...listOf(list)
        },
        list,
        (ids) => [...ids.slice(0, index + 1), copy, ...ids.slice(index + 1)],
        copy
      )
    },
    [session, displayDoc, structural]
  )

  const removeStep = useCallback(
    (id: string) => {
      if (!session) return
      const found = locate(session, id)
      if (!found) return
      const { list, index } = found
      // Its unsaved edit goes with it, rather than being written first.
      update(session.summary.path, (current) => {
        const drafts = { ...current.drafts }
        delete drafts[id]
        return { ...current, drafts }
      })
      const ids = idsOf(session, list)
      const neighbour = ids[index + 1] ?? ids[index - 1] ?? session.ids[0] ?? undefined
      void structural(
        { type: 'removeStep', index, ...listOf(list) },
        list,
        (current) => current.filter((candidate) => candidate !== id),
        neighbour
      )
    },
    [session, structural, update]
  )

  /**
   * Remove several steps of one list in a single write, the last first so
   * each edit's index is still the step's. Their unsaved edits go with them.
   * The selected step stays selected; one removed gives way to the step after
   * the last of them, or before the first.
   */
  const removeSteps = useCallback(
    (ids: string[]) => {
      if (!session || ids.length === 0) return
      const found = ids
        .map((id) => ({ id, at: locate(session, id) }))
        .filter((entry): entry is { id: string; at: NonNullable<typeof entry.at> } => !!entry.at)
      const list = found[0]?.at.list
      if (!list) return
      const removing = found.filter((entry) => entry.at.list === list)
      const gone = new Set(removing.map((entry) => entry.id))
      update(session.summary.path, (current) => {
        const drafts = { ...current.drafts }
        for (const id of gone) delete drafts[id]
        return { ...current, drafts }
      })
      const listed = idsOf(session, list)
      const indexes = removing.map((entry) => entry.at.index).sort((a, b) => b - a)
      const last = indexes[0]!
      const first = indexes[indexes.length - 1]!
      const neighbour =
        listed.slice(last + 1).find((id) => !gone.has(id)) ??
        listed
          .slice(0, first)
          .reverse()
          .find((id) => !gone.has(id)) ??
        session.ids.find((id) => !gone.has(id))
      void structural(
        indexes.map((index) => ({ type: 'removeStep' as const, index, ...listOf(list) })),
        list,
        (current) => current.filter((candidate) => !gone.has(candidate)),
        selectedId !== null && !gone.has(selectedId) ? selectedId : neighbour
      )
    },
    [session, structural, update, selectedId]
  )

  /** Move a step to another place in its own list. */
  const moveStep = useCallback(
    (id: string, to: number) => {
      if (!session) return
      const found = locate(session, id)
      if (!found || found.index === to) return
      const { list, index: from } = found
      void structural({ type: 'moveStep', from, to, ...listOf(list) }, list, (ids) => {
        const next = ids.filter((candidate) => candidate !== id)
        next.splice(to, 0, id)
        return next
      })
    },
    [session, structural]
  )

  /* ------------------------------------------------- changes on disk -- */

  useEffect(() => {
    if (!session) return
    const path = session.summary.path
    return window.desktop.projects.onUpdated(async (project) => {
      if (project.id !== session.projectId) return
      // A save in progress changes the base; judge the disk against its result.
      await inFlight.current.get(path)?.catch(() => undefined)
      const read = await load(path).catch(() => null)
      const current = latest.current[path]
      if (!read || !current) return
      // Our own write coming back through the watcher: the base already says so.
      // The environments beside it may still have changed.
      if (read.source === current.source) {
        if (JSON.stringify(read.environments) !== JSON.stringify(current.environments)) {
          update(path, (s) => ({
            ...s,
            environments: read.environments,
            environmentsPath: read.environmentsPath
          }))
        }
        return
      }

      if (pendingCount(current) > 0) {
        update(path, (s) => ({ ...s, conflict: { doc: read.doc, source: read.source } }))
      } else {
        update(path, (s) => ({
          ...s,
          doc: read.doc,
          source: read.source,
          ids: s.ids.length === read.doc.steps.length ? s.ids : freshIds(read.doc.steps.length),
          stageIds: stageIdsFor(read.doc, s.stageIds),
          drafts: {},
          environments: read.environments,
          environmentsPath: read.environmentsPath
        }))
      }
    })
  }, [session?.summary.path, session?.projectId, load, pendingCount, update])

  /** Drop the edits and take the file as it is on disk. */
  const reloadFromDisk = useCallback(() => {
    if (!openPath) return
    update(openPath, (s) =>
      s.conflict
        ? {
            ...s,
            doc: s.conflict.doc,
            source: s.conflict.source,
            ids:
              s.ids.length === s.conflict.doc.steps.length
                ? s.ids
                : freshIds(s.conflict.doc.steps.length),
            stageIds: stageIdsFor(s.conflict.doc, s.stageIds),
            drafts: {},
            collectionDraft: null,
            conflict: null
          }
        : s
    )
  }, [openPath, update])

  /**
   * Keep the edits, applied on top of the disk version. Edits are per key, so a
   * field changed only on disk survives; then it is saved against the new base.
   */
  const keepMine = useCallback(() => {
    if (!openPath) return
    update(openPath, (s) => {
      if (!s.conflict) return s
      const fits = sameShape(s, s.conflict.doc)
      return {
        ...s,
        doc: s.conflict.doc,
        source: s.conflict.source,
        ids: fits ? s.ids : freshIds(s.conflict.doc.steps.length),
        stageIds: fits ? s.stageIds : stageIdsFor(s.conflict.doc),
        drafts: fits ? s.drafts : {},
        conflict: null
      }
    })
    setEditVersion((v) => v + 1)
    if (!autoSave.enabled) return
    setTimeout(() => void saveAll(), 0)
  }, [openPath, update, autoSave.enabled, saveAll])

  /* ------------------------------------------------------------- status -- */

  const status: SaveStatus | null = useMemo(() => {
    if (!session) return null
    if (session.conflict) return { kind: 'conflict' }
    if (session.save.state === 'saving') return { kind: 'saving' }
    if (session.save.state === 'failed')
      return { kind: 'failed', message: session.save.message ?? 'Save failed' }
    const count = pendingCount(session)
    return count > 0 ? { kind: 'unsaved', count } : { kind: 'saved' }
  }, [session, pendingCount])

  /** Places with unsaved edits, per list. */
  const dirtyIndexes = useMemo(() => {
    const indexes: Record<StepList, Set<number>> = {
      setup: new Set(),
      steps: new Set(),
      teardown: new Set()
    }
    if (!session) return indexes
    for (const id of dirtyIds(session)) {
      const found = locate(session, id)
      if (found) indexes[found.list].add(found.index)
    }
    return indexes
  }, [session, dirtyIds])

  return {
    session,
    displayDoc,
    selectedId,
    selectedList,
    selectedIndex,
    select: (id: string) => setSelectedId(id),
    request,
    patch,
    rename,
    setCollectionTags: (tags: string[]) => setCollectionField('tags', tags),
    setCollectionDocs: (docs: string) =>
      setCollectionField('docs', docs.trim() === '' ? undefined : docs),
    setCollectionHeaders: (headers: Headers | undefined) =>
      setCollectionField('headers', headers ?? {}),
    setCollectionSettings: (settings: Settings) => setCollectionField('settings', settings),
    setCollectionVars: (vars: Vars | undefined) => setCollectionField('vars', vars ?? {}),
    /** The collection's pre-request script; empty removes `before` altogether. */
    setCollectionPreRequest: (script: string) =>
      setCollectionField('before', script.trim() === '' ? undefined : { script }),
    setCollectionTests: (tests: string) =>
      setCollectionField('tests', tests.trim() === '' ? undefined : tests),
    /**
     * A request set's params. `{}` is kept — a set that takes nothing is still
     * a set — and only `undefined` makes it a plain collection again.
     */
    setCollectionParams: (params: Collection['params']) =>
      setCollectionField('params', params, true),
    setCollectionExtends: (base: string | undefined) => setCollectionField('extends', base),
    /** Write the id the file must have: its name (SPEC.md §2). Main refuses any other. */
    setCollectionId: (id: string) => setCollectionField('id', id),
    /** Leave the collection out of group runs; off removes the key rather than writing false. */
    /** Feature flags the whole collection needs (SPEC.md §2.9); none removes `flags`. */
    setCollectionFlags: (flags: Collection['flags']) => setCollectionField('flags', flags ?? {}),
    setCollectionExcluded: (excluded: boolean) =>
      setCollectionField('exclude', excluded ? true : undefined),
    setStepTagsEnabled,
    addStep,
    duplicateStep,
    removeStep,
    removeSteps,
    moveStep,
    openCollection,
    close,
    forget,
    forgetProject,
    saveAll,
    flush,
    unsavedNames,
    reloadFromDisk,
    keepMine,
    status,
    dirtyIndexes,
    pendingStep: session && selectedStep && request ? mergeIntoStep(selectedStep, request) : null
  }
}
