import type { RunResult } from '@schwabyio/gravity-core/model'

/**
 * What the Pre-request and Tests tabs say beside their names: what each
 * script holds before a run — `1 line`, `3 checks` — and how it went after
 * one — `✓ 3`, `✕ 1 of 3`, `!`. Pure, so the tabs and their tests agree.
 */
export interface ScriptChip {
  text: string
  tone: 'idle' | 'pass' | 'fail' | 'error'
  /** Said in full, on hover and to screen readers. */
  title: string
}

/** The checks a tests script makes, by its `gta.expect…` and `gta.test` calls. */
export function countChecks(script: string): number {
  return script.match(/\bgta\.(?:expect\w*|test)\s*\(/g)?.length ?? 0
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * The Tests tab's chip. `inherited` is whether a layer around the step —
 * its endpoint base, base collection or collection — has tests, which make
 * checks of their own though the step's script is empty.
 */
export function testsChip(
  script: string,
  result: RunResult | null,
  inherited = false
): ScriptChip | null {
  const written = script.trim() !== ''
  if (result) {
    if (result.error?.phase === 'tests') {
      return { text: '!', tone: 'error', title: 'The tests stopped with an error' }
    }
    // Nothing came back, so nothing was checked.
    if (!result.response) {
      return written ? { text: 'not run', tone: 'idle', title: 'The tests did not run' } : null
    }
    const checks = result.assertions
    const failed = checks.filter((a) => a.status === 'fail').length
    if (failed > 0) {
      return {
        text: `✕ ${failed} of ${checks.length}`,
        tone: 'fail',
        title: `${failed} of ${plural(checks.length, 'check')} failed`
      }
    }
    if (checks.length > 0) {
      return {
        text: `✓ ${checks.length}`,
        tone: 'pass',
        title: checks.length === 1 ? '1 check passed' : `All ${checks.length} checks passed`
      }
    }
  }
  const count = countChecks(script)
  if (count > 0)
    return { text: plural(count, 'check'), tone: 'idle', title: plural(count, 'check') }
  if (written || inherited) return null
  return { text: 'none', tone: 'idle', title: 'This step has no tests' }
}

/** The Pre-request tab's chip. */
export function preRequestChip(script: string, result: RunResult | null): ScriptChip | null {
  if (result?.error?.phase === 'pre-request') {
    return { text: '!', tone: 'error', title: 'The pre-request script stopped with an error' }
  }
  if (script.trim() === '') return null
  if (result && result.status !== 'skipped') {
    return { text: '✓', tone: 'pass', title: 'The pre-request script ran' }
  }
  const lines = script.split('\n').filter((line) => line.trim() !== '').length
  return { text: plural(lines, 'line'), tone: 'idle', title: plural(lines, 'line') }
}
