/**
 * Paths into a response body, in the dot/bracket notation `expect.body` keys use.
 *
 *     user.name          a property
 *     groups.0.name      an array index, dot form (what converted xtest suites use)
 *     groups[0].name     the same index, bracket form
 *     sessions[].id      `id` on every item of `sessions`
 *
 * Pure and dependency-free: the engine evaluates with it, and the renderer uses
 * the same parser to find which lines of a body an assertion is about.
 */

export type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  /** `[]`: every item of an array. */
  | { kind: 'each' }

export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  const pattern = /([^.[\]]+)|\[(\d*)\]/g
  for (const match of path.matchAll(pattern)) {
    if (match[1] !== undefined) segments.push({ kind: 'key', key: match[1] })
    else if (match[2] === '') segments.push({ kind: 'each' })
    else segments.push({ kind: 'index', index: Number(match[2]) })
  }
  return segments
}

/** The canonical spelling: brackets for indexes, dots for keys. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = ''
  for (const segment of segments) {
    if (segment.kind === 'key') out += out === '' ? segment.key : `.${segment.key}`
    else if (segment.kind === 'index') out += `[${segment.index}]`
    else out += '[]'
  }
  return out
}

const isIndexKey = (key: string): boolean => /^\d+$/.test(key)

/**
 * Whether a concrete path (no `[]`) is matched by a pattern.
 *
 * A numeric key matches an index, so `groups.0` and `groups[0]` are the same
 * place. With `prefix`, the concrete path may continue past the pattern: that is
 * how an assertion on `roles` claims every line of the array beneath it.
 */
export function pathMatches(
  pattern: readonly PathSegment[],
  concrete: readonly PathSegment[],
  { prefix = false }: { prefix?: boolean } = {}
): boolean {
  if (concrete.length < pattern.length) return false
  if (!prefix && concrete.length !== pattern.length) return false
  return pattern.every((want, i) => {
    const have = concrete[i]!
    if (want.kind === 'each') return have.kind === 'index'
    if (want.kind === 'index') return have.kind === 'index' && have.index === want.index
    if (have.kind === 'key') return have.key === want.key
    return have.kind === 'index' && isIndexKey(want.key) && Number(want.key) === have.index
  })
}

/** A value found at a path, with the concrete path it was found at. */
export interface Located {
  path: PathSegment[]
  value: unknown
}

/**
 * Every value a path reaches.
 *
 * Without `[]` that is zero or one value; `[]` fans out across an array. A
 * missing step yields nothing rather than `undefined`, so "absent" and "present
 * with the value undefined" never blur.
 */
export function resolvePath(root: unknown, pattern: readonly PathSegment[]): Located[] {
  let frontier: Located[] = [{ path: [], value: root }]
  for (const segment of pattern) {
    const next: Located[] = []
    for (const { path, value } of frontier) {
      if (segment.kind === 'each') {
        if (!Array.isArray(value)) continue
        value.forEach((item, index) =>
          next.push({ path: [...path, { kind: 'index', index }], value: item })
        )
        continue
      }
      const step = childOf(value, segment)
      if (step) next.push({ path: [...path, step.segment], value: step.value })
    }
    frontier = next
  }
  return frontier
}

function childOf(
  value: unknown,
  segment: Exclude<PathSegment, { kind: 'each' }>
): { segment: PathSegment; value: unknown } | null {
  if (Array.isArray(value)) {
    const index =
      segment.kind === 'index' ? segment.index : isIndexKey(segment.key) ? Number(segment.key) : -1
    if (index < 0 || index >= value.length) return null
    return { segment: { kind: 'index', index }, value: value[index] }
  }
  if (value === null || typeof value !== 'object' || segment.kind !== 'key') return null
  if (!Object.prototype.hasOwnProperty.call(value, segment.key)) return null
  return { segment, value: (value as Record<string, unknown>)[segment.key] }
}

/**
 * Sort every array of objects in a body by the given properties, as xtest's
 * `sortResponseBodyArrays` did.
 *
 * A property may be a path (`id.value`). Nested arrays sort first. An array is
 * sorted only when at least one of its items holds the property; items without
 * it go last. Values compare alphanumerically, so `Group 2` precedes `Group 10`.
 * With several properties the first is the primary key. Returns a sorted copy.
 */
export function sortArraysBy(value: unknown, properties: readonly string[]): unknown {
  const paths = properties.map(parsePath)
  const sortValue = (item: unknown, path: PathSegment[]): unknown =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? resolvePath(item, path)[0]?.value
      : undefined

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const items = node.map(visit)
      const sortable = paths.some((path) =>
        items.some((item) => sortValue(item, path) !== undefined)
      )
      if (!sortable) return items
      return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          for (const path of paths) {
            const order = compareAlphanumerically(sortValue(a.item, path), sortValue(b.item, path))
            if (order !== 0) return order
          }
          return a.index - b.index
        })
        .map(({ item }) => item)
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]))
    }
    return node
  }
  return visit(value)
}

/** xtest's `compareAlphaNumerically`, so converted suites sort identically. */
export function compareAlphanumerically(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1

  const stringA = String(a)
  const stringB = String(b)
  const chunksA = stringA.match(/\d+|\D+/g) ?? []
  const chunksB = stringB.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < chunksA.length && i < chunksB.length; i++) {
    const chunkA = chunksA[i]!
    const chunkB = chunksB[i]!
    if (/^\d+$/.test(chunkA) && /^\d+$/.test(chunkB)) {
      if (Number(chunkA) !== Number(chunkB)) return Number(chunkA) < Number(chunkB) ? -1 : 1
    } else {
      const lowerA = chunkA.toLowerCase()
      const lowerB = chunkB.toLowerCase()
      if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1
    }
  }
  if (chunksA.length !== chunksB.length) return chunksA.length < chunksB.length ? -1 : 1
  if (stringA !== stringB) return stringA < stringB ? -1 : 1
  return 0
}
