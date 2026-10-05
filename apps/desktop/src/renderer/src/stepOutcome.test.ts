import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import { stepOutcome } from './stepOutcome.js'

const result = (over: Partial<RunResult> = {}): RunResult => ({
  item: { path: null, name: 'step', seq: null },
  request: { method: 'GET', url: 'http://x/', headers: [], body: null },
  response: {
    status: 200,
    statusText: 'OK',
    url: 'http://x/',
    headers: [],
    body: '',
    bodyKind: 'empty',
    sizeBytes: 0,
    redirectCount: 0,
    timings: { startedAt: 0, ttfbMs: 1, totalMs: 2 }
  },
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 84,
  ...over
})

const one = (r: RunResult) => stepOutcome({ running: false, result: r, parts: [], expected: 0 })

const check = (name: string, status: 'pass' | 'fail') => ({ name, status })

describe('stepOutcome', () => {
  it('puts a pass’s status and time beside its mark, and says on hover that its checks passed', () => {
    const passed = result({ assertions: [check('status', 'pass'), check('id', 'pass')] })
    expect(one(passed)).toEqual({
      mark: 'pass',
      summary: '200 · 84 ms',
      detail: null,
      hover: { title: 'All 2 checks passed', lines: [] }
    })
  })

  it('marks nothing as passed when the step has no tests', () => {
    expect(one(result())).toEqual({
      mark: null,
      summary: '200 · 84 ms',
      detail: null,
      hover: { title: 'No checks', lines: ['This step has no tests.'] }
    })
  })

  it('says on hover how many checks failed, and which', () => {
    const failed = result({
      status: 'fail',
      assertions: [check('status', 'pass'), check('name', 'fail'), check('id', 'pass')]
    })
    expect(one(failed)).toEqual({
      mark: 'fail',
      summary: '200 · 84 ms',
      detail: null,
      hover: { title: '1 of 3 checks failed', lines: ['✕ name'] }
    })
    const many = result({
      status: 'fail',
      assertions: Array.from({ length: 7 }, (_, n) => check(`c${n}`, 'fail'))
    })
    expect(one(many).hover?.lines).toEqual(['✕ c0', '✕ c1', '✕ c2', '✕ c3', '✕ c4', 'and 2 more'])
  })

  it('names an unanswered request by its code, under the name', () => {
    expect(
      one(
        result({
          status: 'error',
          response: null,
          error: {
            phase: 'http',
            code: 'ECONNREFUSED',
            message: 'connect ECONNREFUSED 127.0.0.1:9'
          }
        })
      )
    ).toEqual({
      mark: 'error',
      summary: null,
      detail: 'ECONNREFUSED',
      hover: { title: 'No response', lines: ['connect ECONNREFUSED 127.0.0.1:9'] }
    })
  })

  it('says an error with no code in full', () => {
    expect(
      one(
        result({
          status: 'error',
          response: null,
          error: { phase: 'interpolate', message: 'Variable "roots" is not defined' }
        })
      )
    ).toMatchObject({ mark: 'error', summary: null, detail: 'Variable "roots" is not defined' })
  })

  it('says why a step was skipped', () => {
    expect(
      one(result({ status: 'skipped', response: null, skipped: { reason: 'flag beta is off' } }))
    ).toMatchObject({ mark: 'skipped', summary: null, detail: 'skipped: flag beta is off' })
  })

  it('counts a use step’s requests or a forEach step’s items, an error first', () => {
    const checked = (status: RunResult['status'] = 'pass') =>
      result({ status, assertions: [check('status', status === 'fail' ? 'fail' : 'pass')] })
    const counted = (parts: RunResult[], expected: number) =>
      stepOutcome({ running: false, parts, expected, partsAre: 'item' })
    expect(counted([checked(), checked()], 2)).toEqual({
      mark: 'pass',
      summary: '2 of 2 passed',
      detail: null,
      hover: { title: '2 of 2 items passed', lines: [] }
    })
    expect(counted([checked(), checked('fail')], 2)).toMatchObject({
      mark: 'fail',
      summary: '1 of 2 passed',
      hover: { lines: ['1 failed'] }
    })
    expect(counted([checked('fail'), checked('error')], 2).mark).toBe('error')
    // None of them has tests: nothing to mark as passed.
    expect(counted([result(), result()], 2).mark).toBeNull()
    // Stopped part way through them: no verdict.
    expect(counted([checked()], 3)).toMatchObject({
      mark: null,
      summary: '1 of 3 passed',
      hover: { lines: ['2 not run'] }
    })
  })

  it('is running, or has nothing to say before it has run', () => {
    expect(stepOutcome({ running: true, parts: [], expected: 0 }).mark).toBe('running')
    expect(stepOutcome({ running: false, parts: [], expected: 0 })).toEqual({
      mark: null,
      summary: null,
      detail: null,
      hover: null
    })
  })

  it('shows the time alone where nothing was answered, and one check passed by itself', () => {
    expect(one(result({ response: null, assertions: [] }))).toMatchObject({
      mark: null,
      summary: '84 ms'
    })
    expect(one(result({ response: null, assertions: [check('ok', 'pass')] }))).toMatchObject({
      mark: 'pass',
      summary: '84 ms',
      hover: { title: '1 check passed' }
    })
    expect(
      one(result({ status: 'fail', response: null, assertions: [check('a', 'fail')] }))
    ).toMatchObject({ summary: '84 ms', hover: { title: '1 of 1 check failed' } })
    expect(one(result({ status: 'skipped', response: null }))).toMatchObject({
      detail: 'skipped',
      hover: { lines: [] }
    })
    expect(one(result({ status: 'error', response: null, error: null }))).toMatchObject({
      mark: 'error',
      detail: 'error',
      hover: { title: 'No response', lines: [] }
    })
  })

  it('counts skipped parts, all skipped as skipped, and requests by default', () => {
    const skipped = result({ status: 'skipped', response: null })
    expect(stepOutcome({ running: false, parts: [skipped, skipped], expected: 2 })).toEqual({
      mark: 'skipped',
      summary: '0 of 2 passed',
      detail: null,
      hover: { title: '0 of 2 requests passed', lines: ['2 skipped'] }
    })
    expect(stepOutcome({ running: false, parts: [result(), result()], expected: 2 }).hover).toEqual(
      {
        title: '2 of 2 requests passed',
        lines: ['No checks: none of them has tests.']
      }
    )
  })
})
