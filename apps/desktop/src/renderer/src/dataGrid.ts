import {
  cellText,
  dataTableProblems,
  parseCellValue,
  parseDataTable,
  serializeDataTable,
  rowLabel,
  type DataKind,
  type DataTable,
  type RunResult,
  type VarValue
} from '@schwabyio/gravity-core/model'
import type { DataRowInput } from '@shared/ipc.js'

/**
 * A data file (SPEC.md §2.8) as the app edits it: columns and rows of cells
 * by position rather than by name, so a column can be renamed through a
 * moment of having no name, or the same name as another, while it is typed.
 * It becomes a `DataTable` — rows by column name — only when it is valid.
 */
export interface DataGrid {
  kind: DataKind
  columns: string[]
  /** One array per row, one cell per column; a JSON row may leave a cell out. */
  rows: Array<Array<VarValue | undefined>>
}

export const gridOf = (table: DataTable): DataGrid => ({
  kind: table.kind,
  columns: [...table.columns],
  rows: table.rows.map((row) => table.columns.map((column) => row[column]))
})

/** What stops the grid being saved or run: nameless or twice-named columns, no rows. */
export const gridProblems = (grid: DataGrid): string[] =>
  dataTableProblems({ kind: grid.kind, columns: grid.columns, rows: grid.rows.map(() => ({})) })

/** The grid as a table, or null while it has problems. */
export function tableOf(grid: DataGrid): DataTable | null {
  if (gridProblems(grid).length > 0) return null
  return {
    kind: grid.kind,
    columns: grid.columns.map((c) => c.trim()),
    rows: grid.rows.map((row) =>
      Object.fromEntries(
        grid.columns.flatMap((column, i) =>
          row[i] === undefined ? [] : [[column.trim(), row[i] as VarValue]]
        )
      )
    )
  }
}

/**
 * The grid as the file's text, problems or not — what the raw editor starts
 * from when the grid has edits. Unedited rows keep their text from `previous`.
 */
export const textOf = (grid: DataGrid, previous: string): string =>
  serializeDataTable(
    {
      kind: grid.kind,
      columns: grid.columns,
      rows: grid.rows.map((row) =>
        Object.fromEntries(
          grid.columns.flatMap((column, i) =>
            row[i] === undefined ? [] : [[column, row[i] as VarValue]]
          )
        )
      )
    },
    previous
  )

/** Text typed in the raw editor, read as a grid — or why it is not a table. */
export function gridFromText(
  text: string,
  fileName: string,
  kind: DataKind
): { grid: DataGrid; error: null } | { grid: null; error: string } {
  try {
    return { grid: gridOf(parseDataTable(text, fileName, kind)), error: null }
  } catch (cause) {
    return { grid: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export const sameGrid = (a: DataGrid, b: DataGrid): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** A cell typed in: text for CSV; for JSON, `true`, `false`, `null` and numbers as themselves. */
export const setCell = (grid: DataGrid, row: number, column: number, text: string): DataGrid => ({
  ...grid,
  rows: grid.rows.map((cells, r) =>
    r === row
      ? grid.columns.map((_, c) => (c === column ? parseCellValue(text, grid.kind) : cells[c]))
      : cells
  )
})

/** A new, empty row after `after` (at the end without it). */
export function addRow(grid: DataGrid, after = grid.rows.length - 1): DataGrid {
  const rows = [...grid.rows]
  rows.splice(
    after + 1,
    0,
    grid.columns.map(() => (grid.kind === 'csv' ? '' : undefined))
  )
  return { ...grid, rows }
}

export const removeRow = (grid: DataGrid, row: number): DataGrid => ({
  ...grid,
  rows: grid.rows.filter((_, r) => r !== row)
})

/** Move a row up (-1) or down (+1); at an end it stays. */
export function moveRow(grid: DataGrid, row: number, by: -1 | 1): DataGrid {
  const to = row + by
  if (to < 0 || to >= grid.rows.length) return grid
  const rows = [...grid.rows]
  const [moved] = rows.splice(row, 1)
  rows.splice(to, 0, moved!)
  return { ...grid, rows }
}

export const addColumn = (grid: DataGrid, name: string): DataGrid => ({
  ...grid,
  columns: [...grid.columns, name],
  rows: grid.rows.map((cells) => [...cells, grid.kind === 'csv' ? '' : undefined])
})

export const renameColumn = (grid: DataGrid, column: number, name: string): DataGrid => ({
  ...grid,
  columns: grid.columns.map((c, i) => (i === column ? name : c))
})

export const removeColumn = (grid: DataGrid, column: number): DataGrid => ({
  ...grid,
  columns: grid.columns.filter((_, i) => i !== column),
  rows: grid.rows.map((cells) => cells.filter((_, i) => i !== column))
})

export { cellText }

/** A row's label, from its `iterationLabel` cell. */
export function labelOf(grid: DataGrid, row: number): string | null {
  const values = Object.fromEntries(grid.columns.map((c, i) => [c.trim(), grid.rows[row]?.[i]]))
  return rowLabel(values as Record<string, VarValue>)
}

/** `2 — Unknown user`, for the row picker and the iterations strip. */
export const rowName = (row: number, label: string | null): string =>
  label ? `${row + 1} — ${label}` : `${row + 1}`

/** A row as a run takes it: its values, where they came from, and its label. */
export function dataRowInput(table: DataTable, row: number, fileName: string): DataRowInput | null {
  const values = table.rows[row]
  if (!values) return null
  return { source: `${fileName} row ${row + 1}`, vars: values, label: rowLabel(values) }
}

/** `Iteration 2 (Unknown user) - get user`, as gta names a result outside its iteration. */
export const iterationName = (name: string, row: number, label: string | null): string =>
  `Iteration ${row + 1}${label ? ` (${label})` : ''} - ${name}`

export interface IterationCounts {
  passed: number
  failed: number
  errored: number
  skipped: number
  /** failed or errored beats skipped beats passed; null with no results yet. */
  state: 'passed' | 'failed' | 'skipped' | null
}

/** One iteration's results, counted. */
export function iterationCounts(results: Record<string, RunResult> | undefined): IterationCounts {
  const all = Object.values(results ?? {})
  const count = (status: RunResult['status']) => all.filter((r) => r.status === status).length
  const counts = {
    passed: count('pass'),
    failed: count('fail'),
    errored: count('error'),
    skipped: count('skipped')
  }
  const state =
    all.length === 0
      ? null
      : counts.failed + counts.errored > 0
        ? 'failed'
        : counts.passed === 0 && counts.skipped > 0
          ? 'skipped'
          : 'passed'
  return { ...counts, state }
}
