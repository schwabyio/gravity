import { formatPath, resolvePath, type PathSegment } from '../model/path.js'
import type { Coverage } from './evaluate.js'

const REMOVED = Symbol('removed')

/**
 * Body paths that nothing accounted for, for `expect.strict`.
 *
 * Mirrors xtest's strict validation: work on a copy of the body, remove what
 * each entry claimed, then prune. xtest's prune also drops `null`, `""` and
 * empty containers, so those never need an assertion of their own; converted
 * suites depend on that, so it is kept.
 */
export function findUnasserted(body: unknown, covered: readonly Coverage[]): string[] {
  const root = { value: structuredClone(body) as unknown }

  for (const coverage of covered) {
    for (const { path } of resolvePath(root.value, coverage.pattern)) remove(root, path)
  }

  const leaves: string[] = []
  collectLeaves(prune(root.value), [], leaves)
  return leaves
}

function remove(root: { value: unknown }, path: PathSegment[]) {
  if (path.length === 0) {
    root.value = REMOVED
    return
  }
  const parent = resolvePath(root.value, path.slice(0, -1))[0]?.value
  const last = path[path.length - 1]!
  if (Array.isArray(parent) && last.kind === 'index') parent[last.index] = REMOVED
  else if (parent !== null && typeof parent === 'object' && last.kind === 'key') {
    delete (parent as Record<string, unknown>)[last.key]
  }
}

/** `undefined` when nothing is left worth asserting. */
function prune(value: unknown): unknown {
  if (value === REMOVED || value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number' && Number.isNaN(value)) return undefined
  if (Array.isArray(value)) {
    // Keep positions, so a leftover item still reports its real index.
    const items = value.map(prune)
    return items.every((item) => item === undefined) ? undefined : items
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, child]) => [key, prune(child)] as const)
      .filter(([, child]) => child !== undefined)
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
  }
  return value
}

function collectLeaves(value: unknown, path: PathSegment[], out: string[]) {
  if (value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, [...path, { kind: 'index', index }], out))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, [...path, { kind: 'key', key }], out)
    }
  } else {
    out.push(formatPath(path))
  }
}
