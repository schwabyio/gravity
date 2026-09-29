/**
 * How collections are presented: a summary per file, and the directory grouping
 * they are shown in.
 *
 * These live in the model because they cross the IPC boundary — the renderer
 * draws this and must import it without pulling the filesystem into a sandboxed
 * bundle.
 */

/** An environment file a project can use. */
export interface EnvironmentRef {
  name: string
  path: string
  /**
   * The project's own `environments/`, or its global project's. Two files of
   * the same name are one environment: the global's values under the project's.
   */
  source: 'project' | 'global'
}

/** Environment names to choose from, once each, sorted. */
export const environmentNames = (environments: EnvironmentRef[]): string[] =>
  [...new Set(environments.map((environment) => environment.name))].sort((a, b) =>
    a.localeCompare(b)
  )

/** A file that could not be read. Never fatal: the rest still loads. */
export interface LoadProblem {
  path: string
  message: string
}

/** What the sidebar needs to know about a collection without opening it. */
export interface CollectionSummary {
  /** Absolute path to the collection file. */
  path: string
  /** Path inside the project's `collections/`, written with `/`: `checkout/sessions.yml`. */
  relativePath: string
  /** The directory it sits in inside `collections/`, or null at the root. */
  directory: string | null
  name: string
  stepCount: number
  /** Every tag used in the collection, its own and its steps', sorted. */
  tags: string[]
  /** The file says `exclude: true`: left out of group runs. */
  excluded?: boolean
  /** Its data file (SPEC.md §2.8), in its place in `collections/`, and how many rows it has. */
  dataFile?: { relativePath: string; rows: number } | null
  /**
   * The `environments/` directory this collection resolves against, or null.
   *
   * Every collection sharing one of these shares its chosen environment: the
   * choice belongs to the set of environments, not to a single file.
   */
  environmentsPath: string | null
  /** Non-empty when the file exists but could not be read. */
  problems: LoadProblem[]
}

export type CollectionNode =
  | { kind: 'directory'; name: string; path: string; children: CollectionNode[] }
  | { kind: 'collection'; summary: CollectionSummary }

/**
 * Group a project's collections by the directory they sit in — one level, as
 * SPEC.md §1 has it: each directory (empty ones included, when `directories`
 * lists them) with its collections, then the collections at the root.
 */
export function groupByDirectory(
  collections: CollectionSummary[],
  directories: string[] = []
): CollectionNode[] {
  const byName = (a: CollectionSummary, b: CollectionSummary) => a.name.localeCompare(b.name)
  const names = [
    ...new Set([
      ...directories,
      ...collections.flatMap((summary) => (summary.directory ? [summary.directory] : []))
    ])
  ].sort((a, b) => a.localeCompare(b))

  return [
    ...names.map((name): CollectionNode => ({
      kind: 'directory',
      name,
      path: name,
      children: collections
        .filter((summary) => summary.directory === name)
        .sort(byName)
        .map((summary) => ({ kind: 'collection', summary }))
    })),
    ...collections
      .filter((summary) => summary.directory === null)
      .sort(byName)
      .map((summary): CollectionNode => ({ kind: 'collection', summary }))
  ]
}

/** Every collection in a grouping, in display order. */
export function flattenCollections(nodes: CollectionNode[]): CollectionSummary[] {
  return nodes.flatMap((node) =>
    node.kind === 'collection' ? [node.summary] : flattenCollections(node.children)
  )
}
