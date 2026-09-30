import { describe, expect, it } from 'vitest'
import { buildChecks, checkedBody, markLines } from './testLinks.js'

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
