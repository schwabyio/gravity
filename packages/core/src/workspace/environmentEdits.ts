import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { DOC_EXTENSION, ENVIRONMENTS_DIR } from '../format/constants.js'
import {
  editEnvironment,
  insertInOrder,
  parseEnvironment,
  serialize,
  type ParsedFile
} from '../format/index.js'
import type { EnvironmentDoc } from '../model/documents.js'
import { foldName, nameProblem } from '../paths.js'
import { projectRootOf, readEnvironments } from './project.js'
import { writeIfUnchanged, type EditOutcome } from './writeFile.js'

/** The fields of an environment file the app edits. */
export const ENVIRONMENT_FIELDS = ['name', 'vars', 'flags'] as const
export type EnvironmentField = (typeof ENVIRONMENT_FIELDS)[number]

/** Set (or, with `undefined`, remove) one field of an environment file. */
export interface EnvironmentEdit {
  key: EnvironmentField
  value: unknown
}

/**
 * Apply edits to an environment file's text, in place: comments, order and
 * the entries not changed stay exactly as they were (SPEC.md §7).
 */
export function editEnvironmentSource(
  source: string,
  edits: EnvironmentEdit[],
  file?: string
): string {
  let parsed: ParsedFile<EnvironmentDoc> = parseEnvironment(source, file)
  for (const edit of edits) {
    if (same(parsed.data[edit.key], edit.value)) continue
    const root = parsed.document.contents
    if (edit.value !== undefined && YAML.isMap(root)) {
      insertInOrder(parsed.document, root, edit.key, edit.value, ENVIRONMENT_FIELDS)
    }
    parsed = editEnvironment(parsed, [edit.key], edit.value)
  }
  return serialize(parsed)
}

/** Apply edits to an environment file, only against the text they were made against. */
export const applyEnvironmentEdits = (
  file: string,
  baseSource: string,
  edits: EnvironmentEdit[]
): Promise<EditOutcome> =>
  writeIfUnchanged(file, baseSource, (source) =>
    editEnvironmentSource(source, edits, path.basename(file))
  )

/** Where a collection's environments are, or would be: its project's `environments/`. */
export async function environmentsDirFor(collectionFile: string): Promise<string> {
  const root = projectRootOf(collectionFile) ?? path.dirname(collectionFile)
  return path.join(root, ENVIRONMENTS_DIR)
}

/** A filename for an environment or collection called `name`: lower case, no spaces. */
export function environmentFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  return `${slug || 'environment'}${DOC_EXTENSION}`
}

/**
 * Create an environment file, and its directory if need be. Refuses a name
 * another environment there already has, and never overwrites a file.
 */
export async function createEnvironmentFile(
  directory: string,
  name: string
): Promise<{ path: string; source: string }> {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('An environment needs a name')
  const existing = await readEnvironments(directory)
  if (existing.some((environment) => environment.name === trimmed)) {
    throw new Error(`There is already an environment called "${trimmed}"`)
  }

  const fileName = environmentFileName(trimmed)
  const unusable = nameProblem(path.basename(fileName, DOC_EXTENSION))
  if (unusable) throw new Error(unusable)

  // Linux would write `staging.yml` beside a hand-made `Staging.yml`; a macOS or
  // Windows checkout could not hold both.
  const taken = existing
    .map((environment) => path.basename(environment.path))
    .find((name) => foldName(name) === foldName(fileName))
  if (taken !== undefined) throw new Error(`${ENVIRONMENTS_DIR}/${taken} already exists`)

  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, fileName)
  const source = new YAML.Document({ name: trimmed }).toString()
  try {
    await fs.writeFile(file, source, { flag: 'wx' })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${ENVIRONMENTS_DIR}/${path.basename(file)} already exists`)
    }
    throw cause
  }
  return { path: file, source }
}

/** Delete an environment file; anything else is refused. */
export async function deleteEnvironmentFile(file: string): Promise<void> {
  if (
    path.basename(path.dirname(file)) !== ENVIRONMENTS_DIR ||
    path.extname(file) !== DOC_EXTENSION
  ) {
    throw new Error('Not an environment file')
  }
  await fs.rm(file)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
