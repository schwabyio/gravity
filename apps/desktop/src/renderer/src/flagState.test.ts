import { describe, expect, it } from 'vitest'
import type { Collection } from '@schwabyio/gravity-core/model'
import { conditionsState, stepFlagState } from './flagState.js'

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
