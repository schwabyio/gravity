import { describe, expect, it } from 'vitest'
import { StepSchema, type Step } from '@schwabyio/gravity-core/model'
import {
  fromStep,
  headerRows,
  mergeIntoStep,
  newPart,
  newRow,
  partRows,
  readQueryParams,
  toBody,
  toHeaders,
  toMultipart,
  writeQueryParams,
  type HeaderRow
} from './requestState.js'

const step = (body: unknown): Step => StepSchema.parse({ POST: 'http://x/upload', body })

describe('multipart bodies in the editor', () => {
  const multipart = {
    description: 'A photo of {{name}}',
    metadata: { value: '{"a":1}', contentType: 'application/json' },
    avatar: { file: 'files/avatar.png', filename: 'me.png' },
    tags: ['red', 'blue']
  }

  it('reads a row per value, and writes the same map back', () => {
    const rows = partRows(multipart)
    expect(
      rows.map(({ name, kind, value, contentType }) => [name, kind, value, contentType])
    ).toEqual([
      ['description', 'text', 'A photo of {{name}}', ''],
      ['metadata', 'text', '{"a":1}', 'application/json'],
      ['avatar', 'file', 'files/avatar.png', ''],
      ['tags', 'text', 'red', ''],
      ['tags', 'text', 'blue', ''],
      ['', 'text', '', '']
    ])
    expect(toMultipart(rows)).toEqual(multipart)
  })

  it('leaves a step it did not change as it was', () => {
    const original = step({ multipart })
    expect(mergeIntoStep(original, fromStep(original))).toEqual(original)
  })

  it('keeps an empty filename, as a browser sends when no file is chosen', () => {
    const empty = { avatar: { file: 'files/empty', filename: '' } }
    expect(toMultipart(partRows(empty))).toEqual(empty)
    const original = step({ multipart: empty })
    expect(mergeIntoStep(original, fromStep(original))).toEqual(original)
  })

  it('groups a repeated name under its first place, and leaves out a file not yet chosen', () => {
    const row = (name: string, value: string, kind: 'text' | 'file' = 'text') => ({
      ...newPart(),
      name,
      value,
      kind
    })
    expect(
      toMultipart([row('a', '1'), row('b', '2'), row('a', '3'), row('c', '', 'file'), row('', 'x')])
    ).toEqual({ a: ['1', '3'], b: '2' })
  })

  it('keeps multipart as the body type with no parts yet', () => {
    const edited = { ...fromStep(step({ text: 'x' })), bodyMode: 'multipart' as const }
    expect(mergeIntoStep(step({ text: 'x' }), edited).body).toEqual({ multipart: {} })
  })
})

describe('file bodies in the editor', () => {
  it('reads and writes the path', () => {
    const original = step({ file: 'files/order.json' })
    const state = fromStep(original)
    expect(state.bodyMode).toBe('file')
    expect(state.bodyFile).toBe('files/order.json')
    expect(mergeIntoStep(original, { ...state, bodyFile: ' files/other.json ' }).body).toEqual({
      file: 'files/other.json'
    })
  })

  it('writes no body until a file is named', () => {
    const original = step({ text: 'x' })
    const edited = { ...fromStep(original), bodyMode: 'file' as const, bodyFile: '' }
    expect(mergeIntoStep(original, edited).body).toBeUndefined()
  })
})

describe('forEach in the editor', () => {
  it('reads a step’s list, writes a change, and removes an emptied one', () => {
    const original = StepSchema.parse({ DELETE: 'http://x/root/{{item}}', forEach: '{{roots}}' })
    const state = fromStep(original)
    expect(state.forEach).toBe('{{roots}}')
    expect(mergeIntoStep(original, state)).toEqual(original)
    expect(mergeIntoStep(original, { ...state, forEach: '["a", "b"]' }).forEach).toBe('["a", "b"]')
    expect(mergeIntoStep(original, { ...state, forEach: '  ' })).not.toHaveProperty('forEach')
  })

  it('never gives a use step one', () => {
    const use = StepSchema.parse({ use: 'login' })
    const state = { ...fromStep(use), forEach: '{{roots}}' }
    expect(fromStep(use).forEach).toBe('')
    expect(mergeIntoStep(use, state)).not.toHaveProperty('forEach')
  })
})

describe('useTests in the editor', () => {
  it('reads a request set step’s mark, keeps it, and removes it when unticked', () => {
    const original = StepSchema.parse({ GET: 'http://x/profile', useTests: true })
    const state = fromStep(original)
    expect(state.useTests).toBe(true)
    expect(mergeIntoStep(original, state)).toEqual(original)
    expect(mergeIntoStep(original, { ...state, useTests: false })).not.toHaveProperty('useTests')
    const plain = StepSchema.parse({ GET: 'http://x/wait' })
    expect(mergeIntoStep(plain, { ...fromStep(plain), useTests: true }).useTests).toBe(true)
  })
})

describe('connections in the editor', () => {
  it('reads and writes the connection a request opens, and removes an emptied one', () => {
    const original = StepSchema.parse({ GET: 'http://x/events', connection: 'orders' })
    const state = fromStep(original)
    expect(state.connection).toBe('orders')
    expect(state.reads).toBeNull()
    expect(mergeIntoStep(original, state)).toEqual(original)
    expect(mergeIntoStep(original, { ...state, connection: 'feed' })).toEqual({
      GET: 'http://x/events',
      connection: 'feed'
    })
    expect(mergeIntoStep(original, { ...state, connection: '' })).toEqual({
      GET: 'http://x/events'
    })
  })

  it('keeps a step reading a connection one, with no request of its own', () => {
    const original = StepSchema.parse({
      name: 'order created',
      connection: 'orders',
      settings: { untilEvent: 'order.created', streamTimeout: 5000 },
      before: { script: "gta.set('a', 1)" },
      tests: "gta.expectResponseBodyToHaveProperty('[0].event', 'order.created')",
      docs: 'Waits for the order.'
    })
    const state = fromStep(original)
    expect(state.reads).toBe('orders')
    expect(state.url).toBe('')
    expect(mergeIntoStep(original, state)).toEqual(original)
    expect(mergeIntoStep(original, { ...state, reads: 'feed', settings: {} })).toEqual({
      name: 'order created',
      connection: 'feed',
      docs: 'Waits for the order.',
      before: { script: "gta.set('a', 1)" },
      tests: "gta.expectResponseBodyToHaveProperty('[0].event', 'order.created')"
    })
  })
})

describe('docs in the editor', () => {
  it('reads a step’s docs, writes a change, and removes emptied ones', () => {
    const original = StepSchema.parse({ name: 'get', GET: 'http://x', docs: 'Gets it.' })
    const editing = fromStep(original)
    expect(editing.docs).toBe('Gets it.')
    expect(mergeIntoStep(original, { ...editing, docs: 'Gets it, **twice**.' }).docs).toBe(
      'Gets it, **twice**.'
    )
    expect('docs' in mergeIntoStep(original, { ...editing, docs: '  ' })).toBe(false)
  })

  it('writes a use step’s and a reading step’s docs as edited', () => {
    const use = StepSchema.parse({ use: 'login', docs: 'Logs in.' })
    expect(mergeIntoStep(use, { ...fromStep(use), docs: 'Logs in first.' }).docs).toBe(
      'Logs in first.'
    )
    const reading = StepSchema.parse({ connection: 'orders' })
    expect(mergeIntoStep(reading, { ...fromStep(reading), docs: 'Waits.' }).docs).toBe('Waits.')
  })
})

describe('query parameters in the editor', () => {
  it('reads the table out of the URL, which stays the source of truth', () => {
    expect(readQueryParams('{{baseUrl}}/users')).toEqual([])
    expect(readQueryParams('/users?page=2&q=a%20b&q=c&flag')).toEqual([
      { name: 'page', value: '2' },
      { name: 'q', value: 'a b' },
      { name: 'q', value: 'c' },
      { name: 'flag', value: '' }
    ])
  })

  it('writes the table back as the query string, encoded, dropping blank rows', () => {
    const params = [
      { name: 'q', value: 'a b&c' },
      { name: '', value: '' },
      { name: 'page', value: '2' }
    ]
    expect(writeQueryParams('/users?old=1', params)).toBe('/users?q=a%20b%26c&page=2')
    expect(writeQueryParams('/users', params)).toBe('/users?q=a%20b%26c&page=2')
    expect(writeQueryParams('/users?old=1', [{ name: ' ', value: '' }])).toBe('/users')
  })
})

describe('headers in the editor', () => {
  const row = (name: string, value: string, enabled = true): HeaderRow => ({
    ...newRow(),
    name,
    value,
    enabled
  })

  it('reads a row per value, a switched-off header unticked, and a blank row to type in', () => {
    const rows = headerRows({
      Accept: 'application/json',
      'X-Tag': ['a', 'b'],
      'X-Debug': { value: '1', enabled: false, description: 'only when asked' }
    })
    expect(rows.map(({ name, value, enabled }) => [name, value, enabled])).toEqual([
      ['Accept', 'application/json', true],
      ['X-Tag', 'a', true],
      ['X-Tag', 'b', true],
      ['X-Debug', '1', false],
      ['', '', true]
    ])
    expect(headerRows(undefined).map((r) => r.name)).toEqual([''])
  })

  it('writes rows back: a repeated name as a list, an unticked one switched off, the long form kept', () => {
    const original = { 'X-Debug': { value: '1', enabled: false, description: 'only when asked' } }
    expect(
      toHeaders(
        [
          row('Accept', 'application/json'),
          row('X-Tag', 'a'),
          row('X-Tag', 'b'),
          row('X-Off', 'x', false),
          row('X-Debug', '2'),
          row('', '')
        ],
        original
      )
    ).toEqual({
      Accept: 'application/json',
      'X-Tag': ['a', 'b'],
      'X-Off': { value: 'x', enabled: false },
      // Ticked again: the long form, and the enabled key it had, now on.
      'X-Debug': { value: '2', description: 'only when asked', enabled: true }
    })
    expect(
      toHeaders([row('X-Debug', '1', false)], { 'X-Debug': { value: '1', enabled: true } })
    ).toEqual({ 'X-Debug': { value: '1', enabled: false } })
    // A long form with no enabled key gets none while it is on.
    expect(
      toHeaders([row('X-Debug', '1')], { 'X-Debug': { value: '1', description: 'why' } })
    ).toEqual({
      'X-Debug': { value: '1', description: 'why' }
    })
    // Only one of a repeated name ticked: that one.
    expect(toHeaders([row('X-Tag', 'a', false), row('X-Tag', 'b')])).toEqual({ 'X-Tag': 'b' })
    expect(toHeaders([row('', '')])).toBeUndefined()
  })
})

describe('bodies in the editor', () => {
  const edited = (bodyMode: Parameters<typeof toBody>[0]['bodyMode'], bodyText = '') => ({
    bodyMode,
    bodyText,
    bodyParts: [newPart()],
    bodyFile: ''
  })

  it('writes each kind of body as its key', () => {
    expect(toBody(edited('json', '{"a":1}'))).toEqual({ json: '{"a":1}' })
    expect(toBody(edited('xml', '<a/>'))).toEqual({ xml: '<a/>' })
    expect(toBody(edited('text', 'hi'))).toEqual({ text: 'hi' })
    expect(toBody(edited('none', 'ignored'))).toBeUndefined()
    expect(toBody(edited('form', 'a=1\n\n b = 2=3 \nflag'))).toEqual({
      form: { a: '1', 'b ': ' 2=3', flag: '' }
    })
  })

  it('reads each kind back, a form a line per field', () => {
    for (const body of [{ json: '{}' }, { xml: '<a/>' }, { text: 'hi' }]) {
      const state = fromStep(step(body))
      expect(toBody(state)).toEqual(body)
    }
    const form = fromStep(step({ form: { a: '1', b: '2' } }))
    expect([form.bodyMode, form.bodyText]).toEqual(['form', 'a=1\nb=2'])
    expect(fromStep(StepSchema.parse({ GET: '/x' })).bodyMode).toBe('none')
  })

  it('leaves a body it has no editor for as it is, and removes one it has when emptied', () => {
    const graphql = step({ graphql: { query: '{ me { id } }' } })
    const state = fromStep(graphql)
    expect(state.bodyMode).toBe('none')
    expect(mergeIntoStep(graphql, state).body).toEqual({ graphql: { query: '{ me { id } }' } })

    const json = step({ json: '{}' })
    expect(mergeIntoStep(json, { ...fromStep(json), bodyMode: 'none' }).body).toBeUndefined()
  })
})

describe('a step written back from the editor', () => {
  it('moves the URL to the method chosen, and keeps what has no editor', () => {
    const original = StepSchema.parse({
      name: 'read',
      GET: '/users/1',
      before: { script: "gta.set('a', 1)" },
      settings: { timeout: 500 }
    })
    const state = fromStep(original)
    const next = mergeIntoStep(original, {
      ...state,
      name: '',
      method: 'DELETE',
      preRequest: '',
      settings: { timeout: undefined, followRedirects: false },
      base: false
    })
    expect(next).toEqual({
      DELETE: '/users/1',
      settings: { followRedirects: false },
      base: false
    })
  })
})
