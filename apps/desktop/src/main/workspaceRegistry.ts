import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { discoverCollections, renameWithRetry, samePath } from '@schwabyio/gravity-core'
import {
  RegistryV1Schema,
  RegistryV2Schema,
  emptyRegistry,
  migrateV1,
  newId,
  type ProjectEntry,
  type RegistryV2,
  type WorkspaceEntry
} from './registrySchema.js'

export type { ProjectEntry, WorkspaceEntry } from './registrySchema.js'

/**
 * The persisted workspaces and their projects.
 *
 * A plain JSON file in userData, zod-validated on read. No `electron-store`: this
 * is one small file and one schema. An older file is migrated on first read and
 * written back in the new form.
 */
export class WorkspaceRegistry {
  private data: RegistryV2 = emptyRegistry()
  private loading: Promise<RegistryV2> | null = null
  /** The last save asked for: each waits for the one before (see `save`). */
  private saving: Promise<void> = Promise.resolve()

  /**
   * Resolved lazily, never in the constructor.
   *
   * This class is built at module load, which is before `app.whenReady()`, and
   * `app.getPath('userData')` is not settled until then — command-line overrides
   * such as `--user-data-dir` have not been applied yet. Reading it early sends
   * the registry to the wrong directory.
   */
  private resolved: string | undefined

  constructor(private readonly override?: string) {}

  private get file(): string {
    this.resolved ??= this.override ?? path.join(app.getPath('userData'), 'workspaces.json')
    return this.resolved
  }

  /**
   * Read the file, once. Every caller waits for that one read, so none sees the
   * placeholder held until then, whose workspace id the file's replaces.
   */
  load(): Promise<RegistryV2> {
    return (this.loading ??= this.read())
  }

  private async read(): Promise<RegistryV2> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      // No file yet, or one that will not parse: start with an empty workspace.
      this.data = emptyRegistry()
      return this.data
    }

    const current = RegistryV2Schema.safeParse(raw)
    if (current.success) {
      this.data = current.data.workspaces.length > 0 ? current.data : emptyRegistry()
      return this.data
    }
    const old = RegistryV1Schema.safeParse(raw)
    if (old.success) {
      this.data = await migrateV1(old.data, async (folder) =>
        (await discoverCollections(folder)).map((directory) => path.dirname(directory.path))
      )
      await this.save()
      return this.data
    }
    this.data = emptyRegistry()
    return this.data
  }

  get activeWorkspaceId(): string | null {
    return this.data.activeWorkspaceId
  }

  workspaces(): WorkspaceEntry[] {
    return this.data.workspaces
  }

  workspace(id: string): WorkspaceEntry | undefined {
    return this.data.workspaces.find((workspace) => workspace.id === id)
  }

  /** Every project, with the workspace it is in. */
  projects(): Array<{ workspaceId: string; entry: ProjectEntry }> {
    return this.data.workspaces.flatMap((workspace) =>
      workspace.projects.map((entry) => ({ workspaceId: workspace.id, entry }))
    )
  }

  project(id: string): { workspaceId: string; entry: ProjectEntry } | undefined {
    return this.projects().find((candidate) => candidate.entry.id === id)
  }

  async createWorkspace(name: string): Promise<WorkspaceEntry> {
    const workspace: WorkspaceEntry = { id: newId('ws'), name: name.trim(), projects: [] }
    this.data.workspaces.push(workspace)
    this.data.activeWorkspaceId = workspace.id
    await this.save()
    return workspace
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    const workspace = this.workspace(id)
    if (!workspace) return
    workspace.name = name.trim()
    await this.save()
  }

  /** Forget a workspace and its projects. At least one workspace always remains. */
  async removeWorkspace(id: string): Promise<ProjectEntry[]> {
    const workspace = this.workspace(id)
    if (!workspace) return []
    this.data.workspaces = this.data.workspaces.filter((candidate) => candidate.id !== id)
    if (this.data.workspaces.length === 0) this.data = emptyRegistry()
    if (this.data.activeWorkspaceId === id) {
      this.data.activeWorkspaceId = this.data.workspaces[0]?.id ?? null
    }
    await this.save()
    return workspace.projects
  }

  async setActive(id: string): Promise<void> {
    if (!this.workspace(id)) return
    this.data.activeWorkspaceId = id
    await this.save()
  }

  /** Adding a folder a workspace already has returns the existing project. */
  async addProject(
    workspaceId: string,
    directory: string,
    options: { scratch?: boolean } = {}
  ): Promise<ProjectEntry> {
    const workspace = this.workspace(workspaceId)
    if (!workspace) throw new Error('Unknown workspace')
    const existing = workspace.projects.find((project) => samePath(project.path, directory))
    if (existing) return existing

    const entry: ProjectEntry = {
      id: newId('project'),
      path: directory,
      autoFetchSeconds: null,
      selectedEnvironment: null,
      lineEndingsNoticeDismissed: false,
      scratch: options.scratch === true
    }
    workspace.projects.push(entry)
    await this.save()
    return entry
  }

  async removeProject(id: string): Promise<void> {
    for (const workspace of this.data.workspaces) {
      workspace.projects = workspace.projects.filter((project) => project.id !== id)
    }
    await this.save()
  }

  async selectEnvironment(id: string, environment: string | null): Promise<void> {
    const found = this.project(id)
    if (!found) return
    found.entry.selectedEnvironment = environment
    await this.save()
  }

  /** A project's folder moved, as a scratch pad's does when renamed: every entry for it follows. */
  async moveProjects(from: string, to: string): Promise<void> {
    for (const { entry } of this.projects()) {
      if (samePath(entry.path, from)) entry.path = to
    }
    await this.save()
  }

  async dismissLineEndingsNotice(id: string): Promise<void> {
    const found = this.project(id)
    if (!found) return
    found.entry.lineEndingsNoticeDismissed = true
    await this.save()
  }

  /**
   * Write the registry as it is when this save's turn comes, after every save
   * asked for before it. Two at once would share the temporary file: one
   * rename would move the other's away, and that save would fail — on
   * Windows, where the disk is slower, more often. A save that fails still
   * lets the next one run.
   */
  private save(): Promise<void> {
    const turn = this.saving.then(() => this.write())
    this.saving = turn.catch(() => undefined)
    return turn
  }

  private async write(): Promise<void> {
    const body = JSON.stringify(this.data, null, 2)
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    // Write then rename, so a crash mid-write cannot leave a truncated registry.
    const temporary = `${this.file}.tmp`
    await fs.writeFile(temporary, body)
    await renameWithRetry(temporary, this.file)
  }
}
