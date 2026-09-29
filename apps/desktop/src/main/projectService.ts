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
  ENVIRONMENTS_DIR,
  GitRepo,
  REQUESTS_DIR,
  isUseStep,
  listRequestSets,
  loadChecks,
  readRequestLine,
  stepLabel,
  addLfAttributes,
  applyProjectEdits,
  clone,
  convertToLf,
  createCollectionFile,
  createDirectory,
  defaultCloneName,
  discoverProject,
  gitAtLeast,
  GitCommandError,
  gitVersion,
  isClean,
  isInside,
  LF_BLOCK,
  lineEndingState,
  loadProjectCollections,
  loadProjectTls,
  parseProgress,
  relativePosix,
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

  async removeWorkspace(id: string): Promise<void> {
    for (const project of await this.registry.removeWorkspace(id)) this.forget(project.id)
    this.emitState()
  }

  async setActive(id: string): Promise<void> {
    await this.registry.setActive(id)
    this.emitState()
  }

  /* ------------------------------------------------------------ projects -- */

  /**
   * Add a folder as a project. A `collections/` folder picked by mistake means
   * its parent; a folder with no `collections/` is added only when asked to
   * create one, so a wrong pick does not quietly become an empty project.
   */
  async addProject(
    workspaceId: string,
    folder: string,
    options: { createCollections?: boolean } = {}
  ): Promise<AddProjectOutcome> {
    const root = await projectRootFor(folder)
    const stat = await fs.stat(root).catch(() => null)
    if (!stat?.isDirectory()) return { ok: false, message: `Not a folder: ${root}` }

    const collections = path.join(root, COLLECTIONS_DIR)
    const hasCollections = await isDirectory(collections)
    if (!hasCollections) {
      if (!options.createCollections) {
        return {
          ok: false,
          noCollections: true,
          message: `${path.basename(root)} has no ${COLLECTIONS_DIR}/ folder.`
        }
      }
      await fs.mkdir(collections)
    }

    const entry = await this.registry.addProject(workspaceId, root)
    const view = (await this.refresh(entry.id)) ?? placeholder(entry, workspaceId)
    this.emitState()
    return { ok: true, project: view }
  }

  /** Clone a repository into a folder and add it as a project, reporting progress as it goes. */
  async cloneInto(workspaceId: string, url: string, parentDir: string): Promise<ProjectView> {
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
      const added = await this.addProject(workspaceId, cloned, { createCollections: true })
      if (!added.ok) throw new Error(added.message)
      return added.project
    } finally {
      report('', null, true)
    }
  }

  async removeProject(id: string): Promise<void> {
    this.forget(id)
    await this.registry.removeProject(id)
    this.emitState()
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
  async refresh(id: string): Promise<ProjectView | null> {
    const found = this.registry.project(id)
    if (!found) return null
    const { workspaceId, entry } = found

    if (!(await isDirectory(entry.path))) {
      const view = { ...placeholder(entry, workspaceId), available: false }
      this.views.set(id, view)
      this.emitProject(view)
      return view
    }

    const repo = this.gitAvailable === false ? null : await GitRepo.open(entry.path)
    const { git, gitNote } = await this.readGit(repo, entry.path)
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

    const view: ProjectView = {
      id,
      workspaceId,
      path: entry.path,
      name: info.doc?.name ?? path.basename(entry.path),
      available: true,
      isRepo: repo !== null,
      repoRoot: repo?.root ?? null,
      git,
      gitNote,
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
          method: isUseStep(step) ? 'USE' : readRequestLine(step).method
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
        hasTests: Boolean(endpoint.file.tests || endpoint.step.tests)
      })),
      bases: bases.map((file) => libraryFile(file, baseProblem)),
      caFiles: tls.files.map(({ path, source, certificates, problem }) => ({
        path,
        source,
        certificates,
        problem
      })),
      // Kept even when no environment has that name any more: the renderer
      // follows a renamed file to its new name, and shows a lost one as unset.
      selectedEnvironment: entry.selectedEnvironment,
      autoFetchSeconds: entry.autoFetchSeconds,
      busy: repo !== null && this.isBusy(repo.root)
    }

    this.views.set(id, view)
    this.watcher.watch(id, this.watchTargets(view, repo))
    this.scheduleAutoFetch(entry)
    this.emitProject(view)
    return view
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

/** A file in the repository's changes as they are now, or a refusal when it has none. */
async function changedFile(repo: GitRepo, repoPath: string) {
  const file = (await repo.status()).files.find((change) => change.path === repoPath)
  if (!file) throw GitCommandError.refused(`${repoPath} has no changes any more.`)
  return file
}

const isDirectory = (target: string) =>
  fs
    .stat(target)
    .then((stat) => stat.isDirectory())
    .catch(() => false)

/** A project we know about but have not been able to read yet. */
const placeholder = (entry: ProjectEntry, workspaceId: string): ProjectView => ({
  id: entry.id,
  workspaceId,
  path: entry.path,
  name: path.basename(entry.path),
  available: true,
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
