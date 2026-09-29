import type { VarValue } from './documents.js'
import { toLf } from './text.js'

/**
 * A data file's contents as a table (SPEC.md §2.8): its columns, in order, and
 * its rows. Pure — no filesystem — so the app's renderer can check and edit a
 * table, and main can write it back.
 *
 * Writing back keeps what the file already was: an unedited table writes the
 * file's own text, byte for byte; an edited one keeps its byte order mark and
 * the text of every header and row it did not change, and is written with LF
 * line endings, as every file the tools write is (SPEC.md §1.2).
 */

/** A row's column that names it in reports, and is a variable like any other. */
export const ITERATION_LABEL = 'iterationLabel'

export type DataKind = 'csv' | 'json'

export interface DataTable {
  kind: DataKind
  columns: string[]
  /** Each row's values by column. A JSON row may leave a column out. */
  rows: Array<Record<string, VarValue>>
}

export class DataFileError extends Error {
  override name = 'DataFileError'
}

export const dataKindOf = (file: string): DataKind => (file.endsWith('.json') ? 'json' : 'csv')

/** A row's label: its `iterationLabel`, when it has a non-empty one. */
export function rowLabel(row: Record<string, VarValue>): string | null {
  const label = row[ITERATION_LABEL]
  return label === undefined || label === null || String(label).trim() === '' ? null : String(label)
}

/**
 * Read a data file's text as a table. Throws `DataFileError` for text that is
 * not a table at all — bad JSON, a header naming a column twice. An empty
 * table is a table: `dataTableProblems` says what a run needs beyond that.
 */
export function parseDataTable(text: string, name: string, kind: DataKind): DataTable {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return kind === 'json' ? jsonTable(content, name) : csvTable(content, name)
}

/** What stops a table being run or saved: columns without a name or named twice, or no rows. */
export function dataTableProblems(table: DataTable): string[] {
  const problems: string[] = []
  table.columns.forEach((column, i) => {
    if (column.trim() === '') problems.push(`column ${i + 1} has no name`)
    else if (table.columns.indexOf(column) !== i)
      problems.push(`the column ${column} is named twice`)
  })
  if (table.rows.length === 0) {
    problems.push('no rows — a data file runs the collection once per row')
  }
  return problems
}

/**
 * A cell typed in the app, as a JSON data file stores it — read as gta reads
 * a flag override: `true`, `false` and `null` are themselves, a number is a
 * number, anything else is text. A CSV cell is always the text as typed.
 */
export function parseCellValue(text: string, kind: DataKind): VarValue {
  if (kind === 'csv') return text
  const trimmed = text.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return text
}

/** A cell as the app shows it: `null` as `null`, a missing JSON value as empty. */
export const cellText = (value: VarValue | undefined): string =>
  value === undefined ? '' : value === null ? 'null' : String(value)

/**
 * A table as a file's text. With `previous` — the file as read — an unchanged
 * table is that text exactly, and an edited one keeps its byte order mark and
 * trailing line break, and every unchanged header and row as it was written —
 * with LF line endings.
 */
export function serializeDataTable(table: DataTable, previous?: string): string {
  if (previous !== undefined) {
    try {
      if (sameTable(parseDataTable(previous, 'previous', table.kind), table)) return previous
    } catch {
      // Not a table before: write this one fresh.
    }
  }
  return table.kind === 'json' ? jsonText(table, previous) : csvText(table, previous)
}

function sameTable(a: DataTable, b: DataTable): boolean {
  return (
    JSON.stringify(a.columns) === JSON.stringify(b.columns) &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => sameRow(row, b.rows[i]!, a.columns))
  )
}

const sameRow = (a: Record<string, VarValue>, b: Record<string, VarValue>, columns: string[]) =>
  columns.every((column) => a[column] === b[column])

/* ------------------------------------------------------------------ json -- */

function jsonTable(text: string, name: string): DataTable {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new DataFileError(`${name}: not valid JSON — ${(cause as Error).message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new DataFileError(`${name}: must be an array of objects, one per row`)
  }
  const columns: string[] = []
  const rows = parsed.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DataFileError(`${name}: row ${index + 1} is not an object of column values`)
    }
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new DataFileError(
          `${name}: row ${index + 1}, ${key} — a value is a string, number, boolean or null`
        )
      }
      if (!columns.includes(key)) columns.push(key)
    }
    return row as Record<string, VarValue>
  })
  return { kind: 'json', columns, rows }
}

function jsonText(table: DataTable, previous: string | undefined): string {
  const rows = table.rows.map((row) =>
    Object.fromEntries(
      table.columns.filter((column) => row[column] !== undefined).map((c) => [c, row[c]])
    )
  )
  const bom = previous?.charCodeAt(0) === 0xfeff ? previous[0] : ''
  return `${bom}${JSON.stringify(rows, null, 2)}\n`
}

/* ------------------------------------------------------------------- csv -- */

interface CsvRecord {
  fields: string[]
  /** Where it starts in the file, from 1. */
  line: number
  /** Its text as written, line break excluded. */
  raw: string
}

function csvTable(text: string, name: string): DataTable {
  const records = parseCsv(text, name)
  if (records.length === 0) return { kind: 'csv', columns: [], rows: [] }
  const [header, ...body] = records as [CsvRecord, ...CsvRecord[]]
  const columns = header.fields.map((column) => column.trim())
  columns.forEach((column, i) => {
    if (column === '') throw new DataFileError(`${name}: column ${i + 1} of the header has no name`)
    if (columns.indexOf(column) !== i) {
      throw new DataFileError(`${name}: the header names ${column} twice`)
    }
  })
  const rows = body.map((record) => {
    if (record.fields.length > columns.length) {
      throw new DataFileError(
        `${name}: line ${record.line} has ${record.fields.length} values for ${columns.length} columns`
      )
    }
    // A short row leaves its last columns empty, as spreadsheets write them.
    return Object.fromEntries(columns.map((column, i) => [column, record.fields[i] ?? '']))
  })
  return { kind: 'csv', columns, rows }
}

/**
 * RFC 4180: a header row, then records; a field in double quotes may hold
 * commas, line breaks and `""` for a quote. Blank lines are skipped; `""` on
 * a line of its own is a record with one empty value, not a blank line. A
 * CRLF inside a quoted value reads as `\n`, so a value is the same whichever
 * line endings the file was checked out with.
 */
function parseCsv(text: string, name: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let sawQuote = false
  let line = 1
  let start = 1
  let startOffset = 0
  let i = 0

  const endRecord = (end: number) => {
    fields.push(field)
    // A line with nothing on it is not a record.
    if (sawQuote || !(fields.length === 1 && fields[0] === '')) {
      records.push({ fields, line: start, raw: text.slice(startOffset, end) })
    }
    fields = []
    field = ''
    sawQuote = false
  }

  while (i < text.length) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else if (char === '\r' && text[i + 1] === '\n') {
        // The \n that follows is kept.
      } else {
        if (char === '\n') line++
        field += char
      }
      i++
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      sawQuote = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      const end = i
      if (char === '\r' && text[i + 1] === '\n') i++
      endRecord(end)
      line++
      start = line
      startOffset = i + 1
    } else {
      field += char
    }
    i++
  }
  if (quoted) {
    throw new DataFileError(`${name}: a quoted value starting on line ${start} never ends`)
  }
  if (field !== '' || fields.length > 0 || sawQuote) endRecord(text.length)
  return records
}

function csvText(table: DataTable, previous: string | undefined): string {
  let before: { columns: string[]; records: CsvRecord[] } | null = null
  if (previous !== undefined) {
    try {
      const content = previous.charCodeAt(0) === 0xfeff ? previous.slice(1) : previous
      const records = parseCsv(content, 'previous')
      const header = records[0]
      if (header) before = { columns: header.fields.map((c) => c.trim()), records }
    } catch {
      before = null
    }
  }
  const bom = previous?.charCodeAt(0) === 0xfeff ? previous[0] : ''
  const ends = previous === undefined || previous === '' || /\r?\n$/.test(previous)

  const sameColumns =
    before !== null && JSON.stringify(before.columns) === JSON.stringify(table.columns)
  const lines: string[] = [
    sameColumns ? toLf(before!.records[0]!.raw) : table.columns.map(csvField).join(',')
  ]

  // Rows written before keep their text: an edit to one row changes one line,
  // and moving a row moves its line as it was.
  const unused = new Map<number, Record<string, string>>()
  if (sameColumns) {
    before!.records.slice(1).forEach((record, i) => {
      unused.set(i, Object.fromEntries(table.columns.map((c, n) => [c, record.fields[n] ?? ''])))
    })
  }
  table.rows.forEach((row, index) => {
    const matches = (i: number) =>
      table.columns.every((c) => (unused.get(i)?.[c] ?? null) === cellText(row[c]))
    const reuse = unused.has(index) && matches(index) ? index : [...unused.keys()].find(matches)
    if (reuse !== undefined) {
      lines.push(toLf(before!.records[reuse + 1]!.raw))
      unused.delete(reuse)
      return
    }
    const values = table.columns.map((column) => csvField(cellText(row[column])))
    // One empty value alone on a line would read as a blank line: quote it.
    lines.push(values.length === 1 && values[0] === '' ? '""' : values.join(','))
  })
  return `${bom}${lines.join('\n')}${ends ? '\n' : ''}`
}

/** A CSV field, quoted only when it has to be. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value
}
