import path from 'node:path'
import { COLLECTIONS_DIR, ENVIRONMENTS_DIR } from '../format/constants.js'
import { parseCollection } from '../format/index.js'
import { relativePosix } from '../paths.js'
import { idOfFile, idProblem, duplicateIds } from './ids.js'
import { findDataFile, readDataFile } from './dataFile.js'
import { directoryOf, discoverProject } from './project.js'
import { readText } from './readFolder.js'
import { stepLabel, type Collection } from '../model/documents.js'
import type { CollectionSummary, LoadProblem } from '../model/tree.js'

/** A collection file, loaded. */
export interface LoadedCollection {
  /** Absolute path to the collection file. */
  path: string
  /** Its place in `collections/`, written with `/`. */
  relativePath: string
  /** The directory it sits in inside `collections/`, or null at the root. */
  directory: string | null
  /** Its id: the file name without `.yml`, unique in `collections/` (SPEC.md §2). */
  name: string
  doc: Collection
  /** Display names of the steps, in run order. */
  stepNames: string[]
  /** The project's `environments/` directory, whether or not it exists yet. */
  environmentsPath: string
  /**
   * The data file beside it (SPEC.md §2.8), in its place in `collections/` and
   * with its row count; null when it has none. One that will not read is a problem.
   */
  dataFile: { path: string; relativePath: string; rows: number } | null
  problems: LoadProblem[]
}

/**
 * Read one collection file of the project at `root`.
 *
 * A file that will not parse comes back as an empty collection carrying the
 * problem, so one bad file never costs the sidebar every other collection.
 */
export async function loadCollection(file: string, root: string): Promise<LoadedCollection> {
  const absolute = path.resolve(file)
  const relativePath = relativePosix(path.join(root, COLLECTIONS_DIR), absolute)
  const fallbackName = idOfFile(absolute)

  let doc: Collection = { steps: [] }
  const problems: LoadProblem[] = []
  try {
    doc = parseCollection(await readText(absolute), relativePath).data
  } catch (cause) {
    problems.push({
      path: relativePath,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }

  // A file that parses but has the wrong id still opens, so it can be fixed.
  const wrongId = problems.length === 0 ? idProblem(doc, absolute) : null
  if (wrongId) problems.push({ path: relativePath, message: wrongId })

  let dataFile: LoadedCollection['dataFile'] = null
  const dataPath = await findDataFile(absolute)
  if (dataPath) {
    const dataRelative = relativePosix(path.join(root, COLLECTIONS_DIR), dataPath)
    try {
      const data = await readDataFile(dataPath)
      dataFile = { path: dataPath, relativePath: dataRelative, rows: data.rows.length }
    } catch (cause) {
      // Running it without its rows would test less than it says it does.
      problems.push({ path: dataRelative, message: (cause as Error).message })
      dataFile = { path: dataPath, relativePath: dataRelative, rows: 0 }
    }
  }

  return {
    path: absolute,
    relativePath,
    directory: directoryOf(absolute),
    name: fallbackName,
    doc,
    stepNames: doc.steps.map(stepLabel),
    environmentsPath: path.join(root, ENVIRONMENTS_DIR),
    dataFile,
    problems
  }
}

/** Just enough for the sidebar, without keeping every step in memory. */
export const summarize = (collection: LoadedCollection): CollectionSummary => ({
  path: collection.path,
  relativePath: collection.relativePath,
  directory: collection.directory,
  name: collection.name,
  stepCount: collection.doc.steps.length,
  tags: [
    ...new Set([
      ...(collection.doc.tags ?? []),
      ...collection.doc.steps.flatMap((step) => step.tags ?? [])
    ])
  ].sort(),
  excluded: collection.doc.exclude === true,
  environmentsPath: collection.environmentsPath,
  dataFile: collection.dataFile
    ? { relativePath: collection.dataFile.relativePath, rows: collection.dataFile.rows }
    : null,
  problems: collection.problems
})

/**
 * Every collection in a project's `collections/`, loaded, each id checked
 * against the others: a collection whose id another one shares carries a
 * problem saying so, as one whose id is wrong does. Both the app and `gta` load
 * a project this way, so they agree on what is broken.
 */
export async function loadProjectCollections(
  root: string,
  files?: readonly string[]
): Promise<LoadedCollection[]> {
  const list = files ?? (await discoverProject(root)).files
  const duplicates = duplicateIds(list, path.join(root, COLLECTIONS_DIR))
  const loaded = await Promise.all(list.map((file) => loadCollection(file, root)))
  for (const collection of loaded) {
    const duplicate = duplicates.get(collection.path)
    if (duplicate) collection.problems.push({ path: collection.relativePath, message: duplicate })
  }
  return loaded
}
