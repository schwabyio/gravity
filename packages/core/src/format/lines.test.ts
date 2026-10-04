import { describe, expect, it } from 'vitest'
import { sourceLine } from './lines.js'

const SOURCE = [
  'id: orders', // 1
  'tests: |', // 2
  '  gta.expectResponseStatusCodeToBe(200)', // 3
  '  gta.expectResponseToHaveHeader("x")', // 4
  'setup:', // 5
  '  - name: grant', // 6
  '    POST: http://x/grant', // 7
  'steps:', // 8
  '  # the first', // 9
  '  - name: list', // 10
  '    GET: http://x/list', // 11
  '    before:', // 12
  '      script: |', // 13
  "        gta.set('a', 1)", // 14
  "        gta.set('b', 2)", // 15
  '    tests: gta.expectResponseStatusCodeToBe(200)', // 16
  '  - name: get', // 17
  '    GET: http://x/get', // 18
  ''
].join('\n')

describe('sourceLine', () => {
  it('finds a step by its list and index, comments before it notwithstanding', () => {
    expect(sourceLine(SOURCE, { step: { list: 'steps', index: 0 } })).toBe(10)
    expect(sourceLine(SOURCE, { step: { list: 'steps', index: 1 } })).toBe(17)
    expect(sourceLine(SOURCE, { step: { list: 'setup', index: 0 } })).toBe(6)
  })

  it('finds a step’s script, a block’s text a line under its key, a one-liner on it', () => {
    const step = { list: 'steps' as const, index: 0 }
    expect(sourceLine(SOURCE, { step, script: 'pre-request' })).toBe(14)
    expect(sourceLine(SOURCE, { step, script: 'pre-request', scriptLine: 2 })).toBe(15)
    expect(sourceLine(SOURCE, { step, script: 'tests' })).toBe(16)
  })

  it('finds the file’s own script, and a line of it', () => {
    expect(sourceLine(SOURCE, { script: 'tests', scriptLine: 2 })).toBe(4)
  })

  it('falls back to the step for a script it has not, and to nothing for a step not there', () => {
    expect(sourceLine(SOURCE, { step: { list: 'steps', index: 1 }, script: 'tests' })).toBe(17)
    expect(sourceLine(SOURCE, { step: { list: 'steps', index: 9 } })).toBeUndefined()
    expect(sourceLine(SOURCE, { script: 'pre-request' })).toBe(1)
  })
})
