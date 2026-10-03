import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BASES_DIR,
  CHECKS_DIR,
  COLLECTIONS_DIR,
  ENDPOINTS_DIR,
  baseProblem,
  endpointProblem,
  listBases,
  listEndpointFiles,
  loadEndpoints,
  mergeHeaders,
  type Collection,
  type LayerParts,
  ENVIRONMENTS_DIR,
  PROJECT_FILE,
  GitRepo,
  REQUESTS_DIR,
  isReadStep,
  isUseStep,
  listRequestSets,
  loadChecks,
  parseCollection,
  readRequestLine,
  stepLabel,
  addLfAttributes,
  applyProjectEdits,
  clone,
  canonical,
  collectionsFolder,
  convertToLf,
  copyCollectionFile,
  createCollectionFile,
  createDirectory,
  defaultCloneName,
  discoverProject,
  DOC_EXTENSION,
  findDataFile,
  findProjects,
  foldName,
  gitAtLeast,
  GitCommandError,
  gitVersion,
  isClean,
  isInside,
  LF_BLOCK,
  lineEndingState,
  loadProjectCollections,
  loadProjectTls,
  moveCollectionToFolder,
  nameProblem,
  parseProgress,
  relativePosix,
  renameCollectionFile,
  renameCollectionsFolder,
  resolveRelative,
  projectEnvironments,
  projectRootFor,
  readProject,
  samePath,
  summarize,
  type BranchInfo,
  type CommitInfo,
  type EditOutcome,
  type FileDiff,
  type GitStatus,
  type ProjectEdit,
  type PullOutcome
} from '@schwabyio/gravity-core'
import type {
  AddProjectOutcome,
  AddProjectsOutcome,
  LibraryKind,
  LibraryFileView,
  GitProgress,
  GitStatusView,
  LineEndingsView,
  ProjectView,
  RepoChangesView,
  WorkspacesState
} from '../shared/ipc.js'
import type { GitSetup } from './bundledGit.js'
import { classifyChanges, type OwnerRoot } from './changes.js'
import { DirectoryWatcher, type WatchTarget } from './watcher.js'
import { WorkspaceRegistry, type ProjectEntry } from './workspaceRegistry.js'

type ProjectListener = (project: ProjectView) => void
type StateListener = (state: WorkspacesState) => void
type ProgressListener = (progress: GitProgress) => void

export interface ProjectServiceOptions {
  /**
   * Where a discarded file goes: the Trash, so a discard can be undone. It
   * rejects when it cannot, and then nothing is discarded.
   */
  moveAside: (file: string) => Promise<void>
  /** The folder scratch pads are made in: the app's own data, never a repository. */
  scratchPads: () => string
}

/**
 * Owns every workspace and project: reading them, their git state and watching
 * them for change.
 *
 * Main holds this state, not the renderer — the renderer has no filesystem access
 * and receives views over IPC. A project is read only within its own folder
 * (and its global project's); git state belongs to the repository, which
 * several projects of a monorepo can share.
 */
/** A document's headers, settings and scripts, as one layer of a request (SPEC.md §2.6). */
const layerOf = (doc: LayerParts): LayerParts => ({
  ...(doc.headers ? { headers: doc.headers } : {}),
  ...(doc.settings ? { settings: doc.settings } : {}),
  ...(doc.before ? { before: doc.before } : {}),
  ...(doc.tests ? { tests: doc.tests } : {})
})

export class ProjectService {
  private readonly registry = new WorkspaceRegistry()
  private readonly views = new Map<string, ProjectView>()
  /** Repository roots with a git operation running. */
  private readonly busyRepos = new Set<string>()
  /**
   * One git operation at a time per repository, the rest queued behind it: a
   * commit clicked during a background fetch waits for it rather than failing.
   */
  private readonly repoQueues = new Map<string, Promise<unknown>>()
  /** Why the last background fetch of a repository failed, by its root. */
  private readonly fetchProblems = new Map<string, string>()
  /** When each repository was last fetched in the background. */
  private readonly lastFetched = new Map<string, number>()
  private readonly autoFetchTimers = new Map<string, NodeJS.Timeout>()
  private readonly watcher = new DirectoryWatcher((id) => void this.refresh(id))
  private readonly projectListeners = new Set<ProjectListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly progressListeners = new Set<ProgressListener>()
  private gitAvailable: boolean | null = null
  private git: GitSetup | null = null

  constructor(private readonly options: ProjectServiceOptions) {}

  /** The git in use, from `setupGit` at startup. */
  setGit(setup: GitSetup): void {
    this.git = setup
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onProject(listener: ProjectListener): () => void {
    this.projectListeners.add(listener)
    return () => this.projectListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private emitProject(view: ProjectView): void {
    for (const listener of this.projectListeners) listener(view)
  }

  private emitState(): void {
    const state = this.state()
    for (const listener of this.stateListeners) listener(state)
  }

  async init(): Promise<WorkspacesState> {
    this.gitAvailable = (await gitVersion()) !== null
    await this.registry.load()
    await Promise.all(this.registry.projects().map(({ entry }) => this.refresh(entry.id)))
    return this.state()
  }

  /**
   * The state once the registry is read, for a window asking as it opens. That
   * is before `init`, which waits on git first — slow to start on Windows —
   * and asked earlier, the answer would be a placeholder workspace that the
   * file replaces, so + Project would fail with "Unknown workspace".
   */
  async loadedState(): Promise<WorkspacesState> {
    await this.registry.load()
    return this.state()
  }

  state(): WorkspacesState {
    return {
      activeWorkspaceId: this.registry.activeWorkspaceId,
      workspaces: this.registry.workspaces().map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        projectIds: workspace.projects.map((project) => project.id)
      })),
      projects: this.registry
        .projects()
        .map(
          ({ workspaceId, entry }) => this.views.get(entry.id) ?? placeholder(entry, workspaceId)
        )
    }
  }

  /** Every project root, and every global project root they use: what main may touch. */
  roots(): string[] {
    return [...this.views.values()].flatMap((view) => [
      view.path,
      ...(view.global ? [view.global.path] : [])
    ])
  }

  project(id: string): ProjectView | undefined {
    return this.views.get(id)
  }

  /* ---------------------------------------------------------- workspaces -- */

  async createWorkspace(name: string): Promise<string> {
    if (name.trim() === '') throw new Error('A workspace needs a name')
    const workspace = await this.registry.createWorkspace(name)
    this.emitState()
    return workspace.id
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    if (name.trim() === '') throw new Error('A workspace needs a name')
    await this.registry.renameWorkspace(id, name)
    this.emitState()
  }

  /** Forget a workspace and its projects, leaving their files alone — but its scratch pads' go to the Trash. */
  async removeWorkspace(id: string): Promise<void> {
    for (const project of await this.registry.removeWorkspace(id)) {
      this.forget(project.id)
      // A folder the Trash refuses stays where it is; the workspace goes all the same.
      if (project.scratch) await this.trashScratchPad(project.path).catch(() => undefined)
    }
    this.emitState()
  }

  async setActive(id: string): Promise<void> {
    await this.registry.setActive(id)
    this.emitState()
  }

  /* ------------------------------------------------------------ projects -- */

  /**
   * Add a folder as a project. A `collections/` folder picked by mistake means
   * its parent. A folder with no `collections/` is added as it is when it holds
   * the rest of a project — a global project may hold nothing else (SPEC.md
   * §1.1) — and otherwise only when asked to create one, so a wrong pick does
   * not quietly become an empty project. A folder holding projects — a
   * monorepo's root, a folder of repositories — offers them instead; one that
   * is a project and holds more besides, a repository-wide suite above its
   * services, offers them too unless `alone`.
   */
  async addProject(
    workspaceId: string,
    folder: string,
    options: { createCollections?: boolean; alone?: boolean } = {}
  ): Promise<AddProjectOutcome> {
    const root = await projectRootFor(folder)
    const stat = await fs.stat(root).catch(() => null)
    if (!stat?.isDirectory()) return { ok: false, message: `Not a folder: ${root}` }

    const collections = path.join(root, COLLECTIONS_DIR)
    if (!(await isDirectory(collections)) && !(await holdsProjectFiles(root))) {
      if (!options.createCollections) {
        // A monorepo's root: its projects are inside, to be added rather than made.
        const inside = await findProjects(root)
        if (inside.length > 0) {
          return {
            ok: false,
            projectsInside: inside.map((project) => relativePosix(root, project)),
            message: `${path.basename(root)} is not a project, but holds ${inside.length} project${inside.length === 1 ? '' : 's'}: ${inside.map((project) => relativePosix(root, project)).join(', ')}.`
          }
        }
        return {
          ok: false,
          noCollections: true,
          message: `${path.basename(root)} has no ${COLLECTIONS_DIR}/ folder, nor ${PROJECT_FILE} or anything else a project holds.`
        }
      }
      await fs.mkdir(collections)
    } else if (!options.alone) {
      const more = (await findProjects(root)).filter((project) => !samePath(project, root))
      if (more.length > 0) {
        const names = more.map((project) => relativePosix(root, project))
        return {
          ok: false,
          projectsInside: names,
          alsoProject: true,
          message: `${path.basename(root)} is a project, and holds ${more.length} more: ${names.join(', ')}.`
        }
      }
    }

    const entry = await this.registry.addProject(workspaceId, root)
    const view = (await this.listed(entry.id)) ?? placeholder(entry, workspaceId)
    this.emitState()
    return { ok: true, project: view }
  }

  /**
   * Refresh a project, and resolve as soon as it can be listed: its files read,
   * whether or not git has answered yet. git, slow to start on Windows, fills
   * in what it says when it does.
   */
  private listed(id: string): Promise<ProjectView | null> {
    return new Promise((resolve, reject) => {
      this.refresh(id, resolve).then(resolve, reject)
    })
  }

  /**
   * Add every project in a folder — a monorepo's services, a folder of
   * repositories — and the global projects they use there (`findProjects`).
   * One already in the workspace is left as it is, and named as already there.
   */
  async addProjectsIn(workspaceId: string, folder: string): Promise<AddProjectsOutcome> {
    if (!(await isDirectory(folder))) return { ok: false, message: `Not a folder: ${folder}` }
    const roots = await findProjects(folder)
    if (roots.length === 0) {
      return {
        ok: false,
        message: `No projects in ${path.basename(folder)}: a project is a folder holding ${COLLECTIONS_DIR}/.`
      }
    }
    const workspace = this.registry.workspace(workspaceId)
    if (!workspace) return { ok: false, message: 'Unknown workspace' }
    const added: string[] = []
    const already: string[] = []
    for (const root of roots) {
      const known = workspace.projects.some((project) => samePath(project.path, root))
      const entry = await this.registry.addProject(workspaceId, root)
      const view = (await this.listed(entry.id)) ?? placeholder(entry, workspaceId)
      ;(known ? already : added).push(view.name)
    }
    this.emitState()
    return { ok: true, added, already }
  }

  /**
   * Clone a repository into a folder and add it, reporting progress as it goes:
   * a monorepo's projects each, as + Project adds a monorepo's; otherwise the clone
   * itself, as + Project would, made a project if it is not one yet. Returns the
   * clone's folder and the names of the projects added.
   */
  async cloneInto(
    workspaceId: string,
    url: string,
    parentDir: string
  ): Promise<{ folder: string; added: string[] }> {
    if (this.gitAvailable === false) throw new Error('git is not available, so cloning is not')
    const parent = path.resolve(parentDir)
    const target = path.join(parent, defaultCloneName(url))
    let last = ''
    const report = (phase: string, percent: number | null, done: boolean) => {
      // git redraws its progress many times a second; pass on only what changed.
      const key = `${phase}|${percent}|${done}`
      if (key === last) return
      last = key
      for (const listener of this.progressListeners) {
        listener({ operation: 'clone', target, phase, percent, done })
      }
    }
    report('', null, false)
    try {
      const cloned = await clone(url, parent, {
        onProgress: (line) => {
          // Only the counted phases: receiving objects, resolving deltas.
          const progress = parseProgress(line)
          if (progress.percent !== null) report(progress.phase, progress.percent, false)
        }
      })
      const found = await this.addProjectsIn(workspaceId, cloned)
      if (found.ok) return { folder: cloned, added: [...found.added, ...found.already] }
      const added = await this.addProject(workspaceId, cloned, { createCollections: true })
      if (!added.ok) throw new Error(added.message)
      return { folder: cloned, added: [added.project.name] }
    } finally {
      report('', null, true)
    }
  }

  /**
   * Remove a project from its workspace, leaving its files alone — except a
   * scratch pad's, which are the app's: its folder goes to the Trash, unless
   * another workspace has it too.
   */
  async removeProject(id: string): Promise<void> {
    const found = this.registry.project(id)
    this.forget(id)
    if (found?.entry.scratch) {
      try {
        await this.trashScratchPad(found.entry.path, id)
      } catch (cause) {
        // Still a project, then: listed and watched again.
        await this.refresh(id)
        throw cause
      }
    }
    await this.registry.removeProject(id)
    this.emitState()
  }

  /** A scratch pad's folder, to the Trash — unless a project other than `except` is that folder too. */
  private async trashScratchPad(root: string, except?: string): Promise<void> {
    const shared = this.registry
      .projects()
      .some(({ entry }) => entry.id !== except && samePath(entry.path, root))
    if (!shared && (await isDirectory(root))) await this.options.moveAside(root)
  }

  /* -------------------------------------------------------- scratch pads -- */

  /**
   * Make a scratch pad in a workspace: a project of its own in the app's data
   * folder, `Scratch pads/<name>/` with a `collections/`, for ad hoc work that
   * belongs in no repository. It is read like any project, without git.
   */
  async createScratchPad(workspaceId: string, name: string): Promise<ProjectView> {
    const trimmed = name.trim()
    const problem = nameProblem(trimmed)
    if (problem) throw new Error(problem)
    if (!this.registry.workspace(workspaceId)) throw new Error('Unknown workspace')
    const home = this.options.scratchPads()
    await fs.mkdir(home, { recursive: true })
    // One folder each, whatever the case: macOS and Windows could not hold both.
    const existing = (await fs.readdir(home)).find((entry) => foldName(entry) === foldName(trimmed))
    if (existing !== undefined)
      throw new Error(`There is already a scratch pad called "${existing}"`)
    const root = path.join(home, trimmed)
    await fs.mkdir(path.join(root, COLLECTIONS_DIR), { recursive: true })
    const entry = await this.registry.addProject(workspaceId, await canonical(root), {
      scratch: true
    })
    const view = (await this.listed(entry.id)) ?? placeholder(entry, workspaceId)
    this.emitState()
    return view
  }

  /**
   * Rename a scratch pad: its folder in the app's data, and the name its
   * `project.yml` gives it, if it gives one. Its collections keep their ids
   * and its `uses:` still reaches its global project, from a folder beside the
   * old one.
   */
  async renameScratchPad(id: string, name: string): Promise<ProjectView> {
    const found = this.registry.project(id)
    const view = this.views.get(id)
    if (!found?.entry.scratch || !view) throw new Error('Only a scratch pad is renamed here')
    const trimmed = name.trim()
    const problem = nameProblem(trimmed)
    if (problem) throw new Error(problem)
    const from = found.entry.path
    const home = path.dirname(from)
    const existing = (await fs.readdir(home)).find(
      (entry) => foldName(entry) === foldName(trimmed) && entry !== path.basename(from)
    )
    if (existing !== undefined)
      throw new Error(`There is already a scratch pad called "${existing}"`)

    // Shown under the name its project.yml gives, if any: that becomes the new one too.
    if (view.project?.name !== undefined) {
      const named = await applyProjectEdits(from, view.projectSource, [
        { key: 'name', value: trimmed }
      ])
      if (!named.ok) throw new Error(`${PROJECT_FILE} changed on disk: try again`)
    }
    const to = path.join(home, trimmed)
    if (to !== from) {
      // Not watched while it moves: on Windows an open watch can hold the folder.
      const sharing = this.registry.projects().filter(({ entry }) => samePath(entry.path, from))
      for (const { entry } of sharing) this.forget(entry.id)
      try {
        await fs.rename(from, to)
        await this.registry.moveProjects(from, await canonical(to))
      } finally {
        await Promise.all(sharing.map(({ entry }) => this.refresh(entry.id)))
      }
    } else {
      await this.refresh(id)
    }
    this.emitState()
    return this.required(id)
  }

  /* --------------------------------------------------------- collections -- */

  /** The project a file of `collections/` is in, or a refusal for any other file. */
  private ownerOf(file: string): ProjectView {
    const view = [...this.views.values()].find((candidate) =>
      isInside(path.join(candidate.path, COLLECTIONS_DIR), file)
    )
    if (!view || !file.endsWith(DOC_EXTENSION)) {
      throw new Error('Not a collection of a project in a workspace')
    }
    return view
  }

  /** Re-read every project in a folder: a folder can be a project in more than one workspace. */
  private async refreshAt(root: string): Promise<void> {
    const views = [...this.views.values()].filter((view) => samePath(view.path, root))
    await Promise.all(views.map((view) => this.refresh(view.id)))
  }

  /** Give a collection a new id: its file and its data file renamed, and its `id:` rewritten. */
  async renameCollection(file: string, id: string): Promise<string> {
    const owner = this.ownerOf(file)
    const renamed = await renameCollectionFile(owner.path, file, id)
    await this.refreshAt(owner.path)
    return renamed
  }

  /** Move a collection, with its data file, to another folder of its project — or its root. */
  async moveToFolder(file: string, folder: string | null): Promise<string> {
    const owner = this.ownerOf(file)
    const moved = await moveCollectionToFolder(owner.path, file, folder)
    await this.refreshAt(owner.path)
    return moved
  }

  /** Copy a collection, with its data file, into another project — or move it there. */
  async copyCollection(
    file: string,
    projectId: string,
    directory: string | null,
    move: boolean
  ): Promise<string> {
    const owner = this.ownerOf(file)
    const target = this.required(projectId)
    if (samePath(owner.path, target.path)) {
      throw new Error(`${path.basename(file)} is in ${target.name} already`)
    }
    const copied = await copyCollectionFile(file, target.path, directory, { move })
    await Promise.all([this.refreshAt(owner.path), this.refreshAt(target.path)])
    return copied
  }

  /**
   * A collection file as its last commit has it, parsed — for the editor to
   * mark what changed since. Null when there is nothing to compare with: a
   * scratch pad, a project outside git, a file never committed, or a
   * committed version that will not parse.
   */
  async committedDoc(file: string): Promise<Collection | null> {
    const view = [...this.views.values()].find(
      (candidate) => candidate.isRepo && !candidate.scratch && isInside(candidate.path, file)
    )
    if (!view) return null
    const repo = await this.repoFor(view.id).catch(() => null)
    if (!repo) return null
    const source = await repo.committed(relativePosix(repo.root, file))
    if (source === null) return null
    try {
      return parseCollection(source, path.basename(file)).data
    } catch {
      return null
    }
  }

  /** Rename a folder of a project's `collections/`, with everything in it. */
  async renameFolder(projectId: string, name: string, to: string): Promise<string> {
    const view = this.required(projectId)
    const renamed = await renameCollectionsFolder(view.path, name, to)
    await this.refreshAt(view.path)
    return renamed
  }

  /** Delete a folder of a project's `collections/` and everything in it, to the Trash. */
  async deleteFolder(projectId: string, name: string): Promise<void> {
    const view = this.required(projectId)
    await this.options.moveAside(await collectionsFolder(view.path, name))
    await this.refreshAt(view.path)
  }

  /** Delete a collection and its data file, to the Trash. */
  async deleteCollection(file: string): Promise<void> {
    const owner = this.ownerOf(file)
    const dataFile = await findDataFile(file)
    await this.options.moveAside(file)
    if (dataFile) await this.options.moveAside(dataFile)
    await this.refreshAt(owner.path)
  }

  private forget(id: string): void {
    this.watcher.unwatch(id)
    this.stopAutoFetch(id)
    this.views.delete(id)
  }

  async selectEnvironment(id: string, environment: string | null): Promise<void> {
    await this.registry.selectEnvironment(id, environment)
    await this.refresh(id)
  }

  async createDirectory(id: string, name: string): Promise<string> {
    const view = this.required(id)
    const directory = await createDirectory(view.path, name)
    await this.refresh(id)
    return directory
  }

  async createCollection(
    id: string,
    directory: string | null,
    name: string,
    kind: LibraryKind = 'collection'
  ): Promise<string> {
    const view = this.required(id)
    const created = await createCollectionFile(view.path, directory, name, kind)
    await this.refresh(id)
    return created.path
  }

  /**
   * Edit a project's `project.yml` — or, with `target: 'global'`, its global
   * project's, whose variables every project using it shares. Only the
   * variables of a global project are edited from here: its name and its own
   * links are its business.
   */
  async applyProjectEdits(
    id: string,
    baseSource: string | null,
    edits: ProjectEdit[],
    target: 'project' | 'global' = 'project'
  ): Promise<EditOutcome> {
    const view = this.required(id)
    if (target === 'project') {
      const outcome = await applyProjectEdits(view.path, baseSource, edits)
      if (outcome.ok && outcome.wrote) await this.refresh(id)
      return outcome
    }

    if (!view.global) throw new Error(`${view.name} does not use a global project`)
    if (edits.some((edit) => edit.key !== 'vars')) {
      throw new Error('Only a global project’s variables are edited from a project using it')
    }
    const root = view.global.path
    const outcome = await applyProjectEdits(root, baseSource, edits)
    if (outcome.ok && outcome.wrote) {
      // Every project sharing it sees the change, not only this one.
      const sharing = [...this.views.values()].filter(
        (other) => other.global !== null && samePath(other.global.path, root)
      )
      await Promise.all(sharing.map((other) => this.refresh(other.id)))
    }
    return outcome
  }

  private required(id: string): ProjectView {
    const view = this.views.get(id)
    if (!view) throw new Error('Unknown project')
    return view
  }

  /**
   * Re-read one project from disk: its collections, `project.yml`, global
   * project, environments and git state.
   *
   * This is what a watcher event, an explicit refresh and a completed pull all
   * funnel into, so there is exactly one path that produces a project view.
   */
  async refresh(
    id: string,
    /** Called with the project's first view: from its files, if git is slow to answer. */
    listed?: (view: ProjectView) => void
  ): Promise<ProjectView | null> {
    const found = this.registry.project(id)
    if (!found) return null
    const { workspaceId, entry } = found

    if (!(await isDirectory(entry.path))) {
      const view = { ...placeholder(entry, workspaceId), available: false }
      this.views.set(id, view)
      this.emitProject(view)
      return view
    }

    // git is read alongside the files rather than before them: on Windows it
    // can be slow to start, and the files need not wait for it. A scratch pad
    // has none, even were the app's data folder in a repository.
    const reading = entry.scratch
      ? Promise.resolve({ repo: null, git: null, gitNote: null })
      : this.readRepo(entry.path)
    // Its failure is met below; until then it must not count as unhandled.
    reading.catch(() => undefined)
    const layout = await discoverProject(entry.path)
    const info = await readProject(entry.path)
    // Ids checked against each other, as gta checks them: a shared id is a problem on both.
    const collections = (await loadProjectCollections(entry.path, layout.files)).map(summarize)
    const environments = await projectEnvironments(entry.path, info.global)
    const sets = await listRequestSets(entry.path, info.global)
    const checks = await loadChecks(entry.path, info.global)
    const endpointFiles = await listEndpointFiles(entry.path, info.global)
    const endpoints = await loadEndpoints(entry.path, info.global)
    const bases = await listBases(entry.path, info.global)
    const tls = await loadProjectTls(entry.path, info)
    const libraryFile = (
      file: (typeof bases)[number],
      problemOf: (doc: Collection) => string | undefined
    ): LibraryFileView => ({
      name: file.name,
      path: file.path,
      source: file.source,
      title: file.name,
      stepCount: file.doc?.steps.length ?? 0,
      problem: file.problem ?? (file.doc ? problemOf(file.doc) : undefined)
    })

    const files: Omit<ProjectView, RepoFields> = {
      id,
      workspaceId,
      path: entry.path,
      name: info.doc?.name ?? path.basename(entry.path),
      available: true,
      scratch: entry.scratch,
      hasCollections: await isDirectory(layout.collectionsDir),
      collections,
      directories: layout.directories,
      // A tls.ca file that cannot be used, reported against its own path.
      problems: [...info.problems, ...layout.problems, ...tls.problems],
      project: info.doc,
      projectSource: info.source,
      global: info.global
        ? {
            path: info.global.root,
            name: info.global.doc.name ?? path.basename(info.global.root),
            uses: info.global.uses,
            vars: info.global.doc.vars ?? null,
            source: info.global.source
          }
        : null,
      environments,
      requestSets: sets.map((set) => ({
        name: set.name,
        path: set.path,
        source: set.source,
        title: set.name,
        params: set.doc?.params ?? {},
        steps: (set.doc?.steps ?? []).map((step) => ({
          label: stepLabel(step),
          method: isUseStep(step) ? 'USE' : isReadStep(step) ? 'READ' : readRequestLine(step).method
        })),
        problem:
          set.problem ??
          (set.doc && !set.doc.params
            ? 'no params: key, so it is not a request set (add params: {} for none)'
            : undefined)
      })),
      checks: checks.map((check) => check.name),
      endpointFiles: endpointFiles.map((file) => libraryFile(file, endpointProblem)),
      endpoints: endpoints.map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        filePath: endpoint.filePath,
        fileName: endpoint.fileName,
        source: endpoint.source,
        headers: Object.keys(mergeHeaders(endpoint.file.headers, endpoint.step.headers)),
        hasTests: Boolean(endpoint.file.tests || endpoint.step.tests),
        hasBefore: Boolean(endpoint.file.before?.script || endpoint.step.before?.script),
        file: layerOf(endpoint.file),
        step: layerOf(endpoint.step)
      })),
      bases: bases.map((file) => ({
        ...libraryFile(file, baseProblem),
        ...(file.doc ? { layer: layerOf(file.doc) } : {})
      })),
      caFiles: tls.files.map(({ path, source, certificates, problem }) => ({
        path,
        source,
        certificates,
        problem
      })),
      // Kept even when no environment has that name any more: the renderer
      // follows a renamed file to its new name, and shows a lost one as unset.
      selectedEnvironment: entry.selectedEnvironment,
      autoFetchSeconds: entry.autoFetchSeconds
    }

    const answered = await within(reading, GIT_PATIENCE)
    if (!answered) {
      // Listed from its files, with what git said last, until it answers.
      const before = this.views.get(id)
      const shown: ProjectView = {
        ...files,
        isRepo: before?.isRepo ?? false,
        repoRoot: before?.repoRoot ?? null,
        git: before?.git ?? null,
        gitNote: before?.gitNote ?? null,
        busy: before?.busy ?? false
      }
      this.views.set(id, shown)
      this.watcher.watch(id, this.watchTargets(shown, null))
      this.emitProject(shown)
      listed?.(shown)
    }
    const { repo, git, gitNote } = answered ?? (await reading)
    const view: ProjectView = {
      ...files,
      isRepo: repo !== null,
      repoRoot: repo?.root ?? null,
      git,
      gitNote,
      busy: repo !== null && this.isBusy(repo.root)
    }

    this.views.set(id, view)
    this.watcher.watch(id, this.watchTargets(view, repo))
    this.scheduleAutoFetch(entry)
    this.emitProject(view)
    return view
  }

  /** The repository a project is in, if any, and its state as the renderer shows it. */
  private async readRepo(
    projectPath: string
  ): Promise<{ repo: GitRepo | null; git: GitStatusView | null; gitNote: string | null }> {
    const repo = this.gitAvailable === false ? null : await GitRepo.open(projectPath)
    return { repo, ...(await this.readGit(repo, projectPath)) }
  }

  /**
   * What to watch for a project: its own folder's entries (for `project.yml`
   * and a `collections/` appearing), `collections/` and `environments/` in
   * depth, the same for its global project, the folders its `tls.ca` files
   * are in, and the few git files that move when a branch, a commit or a
   * fetch does. Never all of `.git`: it is noisy, and on Windows open handles
   * there can get in git's way.
   */
  private watchTargets(view: ProjectView, repo: GitRepo | null): WatchTarget[] {
    const caDirectories = new Set(
      view.caFiles.map((file) =>
        path.dirname(
          resolveRelative(
            file.source === 'global' && view.global ? view.global.path : view.path,
            file.path
          )
        )
      )
    )
    const globalRoot = view.global?.path ?? null
    const projectTargets = (root: string): WatchTarget[] => [
      { path: root, recursive: false },
      ...[
        COLLECTIONS_DIR,
        ENVIRONMENTS_DIR,
        REQUESTS_DIR,
        CHECKS_DIR,
        ENDPOINTS_DIR,
        BASES_DIR
      ].map((directory) => ({
        path: path.join(root, directory),
        recursive: true
      }))
    ]
    return [
      ...projectTargets(view.path),
      ...(globalRoot
        ? projectTargets(globalRoot).filter(
            (target) => !samePath(target.path, path.join(globalRoot, COLLECTIONS_DIR))
          )
        : []),
      ...[...caDirectories].map((directory) => ({ path: directory, recursive: false })),
      ...(repo
        ? [
            { path: repo.gitDir, recursive: false },
            { path: path.join(repo.gitDir, 'refs'), recursive: true }
          ]
        : [])
    ]
  }

  private async readGit(
    repo: GitRepo | null,
    projectPath: string
  ): Promise<{ git: GitStatusView | null; gitNote: string | null }> {
    if (this.gitAvailable === false) {
      return { git: null, gitNote: 'git is not installed — watching files only' }
    }
    if (!repo) return { git: null, gitNote: null }

    try {
      return { git: await this.statusView(repo, await repo.status(), projectPath), gitNote: null }
    } catch (cause) {
      return { git: null, gitNote: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  /** A repository's state as the renderer shows it. Built field by field: no file lists. */
  private async statusView(
    repo: GitRepo,
    status: GitStatus,
    projectPath: string | null
  ): Promise<GitStatusView> {
    return {
      branch: status.branch,
      detached: status.detached,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      changed: status.changed,
      untracked: status.untracked,
      conflicted: status.conflicted,
      clean: isClean(status),
      unborn: status.unborn,
      upstreamGone: status.upstreamGone,
      operation: await repo.operation(),
      remotes: await repo.remotes(),
      projectChanges: projectPath
        ? status.files.filter((file) => isInside(projectPath, repo.absolute(file.path))).length
        : 0,
      projectFiles: projectPath ? projectFiles(repo, status, projectPath) : {},
      fetchProblem: this.fetchProblems.get(this.repoKey(repo.root)) ?? null
    }
  }

  /* ----------------------------------------------------------------- git -- */

  /** Fetch, as asked: a sign-in window may open. */
  async fetch(projectId: string): Promise<void> {
    await this.withRepo(projectId, async (repo) => {
      await repo.fetch({ interactive: true })
      this.fetchProblems.delete(this.repoKey(repo.root))
      this.lastFetched.set(this.repoKey(repo.root), Date.now())
    })
  }

  /**
   * The auto-fetch timer's fetch: never prompts, skips a busy repository or one
   * fetched moments ago (projects of a monorepo share one), and keeps a failure
   * to show on the strip rather than dropping it.
   */
  private async backgroundFetch(projectId: string, intervalSeconds: number): Promise<void> {
    const found = this.registry.project(projectId)
    if (!found) return
    const repo = await GitRepo.open(found.entry.path).catch(() => null)
    if (!repo || this.isBusy(repo.root)) return
    const key = this.repoKey(repo.root)
    if (Date.now() - (this.lastFetched.get(key) ?? 0) < (intervalSeconds * 1000) / 2) return
    this.lastFetched.set(key, Date.now())
    await this.withRepo(projectId, async (fetching) => {
      try {
        await fetching.fetch({ interactive: false })
        this.fetchProblems.delete(key)
      } catch (cause) {
        this.fetchProblems.set(key, cause instanceof Error ? cause.message : String(cause))
      }
    }).catch(() => undefined)
  }

  async pull(projectId: string): Promise<{ outcome: PullOutcome; message: string }> {
    this.assertWritable()
    return this.withRepo(projectId, (repo) => repo.pull())
  }

  async push(projectId: string, remote: string | null): Promise<{ message: string }> {
    this.assertWritable()
    return this.withRepo(projectId, (repo) => repo.push({ remote }))
  }

  /** Every changed file in the project's repository, grouped by the app's projects there. */
  async changes(projectId: string): Promise<RepoChangesView> {
    const repo = await this.repoFor(projectId)
    const status = await repo.status()

    const roots: Array<OwnerRoot & { name: string }> = []
    const addRoot = (root: OwnerRoot & { name: string }) => {
      if (!roots.some((known) => samePath(known.path, root.path))) roots.push(root)
    }
    const views = this.projectsIn(repo.root)
    for (const view of views) addRoot({ id: view.id, name: view.name, path: view.path })
    for (const view of views) {
      if (view.global && isInside(repo.root, view.global.path)) {
        addRoot({
          id: `global:${view.global.path}`,
          name: `${view.global.name} (shared)`,
          path: view.global.path
        })
      }
    }
    const { files, truncated } = classifyChanges(repo.root, status.files, roots)

    const lineEndingNotices: RepoChangesView['lineEndingNotices'] = []
    for (const root of roots) {
      const view = this.views.get(root.id)
      const entry = this.registry.project(root.id)?.entry
      if (!view || !entry || entry.lineEndingsNoticeDismissed) continue
      const state = await lineEndingState(repo, view.path)
      if (!state.covered) lineEndingNotices.push({ projectId: view.id, name: view.name })
    }

    return {
      repoRoot: repo.root,
      repoName: path.basename(repo.root),
      status: await this.statusView(repo, status, null),
      identity: await repo.identity(),
      projects: roots.map((root) => ({
        id: root.id,
        name: root.name,
        path: relativePosix(repo.root, root.path)
      })),
      files,
      truncated,
      lineEndingNotices
    }
  }

  async diff(projectId: string, repoPath: string): Promise<FileDiff> {
    const repo = await this.repoFor(projectId)
    return repo.diff(await changedFile(repo, repoPath))
  }

  /**
   * Commit the chosen files as they are on disk. The list is checked against
   * the repository as it is now, and a rename brings the path it came from.
   */
  async commit(
    projectId: string,
    paths: string[],
    message: string
  ): Promise<{ oid: string; shortOid: string }> {
    this.assertWritable()
    return this.withRepo(projectId, async (repo) => {
      const changed = new Map((await repo.status()).files.map((file) => [file.path, file]))
      const selected = new Set<string>()
      for (const requested of paths) {
        const file = changed.get(requested)
        if (!file) continue
        selected.add(file.path)
        if (file.origPath) selected.add(file.origPath)
      }
      if (selected.size === 0) {
        throw GitCommandError.refused('Those changes are gone: review them and try again.')
      }
      return repo.commit([...selected], message)
    })
  }

  /** Put one file back as the last commit has it; the version on disk goes to the Trash. */
  async discard(projectId: string, repoPath: string): Promise<void> {
    this.assertWritable()
    await this.withRepo(projectId, async (repo) => {
      const file = await changedFile(repo, repoPath)
      await repo.discard(file, async (absolute) => {
        try {
          await this.options.moveAside(absolute)
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause)
          throw new Error(
            `Could not move ${repoPath} to the Trash, so nothing was discarded: ${reason}`
          )
        }
      })
    })
  }

  async log(projectId: string, skip: number): Promise<{ commits: CommitInfo[]; hasMore: boolean }> {
    return (await this.repoFor(projectId)).log({ skip })
  }

  async branches(projectId: string): Promise<{ branches: BranchInfo[]; remotes: string[] }> {
    return (await this.repoFor(projectId)).branches()
  }

  async createBranch(projectId: string, name: string): Promise<void> {
    this.assertWritable()
    await this.withRepo(projectId, (repo) => repo.createBranch(name))
  }

  async switchBranch(projectId: string, name: string, remote: string | null): Promise<void> {
    this.assertWritable()
    await this.withRepo(projectId, (repo) => repo.switchBranch(name, remote))
  }

  async setIdentity(projectId: string, name: string, email: string): Promise<void> {
    await (await this.repoFor(projectId)).setIdentity(name, email)
  }

  /** Whether git keeps this project's files LF, and which it stores CRLF. */
  async lineEndings(projectId: string): Promise<LineEndingsView> {
    const view = this.required(projectId)
    const repo = await GitRepo.open(view.path)
    if (!repo) {
      return { isRepo: false, covered: false, hasBlock: false, crlfFiles: [], block: LF_BLOCK }
    }
    return { isRepo: true, ...(await lineEndingState(repo, view.path)), block: LF_BLOCK }
  }

  /** Add the LF block to the project's `.gitattributes`: offered, never done unasked. */
  async addAttributes(projectId: string): Promise<LineEndingsView> {
    const view = this.required(projectId)
    await addLfAttributes(view.path)
    await this.refreshRepoOf(view)
    return this.lineEndings(projectId)
  }

  /** Rewrite the project's files git stores with CRLF as LF, ready to be committed. */
  async convertToLf(projectId: string): Promise<string[]> {
    const view = this.required(projectId)
    return this.withRepo(projectId, async (repo) =>
      convertToLf(repo, (await lineEndingState(repo, view.path)).crlfFiles)
    )
  }

  async dismissLineEndingsNotice(projectId: string): Promise<void> {
    await this.registry.dismissLineEndingsNotice(projectId)
  }

  private async refreshRepoOf(view: ProjectView): Promise<void> {
    const sharing = view.repoRoot ? this.projectsIn(view.repoRoot) : [view]
    await Promise.all(sharing.map((other) => this.refresh(other.id)))
  }

  /** Writes need a git that reads paths from a file and config from the environment. */
  private assertWritable(): void {
    if (this.git && !this.git.bundled && !gitAtLeast(this.git.version, 2, 31)) {
      throw new Error(
        `git ${this.git.version ?? '(unknown)'} is too old to commit from the app: 2.31 or later is needed.`
      )
    }
  }

  private async repoFor(projectId: string): Promise<GitRepo> {
    const found = this.registry.project(projectId)
    if (!found) throw new Error('Unknown project')
    const repo = await GitRepo.open(found.entry.path)
    if (!repo) throw new Error('Not a git repository')
    return repo
  }

  /** One key per repository, however its root is spelled. */
  private repoKey(root: string): string {
    return (
      [...this.repoQueues.keys(), ...this.fetchProblems.keys(), ...this.lastFetched.keys()].find(
        (known) => samePath(known, root)
      ) ?? root
    )
  }

  private isBusy(repoRoot: string): boolean {
    return [...this.busyRepos].some((busy) => samePath(busy, repoRoot))
  }

  /** The projects in one repository: a pull moves all of them. */
  private projectsIn(repoRoot: string): ProjectView[] {
    return [...this.views.values()].filter(
      (view) => view.repoRoot !== null && samePath(view.repoRoot, repoRoot)
    )
  }

  /**
   * Run a git operation on a project's repository, busy while it runs.
   *
   * Operations on one repository run one at a time, in the order asked. Every
   * project in the repository is re-read afterwards — a branch switch or a pull
   * moves all of them.
   */
  private async withRepo<T>(
    projectId: string,
    operation: (repo: GitRepo) => Promise<T>
  ): Promise<T> {
    const repo = await this.repoFor(projectId)
    const key = this.repoKey(repo.root)
    const previous = this.repoQueues.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      this.busyRepos.add(repo.root)
      this.setBusy(repo.root, true)
      try {
        return await operation(repo)
      } finally {
        this.busyRepos.delete(repo.root)
        await Promise.all(this.projectsIn(repo.root).map((view) => this.refresh(view.id)))
      }
    })
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.repoQueues.set(key, settled)
    void settled.then(() => {
      if (this.repoQueues.get(key) === settled) this.repoQueues.delete(key)
    })
    return run
  }

  private setBusy(repoRoot: string, busy: boolean): void {
    for (const view of this.projectsIn(repoRoot)) {
      const next = { ...view, busy }
      this.views.set(view.id, next)
      this.emitProject(next)
    }
  }

  private scheduleAutoFetch(entry: ProjectEntry): void {
    // Left running across refreshes: restarting it on every file change would
    // keep postponing the fetch for as long as someone is editing.
    if (!entry.autoFetchSeconds) {
      this.stopAutoFetch(entry.id)
      return
    }
    if (this.autoFetchTimers.has(entry.id)) return
    const seconds = entry.autoFetchSeconds
    this.autoFetchTimers.set(
      entry.id,
      setInterval(() => void this.backgroundFetch(entry.id, seconds), seconds * 1000)
    )
  }

  private stopAutoFetch(id: string): void {
    const timer = this.autoFetchTimers.get(id)
    if (timer) clearInterval(timer)
    this.autoFetchTimers.delete(id)
  }

  dispose(): void {
    this.watcher.dispose()
    for (const id of [...this.autoFetchTimers.keys()]) this.stopAutoFetch(id)
    this.projectListeners.clear()
    this.stateListeners.clear()
    this.progressListeners.clear()
  }
}

/**
 * What changed of each file in a project's own folder, by its path from the
 * project, with `/`: the sidebar marks its rows with it.
 */
function projectFiles(
  repo: GitRepo,
  status: GitStatus,
  projectPath: string
): Record<string, GitStatus['files'][number]['kind']> {
  const files: Record<string, GitStatus['files'][number]['kind']> = {}
  for (const file of status.files) {
    const absolute = repo.absolute(file.path)
    if (isInside(projectPath, absolute)) files[relativePosix(projectPath, absolute)] = file.kind
  }
  return files
}

/** A file in the repository's changes as they are now, or a refusal when it has none. */
async function changedFile(repo: GitRepo, repoPath: string) {
  const file = (await repo.status()).files.find((change) => change.path === repoPath)
  if (!file) throw GitCommandError.refused(`${repoPath} has no changes any more.`)
  return file
}

/**
 * Whether a folder holds what a project holds besides `collections/`: a
 * `project.yml`, or one of the folders a global project shares (SPEC.md §1.1).
 */
async function holdsProjectFiles(root: string): Promise<boolean> {
  const file = await fs.stat(path.join(root, PROJECT_FILE)).catch(() => null)
  if (file?.isFile()) return true
  for (const directory of [ENVIRONMENTS_DIR, REQUESTS_DIR, BASES_DIR, ENDPOINTS_DIR, CHECKS_DIR]) {
    if (await isDirectory(path.join(root, directory))) return true
  }
  return false
}

const isDirectory = (target: string) =>
  fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false)

/** A project we know about but have not been able to read yet. */
/** What a project view takes from git rather than from the project's files. */
type RepoFields = 'isRepo' | 'repoRoot' | 'git' | 'gitNote' | 'busy'

/** How long a project's files wait for git before they are shown without it. */
const GIT_PATIENCE = 1000

/** What `promise` resolves to, if it does within `ms`; else null, and it is left to finish. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise, waited]).finally(() => clearTimeout(timer))
}

const placeholder = (entry: ProjectEntry, workspaceId: string): ProjectView => ({
  id: entry.id,
  workspaceId,
  path: entry.path,
  name: path.basename(entry.path),
  available: true,
  scratch: entry.scratch,
  isRepo: false,
  repoRoot: null,
  git: null,
  gitNote: null,
  hasCollections: true,
  collections: [],
  directories: [],
  problems: [],
  project: null,
  projectSource: null,
  global: null,
  environments: [],
  requestSets: [],
  checks: [],
  endpointFiles: [],
  endpoints: [],
  bases: [],
  caFiles: [],
  selectedEnvironment: entry.selectedEnvironment,
  autoFetchSeconds: entry.autoFetchSeconds,
  busy: false
})
