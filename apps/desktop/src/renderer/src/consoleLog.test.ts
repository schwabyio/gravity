import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import type { ConsoleEvent } from '@shared/ipc.js'
import {
  clockTime,
  consoleReducer,
  EMPTY_CONSOLE,
  isProblem,
  MAX_RESULTS,
  MAX_ROWS,
  outcomeOf,
  problemCounts,
  rawExchange,
  rawRequest,
  rawResponse,
  rowsOf,
  rowsText,
  sentAt,
  shownRows,
  sourceOf,
  type ConsoleState,
  type ResultEntry
} from './consoleLog.js'

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  item: { path: '/p/collections/users.yml', name: 'get user', seq: null },
  request: {
    method: 'GET',
    url: 'http://api.test/users/7',
    headers: [{ name: 'accept', value: 'application/json' }],
    body: null
  },
  response: {
    status: 200,
    statusText: 'OK',
    url: 'http://api.test/users/7',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: '{"id":7}',
    bodyKind: 'json',
    sizeBytes: 8,
    redirectCount: 0,
    timings: { startedAt: 1_000, ttfbMs: 5, totalMs: 9 }
  },
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 12,
  ...overrides
})

const play = (events: ConsoleEvent[], from: ConsoleState = EMPTY_CONSOLE): ConsoleState =>
  events.reduce((state, event) => consoleReducer(state, { type: 'event', event }), from)

const start = (
  runId: string,
  run: 'send' | 'steps' | 'all',
  extra: Partial<Extract<ConsoleEvent, { kind: 'start' }>> = {}
): ConsoleEvent => ({
  kind: 'start',
  runId,
  at: 1,
  run,
  collection: 'users',
  environment: 'staging',
  ...extra
})

const landed = (runId: string, landedResult: RunResult = result()): ConsoleEvent => ({
  kind: 'result',
  runId,
  at: 2,
  result: landedResult
})

const totals = { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0, durationMs: 1234 }

describe('the console’s entries', () => {
  it('names each result after the run it came from, and forgets the run once it ends', () => {
    const state = play([start('a', 'send'), landed('a'), { kind: 'end', runId: 'a', at: 3 }])
    expect(state.entries.map((entry) => entry.kind)).toEqual(['start', 'result', 'end'])
    expect(state.entries[1]).toMatchObject({ run: { collection: 'users', environment: 'staging' } })
    expect(state.runs).toEqual({})
  })

  it('keeps the latest results, dropping the oldest with what came before them', () => {
    const many = Array.from({ length: MAX_RESULTS + 2 }, (_, i) =>
      landed('a', result({ item: { path: null, name: `step ${i}`, seq: null } }))
    )
    const state = play([start('a', 'all'), ...many])
    const results = state.entries.filter((entry) => entry.kind === 'result')
    expect(results).toHaveLength(MAX_RESULTS)
    expect(state.entries[0]).toMatchObject({ result: { item: { name: 'step 2' } } })
    expect(state.dropped).toBe(2)
  })

  it('empties on Clear, though a run in flight still names what it brings back', () => {
    const cleared = consoleReducer(play([start('a', 'all'), landed('a')]), { type: 'clear' })
    expect(cleared.entries).toEqual([])
    const after = play([landed('a')], cleared)
    expect(after.entries[0]).toMatchObject({ run: { kind: 'all', collection: 'users' } })
  })
})

describe('the console’s lines', () => {
  it('shows a Send as its request, then what its scripts wrote, then what stopped it', () => {
    const state = play([
      start('a', 'send'),
      landed(
        'a',
        result({
          status: 'error',
          logs: [
            { level: 'log', phase: 'pre-request', message: 'token ready' },
            { level: 'warn', phase: 'tests', message: 'slow' }
          ],
          error: { phase: 'tests', message: 'x is not defined', line: 3 }
        })
      ),
      { kind: 'end', runId: 'a', at: 3 }
    ])
    const { rows } = shownRows(state.entries, 'all', '')
    expect(rows.map((row) => row.kind)).toEqual(['request', 'log', 'log', 'error'])
    expect(rows[0]).toMatchObject({ source: 'users › get user' })
  })

  it('gives Run all a line for its start and one for its totals', () => {
    const state = play([
      start('a', 'all', { rows: 3 }),
      landed('a'),
      { kind: 'end', runId: 'a', at: 3, totals }
    ])
    const { rows } = shownRows(state.entries, 'all', '')
    expect(rows[0]).toMatchObject({
      kind: 'start',
      text: 'Run all · users · staging · 3 data rows'
    })
    expect(rows.at(-1)).toMatchObject({
      kind: 'end',
      text: 'Run all finished in 1.23 s · 1 passed · 1 failed',
      problem: true
    })
  })

  it('says when a run could not run at all', () => {
    const state = play([
      start('a', 'send'),
      { kind: 'end', runId: 'a', at: 3, failure: 'Run worker exited unexpectedly (code 1)' }
    ])
    expect(shownRows(state.entries, 'all', '').rows).toMatchObject([
      { kind: 'end', text: 'Send could not run: Run worker exited unexpectedly (code 1)' }
    ])
  })

  it('shows a skipped step as one line, with why', () => {
    const state = play([
      landed(
        'a',
        result({ status: 'skipped', response: null, skipped: { reason: 'flag beta is off' } })
      )
    ])
    expect(shownRows(state.entries, 'all', '').rows).toMatchObject([
      { kind: 'skipped', reason: 'flag beta is off', source: 'get user' }
    ])
  })

  it('names the data row a result ran with', () => {
    const state = play([
      start('a', 'all'),
      { ...landed('a'), iteration: { index: 2, of: 3, label: 'ada' } } as ConsoleEvent
    ])
    expect(shownRows(state.entries, 'requests', '').rows[0]).toMatchObject({
      source: 'users › get user · iteration 2 (ada)'
    })
  })

  it('filters by kind and by every word typed, in any case', () => {
    const state = play([
      start('a', 'send'),
      landed(
        'a',
        result({
          status: 'fail',
          assertions: [{ name: 'status', status: 'fail' }],
          logs: [
            { level: 'log', phase: 'tests', message: 'all fine' },
            { level: 'error', phase: 'tests', message: 'Broken thing' }
          ]
        })
      ),
      landed(
        'a',
        result({
          request: { method: 'POST', url: 'http://api.test/orders', headers: [], body: '{}' }
        })
      )
    ])
    const kinds = (show: Parameters<typeof shownRows>[1], query = '') =>
      shownRows(state.entries, show, query).rows.map((row) => row.kind)
    expect(kinds('requests')).toEqual(['request', 'request'])
    expect(kinds('logs')).toEqual(['log', 'log'])
    expect(kinds('problems')).toEqual(['request', 'log'])
    expect(kinds('all', 'post ORDERS')).toEqual(['request'])
    expect(kinds('all', 'broken')).toEqual(['log'])
    expect(kinds('all', 'nothing like it')).toEqual([])
  })

  it('draws only the latest lines, and says how many it leaves out', () => {
    const logs = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({
      level: 'log' as const,
      phase: 'tests' as const,
      message: `line ${i}`
    }))
    const state = play([landed('a', result({ logs }))])
    const { rows, hidden } = shownRows(state.entries, 'logs', '')
    expect(rows).toHaveLength(MAX_ROWS)
    expect(hidden).toBe(5)
    expect(rows.at(-1)).toMatchObject({ log: { message: `line ${MAX_ROWS + 4}` } })
  })
})

describe('problemCounts', () => {
  it('counts errors — errored steps, failed runs, console.error — and warnings', () => {
    const state = play([
      landed(
        'a',
        result({
          status: 'error',
          error: { phase: 'http', message: 'refused', code: 'ECONNREFUSED' },
          logs: [
            { level: 'error', phase: 'tests', message: 'bad' },
            { level: 'warn', phase: 'tests', message: 'hmm' }
          ]
        })
      ),
      // A failed check is a test's outcome, not a console problem.
      landed('a', result({ status: 'fail' })),
      start('b', 'send'),
      { kind: 'end', runId: 'b', at: 3, failure: 'boom' }
    ])
    expect(problemCounts(state.entries)).toEqual({ errors: 3, warnings: 1 })
  })
})

describe('raw text', () => {
  it('writes a request as its line, headers, a blank line and its body', () => {
    expect(
      rawRequest({
        method: 'POST',
        url: 'http://api.test/orders',
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'authorization', value: 'Bearer [secret: TOKEN]' }
        ],
        body: '{"id":1}'
      })
    ).toBe(
      'POST http://api.test/orders\ncontent-type: application/json\nauthorization: Bearer [secret: TOKEN]\n\n{"id":1}'
    )
    expect(rawRequest({ method: 'GET', url: 'http://api.test/', headers: [], body: null })).toBe(
      'GET http://api.test/'
    )
  })

  it('writes a response as its status, headers, a blank line and its body as received', () => {
    const response = result().response!
    expect(rawResponse(response)).toBe('200 OK\ncontent-type: application/json\n\n{"id":7}')
    expect(rawResponse({ ...response, body: '', headers: [] })).toBe('200 OK')
    expect(
      rawResponse({
        ...response,
        bodyKind: 'binary',
        body: 'iVBORw0KGgo=',
        bodyEncoding: 'base64',
        sizeBytes: 2048
      })
    ).toBe('200 OK\ncontent-type: application/json\n\n[binary body, 2.0 KB]')
    // A binary type whose bytes are text, application/jwt say, is that text.
    expect(rawResponse({ ...response, bodyKind: 'binary', body: 'eyJhbGciOi.x.y' })).toBe(
      '200 OK\ncontent-type: application/json\n\neyJhbGciOi.x.y'
    )
  })

  it('writes both, the request first', () => {
    expect(rawExchange(result())).toBe(
      'GET http://api.test/users/7\naccept: application/json\n\n200 OK\ncontent-type: application/json\n\n{"id":7}'
    )
    expect(rawExchange(result({ response: null }))).toBe(
      'GET http://api.test/users/7\naccept: application/json'
    )
  })

  it('says what a request came to', () => {
    expect(outcomeOf(result())).toBe('200 OK')
    expect(
      outcomeOf(
        result({ response: null, error: { phase: 'http', message: 'x', code: 'ECONNREFUSED' } })
      )
    ).toBe('ECONNREFUSED')
    expect(
      outcomeOf(result({ response: null, error: { phase: 'pre-request', message: 'x' } }))
    ).toBe('not sent')
  })

  it('says a failed request with no code failed, and when each was sent', () => {
    expect(outcomeOf(result({ response: null, error: { phase: 'http', message: 'x' } }))).toBe(
      'failed'
    )
    const entry = (r: RunResult): ResultEntry => ({
      kind: 'result',
      key: 1,
      at: 5_000,
      run: null,
      result: r
    })
    // Sent: when the response says. Never sent: when its step began.
    expect(sentAt(entry(result()))).toBe(1_000)
    expect(sentAt(entry(result({ response: null, durationMs: 40 })))).toBe(4_960)
  })

  it('tells the time of day to the millisecond', () => {
    const at = new Date(2026, 9, 5, 9, 3, 7, 45).getTime()
    expect(clockTime(at)).toBe('09:03:07.045')
  })
})

describe('a result as the console names and lists it', () => {
  const entry = (over: Partial<ResultEntry> = {}): ResultEntry => ({
    kind: 'result',
    key: 3,
    at: 10,
    run: { kind: 'all', collection: 'users', environment: null },
    result: result(),
    ...over
  })

  it('names its collection, step and iteration', () => {
    expect(sourceOf(entry())).toBe('users › get user')
    expect(sourceOf(entry({ run: null }))).toBe('get user')
    expect(sourceOf(entry({ iteration: { index: 2, of: 3, label: 'ada' } }))).toBe(
      'users › get user · iteration 2 (ada)'
    )
    expect(sourceOf(entry({ iteration: { index: 3, of: 3, label: null } }))).toBe(
      'users › get user · iteration 3'
    )
  })

  it('lists a skipped step by its reason, a script’s warning as a problem, and an error', () => {
    const skipped = rowsOf(
      entry({
        result: result({ status: 'skipped', response: null, skipped: { reason: 'flag off' } })
      })
    )
    expect(skipped[0]).toMatchObject({ kind: 'skipped', reason: 'flag off' })
    expect(isProblem(skipped[0]!)).toBe(false)
    const unexplained = rowsOf(entry({ result: result({ status: 'skipped', response: null }) }))
    expect(unexplained[0]).toMatchObject({ kind: 'skipped', reason: 'not run' })

    const logged = rowsOf(
      entry({
        result: result({
          status: 'error',
          logs: [
            { phase: 'tests', level: 'warn', message: 'slow' },
            { phase: 'tests', level: 'log', message: 'ok' }
          ],
          error: { phase: 'tests', message: 'boom' }
        })
      })
    )
    expect(logged.map((row) => row.kind)).toEqual(['request', 'log', 'log', 'error'])
    expect(logged.map(isProblem)).toEqual([true, true, false, true])
  })
})

describe('the load log', () => {
  const load = (seq: number, subject: string, text: string, problem = false): ConsoleEvent => ({
    kind: 'load',
    seq,
    at: new Date(2026, 9, 10, 9, 0, 0, seq).getTime(),
    subject,
    text,
    ...(problem ? { problem } : {})
  })
  const state = play([
    load(1, 'git', 'bundled git 2.53.0 answered in 1.2 s'),
    load(2, 'orders', 'Listed 120 collections, 7 environments in 640 ms (as it was added)'),
    start('r1', 'send'),
    { kind: 'result', runId: 'r1', at: 2_000, result: result() },
    load(
      3,
      'orders',
      '../shared/environments could not be read (EBUSY: resource busy or locked)',
      true
    )
  ])

  it('shows each line among the requests, about its project, git or the app', () => {
    const { rows } = shownRows(state.entries, 'all', '')
    expect(rows.map((row) => row.kind)).toEqual(['load', 'load', 'request', 'load'])
    expect(rows[1]).toMatchObject({ kind: 'load', subject: 'orders', problem: false })
  })

  it('shows only the load log under Loading projects, and finds a project by name', () => {
    expect(shownRows(state.entries, 'loading', '').rows).toHaveLength(3)
    expect(shownRows(state.entries, 'loading', 'git').rows).toHaveLength(1)
  })

  it('counts a part that could not be read as a warning, among the problems', () => {
    expect(problemCounts(state.entries)).toEqual({ errors: 0, warnings: 1 })
    const problems = shownRows(state.entries, 'problems', '').rows
    expect(problems).toHaveLength(1)
    expect(problems.every(isProblem)).toBe(true)
  })

  it('copies as text, a line each, the time first, the problem marked', () => {
    const text = rowsText(shownRows(state.entries, 'loading', '').rows).split('\n')
    expect(text).toEqual([
      '09:00:00.001  git · bundled git 2.53.0 answered in 1.2 s',
      '09:00:00.002  orders · Listed 120 collections, 7 environments in 640 ms (as it was added)',
      '09:00:00.003  PROBLEM orders · ../shared/environments could not be read (EBUSY: resource busy or locked)'
    ])
  })

  it('copies a request as its method, URL, outcome and time', () => {
    const [request] = shownRows(state.entries, 'requests', '').rows
    expect(rowsText([request!])).toBe(
      `${clockTime(1_000)}  GET http://api.test/users/7  200 OK  9 ms  users › get user`
    )
  })
})
