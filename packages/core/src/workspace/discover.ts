import fs from 'node:fs/promises'
import path from 'node:path'
import { COLLECTIONS_DIR, DOC_EXTENSION, IGNORED_DIRECTORIES } from '../format/constants.js'
import { GitRepo } from '../git/index.js'
import { canonical as canonicalize, isInside } from '../paths.js'
import { readProject } from './project.js'

/** How deep the non-git fallback walk will go before giving up. */
const MAX_WALK_DEPTH = 10

/** A `collections/` directory and everything in it. */
export interface CollectionsDir {
  /** Absolute path to the `collections/` directory. */
  path: string
  /**
   * Where it sits, relative to the workspace root, minus the directory itself.
   *
   * Empty for `<workspace>/collections`; `services/auth` for a monorepo's
   * `services/auth/collections`. Used to keep two services' collections apart
   * without showing the constant `collections/` segment in every row.
   */
  scope: string
  /** Collection files inside it, at any depth. */
  files: string[]
}

/**
 * Find every `collections/` directory under a folder, at any depth.
 *
 * Only for moving an old workspace — one folder that could hold several
 * services — onto projects; everything else reads one project with
 * `discoverProject`.
 *
 * Find every collection in a workspace.
 *
 * Collections live under a directory named `collections/`; directories inside
 * that group them and carry no meaning of their own. A workspace may hold several
 * `collections/` directories — one per service in a monorepo — and each keeps its
 * own scope.
 */
export async function discoverCollections(root: string): Promise<CollectionsDir[]> {
  const absoluteRoot = await canonicalize(root)
  const repo = await GitRepo.open(absoluteRoot)

  const files = repo
    ? await filesViaGit(repo, absoluteRoot)
    : await filesViaWalk(absoluteRoot, absoluteRoot)

  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const directory = collectionsDirOf(file)
    if (!directory) continue
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file])
  }

  return [...byDirectory]
    .map(([directory, contents]) => ({
      path: directory,
      scope: path.relative(absoluteRoot, path.dirname(directory)),
      files: contents.sort()
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/** The nearest ancestor named `collections`, or null when there is none. */
export function collectionsDirOf(file: string): string | null {
  let current = path.dirname(path.resolve(file))
  for (;;) {
    if (path.basename(current) === COLLECTIONS_DIR) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function filesViaGit(repo: GitRepo, root: string): Promise<string[]> {
  const entries = await repo.listFiles(`*${DOC_EXTENSION}`)
  const files: string[] = []

  for (const entry of entries) {
    const absolute = path.resolve(repo.root, entry)
    // ls-files runs from the repo root, so a workspace pointed at a
    // subdirectory must discard everything outside it.
    if (!isInside(root, absolute)) continue
    if (!collectionsDirOf(absolute)) continue
    if (hasIgnoredSegment(path.relative(root, absolute))) continue
    files.push(absolute)
  }
  return files
}

async function filesViaWalk(root: string, current: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return []

  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      files.push(...(await filesViaWalk(root, full, depth + 1)))
    } else if (entry.isFile() && entry.name.endsWith(DOC_EXTENSION) && collectionsDirOf(full)) {
      files.push(full)
    }
  }
  return files
}

const hasIgnoredSegment = (relativePath: string): boolean =>
  relativePath
    .split(/[/\\]/)
    .slice(0, -1)
    .some((segment) => IGNORED_DIRECTORIES.has(segment) || segment.startsWith('.'))

/** How deep a search for projects goes: far enough for `services/<team>/<service>/`. */
const MAX_PROJECT_DEPTH = 6

/**
 * Every project in a folder: each folder holding a `collections/`, at any depth
 * down to a few levels, and each global project one of them `uses:` inside the
 * folder (SPEC.md §1, §1.1). For adding a monorepo's projects at once.
 *
 * Folders never searched — `node_modules`, a dot-folder, build output — are
 * skipped, and so is what is inside a `collections/`, which only groups
 * collections. Canonical paths, sorted.
 */
export async function findProjects(folder: string): Promise<string[]> {
  const root = await canonicalize(folder)
  const found: string[] = []

  const walk = async (current: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    const folders = entries.filter(
      (entry) =>
        entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')
    )
    if (folders.some((entry) => entry.name === COLLECTIONS_DIR)) found.push(current)
    if (depth >= MAX_PROJECT_DEPTH) return
    for (const entry of folders) {
      if (entry.name !== COLLECTIONS_DIR) await walk(path.join(current, entry.name), depth + 1)
    }
  }
  await walk(root, 0)

  // A global project need hold no collections: it is found by those using it.
  const shared = await Promise.all(
    found.map(async (project) => (await readProject(project)).global?.root ?? null)
  )
  const all = new Set(found)
  for (const global of shared) {
    if (global && isInside(root, global)) all.add(global)
  }
  return [...all].sort((a, b) => a.localeCompare(b))
}
