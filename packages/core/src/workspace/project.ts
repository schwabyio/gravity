import fs from 'node:fs/promises'
import path from 'node:path'
import {
  COLLECTIONS_DIR,
  CHECKS_DIR,
  DOC_EXTENSION,
  ENVIRONMENTS_DIR,
  BASES_DIR,
  ENDPOINTS_DIR,
  IGNORED_DIRECTORIES,
  PROJECT_FILE,
  REQUESTS_DIR,
  SETTINGS_FILE
} from '../format/constants.js'
import { parseEnvironment, parseProject } from '../format/index.js'
import type { ProjectDoc } from '../model/documents.js'
import type { EnvironmentRef, LoadProblem } from '../model/tree.js'
import {
  canonical,
  foldName,
  nameProblem,
  relativePosix,
  resolveRelative,
  samePath,
  spellingProblem
} from '../paths.js'

/**
 * A project: one folder holding `collections/`, `environments/` and, if it
 * wants one, `project.yml` (SPEC.md §1).
 *
 * Everything here is bounded by the project folder. Nothing walks up the
 * filesystem looking for a directory by name, so a project never picks up an
 * `environments/` that belongs to something else.
 */

/** What `collections/` holds: files at its root and one directory down. */
export interface ProjectLayout {
  root: string
  collectionsDir: string
  /** Collection files, absolute, sorted by their place in `collections/`. */
  files: string[]
  /** The directories inside `collections/`, sorted — empty ones included. */
  directories: string[]
  problems: LoadProblem[]
}

/** A project's `project.yml`, and the global project it uses. */
export interface ProjectInfo {
  /** The parsed `project.yml`, or null when there is none (or it will not parse). */
  doc: ProjectDoc | null
  /** Its text, for editing against; null when the file does not exist. */
  source: string | null
  global: GlobalProject | null
  problems: LoadProblem[]
}

export interface GlobalProject {
  root: string
  doc: ProjectDoc
  /** Its `project.yml` text, for editing against. */
  source: string
  /** As written in `uses:`, with `/`. */
  uses: string
}

/**
 * The project a chosen folder stands for: the folder itself, or — when the
 * folder picked is a `collections/` directory — the one holding it.
 */
export async function projectRootFor(folder: string): Promise<string> {
  const absolute = await canonical(folder)
  return path.basename(absolute) === COLLECTIONS_DIR ? path.dirname(absolute) : absolute
}

/** Where a project keeps collection files: its collections, and its request sets. */
const HOMES = new Set([COLLECTIONS_DIR, REQUESTS_DIR, ENDPOINTS_DIR, BASES_DIR])

/**
 * The project a collection file belongs to: two steps up at most, since a
 * collection — or a request set — sits in `collections/` (`requests/`) or one
 * directory inside it.
 */
export function projectRootOf(collectionFile: string): string | null {
  const directory = path.dirname(path.resolve(collectionFile))
  if (HOMES.has(path.basename(directory))) return path.dirname(directory)
  const parent = path.dirname(directory)
  if (HOMES.has(path.basename(parent))) return path.dirname(parent)
  return null
}

/** The directory a collection sits in inside `collections/`, or null at its root. */
export function directoryOf(collectionFile: string): string | null {
  const directory = path.dirname(path.resolve(collectionFile))
  return HOMES.has(path.basename(directory)) ? null : path.basename(directory)
}

const isHidden = (name: string) => name.startsWith('.') || IGNORED_DIRECTORIES.has(name)
const isCollectionFile = (name: string) => name.endsWith(DOC_EXTENSION) && !name.startsWith('.')

/**
 * Read `collections/`: its own `.yml` files and those one directory down.
 * Anything deeper is reported, not loaded — directories go one level deep.
 */
export async function discoverProject(root: string): Promise<ProjectLayout> {
  const collectionsDir = path.join(root, COLLECTIONS_DIR)
  const layout: ProjectLayout = { root, collectionsDir, files: [], directories: [], problems: [] }

  const entries = await readDir(collectionsDir)
  for (const entry of entries) {
    if (entry.isFile() && isCollectionFile(entry.name)) {
      layout.files.push(path.join(collectionsDir, entry.name))
    } else if (entry.isDirectory() && !isHidden(entry.name)) {
      layout.directories.push(entry.name)
      const directory = path.join(collectionsDir, entry.name)
      for (const inner of await readDir(directory)) {
        if (inner.isFile() && isCollectionFile(inner.name)) {
          layout.files.push(path.join(directory, inner.name))
        } else if (inner.isDirectory() && !isHidden(inner.name)) {
          layout.problems.push({
            path: `${entry.name}/${inner.name}`,
            message: `Directories inside collections/ go one level deep, so collections/${entry.name}/${inner.name}/ is not read (SPEC.md §1)`
          })
        }
      }
    }
  }

  const byPlace = (file: string) => relativePosix(collectionsDir, file)
  layout.files.sort((a, b) => byPlace(a).localeCompare(byPlace(b)))
  layout.directories.sort((a, b) => a.localeCompare(b))
  layout.problems.push(...(await portabilityProblems(root)))
  return layout
}

/** What gta looks for at a project's root. */
const PROJECT_NAMES = [
  COLLECTIONS_DIR,
  ENVIRONMENTS_DIR,
  REQUESTS_DIR,
  ENDPOINTS_DIR,
  BASES_DIR,
  CHECKS_DIR,
  PROJECT_FILE,
  SETTINGS_FILE
]

/**
 * What would make the project read differently on another platform (SPEC.md
 * §1.2), each against its path from the project:
 *
 * - `Collections/` for `collections/`: macOS and Windows find it, Linux does not.
 * - Two names in one directory that differ only in case: Linux holds both, a
 *   macOS or Windows checkout only one.
 * - A name Windows refuses, such as `aux`: a Windows checkout cannot hold it.
 *
 * Collection files are checked with their ids (ids.ts).
 */
async function portabilityProblems(root: string): Promise<LoadProblem[]> {
  const problems: LoadProblem[] = []
  const atRoot = (await readDir(root)).map((entry) => entry.name)
  for (const wanted of PROJECT_NAMES) {
    if (atRoot.includes(wanted)) continue
    const variant = atRoot.find((name) => foldName(name) === foldName(wanted))
    if (variant) {
      problems.push({
        path: variant,
        message: `must be named ${wanted}: macOS and Windows read it as it is, Linux does not (SPEC.md §1.2)`
      })
    }
  }
  for (const home of [COLLECTIONS_DIR, REQUESTS_DIR, ENDPOINTS_DIR, BASES_DIR]) {
    const directories = (await readDir(path.join(root, home)))
      .filter((entry) => entry.isDirectory() && !isHidden(entry.name))
      .map((entry) => entry.name)
    problems.push(...portableNameProblems(home, directories))
  }
  for (const [home, extension] of [
    [ENVIRONMENTS_DIR, DOC_EXTENSION],
    [CHECKS_DIR, '.js']
  ] as const) {
    const files = (await readDir(path.join(root, home)))
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => entry.name)
    problems.push(...portableNameProblems(home, files))
  }
  return problems
}

/** Names in one directory, `home`, that Windows refuses, or that differ only in case. */
export function portableNameProblems(home: string, names: readonly string[]): LoadProblem[] {
  const problems: LoadProblem[] = []
  const alike = new Map<string, string[]>()
  for (const name of names) {
    const unusable = nameProblem(name)
    if (unusable) problems.push({ path: `${home}/${name}`, message: `${unusable} (SPEC.md §1.2)` })
    alike.set(foldName(name), [...(alike.get(foldName(name)) ?? []), name])
  }
  for (const group of alike.values()) {
    if (group.length < 2) continue
    for (const name of group) {
      const others = group.filter((other) => other !== name).map((other) => `${home}/${other}`)
      problems.push({
        path: `${home}/${name}`,
        message: `differs only in case from ${others.join(', ')}: a macOS or Windows checkout can hold only one of them (SPEC.md §1.2)`
      })
    }
  }
  return problems
}

/**
 * Read `project.yml` and the global project it `uses`. Every way that can go
 * wrong is a problem on the project, never a thrown error: a broken link must
 * not cost the project its collections.
 */
export async function readProject(root: string): Promise<ProjectInfo> {
  const info: ProjectInfo = { doc: null, source: null, global: null, problems: [] }
  const own = await readProjectFile(root)
  info.source = own.source
  if (own.problem) info.problems.push(own.problem)
  info.doc = own.doc
  if (!own.doc?.uses) return info

  const uses = own.doc.uses.replace(/\\/g, '/')
  let target: string
  try {
    target = await canonical(resolveRelative(root, uses))
  } catch (cause) {
    info.problems.push({ path: PROJECT_FILE, message: (cause as Error).message })
    return info
  }
  const problem = (message: string) => info.problems.push({ path: PROJECT_FILE, message })

  // realpath would quietly correct `../Shared` on macOS or Windows; Linux would not find it.
  const misspelled = await spellingProblem(root, uses)
  if (misspelled) {
    problem(`uses: ${misspelled}`)
    return info
  }
  if (samePath(target, root)) {
    problem('uses points at this project itself')
    return info
  }
  const global = await readProjectFile(target)
  if (global.source === null) {
    problem(`uses: ${uses} — there is no ${PROJECT_FILE} there, so it is not a project`)
    return info
  }
  if (global.problem || !global.doc) {
    problem(`uses: ${uses} — its ${PROJECT_FILE} will not read: ${global.problem?.message ?? ''}`)
    return info
  }
  if (global.doc.uses) {
    problem(`uses: ${uses} — a global project cannot use another one (SPEC.md §1.1)`)
    return info
  }
  info.global = { root: target, doc: global.doc, source: global.source, uses }
  return info
}

async function readProjectFile(
  root: string
): Promise<{ doc: ProjectDoc | null; source: string | null; problem: LoadProblem | null }> {
  let source: string
  try {
    source = await fs.readFile(path.join(root, PROJECT_FILE), 'utf8')
  } catch {
    return { doc: null, source: null, problem: null }
  }
  try {
    return { doc: parseProject(source, PROJECT_FILE).data, source, problem: null }
  } catch (cause) {
    return {
      doc: null,
      source,
      problem: {
        path: PROJECT_FILE,
        message: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }
}

/**
 * Every environment file a project can use: its own, then its global
 * project's, each by declared name or filename.
 */
export async function projectEnvironments(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<EnvironmentRef[]> {
  const own = await readEnvironments(path.join(root, ENVIRONMENTS_DIR), 'project')
  const shared = global
    ? await readEnvironments(path.join(global.root, ENVIRONMENTS_DIR), 'global')
    : []
  return [...own, ...shared]
}

/** The environment files in a directory, by declared name or filename. */
export async function readEnvironments(
  directory: string,
  source: EnvironmentRef['source'] = 'project'
): Promise<EnvironmentRef[]> {
  const environments: EnvironmentRef[] = []
  for (const entry of await readDir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(DOC_EXTENSION)) continue
    const file = path.join(directory, entry.name)
    let name = path.basename(entry.name, DOC_EXTENSION)
    try {
      name = parseEnvironment(await fs.readFile(file, 'utf8'), file).data.name ?? name
    } catch {
      // A broken environment file still lists, under its filename.
    }
    environments.push({ name, path: file, source })
  }
  return environments.sort((a, b) => a.name.localeCompare(b.name))
}

async function readDir(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}
