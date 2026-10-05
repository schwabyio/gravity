import { describe, expect, it } from 'vitest'
import type { Collection } from '@schwabyio/gravity-core/model'
import { conditionsState, showFlagValue, stepFlagState } from './flagState.js'

describe('stepFlagState', () => {
  const collection: Pick<Collection, 'flags' | 'steps'> = {
    flags: { area: 'checkout' },
    steps: [
      { GET: '/a', flags: { newCheckout: true } },
      { GET: '/b', flags: { newCheckout: false } },
      { GET: '/c' },
      { GET: '/d', flags: { typo: true } }
    ]
  }
  const values = { area: 'checkout', newCheckout: true }

  it('runs a step whose flags hold, and says why one is skipped', () => {
    expect(stepFlagState(collection, 0, values)).toBeNull()
    expect(stepFlagState(collection, 1, values)).toEqual({
      kind: 'skip',
      reason: 'feature flag newCheckout is on'
    })
    expect(stepFlagState(collection, 2, values)).toBeNull()
  })

  it('names a flag the values do not have as an error', () => {
    expect(stepFlagState(collection, 3, values)).toEqual({
      kind: 'error',
      message: expect.stringContaining('feature flag typo is not known')
    })
  })

  it('checks the collection’s conditions before the step’s', () => {
    expect(stepFlagState(collection, 0, { ...values, area: 'billing' })).toEqual({
      kind: 'skip',
      reason: 'feature flag area is billing, not checkout'
    })
    expect(conditionsState(undefined, null)).toBeNull()
  })
})

describe('flag values and conditions', () => {
  it('skips by the collection’s conditions before a step’s own', () => {
    const collection = { flags: { area: 'checkout' }, steps: [{ GET: '/a', flags: { v2: true } }] }
    expect(stepFlagState(collection, 0, { area: 'billing', v2: true })).toEqual({
      kind: 'skip',
      reason: expect.stringContaining('area')
    })
    expect(stepFlagState(collection, 5, { area: 'checkout', v2: true })).toBeNull()
  })

  it('throws what is not an unknown flag, rather than hiding it', () => {
    expect(() => conditionsState({ v2: true }, 'not values' as never)).toThrow()
  })

  it('shows a value as it is typed', () => {
    expect([showFlagValue(true), showFlagValue(2), showFlagValue('v2')]).toEqual([
      'true',
      '2',
      'v2'
    ])
  })
})
