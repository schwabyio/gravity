import fs from 'node:fs/promises'
import path from 'node:path'
import { COLLECTIONS_DIR, DOC_EXTENSION, IGNORED_DIRECTORIES } from '../format/constants.js'
import { GitRepo } from '../git/index.js'
import { canonical as canonicalize, isInside } from '../paths.js'

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
