import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dataKindOf, toLf, type DataTable } from '@schwabyio/gravity-core/model'
import {
  gridFromText,
  gridOf,
  gridProblems,
  sameGrid,
  tableOf,
  textOf,
  type DataGrid
} from '../dataGrid.js'
import type { SaveStatus } from './useCollectionEditor.js'

/** The open collection's data file, as read and as edited. */
interface DataState {
  collectionPath: string
  /** Absolute; null when the collection has none. */
  path: string | null
  /** The file's text when last read or written: the base every write is checked against. */
  source: string
  /** The table on disk; null without a file, or when the file is not a table. */
  disk: DataGrid | null
  /** The grid as edited; null when it matches the disk. */
  draft: DataGrid | null
  /**
   * The file's text as edited in the raw editor; null when it matches the
   * disk. While set it is the edit — saved as typed — and the grid shows it read.
   */
  raw: string | null
  /** Why the file on disk is not a table, when it is not. */
  problem: string | null
  save: { state: 'idle' | 'saving' | 'failed'; message?: string }
  /** The file changed on disk while it had edits. */
  conflict: { source: string; disk: DataGrid | null } | null
}

/**
 * The open collection's data file (SPEC.md §2.8), edited as a grid and saved
 * the way collections and environments are: only against the text it was read
 * as, after the auto save delay or on Save, never while it has problems — and
 * reloaded, or put to the person, when it changes on disk.
 *
 * What a run uses is the grid as edited, saved or not, as long as it is valid.
 */
export function useDataFileEditor(
  collectionPath: string | null,
  autoSave: { enabled: boolean; delayMs: number }
) {
  const [state, setState] = useState<DataState | null>(null)
  const latest = useRef<DataState | null>(null)
  const [editVersion, setEditVersion] = useState(0)

  const commit = useCallback((next: DataState | null) => {
    latest.current = next
    setState(next)
  }, [])

  const read = useCallback(async (path: string) => {
    const result = await window.desktop.data.read(path)
    if (!result.ok) throw new Error(result.message)
    return result
  }, [])

  /** The file as read, into state: replacing the edits, or — with edits in hand — as a conflict. */
  const take = useCallback(
    async (target: string) => {
      const disk = await read(target).catch(() => null)
      const current = latest.current
      if (!disk) return
      const grid = disk.table ? gridOf(disk.table) : null
      if (current?.collectionPath === target && current.path === disk.path) {
        if (disk.source === current.source) return
        if (current.draft || current.raw !== null) {
          commit({ ...current, conflict: { source: disk.source, disk: grid } })
          return
        }
      }
      commit({
        collectionPath: target,
        path: disk.path,
        source: disk.source,
        disk: grid,
        draft: null,
        raw: null,
        problem: disk.problem,
        save: { state: 'idle' },
        conflict: null
      })
    },
    [read, commit]
  )

  useEffect(() => {
    if (!collectionPath) return void commit(null)
    void take(collectionPath)
  }, [collectionPath, take, commit])

  // A change on disk — added, edited, deleted outside the app — follows.
  useEffect(
    () =>
      window.desktop.projects.onUpdated(() => {
        const target = latest.current?.collectionPath
        if (target) void take(target)
      }),
    [take]
  )

  const fileName = state?.path ? (state.path.split(/[\\/]/).pop() ?? state.path) : null
  /** The raw edit, read: a grid, or why it is not a table. */
  const rawRead = useMemo(
    () =>
      state?.raw !== null && state?.raw !== undefined && state.path
        ? gridFromText(state.raw, fileName ?? '', dataKindOf(state.path))
        : null,
    [state?.raw, state?.path, fileName]
  )
  const grid = state ? (rawRead ? rawRead.grid : (state.draft ?? state.disk)) : null

  /**
   * The text the raw editor shows: the raw edit, the grid's edits as text, or
   * the file. A text box only has `\n`, and the tools write LF, so a file
   * checked out with CRLF is shown — and saved — with `\n`.
   */
  const rawText = state
    ? (state.raw ?? (state.draft ? textOf(state.draft, state.source) : state.source)).replace(
        /\r\n/g,
        '\n'
      )
    : ''

  const edit = useCallback(
    (change: (grid: DataGrid) => DataGrid) => {
      const current = latest.current
      if (!current?.path) return
      // A grid edit after a raw one starts from the raw text, read.
      const base =
        current.raw !== null
          ? gridFromText(current.raw, current.path, dataKindOf(current.path)).grid
          : (current.draft ?? current.disk)
      if (!base) return
      const next = change(base)
      commit({
        ...current,
        raw: null,
        draft: current.disk && sameGrid(next, current.disk) ? null : next
      })
      setEditVersion((v) => v + 1)
    },
    [commit]
  )

  /** The file's text, typed in the raw editor: saved as typed, once it reads as a table. */
  const editRaw = useCallback(
    (text: string) => {
      const current = latest.current
      if (!current?.path) return
      // Text typed back to what the file says is no edit, whatever its line ends.
      commit({ ...current, draft: null, raw: text === toLf(current.source) ? null : text })
      setEditVersion((v) => v + 1)
    },
    [commit]
  )

  const flush = useCallback(async (): Promise<boolean> => {
    const start = latest.current
    if (!start?.path || (!start.draft && start.raw === null) || start.conflict) return true
    const raw = start.raw
    // Raw text is saved as typed, once it reads as a table a run accepts.
    const typed = raw !== null ? gridFromText(raw, start.path, dataKindOf(start.path)) : null
    const draft = typed ? typed.grid : start.draft
    const table = draft ? tableOf(draft) : null
    // Anything with problems is not saved: they are shown, and the file stays as it was.
    if (!draft || !table) return false
    commit({ ...start, save: { state: 'saving' } })
    const result =
      raw !== null
        ? await window.desktop.data.applyText(start.path, start.source, raw)
        : await window.desktop.data.apply(start.path, start.source, table)
    const now = latest.current
    if (!now || now.path !== start.path) return false
    if (!result.ok) {
      commit({ ...now, save: { state: 'failed', message: result.message } })
      return false
    }
    if (result.conflict) {
      const disk = await read(start.collectionPath).catch(() => null)
      commit({
        ...now,
        save: { state: 'idle' },
        conflict: disk
          ? { source: disk.source, disk: disk.table ? gridOf(disk.table) : null }
          : null
      })
      return false
    }
    // Anything typed while the save was on its way stays a draft.
    commit({
      ...now,
      source: result.source,
      disk: draft,
      draft: raw === null && now.draft === draft ? null : now.draft,
      raw: raw !== null && now.raw === raw ? null : now.raw,
      save: { state: 'idle' }
    })
    return true
  }, [commit, read])

  useEffect(() => {
    if (!autoSave.enabled || editVersion === 0) return
    const timer = setTimeout(() => void flush(), autoSave.delayMs)
    return () => clearTimeout(timer)
  }, [editVersion, autoSave.enabled, autoSave.delayMs, flush])

  useEffect(() => {
    if (!autoSave.enabled) return
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [autoSave.enabled, flush])

  /** Take the disk version, dropping the edits. */
  const reload = useCallback(() => {
    const current = latest.current
    if (!current?.conflict) return
    commit({
      ...current,
      source: current.conflict.source,
      disk: current.conflict.disk,
      draft: null,
      raw: null,
      conflict: null,
      save: { state: 'idle' }
    })
  }, [commit])

  /** Keep the edits, on top of the disk version, and save them against it. */
  const keepMine = useCallback(() => {
    const current = latest.current
    if (!current?.conflict) return
    commit({
      ...current,
      source: current.conflict.source,
      disk: current.conflict.disk,
      conflict: null
    })
    setEditVersion((v) => v + 1)
    if (autoSave.enabled) setTimeout(() => void flush(), 0)
  }, [commit, flush, autoSave.enabled])

  const create = useCallback(
    async (column: string) => {
      const target = latest.current?.collectionPath
      if (!target) return
      const result = await window.desktop.data.create(target, column)
      if (!result.ok) throw new Error(result.message)
      await take(target)
    },
    [take]
  )

  const remove = useCallback(async () => {
    const current = latest.current
    if (!current?.path) return
    const result = await window.desktop.data.remove(current.path)
    if (!result.ok) throw new Error(result.message)
    await take(current.collectionPath)
  }, [take])

  const status: SaveStatus | null = !state?.path
    ? null
    : state.conflict
      ? { kind: 'conflict' }
      : state.save.state === 'saving'
        ? { kind: 'saving' }
        : state.save.state === 'failed'
          ? { kind: 'failed', message: state.save.message ?? '' }
          : state.draft || state.raw !== null
            ? { kind: 'unsaved', count: 1 }
            : { kind: 'saved' }

  /** The table a run uses: as edited when that is valid, else as on disk. */
  const disk = state?.disk ?? null
  const table: DataTable | null = useMemo(
    () => (grid ? (tableOf(grid) ?? (disk ? tableOf(disk) : null)) : null),
    [grid, disk]
  )
  const problems = useMemo(
    () => (rawRead?.error ? [rawRead.error] : grid ? gridProblems(grid) : []),
    [grid, rawRead]
  )

  return {
    /** Absolute path of the data file; null when the collection has none. */
    path: state?.path ?? null,
    fileName,
    grid,
    /** The file's text for the raw editor, with any edits. */
    rawText,
    /** Why the file on disk is not a table at all. */
    problem: state?.problem ?? null,
    /** Why the grid as edited cannot be saved or run. */
    problems,
    table,
    status,
    conflict: state?.conflict !== null && state?.conflict !== undefined,
    dirty: !!state?.draft || (state?.raw ?? null) !== null,
    edit,
    editRaw,
    flush,
    reload,
    keepMine,
    create,
    remove
  }
}
