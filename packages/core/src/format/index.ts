/**
 * The format layer: our YAML collection format <-> typed documents.
 *
 * This module is the only place that knows how a collection is stored, and it
 * depends on nothing but the `yaml` package and our own schemas. See SPEC.md.
 *
 * Every parse keeps the source YAML document alongside the validated data. A save
 * re-emits that document, so a file the app did not change comes back byte for
 * byte, and editing one step changes that step — comments, key order and
 * formatting all survive (SPEC.md §7).
 */
import YAML from 'yaml'
import type { z } from 'zod'
import {
  CollectionSchema,
  EnvironmentDocSchema,
  ProjectDocSchema,
  type Collection,
  type EnvironmentDoc,
  type ProjectDoc
} from '../model/documents.js'
import { describeValidation, FormatError } from './errors.js'
import { toLf } from '../model/text.js'
import { patchIn } from './patch.js'

export * from './constants.js'
export * from './errors.js'
export * from './merge.js'
export * from './lines.js'

/** A parsed document plus the YAML it came from. */
export interface ParsedFile<T> {
  data: T
  /** Source document; mutate through `setIn` so writes stay lossless. */
  document: YAML.Document.Parsed
  /** The text this was parsed from, if any. */
  source?: string
  /** Set once the document has been edited. */
  dirty?: boolean
}

/**
 * Emitter options for files we write.
 *
 * `flowCollectionPadding: false` keeps `[a, b]` from becoming `[ a, b ]`, and
 * `lineWidth: 0` stops long URLs being folded across lines. Both exist to keep a
 * one-field edit to a one-line diff.
 */
const EMIT_OPTIONS: YAML.ToStringOptions = {
  lineWidth: 0,
  flowCollectionPadding: false,
  blockQuote: 'literal'
}

function parseWith<S extends z.ZodType>(
  schema: S,
  source: string,
  file?: string,
  /** A retired key, say, explained better than the schema's "unrecognized key". */
  retired?: (raw: unknown) => string | null
): ParsedFile<z.infer<S>> {
  const document = YAML.parseDocument(source, { keepSourceTokens: true })
  if (document.errors.length > 0) {
    throw new FormatError(document.errors[0]?.message ?? 'invalid YAML', file)
  }
  const raw = document.toJS() ?? {}
  const retiredKey = retired?.(raw)
  if (retiredKey) throw new FormatError(retiredKey, file)
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new FormatError(describeValidation(result.error), file, result.error)
  }
  return { data: result.data, document, source }
}

export const parseCollection = (source: string, file?: string): ParsedFile<Collection> =>
  parseWith(CollectionSchema, source, file, (raw) =>
    raw !== null && typeof raw === 'object' && 'name' in raw
      ? 'name: is now id:, the collection file name without .yml (SPEC.md §2)'
      : null
  )

export const parseProject = (source: string, file?: string): ParsedFile<ProjectDoc> =>
  parseWith(ProjectDocSchema, source, file)

export const parseEnvironment = (source: string, file?: string): ParsedFile<EnvironmentDoc> =>
  parseWith(EnvironmentDocSchema, source, file)

/**
 * Re-emit a parsed file.
 *
 * A file that has not been edited returns its original text verbatim, so saving
 * something the app did not change is a guaranteed no-op rather than a bet on the
 * emitter reproducing the author's formatting (SPEC.md §7).
 */
export function serialize(file: ParsedFile<unknown>): string {
  if (!file.dirty && file.source !== undefined) return file.source
  keepFlowPadding(file.document, file.source)
  // The tools write LF, whatever the file was checked out with (SPEC.md §1.2).
  return toLf(file.document.toString(EMIT_OPTIONS))
}

/**
 * The emitter pads every flow collection or none. People write lists tight —
 * `[a, b]` — and maps padded — `{ secret: true }` — so re-emitting a file
 * would change lines nobody edited. Each flow collection is written the way it
 * was read instead; a new one follows those conventions.
 */
function keepFlowPadding(document: YAML.Document, source: string | undefined) {
  YAML.visit(document, {
    Map: (_key, node) => pad(node, true),
    Seq: (_key, node) => pad(node, false)
  })
  function pad(node: YAML.YAMLMap | YAML.YAMLSeq, byDefault: boolean) {
    if (!node.flow || node.items.length === 0) return
    const start = node.range?.[0]
    const padded =
      source !== undefined && start !== undefined ? source[start + 1] === ' ' : byDefault
    const own = Object.getPrototypeOf(node).toString as (...args: unknown[]) => string
    // `toString(ctx, …)` is what the emitter calls for a collection node.
    Object.defineProperty(node, 'toString', {
      configurable: true,
      value: (ctx: { flowCollectionPadding?: string } | undefined, ...rest: unknown[]) =>
        own.call(node, ctx && { ...ctx, flowCollectionPadding: padded ? ' ' : '' }, ...rest)
    })
  }
}

/**
 * Write a value into a parsed file, re-validating the result.
 *
 * Edits go through the YAML document rather than through the plain object, so
 * only what changed is rewritten — inside a map, key by key (`patchIn`).
 * Passing `undefined` deletes the key.
 */
export function setIn<T>(
  file: ParsedFile<T>,
  schema: z.ZodType<T>,
  path: ReadonlyArray<string | number>,
  value: unknown
): ParsedFile<T> {
  if (value === undefined) file.document.deleteIn(path)
  else patchIn(file.document, path, value)

  const result = schema.safeParse(file.document.toJS() ?? {})
  if (!result.success) {
    throw new FormatError(
      `edit at ${path.join('.')} is invalid — ${describeValidation(result.error)}`,
      undefined,
      result.error
    )
  }
  return { ...file, data: result.data, document: file.document, dirty: true }
}

export const editCollection = (
  file: ParsedFile<Collection>,
  path: ReadonlyArray<string | number>,
  value: unknown
): ParsedFile<Collection> => setIn(file, CollectionSchema, path, value)

export const editProject = (
  file: ParsedFile<ProjectDoc>,
  path: ReadonlyArray<string | number>,
  value: unknown
): ParsedFile<ProjectDoc> => setIn(file, ProjectDocSchema, path, value)

export const editEnvironment = (
  file: ParsedFile<EnvironmentDoc>,
  path: ReadonlyArray<string | number>,
  value: unknown
): ParsedFile<EnvironmentDoc> => setIn(file, EnvironmentDocSchema, path, value)

const CREATE_OPTIONS: YAML.DocumentOptions & YAML.SchemaOptions & YAML.ToStringOptions = {
  ...EMIT_OPTIONS,
  defaultStringType: 'QUOTE_DOUBLE',
  defaultKeyType: 'PLAIN',
  nullStr: 'null'
}

function createWith<S extends z.ZodType>(schema: S, value: z.infer<S>): ParsedFile<z.infer<S>> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new FormatError(describeValidation(result.error), undefined, result.error)
  const document = new YAML.Document(result.data, CREATE_OPTIONS) as YAML.Document.Parsed
  return { data: result.data, document, dirty: true }
}

export const createCollection = (doc: Collection): ParsedFile<Collection> =>
  createWith(CollectionSchema, doc)

export const createEnvironment = (doc: EnvironmentDoc): ParsedFile<EnvironmentDoc> =>
  createWith(EnvironmentDocSchema, doc)
