import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BASES_DIR,
  CHECKS_DIR,
  DOC_EXTENSION,
  ENDPOINTS_DIR,
  REQUESTS_DIR
} from '../format/constants.js'
import { parseCollection } from '../format/index.js'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  type Collection,
  type HttpMethod,
  type Step
} from '../model/documents.js'
import { pathOf } from '../model/endpoints.js'
import { stripBom } from '../model/text.js'
import { nameProblem, relativePosix, samePath, spellingProblem, toPosix } from '../paths.js'
import { duplicateIds, idProblem } from './ids.js'
import { projectRootOf, readProject, type GlobalProject } from './project.js'
import { loadProjectTls, type ProjectTrust } from './projectTls.js'

/**
 * What a project can reuse (SPEC.md §2.5): request sets in `requests/`, run by
 * a step with `use:`, and check functions in `checks/`, called from scripts —
 * its own, then its global project's.
 */

/** A request set, as a step names it. */
export interface RequestSetRef {
  /** How a step names it: `login`, or `auth/login` one directory down. */
  name: string
  path: string
  source: 'project' | 'global'
  /** Parsed, or null when it will not parse — `problem` says why. */
  doc: Collection | null
  problem?: string
}

const GLOBAL_PREFIX = 'global:'

/** Every request set a project can use: its own, then its global project's. */
export async function listRequestSets(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<RequestSetRef[]> {
  return [
    ...(await setsIn(root, 'project')),
    ...(global ? await setsIn(global.root, 'global') : [])
  ]
}

const setsIn = (root: string, source: RequestSetRef['source']) =>
  filesIn(root, REQUESTS_DIR, source)

/**
 * The files in one of a project's library directories — `requests/`,
 * `endpoints/` or `bases/` — one level deep, absolute.
 */
export async function libraryFiles(root: string, home: string): Promise<string[]> {
  const directory = path.join(root, home)
  const files: string[] = []
  for (const entry of await readDir(directory)) {
    if (entry.isFile() && entry.name.endsWith(DOC_EXTENSION)) {
      files.push(path.join(directory, entry.name))
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const inner of await readDir(path.join(directory, entry.name))) {
        if (inner.isFile() && inner.name.endsWith(DOC_EXTENSION)) {
          files.push(path.join(directory, entry.name, inner.name))
        }
      }
    }
  }
  return files
}

/** The collection files in one of a project's library directories, one level deep. */
async function filesIn(
  root: string,
  home: string,
  source: RequestSetRef['source']
): Promise<RequestSetRef[]> {
  const directory = path.join(root, home)
  const files = await libraryFiles(root, home)
  const sets = await Promise.all(files.map((file) => readSet(file, directory, source)))
  const duplicates = duplicateIds(files, directory)
  return sets
    .map((set) => {
      const duplicate = duplicates.get(set.path)
      return duplicate && !set.problem ? { ...set, problem: duplicate } : set
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function readSet(
  file: string,
  directory: string,
  source: RequestSetRef['source']
): Promise<RequestSetRef> {
  const name = relativePosix(directory, file).slice(0, -DOC_EXTENSION.length)
  try {
    const doc = parseCollection(await fs.readFile(file, 'utf8'), file).data
    const problem = idProblem(doc, file)
    return problem ? { name, path: file, source, doc, problem } : { name, path: file, source, doc }
  } catch (cause) {
    return { name, path: file, source, doc: null, problem: (cause as Error).message }
  }
}

/**
 * The request set a `use:` names: in the project's `requests/` first, then its
 * global project's; `global:name` looks only in the global project's.
 */
export async function resolveRequestSet(
  root: string,
  global: Pick<GlobalProject, 'root'> | null,
  reference: string
): Promise<RequestSetRef & { doc: Collection }> {
  const set = await resolveIn(root, global, reference, REQUESTS_DIR, 'use')
  if (!set.doc.params) {
    throw new Error(
      `use: ${reference} — ${set.name}.yml has no params, so it is not a reusable requests file (SPEC.md §2.5)`
    )
  }
  return set
}

/**
 * A file named by a reference, in `home/` of the project first, then its
 * global project's; `global:name` only the global project's.
 */
async function resolveIn(
  root: string,
  global: Pick<GlobalProject, 'root'> | null,
  reference: string,
  home: string,
  key: 'use' | 'extends'
): Promise<RequestSetRef & { doc: Collection }> {
  const onlyGlobal = reference.startsWith(GLOBAL_PREFIX)
  const name = toPosix(onlyGlobal ? reference.slice(GLOBAL_PREFIX.length) : reference)
  const segments = name.split('/')
  if (segments.length > 2 || segments.some((segment) => segment === '..' || nameProblem(segment))) {
    throw new Error(`${key}: ${reference} — not a name of a file in ${home}/`)
  }
  if (onlyGlobal && !global) {
    throw new Error(`${key}: ${reference} — this project does not use a global project`)
  }

  const places: Array<[string, RequestSetRef['source']]> = [
    ...(onlyGlobal ? [] : [[root, 'project'] as [string, RequestSetRef['source']]]),
    ...(global ? [[global.root, 'global'] as [string, RequestSetRef['source']]] : [])
  ]
  for (const [place, source] of places) {
    const directory = path.join(place, home)
    const file = path.join(directory, ...segments) + DOC_EXTENSION
    // Found only because this disk ignores case: Linux would not find it.
    const misspelled = await spellingProblem(directory, `${name}${DOC_EXTENSION}`)
    if (misspelled) throw new Error(`${key}: ${reference} — ${misspelled}`)
    if (!(await exists(file))) continue
    const found = await readSet(file, directory, source)
    const problem = found.problem ?? (await sharedId(file, directory))
    if (!found.doc || problem) throw new Error(`${key}: ${reference} — ${problem}`)
    return { ...found, doc: found.doc }
  }
  const where = onlyGlobal ? `the global project’s ${home}/` : `${home}/`
  throw new Error(`${key}: ${reference} — there is no ${name}${DOC_EXTENSION} in ${where}`)
}

/** Whether another file in the home has this file's id, which makes neither usable. */
async function sharedId(file: string, directory: string): Promise<string | undefined> {
  const names: string[] = []
  for (const entry of await readDir(directory)) {
    if (entry.isFile()) names.push(path.join(directory, entry.name))
    else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const inner of await readDir(path.join(directory, entry.name))) {
        if (inner.isFile()) names.push(path.join(directory, entry.name, inner.name))
      }
    }
  }
  const files = names.filter((name) => name.endsWith(DOC_EXTENSION))
  return duplicateIds(files, directory).get(files.find((f) => samePath(f, file)) ?? file)
}

/** A check file: its functions are `checks.<name>` in every script. */
export interface CheckFile {
  /** The file's name without `.js`: `pagination` for `checks/pagination.js`. */
  name: string
  /** Where it is, relative to the project, with `/` — for stack traces. */
  filename: string
  code: string
}

/**
 * The check files a project's scripts can call: the global project's, with
 * the project's own replacing any of the same name.
 */
export async function loadChecks(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<CheckFile[]> {
  const byName = new Map<string, CheckFile>()
  for (const place of [...(global ? [global.root] : []), root]) {
    const directory = path.join(place, CHECKS_DIR)
    for (const entry of await readDir(directory)) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const name = entry.name.slice(0, -'.js'.length)
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
      const file = path.join(directory, entry.name)
      byName.set(name, {
        name,
        filename: relativePosix(root, file),
        // Windows editors may save a byte order mark, which would hide `export` on line 1.
        code: stripBom(await fs.readFile(file, 'utf8'))
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------ endpoints -- */

/** One endpoint base: a step of a file in `endpoints/`, whose URL is a path pattern. */
export interface EndpointBase {
  method: HttpMethod
  /** `/users/{id}`. */
  path: string
  /** The endpoint's own headers, settings, `before`, `tests` and docs. */
  step: Step
  /** The file it is in: its own headers, settings and scripts apply to each endpoint. */
  file: Collection
  /** Where the file is, and what it is called in `endpoints/`. */
  filePath: string
  fileName: string
  source: RequestSetRef['source']
}

/** Every endpoints file a project has: its own, then its global project's. */
export async function listEndpointFiles(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<RequestSetRef[]> {
  return [
    ...(await filesIn(root, ENDPOINTS_DIR, 'project')),
    ...(global ? await filesIn(global.root, ENDPOINTS_DIR, 'global') : [])
  ]
}

/**
 * The endpoint bases a project's requests match against: its own, and its
 * global project's for any method + path it does not define itself.
 */
export async function loadEndpoints(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<EndpointBase[]> {
  const own: EndpointBase[] = []
  const shared: EndpointBase[] = []
  for (const file of await listEndpointFiles(root, global)) {
    // One that will not parse, or whose id is wrong, is shown with its problem, not used.
    if (!file.doc || file.problem) continue
    for (const step of file.doc.steps) {
      if (isUseStep(step) || isReadStep(step)) continue
      const { method, url } = readRequestLine(step)
      const base: EndpointBase = {
        method,
        path: url,
        step,
        file: file.doc,
        filePath: file.path,
        fileName: file.name,
        source: file.source
      }
      ;(file.source === 'project' ? own : shared).push(base)
    }
  }
  const key = (base: EndpointBase) => `${base.method} ${pathOf(base.path).join('/')}`
  const defined = new Set(own.map(key))
  return [...own, ...shared.filter((base) => !defined.has(key(base)))]
}

/** What is wrong with an endpoints file's steps as endpoints, if anything. */
export function endpointProblem(doc: Collection): string | undefined {
  if (doc.setup || doc.teardown) return 'an endpoints file has no setup or teardown'
  for (const step of doc.steps) {
    if (isUseStep(step)) return 'an endpoint is a method and a path, not a use: step'
    if (isReadStep(step)) {
      return 'an endpoint is a method and a path, not a step reading a connection'
    }
    if (step.connection !== undefined) return 'an endpoint opens no connection'
    const { method, url } = readRequestLine(step)
    if (!url.startsWith('/'))
      return `${method} ${url}: an endpoint's URL is its path, like /users/{id}`
  }
  return undefined
}

/* ---------------------------------------------------------------- bases -- */

/** Every base collection a project has: its own, then its global project's. */
export async function listBases(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<RequestSetRef[]> {
  return [
    ...(await filesIn(root, BASES_DIR, 'project')),
    ...(global ? await filesIn(global.root, BASES_DIR, 'global') : [])
  ]
}

/** What is wrong with a file as a base collection, if anything. */
export function baseProblem(doc: Collection): string | undefined {
  if (doc.steps.length > 0) return 'a base collection has no steps of its own'
  if (doc.setup || doc.teardown) return 'a base collection has no setup or teardown'
  if (doc.params) return 'a base collection has no params'
  if (doc.extends) return 'a base collection cannot extend another (SPEC.md §2.7)'
  return undefined
}

/**
 * The base collection an `extends:` names: in the project's `bases/` first,
 * then its global project's; `global:name` looks only in the global project's.
 */
export async function resolveBase(
  root: string,
  global: Pick<GlobalProject, 'root'> | null,
  reference: string
): Promise<RequestSetRef & { doc: Collection }> {
  const found = await resolveIn(root, global, reference, BASES_DIR, 'extends')
  const problem = baseProblem(found.doc)
  if (problem) throw new Error(`extends: ${reference} — ${problem}`)
  return found
}

/** The check files of the project a collection is in. */
export async function checksFor(collectionPath: string): Promise<CheckFile[]> {
  const root = projectRootOf(collectionPath) ?? path.dirname(collectionPath)
  const { global } = await readProject(root)
  return loadChecks(root, global)
}

/**
 * What a run reads from the project a collection is in: checks, endpoints,
 * bases and the certificates its requests trust.
 */
export interface Library {
  checks: CheckFile[]
  endpoints: EndpointBase[]
  /** The base collection an `extends:` names; throws when it cannot be used. */
  base: (reference: string) => Promise<Collection>
  /** `tls.ca`, the project's and its global project's (SPEC.md §1.1). */
  tls: ProjectTrust
}

export async function loadLibrary(collectionPath: string): Promise<Library> {
  const root = projectRootOf(collectionPath) ?? path.dirname(collectionPath)
  const info = await readProject(root)
  const { global } = info
  const [checks, endpoints, tls] = await Promise.all([
    loadChecks(root, global),
    loadEndpoints(root, global),
    loadProjectTls(root, info)
  ])
  return {
    checks,
    endpoints,
    base: async (reference) => (await resolveBase(root, global, reference)).doc,
    tls
  }
}

async function readDir(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

const exists = (file: string) =>
  fs
    .stat(file)
    .then((stat) => stat.isFile())
    .catch(() => false)
