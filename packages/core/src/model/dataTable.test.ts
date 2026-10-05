import { describe, expect, it } from 'vitest'
import {
  cellText,
  dataTableProblems,
  parseCellValue,
  parseDataTable,
  serializeDataCells,
  serializeDataTable,
  type DataTable
} from './dataTable.js'

const bom = String.fromCharCode(0xfeff)
const CSV = `${bom}id,"name",note\r\n1,"Smith, Ann","said ""hi""\r\nthen left"\r\n2 ,Bob,\r\n3,Cat,"  padded  "\r\n`

describe('data tables', () => {
  it('reads a CSV file as a table', () => {
    expect(parseDataTable(CSV, 'u.csv', 'csv')).toEqual({
      kind: 'csv',
      columns: ['id', 'name', 'note'],
      rows: [
        // A line break in a value reads as \n, whatever the file's line ends.
        { id: '1', name: 'Smith, Ann', note: 'said "hi"\nthen left' },
        { id: '2 ', name: 'Bob', note: '' },
        { id: '3', name: 'Cat', note: '  padded  ' }
      ]
    })
  })

  it('writes an unedited CSV back byte for byte: CRLF, BOM, quoting and all', () => {
    const table = parseDataTable(CSV, 'u.csv', 'csv')
    expect(serializeDataTable(table, CSV)).toBe(CSV)
  })

  it('changes one line for one edited cell, keeping the BOM, and writes LF', () => {
    const table = parseDataTable(CSV, 'u.csv', 'csv')
    table.rows[2] = { ...table.rows[2]!, name: 'Cathy' }
    expect(serializeDataTable(table, CSV)).toBe(
      CSV.replace('3,Cat,', '3,Cathy,').replace(/\r\n/g, '\n')
    )
  })

  it('moves a row as it was written, and writes a new one quoting only what needs it', () => {
    const table = parseDataTable(CSV, 'u.csv', 'csv')
    const [first, second, third] = table.rows
    table.rows = [third!, first!, second!, { id: '4', name: 'Dee, D', note: ' x' }]
    const written = serializeDataTable(table, CSV)
    expect(written).not.toContain('\r')
    const lines = written.split('\n')
    expect(lines).toEqual([
      `${bom}id,"name",note`,
      '3,Cat,"  padded  "',
      '1,"Smith, Ann","said ""hi""',
      'then left"',
      '2 ,Bob,',
      '4,"Dee, D"," x"',
      ''
    ])
  })

  it('rewrites the header when columns change, and quotes a lone empty value', () => {
    const text = 'a\nx\n'
    const table: DataTable = { kind: 'csv', columns: ['b'], rows: [{ b: '' }] }
    expect(serializeDataTable(table, text)).toBe('b\n""\n')
    // …which reads back as a row, not a blank line.
    expect(parseDataTable('b\n""\n', 'b.csv', 'csv').rows).toEqual([{ b: '' }])
  })

  it('keeps JSON values’ types, writing an unchanged file as it was', () => {
    const text = '[{"n": 1, "ok": true, "none": null, "s": "x"}]'
    const table = parseDataTable(text, 'u.json', 'json')
    expect(serializeDataTable(table, text)).toBe(text)
    table.rows[0] = { ...table.rows[0]!, s: 'y' }
    expect(serializeDataTable(table, text)).toBe(
      '[\n  {\n    "n": 1,\n    "ok": true,\n    "none": null,\n    "s": "y"\n  }\n]\n'
    )
  })

  it('reads a typed cell as JSON stores it, and CSV as text', () => {
    expect(
      ['true', 'false', 'null', '12', '1.5', 'v2', ''].map((t) => parseCellValue(t, 'json'))
    ).toEqual([true, false, null, 12, 1.5, 'v2', ''])
    expect(parseCellValue('12', 'csv')).toBe('12')
    expect([cellText(null), cellText(undefined), cellText(2)]).toEqual(['null', '', '2'])
  })

  it('says what stops a table being saved', () => {
    expect(dataTableProblems({ kind: 'csv', columns: ['a', 'a', ' '], rows: [] })).toEqual([
      'the column a is named twice',
      'column 3 has no name',
      'no rows — a data file runs the collection once per row'
    ])
  })

  it('refuses a JSON row that names a column twice, which JSON.parse would quietly halve', () => {
    expect(() =>
      parseDataTable('[{"id": 1}, {"id": 2, "note": "a", "id": 3}]', 'u.json', 'json')
    ).toThrow('u.json: row 2 names id twice')
    // A key and a value alike, escapes and all, are not mistaken for each other.
    expect(
      parseDataTable('[{"a\\"b": "c: d", "x": "{\\"a\\": 1}"}, {"a\\"b": "e"}]', 'u.json', 'json')
        .rows
    ).toEqual([{ 'a"b': 'c: d', x: '{"a": 1}' }, { 'a"b': 'e' }])
  })

  it('writes cells by position when a column has no name or another’s, keeping every value', () => {
    const columns = ['id', 'id', '']
    const rows = [
      ['1', 'Happy', 'x'],
      ['2', '', 'y, z']
    ]
    expect(serializeDataCells('csv', columns, rows, `${bom}a,b\r\n1,2\r\n`)).toBe(
      `${bom}id,id,\n1,Happy,x\n2,,"y, z"\n`
    )
    // No line break at the end where the file had none; a lone empty value quoted.
    expect(serializeDataCells('csv', ['a'], [['']], 'a\nx')).toBe('a\n""')
    expect(() => parseDataTable('id,id,\n1,Happy,x\n', 'u.csv', 'csv')).toThrow('names id twice')

    const json = serializeDataCells('json', ['n', 'n'], [[1, true], [undefined, null], []])
    expect(json).toBe(
      '[\n  {\n    "n": 1,\n    "n": true\n  },\n  {\n    "n": null\n  },\n  {}\n]\n'
    )
    expect(() => parseDataTable(json, 'u.json', 'json')).toThrow('u.json: row 1 names n twice')
    // With nothing repeated, it writes what JSON.stringify would.
    expect(serializeDataCells('json', ['a', 'b'], [[1, 'x']])).toBe(
      `${JSON.stringify([{ a: 1, b: 'x' }], null, 2)}\n`
    )
    expect(serializeDataCells('json', ['a'], [])).toBe('[]\n')
  })
})
