import { describe, expect, it } from 'vitest'
import { fitShare } from './usePaneWidth.js'

describe('fitShare', () => {
  it('keeps a share that leaves both panes their least', () => {
    expect(fitShare(0.5, 800, 240)).toBe(0.5)
    expect(fitShare(0.6, 800, 240)).toBe(0.6)
  })

  it('stops a pane short of crowding out the other', () => {
    expect(fitShare(0.9, 800, 240)).toBe(0.7)
    expect(fitShare(0.1, 800, 240)).toBe(0.3)
  })

  it('splits evenly when there is not room for both at their least', () => {
    expect(fitShare(0.8, 400, 240)).toBe(0.5)
  })
})
