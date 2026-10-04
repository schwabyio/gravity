import { describe, expect, it } from 'vitest'
import type { AssertionResult } from '@schwabyio/gravity-core/model'
import { checkLines } from './checkLines.js'

const made = (
  name: string,
  status: 'pass' | 'fail',
  line: number,
  more: Partial<AssertionResult> = {}
): AssertionResult => ({ name, status, source: { script: 'step', line }, ...more })

describe('checkLines', () => {
  it('marks each line its checks were made on, a failure with what it said', () => {
    expect(
      checkLines(
        [
          made('Status is 201', 'pass', 1),
          made('status is "pending"', 'fail', 3, { message: 'Expected "pending", got "new"' })
        ],
        'step'
      )
    ).toEqual([
      { line: 1, status: 'pass', title: '✓ Status is 201', failures: [] },
      {
        line: 3,
        status: 'fail',
        title: '✕ status is "pending"',
        failures: ['Expected "pending", got "new"']
      }
    ])
  })

  it('puts the checks one line made together, any failure failing it', () => {
    const [line] = checkLines(
      [
        made('a', 'pass', 4),
        made('b', 'fail', 4, { expected: 'is 1', actual: '2' }),
        made('c', 'fail', 4)
      ],
      'step'
    )
    expect(line).toEqual({
      line: 4,
      status: 'fail',
      title: '1 of 3 checks passed\n✓ a\n✕ b\n✕ c',
      failures: ['b: Expected is 1, actual 2', 'c: Failed']
    })
  })

  it('marks a line that only ignored a property as ignored, a check on it winning', () => {
    expect(
      checkLines([made('id.value is "a"', 'pass', 2)], 'step', [
        { path: 'subAccounts', source: { script: 'step', line: 1 } },
        { path: 'extra', source: { script: 'step', line: 2 } },
        { path: 'theirs', source: { script: 'collection', line: 1 } }
      ])
    ).toEqual([
      { line: 1, status: 'ignored', title: '– subAccounts ignored', failures: [] },
      { line: 2, status: 'pass', title: '✓ id.value is "a"\n– extra ignored', failures: [] }
    ])
  })

  it('leaves out checks other scripts made, and those no line made', () => {
    expect(
      checkLines(
        [
          made('from the collection', 'pass', 1, { source: { script: 'collection', line: 1 } }),
          { name: 'Strict: every body property is asserted', status: 'pass', target: 'strict' },
          made('mine', 'pass', 2)
        ],
        'step'
      ).map((line) => line.line)
    ).toEqual([2])
  })
})
