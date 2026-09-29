import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSION, ENVIRONMENTS_DIR, PROJECT_FILE } from '../format/constants.js'
import { parseCollection, parseEnvironment } from '../format/index.js'
import { isInside, relativePosix, samePath } from '../paths.js'
import { resolveBase } from '../workspace/library.js'
import { projectRootOf, readProject } from '../workspace/project.js'
import { loadDataFile } from '../workspace/dataFile.js'
import type {
  EnvironmentDoc,
  EnvironmentVar,
  FlagValue,
  VarValue,
  Vars
} from '../model/documents.js'
import { parseDotEnv } from './dotenv.js'
import { exactEnv, InterpolationError, VariableScope, type VarLayer } from './scope.js'

export interface ScopeContext {
  /** The collection file whose variables are in scope. */
  collectionPath: string
  /** Environment to use, by its `name` or filename. */
  environmentName?: string | null
  /** Overridable for tests; defaults to the real process environment. */
  env?: Record<string, string | undefined>
  /**
   * The collection's variables as they are in the editor, when a run or preview
   * must use them rather than what was last saved. Absent: read from the file.
   */
  collectionVars?: Vars | null
  /**
   * The base collection the collection `extends:`, as edited: null for none;
   * absent, read from the collection file.
   */
  collectionExtends?: string | null
  /** The project's `project.yml` variables as edited; absent, read from the file. */
  projectVars?: Vars | null
  /**
   * Environment files as they are in the editor, used instead of the files at
   * those paths. Their secrets still come from the process environment or `.env`.
   */
  environments?: Array<{ path: string; doc: EnvironmentDoc }>
  /**
   * One row of the collection's data file (SPEC.md §2.8), over the
   * environment. Absent: the file's first row, if it has one — what the app
   * runs with; null: none, as for a collection with no data file.
   */
  dataRow?: { source: string; vars: Record<string, VarValue> } | null
  /**
   * The run's feature flag values (SPEC.md §2.9), as gta and the app resolve
   * them — command output and overrides included. Absent: the environment
   * file's fixed `flags.values`; null: none known.
   */
  flags?: Record<string, FlagValue> | null
}

/**
 * Build the variable scope for a run, lowest precedence first (SPEC.md §4):
 *
 *     global project -> project -> collection -> environment (global's, then
 *     the project's) -> [before.script] -> [captures] -> process env
 *
 * What `before.script` sets and what checks capture are applied later, by the
 * runner, because they depend on the run itself.
 */
export async function buildScope(context: ScopeContext): Promise<VariableScope> {
  const layers: VarLayer[] = []
  const root = projectRootOf(context.collectionPath) ?? path.dirname(context.collectionPath)
  const project = await readProject(root)

  if (project.global?.doc.vars) {
    layers.push({
      source: relativePosix(root, path.join(project.global.root, PROJECT_FILE)),
      vars: project.global.doc.vars
    })
  }
  const projectVars =
    context.projectVars !== undefined ? context.projectVars : (project.doc?.vars ?? null)
  if (projectVars) layers.push({ source: PROJECT_FILE, vars: projectVars })

  const extendsRef =
    context.collectionExtends !== undefined
      ? context.collectionExtends
      : await readCollectionExtends(context.collectionPath)
  if (extendsRef) {
    try {
      const base = await resolveBase(root, project.global, extendsRef)
      if (base.doc.vars) {
        layers.push({ source: relativePosix(root, base.path), vars: base.doc.vars })
      }
    } catch {
      // A base that cannot be used is reported by the run itself, with its reason.
    }
  }

  const collection =
    context.collectionVars !== undefined
      ? context.collectionVars
      : await readCollectionVars(context.collectionPath)
  if (collection) layers.push({ source: path.basename(context.collectionPath), vars: collection })

  if (context.environmentName) {
    layers.push(...(await environmentLayers(context, context.environmentName)))
  }

  const row =
    context.dataRow !== undefined ? context.dataRow : await firstRow(context.collectionPath)
  if (row) layers.push(row)

  const scope = new VariableScope(layers, context.env ?? process.env)
  scope.flags =
    context.flags !== undefined
      ? context.flags
      : context.environmentName
        ? (await environmentFlags(root, context.environmentName, context.environments)).values
        : null
  return scope
}

/**
 * The first row of the collection's data file, for a run that is not one of
 * gta's iterations. One that will not read is no layer: the collection shows
 * the problem, and gta refuses to run it.
 */
async function firstRow(
  collectionPath: string
): Promise<{ source: string; vars: Record<string, VarValue> } | null> {
  try {
    const data = await loadDataFile(collectionPath)
    const row = data?.rows[0]
    return data && row ? { source: `${path.basename(data.path)} row 1`, vars: row.values } : null
  } catch {
    return null
  }
}

async function readCollectionExtends(file: string): Promise<string | null> {
  try {
    return parseCollection(await fs.readFile(file, 'utf8'), file).data.extends ?? null
  } catch {
    return null
  }
}

async function readCollectionVars(file: string): Promise<Vars | null> {
  try {
    return parseCollection(await fs.readFile(file, 'utf8'), file).data.vars ?? null
  } catch {
    return null
  }
}

/**
 * The environment called `name`, as one layer: the global project's file of
 * that name, if any, with the project's own over it, key by key.
 */
export async function environmentLayer(
  context: Pick<ScopeContext, 'collectionPath' | 'env' | 'environments'>,
  name: string
): Promise<VarLayer> {
  const layers = await environmentLayers(context, name)
  return {
    source: layers.map((layer) => layer.source).join(' + '),
    vars: Object.assign({}, ...layers.map((layer) => layer.vars)),
    secrets: [...new Set(layers.flatMap((layer) => layer.secrets ?? []))]
  }
}

async function environmentLayers(
  context: Pick<ScopeContext, 'collectionPath' | 'env' | 'environments'>,
  name: string
): Promise<VarLayer[]> {
  const root = projectRootOf(context.collectionPath) ?? path.dirname(context.collectionPath)
  const project = await readProject(root)
  const edited = (file: string) =>
    context.environments?.find((environment) => samePath(environment.path, file))?.doc

  // Global first, so the project's own values land on top.
  const places = [...(project.global ? [project.global.root] : []), root]
  const dotEnvs = await Promise.all(
    [root, ...(project.global ? [project.global.root] : [])].map(readDotEnv)
  )
  const dotEnv = Object.assign({}, ...dotEnvs.reverse())

  const env = exactEnv(context.env ?? process.env)
  const layers: VarLayer[] = []
  for (const place of places) {
    const directory = path.join(place, ENVIRONMENTS_DIR)
    const file = await findEnvironmentFile(directory, name, context.environments)
    if (!file) continue
    const doc = edited(file) ?? parseEnvironment(await fs.readFile(file, 'utf8'), file).data
    layers.push(layerOf(relativePosix(root, file), doc, env, dotEnv))
  }
  if (layers.length === 0) throw new InterpolationError(`Environment "${name}" was not found`)
  return layers
}

/** An environment's variables as a layer, its secrets resolved. */
function layerOf(
  source: string,
  doc: EnvironmentDoc,
  env: Map<string, string>,
  dotEnv: Record<string, string>
): VarLayer {
  const vars: Vars = {}
  const secrets: string[] = []
  for (const [key, declared] of Object.entries(doc.vars)) {
    if (isSecretDeclaration(declared)) secrets.push(key)
    const value = resolveEnvironmentVar(key, declared, env, dotEnv)
    if (value !== undefined) vars[key] = value
  }
  return { source, vars, secrets }
}

/**
 * A secret's value never lives in the file: it comes from the process
 * environment, or from `.env` at the project's root — or its global project's —
 * so the repository can be shared without the credential going with it.
 */
function resolveEnvironmentVar(
  key: string,
  declared: EnvironmentVar,
  env: Map<string, string>,
  dotEnv: Record<string, string>
): VarValue | undefined {
  if (declared !== null && typeof declared === 'object') {
    const entry = declared as { value?: VarValue; secret?: true }
    if (entry.secret) {
      const secret = env.get(key) ?? dotEnv[key]
      if (secret === undefined) {
        throw new InterpolationError(
          `Secret "${key}" has no value — set ${key} in the environment or in .env`,
          key
        )
      }
      return secret
    }
    return entry.value
  }
  return declared as VarValue
}

const isSecretDeclaration = (declared: EnvironmentVar): boolean =>
  declared !== null &&
  typeof declared === 'object' &&
  !Array.isArray(declared) &&
  (declared as { secret?: true }).secret === true

/**
 * Environment files are matched on their `name`, falling back to the filename.
 * A file being edited is matched on its edited name.
 */
/**
 * The environment called `name`'s feature flag setup (SPEC.md §2.9): its
 * fixed values — the global project's file of that name under the project's
 * own — and the command to fetch fresh ones, with the folder to run it in.
 * The project's command wins over the global project's.
 */
export async function environmentFlags(
  root: string,
  name: string,
  environments?: ScopeContext['environments']
): Promise<{
  values: Record<string, FlagValue>
  command: { command: string; cwd: string } | null
}> {
  const project = await readProject(root)
  const edited = (file: string) =>
    environments?.find((environment) => samePath(environment.path, file))?.doc
  const values: Record<string, FlagValue> = {}
  let command: { command: string; cwd: string } | null = null
  for (const place of [...(project.global ? [project.global.root] : []), root]) {
    const directory = path.join(place, ENVIRONMENTS_DIR)
    const file = await findEnvironmentFile(directory, name, environments)
    if (!file) continue
    // A file that will not read throws: flags silently missing would skip the wrong tests.
    const doc = edited(file) ?? parseEnvironment(await fs.readFile(file, 'utf8'), file).data
    Object.assign(values, doc.flags?.values ?? {})
    if (doc.flags?.command) command = { command: doc.flags.command, cwd: place }
  }
  return { values, command }
}

async function findEnvironmentFile(
  directory: string,
  name: string,
  edited: ScopeContext['environments']
): Promise<string | null> {
  const renamed = edited?.find(
    (environment) =>
      isInside(directory, environment.path) &&
      (environment.doc.name ?? path.basename(environment.path, DOC_EXTENSION)) === name
  )
  if (renamed) return renamed.path

  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch {
    return null
  }
  // The file name exactly, in its case: macOS and Windows would find `Staging.yml`
  // for `staging` too, and Linux would not.
  if (entries.includes(`${name}${DOC_EXTENSION}`)) {
    return path.join(directory, `${name}${DOC_EXTENSION}`)
  }

  for (const entry of entries) {
    if (!entry.endsWith('.yml')) continue
    const file = path.join(directory, entry)
    try {
      if (parseEnvironment(await fs.readFile(file, 'utf8'), file).data.name === name) return file
    } catch {
      // A broken environment file must not hide the working ones.
    }
  }
  return null
}

/** `.env` sits at a project's root, beside `environments/`. */
async function readDotEnv(near: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await fs.readFile(path.join(near, '.env'), 'utf8'))
  } catch {
    return {}
  }
}
