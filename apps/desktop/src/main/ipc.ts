import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  CollectionSchema,
  StepSchema,
  VarsSchema,
  EnvironmentDocSchema,
  ENVIRONMENT_FIELDS,
  createEnvironmentFile,
  deleteEnvironmentFile,
  environmentsDirFor,
  buildScope,
  checkScriptSyntax,
  COLLECTION_FIELDS,
  STEP_LISTS,
  FLAG_NAME_PATTERN,
  FlagValueSchema,
  GitCommandError,
  GLOBAL_FILE,
  isAbsoluteAnywhere,
  isInside,
  projectRootOf,
  PROJECT_FIELDS,
  readProject,
  relativePosix,
  samePath,
  previewVariables,
  applyDataTable,
  canonical,
  applyDataText,
  createDataFile,
  DOC_EXTENSION,
  findDataFile,
  idOfFile,
  readDataTable,
  sourceLine,
  VarValueSchema,
  type CollectionRunSummary,
  type RunResult,
  type ScopeContext,
  type VariablePreviews
} from '@schwabyio/gravity-core'
import {
  IpcChannel,
  type AddProjectsOutcome,
  type ConsoleEvent,
  type ConsoleRunKind,
  type PreviewRequest,
  type Result,
  type RunCollectionRequest,
  type RunStartRequest,
  type WorkspacesState
} from '../shared/ipc.js'
import {
  applyEdits,
  applyEnvironmentFileEdits,
  readCollectionFile,
  readEnvironmentFile
} from './collectionFiles.js'
import { settingsStore } from './settingsStore.js'
import { openInEditor } from './editor.js'
import { runSupervisor } from './runSupervisor.js'
import { flagService } from './flagService.js'
import type { ProjectService } from './projectService.js'

const index = z.number().int().nonnegative()
/** Which of the collection's step lists a step edit is to; absent, `steps`. */
const list = z.enum(STEP_LISTS).optional()

/** Edits arrive from the renderer, so each is validated before any file is touched. */
const EditsSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('editStep'), index, step: StepSchema, list }),
    z.object({ type: z.literal('insertStep'), index, step: StepSchema, list }),
    z.object({ type: z.literal('removeStep'), index, list }),
    z.object({ type: z.literal('moveStep'), from: index, to: index, list }),
    z.object({
      type: z.literal('editCollection'),
      key: z.enum(COLLECTION_FIELDS),
      value: z.unknown()
    })
  ])
)

const EnvironmentEditsSchema = z.array(
  z.object({ key: z.enum(ENVIRONMENT_FIELDS), value: z.unknown() })
)

const ProjectEditsSchema = z.array(z.object({ key: z.enum(PROJECT_FIELDS), value: z.unknown() }))

const optionalString = (value: unknown) => (typeof value === 'string' ? value : null)

/** A data file row from the renderer: plain values only (SPEC.md §2.8). */
const DataRowSchema = z.object({
  source: z.string().max(500),
  vars: z.record(z.string(), VarValueSchema),
  label: z.string().nullable().optional()
})

/** A data file's table from the renderer's grid, checked before anything is written. */
const DataTableSchema = z.object({
  kind: z.enum(['csv', 'json']),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), VarValueSchema))
})

/** A data row as sent: absent stays absent (the file's first row), null is none. */
const dataRowOf = (value: unknown) =>
  value === undefined ? undefined : value === null ? null : DataRowSchema.parse(value)

/** Wrap a handler so a thrown error becomes a typed failure, never an IPC rejection. */
const guard =
  <A extends unknown[], T extends object>(handler: (...args: A) => Promise<T>) =>
  async (...args: A): Promise<Result<T>> => {
    try {
      return { ok: true, ...(await handler(...args)) }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        // What to do next, when git's message does not say.
        ...(cause instanceof GitCommandError && cause.hint ? { hint: cause.hint } : {})
      }
    }
  }

/**
 * A path in a repository as git reports it: relative, with `/`. Main also
 * checks it is among the repository's changes before acting on it.
 */
const RepoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\0') && !isAbsoluteAnywhere(value) && !value.split(/[\\/]/).includes('..'),
    'Not a path in the repository'
  )

const CommitSchema = z.object({
  paths: z.array(RepoPathSchema).min(1).max(50_000),
  message: z.string().trim().min(1, 'Write a commit message first').max(20_000)
})

const IdentitySchema = z.object({
  name: z.string().trim().min(1, 'Add your name').max(200),
  email: z
    .string()
    .trim()
    .max(320)
    .regex(/^[^\s<>@]+@[^\s<>@]+$/, 'That does not look like an email address')
})

/** A remote or branch name from the renderer; git checks it further. */
const RefNameSchema = z.string().trim().min(1).max(250)

export function registerIpc(projects: ProjectService): void {
  /** Build a scope context from a renderer payload, confined to the projects. */
  const scopeContextOf = (payload: {
    collectionPath?: string | null
    environment?: string | null
    collection?: { vars?: unknown; extends?: unknown }
    environmentOverrides?: unknown
    projectVars?: unknown
    dataRow?: unknown
  }): ScopeContext | null => {
    if (typeof payload?.collectionPath !== 'string') return null
    // The editor's variables, when sent, are what the preview should show.
    const vars = payload.collection ? VarsSchema.safeParse(payload.collection.vars ?? {}) : null
    const projectVars = projectVarsOf(payload.projectVars)
    return {
      collectionPath: assertInProjects(payload.collectionPath),
      environmentName: optionalString(payload.environment),
      ...(vars?.success ? { collectionVars: vars.data } : {}),
      ...(payload.collection
        ? {
            collectionExtends:
              typeof payload.collection.extends === 'string' ? payload.collection.extends : null
          }
        : {}),
      ...(projectVars !== undefined ? { projectVars } : {}),
      ...(dataRowOf(payload.dataRow) !== undefined ? { dataRow: dataRowOf(payload.dataRow)! } : {}),
      environments: environmentOverridesOf(payload.environmentOverrides)
    }
  }

  /** Edited environment files sent with a run or preview, checked like files would be. */
  const environmentOverridesOf = (value: unknown) =>
    (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const { path: file, doc } = item as { path?: unknown; doc?: unknown }
      if (typeof file !== 'string') return []
      return [{ path: assertInProjects(file), doc: EnvironmentDocSchema.parse(doc) }]
    })

  /**
   * The feature flag values a run of a collection file uses: its project's,
   * for the environment chosen — fixed values, the command's last output,
   * the app's overrides. Null for a request with no collection.
   */
  const flagsForRun = async (
    collectionPath: string | null,
    payload: { environment?: unknown; environmentOverrides?: unknown }
  ) =>
    collectionPath
      ? flagService.values(
          projectRootOf(collectionPath) ?? path.dirname(collectionPath),
          optionalString(payload?.environment),
          environmentOverridesOf(payload?.environmentOverrides)
        )
      : null

  /** Edited project variables: absent means "read project.yml". */
  const projectVarsOf = (value: unknown) =>
    value === undefined ? undefined : value === null ? null : VarsSchema.parse(value)

  /** Rescan the projects a path is in, so their views pick up a file added or removed. */
  const refreshProjectsOf = async (target: string) => {
    const owners = projects
      .state()
      .projects.filter(
        (project) =>
          isInside(project.path, target) ||
          (project.global !== null && isInside(project.global.path, target))
      )
    await Promise.all(owners.map((project) => projects.refresh(project.id)))
  }

  /**
   * Paths arrive from the renderer, so every filesystem call is confined to a
   * project — or a global project one uses. Without this, a compromised
   * renderer could ask main to read anything on the machine. Compared with
   * `isInside`, never by string prefix: on Windows the same folder can be
   * spelled with other cases and separators.
   */
  const assertInProjects = (target: string): string => {
    if (!projects.roots().some((root) => isInside(root, target))) {
      throw new Error('Path is outside every open project')
    }
    return target
  }

  ipcMain.handle(
    IpcChannel.runStart,
    guard(async (_event, payload: RunStartRequest) => {
      const runId = String(payload?.runId ?? '')
      if (runId === '') throw new Error('Missing runId')
      return consoleRun(runId, 'send', payload, async () => {
        const step = StepSchema.parse(payload?.step)
        const collection = payload?.collection ? CollectionSchema.parse(payload.collection) : null
        const collectionPath =
          typeof payload?.collectionPath === 'string'
            ? assertInProjects(payload.collectionPath)
            : null
        const result = await runSupervisor.run(runId, step, collection, collectionPath, {
          environment: optionalString(payload?.environment),
          environmentOverrides: environmentOverridesOf(payload?.environmentOverrides),
          projectVars: projectVarsOf(payload?.projectVars),
          flags: await flagsForRun(collectionPath, payload),
          ...(payload?.dataRow !== undefined ? { dataRow: dataRowOf(payload.dataRow)! } : {})
        })
        tellConsole({ kind: 'result', runId, at: Date.now(), result })
        return { result }
      })
    })
  )

  ipcMain.handle(
    IpcChannel.runCollection,
    guard(async (_event, payload: RunCollectionRequest) => {
      const runId = String(payload?.runId ?? '')
      if (runId === '') throw new Error('Missing runId')
      // Steps run on their own keep the connections Sends hold; Run all does not.
      const run = payload?.keepConnections === true ? 'steps' : 'all'
      return consoleRun(runId, run, payload, async () => {
        const collection = CollectionSchema.parse(payload?.collection)
        const collectionPath =
          typeof payload?.collectionPath === 'string'
            ? assertInProjects(payload.collectionPath)
            : null
        // Its results reach the console as they land, through `broadcastRunProgress`.
        return {
          summary: await runSupervisor.runCollection(runId, collection, collectionPath, {
            environment: optionalString(payload?.environment),
            environmentOverrides: environmentOverridesOf(payload?.environmentOverrides),
            projectVars: projectVarsOf(payload?.projectVars),
            flags: await flagsForRun(collectionPath, payload),
            ...(payload?.dataRow !== undefined ? { dataRow: dataRowOf(payload.dataRow)! } : {}),
            ...(payload?.dataRows !== undefined
              ? { dataRows: z.array(DataRowSchema).min(1).parse(payload.dataRows) }
              : {}),
            ...(payload?.keepConnections === true ? { keepConnections: true } : {})
          })
        }
      })
    })
  )

  /* ---------------------------------------------------------------- data -- */

  /** A data file path from the renderer: a `.csv` or `.json` in an open project. */
  const dataFileOf = (value: unknown): string => {
    const file = assertInProjects(String(value))
    if (!/\.(csv|json)$/.test(file)) throw new Error('Not a data file')
    return file
  }

  ipcMain.handle(
    IpcChannel.dataRead,
    guard(async (_event, collectionPath: unknown) => {
      const collection = assertInProjects(String(collectionPath))
      if (!collection.endsWith(DOC_EXTENSION)) throw new Error('Not a collection file')
      const file = await findDataFile(collection)
      if (!file) return { path: null, source: '', table: null, problem: null }
      try {
        const { source, table } = await readDataTable(file)
        return { path: file, source, table, problem: null }
      } catch (cause) {
        // A file that is not a table still opens, with why, so it can be fixed elsewhere.
        return {
          path: file,
          source: await fs.readFile(file, 'utf8').catch(() => ''),
          table: null,
          problem: (cause as Error).message
        }
      }
    })
  )

  ipcMain.handle(
    IpcChannel.dataApply,
    guard(async (_event, file: unknown, baseSource: unknown, table: unknown) => {
      if (typeof baseSource !== 'string')
        throw new Error('Missing the text the edits were made against')
      const target = dataFileOf(file)
      const outcome = await applyDataTable(target, baseSource, DataTableSchema.parse(table))
      if (outcome.ok && outcome.wrote) await refreshProjectsOf(target)
      return outcome.ok
        ? { conflict: false, source: outcome.source, wrote: outcome.wrote }
        : { conflict: true, source: outcome.source, wrote: false }
    })
  )

  ipcMain.handle(
    IpcChannel.dataApplyText,
    guard(async (_event, file: unknown, baseSource: unknown, text: unknown) => {
      if (typeof baseSource !== 'string' || typeof text !== 'string')
        throw new Error('Missing the text to write, or the text it was edited from')
      const target = dataFileOf(file)
      const outcome = await applyDataText(target, baseSource, text)
      if (outcome.ok && outcome.wrote) await refreshProjectsOf(target)
      return outcome.ok
        ? { conflict: false, source: outcome.source, wrote: outcome.wrote }
        : { conflict: true, source: outcome.source, wrote: false }
    })
  )

  ipcMain.handle(
    IpcChannel.dataCreate,
    guard(async (_event, collectionPath: unknown, column: unknown) => {
      const collection = assertInProjects(String(collectionPath))
      if (!collection.endsWith(DOC_EXTENSION)) throw new Error('Not a collection file')
      const created = await createDataFile(collection, String(column ?? ''))
      await refreshProjectsOf(created)
      return { path: created }
    })
  )

  ipcMain.handle(
    IpcChannel.dataDelete,
    guard(async (_event, file: unknown) => {
      const target = dataFileOf(file)
      await fs.rm(target)
      await refreshProjectsOf(target)
      return {}
    })
  )

  /* --------------------------------------------------------------- flags -- */

  /** A project folder from the renderer: one of the open projects, or its global project. */
  const projectRootOf_ = (value: unknown): string => {
    if (typeof value !== 'string') throw new Error('Missing project folder')
    return assertInProjects(value)
  }

  ipcMain.handle(
    IpcChannel.flagsGet,
    guard(async (_event, root: unknown, environment: unknown, options: unknown) => {
      const { refresh, environmentOverrides } = (options ?? {}) as {
        refresh?: unknown
        environmentOverrides?: unknown
      }
      return {
        flags: await flagService.view(projectRootOf_(root), optionalString(environment), {
          refresh: refresh === true,
          environments: environmentOverridesOf(environmentOverrides)
        })
      }
    })
  )

  ipcMain.handle(
    IpcChannel.flagsSetOverride,
    guard(async (_event, root: unknown, environment: unknown, name: unknown, value: unknown) => {
      const folder = projectRootOf_(root)
      const flag = z.string().regex(FLAG_NAME_PATTERN).parse(name)
      await flagService.setOverride(
        folder,
        optionalString(environment),
        flag,
        value === null ? null : FlagValueSchema.parse(value)
      )
      return { flags: await flagService.view(folder, optionalString(environment)) }
    })
  )

  ipcMain.on(IpcChannel.runCancel, (_event, runId: unknown) => {
    if (typeof runId === 'string' && runId !== '') runSupervisor.cancel(runId)
  })

  ipcMain.on(IpcChannel.runStop, (_event, runId: unknown) => {
    if (typeof runId === 'string' && runId !== '') runSupervisor.stop(runId)
  })

  ipcMain.on(IpcChannel.connectionClose, (_event, collectionPath: unknown, name: unknown) => {
    if (typeof collectionPath !== 'string' || collectionPath === '') return
    runSupervisor.closeConnection(collectionPath, typeof name === 'string' ? name : undefined)
  })

  /* ---------------------------------------------------------- workspaces -- */

  ipcMain.handle(IpcChannel.workspacesList, (): Promise<WorkspacesState> => projects.loadedState())

  ipcMain.handle(
    IpcChannel.workspaceCreate,
    guard(async (_event, name: unknown) => ({
      id: await projects.createWorkspace(String(name ?? ''))
    }))
  )

  ipcMain.handle(
    IpcChannel.workspaceRename,
    guard(async (_event, id: unknown, name: unknown) => {
      await projects.renameWorkspace(String(id), String(name ?? ''))
      return {}
    })
  )

  ipcMain.handle(IpcChannel.workspaceRemove, async (_event, id: unknown) => {
    if (typeof id === 'string') await projects.removeWorkspace(id)
  })

  ipcMain.handle(IpcChannel.workspaceSetActive, async (_event, id: unknown) => {
    if (typeof id === 'string') await projects.setActive(id)
  })

  /* ------------------------------------------------------------ projects -- */

  ipcMain.handle(IpcChannel.projectPick, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Add a project — the folder holding collections/, or a monorepo of them',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(
    IpcChannel.projectAdd,
    async (_event, workspaceId: unknown, folder: unknown, options: unknown) => {
      if (typeof workspaceId !== 'string') return { ok: false, message: 'Missing workspace' }
      if (typeof folder !== 'string' || folder === '')
        return { ok: false, message: 'Missing folder' }
      const asked = (typeof options === 'object' && options !== null ? options : {}) as {
        createCollections?: unknown
        alone?: unknown
      }
      try {
        return await projects.addProject(workspaceId, folder, {
          createCollections: asked.createCollections === true,
          alone: asked.alone === true
        })
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
    }
  )

  ipcMain.handle(
    IpcChannel.projectAddAll,
    async (_event, workspaceId: unknown, folder: unknown): Promise<AddProjectsOutcome> => {
      if (typeof workspaceId !== 'string') return { ok: false, message: 'Missing workspace' }
      if (typeof folder !== 'string' || folder === '')
        return { ok: false, message: 'Missing folder' }
      try {
        return await projects.addProjectsIn(workspaceId, folder)
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
    }
  )

  ipcMain.handle(
    IpcChannel.projectClone,
    guard(async (_event, workspaceId: unknown, url: unknown, parentDir: unknown) => {
      if (typeof url !== 'string' || url.trim() === '') throw new Error('Missing repository URL')
      if (typeof parentDir !== 'string' || parentDir === '') throw new Error('Missing folder')
      return await projects.cloneInto(String(workspaceId), url.trim(), parentDir)
    })
  )

  ipcMain.handle(
    IpcChannel.projectRemove,
    guard(async (_event, id: unknown) => {
      if (typeof id === 'string') await projects.removeProject(id)
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.projectRenameFolder,
    guard(async (_event, id: unknown, name: unknown, to: unknown) => ({
      path: await projects.renameFolder(String(id), String(name ?? ''), String(to ?? ''))
    }))
  )

  ipcMain.handle(
    IpcChannel.projectDeleteFolder,
    guard(async (_event, id: unknown, name: unknown) => {
      await projects.deleteFolder(String(id), String(name ?? ''))
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.projectRenameScratchPad,
    guard(async (_event, id: unknown, name: unknown) => ({
      path: (await projects.renameScratchPad(String(id), String(name ?? ''))).path
    }))
  )

  ipcMain.handle(
    IpcChannel.projectCreateScratchPad,
    guard(async (_event, workspaceId: unknown, name: unknown) => ({
      id: (await projects.createScratchPad(String(workspaceId), String(name ?? ''))).id
    }))
  )

  ipcMain.handle(
    IpcChannel.projectSelectEnvironment,
    async (_event, id: unknown, environment: unknown) => {
      if (typeof id !== 'string') return
      await projects.selectEnvironment(
        id,
        typeof environment === 'string' && environment !== '' ? environment : null
      )
    }
  )

  ipcMain.handle(IpcChannel.projectReveal, async (_event, target: unknown) => {
    if (typeof target === 'string') shell.showItemInFolder(assertInProjects(target))
  })

  ipcMain.handle(
    IpcChannel.projectCreateDirectory,
    guard(async (_event, id: unknown, name: unknown) => ({
      path: await projects.createDirectory(String(id), String(name ?? ''))
    }))
  )

  ipcMain.handle(
    IpcChannel.projectCreateCollection,
    guard(async (_event, id: unknown, directory: unknown, name: unknown, kind: unknown) => ({
      path: await projects.createCollection(
        String(id),
        optionalString(directory),
        String(name ?? ''),
        kind === 'set' || kind === 'endpoints' || kind === 'base' ? kind : 'collection'
      )
    }))
  )

  ipcMain.handle(
    IpcChannel.projectApplyEdits,
    guard(async (_event, id: unknown, baseSource: unknown, edits: unknown, target: unknown) => {
      if (baseSource !== null && typeof baseSource !== 'string')
        throw new Error('Missing the text the edits were made against')
      const outcome = await projects.applyProjectEdits(
        String(id),
        baseSource,
        ProjectEditsSchema.parse(edits),
        target === 'global' ? 'global' : 'project'
      )
      return outcome.ok
        ? { conflict: false, source: outcome.source, wrote: outcome.wrote }
        : { conflict: true, source: outcome.source, wrote: false }
    })
  )

  ipcMain.handle(
    IpcChannel.projectPickFile,
    guard(async (event, request: unknown): Promise<{ path: string | null }> => {
      const { kind, root } = pickRoot(request)
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title:
          kind === 'certificate'
            ? 'Trust a CA certificate'
            : kind === 'global'
              ? 'Choose the global project this one uses'
              : 'Choose a file to upload',
        // A global project is usually beside this one, not in it.
        defaultPath: kind === 'global' ? path.dirname(root) : root,
        properties: [kind === 'global' ? 'openDirectory' : 'openFile'] as Array<
          'openFile' | 'openDirectory'
        >,
        filters:
          kind === 'certificate'
            ? [
                { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'der'] },
                { name: 'All files', extensions: ['*'] }
              ]
            : []
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      const picked = result.canceled ? undefined : result.filePaths[0]
      if (!picked) return { path: null }
      // Spelled as the project root is: through symlinks (/var is /private/var on
      // macOS), and on Windows with long names, never 8.3 ones like RUNNER~1.
      const file = await canonical(picked)
      if (kind === 'global' && samePath(file, root)) {
        throw new Error('A project cannot use itself as its global project')
      }
      // One of the global project's, not the project's own: named as its (SPEC.md §2.2).
      if (kind === 'upload' && !isInside(root, file)) {
        const { global } = await readProject(root)
        if (global && isInside(global.root, file)) {
          return { path: `${GLOBAL_FILE}${relativePosix(global.root, file)}` }
        }
      }
      // Written relative so it works on every machine; another drive has no relative path.
      if (path.isAbsolute(path.relative(root, file))) {
        throw new Error(
          `The ${kind === 'global' ? 'folder' : 'file'} must be on the same drive as the project, so ${
            kind === 'certificate' ? 'tls.ca' : kind === 'global' ? 'uses:' : 'the collection'
          } can name it with a relative path`
        )
      }
      return { path: relativePosix(root, file) }
    })
  )

  /** The folder a picked file is named from: a known project's, or its global project's. */
  const pickRoot = (
    request: unknown
  ): { kind: 'certificate' | 'upload' | 'global'; root: string } => {
    const asked = (request ?? {}) as {
      kind?: unknown
      projectId?: unknown
      collectionPath?: unknown
    }
    if (asked.kind === 'certificate' || asked.kind === 'global') {
      const view = projects.project(String(asked.projectId))
      if (!view) throw new Error('Unknown project')
      return { kind: asked.kind, root: view.path }
    }
    if (asked.kind === 'upload' && typeof asked.collectionPath === 'string') {
      const root = projectRootOf(asked.collectionPath) ?? path.dirname(asked.collectionPath)
      if (!projects.roots().some((known) => samePath(known, root))) {
        throw new Error('That collection is not in a project the app has open')
      }
      return { kind: 'upload', root }
    }
    throw new Error('Unknown file request')
  }

  /* ----------------------------------------------------------------- git -- */

  ipcMain.handle(
    IpcChannel.gitFetch,
    guard(async (_event, id: unknown) => {
      await projects.fetch(String(id))
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.gitPull,
    guard(async (_event, id: unknown) => projects.pull(String(id)))
  )

  ipcMain.handle(
    IpcChannel.gitPush,
    guard(async (_event, id: unknown, remote: unknown) =>
      projects.push(String(id), remote == null ? null : RefNameSchema.parse(remote))
    )
  )

  ipcMain.handle(
    IpcChannel.gitChanges,
    guard(async (_event, id: unknown) => ({ changes: await projects.changes(String(id)) }))
  )

  ipcMain.handle(
    IpcChannel.gitDiff,
    guard(async (_event, id: unknown, file: unknown) => ({
      diff: await projects.diff(String(id), RepoPathSchema.parse(file))
    }))
  )

  ipcMain.handle(
    IpcChannel.gitCommit,
    guard(async (_event, id: unknown, paths: unknown, message: unknown) => {
      const request = CommitSchema.parse({ paths, message })
      return projects.commit(String(id), request.paths, request.message)
    })
  )

  ipcMain.handle(
    IpcChannel.gitDiscard,
    guard(async (_event, id: unknown, file: unknown) => {
      await projects.discard(String(id), RepoPathSchema.parse(file))
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.gitLog,
    guard(async (_event, id: unknown, skip: unknown) =>
      projects.log(
        String(id),
        z
          .number()
          .int()
          .min(0)
          .catch(0)
          .parse(skip ?? 0)
      )
    )
  )

  ipcMain.handle(
    IpcChannel.gitBranches,
    guard(async (_event, id: unknown) => projects.branches(String(id)))
  )

  ipcMain.handle(
    IpcChannel.gitCreateBranch,
    guard(async (_event, id: unknown, name: unknown) => {
      await projects.createBranch(String(id), RefNameSchema.parse(name))
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.gitSwitchBranch,
    guard(async (_event, id: unknown, name: unknown, remote: unknown) => {
      await projects.switchBranch(
        String(id),
        RefNameSchema.parse(name),
        remote == null ? null : RefNameSchema.parse(remote)
      )
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.gitSetIdentity,
    guard(async (_event, id: unknown, name: unknown, email: unknown) => {
      const identity = IdentitySchema.parse({ name, email })
      await projects.setIdentity(String(id), identity.name, identity.email)
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.gitLineEndings,
    guard(async (_event, id: unknown) => ({ lineEndings: await projects.lineEndings(String(id)) }))
  )

  ipcMain.handle(
    IpcChannel.gitAddAttributes,
    guard(async (_event, id: unknown) => ({
      lineEndings: await projects.addAttributes(String(id))
    }))
  )

  ipcMain.handle(
    IpcChannel.gitConvertToLf,
    guard(async (_event, id: unknown) => ({ files: await projects.convertToLf(String(id)) }))
  )

  ipcMain.handle(IpcChannel.gitDismissLineEndings, async (_event, id: unknown) => {
    if (typeof id === 'string') await projects.dismissLineEndingsNotice(id)
  })

  ipcMain.handle(
    IpcChannel.collectionRead,
    guard(async (_event, file: unknown) => readCollectionFile(assertInProjects(String(file))))
  )

  ipcMain.handle(
    IpcChannel.collectionApplyEdits,
    guard(async (_event, file: unknown, baseSource: unknown, edits: unknown) => {
      if (typeof baseSource !== 'string')
        throw new Error('Missing the text the edits were made against')
      const target = assertInProjects(String(file))
      const outcome = await applyEdits(target, baseSource, EditsSchema.parse(edits))
      return outcome.ok
        ? { conflict: false, source: outcome.source, wrote: outcome.wrote }
        : { conflict: true, source: outcome.source, wrote: false }
    })
  )

  // Each names a collection file of a project in a workspace; the service refuses any other.
  ipcMain.handle(
    IpcChannel.collectionRename,
    guard(async (_event, file: unknown, id: unknown) => ({
      path: await projects.renameCollection(assertInProjects(String(file)), String(id ?? ''))
    }))
  )

  ipcMain.handle(
    IpcChannel.collectionCopy,
    guard(async (_event, file: unknown, projectId: unknown, directory: unknown, move: unknown) => ({
      path: await projects.copyCollection(
        assertInProjects(String(file)),
        String(projectId),
        optionalString(directory),
        move === true
      )
    }))
  )

  ipcMain.handle(
    IpcChannel.collectionMoveToFolder,
    guard(async (_event, file: unknown, folder: unknown) => ({
      path: await projects.moveToFolder(assertInProjects(String(file)), optionalString(folder))
    }))
  )

  ipcMain.handle(
    IpcChannel.collectionCommitted,
    guard(async (_event, file: unknown) => ({
      doc: await projects.committedDoc(assertInProjects(String(file)))
    }))
  )

  ipcMain.handle(
    IpcChannel.collectionDelete,
    guard(async (_event, file: unknown) => {
      await projects.deleteCollection(assertInProjects(String(file)))
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.environmentRead,
    guard(async (_event, file: unknown) => readEnvironmentFile(assertInProjects(String(file))))
  )

  ipcMain.handle(
    IpcChannel.environmentApplyEdits,
    guard(async (_event, file: unknown, baseSource: unknown, edits: unknown) => {
      if (typeof baseSource !== 'string')
        throw new Error('Missing the text the edits were made against')
      const target = assertInProjects(String(file))
      const outcome = await applyEnvironmentFileEdits(
        target,
        baseSource,
        EnvironmentEditsSchema.parse(edits)
      )
      return outcome.ok
        ? { conflict: false, source: outcome.source, wrote: outcome.wrote }
        : { conflict: true, source: outcome.source, wrote: false }
    })
  )

  ipcMain.handle(
    IpcChannel.environmentCreate,
    guard(async (_event, collectionPath: unknown, name: unknown) => {
      const directory = assertInProjects(
        await environmentsDirFor(assertInProjects(String(collectionPath)))
      )
      const created = await createEnvironmentFile(directory, String(name ?? ''))
      await refreshProjectsOf(created.path)
      return { path: created.path }
    })
  )

  ipcMain.handle(
    IpcChannel.environmentDelete,
    guard(async (_event, file: unknown) => {
      const target = assertInProjects(String(file))
      await deleteEnvironmentFile(target)
      await refreshProjectsOf(target)
      return {}
    })
  )

  /** A place to open, checked: a renderer could send anything. */
  const EditorTargetSchema = z.object({
    path: z.string(),
    line: z.number().int().positive().optional(),
    step: z.object({ list: z.enum(STEP_LISTS), index: z.number().int().nonnegative() }).optional(),
    script: z.enum(['tests', 'pre-request']).optional(),
    scriptLine: z.number().int().positive().optional()
  })

  ipcMain.handle(
    IpcChannel.editorOpen,
    guard(async (_event, payload: unknown) => {
      const target = EditorTargetSchema.parse(payload)
      const file = assertInProjects(target.path)
      // A step or a script is found in the file as it is on disk now.
      const line =
        target.line ??
        (target.step || target.script
          ? sourceLine(await fs.readFile(file, 'utf8'), {
              ...(target.step ? { step: target.step } : {}),
              ...(target.script ? { script: target.script } : {}),
              ...(target.scriptLine ? { scriptLine: target.scriptLine } : {})
            })
          : undefined)
      await openInEditor((await settingsStore.get()).editor, file, line)
      return {}
    })
  )

  ipcMain.handle(
    IpcChannel.editorTest,
    guard(async () => {
      const settings = await settingsStore.get()
      // Written once, if it never has been, so there is a file to open.
      await fs.access(settingsStore.file).catch(() => settingsStore.update({}))
      await openInEditor(settings.editor, settingsStore.file)
      return {}
    })
  )

  ipcMain.handle(IpcChannel.settingsGet, () => settingsStore.get())
  ipcMain.handle(
    IpcChannel.settingsSet,
    guard(async (_event, patch: unknown) => ({ settings: await settingsStore.update(patch) }))
  )

  ipcMain.handle(
    IpcChannel.variablesPreview,
    async (_event, payload: PreviewRequest): Promise<VariablePreviews> => {
      try {
        const step = StepSchema.parse(payload?.step)
        const script = payload?.collection ? payload.collection.script : undefined
        return await previewVariables(
          step,
          scopeContextOf(payload),
          payload?.collection ? (typeof script === 'string' ? script : null) : undefined
        )
      } catch {
        // A preview is advisory. A document mid-edit will not always parse, and
        // that must never surface as an error while someone is typing.
        return {}
      }
    }
  )

  ipcMain.handle(
    IpcChannel.variablesCopy,
    async (_event, payload: PreviewRequest, name: unknown): Promise<boolean> => {
      if (typeof name !== 'string' || name === '') return false
      const context = scopeContextOf(payload)
      if (!context) return false
      try {
        const scope = await buildScope(context)
        const value = scope.get(name)
        if (value === undefined) return false
        clipboard.writeText(value === null ? '' : String(value))
        return true
      } catch {
        return false
      }
    }
  )

  ipcMain.on(IpcChannel.appCopyText, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  // Parse only, never run: compiling a script executes none of it.
  ipcMain.handle(IpcChannel.scriptCheck, (_event, code: unknown) =>
    typeof code === 'string' ? checkScriptSyntax(code) : null
  )
}

/** Push workspace and project changes to every open window. */
export function broadcastProjects(projects: ProjectService): () => void {
  const send = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
  }
  const offProject = projects.onProject((project) => send(IpcChannel.eventProject, project))
  const offState = projects.onState((state) => send(IpcChannel.eventWorkspaces, state))
  return () => {
    offProject()
    offState()
  }
}

/** Push a clone's progress to every open window. */
export function broadcastGitProgress(projects: ProjectService): () => void {
  return projects.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IpcChannel.eventGitProgress, progress)
    }
  })
}

/** Push settings changes to every open window. */
export function broadcastSettings(): () => void {
  return settingsStore.onChanged((settings) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IpcChannel.eventSettings, settings)
    }
  })
}

const toWindows = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

const tellConsole = (event: ConsoleEvent) => toWindows(IpcChannel.eventConsole, event)

/**
 * A run as the console tells it (`ConsoleEvent`): its start, then its end —
 * with why, when it could not run. Its results land in between.
 */
async function consoleRun<T extends { summary: CollectionRunSummary } | { result: RunResult }>(
  runId: string,
  run: ConsoleRunKind,
  payload: { collectionPath?: unknown; environment?: unknown; dataRows?: unknown } | undefined,
  body: () => Promise<T>
): Promise<T> {
  tellConsole({
    kind: 'start',
    runId,
    at: Date.now(),
    run,
    collection:
      typeof payload?.collectionPath === 'string' ? idOfFile(payload.collectionPath) : null,
    environment: optionalString(payload?.environment),
    ...(Array.isArray(payload?.dataRows) ? { rows: payload.dataRows.length } : {})
  })
  try {
    const value = await body()
    const totals = 'summary' in value ? totalsOf(value.summary) : null
    tellConsole({ kind: 'end', runId, at: Date.now(), ...(totals ? { totals } : {}) })
    return value
  } catch (cause) {
    tellConsole({
      kind: 'end',
      runId,
      at: Date.now(),
      failure: cause instanceof Error ? cause.message : String(cause)
    })
    throw cause
  }
}

/** A summary without its results, which the console has had one by one. */
const totalsOf = ({ results: _results, ...totals }: CollectionRunSummary) => totals

/**
 * Push per-step results to every open window as a collection run proceeds,
 * with the events of a stream as it is read and the connections Sends hold.
 */
export function broadcastRunProgress(): () => void {
  const unsubscribe = [
    runSupervisor.onProgress((runId, index, result, iteration) => {
      toWindows(IpcChannel.eventRunProgress, {
        runId,
        index,
        result,
        ...(iteration ? { iteration } : {})
      })
      tellConsole({
        kind: 'result',
        runId,
        at: Date.now(),
        result,
        ...(iteration ? { iteration } : {})
      })
    }),
    runSupervisor.onLive((runId, live) => toWindows(IpcChannel.eventRunLive, { runId, live })),
    runSupervisor.onConnections((collectionPath, connections) =>
      toWindows(IpcChannel.eventConnections, { collectionPath, connections })
    )
  ]
  return () => {
    for (const undo of unsubscribe) undo()
  }
}
