import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitProgress, LibraryKind, ProjectView, WorkspacesState } from '@shared/ipc.js'
import { diverged, rebaseQuestion } from '../gitActions.js'

const EMPTY: WorkspacesState = { activeWorkspaceId: null, workspaces: [], projects: [] }

/**
 * Workspaces and their projects, kept current by main.
 *
 * Main owns the filesystem and pushes a new view whenever a watcher fires, a
 * fetch finishes or a project is added, so nothing here polls.
 */
export function useProjects() {
  const [state, setState] = useState<WorkspacesState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cloning, setCloning] = useState<GitProgress | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => window.desktop.git.onProgress((progress) => setCloning(progress.done ? null : progress)),
    []
  )
  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  useEffect(() => {
    let live = true
    void window.desktop.workspaces.list().then((next) => {
      if (live) setState(next)
    })
    const offState = window.desktop.workspaces.onChanged(setState)
    const offProject = window.desktop.projects.onUpdated((project) =>
      setState((current) => ({
        ...current,
        projects: current.projects.some((item) => item.id === project.id)
          ? current.projects.map((item) => (item.id === project.id ? project : item))
          : [...current.projects, project]
      }))
    )
    return () => {
      live = false
      offState()
      offProject()
    }
  }, [])

  const active = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)
  /** The active workspace's projects, in the order they were added. */
  const projects = useMemo(
    () =>
      (active?.projectIds ?? []).flatMap((id) => {
        const project = state.projects.find((candidate) => candidate.id === id)
        return project ? [project] : []
      }),
    [active, state.projects]
  )

  /** git's message, and on a line of its own what to do about it. */
  const fail = (message: string, hint?: string) => {
    setNotice(null)
    setError(hint ? `${message}\n${hint}` : message)
  }
  /** A brief word on what a git action did; it fades. */
  const tell = (message: string) => {
    setNotice(message)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  const addProject = useCallback(async () => {
    setError(null)
    if (!state.activeWorkspaceId) return
    const folder = await window.desktop.projects.pick()
    if (!folder) return
    let result = await window.desktop.projects.add(state.activeWorkspaceId, folder)
    if (!result.ok && result.noCollections) {
      if (!window.confirm(`${result.message} Create one and add it as a project?`)) return
      result = await window.desktop.projects.add(state.activeWorkspaceId, folder, {
        createCollections: true
      })
    }
    if (!result.ok) fail(result.message)
  }, [state.activeWorkspaceId])

  const cloneUrl = useCallback(
    async (url: string) => {
      setError(null)
      if (!state.activeWorkspaceId) return
      const parentDir = await window.desktop.projects.pick()
      if (!parentDir) return
      const result = await window.desktop.projects.clone(state.activeWorkspaceId, url, parentDir)
      if (!result.ok) fail(result.message, result.hint)
    },
    [state.activeWorkspaceId]
  )

  const run = async <T extends { ok: boolean }>(call: Promise<T>) => {
    setError(null)
    const result = await call
    if (!result.ok) {
      const failure = result as unknown as { message: string; hint?: string }
      fail(failure.message, failure.hint)
    } else if ('message' in result && typeof result.message === 'string') {
      tell(result.message)
    }
    return result
  }

  const pull = (id: string) => {
    const git = state.projects.find((project) => project.id === id)?.git
    if (git && diverged(git) && !window.confirm(rebaseQuestion(git))) return
    void run(window.desktop.git.pull(id))
  }

  return {
    state,
    active,
    projects,
    /** Any project of any workspace, by id. */
    project: (id: string | null | undefined): ProjectView | null =>
      state.projects.find((project) => project.id === id) ?? null,
    error,
    clearError: () => setError(null),
    notice,
    cloning,
    addProject,
    cloneUrl,
    removeProject: (id: string) => window.desktop.projects.remove(id),
    fetch: (id: string) => void run(window.desktop.git.fetch(id)),
    pull,
    push: (id: string) => void run(window.desktop.git.push(id)),
    // These answer to the form that asked, which shows any refusal itself.
    createWorkspace: (name: string) => window.desktop.workspaces.create(name),
    renameWorkspace: (id: string, name: string) => window.desktop.workspaces.rename(id, name),
    removeWorkspace: (id: string) => window.desktop.workspaces.remove(id),
    setActive: (id: string) => window.desktop.workspaces.setActive(id),
    createDirectory: (id: string, name: string) =>
      window.desktop.projects.createDirectory(id, name),
    createCollection: (
      id: string,
      directory: string | null,
      name: string,
      kind: LibraryKind = 'collection'
    ) => window.desktop.projects.createCollection(id, directory, name, kind)
  }
}
