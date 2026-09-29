import { resultName, type RunResult } from '@schwabyio/gravity-core'
import { allSkipped, iterationName, type JobOutcome } from './job.js'
import type { RunTarget } from './select.js'
import { stepCountOf } from './select.js'

/** ANSI colour, or none: off when output is not a terminal, or `NO_COLOR` is set. */
export interface Paint {
  red(text: string): string
  green(text: string): string
  cyan(text: string): string
  yellow(text: string): string
  dim(text: string): string
  bold(text: string): string
}

export function paint(enabled: boolean): Paint {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text
  return {
    red: wrap(31, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
    yellow: wrap(33, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22)
  }
}

export function colorWanted(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>
): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  return stream.isTTY === true
}

/** One collection's counts, whether it ran or not. */
export interface CollectionTally {
  id: string
  passed: boolean
  durationMs: number
  steps: { total: number; passed: number; failed: number; errored: number; skipped: number }
  assertions: { total: number; passed: number; failed: number }
  /** Every step was skipped by a feature flag: it neither passed nor failed. */
  skipped: boolean
  /** Why the collection could not run at all. */
  error: string | null
  /** Every step that did not pass, for the failure details. */
  problems: RunResult[]
}

export function tally(target: RunTarget, outcome: JobOutcome, durationMs: number): CollectionTally {
  if (!outcome.ok) {
    const total = stepCountOf(target)
    return {
      id: target.id,
      passed: false,
      durationMs,
      steps: { total, passed: 0, failed: 0, errored: 0, skipped: total },
      assertions: { total: 0, passed: 0, failed: 0 },
      skipped: false,
      error: outcome.message,
      problems: []
    }
  }
  const { summary } = outcome
  const assertions = summary.results.flatMap((r) => r.assertions)
  const failed = assertions.filter((a) => a.status === 'fail').length
  return {
    id: target.id,
    passed: summary.failed === 0 && summary.errored === 0,
    durationMs,
    steps: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errored: summary.errored,
      skipped: summary.skipped
    },
    assertions: { total: assertions.length, passed: assertions.length - failed, failed },
    skipped: allSkipped(summary),
    error: null,
    // Named for the row they ran with, when a data file drove the collection.
    problems: summary.results.flatMap((r, i) =>
      r.status === 'fail' || r.status === 'error'
        ? [{ ...r, item: { ...r.item, name: iterationName(resultName(r), outcome.steps[i]) } }]
        : []
    )
  }
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

export const rule = (p: Paint, width = 100): string => p.dim('─'.repeat(width))

/** `label:` padded so a block of them lines up. */
export const field = (label: string, value: string, width = 14): string =>
  `${`${label}:`.padEnd(width)}${value}`

const NUMBER_COLUMNS = [
  ['Time', 9],
  ['Steps', 6],
  ['Pass', 5],
  ['Fail', 5],
  ['Error', 6],
  ['Skip', 5],
  ['Asserts', 8],
  ['Pass', 5],
  ['Fail', 5]
] as const

export const nameWidthFor = (ids: readonly string[]): number =>
  Math.min(80, Math.max('Collection'.length, ...ids.map((id) => id.length)))

/** How wide the results table is, for a name column this wide. */
export const tableWidth = (nameWidth: number): number =>
  4 +
  2 +
  nameWidth +
  1 +
  NUMBER_COLUMNS.reduce((n, [, w]) => n + w + 1, 0) -
  1 +
  2 +
  'passed'.length

export function tableHeader(nameWidth: number, p: Paint): string {
  const cells = NUMBER_COLUMNS.map(([label, width]) => label.padStart(width))
  return p.bold(`${'#'.padStart(4)}  ${'Collection'.padEnd(nameWidth)} ${cells.join(' ')}  Result`)
}

/** A collection id cut or padded to its column. */
export const nameCell = (id: string, width: number): string =>
  id.length > width ? `${id.slice(0, width - 1)}…` : id.padEnd(width)

export function tableRow(n: number, t: CollectionTally, nameWidth: number, p: Paint): string {
  const name = nameCell(t.id, nameWidth)
  const values = [
    seconds(t.durationMs),
    t.steps.total,
    t.steps.passed,
    t.steps.failed,
    t.steps.errored,
    t.steps.skipped,
    t.assertions.total,
    t.assertions.passed,
    t.assertions.failed
  ]
  const cells = values.map((value, i) => String(value).padStart(NUMBER_COLUMNS[i]![1]))
  const result = t.skipped ? p.cyan('skipped') : t.passed ? p.green('passed') : p.red('failed')
  return `${String(n).padStart(4)}  ${name} ${cells.join(' ')}  ${result}`
}

const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text

/** What went wrong in each failed collection, step by step. */
export function failureDetails(tallies: readonly CollectionTally[], p: Paint): string[] {
  const lines: string[] = []
  for (const t of tallies) {
    if (t.passed) continue
    lines.push(p.bold(t.id))
    if (t.error) lines.push(`  ${p.red('✗')} ${t.error}`)
    for (const result of t.problems) {
      const where = result.use
        ? ` ${p.dim(`(${result.use.set} ${result.use.child + 1}/${result.use.of})`)}`
        : ''
      const status = result.response ? ` ${p.dim(String(result.response.status))}` : ''
      lines.push(`  ${p.red('✗')} ${result.item.name}${where}${status}`)
      if (result.error) {
        const { phase, script, line, message } = result.error
        const at = [script && `${script} script`, line && `line ${line}`].filter(Boolean).join(', ')
        lines.push(`      ${p.red(`${phase} error${at ? ` (${at})` : ''}:`)} ${clip(message)}`)
      }
      for (const assertion of result.assertions) {
        if (assertion.status !== 'fail') continue
        const message = assertion.message ? `: ${assertion.message}` : ''
        lines.push(`      ${assertion.name}${message}`)
        if (assertion.expected !== undefined) {
          lines.push(`        ${p.dim('expected')} ${clip(assertion.expected)}`)
        }
        if (assertion.actual !== undefined) {
          lines.push(`        ${p.dim('actual  ')} ${clip(assertion.actual)}`)
        }
        if (assertion.unasserted?.length) {
          lines.push(`        ${p.dim('not asserted')} ${clip(assertion.unasserted.join(', '))}`)
        }
      }
    }
    lines.push('')
  }
  return lines
}

export interface RunTotals {
  collections: { total: number; passed: number; failed: number }
  steps: CollectionTally['steps']
  assertions: CollectionTally['assertions']
}

export function totalsOf(tallies: readonly CollectionTally[]): RunTotals {
  const sum = (pick: (t: CollectionTally) => number) => tallies.reduce((n, t) => n + pick(t), 0)
  return {
    collections: {
      total: tallies.length,
      passed: tallies.filter((t) => t.passed).length,
      failed: tallies.filter((t) => !t.passed).length
    },
    steps: {
      total: sum((t) => t.steps.total),
      passed: sum((t) => t.steps.passed),
      failed: sum((t) => t.steps.failed),
      errored: sum((t) => t.steps.errored),
      skipped: sum((t) => t.steps.skipped)
    },
    assertions: {
      total: sum((t) => t.assertions.total),
      passed: sum((t) => t.assertions.passed),
      failed: sum((t) => t.assertions.failed)
    }
  }
}

export function summary(totals: RunTotals, durationMs: number, p: Paint): string[] {
  const { collections: c, steps: s, assertions: a } = totals
  const passed = c.failed === 0
  return [
    field('Collections', `${c.total} total, ${c.passed} passed, ${c.failed} failed`),
    field(
      'Steps',
      `${s.total} total, ${s.passed} passed, ${s.failed} failed, ${s.errored} errored, ${s.skipped} skipped`
    ),
    field('Assertions', `${a.total} total, ${a.passed} passed, ${a.failed} failed`),
    field('Run time', seconds(durationMs)),
    field('Result', passed ? p.green(p.bold('PASSED')) : p.red(p.bold('FAILED')))
  ]
}
