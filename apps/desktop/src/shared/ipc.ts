import type {
  Collection,
  CollectionRunSummary,
  CollectionSummary,
  DataTable,
  EnvironmentDoc,
  EnvironmentRef,
  FlagValue,
  HttpMethod,
  LoadProblem,
  ParamSpec,
  ProjectDoc,
  RunResult,
  Step,
  StepList,
  VariablePreviews,
  VarValue,
  Vars
} from '@schwabyio/gravity-core/model'
import type { Settings, SettingsPatch } from './settings.js'

/**
 * The renderer <-> main contract.
 *
 * Every channel name lives here so both sides import the same constant, and main
 * validates each payload with the core schemas before acting on it. The renderer
 * never touches the network or the filesystem.
 */
export const IpcChannel = {
  runStart: 'run:start',
  runCollection: 'run:collection',
  runCancel: 'run:cancel',

  workspacesList: 'workspaces:list',
  workspaceCreate: 'workspaces:create',
  workspaceRename: 'workspaces:rename',
  workspaceRemove: 'workspaces:remove',
  workspaceSetActive: 'workspaces:setActive',

  projectPick: 'projects:pick',
  projectAdd: 'projects:add',
  projectClone: 'projects:clone',
  projectRemove: 'projects:remove',
  projectReveal: 'projects:reveal',
  projectSelectEnvironment: 'projects:selectEnvironment',
  projectCreateDirectory: 'projects:createDirectory',
  projectCreateCollection: 'projects:createCollection',
  projectApplyEdits: 'projects:applyEdits',
  projectPickFile: 'projects:pickFile',

  gitFetch: 'git:fetch',
  gitPull: 'git:pull',
  gitPush: 'git:push',
  gitChanges: 'git:changes',
  gitDiff: 'git:diff',
  gitCommit: 'git:commit',
  gitDiscard: 'git:discard',
  gitLog: 'git:log',
  gitBranches: 'git:branches',
  gitCreateBranch: 'git:createBranch',
  gitSwitchBranch: 'git:switchBranch',
  gitSetIdentity: 'git:setIdentity',
  gitLineEndings: 'git:lineEndings',
  gitAddAttributes: 'git:addAttributes',
  gitConvertToLf: 'git:convertToLf',
  gitDismissLineEndings: 'git:dismissLineEndings',

  collectionRead: 'collection:read',
  collectionApplyEdits: 'collection:applyEdits',
  dataRead: 'data:read',
  dataApply: 'data:apply',
  dataApplyText: 'data:applyText',
  dataCreate: 'data:create',
  dataDelete: 'data:delete',
  environmentRead: 'environment:read',
  environmentApplyEdits: 'environment:applyEdits',
  environmentCreate: 'environment:create',
  environmentDelete: 'environment:delete',

  flagsGet: 'flags:get',
  flagsSetOverride: 'flags:setOverride',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  /** main -> renderer: may the window close? The renderer answers on appCloseReply. */
  appBeforeClose: 'app:beforeClose',
  appCloseReply: 'app:closeReply',
  variablesPreview: 'variables:preview',
  variablesCopy: 'variables:copy',
  scriptCheck: 'script:check',

  /** main -> renderer: one step of a collection run finished. */
  eventRunProgress: 'event:runProgress',
  /** main -> renderer: workspaces, the active one, or which projects they hold changed. */
  eventWorkspaces: 'event:workspaces',
  /** main -> renderer: one project was rescanned or its git state moved. */
  eventProject: 'event:project',
  /** main -> renderer: settings changed. */
  eventSettings: 'event:settings',
  /** main -> renderer: a clone's progress. */
  eventGitProgress: 'event:gitProgress'
} as const

export type GitOperationView = 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert'

export interface GitStatusView {
  branch: string | null
  detached: boolean
  upstream: string | null
  /** Null, not 0, when there is no upstream or no commits yet. */
  ahead: number | null
  behind: number | null
  changed: number
  untracked: number
  conflicted: number
  clean: boolean
  /** True on a branch with no commits yet. */
  unborn: boolean
  /** True when the branch's upstream is gone from the remote. */
  upstreamGone: boolean
  /** A merge, rebase or the like left in progress, which blocks commits and pulls. */
  operation: GitOperationView | null
  remotes: string[]
  /** Changed files inside this project's own folder. */
  projectChanges: number
  /** Why the last background fetch failed, or null. */
  fetchProblem: string | null
}

/** Mirrors core's `ChangeKind`. */
export type ChangeKindView =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

/** One changed file in a repository, as the Changes drawer lists it. */
export interface ChangedFileView {
  /** Repo-relative, with `/`. */
  path: string
  origPath: string | null
  kind: ChangeKindView
  staged: boolean
  submodule: boolean
  /** The project it is in, or null for a file elsewhere in the repository. */
  projectId: string | null
  /** Starts checked: one of gta's own files in a project, and not a secret. */
  checkedByDefault: boolean
  /** A `.env` file, which holds secret values and is not meant to be committed. */
  secret: boolean
}

/** Everything the Changes drawer shows for one repository. */
export interface RepoChangesView {
  repoRoot: string
  /** The repository folder's name. */
  repoName: string
  status: GitStatusView
  identity: { name: string | null; email: string | null }
  /** The app's projects in this repository, with their folders from its root. */
  projects: Array<{ id: string; name: string; path: string }>
  files: ChangedFileView[]
  /** True when there were more changed files than are listed. */
  truncated: boolean
  /** Projects whose gta files git does not keep LF, and the notice is not dismissed. */
  lineEndingNotices: Array<{ projectId: string; name: string }>
}

/** Mirrors core's `FileDiff`. */
export interface FileDiffView {
  path: string
  origPath: string | null
  binary: boolean
  tooLarge: boolean
  hunks: Array<{
    header: string
    lines: Array<{
      kind: 'context' | 'add' | 'del' | 'meta'
      text: string
      oldLine: number | null
      newLine: number | null
    }>
  }>
}

/** Mirrors core's `CommitInfo`. */
export interface CommitView {
  oid: string
  shortOid: string
  author: string
  email: string
  date: string
  subject: string
  pushed: boolean
}

/** Mirrors core's `BranchInfo`. */
export interface BranchView {
  name: string
  /** For a branch only on a remote: that remote. */
  remote: string | null
  current: boolean
  upstream: string | null
  track: string
}

export type PullOutcomeView = 'up-to-date' | 'fast-forward' | 'rebased'

/** How a project's files are kept in git: LF or not. */
export interface LineEndingsView {
  /** False when the project is not in a repository. */
  isRepo: boolean
  covered: boolean
  hasBlock: boolean
  /** gta files git stores with CRLF, repo-relative. */
  crlfFiles: string[]
  /** The block the app adds to `.gitattributes`. */
  block: string
}

/** A clone's progress, from git's own output. */
export interface GitProgress {
  operation: 'clone'
  /** Where it is cloning into. */
  target: string
  phase: string
  percent: number | null
  /** True once it has finished, either way. */
  done: boolean
}

/** A named group of projects. It lives only in the app, never in a repository. */
export interface WorkspaceSummary {
  id: string
  name: string
  /** Its projects, in the order they were added. */
  projectIds: string[]
}

export interface WorkspacesState {
  activeWorkspaceId: string | null
  workspaces: WorkspaceSummary[]
  /** Every project of every workspace. */
  projects: ProjectView[]
}

/** A global project a project `uses:`. */
export interface GlobalProjectView {
  path: string
  name: string
  /** As written in `project.yml`, with `/`. */
  uses: string
  /** Its variables: shared by every project that uses it. */
  vars: Vars | null
  /** Its `project.yml` text, to edit its variables against. */
  source: string
}

/**
 * What a file is picked for: a project's `tls.ca` certificate, or an upload
 * in the body of a collection file's step — named from that file's project,
 * which may be a global one.
 */
export type PickFileRequest =
  { kind: 'certificate'; projectId: string } | { kind: 'upload'; collectionPath: string }

/** One file in `tls.ca` (SPEC.md §1.1), and what it holds. */
export interface CaFileView {
  /** As written in `tls.ca`, with `/`. */
  path: string
  /** Whose `project.yml` lists it. */
  source: 'project' | 'global'
  certificates: Array<{ subject: string; expires: string }>
  /** Why it cannot be used; null when it can. */
  problem: string | null
}

/** One project: a folder with `collections/`, and git if it is in a repository. */
export interface ProjectView {
  id: string
  workspaceId: string
  path: string
  /** `project.yml`'s name, else the folder's. */
  name: string
  /** False when the folder has gone: the entry is kept, not dropped. */
  available: boolean
  isRepo: boolean
  /** The repository's root — shared by every project in a monorepo. */
  repoRoot: string | null
  git: GitStatusView | null
  /** Why git state is unavailable, when it is. */
  gitNote: string | null
  /** Whether it has a `collections/` directory at all. */
  hasCollections: boolean
  collections: CollectionSummary[]
  /** Directories inside `collections/`, empty ones included. */
  directories: string[]
  /** Anything about the project that could not be read. */
  problems: LoadProblem[]
  /** `project.yml`, parsed, or null when there is none. */
  project: ProjectDoc | null
  /** Its text, to edit against; null when there is no file. */
  projectSource: string | null
  global: GlobalProjectView | null
  /** Environment files: the project's own, then its global project's. */
  environments: EnvironmentRef[]
  /** Request sets a use step can run: the project's own, then its global project's. */
  requestSets: RequestSetView[]
  /** Check files scripts can call as `checks.<name>`. */
  checks: string[]
  /** Files in `endpoints/`, the project's and its global project's, to open and edit. */
  endpointFiles: LibraryFileView[]
  /** Every endpoint base, the project's first: what a step's request is matched with. */
  endpoints: EndpointView[]
  /** Base collections a collection can `extends:`. */
  bases: LibraryFileView[]
  /** Certificates its requests trust besides the system's: `tls.ca`, its own then its global project's. */
  caFiles: CaFileView[]
  selectedEnvironment: string | null
  /** Background fetch interval, or null when off. Off by default. */
  autoFetchSeconds: number | null
  /** True while a fetch or pull is running on its repository. */
  busy: boolean
}

/** A request set, as a use step picks it and the step list shows it. */
export interface RequestSetView {
  /** As a use step names it: `login`, `auth/login`. */
  name: string
  path: string
  source: 'project' | 'global'
  /** The set's own name, else its file's. */
  title: string
  params: Record<string, ParamSpec>
  /** Its steps, for the list under a use step. */
  steps: Array<{ label: string; method: string }>
  /** Why it cannot be used, when it cannot. */
  problem?: string | undefined
}

/** What a new collection file is: a collection, a request set, an endpoints file or a base. */
export type LibraryKind = 'collection' | 'set' | 'endpoints' | 'base'

/** A collection file in one of a project's library directories: `endpoints/`, `bases/`. */
export interface LibraryFileView {
  /** As a collection names it: `authenticated`, `auth/admin`. */
  name: string
  path: string
  source: 'project' | 'global'
  title: string
  stepCount: number
  problem?: string | undefined
}

/** An endpoint base, as a step is matched with it (SPEC.md §2.6). */
export interface EndpointView {
  method: HttpMethod
  path: string
  /** The endpoints file it is in, and that file's name in `endpoints/`. */
  filePath: string
  fileName: string
  source: 'project' | 'global'
  /** What it brings: for the note under a step that uses it. */
  headers: string[]
  hasTests: boolean
}

/** Why a folder could not be added as it is, when the person can do something about it. */
export type AddProjectOutcome =
  { ok: true; project: ProjectView } | { ok: false; message: string; noCollections?: boolean }

/** Set (or, with `undefined`, remove) one field of `project.yml`. */
export interface ProjectEdit {
  key: 'name' | 'uses' | 'vars' | 'tls'
  value: unknown
}

export type Ok<T> = { ok: true } & T
/** `hint` says what to do next, when there is something to say. */
export type Err = { ok: false; message: string; hint?: string }
export type Result<T> = Ok<T> | Err

/**
 * One row of a collection's data file (SPEC.md §2.8), as a run takes it: its
 * values over the environment, and what reports call it.
 */
export interface DataRowInput {
  /** Where the values came from, for variable origins: `users.csv row 2`. */
  source: string
  vars: Record<string, VarValue>
  /** Its `iterationLabel`, when it has one. */
  label?: string | null
}

/** Which row of the data file a result ran with, from 1. */
export interface IterationRef {
  index: number
  of: number
  label: string | null
}

export interface RunStartRequest {
  runId: string
  step: Step
  /** The collection the step belongs to, for shared headers and settings. */
  collection?: Collection | null
  /** Path to the collection file; null for the scratchpad. */
  collectionPath?: string | null
  /** Environment to resolve variables against; null for none. */
  environment?: string | null
  /** Environment files as edited, saved or not; absent, they are read from disk. */
  environmentOverrides?: EnvironmentOverride[]
  /** The project's variables as edited; absent, read from `project.yml`. */
  projectVars?: Vars | null
  /** The data file row to run with; null for none; absent, the file's first row. */
  dataRow?: DataRowInput | null
}

export interface RunCollectionRequest {
  runId: string
  collection: Collection
  collectionPath: string | null
  environment: string | null
  /** Environment files as edited, saved or not; absent, they are read from disk. */
  environmentOverrides?: EnvironmentOverride[]
  /** The project's variables as edited; absent, read from `project.yml`. */
  projectVars?: Vars | null
  /** The data file row to run with, when not iterating; null for none. */
  dataRow?: DataRowInput | null
  /**
   * Every row of the data file, as edited: the collection runs once per row,
   * each with a fresh scope (SPEC.md §2.8). Progress says which row.
   */
  dataRows?: DataRowInput[]
}

/**
 * A project's feature flags for an environment (SPEC.md §2.9), as the app runs
 * with them: each value and where it came from.
 */
export interface FlagsView {
  environment: string | null
  values: Record<string, FlagValue>
  sources: Record<string, 'environment' | 'command' | 'override'>
  /** The overrides made in the app, which win over everything else. */
  overrides: Record<string, FlagValue>
  /** The environment's `flags.command`, and when it last ran; null without one. */
  command: { command: string; ranAt: number } | null
  /**
   * Why the command's values are missing — it failed, or the environment file
   * will not read. Runs go on with the fixed values and overrides.
   */
  error: string | null
}

export interface RunProgress {
  runId: string
  /** The step's place in its list: `steps` as sent, or `setup`/`teardown` when `result.stage` says. */
  index: number
  result: RunResult
  /** For a run over a data file: the row this result ran with. */
  iteration?: IterationRef
}

/** A collection's data file, for the editor: its text and its table, or why it is not one. */
export interface ReadDataResult {
  /** Absolute; null when the collection has no data file. */
  path: string | null
  /** The file exactly as it is on disk. */
  source: string
  table: DataTable | null
  /** Why the file is not a table — bad CSV or JSON — when it is not. */
  problem: string | null
}

export interface ReadCollectionResult {
  doc: Collection
  /** The file exactly as it is on disk, so the editor can detect outside changes. */
  source: string
  /** Environment files its project can use: its own, then its global project's. */
  environments: EnvironmentRef[]
  /** The project's `environments/` directory, whether or not it exists yet. */
  environmentsPath: string | null
  name: string
}

export type Unsubscribe = () => void

export interface DesktopApi {
  runStart(request: RunStartRequest): Promise<Result<{ result: RunResult }>>
  /** Run every step in order, sharing one variable scope. */
  runCollection(request: RunCollectionRequest): Promise<Result<{ summary: CollectionRunSummary }>>
  runCancel(runId: string): void
  /** Per-step results, delivered as they land rather than at the end. */
  onRunProgress(callback: (progress: RunProgress) => void): Unsubscribe

  workspaces: {
    list(): Promise<WorkspacesState>
    create(name: string): Promise<Result<{ id: string }>>
    rename(id: string, name: string): Promise<Result<Record<string, never>>>
    /** Forget a workspace and its projects; their files are left alone. */
    remove(id: string): Promise<void>
    setActive(id: string): Promise<void>
    onChanged(callback: (state: WorkspacesState) => void): Unsubscribe
  }

  projects: {
    /** Open a folder picker; resolves null when cancelled. */
    pick(): Promise<string | null>
    /**
     * Add a folder as a project: one with `collections/`, or a shared project with
     * the rest of one; `createCollections` makes a missing `collections/` otherwise.
     */
    add(
      workspaceId: string,
      folder: string,
      options?: { createCollections?: boolean }
    ): Promise<AddProjectOutcome>
    clone(
      workspaceId: string,
      url: string,
      parentDir: string
    ): Promise<Result<{ project: ProjectView }>>
    remove(id: string): Promise<void>
    reveal(path: string): Promise<void>
    selectEnvironment(id: string, environment: string | null): Promise<void>
    createDirectory(id: string, name: string): Promise<Result<{ path: string }>>
    /** A collection in `collections/`, or with `kind: 'set'` a request set in `requests/`. */
    createCollection(
      id: string,
      directory: string | null,
      name: string,
      kind?: LibraryKind
    ): Promise<Result<{ path: string }>>
    /**
     * Edit `project.yml`, only if it still reads `baseSource` (null: no file
     * yet). With `target: 'global'`, the project's global project's instead —
     * its variables only.
     */
    applyEdits(
      id: string,
      baseSource: string | null,
      edits: ProjectEdit[],
      target?: 'project' | 'global'
    ): Promise<Result<{ conflict: boolean; source: string; wrote: boolean }>>
    /**
     * Pick a file for a project to name: a certificate for its `tls.ca`, or a
     * file for a collection's body to upload. It resolves to the file's path
     * from the project folder, with `/`, or to null when cancelled.
     */
    pickFile(request: PickFileRequest): Promise<Result<{ path: string | null }>>
    onUpdated(callback: (project: ProjectView) => void): Unsubscribe
  }

  /** The repository a project is in: every call names the project. */
  git: {
    fetch(projectId: string): Promise<Result<Record<string, never>>>
    /** Fast-forward, or replay local commits on top when both sides moved on. */
    pull(projectId: string): Promise<Result<{ outcome: PullOutcomeView; message: string }>>
    /** Push the branch; `remote` chooses where to publish one with no upstream yet. */
    push(projectId: string, remote?: string | null): Promise<Result<{ message: string }>>
    changes(projectId: string): Promise<Result<{ changes: RepoChangesView }>>
    diff(projectId: string, path: string): Promise<Result<{ diff: FileDiffView }>>
    /** Commit these repo-relative paths as they are on disk, and nothing else. */
    commit(
      projectId: string,
      paths: string[],
      message: string
    ): Promise<Result<{ oid: string; shortOid: string }>>
    /** Put a file back as the last commit has it; the version on disk goes to the Trash. */
    discard(projectId: string, path: string): Promise<Result<Record<string, never>>>
    log(
      projectId: string,
      skip?: number
    ): Promise<Result<{ commits: CommitView[]; hasMore: boolean }>>
    branches(projectId: string): Promise<Result<{ branches: BranchView[]; remotes: string[] }>>
    createBranch(projectId: string, name: string): Promise<Result<Record<string, never>>>
    /** Switch to a local branch, or with `remote` to that remote's branch as a new local one. */
    switchBranch(
      projectId: string,
      name: string,
      remote?: string | null
    ): Promise<Result<Record<string, never>>>
    /** Save a name and email in the global git config. */
    setIdentity(
      projectId: string,
      name: string,
      email: string
    ): Promise<Result<Record<string, never>>>
    lineEndings(projectId: string): Promise<Result<{ lineEndings: LineEndingsView }>>
    /** Add the LF block to the project's `.gitattributes`. */
    addAttributes(projectId: string): Promise<Result<{ lineEndings: LineEndingsView }>>
    /** Rewrite the files git stores with CRLF as LF, ready to commit. */
    convertToLf(projectId: string): Promise<Result<{ files: string[] }>>
    /** "Not now" on the Changes drawer's line-endings notice. */
    dismissLineEndings(projectId: string): Promise<void>
    onProgress(callback: (progress: GitProgress) => void): Unsubscribe
  }

  collection: {
    read(path: string): Promise<Result<ReadCollectionResult>>
    /**
     * Apply a batch of edits to one file, but only if it still reads
     * `baseSource`. On `conflict`, nothing was written and `source` is the file
     * as it is now.
     */
    applyEdits(
      path: string,
      baseSource: string,
      edits: CollectionEdit[]
    ): Promise<Result<{ conflict: boolean; source: string; wrote: boolean }>>
  }

  data: {
    /** The data file beside the collection at `collectionPath`, if it has one. */
    read(collectionPath: string): Promise<Result<ReadDataResult>>
    /** Write an edited table, only against the text it was read from. */
    apply(
      path: string,
      baseSource: string,
      table: DataTable
    ): Promise<Result<{ conflict: boolean; source: string; wrote: boolean }>>
    /** Write the file's text as typed in the raw editor, only against the text it was read from. */
    applyText(
      path: string,
      baseSource: string,
      text: string
    ): Promise<Result<{ conflict: boolean; source: string; wrote: boolean }>>
    /** Give the collection a CSV data file with one column and one empty row. */
    create(collectionPath: string, column: string): Promise<Result<{ path: string }>>
    remove(path: string): Promise<Result<Record<string, never>>>
  }

  environment: {
    read(path: string): Promise<Result<ReadEnvironmentResult>>
    /** As `collection.applyEdits`, for an environment file. */
    applyEdits(
      path: string,
      baseSource: string,
      edits: EnvironmentEdit[]
    ): Promise<Result<{ conflict: boolean; source: string; wrote: boolean }>>
    /**
     * Create an environment for the collection at `collectionPath`: in its
     * `environments/`, or a new one beside its `collections/`.
     */
    create(collectionPath: string, name: string): Promise<Result<{ path: string }>>
    remove(path: string): Promise<Result<Record<string, never>>>
  }

  flags: {
    /**
     * The feature flags of the project at `root` for `environment`. `refresh`
     * runs the environment's `flags.command` again.
     */
    get(
      root: string,
      environment: string | null,
      options?: { refresh?: boolean; environmentOverrides?: EnvironmentOverride[] }
    ): Promise<Result<{ flags: FlagsView }>>
    /** Override a flag in the app, or clear the override with null. */
    setOverride(
      root: string,
      environment: string | null,
      name: string,
      value: FlagValue | null
    ): Promise<Result<{ flags: FlagsView }>>
  }

  settings: {
    get(): Promise<Settings>
    set(patch: SettingsPatch): Promise<Result<{ settings: Settings }>>
    onChanged(callback: (settings: Settings) => void): Unsubscribe
  }

  app: {
    /**
     * Answer "may the window close?". The handler flushes or reports what is
     * unsaved; main decides whether to ask.
     */
    onBeforeClose(handler: (request: { save: boolean }) => Promise<CloseCheck>): Unsubscribe
  }

  variables: {
    /** What each variable in scope resolves to, for display in the editor. */
    preview(request: PreviewRequest): Promise<VariablePreviews>
    /**
     * Copy a variable's value to the clipboard.
     *
     * Main resolves and writes it directly, so a secret's value reaches the
     * clipboard without ever passing through the renderer.
     */
    copy(request: PreviewRequest, name: string): Promise<boolean>
  }

  script: {
    /**
     * Where a script stops parsing, or null when it parses. Checked by the same
     * V8 parser that runs it, so the editor and a run never disagree.
     */
    check(code: string): Promise<ScriptSyntaxProblem | null>
  }
}

/** Mirrors core's `SyntaxProblem`: 1-based line and column. */
export interface ScriptSyntaxProblem {
  line: number
  column: number
  length: number
  message: string
}

/** One change to a collection file; mirrors core's `CollectionEdit`. */
/** Collection-level fields the app edits; mirrors core's `COLLECTION_FIELDS`. */
export type CollectionField =
  | 'id'
  | 'tags'
  | 'stepTags'
  | 'exclude'
  | 'flags'
  | 'headers'
  | 'settings'
  | 'vars'
  | 'before'
  | 'tests'
  | 'params'
  | 'extends'

/** Set (or, with `undefined`, remove) one field of an environment file. */
export interface EnvironmentEdit {
  key: 'name' | 'vars' | 'flags'
  value: unknown
}

export interface ReadEnvironmentResult {
  doc: EnvironmentDoc
  source: string
}

/** An environment as it is in the editor, for a run or preview to use instead of the file. */
export interface EnvironmentOverride {
  path: string
  doc: EnvironmentDoc
}

/** A step edit is to `steps` unless `list` names `setup` or `teardown`. */
export type CollectionEdit =
  | { type: 'editStep'; index: number; step: Step; list?: StepList }
  | { type: 'insertStep'; index: number; step: Step; list?: StepList }
  | { type: 'removeStep'; index: number; list?: StepList }
  | { type: 'moveStep'; from: number; to: number; list?: StepList }
  | { type: 'editCollection'; key: CollectionField; value: unknown }

/** The renderer's answer to "may the window close?". */
export interface CloseCheck {
  /** Collection names with edits that are not on disk. Empty: safe to close. */
  unsaved: string[]
}

export interface PreviewRequest {
  step: Step
  collectionPath: string | null
  environment: string | null
  /** The collection's variables and `before.script` as edited, saved or not. */
  collection?: {
    vars?: Vars | undefined
    script?: string | undefined
    extends?: string | undefined
  }
  /** Environment files as edited, saved or not; absent, they are read from disk. */
  environmentOverrides?: EnvironmentOverride[]
  /** The project's variables as edited; absent, read from `project.yml`. */
  projectVars?: Vars | null
  /** The data file row to preview with; null for none; absent, the file's first row. */
  dataRow?: DataRowInput | null
}
