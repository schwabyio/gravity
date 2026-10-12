import type * as Timers from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { StepSchema } from '../model/documents.js'
import { runRequest } from './runRequest.js'

// Timers that end early, as Node's can by a millisecond, Windows' most of all.
vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof Timers>()
  return {
    ...timers,
    setTimeout: (ms: number, value?: unknown, options?: object) =>
      timers.setTimeout(Math.max(0, ms - 3), value, options)
  }
})

describe('a wait step, when timers end early', () => {
  it('still waits all its milliseconds', async () => {
    const started = performance.now()
    const result = await runRequest({ step: StepSchema.parse({ wait: 40 }) })
    expect(performance.now() - started).toBeGreaterThanOrEqual(40)
    expect(result.durationMs).toBeGreaterThanOrEqual(40)
    expect(result.status).toBe('pass')
  })
})
