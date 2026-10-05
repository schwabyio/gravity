import { describe, expect, it } from 'vitest'
import { formatMs, formatSize } from './format.js'

describe('format', () => {
  it('shows a duration in ms under a second, and in seconds from one', () => {
    expect(formatMs(0)).toBe('0 ms')
    expect(formatMs(84.4)).toBe('84 ms')
    expect(formatMs(999.4)).toBe('999 ms')
    expect(formatMs(1000)).toBe('1.00 s')
    expect(formatMs(1204)).toBe('1.20 s')
  })

  it('shows a size in bytes under a kilobyte, and in KB from one', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1260)).toBe('1.2 KB')
  })
})
