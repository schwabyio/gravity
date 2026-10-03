import { describe, expect, it } from 'vitest'
import { StepSchema, type Step } from '@schwabyio/gravity-core/model'
import { fromStep, mergeIntoStep, newPart, partRows, toMultipart } from './requestState.js'

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
