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
  // The first listing, so a click on + Project as the window opens, before it
  // has arrived, is carried out rather than dropped.
  const listing = useRef<Promise<WorkspacesState> | null>(null)

  useEffect(
    () => window.desktop.git.onProgress((progress) => setCloning(progress.done ? null : progress)),
    []
  )
  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  useEffect(() => {
    let live = true
    listing.current = window.desktop.workspaces.list()
    void listing.current.then((next) => {
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
  /**
   * Say what is being done until it is: adding a project can take a while on
   * a slow disk. A message that replaced this one in the meantime stays.
   */
  const whileDoing = async <T>(message: string, work: () => Promise<T>): Promise<T> => {
    clearTimeout(noticeTimer.current)
    setNotice(message)
    try {
      return await work()
    } finally {
      setNotice((current) => (current === message ? null : current))
    }
  }

  const addProject = useCallback(async () => {
    setError(null)
    const workspaceId = state.activeWorkspaceId ?? (await listing.current)?.activeWorkspaceId
    if (!workspaceId) return
    const folder = await window.desktop.projects.pick()
    if (!folder) return
    const adding = `Adding ${folderName(folder)}…`
    let result = await whileDoing(adding, () => window.desktop.projects.add(workspaceId, folder))
    if (!result.ok && result.projectsInside) {
      if (!window.confirm(`${result.message} Add them all?`)) return
      const all = await whileDoing(adding, () =>
        window.desktop.projects.addAll(workspaceId, folder)
      )
      if (!all.ok) return fail(all.message)
      return tell(addedMessage(folder, all.added, all.already))
    }
    if (!result.ok && result.noCollections) {
      if (!window.confirm(`${result.message} Create collections/ in it and add it as a project?`)) {
        return
      }
      result = await whileDoing(adding, () =>
        window.desktop.projects.add(workspaceId, folder, { createCollections: true })
      )
    }
    if (!result.ok) fail(result.message)
  }, [state.activeWorkspaceId])

  /** Search a folder, a monorepo's say, and add every project in it. */
  const addProjectsIn = useCallback(async () => {
    setError(null)
    const workspaceId = state.activeWorkspaceId ?? (await listing.current)?.activeWorkspaceId
    if (!workspaceId) return
    const folder = await window.desktop.projects.pick('all')
    if (!folder) return
    const result = await whileDoing(`Searching ${folderName(folder)} for projects…`, () =>
      window.desktop.projects.addAll(workspaceId, folder)
    )
    if (!result.ok) return fail(result.message)
    tell(addedMessage(folder, result.added, result.already))
  }, [state.activeWorkspaceId])

  const cloneUrl = useCallback(
    async (url: string) => {
      setError(null)
      const workspaceId = state.activeWorkspaceId ?? (await listing.current)?.activeWorkspaceId
      if (!workspaceId) return
      const parentDir = await window.desktop.projects.pick()
      if (!parentDir) return
      const result = await window.desktop.projects.clone(workspaceId, url, parentDir)
      if (!result.ok) return fail(result.message, result.hint)
      tell(clonedMessage(result.folder, result.added))
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
    addProjectsIn,
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

/** What adding a folder's projects did, in a sentence: `Added 3 projects from platform: …`. */
export function addedMessage(folder: string, added: string[], already: string[]): string {
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  const count = (n: number) => `${n} project${n === 1 ? '' : 's'}`
  if (added.length === 0) {
    return already.length === 1
      ? `The project in ${name} was here already.`
      : `All ${count(already.length)} in ${name} were here already.`
  }
  const were = already.length === 1 ? 'was' : 'were'
  const rest = already.length > 0 ? ` ${already.length} more ${were} here already.` : ''
  return `Added ${count(added.length)} from ${name}: ${added.join(', ')}.${rest}`
}

/** A folder's own name, from its path on any platform. */
const folderName = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder

/** What a clone added, in a sentence: `Cloned platform and added 3 projects: …`. */
export function clonedMessage(folder: string, added: string[]): string {
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
  const count = `${added.length} project${added.length === 1 ? '' : 's'}`
  return `Cloned ${name} and added ${count}: ${added.join(', ')}.`
}
