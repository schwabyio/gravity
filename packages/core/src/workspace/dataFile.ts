import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSION } from '../format/constants.js'
import type { VarValue } from '../model/documents.js'
import {
  dataKindOf,
  DataFileError,
  dataTableProblems,
  ITERATION_LABEL,
  parseDataTable,
  rowLabel,
  serializeDataTable,
  type DataTable
} from '../model/dataTable.js'
import { toLf } from '../model/text.js'
import { writeIfUnchanged, type EditOutcome } from './writeFile.js'

/**
 * A collection's data file (SPEC.md §2.8): `<id>.csv` or `<id>.json` beside
 * `<id>.yml`, one row per run of the whole collection, each column a variable.
 * `.csv` wins when both are there.
 *
 * CSV values are strings, as every tool reading CSV gives them — a zip code
 * `01234` stays `01234`. JSON values keep their type.
 */

/** The largest data file read; a run over more is a job for something else. */
const MAX_BYTES = 10 * 1024 * 1024

export { DataFileError, ITERATION_LABEL }

export interface DataRow {
  values: Record<string, VarValue>
  /** Its `iterationLabel`, when it has a non-empty one. */
  label: string | null
}

export interface DataFile {
  /** Absolute. */
  path: string
  rows: DataRow[]
}

/** The data file beside a collection file, or null when it has none. */
export async function findDataFile(collectionFile: string): Promise<string | null> {
  const base = collectionFile.endsWith(DOC_EXTENSION)
    ? collectionFile.slice(0, -DOC_EXTENSION.length)
    : collectionFile
  for (const extension of ['.csv', '.json']) {
    try {
      // The exact name, in its case: a case-insensitive disk would match `Sessions.CSV` too.
      const candidate = `${base}${extension}`
      const names = await fs.readdir(path.dirname(candidate))
      if (names.includes(path.basename(candidate))) return candidate
    } catch {
      return null
    }
  }
  return null
}

/** A data file's text and its table, for editing. Throws `DataFileError` for one that is not a table. */
export async function readDataTable(file: string): Promise<{ source: string; table: DataTable }> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_BYTES) {
    throw new DataFileError(`${path.basename(file)}: larger than ${MAX_BYTES / 1024 / 1024} MB`)
  }
  const source = await fs.readFile(file, 'utf8')
  return { source, table: parseDataTable(source, path.basename(file), dataKindOf(file)) }
}

/** A table's rows as a run takes them, with their labels. */
export const rowsOf = (table: DataTable): DataRow[] =>
  table.rows.map((values) => ({ values, label: rowLabel(values) }))

/** Read a data file for a run. Throws `DataFileError` saying what is wrong and where. */
export async function readDataFile(file: string): Promise<DataFile> {
  const { table } = await readDataTable(file)
  const problem = dataTableProblems(table)[0]
  if (problem) throw new DataFileError(`${path.basename(file)}: ${problem}`)
  return { path: file, rows: rowsOf(table) }
}

/** The data file beside a collection, read; null when there is none. */
export async function loadDataFile(collectionFile: string): Promise<DataFile | null> {
  const file = await findDataFile(collectionFile)
  return file ? readDataFile(file) : null
}

/** Write an edited table back, only against the text it was read from (see `writeIfUnchanged`). */
export async function applyDataTable(
  file: string,
  baseSource: string,
  table: DataTable
): Promise<EditOutcome> {
  const problem = dataTableProblems(table)[0]
  if (problem) throw new DataFileError(`${path.basename(file)}: ${problem}`)
  return writeIfUnchanged(file, baseSource, (source) => serializeDataTable(table, source))
}

/**
 * Write a data file's text as typed — the raw edit — only against the text it
 * was read from. The text must read as a table a run accepts; what the person
 * wrote is kept exactly, quoting and spacing included, with LF line endings.
 */
export async function applyDataText(
  file: string,
  baseSource: string,
  text: string
): Promise<EditOutcome> {
  const table = parseDataTable(text, path.basename(file), dataKindOf(file))
  const problem = dataTableProblems(table)[0]
  if (problem) throw new DataFileError(`${path.basename(file)}: ${problem}`)
  return writeIfUnchanged(file, baseSource, () => toLf(text))
}

/**
 * Give a collection a data file: `<id>.csv` beside it, with one column and one
 * empty row — the smallest file a run accepts. Never overwrites one.
 */
export async function createDataFile(collectionFile: string, column: string): Promise<string> {
  if (await findDataFile(collectionFile)) throw new Error('This collection already has a data file')
  const name = column.trim()
  if (name === '') throw new Error('A data file needs a first column name')
  const file = `${collectionFile.slice(0, -DOC_EXTENSION.length)}.csv`
  const text = serializeDataTable({ kind: 'csv', columns: [name], rows: [{ [name]: '' }] })
  await fs.writeFile(file, text, { flag: 'wx' })
  return file
}
