import type { AssertionResult, IgnoredPath, ScriptOwner } from '@schwabyio/gravity-core/model'

/**
 * One line of a tests script, as its last run checked it: a ✓ when every
 * check made there passed, a ✕ when any failed, with what the failed ones
 * said to show under it; a – where it only ignored a property for strict
 * validation. Pure, so the editor and its tests agree.
 */
export interface CheckLine {
  /** 1-based, in the script. */
  line: number
  status: 'pass' | 'fail' | 'ignored'
  /** The checks made there, and what it ignored, said in full for hover. */
  title: string
  /** What each failed check said. */
  failures: string[]
}

/** What a failed check says, as the results list would: its message, or what it wanted. */
const failureOf = (assertion: AssertionResult): string =>
  assertion.message ??
  (assertion.expected !== undefined
    ? `Expected ${assertion.expected}, actual ${assertion.actual ?? 'not present'}`
    : 'Failed')

/** The lines of `script`'s tests the run's checks were made on, or ignored a path on, in order. */
export function checkLines(
  assertions: AssertionResult[],
  script: ScriptOwner,
  ignored: IgnoredPath[] = []
): CheckLine[] {
  const byLine = new Map<number, { made: AssertionResult[]; paths: string[] }>()
  const at = (line: number) => {
    let entry = byLine.get(line)
    if (!entry) byLine.set(line, (entry = { made: [], paths: [] }))
    return entry
  }
  for (const assertion of assertions) {
    if (assertion.source?.script === script) at(assertion.source.line).made.push(assertion)
  }
  for (const entry of ignored) {
    if (entry.source?.script === script) at(entry.source.line).paths.push(entry.path)
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, { made, paths }]) => {
      const failed = made.filter((assertion) => assertion.status === 'fail')
      const passed = made.length - failed.length
      const names = [
        ...made.map((assertion) => `${assertion.status === 'pass' ? '✓' : '✕'} ${assertion.name}`),
        ...paths.map((path) => `– ${path} ignored`)
      ]
      return {
        line,
        // A check's verdict over an ignore: only a line that checked nothing is marked ignored.
        status: failed.length > 0 ? 'fail' : made.length > 0 ? 'pass' : 'ignored',
        title:
          made.length <= 1
            ? names.join('\n')
            : [`${passed} of ${made.length} checks passed`, ...names].join('\n'),
        // One failure speaks for itself; several say which is which.
        failures: failed.map((assertion) =>
          failed.length === 1 ? failureOf(assertion) : `${assertion.name}: ${failureOf(assertion)}`
        )
      }
    })
}
