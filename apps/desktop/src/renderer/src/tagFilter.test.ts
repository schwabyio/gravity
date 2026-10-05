import { describe, expect, it } from 'vitest'
import type { Collection } from '@schwabyio/gravity-core/model'
import { filterSteps, stepTagsIn } from './tagFilter.js'

const collection = (stepTags: boolean): Collection => ({
  stepTags,
  steps: [
    { name: 'a', GET: '/a', tags: ['smoke', 'slow'] },
    { name: 'b', GET: '/b' },
    { name: 'c', GET: '/c', tags: ['smoke'] }
  ]
})

describe('the step tag filter', () => {
  it('offers the steps’ tags, sorted and once each, only where steps carry tags', () => {
    expect(stepTagsIn(collection(true))).toEqual(['slow', 'smoke'])
    expect(stepTagsIn(collection(false))).toEqual([])
  })

  it('leaves the steps with any tag picked, and every step with none', () => {
    expect(filterSteps(collection(true), [])).toEqual({ active: [], indexes: [0, 1, 2] })
    expect(filterSteps(collection(true), ['smoke'])).toEqual({ active: ['smoke'], indexes: [0, 2] })
    expect(filterSteps(collection(true), ['slow', 'smoke'])).toEqual({
      active: ['slow', 'smoke'],
      indexes: [0, 2]
    })
  })

  it('drops a tag no step carries, rather than hiding every step', () => {
    expect(filterSteps(collection(true), ['gone'])).toEqual({ active: [], indexes: [0, 1, 2] })
    // Without step tags there is nothing to narrow by.
    expect(filterSteps(collection(false), ['smoke'])).toEqual({ active: [], indexes: [0, 1, 2] })
  })
})
