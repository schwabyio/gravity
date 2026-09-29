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
