import type { CollectionSummary } from '@schwabyio/gravity-core/model'

/**
 * Filtering a project's files in the sidebar by what is typed: pure, so the
 * sidebar and its tests agree on what matches.
 *
 * Every word typed must be found, in any case, in what a file is called or
 * where it is: a collection's name, its directory or one of its tags; a
 * request set's, endpoints file's or base's name. `checkout sess` finds
 * `checkout/sessions`, and `smoke` a collection tagged smoke.
 */
export function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = fields
    .filter((field): field is string => Boolean(field))
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/** Whether anything is being filtered for. */
export const filtering = (query: string): boolean => query.trim() !== ''

/**
 * A project's collections and directories that a filter keeps: each collection
 * that matches, and each directory holding one of them — or, empty, one whose
 * own name matches.
 */
export function filterCollections(
  collections: CollectionSummary[],
  directories: string[],
  query: string
): { collections: CollectionSummary[]; directories: string[] } {
  if (!filtering(query)) return { collections, directories }
  const kept = collections.filter((summary) =>
    matches(query, summary.name, summary.directory, ...summary.tags)
  )
  const holding = new Set(kept.flatMap((summary) => (summary.directory ? [summary.directory] : [])))
  return {
    collections: kept,
    directories: directories.filter((name) => holding.has(name) || matches(query, name))
  }
}

/** A library file — a request set, endpoints file or base — that a filter keeps. */
export const keepsFile = (query: string, file: { name: string; title: string }): boolean =>
  matches(query, file.title, file.name)
