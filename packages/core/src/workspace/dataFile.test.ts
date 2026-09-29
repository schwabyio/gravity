import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildScope } from '../vars/resolve.js'
import { loadCollection } from './collection.js'
import {
  applyDataTable,
  applyDataText,
  createDataFile,
  DataFileError,
  findDataFile,
  readDataFile,
  readDataTable
} from './dataFile.js'

let root: string
let collections: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-data-'))
  collections = path.join(root, 'collections')
  await fs.mkdir(collections)
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const write = (name: string, text: string) => fs.writeFile(path.join(collections, name), text)
const rowsOf = async (name: string, text: string) => {
  await write(name, text)
  return (await readDataFile(path.join(collections, name))).rows
}

describe('data files', () => {
  it('finds <id>.csv beside the collection, before <id>.json, in its exact case', async () => {
    await write('users.yml', 'id: users\nsteps: []\n')
    expect(await findDataFile(path.join(collections, 'users.yml'))).toBeNull()
    await write('users.json', '[]')
    expect(await findDataFile(path.join(collections, 'users.yml'))).toBe(
      path.join(collections, 'users.json')
    )
    await write('users.csv', 'a\n1\n')
    expect(await findDataFile(path.join(collections, 'users.yml'))).toBe(
      path.join(collections, 'users.csv')
    )
    await write('Other.csv', 'a\n1\n')
    await write('other.yml', 'id: other\nsteps: []\n')
    expect(await findDataFile(path.join(collections, 'other.yml'))).toBeNull()
  })

  it('reads CSV as strings: quotes, commas, line breaks, CRLF, a BOM and short rows', async () => {
    const bom = String.fromCharCode(0xfeff)
    const rows = await rowsOf(
      'u.csv',
      `${bom}id,name,zip,note\r\n1,"Smith, Ann",01234,"said ""hi""\nthen left"\r\n\r\n2,Bob\r\n`
    )
    expect(rows.map((r) => r.values)).toEqual([
      { id: '1', name: 'Smith, Ann', zip: '01234', note: 'said "hi"\nthen left' },
      { id: '2', name: 'Bob', zip: '', note: '' }
    ])
  })

  it('takes a row’s label from iterationLabel, when it has one', async () => {
    const rows = await rowsOf('u.csv', 'a,iterationLabel\n1,Happy path\n2,\n')
    expect(rows.map((r) => r.label)).toEqual(['Happy path', null])
    expect(rows[0]!.values.iterationLabel).toBe('Happy path')
  })

  it('keeps JSON values’ types', async () => {
    const rows = await rowsOf('u.json', '[{"n": 1, "ok": true, "none": null, "s": "x"}]')
    expect(rows[0]!.values).toEqual({ n: 1, ok: true, none: null, s: 'x' })
  })

  it('says what is wrong with a file that will not do', async () => {
    const refused = async (name: string, text: string, message: RegExp) =>
      expect(rowsOf(name, text)).rejects.toThrow(message)
    await refused('a.csv', 'a,b\n', /no rows/)
    await refused('b.csv', 'a,a\n1,2\n', /names a twice/)
    await refused('c.csv', 'a,\n1,2\n', /column 2 of the header has no name/)
    await refused('d.csv', 'a\n1,2\n', /line 2 has 2 values for 1 columns/)
    await refused('e.csv', 'a\n"open\n', /never ends/)
    await refused('f.json', '{"a": 1}', /array of objects/)
    await refused('g.json', '[{"a": {"b": 1}}]', /row 1, a — a value is/)
    await refused('h.json', '[', /not valid JSON/)
    await expect(rowsOf('i.csv', '')).rejects.toBeInstanceOf(DataFileError)
  })

  it('shows on the collection, and a broken one is a problem', async () => {
    await write('users.yml', 'id: users\nsteps: []\n')
    await write('users.csv', 'a\n1\n2\n')
    const loaded = await loadCollection(path.join(collections, 'users.yml'), root)
    expect(loaded.dataFile).toEqual({
      path: path.join(collections, 'users.csv'),
      relativePath: 'users.csv',
      rows: 2
    })
    expect(loaded.problems).toEqual([])
    await write('users.csv', 'a\n')
    const broken = await loadCollection(path.join(collections, 'users.yml'), root)
    expect(broken.problems).toEqual([
      { path: 'users.csv', message: expect.stringContaining('no rows') }
    ])
  })

  it('puts a row over the environment in the scope: the first by default, or the one given', async () => {
    await fs.mkdir(path.join(root, 'environments'))
    await fs.writeFile(
      path.join(root, 'environments', 'demo.yml'),
      'name: demo\nvars:\n  user: env\n  host: h\n'
    )
    await write('users.yml', 'id: users\nvars:\n  user: collection\nsteps: []\n')
    await write('users.csv', 'user\nann\nbob\n')
    const context = {
      collectionPath: path.join(collections, 'users.yml'),
      environmentName: 'demo',
      env: {}
    }
    const first = await buildScope(context)
    expect(first.get('user')).toBe('ann')
    expect(first.originOf('user')).toBe('users.csv row 1')
    const second = await buildScope({
      ...context,
      dataRow: { source: 'users.csv row 2', vars: { user: 'bob' } }
    })
    expect(second.get('user')).toBe('bob')
    const none = await buildScope({ ...context, dataRow: null })
    expect(none.get('user')).toBe('env')
    expect(first.get('host')).toBe('h')
  })

  it('creates a CSV with one column and one empty row, never over one that exists', async () => {
    await write('users.yml', 'id: users\nsteps: []\n')
    const file = await createDataFile(path.join(collections, 'users.yml'), 'userId')
    expect(file).toBe(path.join(collections, 'users.csv'))
    expect(await fs.readFile(file, 'utf8')).toBe('userId\n""\n')
    expect((await readDataFile(file)).rows).toEqual([{ values: { userId: '' }, label: null }])
    await expect(createDataFile(path.join(collections, 'users.yml'), 'x')).rejects.toThrow(
      'already has a data file'
    )
  })

  it('writes an edited table only against the text it was read from, and never an invalid one', async () => {
    await write('users.csv', 'a,b\r\n1,2\r\n')
    const file = path.join(collections, 'users.csv')
    const { source, table } = await readDataTable(file)
    table.rows.push({ a: '3', b: '4' })
    const written = await applyDataTable(file, source, table)
    // A file checked out with CRLF is written back LF.
    expect(written).toMatchObject({ ok: true, wrote: true, source: 'a,b\n1,2\n3,4\n' })
    const stale = await applyDataTable(file, source, table)
    expect(stale).toMatchObject({ ok: false, conflict: true })
    await expect(
      applyDataTable(file, 'a,b\n1,2\n3,4\n', { ...table, columns: ['a', 'a'] })
    ).rejects.toThrow('named twice')
  })

  it('writes raw text exactly as typed, once it reads as a table a run accepts', async () => {
    await write('users.csv', 'a,b\n1,2\n')
    const file = path.join(collections, 'users.csv')
    const typed = 'a,b\n"1",   2\n3,4\n'
    expect(await applyDataText(file, 'a,b\n1,2\n', typed)).toMatchObject({ ok: true, wrote: true })
    expect(await fs.readFile(file, 'utf8')).toBe(typed)
    await expect(applyDataText(file, typed, 'a,a\n1,2\n')).rejects.toThrow('names a twice')
    await expect(applyDataText(file, typed, 'a,b\n')).rejects.toThrow('no rows')
    expect(await fs.readFile(file, 'utf8')).toBe(typed)
    expect(await applyDataText(file, 'stale', 'a\n1\n')).toMatchObject({
      ok: false,
      conflict: true
    })
    // Pasted CRLF is written LF, as every file the tools write is.
    expect(await applyDataText(file, typed, 'a,b\r\n5,6\r\n')).toMatchObject({
      ok: true,
      source: 'a,b\n5,6\n'
    })
  })
})
