import { describe, expect, it } from 'vitest'
import { dropAtHeight, movedTo } from './stepDrop.js'

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

describe('dropAtHeight', () => {
  // Three rows 20 tall, the middle one hidden by a tag filter.
  const rows = [
    { index: 0, top: 0, bottom: 20 },
    { index: 2, top: 20, bottom: 40 },
    { index: 3, top: 40, bottom: 60 }
  ]

  it('drops before a row from its top half, after it from its bottom half', () => {
    expect(dropAtHeight(rows, 25)).toEqual({ index: 2, after: false })
    expect(dropAtHeight(rows, 35)).toEqual({ index: 2, after: true })
  })

  it('drops after the last row from anywhere below it', () => {
    expect(dropAtHeight(rows, 55)).toEqual({ index: 3, after: true })
    expect(dropAtHeight(rows, 61)).toEqual({ index: 3, after: true })
    expect(dropAtHeight(rows, 400)).toEqual({ index: 3, after: true })
  })

  it('drops before the first row from above it', () => {
    expect(dropAtHeight(rows, -4)).toEqual({ index: 0, after: false })
  })

  it('has nowhere to drop with no rows shown', () => {
    expect(dropAtHeight([], 10)).toBeNull()
  })
})
