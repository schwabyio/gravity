import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import {
  addColumn,
  addRow,
  dataRowInput,
  gridFromText,
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
  sameGrid,
  setCell,
  tableOf,
  textOf
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

  it('turns into the file’s text, problems and all, and back from text typed in', () => {
    const text = 'id,iterationLabel\n1,Happy\n2,\n'
    const edited = setCell(csv, 1, 0, '20')
    expect(textOf(edited, text)).toBe('id,iterationLabel\n1,Happy\n20,\n')
    // One that cannot be saved still has text for the raw editor to start from —
    // every value of a column named twice, as well as the other's.
    const twice = renameColumn(csv, 1, 'id')
    expect(textOf(twice, text)).toBe('id,id\n1,Happy\n2,\n')
    expect(gridFromText(textOf(twice, text), 'users.csv', 'csv')).toEqual({
      grid: null,
      error: 'users.csv: the header names id twice'
    })
    const json = gridOf({ kind: 'json', columns: ['n', 'm'], rows: [{ n: 1, m: 'x' }] })
    expect(textOf(renameColumn(json, 1, 'n'), '[]')).toBe(
      '[\n  {\n    "n": 1,\n    "n": "x"\n  }\n]\n'
    )
    expect(textOf(renameColumn(csv, 0, ''), text)).toBe(',iterationLabel\n1,Happy\n2,\n')

    const read = gridFromText('id,iterationLabel\n1,Happy\n2,\n', 'users.csv', 'csv')
    expect(read.error).toBeNull()
    expect(sameGrid(read.grid!, csv)).toBe(true)
    expect(sameGrid(read.grid!, edited)).toBe(false)
    expect(gridFromText('[1, 2]', 'users.json', 'json')).toEqual({
      grid: null,
      error: expect.stringContaining('users.json')
    })
  })

  it('leaves a row where it is when moved past an end, and adds one at the end by default', () => {
    expect(moveRow(csv, 0, -1)).toBe(csv)
    expect(moveRow(csv, 1, 1)).toBe(csv)
    expect(addRow(csv).rows.at(-1)).toEqual(['', ''])
  })

  it('names an iteration with no label by its number alone', () => {
    expect(iterationName('get user', 0, null)).toBe('Iteration 1 - get user')
    expect(dataRowInput(tableOf(csv)!, 5, 'users.csv')).toBeNull()
    const r = (status: RunResult['status']) => ({ status }) as RunResult
    expect(iterationCounts({ a: r('pass'), b: r('skipped') }).state).toBe('passed')
    expect(iterationCounts({ a: r('error') }).state).toBe('failed')
  })
})
