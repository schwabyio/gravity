import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangedFileView, CommitView, FileDiffView, RepoChangesView } from '@shared/ipc.js'

/** A failure to show: git's message, and what to do about it. */
export interface GitFailure {
  message: string
  hint?: string | undefined
}

/** Commit messages being written, by repository: closing the drawer does not lose one. */
const drafts = new Map<string, string>()

/**
 * One repository's changes, for the Changes drawer: loaded when it opens, and
 * again whenever the repository moves — main pushes a project update after
 * every git operation and file change — and when the window regains focus,
 * since a file outside the projects' folders changes without a watcher seeing.
 */
export function useRepoChanges(projectId: string, repoRoot: string | null) {
  const [changes, setChanges] = useState<RepoChangesView | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  /** Only what the person ticked or unticked; the rest follows each file's default. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<FileDiffView | null>(null)
  const [message, setMessageState] = useState(() => (repoRoot ? (drafts.get(repoRoot) ?? '') : ''))
  const [history, setHistory] = useState<{ commits: CommitView[]; hasMore: boolean } | null>(null)
  const live = useRef(true)

  const load = useCallback(async () => {
    const result = await window.desktop.git.changes(projectId)
    if (!live.current) return
    if (result.ok) setChanges(result.changes)
    else setFailure({ message: result.message, hint: result.hint })
  }, [projectId])

  const loadHistory = useCallback(
    async (more = false) => {
      const skip = more ? (history?.commits.length ?? 0) : 0
      const result = await window.desktop.git.log(projectId, skip)
      if (!live.current) return
      if (!result.ok) {
        setFailure({ message: result.message, hint: result.hint })
        return
      }
      setHistory((current) => ({
        commits: more && current ? [...current.commits, ...result.commits] : result.commits,
        hasMore: result.hasMore
      }))
    },
    [projectId, history]
  )

  useEffect(() => {
    live.current = true
    void load()
    return () => {
      live.current = false
    }
  }, [load])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 150)
    }
    const off = window.desktop.projects.onUpdated((project) => {
      if (repoRoot && project.repoRoot === repoRoot) later()
    })
    window.addEventListener('focus', later)
    return () => {
      off()
      window.removeEventListener('focus', later)
      clearTimeout(timer)
    }
  }, [load, repoRoot])

  // The selected file's diff follows the file, and goes when the file does.
  const selectedFile = changes?.files.find((file) => file.path === selected) ?? null
  useEffect(() => {
    if (!selectedFile) {
      setDiff(null)
      return
    }
    let current = true
    // A file committed or discarded while its diff was being read has none:
    // nothing to report, the next reload drops it from the list.
    void window.desktop.git.diff(projectId, selectedFile.path).then((result) => {
      if (current) setDiff(result.ok ? result.diff : null)
    })
    return () => {
      current = false
    }
    // A reload that leaves the file changed may still have changed its content.
  }, [projectId, selectedFile?.path, selectedFile?.kind, changes])

  const isChecked = useCallback(
    (file: ChangedFileView) => toggled.get(file.path) ?? file.checkedByDefault,
    [toggled]
  )

  const setChecked = useCallback((paths: string[], checked: boolean) => {
    setToggled((current) => {
      const next = new Map(current)
      for (const path of paths) next.set(path, checked)
      return next
    })
  }, [])

  const setMessage = useCallback(
    (text: string) => {
      setMessageState(text)
      if (repoRoot) drafts.set(repoRoot, text)
    },
    [repoRoot]
  )

  /** Forget ticks for files that are no longer changed, once committed or discarded. */
  const settle = useCallback((paths: string[]) => {
    setToggled((current) => {
      const next = new Map(current)
      for (const path of paths) next.delete(path)
      return next
    })
  }, [])

  return {
    changes,
    failure,
    setFailure,
    load,
    isChecked,
    setChecked,
    settle,
    selected,
    select: setSelected,
    diff,
    message,
    setMessage,
    history,
    loadHistory
  }
}
