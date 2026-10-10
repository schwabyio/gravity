import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core'
import type { JobOutcome } from './job.js'
import { timedOutAfter } from './pool.js'

const result = (status: RunResult['status'], stage?: 'setup' | 'teardown') =>
  ({ status, ...(stage ? { stage } : {}) }) as RunResult

const ran = (...results: RunResult[]): JobOutcome => ({
  ok: true,
  summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, durationMs: 0, results },
  steps: [],
  data: null
})

const MESSAGE = 'Timed out after 500 ms (timeoutCollection)'

describe('timedOutAfter', () => {
  it('fails a run stopped at its limit, saying how its teardown went', () => {
    expect(
      timedOutAfter(
        MESSAGE,
        ran(result('pass'), result('pass', 'teardown'), result('fail', 'teardown'))
      )
    ).toEqual({ ok: false, message: `${MESSAGE}. Teardown ran after it: 1 of 2 passed.` })
  })

  it('says only that it timed out when no teardown ran, or the thread said nothing', () => {
    expect(timedOutAfter(MESSAGE, ran(result('pass', 'setup')))).toEqual({
      ok: false,
      message: MESSAGE
    })
    expect(timedOutAfter(MESSAGE, { ok: false, message: 'gone' })).toEqual({
      ok: false,
      message: MESSAGE
    })
  })
})
