import { describe, expect, it } from 'vitest'
import { buildChecks, checkedBody, checkedDiffersFromRaw, markLines } from './checkMarks.js'
import { parsePath } from './path.js'

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

  it('marks what was ignored, everything inside it, and under a check its check’s verdict', () => {
    const body = checkedBody(
      {
        bodyKind: 'json',
        body: JSON.stringify({
          id: { value: 'account-1' },
          subAccounts: [{ id: { value: 'sub-1' } }],
          account: [{ id: { value: 'a' }, kind: 'x' }]
        })
      },
      undefined
    )
    if (!body.ok) throw new Error(body.message)
    const checks = buildChecks([
      { name: 'id.value is "account-1"', status: 'fail', target: 'body', path: 'id.value' }
    ])
    const ignored = ['subAccounts', 'account[].id.value', 'id'].map(parsePath)
    const marked = markLines(body.lines, checks, ignored)
    const markOf = (text: string) =>
      marked[body.lines.findIndex((l) => l.text.includes(text))]?.mark
    expect(markOf('"subAccounts"')).toBe('ignored')
    expect(markOf('"sub-1"')).toBe('ignored')
    expect(markOf('"a"')).toBe('ignored')
    expect(markOf('"kind"')).toBeNull()
    // The check's ✗ shows, though an ignore of `id` covers its line too.
    expect(markOf('"account-1"')).toBe('fail')
  })
})

describe('marking only what a check covered', () => {
  const body = checkedBody(
    {
      bodyKind: 'json',
      body: JSON.stringify({
        account: [
          { id: { value: 'account-1' }, subAccounts: [{ id: { value: 'sub-account-1' } }] },
          { id: { value: 'account-2' }, subAccounts: [] }
        ]
      })
    },
    undefined
  )
  if (!body.ok) throw new Error(body.message)
  const markOf = (marked: ReturnType<typeof markLines>, text: string) =>
    marked[body.lines.findIndex((l) => l.text.includes(text))]?.mark ?? null

  it('marks an unordered check’s array, and the properties it matched, not every line', () => {
    const checks = buildChecks([
      {
        name: 'account has, in any order, subAccounts.0.id.value "sub-account-1"',
        status: 'pass',
        target: 'body',
        path: 'account',
        covered: ['account[0].subAccounts[0].id.value']
      }
    ])
    const marked = markLines(body.lines, checks)
    expect(markOf(marked, '"account": [')).toBe('pass')
    expect(markOf(marked, '"sub-account-1"')).toBe('pass')
    expect(markOf(marked, '"account-1"')).toBeNull()
    expect(markOf(marked, '"account-2"')).toBeNull()
  })

  it('marks only the array’s own line when nothing in it matched', () => {
    const checks = buildChecks([
      { name: 'account has …', status: 'fail', target: 'body', path: 'account', covered: [] }
    ])
    const marked = markLines(body.lines, checks)
    expect(markOf(marked, '"account": [')).toBe('fail')
    expect(markOf(marked, '"account-1"')).toBeNull()
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
