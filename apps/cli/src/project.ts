import fs from 'node:fs/promises'
import path from 'node:path'
import {
  COLLECTIONS_DIR,
  discoverProject,
  environmentNames,
  flagOverrides,
  loadProjectCollections,
  loadProjectTls,
  projectEnvironments,
  readProject,
  relativePosix,
  resolveFlags,
  type FlagResolution,
  type FlagValues,
  type LoadedCollection
} from '@schwabyio/gravity-core'
import { loadSettings, SETTINGS_FILE, type Settings, type SettingSources } from './settings.js'

/** Something about the project folder that stops a run. */
export class ProjectError extends Error {
  override name = 'ProjectError'
}

export interface OpenProject {
  root: string
  name: string
  /** The global project it `uses:`, if any (SPEC.md §1.1). */
  global: { root: string; uses: string } | null
  settings: Settings
  /** Where each setting came from: the global project's settings.yml, the project's, … */
  settingSources: SettingSources
  /** The run's feature flags: fixed values, the environment's command, overrides (SPEC.md §2.9). */
  flags: FlagResolution
  collections: LoadedCollection[]
  environments: string[]
  /** `tls.ca`, the project's then its global project's, each with what it holds (SPEC.md §1.1). */
  caFiles: string[]
  warnings: string[]
}

export interface LoadProjectOptions {
  /** The project folder, canonical: the one holding `collections/`. */
  root: string
  /** Where `GTA_*` settings and `GTA_FLAG_*` overrides are read from. */
  env: Record<string, string | undefined>
  /** Settings as the command line gives them (`--key value`). */
  overrides?: Record<string, string | true>
  /** How messages name an override; `--key` by default. */
  overrideLabel?: (key: string) => string
  /** `--flag name=value`, as typed. */
  flagArgs?: readonly string[]
  /** Flag values given in code, over `--flag` and `GTA_FLAG_*`. */
  flagValues?: FlagValues
  /** Run on the default settings when there is no `settings.yml`. */
  optionalSettings?: boolean
}

/**
 * A project as a run sees it: its settings, its feature flags, and everything
 * in `collections/`. The flag command, if the environment has one, runs now.
 */
export async function loadProject(options: LoadProjectOptions): Promise<OpenProject> {
  const { root, env } = options
  if (!(await isDirectory(path.join(root, COLLECTIONS_DIR)))) {
    throw new ProjectError(
      `There is no ${COLLECTIONS_DIR}/ in ${root}.\n` +
        `gta runs from a project folder: the one holding ${COLLECTIONS_DIR}/ and ${SETTINGS_FILE}.`
    )
  }
  const info = await readProject(root)
  const { settings, sources: settingSources } = await loadSettings({
    root,
    global: info.global,
    env,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.overrideLabel ? { overrideLabel: options.overrideLabel } : {}),
    ...(options.optionalSettings ? { optionalFile: true } : {})
  })
  const layout = await discoverProject(root)
  // Ids checked against each other too: a shared id is reported on both files.
  const collections = await loadProjectCollections(root, layout.files)
  const environments = environmentNames(await projectEnvironments(root, info.global))

  if (settings.environmentType && !environments.includes(settings.environmentType)) {
    throw new ProjectError(
      `environmentType (from ${settingSources.environmentType}): there is no environment called "${settings.environmentType}". ` +
        (environments.length > 0
          ? `This project has: ${environments.join(', ')}`
          : `This project has no environments/.`)
    )
  }

  // Fresh before the run: the environment's command, if it has one, runs now, once.
  let flags: FlagResolution
  try {
    flags = await resolveFlags({
      root,
      environmentName: settings.environmentType,
      overrides: { ...flagOverrides(options.flagArgs ?? [], env), ...options.flagValues },
      env: { ...process.env, ...env }
    })
  } catch (cause) {
    throw new ProjectError((cause as Error).message)
  }

  // Every request that needs a broken tls.ca file would fail, and less clearly than this.
  const tls = await loadProjectTls(root, info)
  if (tls.problems.length > 0) {
    throw new ProjectError(
      `A certificate in tls.ca cannot be used:\n` +
        tls.problems.map((problem) => `  ${problem.path}: ${problem.message}`).join('\n')
    )
  }

  return {
    root,
    name: info.doc?.name ?? path.basename(root),
    global: info.global ? { root: info.global.root, uses: info.global.uses } : null,
    settings,
    settingSources,
    flags,
    collections,
    environments,
    caFiles: tls.files.map(
      (file) =>
        `${relativePosix(root, file.file)} (${file.certificates.map((c) => c.subject).join(', ')})`
    ),
    warnings: [...info.problems, ...layout.problems].map((problem) =>
      problem.path ? `${problem.path}: ${problem.message}` : problem.message
    )
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}
