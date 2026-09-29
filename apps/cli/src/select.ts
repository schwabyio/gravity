import { DOC_EXTENSION, stepsForTags, type LoadedCollection } from '@schwabyio/gravity-core'
import { UsageError } from './args.js'

/**
 * Which collections a command runs, and which of their steps.
 *
 * A collection is named by its id — `smoke`, `sessions` — which is unique in the
 * project (SPEC.md §2); its place in `collections/`, `checkout/sessions`, names
 * it too. A directory is named by its name, `checkout`, standing for every
 * collection in it, in place (SPEC.md §1); `checkout/` names only the
 * directory, should a collection have the same id.
 *
 * A collection with `exclude: true` is left out of group runs — `all`, and a
 * directory — but runs when named on its own (SPEC.md §2.4).
 */
export interface RunTarget {
  /** Its id: the file name without `.yml`, unique in the project. */
  id: string
  collection: LoadedCollection
  /** The steps a tag selection picked, in order; null for every step. */
  steps: number[] | null
  /** Why the file cannot run, when it will not parse. It is reported, never dropped. */
  broken: string | null
}

export interface Selection {
  targets: RunTarget[]
  /** Collections left out because they say `exclude: true`, by id. */
  excluded: string[]
  /** How many collections `tags` / `notTags` left with nothing to run. */
  untagged: number
}

export type Request = { kind: 'all' } | { kind: 'list'; selectors: string[] }

/**
 * A `use:` or `extends:` in a collection that loads, which a run would stop
 * at: `gta get` reports it without running anything (SPEC.md Appendix A).
 */
export interface ListingProblem {
  id: string
  /** Why `gta all` leaves the collection out, or null when it runs it. */
  leftOut: 'excluded' | 'tags' | null
  /** The use step's index in `steps`; null for `extends:`. */
  step: number | null
  message: string
}

/** A collection's id: `LoadedCollection.name` is its file name, which the id must be. */
export const idOf = (collection: LoadedCollection): string => collection.name

/** Its place in `collections/` without `.yml`: `checkout/sessions`. */
const placeOf = (collection: LoadedCollection): string =>
  collection.relativePath.slice(0, -DOC_EXTENSION.length)

/** `./collections/checkout/` and `checkout\sessions.yml` name what they look like they name. */
const normalize = (selector: string): { name: string; directoryOnly: boolean } => {
  // NFC, as directory names are compared: macOS may spell `Café/` either way.
  const cleaned = selector
    .normalize('NFC')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^collections\//, '')
  return {
    name: cleaned.replace(/\/+$/, '').replace(/\.yml$/, ''),
    directoryOnly: cleaned.endsWith('/')
  }
}

export function selectCollections(
  collections: readonly LoadedCollection[],
  request: Request,
  options: { tags: readonly string[]; notTags?: readonly string[] }
): Selection {
  const excluded = new Set<LoadedCollection>()
  /** In a group run, an excluded collection is noted and left out. */
  const inGroup = (group: readonly LoadedCollection[]) =>
    group.filter((c) => {
      if (c.doc.exclude === true) excluded.add(c)
      return c.doc.exclude !== true
    })

  let chosen: LoadedCollection[]
  if (request.kind === 'list') {
    const unknown: string[] = []
    chosen = []
    for (const selector of request.selectors) {
      const { name, directoryOnly } = normalize(selector)
      const exact = directoryOnly
        ? undefined
        : (collections.find((c) => idOf(c) === name) ??
          collections.find((c) => placeOf(c).normalize('NFC') === name))
      const inDirectory = collections.filter((c) => c.directory?.normalize('NFC') === name)
      const found = exact ? [exact] : inDirectory.length > 0 ? inGroup(inDirectory) : null
      if (found) chosen.push(...found.filter((c) => !chosen.includes(c)))
      else unknown.push(selector)
    }
    if (unknown.length > 0) {
      throw new UsageError(
        `No collection or directory is called ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
          'List them with: gta get'
      )
    }
  } else {
    chosen = inGroup(collections)
  }

  const targets: RunTarget[] = []
  let untagged = 0
  for (const collection of chosen) {
    const id = idOf(collection)
    if (collection.problems.length > 0) {
      const broken = collection.problems.map((p) => p.message).join('; ')
      targets.push({ id, collection, steps: null, broken })
      continue
    }
    const picked = stepsForTags(collection.doc, options.tags, options.notTags ?? [])
    if (picked.length === 0 && (options.tags.length > 0 || (options.notTags ?? []).length > 0)) {
      untagged++
      continue
    }
    const all = picked.length === collection.doc.steps.length
    targets.push({ id, collection, steps: all ? null : picked, broken: null })
  }
  return {
    targets,
    // Named on its own, an excluded collection ran: it was not left out.
    excluded: [...excluded].filter((c) => !chosen.includes(c)).map(idOf),
    untagged
  }
}

/** How many steps a target runs. */
export const stepCountOf = (target: RunTarget): number =>
  target.steps?.length ?? target.collection.doc.steps.length
