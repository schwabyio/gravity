import { describe, expect, it } from 'vitest'
import type { Collection } from '@schwabyio/gravity-core/model'
import { filterSteps, stepsToRunAll, stepTagsIn } from './tagFilter.js'

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

describe('what Run all runs', () => {
  const withExcluded: Collection = {
    stepTags: true,
    steps: [
      { name: 'a', GET: '/a', tags: ['smoke'] },
      { name: 'b', GET: '/b', exclude: true },
      { name: 'c', GET: '/c', tags: ['smoke'], exclude: true },
      { name: 'd', GET: '/d', exclude: false }
    ]
  }

  it('leaves out the steps excluded from group runs, and counts them', () => {
    expect(stepsToRunAll(withExcluded, [])).toEqual({ indexes: [0, 3], excluded: 2 })
    expect(stepsToRunAll(collection(true), [])).toEqual({ indexes: [0, 1, 2], excluded: 0 })
  })

  it('counts only the excluded steps the tag filter shows', () => {
    expect(stepsToRunAll(withExcluded, ['smoke'])).toEqual({ indexes: [0], excluded: 1 })
  })

  it('runs nothing when every step it would run is excluded', () => {
    const allOut: Collection = { steps: [{ GET: '/a', exclude: true }] }
    expect(stepsToRunAll(allOut, [])).toEqual({ indexes: [], excluded: 1 })
  })
})
