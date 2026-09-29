import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import {
  BASES_DIR,
  COLLECTIONS_DIR,
  DOC_EXTENSION,
  ENDPOINTS_DIR,
  PROJECT_FILE,
  REQUESTS_DIR
} from '../format/constants.js'
import {
  editProject,
  insertInOrder,
  parseProject,
  serialize,
  type ParsedFile
} from '../format/index.js'
import { ProjectDocSchema, type ProjectDoc } from '../model/documents.js'
import { foldName, nameProblem, toPosix } from '../paths.js'
import { ID_PATTERN } from './ids.js'
import { writeIfUnchanged, type EditOutcome } from './writeFile.js'

/** The fields of `project.yml` the app edits, in the order they are written. */
export const PROJECT_FIELDS = ['name', 'uses', 'vars', 'tls'] as const
export type ProjectField = (typeof PROJECT_FIELDS)[number]

/** Set (or, with `undefined`, remove) one field of `project.yml`. */
export interface ProjectEdit {
  key: ProjectField
  value: unknown
}

/** Paths — `uses`, `tls.ca` — are always written with `/`, whatever was typed. */
function normalise(edit: ProjectEdit): ProjectEdit {
  if (edit.key === 'uses' && typeof edit.value === 'string') {
    return { ...edit, value: toPosix(edit.value.trim()) }
  }
  const tls = edit.value as { ca?: unknown } | undefined
  if (edit.key === 'tls' && Array.isArray(tls?.ca)) {
    const ca = tls.ca.map((file) => (typeof file === 'string' ? toPosix(file.trim()) : file))
    return { ...edit, value: { ...tls, ca } }
  }
  return edit
}

/** Apply edits to `project.yml`'s text in place (SPEC.md §7). */
export function editProjectSource(source: string, edits: ProjectEdit[]): string {
  let parsed: ParsedFile<ProjectDoc> = parseProject(source, PROJECT_FILE)
  for (const edit of edits.map(normalise)) {
    if (JSON.stringify(parsed.data[edit.key]) === JSON.stringify(edit.value)) continue
    const root = parsed.document.contents
    if (edit.value !== undefined && YAML.isMap(root)) {
      insertInOrder(parsed.document, root, edit.key, edit.value, PROJECT_FIELDS)
    }
    parsed = editProject(parsed, [edit.key], edit.value)
  }
  return serialize(parsed)
}

/**
 * Edit a project's `project.yml`, only against the text it was read as.
 * `baseSource` null means there is no file yet: it is created, unless one
 * appeared in the meantime.
 */
export async function applyProjectEdits(
  root: string,
  baseSource: string | null,
  edits: ProjectEdit[]
): Promise<EditOutcome> {
  const file = path.join(root, PROJECT_FILE)
  if (baseSource !== null) {
    return writeIfUnchanged(file, baseSource, (source) => editProjectSource(source, edits))
  }

  const doc: Record<string, unknown> = {}
  for (const { key, value } of edits.map(normalise)) {
    if (value !== undefined) doc[key] = value
  }
  const checked = ProjectDocSchema.parse(doc)
  const ordered = Object.fromEntries(
    PROJECT_FIELDS.filter((key) => checked[key] !== undefined).map((key) => [key, checked[key]])
  )
  if (Object.keys(ordered).length === 0) return { ok: true, source: '', wrote: false }
  const source = new YAML.Document(ordered).toString({ lineWidth: 0 })
  try {
    await fs.writeFile(file, source, { flag: 'wx' })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    return { ok: false, conflict: true, source: await fs.readFile(file, 'utf8') }
  }
  return { ok: true, source, wrote: true }
}

/** Make a directory in the project's `collections/`; one level only. */
export async function createDirectory(root: string, name: string): Promise<string> {
  const trimmed = name.trim()
  const problem = nameProblem(trimmed)
  if (problem) throw new Error(problem)
  const directory = path.join(root, COLLECTIONS_DIR, trimmed)
  // Linux would make `Checkout/` beside `checkout/`; a macOS or Windows checkout could not hold both.
  const existing = (await fs.readdir(path.join(root, COLLECTIONS_DIR)).catch(() => [])).find(
    (name) => foldName(name) === foldName(trimmed)
  )
  if (existing !== undefined) throw new Error(`There is already a directory called "${existing}"`)
  try {
    await fs.mkdir(path.join(root, COLLECTIONS_DIR), { recursive: true })
    await fs.mkdir(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`There is already a directory called "${trimmed}"`)
    }
    throw cause
  }
  return directory
}

/**
 * Make a collection, empty, in `collections/` or one of its directories — or,
 * as `kind: 'set'`, a request set with no params yet in `requests/`.
 *
 * `id` is the file's name and its `id:` (SPEC.md §2), taken as typed. One
 * that another file in the same home already has — in any of its
 * directories, in any case — is refused, and an existing file is never
 * overwritten.
 */
export async function createCollectionFile(
  root: string,
  directory: string | null,
  id: string,
  kind: 'collection' | 'set' | 'endpoints' | 'base' = 'collection'
): Promise<{ path: string; source: string }> {
  const trimmed = id.trim()
  if (trimmed === '') throw new Error('A collection needs an id')
  if (!ID_PATTERN.test(trimmed)) {
    throw new Error('An id is letters, digits and - _ . — it is also the file name')
  }
  const problem = nameProblem(trimmed)
  if (problem) throw new Error(problem)
  const fileName = `${trimmed}${DOC_EXTENSION}`
  if (directory !== null) {
    const directoryProblem = nameProblem(directory)
    if (directoryProblem) throw new Error(directoryProblem)
  }

  const home = {
    collection: COLLECTIONS_DIR,
    set: REQUESTS_DIR,
    endpoints: ENDPOINTS_DIR,
    base: BASES_DIR
  }[kind]
  const taken = await idTaken(path.join(root, home), trimmed)
  if (taken) throw new Error(`${home}/${taken} already has the id ${trimmed}`)
  const parent = path.join(root, home, ...(directory ? [directory] : []))
  await fs.mkdir(parent, { recursive: true })
  const file = path.join(parent, fileName)
  // A base collection is only its shared parts; the others start with no steps.
  const doc =
    kind === 'set'
      ? { id: trimmed, params: {}, steps: [] }
      : kind === 'base'
        ? { id: trimmed }
        : { id: trimmed, steps: [] }
  const source = new YAML.Document(doc).toString()
  try {
    await fs.writeFile(file, source, { flag: 'wx' })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${[directory, fileName].filter(Boolean).join('/')} already exists`)
    }
    throw cause
  }
  return { path: file, source }
}

/** The file in a home, one directory deep, whose id is `id` ignoring case — written with `/`. */
async function idTaken(home: string, id: string): Promise<string | null> {
  const wanted = `${id}${DOC_EXTENSION}`.toLowerCase()
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === wanted) return entry.name
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const inner = await fs.readdir(path.join(home, entry.name)).catch(() => [] as string[])
      const found = inner.find((name) => name.toLowerCase() === wanted)
      if (found) return `${entry.name}/${found}`
    }
  }
  return null
}
