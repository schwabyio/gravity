import {
  TESTS_ALLOWANCES,
  testsScriptFindings,
  type ScriptFinding,
  type TestsAllowance
} from '@schwabyio/gravity-core'

/**
 * What a tests script calls that `tests.only` does not allow (SPEC.md §1.4),
 * for the Tests editor to flag as it is typed. Both come from the renderer, so
 * anything that is not a script and a list naming `gta` checks nothing.
 */
export function scriptRuleFindings(code: unknown, allowed: unknown): ScriptFinding[] {
  const list = Array.isArray(allowed)
    ? allowed.filter((entry): entry is TestsAllowance =>
        (TESTS_ALLOWANCES as readonly unknown[]).includes(entry)
      )
    : []
  return typeof code === 'string' && list.includes('gta') ? testsScriptFindings(code, list) : []
}
