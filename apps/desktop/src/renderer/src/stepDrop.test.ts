import { describe, expect, it } from 'vitest'
import { movedTo } from './stepDrop.js'

describe('movedTo', () => {
  // Steps 0–3; each case drags one and drops it beside another.
  it('moves a step to the end, dropped after the last', () => {
    expect(movedTo(0, { index: 3, after: true })).toBe(3)
    expect(movedTo(1, { index: 3, after: true })).toBe(3)
  })

  it('moves a step to the start, dropped before the first', () => {
    expect(movedTo(3, { index: 0, after: false })).toBe(0)
  })

  it('lands between the same two steps either way it is dropped there', () => {
    // After step 1 and before step 2 are the same place.
    expect(movedTo(3, { index: 1, after: true })).toBe(2)
    expect(movedTo(3, { index: 2, after: false })).toBe(2)
    expect(movedTo(0, { index: 1, after: true })).toBe(1)
    expect(movedTo(0, { index: 2, after: false })).toBe(1)
  })

  it('stays put dropped beside itself', () => {
    expect(movedTo(2, { index: 2, after: false })).toBe(2)
    expect(movedTo(2, { index: 2, after: true })).toBe(2)
    expect(movedTo(2, { index: 1, after: true })).toBe(2)
    expect(movedTo(2, { index: 3, after: false })).toBe(2)
  })
})
