import { describe, expect, it } from 'vitest'
import type { AssertionResult } from '@schwabyio/gravity-core/model'
import { checkLines, madeIn } from './checkLines.js'

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
      { line: 1, status: 'pass', title: '✓ Status is 201', failures: [], about: [0] },
      {
        line: 3,
        status: 'fail',
        title: '✕ status is "pending"',
        failures: ['Expected "pending", got "new"'],
        about: [1]
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
      failures: ['b: Expected is 1, actual 2', 'c: Failed'],
      about: [0, 1, 2]
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
      { line: 1, status: 'ignored', title: '– subAccounts ignored', failures: [], about: [] },
      {
        line: 2,
        status: 'pass',
        title: '✓ id.value is "a"\n– extra ignored',
        failures: [],
        about: [0]
      }
    ])
  })

  it('marks a check file by its own lines, and its caller by the calling line', () => {
    const fromFile = made('id is 7', 'pass', 2, {
      source: { script: 'step', line: 2, check: { file: 'checks/common.js', line: 3 } }
    })
    expect(checkLines([fromFile], { file: 'checks/common.js' }).map((l) => l.line)).toEqual([3])
    expect(checkLines([fromFile], 'step').map((l) => l.line)).toEqual([2])
    expect(madeIn([fromFile], { file: 'checks/other.js' })).toEqual([])
  })

  it('leaves out checks other scripts made, and those no line made', () => {
    const lines = checkLines(
      [
        made('from the collection', 'pass', 1, { source: { script: 'collection', line: 1 } }),
        { name: 'Strict: every body property is asserted', status: 'pass', target: 'strict' },
        made('mine', 'pass', 2)
      ],
      'step'
    )
    expect(lines.map((line) => line.line)).toEqual([2])
    // Each check by its place among all the run's, not among the script's own.
    expect(lines[0]!.about).toEqual([2])
  })
})
