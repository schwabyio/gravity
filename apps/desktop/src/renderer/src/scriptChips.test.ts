import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import { countChecks, preRequestChip, testsChip } from './scriptChips.js'

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

const tests = [
  'gta.expectResponseStatusCodeToBe(201)',
  "gta.expectResponseBodyToHaveProperty('id')",
  "gta.test('total adds up', () => {})"
].join('\n')

describe('countChecks', () => {
  it('counts gta.expect… and gta.test calls, not other code', () => {
    expect(countChecks(tests)).toBe(3)
    expect(countChecks("gta.set('a', 1)\nconsole.log(res.body)")).toBe(0)
  })
})

describe('testsChip', () => {
  it('says how many checks are written, before a run', () => {
    expect(testsChip(tests, null)?.text).toBe('3 checks')
    expect(testsChip('gta.expectResponseStatusCodeToBe(200)', null)?.text).toBe('1 check')
  })

  it('says none for a step with no tests, unless a layer around it has some', () => {
    expect(testsChip('', null)).toMatchObject({ text: 'none', tone: 'idle' })
    expect(testsChip('', null, true)).toBeNull()
  })

  it('says how a run went', () => {
    const checks = [
      { name: 'a', status: 'pass' as const },
      { name: 'b', status: 'fail' as const },
      { name: 'c', status: 'pass' as const }
    ]
    expect(testsChip(tests, result({ assertions: checks, status: 'fail' }))).toEqual({
      text: '✕ 1 of 3',
      tone: 'fail',
      title: '1 of 3 checks failed'
    })
    expect(testsChip(tests, result({ assertions: [checks[0]!] }))).toMatchObject({
      text: '✓ 1',
      tone: 'pass'
    })
  })

  it('marks tests that stopped, or never ran for want of a response', () => {
    const stopped = result({
      status: 'error',
      error: { phase: 'tests', message: 'boom', script: 'step', line: 2 }
    })
    expect(testsChip(tests, stopped)?.tone).toBe('error')
    const unanswered = result({
      status: 'error',
      response: null,
      error: { phase: 'http', code: 'ECONNREFUSED', message: 'refused' }
    })
    expect(testsChip(tests, unanswered)?.text).toBe('not run')
  })
})

describe('preRequestChip', () => {
  it('counts lines before a run, and says it ran after one', () => {
    expect(preRequestChip("gta.set('a', 1)\n\ngta.set('b', 2)\n", null)?.text).toBe('2 lines')
    expect(preRequestChip("gta.set('a', 1)", result())).toMatchObject({ text: '✓', tone: 'pass' })
    expect(preRequestChip('', null)).toBeNull()
  })

  it('marks a script that stopped', () => {
    const stopped = result({
      status: 'error',
      response: null,
      error: { phase: 'pre-request', message: 'boom', script: 'step', line: 1 }
    })
    expect(preRequestChip("gta.set('a')", stopped)).toMatchObject({ text: '!', tone: 'error' })
  })
})
