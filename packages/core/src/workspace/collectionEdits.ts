import YAML from 'yaml'
import path from 'node:path'
import { idOfFile } from './ids.js'
import {
  applyStepEdits,
  COLLECTION_KEY_ORDER,
  codeAsBlock,
  compactList,
  insertInOrder,
  editCollection,
  insertStep,
  moveStep,
  parseCollection,
  removeStep,
  serialize,
  type ParsedFile
} from '../format/index.js'
import type { Collection, Step, StepList } from '../model/documents.js'
import { writeIfUnchanged, type EditOutcome } from './writeFile.js'

export type { EditOutcome }

/**
 * One change to a collection file, applied in order with the others in its
 * batch. A step edit is to `steps` unless `list` names `setup` or `teardown`.
 */
export type CollectionEdit =
  | { type: 'editStep'; index: number; step: Step; list?: StepList }
  | { type: 'insertStep'; index: number; step: Step; list?: StepList }
  | { type: 'removeStep'; index: number; list?: StepList }
  | { type: 'moveStep'; from: number; to: number; list?: StepList }
  /** Set (or, with `undefined`, remove) a collection-level field. */
  | { type: 'editCollection'; key: CollectionField; value: unknown }

/** Collection-level fields the app edits. */
export const COLLECTION_FIELDS = [
  'id',
  'tags',
  'stepTags',
  'exclude',
  'flags',
  'headers',
  'settings',
  'vars',
  'before',
  'tests',
  'params',
  'extends'
] as const
export type CollectionField = (typeof COLLECTION_FIELDS)[number]

/**
 * Apply a batch of edits to a collection file: one write per batch, only
 * against the text they were made against (see `writeIfUnchanged`).
 */
export async function applyCollectionEdits(
  file: string,
  baseSource: string,
  edits: CollectionEdit[]
): Promise<EditOutcome> {
  // An id is the file's name (SPEC.md §2): the only id an edit may write is that one.
  const expected = idOfFile(file)
  for (const edit of edits) {
    if (edit.type === 'editCollection' && edit.key === 'id' && edit.value !== expected) {
      throw new Error(`id: must be ${expected}, the file name`)
    }
  }
  return writeIfUnchanged(file, baseSource, (source) =>
    editSource(source, edits, path.basename(file))
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The pure part: collection text in, edited collection text out. */
export function editSource(source: string, edits: CollectionEdit[], name?: string): string {
  let parsed: ParsedFile<Collection> = parseCollection(source, name)
  for (const edit of edits) {
    switch (edit.type) {
      case 'editStep':
        parsed = applyStepEdits(parsed, edit.index, edit.step, edit.list)
        break
      case 'insertStep':
        parsed = insertStep(parsed, edit.index, edit.step, edit.list)
        break
      case 'removeStep':
        parsed = removeStep(parsed, edit.index, edit.list)
        break
      case 'moveStep':
        parsed = moveStep(parsed, edit.from, edit.to, edit.list)
        break
      case 'editCollection':
        if (!same(parsed.data[edit.key], edit.value)) {
          const root = parsed.document.contents
          if (edit.value !== undefined && YAML.isMap(root)) {
            insertInOrder(parsed.document, root, edit.key, edit.value, COLLECTION_KEY_ORDER)
          }
          parsed = editCollection(parsed, [edit.key], edit.value)
          compactList(parsed.document, [edit.key])
          codeAsBlock(parsed.document, [], edit.key)
        }
        break
    }
  }
  return serialize(parsed)
}
