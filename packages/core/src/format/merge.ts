import YAML from 'yaml'
import {
  CollectionSchema,
  HTTP_METHODS,
  type Collection,
  type Step,
  type StepList
} from '../model/documents.js'
import { describeValidation, FormatError } from './errors.js'
import type { ParsedFile } from './index.js'
import { patchIn } from './patch.js'

/**
 * Apply an edited step onto a parsed collection, touching only what changed.
 *
 * The editor works with whole steps, but writing the whole step back would
 * re-emit it and discard every comment inside. So the change set is computed here
 * and applied key by key, at `steps[index].<key>` (or `setup`, `teardown`),
 * leaving the rest of the file — every other step included — exactly as it was.
 *
 * The edits are applied together and validated once at the end: a step is only
 * valid with exactly one method key, so changing GET to POST passes through a
 * moment with none (or two) that must not be judged on its own. A changed method
 * is renamed in place, keeping the line where it was.
 */
export function applyStepEdits(
  file: ParsedFile<Collection>,
  index: number,
  next: Step,
  list: StepList = 'steps'
): ParsedFile<Collection> {
  const before = file.data[list]?.[index] ?? {}
  const edits = diff(before, next)
  if (edits.length === 0) return file

  const document = file.document
  const step = document.getIn([list, index], true)
  const removed = edits.filter(([key, value]) => isMethod(key) && value === undefined)
  const added = edits.filter(
    ([key, value]) => isMethod(key) && value !== undefined && !(key in before)
  )
  let remaining = edits

  if (YAML.isMap(step) && removed.length === 1 && added.length === 1) {
    const [oldMethod] = removed[0]!
    const [newMethod, url] = added[0]!
    const pair = step.items.find((item) => YAML.isScalar(item.key) && item.key.value === oldMethod)
    if (pair && YAML.isScalar(pair.key)) {
      pair.key.value = newMethod
      if (YAML.isScalar(pair.value)) pair.value.value = url
      else pair.value = document.createNode(url)
      remaining = edits.filter(([key]) => key !== oldMethod && key !== newMethod)
    }
  }

  for (const [key, value] of remaining) {
    if (value === undefined) document.deleteIn([list, index, key])
    else {
      if (YAML.isMap(step)) insertInOrder(document, step, key, value, STEP_KEY_ORDER)
      patchIn(document, [list, index, key], value)
      compactList(document, [list, index, key])
      codeAsBlock(document, [list, index], key)
    }
  }

  const result = CollectionSchema.safeParse(document.toJS() ?? {})
  if (!result.success) {
    throw new FormatError(
      `edit to ${list === 'steps' ? '' : `${list} `}step ${index + 1} is invalid — ${describeValidation(result.error)}`,
      undefined,
      result.error
    )
  }
  return { ...file, data: result.data, dirty: true }
}

const isMethod = (key: string): boolean => (HTTP_METHODS as readonly string[]).includes(key)

/** Keys that differ, `undefined` meaning "delete this key". */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Array<[string, unknown]> {
  const edits: Array<[string, unknown]> = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[key], after[key])) edits.push([key, after[key]])
  }
  return edits
}

/**
 * Structural equality via JSON.
 *
 * Adequate here because every document is YAML-derived: plain objects, arrays and
 * scalars, with no dates, maps, sets or cycles.
 */
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/* ------------------------------------------------------ step structure -- */

/**
 * Insert, remove and move steps by splicing the `steps` sequence node itself
 * (or `setup`'s, or `teardown`'s).
 *
 * Each step is one item node carrying its own comments, so moving the node
 * moves them with it, and every step not moved is emitted exactly as before.
 * Rebuilding the list from plain data would re-emit every step instead.
 */
export function insertStep(
  file: ParsedFile<Collection>,
  index: number,
  step: Step,
  list: StepList = 'steps'
): ParsedFile<Collection> {
  return withSteps(file, list, (items, document) => {
    const at = Math.max(0, Math.min(index, items.length))
    items.splice(at, 0, document.createNode(step))
  })
}

export function removeStep(
  file: ParsedFile<Collection>,
  index: number,
  list: StepList = 'steps'
): ParsedFile<Collection> {
  return withSteps(file, list, (items) => {
    if (index < 0 || index >= items.length)
      throw new FormatError(`no ${list} step at index ${index}`, undefined)
    items.splice(index, 1)
  })
}

export function moveStep(
  file: ParsedFile<Collection>,
  from: number,
  to: number,
  list: StepList = 'steps'
): ParsedFile<Collection> {
  return withSteps(file, list, (items) => {
    if (from < 0 || from >= items.length)
      throw new FormatError(`no ${list} step at index ${from}`, undefined)
    const [item] = items.splice(from, 1)
    items.splice(Math.max(0, Math.min(to, items.length)), 0, item)
  })
}

function withSteps(
  file: ParsedFile<Collection>,
  list: StepList,
  change: (items: unknown[], document: YAML.Document.Parsed) => void
): ParsedFile<Collection> {
  const document = file.document
  let steps = document.get(list, true)
  if (!YAML.isSeq(steps)) {
    // `steps: []` written flow-style, or absent: make it a block sequence we own,
    // where a person would put it — setup before steps, teardown after.
    steps = new YAML.YAMLSeq()
    const root = document.contents
    if (YAML.isMap(root) && !root.has(list)) {
      insertInOrder(document, root, list, [], COLLECTION_KEY_ORDER)
    }
    document.set(list, steps)
  }
  change((steps as YAML.YAMLSeq).items, document)
  // An empty flow `[]` that gained items reads better as a block list.
  if ((steps as YAML.YAMLSeq).items.length > 0) (steps as YAML.YAMLSeq).flow = false
  // A setup or teardown with nothing left in it is no list at all.
  else if (list !== 'steps') document.delete(list)

  const result = CollectionSchema.safeParse(file.document.toJS() ?? {})
  if (!result.success) {
    throw new FormatError(
      `step edit is invalid — ${describeValidation(result.error)}`,
      undefined,
      result.error
    )
  }
  return { ...file, data: result.data, dirty: true }
}

/**
 * Write a list of plain values on one line — `tags: [smoke, auth]` — the way
 * people write them by hand, rather than as a block of `- item` lines.
 */
export function compactList(document: YAML.Document, path: ReadonlyArray<string | number>) {
  const value = document.getIn(path, true)
  // A value set from plain data is stored as-is until emitted; make it a node.
  const node = Array.isArray(value) ? document.createNode(value) : value
  if (!YAML.isSeq(node) || !node.items.every((item) => YAML.isScalar(item))) return
  node.flow = true
  if (node !== value) document.setIn(path, node)
}

/**
 * Write code — `tests` and `before.script` — as a `|` block, even one line of
 * it: code reads as code there, and never needs quoting or escaping. Docs too,
 * once they run past a line: markdown is written as it reads.
 */
export function codeAsBlock(
  document: YAML.Document,
  owner: ReadonlyArray<string | number>,
  key: string
) {
  const path =
    key === 'tests'
      ? [...owner, 'tests']
      : key === 'before'
        ? [...owner, 'before', 'script']
        : key === 'docs'
          ? [...owner, 'docs']
          : null
  const node = path && document.getIn(path, true)
  if (!YAML.isScalar(node) || typeof node.value !== 'string') return
  if (key !== 'docs' || node.value.includes('\n')) node.type = 'BLOCK_LITERAL'
}

/** Where keys go in a step, so a newly added one lands where a person would put it. */
export const STEP_KEY_ORDER = [
  'name',
  'use',
  'with',
  ...HTTP_METHODS,
  'connection',
  'forEach',
  'tags',
  'flags',
  'useTests',
  'base',
  'docs',
  'headers',
  'body',
  'settings',
  'before',
  'tests'
]

/** The same for a collection's top-level keys. */
export const COLLECTION_KEY_ORDER = [
  'id',
  'docs',
  'extends',
  'params',
  'tags',
  'stepTags',
  'exclude',
  'flags',
  'headers',
  'settings',
  'vars',
  'before',
  'tests',
  'setup',
  'steps',
  'teardown'
]

/**
 * Add a key that is not there yet at its place in `order`: after the last key
 * present that comes before it. An existing key is left where it is — the
 * caller then sets its value in place.
 */
export function insertInOrder(
  document: YAML.Document,
  map: YAML.YAMLMap,
  key: string,
  value: unknown,
  order: readonly string[]
) {
  if (map.has(key)) return
  const rank = order.indexOf(key)
  if (rank < 0) return
  const keys = map.items.map((pair) => (YAML.isScalar(pair.key) ? String(pair.key.value) : ''))
  let at = 0
  keys.forEach((existing, i) => {
    const r = order.indexOf(existing)
    if (r >= 0 && r < rank) at = i + 1
  })
  const pair = document.createPair(key, value) as (typeof map.items)[number]
  // Its entries' small maps — a variable's `{ secret: true }` — go on one line.
  if (YAML.isMap(pair.value)) {
    for (const item of pair.value.items) {
      if (YAML.isMap(item.value) && item.value.items.every((inner) => YAML.isScalar(inner.value))) {
        item.value.flow = true
      }
    }
  }
  // A comment above the first key heads the file; it stays at the top.
  const first = at === 0 ? map.items[0] : undefined
  if (first && YAML.isScalar(first.key) && first.key.commentBefore && YAML.isScalar(pair.key)) {
    pair.key.commentBefore = first.key.commentBefore
    first.key.commentBefore = undefined
  }
  map.items.splice(at, 0, pair)
}
