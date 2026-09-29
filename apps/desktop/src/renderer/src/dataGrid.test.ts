import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import {
  addColumn,
  addRow,
  dataRowInput,
  gridOf,
  gridProblems,
  iterationCounts,
  iterationName,
  labelOf,
  moveRow,
  removeColumn,
  removeRow,
  renameColumn,
  rowName,
  setCell,
  tableOf
} from './dataGrid.js'

const csv = gridOf({
  kind: 'csv',
  columns: ['id', 'iterationLabel'],
  rows: [
    { id: '1', iterationLabel: 'Happy' },
    { id: '2', iterationLabel: '' }
  ]
})

describe('data grid', () => {
  it('edits cells, rows and columns, and turns back into a table', () => {
    let grid = setCell(csv, 1, 0, '20')
    grid = addRow(grid, 0)
    grid = setCell(grid, 1, 0, 'new')
    grid = moveRow(grid, 2, -1)
    grid = addColumn(grid, 'extra')
    grid = removeColumn(renameColumn(grid, 1, 'label'), 1)
    expect(tableOf(grid)).toEqual({
      kind: 'csv',
      columns: ['id', 'extra'],
      rows: [
        { id: '1', extra: '' },
        { id: '20', extra: '' },
        { id: 'new', extra: '' }
      ]
    })
    expect(tableOf(removeRow(removeRow(removeRow(grid, 0), 0), 0))).toBeNull()
  })

  it('holds a duplicate or empty column name while typed, saying why it cannot be saved', () => {
    const grid = renameColumn(csv, 1, 'id')
    expect(gridProblems(grid)).toEqual(['the column id is named twice'])
    expect(tableOf(grid)).toBeNull()
    expect(gridProblems(renameColumn(csv, 0, ' '))).toEqual(['column 1 has no name'])
  })

  it('reads a JSON cell as JSON stores it', () => {
    const json = gridOf({ kind: 'json', columns: ['n'], rows: [{ n: 1 }] })
    expect(tableOf(setCell(json, 0, 0, 'true'))?.rows).toEqual([{ n: true }])
    expect(tableOf(setCell(json, 0, 0, '12'))?.rows).toEqual([{ n: 12 }])
    // A new JSON row leaves its cells out until typed in.
    expect(tableOf(addRow(json))?.rows).toEqual([{ n: 1 }, {}])
  })

  it('names rows and iterations as the picker and gta do', () => {
    expect([labelOf(csv, 0), labelOf(csv, 1)]).toEqual(['Happy', null])
    expect([rowName(0, 'Happy'), rowName(1, null)]).toEqual(['1 — Happy', '2'])
    expect(iterationName('get user', 1, 'Unknown')).toBe('Iteration 2 (Unknown) - get user')
    expect(dataRowInput(tableOf(csv)!, 0, 'users.csv')).toEqual({
      source: 'users.csv row 1',
      vars: { id: '1', iterationLabel: 'Happy' },
      label: 'Happy'
    })
  })

  it('counts an iteration’s results', () => {
    const r = (status: RunResult['status']) => ({ status }) as RunResult
    expect(iterationCounts({ a: r('pass'), b: r('fail'), c: r('skipped') })).toEqual({
      passed: 1,
      failed: 1,
      errored: 0,
      skipped: 1,
      state: 'failed'
    })
    expect(iterationCounts({ a: r('skipped') }).state).toBe('skipped')
    expect(iterationCounts(undefined).state).toBeNull()
  })
})
