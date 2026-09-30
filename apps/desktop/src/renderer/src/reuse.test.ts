import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import { childKey, itemKey, itemResultsOf, stepOfKey } from './reuse.js'

const result = (index: number): RunResult => ({
  item: { path: null, name: 'remove', seq: null },
  request: { method: 'DELETE', url: `http://x/${index}`, headers: [], body: null },
  response: null,
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 1,
  forEach: { index, of: 3, item: String(index) }
})

describe('forEach results', () => {
  it('are kept one per item, under the step, and read back in order', () => {
    const results = { [itemKey('step-1', 1)]: result(1), [itemKey('step-1', 0)]: result(0) }
    expect(itemResultsOf(results, 'step-1').map((r) => r.forEach?.index)).toEqual([0, 1])
    expect(itemResultsOf(results, 'step-2')).toEqual([])
  })

  it('belong to their step, as a use step’s requests do', () => {
    expect(stepOfKey(itemKey('step-1', 2))).toBe('step-1')
    expect(stepOfKey(childKey('step-3', 0))).toBe('step-3')
    expect(stepOfKey('step-4')).toBe('step-4')
  })
})
