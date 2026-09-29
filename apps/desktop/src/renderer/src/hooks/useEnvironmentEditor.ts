import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EnvironmentDoc,
  EnvironmentFlags,
  EnvironmentVar
} from '@schwabyio/gravity-core/model'
import type { EnvironmentEdit, EnvironmentOverride } from '@shared/ipc.js'
import type { SaveStatus } from './useCollectionEditor.js'

/** One environment file, as read and as edited. */
interface EnvFile {
  doc: EnvironmentDoc
  /** The file's text when last read or written: the base every write is checked against. */
  source: string
  /** Fields changed since; `undefined` inside means "remove it". */
  draft: Partial<Pick<EnvironmentDoc, 'name' | 'vars' | 'flags'>> | null
  save: { state: 'idle' | 'saving' | 'failed'; message?: string }
  /** The file changed on disk while it had edits. */
  conflict: { doc: EnvironmentDoc; source: string } | null
}

type Files = Record<string, EnvFile>

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/** The fields whose edited value differs from the file. */
const changes = (file: EnvFile): EnvironmentEdit[] =>
  Object.entries(file.draft ?? {})
    .filter(([key, value]) => !same(value, file.doc[key as 'name' | 'vars' | 'flags']))
    .map(([key, value]) => ({ key: key as 'name' | 'vars' | 'flags', value }))

const withDraft = (file: EnvFile): EnvironmentDoc => {
  const doc: Record<string, unknown> = { ...file.doc }
  for (const [key, value] of Object.entries(file.draft ?? {})) {
    if (value === undefined) delete doc[key]
    else doc[key] = value
  }
  return { vars: {}, ...doc } as EnvironmentDoc
}

/**
 * Environment files being edited: read on demand, saved the way collections
 * are — only against the text they were read as, automatically after the auto
 * save delay or on Save — and reloaded or put to the person when they change on
 * disk. An environment with unsaved edits is what a run uses (`overrideFor`).
 */
export function useEnvironmentEditor(autoSave: { enabled: boolean; delayMs: number }) {
  const [files, setFiles] = useState<Files>({})
  const latest = useRef<Files>({})
  const [editVersion, setEditVersion] = useState(0)

  const commit = useCallback((next: Files) => {
    latest.current = next
    setFiles(next)
  }, [])
  const update = useCallback(
    (path: string, change: (file: EnvFile) => EnvFile) => {
      const current = latest.current[path]
      if (current) commit({ ...latest.current, [path]: change(current) })
    },
    [commit]
  )

  const read = async (path: string) => {
    const result = await window.desktop.environment.read(path)
    if (!result.ok) throw new Error(result.message)
    return result
  }

  /** Read an environment, unless it is already open. */
  const open = useCallback(
    async (path: string) => {
      if (latest.current[path]) return
      const { doc, source } = await read(path)
      commit({
        ...latest.current,
        [path]: { doc, source, draft: null, save: { state: 'idle' }, conflict: null }
      })
    },
    [commit]
  )

  const edit = useCallback(
    (path: string, key: 'name' | 'vars' | 'flags', value: unknown) => {
      update(path, (file) => ({ ...file, draft: { ...file.draft, [key]: value } }))
      setEditVersion((v) => v + 1)
    },
    [update]
  )

  const pending = (file: EnvFile | undefined) => !!file && changes(file).length > 0

  const flush = useCallback(
    async (path: string): Promise<boolean> => {
      const start = latest.current[path]
      if (!start || start.conflict || !pending(start)) return true
      const draft = start.draft
      update(path, (file) => ({ ...file, save: { state: 'saving' } }))
      const result = await window.desktop.environment.applyEdits(path, start.source, changes(start))
      if (!result.ok) {
        update(path, (file) => ({ ...file, save: { state: 'failed', message: result.message } }))
        return false
      }
      if (result.conflict) {
        const disk = await read(path).catch(() => null)
        update(path, (file) => ({
          ...file,
          save: { state: 'idle' },
          conflict: disk ? { doc: disk.doc, source: disk.source } : null
        }))
        return false
      }
      update(path, (file) => {
        const doc = withDraft({ ...file, draft })
        // Anything typed while the save was on its way stays a draft.
        return {
          ...file,
          doc,
          source: result.source,
          draft: file.draft === draft ? null : file.draft,
          save: { state: 'idle' }
        }
      })
      return true
    },
    [update]
  )

  const saveAll = useCallback(async () => {
    const results = await Promise.all(Object.keys(latest.current).map((path) => flush(path)))
    return results.every(Boolean)
  }, [flush])

  useEffect(() => {
    if (!autoSave.enabled || editVersion === 0) return
    const timer = setTimeout(() => void saveAll(), autoSave.delayMs)
    return () => clearTimeout(timer)
  }, [editVersion, autoSave.enabled, autoSave.delayMs, saveAll])

  useEffect(() => {
    if (!autoSave.enabled) return
    const onBlur = () => void saveAll()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [autoSave.enabled, saveAll])

  // A change on disk: take it, or — with edits in hand — put it to the person.
  useEffect(
    () =>
      window.desktop.projects.onUpdated(async () => {
        for (const path of Object.keys(latest.current)) {
          const disk = await read(path).catch(() => null)
          const current = latest.current[path]
          if (!current) continue
          if (!disk) {
            // Deleted outside the app.
            const { [path]: _gone, ...rest } = latest.current
            commit(rest)
            continue
          }
          if (disk.source === current.source) continue
          if (pending(current)) {
            update(path, (file) => ({ ...file, conflict: { doc: disk.doc, source: disk.source } }))
          } else {
            update(path, (file) => ({ ...file, doc: disk.doc, source: disk.source, draft: null }))
          }
        }
      }),
    [commit, update]
  )

  const reload = useCallback(
    (path: string) =>
      update(path, (file) =>
        file.conflict
          ? { ...file, ...file.conflict, draft: null, conflict: null, save: { state: 'idle' } }
          : file
      ),
    [update]
  )

  /** Keep the edits, on top of the disk version, and save them against it. */
  const keepMine = useCallback(
    (path: string) => {
      update(path, (file) => (file.conflict ? { ...file, ...file.conflict, conflict: null } : file))
      setEditVersion((v) => v + 1)
      if (autoSave.enabled) setTimeout(() => void flush(path), 0)
    },
    [update, flush, autoSave.enabled]
  )

  const create = useCallback(async (collectionPath: string, name: string) => {
    const result = await window.desktop.environment.create(collectionPath, name)
    if (!result.ok) throw new Error(result.message)
    return result.path
  }, [])

  const remove = useCallback(
    async (path: string) => {
      const result = await window.desktop.environment.remove(path)
      if (!result.ok) throw new Error(result.message)
      const { [path]: _gone, ...rest } = latest.current
      commit(rest)
    },
    [commit]
  )

  const status = (path: string): SaveStatus | null => {
    const file = files[path]
    if (!file) return null
    if (file.conflict) return { kind: 'conflict' }
    if (file.save.state === 'saving') return { kind: 'saving' }
    if (file.save.state === 'failed') return { kind: 'failed', message: file.save.message ?? '' }
    const count = changes(file).length
    return count > 0 ? { kind: 'unsaved', count } : { kind: 'saved' }
  }

  return {
    open,
    /** The environment as edited, or null until it has been read. */
    docFor: (path: string): EnvironmentDoc | null => {
      const file = files[path]
      return file ? withDraft(file) : null
    },
    setName: (path: string, name: string) =>
      edit(path, 'name', name.trim() === '' ? undefined : name),
    setVars: (path: string, vars: Record<string, EnvironmentVar> | undefined) =>
      edit(path, 'vars', vars && Object.keys(vars).length > 0 ? vars : undefined),
    /** The environment's feature flag command and fixed values; empty removes `flags`. */
    setFlags: (path: string, flags: EnvironmentFlags | undefined) => {
      const command = flags?.command?.trim() ? flags.command : undefined
      const values =
        flags?.values && Object.keys(flags.values).length > 0 ? flags.values : undefined
      edit(
        path,
        'flags',
        command || values
          ? { ...(command ? { command } : {}), ...(values ? { values } : {}) }
          : undefined
      )
    },
    status,
    hasPending: (path: string) => pending(files[path]),
    anyPending: Object.values(files).some(pending),
    /** Names of the environments with edits not on disk. */
    unsavedNames: useCallback(
      () =>
        Object.entries(latest.current)
          .filter(([, file]) => pending(file))
          .map(([path, file]) => withDraft(file).name ?? path.split(/[\\/]/).pop() ?? path),
      []
    ),
    /** For a run: those of `paths` that are edited, as edited. */
    overridesFor: (paths: string[]): EnvironmentOverride[] =>
      paths.flatMap((path) => {
        const file = files[path]
        return file && pending(file) ? [{ path, doc: withDraft(file) }] : []
      }),
    flush,
    saveAll,
    reload,
    keepMine,
    create,
    remove
  }
}
