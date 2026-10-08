import { describe, expect, it } from 'vitest'
import {
  FIND_LIMIT,
  findCount,
  findKey,
  findMatches,
  matchesByLine,
  searchable,
  splitLine,
  stepMatch
} from './bodyFind.js'

const lines = ['{', '  "name": "Ada",', '  "email": "ada@example.test"', '}']

describe('finding text in a response body', () => {
  it('finds every match, line by line, in any case', () => {
    expect(findMatches(lines, 'ada', false)).toEqual({
      matches: [
        { line: 1, start: 11, end: 14 },
        { line: 2, start: 12, end: 15 }
      ],
      capped: false
    })
  })

  it('matches case only when asked', () => {
    expect(findMatches(lines, 'Ada', true).matches).toEqual([{ line: 1, start: 11, end: 14 }])
    expect(findMatches(lines, 'ADA', true).matches).toEqual([])
  })

  it('finds what is typed as written, never as a pattern', () => {
    expect(findMatches(['a.b', 'axb', '(x)', 'a\\b'], '.', false).matches).toEqual([
      { line: 0, start: 1, end: 2 }
    ])
    expect(findMatches(['a.b', '(x)', '[1]', '$5 ^'], '(x)', false).matches).toHaveLength(1)
    expect(findMatches(['[1]'], '[1]', false).matches).toHaveLength(1)
    expect(findMatches(['a\\b'], '\\', false).matches).toEqual([{ line: 0, start: 1, end: 2 }])
    expect(findMatches(['a-b'], '-', false).matches).toHaveLength(1)
  })

  it('never overlaps one match with the next', () => {
    expect(findMatches(['aaaa'], 'aa', false).matches).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 }
    ])
  })

  it('finds nothing for nothing typed, but spaces are looked for', () => {
    expect(findMatches(lines, '', false)).toEqual({ matches: [], capped: false })
    expect(findMatches(['a  b'], '  ', false).matches).toEqual([{ line: 0, start: 1, end: 3 }])
  })

  it('places a match where it is in the line as written, whatever lower case does to it', () => {
    // 'İ' lower-cases to two characters: lower-casing the line would put the match one late.
    expect(findMatches(['İstanbul ist'], 'ist', false).matches).toEqual([
      { line: 0, start: 9, end: 12 }
    ])
    expect(findMatches(['ÉCOLE école'], 'école', false).matches).toEqual([
      { line: 0, start: 0, end: 5 },
      { line: 0, start: 6, end: 11 }
    ])
  })

  it('stops counting at the limit, and says so', () => {
    const found = findMatches(['a'.repeat(FIND_LIMIT + 5)], 'a', false)
    expect(found.matches).toHaveLength(FIND_LIMIT)
    expect(found.capped).toBe(true)
    expect(findCount(found, 0)).toBe('1 of 10,000+')
  })

  it('says how many there are and which is current', () => {
    const found = findMatches(lines, 'a', false)
    expect(findCount(found, 2)).toBe(`3 of ${found.matches.length}`)
    expect(findCount(findMatches(lines, 'zzz', false), 0)).toBe('No results')
  })

  it('goes round from the last match to the first, and back', () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(0)
  })

  it('cuts a line at its matches, each knowing its place among all of them', () => {
    const found = findMatches(['ab ab', 'b', 'xab'], 'ab', false)
    const byLine = matchesByLine(found)
    expect([...byLine.keys()]).toEqual([0, 2])
    expect(splitLine('ab ab', byLine.get(0)!)).toEqual([
      { text: 'ab', index: 0 },
      { text: ' ', index: null },
      { text: 'ab', index: 1 }
    ])
    expect(splitLine('xab', byLine.get(2)!)).toEqual([
      { text: 'x', index: null },
      { text: 'ab', index: 2 }
    ])
  })

  it('looks only in a body that is text', () => {
    expect(searchable({ bodyKind: 'json' })).toBe(true)
    expect(searchable({ bodyKind: 'text' })).toBe(true)
    expect(searchable({ bodyKind: 'empty' })).toBe(false)
    expect(searchable({ bodyKind: 'binary', bodyEncoding: 'base64' })).toBe(false)
  })
})

describe('the keys for finding', () => {
  const key = (
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}
  ) =>
    findKey({
      key,
      metaKey: mods.meta ?? false,
      ctrlKey: mods.ctrl ?? false,
      shiftKey: mods.shift ?? false,
      altKey: mods.alt ?? false
    })

  it('opens on ⌘F or Ctrl+F', () => {
    expect(key('f', { meta: true })).toBe('open')
    expect(key('f', { ctrl: true })).toBe('open')
    expect(key('F', { ctrl: true })).toBe('open')
    expect(key('f')).toBe(null)
    expect(key('f', { meta: true, shift: true })).toBe(null)
    expect(key('f', { meta: true, alt: true })).toBe(null)
  })

  it('goes on with ⌘G, Ctrl+G or F3, and back with Shift', () => {
    expect(key('g', { meta: true })).toBe('next')
    expect(key('g', { ctrl: true })).toBe('next')
    expect(key('G', { meta: true, shift: true })).toBe('previous')
    expect(key('F3')).toBe('next')
    expect(key('F3', { shift: true })).toBe('previous')
    expect(key('g')).toBe(null)
    expect(key('F3', { meta: true })).toBe(null)
  })
})
