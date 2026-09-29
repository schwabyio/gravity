import path from 'node:path'
import { isInside, samePath } from '@schwabyio/gravity-core'
import { z } from 'zod'

/**
 * What `workspaces.json` holds, and how an older file becomes this one.
 *
 * Kept apart from the registry class so it can be tested without Electron.
 */

export const ProjectEntrySchema = z.object({
  id: z.string(),
  /** Canonical: resolved through symlinks once, when added. */
  path: z.string(),
  /** Background fetch interval in seconds, or null for off. Off by default. */
  autoFetchSeconds: z.number().int().positive().nullable().default(null),
  /**
   * The environment chosen for this project's runs, by name. Persisted because
   * losing it on every restart, in a tool whose whole job is pointing the same
   * requests at different hosts, is a papercut you feel daily.
   */
  selectedEnvironment: z.string().nullable().default(null),
  /**
   * "Not now" on the Changes drawer's line-endings notice, for this project.
   * Project settings still offers the `.gitattributes`.
   */
  lineEndingsNoticeDismissed: z.boolean().default(false)
})
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>

export const WorkspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  projects: z.array(ProjectEntrySchema).default([])
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>

export const RegistryV2Schema = z.object({
  version: z.literal(2),
  activeWorkspaceId: z.string().nullable().default(null),
  workspaces: z.array(WorkspaceEntrySchema).default([])
})
export type RegistryV2 = z.infer<typeof RegistryV2Schema>

/** Version 1: each "workspace" was one folder, holding any number of `collections/`. */
export const RegistryV1Schema = z.object({
  version: z.literal(1),
  workspaces: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        name: z.string(),
        autoFetchSeconds: z.number().int().positive().nullable().default(null),
        /** Chosen environment, keyed by the `environments/` directory it belonged to. */
        selectedEnvironments: z.record(z.string(), z.string()).default({})
      })
    )
    .default([])
})
export type RegistryV1 = z.infer<typeof RegistryV1Schema>

export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** A new, empty registry: one workspace to put projects in. */
export function emptyRegistry(): RegistryV2 {
  const workspace = { id: newId('ws'), name: 'My workspace', projects: [] }
  return { version: 2, activeWorkspaceId: workspace.id, workspaces: [workspace] }
}

/**
 * Move a version 1 file onto workspaces and projects, losing nothing that was
 * shown: every old entry's folders that held a `collections/` become projects —
 * the folder itself, or each service in a monorepo — in one "Default"
 * workspace. A chosen environment follows its project.
 *
 * `projectRootsIn(folder)` lists the folders holding a `collections/` under
 * `folder`; an entry with none still becomes a project, so it stays listed.
 */
export async function migrateV1(
  v1: RegistryV1,
  projectRootsIn: (folder: string) => Promise<string[]>
): Promise<RegistryV2> {
  const workspace: WorkspaceEntry = { id: newId('ws'), name: 'Default', projects: [] }

  for (const entry of v1.workspaces) {
    const roots = await projectRootsIn(entry.path).catch(() => [])
    for (const root of roots.length > 0 ? roots : [entry.path]) {
      workspace.projects.push({
        id: newId('project'),
        path: root,
        autoFetchSeconds: entry.autoFetchSeconds,
        selectedEnvironment: chosenFor(root, entry.selectedEnvironments),
        lineEndingsNoticeDismissed: false
      })
    }
  }

  return { version: 2, activeWorkspaceId: workspace.id, workspaces: [workspace] }
}

/**
 * The environment chosen, in version 1, for the `environments/` a project
 * resolved against: its own, else the nearest one above it.
 */
function chosenFor(root: string, chosen: Record<string, string>): string | null {
  const candidates = Object.entries(chosen)
    .filter(([directory]) => isInside(path.dirname(directory), root))
    .sort(([a], [b]) => b.length - a.length)
  const own = candidates.find(([directory]) => samePath(path.dirname(directory), root))
  return (own ?? candidates[0])?.[1] ?? null
}
