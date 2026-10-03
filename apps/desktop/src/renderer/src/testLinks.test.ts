import { describe, expect, it } from 'vitest'
import { buildChecks, checkedBody, checkedDiffersFromRaw, markLines } from './testLinks.js'

describe('marking the lines a check is about', () => {
  it('finds a key holding dots, and the empty key, by their quoted paths', () => {
    const body = checkedBody(
      {
        bodyKind: 'json',
        body: JSON.stringify({
          payload: { 'https://data.ia.io/id': 'acct-1', https: 'other' },
          modules: { '': { edition: 'maker' } }
        })
      },
      undefined
    )
    if (!body.ok) throw new Error(body.message)
    const checks = buildChecks([
      {
        name: 'payload["https://data.ia.io/id"] is "acct-1"',
        status: 'pass',
        target: 'body',
        path: 'payload["https://data.ia.io/id"]'
      },
      {
        name: 'Strict: every body property is asserted',
        status: 'fail',
        target: 'strict',
        unasserted: ['modules[""].edition']
      }
    ])
    const marked = markLines(body.lines, checks)
    const markOf = (text: string) => marked[body.lines.findIndex((l) => l.text.includes(text))]
    expect(markOf('"https://data.ia.io/id"')).toEqual({ about: [0], mark: 'pass' })
    expect(markOf('"https": "other"')).toEqual({ about: [], mark: null })
    expect(markOf('"edition"')).toEqual({ about: [1], mark: 'unasserted' })
  })
})

describe('an event stream', () => {
  const response = {
    bodyKind: 'events' as const,
    body: 'event: price\ndata: {"price":100}\n\n: heartbeat\n\ndata: [DONE]\n\n'
  }

  it('is shown as its events, with the stream as sent a click away', () => {
    expect(checkedDiffersFromRaw(response, undefined)).toBe(true)
    const body = checkedBody(response, undefined)
    if (!body.ok) throw new Error(body.message)
    expect(body.lines.map((line) => line.text.trim())).toEqual([
      '[',
      '{',
      '"event": "price",',
      '"data": {',
      '"price": 100',
      '}',
      '},',
      '{',
      '"data": "[DONE]"',
      '}',
      ']'
    ])
  })

  it('marks the line a check on an event is about', () => {
    const body = checkedBody(response, undefined)
    if (!body.ok) throw new Error(body.message)
    const checks = buildChecks([
      { name: '[0].data.price is 100', status: 'pass', target: 'body', path: '[0].data.price' }
    ])
    const marked = markLines(body.lines, checks)
    const at = body.lines.findIndex((line) => line.text.includes('"price": 100'))
    expect(marked[at]).toEqual({ about: [0], mark: 'pass' })
  })
})
