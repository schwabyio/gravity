import { describe, expect, it } from 'vitest'
import { strftime } from './generators.js'
import { parseDotEnv } from './dotenv.js'

// A fixed instant: 2026-03-09T14:05:07.042Z, a Monday.
const AT = new Date(Date.UTC(2026, 2, 9, 14, 5, 7, 42))

describe('strftime', () => {
  it('formats the common date and time specifiers in UTC', () => {
    expect(strftime('%Y-%m-%d', AT, 'utc')).toBe('2026-03-09')
    expect(strftime('%H:%M:%S', AT, 'utc')).toBe('14:05:07')
    expect(strftime('%F %T', AT, 'utc')).toBe('2026-03-09 14:05:07')
    expect(strftime('%y', AT, 'utc')).toBe('26')
    expect(strftime('%L', AT, 'utc')).toBe('042')
  })

  it('formats names and 12-hour time', () => {
    expect(strftime('%B %b %A %a', AT, 'utc')).toBe('March Mar Monday Mon')
    expect(strftime('%I %p', AT, 'utc')).toBe('02 PM')
  })

  it('formats day of year, epoch and offset', () => {
    expect(strftime('%j', AT, 'utc')).toBe('068')
    expect(strftime('%s', AT, 'utc')).toBe(String(Math.floor(AT.getTime() / 1000)))
    expect(strftime('%z', AT, 'utc')).toBe('+0000')
  })

  it('honours an IANA timezone', () => {
    // 9 March 2026 is after the US DST change (8 March), so New York is on EDT
    // at UTC-4 and 14:05 UTC is 10:05 local.
    expect(strftime('%Y-%m-%d %H:%M', AT, 'America/New_York')).toBe('2026-03-09 10:05')
    expect(strftime('%z', AT, 'America/New_York')).toBe('-0400')
  })

  it('handles midnight without rolling the hour to 24', () => {
    const midnight = new Date(Date.UTC(2026, 2, 9, 0, 0, 0))
    expect(strftime('%H', midnight, 'utc')).toBe('00')
    expect(strftime('%I %p', midnight, 'utc')).toBe('12 AM')
  })

  it('escapes a literal percent', () => {
    expect(strftime('100%% sure', AT, 'utc')).toBe('100% sure')
  })

  it('leaves an unknown specifier visible rather than dropping it', () => {
    expect(strftime('%Q', AT, 'utc')).toBe('%Q')
  })
})

describe('parseDotEnv', () => {
  it('reads plain assignments', () => {
    expect(parseDotEnv('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' })
  })

  it('ignores comments and blank lines', () => {
    expect(parseDotEnv('# note\n\nA=1\n')).toEqual({ A: '1' })
  })

  it('strips quotes and honours escapes only inside double quotes', () => {
    expect(parseDotEnv('A="a b"\nB=\'c d\'\nC="line\\nbreak"\nD=\'no\\nescape\'\n')).toEqual({
      A: 'a b',
      B: 'c d',
      C: 'line\nbreak',
      D: 'no\\nescape'
    })
  })

  it('drops an inline comment from an unquoted value but keeps it inside quotes', () => {
    expect(parseDotEnv('A=value # note\nB="value # kept"\n')).toEqual({
      A: 'value',
      B: 'value # kept'
    })
  })

  it('accepts an export prefix and values containing equals signs', () => {
    expect(parseDotEnv('export TOKEN=abc=def\n')).toEqual({ TOKEN: 'abc=def' })
  })
})
