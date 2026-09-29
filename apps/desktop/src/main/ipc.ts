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
  FLAG_NAME_PATTERN,
  FlagValueSchema,
  GitCommandError,
  isAbsoluteAnywhere,
  isInside,
  projectRootOf,
  PROJECT_FIELDS,
  relativePosix,
  samePath,
  previewVariables,
  applyDataTable,
  applyDataText,
  createDataFile,
  DOC_EXTENSION,
  findDataFile,
  readDataTable,
  VarValueSchema,
  type ScopeContext,
  type VariablePreviews
} from '@schwabyio/gravity-core'
import {
  IpcChannel,
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
import { runSupervisor } from './runSupervisor.js'
import { flagService } from './flagService.js'
import type { ProjectService } from './projectService.js'

const index = z.number().int().nonnegative()

/** Edits arrive from the renderer, so each is validated before any file is touched. */
const EditsSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('editStep'), index, step: StepSchema }),
    z.object({ type: z.literal('insertStep'), index, step: StepSchema }),
    z.object({ type: z.literal('removeStep'), index }),
    z.object({ type: z.literal('moveStep'), from: index, to: index }),
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
      const step = StepSchema.parse(payload?.step)
      const runId = String(payload?.runId ?? '')
      if (runId === '') throw new Error('Missing runId')
      const collection = payload?.collection ? CollectionSchema.parse(payload.collection) : null
      const collectionPath =
        typeof payload?.collectionPath === 'string'
          ? assertInProjects(payload.collectionPath)
          : null
      return {
        result: await runSupervisor.run(runId, step, collection, collectionPath, {
          environment: optionalString(payload?.environment),
          environmentOverrides: environmentOverridesOf(payload?.environmentOverrides),
          projectVars: projectVarsOf(payload?.projectVars),
          flags: await flagsForRun(collectionPath, payload),
          ...(payload?.dataRow !== undefined ? { dataRow: dataRowOf(payload.dataRow)! } : {})
        })
      }
    })
  )

  ipcMain.handle(
    IpcChannel.runCollection,
    guard(async (_event, payload: RunCollectionRequest) => {
      const runId = String(payload?.runId ?? '')
      if (runId === '') throw new Error('Missing runId')
      const collection = CollectionSchema.parse(payload?.collection)
      const collectionPath =
        typeof payload?.collectionPath === 'string'
          ? assertInProjects(payload.collectionPath)
          : null
      return {
        summary: await runSupervisor.runCollection(runId, collection, collectionPath, {
          environment: optionalString(payload?.environment),
          environmentOverrides: environmentOverridesOf(payload?.environmentOverrides),
          projectVars: projectVarsOf(payload?.projectVars),
          flags: await flagsForRun(collectionPath, payload),
          ...(payload?.dataRow !== undefined ? { dataRow: dataRowOf(payload.dataRow)! } : {}),
          ...(payload?.dataRows !== undefined
            ? { dataRows: z.array(DataRowSchema).min(1).parse(payload.dataRows) }
            : {})
        })
      }
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

  /* ---------------------------------------------------------- workspaces -- */

  ipcMain.handle(IpcChannel.workspacesList, (): WorkspacesState => projects.state())

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
      title: 'Add a project — the folder holding collections/',
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
      const createCollections =
        typeof options === 'object' &&
        options !== null &&
        (options as { createCollections?: unknown }).createCollections === true
      try {
        return await projects.addProject(workspaceId, folder, { createCollections })
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
    }
  )

  ipcMain.handle(
    IpcChannel.projectClone,
    guard(async (_event, workspaceId: unknown, url: unknown, parentDir: unknown) => {
      if (typeof url !== 'string' || url.trim() === '') throw new Error('Missing repository URL')
      if (typeof parentDir !== 'string' || parentDir === '') throw new Error('Missing directory')
      return { project: await projects.cloneInto(String(workspaceId), url.trim(), parentDir) }
    })
  )

  ipcMain.handle(IpcChannel.projectRemove, async (_event, id: unknown) => {
    if (typeof id === 'string') await projects.removeProject(id)
  })

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
        title: kind === 'certificate' ? 'Trust a CA certificate' : 'Choose a file to upload',
        defaultPath: root,
        properties: ['openFile'] as Array<'openFile'>,
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
      const file = result.canceled ? undefined : result.filePaths[0]
      if (!file) return { path: null }
      // Written relative so it works on every machine; another drive has no relative path.
      if (path.isAbsolute(path.relative(root, file))) {
        throw new Error(
          `The file must be on the same drive as the project, so ${kind === 'certificate' ? 'tls.ca' : 'the collection'} can name it with a relative path`
        )
      }
      return { path: relativePosix(root, file) }
    })
  )

  /** The folder a picked file is named from: a known project's, or its global project's. */
  const pickRoot = (request: unknown): { kind: 'certificate' | 'upload'; root: string } => {
    const asked = (request ?? {}) as {
      kind?: unknown
      projectId?: unknown
      collectionPath?: unknown
    }
    if (asked.kind === 'certificate') {
      const view = projects.project(String(asked.projectId))
      if (!view) throw new Error('Unknown project')
      return { kind: 'certificate', root: view.path }
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

/** Push per-step results to every open window as a collection run proceeds. */
export function broadcastRunProgress(): () => void {
  return runSupervisor.onProgress((runId, index, result, iteration) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IpcChannel.eventRunProgress, {
        runId,
        index,
        result,
        ...(iteration ? { iteration } : {})
      })
    }
  })
}
