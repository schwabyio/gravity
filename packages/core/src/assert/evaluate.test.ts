import { describe, expect, it } from 'vitest'
import type { AssertionResult, ReceivedResponse } from '../model/run.js'
import { VariableScope } from '../vars/scope.js'
import type { CheckMatcher } from './evaluate.js'
import { CheckSession } from './session.js'

const response = (body: unknown, extra: Partial<ReceivedResponse> = {}): ReceivedResponse => ({
  status: 200,
  statusText: 'OK',
  url: 'http://example.test/',
  headers: [
    { name: 'Content-Type', value: 'application/json; charset=utf-8' },
    { name: 'X-Request-Id', value: 'abc' }
  ],
  body: typeof body === 'string' ? body : JSON.stringify(body),
  bodyKind: typeof body === 'string' ? 'text' : 'json',
  sizeBytes: 0,
  redirectCount: 0,
  timings: { startedAt: 0, ttfbMs: 0, totalMs: 0 },
  ...extra
})

/** A block of checks, shaped for brevity here; a scalar means equality. */
interface Block {
  strict?: boolean
  sortArraysBy?: string[]
  status?: CheckMatcher | number
  headers?: Record<string, CheckMatcher | string>
  body?: Record<string, unknown>
}

const asMatcher = (m: unknown): CheckMatcher =>
  m !== null && typeof m === 'object' ? (m as CheckMatcher) : { equals: m as never }

/** Drive the engine the way gta's calls do. */
const run = (block: Block, body: unknown, scope = new VariableScope(), extra = {}) => {
  const session = new CheckSession({
    response: response(body, extra),
    scope,
    now: () => new Date(2026, 8, 23, 12).getTime()
  })
  if (block.strict !== undefined) session.setStrict(block.strict)
  if (block.sortArraysBy) session.sortBy(block.sortArraysBy)
  if (block.status !== undefined) session.status(asMatcher(block.status))
  for (const [name, m] of Object.entries(block.headers ?? {})) session.header(name, asMatcher(m))
  for (const [path, m] of Object.entries(block.body ?? {})) {
    if (m === 'ignore') session.ignore(path)
    else session.body(path, asMatcher(m))
  }
  return session.finish()
}

const byPath = (assertions: AssertionResult[], path: string) =>
  assertions.find((a) => a.path === path)

describe('status and headers', () => {
  it('checks the status by equality, pattern and negation', () => {
    expect(run({ status: 200 }, {}).assertions[0]).toMatchObject({
      status: 'pass',
      target: 'status'
    })
    expect(run({ status: { matches: '^2' } }, {}).assertions[0]?.status).toBe('pass')
    expect(run({ status: 404 }, {}).assertions[0]).toMatchObject({
      status: 'fail',
      actual: '200',
      message: 'Expected 404, got 200'
    })
    expect(run({ status: { not: 200 } }, {}).assertions[0]?.status).toBe('fail')
  })

  it('matches header names case-insensitively, and checks presence', () => {
    const { assertions } = run(
      {
        headers: {
          'content-type': { matches: '^application/json' },
          'X-Request-Id': { present: true },
          'X-Debug': { absent: true },
          'X-Missing': 'x'
        }
      },
      {}
    )
    expect(assertions.map((a) => a.status)).toEqual(['pass', 'pass', 'pass', 'fail'])
    expect(byPath(assertions, 'X-Missing')?.message).toBe('Not present')
  })
})

describe('body', () => {
  const body = {
    error: { code: 'token_expired', retryable: false, attempts: 3, score: 101, stack: undefined },
    roles: ['viewer', 'admin', 'editor'],
    sessions: [],
    users: [
      { id: 2, name: 'b' },
      { id: 1, name: 'a' }
    ]
  }

  it('compares with type, and says so when only the type differs', () => {
    const { assertions } = run(
      { body: { 'error.code': 'token_expired', 'error.attempts': '3' } },
      body
    )
    expect(byPath(assertions, 'error.code')?.status).toBe('pass')
    expect(byPath(assertions, 'error.attempts')).toMatchObject({
      status: 'fail',
      message: 'Expected "3" (a string), got 3 (a number)'
    })
  })

  it('reports a missing property as its own failure', () => {
    const { assertions } = run({ body: { 'error.nope': 1 } }, body)
    expect(assertions[0]).toMatchObject({
      status: 'fail',
      message: 'Not present in the response body'
    })
    expect(assertions[0]?.actual).toBeUndefined()
  })

  it('supports within, arrays and unordered', () => {
    const { assertions } = run(
      {
        body: {
          'error.score': { equals: 100, within: 2 },
          roles: { unordered: ['admin', 'editor'] },
          sessions: { isArray: 'empty' },
          users: { isArray: true, length: 3 },
          'users[].id': { matches: '^\\d$' }
        }
      },
      body
    )
    expect(assertions.map((a) => [a.path, a.status])).toEqual([
      ['error.score', 'pass'],
      ['roles', 'pass'],
      ['sessions', 'pass'],
      ['users', 'fail'],
      ['users[].id', 'pass']
    ])
    expect(byPath(assertions, 'users')?.message).toBe('Expected 3 items, got 2')
  })

  it('matches a RegExp in an unordered list, or as an item’s property, against the value as text', () => {
    const { assertions } = run(
      {
        body: {
          roles: { unordered: [/^ADM/i, 'editor'] },
          users: { unordered: [{ id: /^1$/, name: /^a/ }] },
          'error.code': { equals: 'token_expired' },
          sessions: { unorderedNot: [/x/] }
        }
      },
      body
    )
    expect(assertions.map((a) => [a.path, a.status])).toEqual([
      ['roles', 'pass'],
      ['users', 'pass'],
      ['error.code', 'pass'],
      ['sessions', 'pass']
    ])
    const missing = run(
      { body: { roles: { unordered: [/^own/] }, users: { unordered: [/a/] } } },
      body
    )
    expect(missing.assertions.map((a) => a.message)).toEqual([
      'Missing from the array: /^own/',
      // A pattern is tested against text, so it never matches an object item.
      'Missing from the array: /a/'
    ])
    const found = run({ body: { roles: { unorderedNot: ['owner', /^view/] } } }, body)
    expect(found.assertions[0]?.message).toBe('Must not contain: /^view/')
  })

  it('compares epoch dates by calendar day, with a number as an offset from now', () => {
    const noon = new Date(2026, 8, 23, 12).getTime()
    const { assertions } = run(
      {
        body: {
          today: { equals: 0, dateAsEpoch: true },
          tomorrow: { equals: 86400, dateAsEpoch: true },
          fixed: { equals: '2026-09-23', dateAsEpoch: true }
        }
      },
      { today: noon, tomorrow: noon + 86_400_000, fixed: noon }
    )
    expect(assertions.every((a) => a.status === 'pass')).toBe(true)
  })

  it('captures into the scope', () => {
    const scope = new VariableScope()
    const { assertions } = run({ body: { 'error.attempts': { into: 'attempts' } } }, body, scope)
    expect(assertions[0]?.status).toBe('pass')
    expect(scope.get('attempts')).toBe(3)
  })

  it('compares expected text literally: {{…}} is not a variable here', () => {
    const { assertions } = run({ body: { 'error.code': '{{want}}' } }, body)
    expect(assertions[0]).toMatchObject({
      status: 'fail',
      message: 'Expected "{{want}}", got "token_expired"'
    })
  })

  it('exposes a text body as plaintext', () => {
    const { assertions } = run({ body: { plaintext: { matches: 'hello' } } }, 'hello world')
    expect(assertions[0]?.status).toBe('pass')
  })

  it('sorts arrays before comparing, and reports the sort', () => {
    const outcome = run({ sortArraysBy: ['id'], body: { 'users.0.name': 'a' } }, body)
    expect(outcome.assertions[0]?.status).toBe('pass')
    expect(outcome.sortedBy).toEqual(['id'])
  })
})

describe('strict', () => {
  const body = {
    id: 7,
    name: 'x',
    deletedAt: null,
    tags: [],
    items: [
      { id: 1, at: 'now' },
      { id: 2, at: 'then' }
    ]
  }
  const strict = (bodyExpect: Record<string, unknown>) =>
    run({ strict: true, body: bodyExpect }, body).assertions.find((a) => a.target === 'strict')!

  it('passes when every property is asserted, ignored or captured', () => {
    expect(
      strict({
        id: 7,
        name: { into: 'n' },
        'items[].id': { matches: '\\d' },
        'items[].at': 'ignore'
      })
    ).toMatchObject({ status: 'pass' })
  })

  it('lists what was left, ignoring null and empty containers as xtest did', () => {
    expect(strict({ id: 7, 'items[].at': 'ignore' })).toMatchObject({
      status: 'fail',
      unasserted: ['name', 'items[0].id', 'items[1].id']
    })
  })

  it('does not let a shape-only check vouch for the contents', () => {
    expect(strict({ id: 7, name: 'x', items: { isArray: true, length: 2 } }).unasserted).toEqual([
      'items[0].id',
      'items[0].at',
      'items[1].id',
      'items[1].at'
    ])
  })

  it('counts items matched by a pattern as checked', () => {
    expect(
      strict({ id: 7, name: 'x', items: { unordered: [{ id: /^1$/, at: /^n/ }, { id: /2/ }] } })
        .unasserted
    ).toEqual(['items[1].at'])
  })

  it('counts object items matched by unordered, property by property', () => {
    expect(
      strict({ id: 7, name: 'x', items: { unordered: [{ id: 1 }, { id: 2, at: 'then' }] } })
        .unasserted
    ).toEqual(['items[0].at'])
  })
})
