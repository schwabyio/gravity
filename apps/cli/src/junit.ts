import os from 'node:os'
import { resultName, type AssertionResult, type RunResult } from '@schwabyio/gravity-core'
import { iterationName, unattempted, type JobOutcome } from './job.js'

/**
 * The run as JUnit XML, for CI: one `<testsuite>` per collection, one
 * `<testcase>` per step that ran.
 *
 * One file for the whole run rather than one per collection, so a collection
 * that did not run this time can never leave a stale result behind for CI to
 * pick up.
 *
 * - A step whose checks failed has a `<failure>`, one line per failed check.
 * - A step that could not finish — a variable, a script, the network — has an
 *   `<error>`, typed by the phase that stopped it.
 * - Steps a bail left unrun are one skipped test case, so the counts add up.
 * - A collection that never ran (it will not parse, timed out, its worker
 *   died) is one test case with an `<error>` saying why.
 * - What a step's scripts logged is its `<system-out>`.
 */
export interface JUnitCollection {
  /** `checkout/sessions`. */
  id: string
  outcome: JobOutcome
  /** Epoch milliseconds the collection started. */
  startedAt: number
  durationMs: number
}

export interface JUnitRun {
  project: string
  environment: string | null
  /** The feature flag values the run used (SPEC.md §2.9). */
  flags?: Record<string, string | number | boolean>
  startedAt: number
  durationMs: number
  /** In the order they were selected, not the order they finished. */
  collections: readonly JUnitCollection[]
}

interface Counts {
  tests: number
  failures: number
  errors: number
  skipped: number
}

export function junitReport(run: JUnitRun): string {
  const suites = run.collections.map((collection) =>
    suite(collection, run.environment, run.flags ?? {})
  )
  const total = suites.reduce<Counts>(
    (sum, s) => ({
      tests: sum.tests + s.counts.tests,
      failures: sum.failures + s.counts.failures,
      errors: sum.errors + s.counts.errors,
      skipped: sum.skipped + s.counts.skipped
    }),
    { tests: 0, failures: 0, errors: 0, skipped: 0 }
  )
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites${attributes({
      name: `gta: ${run.project}`,
      ...total,
      time: seconds(run.durationMs),
      timestamp: timestamp(run.startedAt)
    })}>`,
    ...suites.flatMap((s) => s.lines),
    '</testsuites>',
    ''
  ].join('\n')
}

function suite(
  collection: JUnitCollection,
  environment: string | null,
  flags: Record<string, string | number | boolean>
): { counts: Counts; lines: string[] } {
  const cases: string[][] = []
  const counts: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 }
  const { outcome, id } = collection

  if (!outcome.ok) {
    counts.tests = 1
    counts.errors = 1
    cases.push(
      testcase(id, '(collection)', 0, [
        `<error${attributes({ message: outcome.message, type: 'collection' })}>${escape(outcome.message)}</error>`
      ])
    )
  } else {
    for (const [i, result] of outcome.summary.results.entries()) {
      counts.tests++
      const body: string[] = []
      if (result.status === 'error') {
        counts.errors++
        const { phase, message, stack } = result.error ?? {
          phase: 'http',
          message: 'no response',
          stack: undefined
        }
        body.push(
          `<error${attributes({ message: `${phase} error: ${message}`, type: phase })}>${escape(userFrames(stack) ?? message)}</error>`
        )
      } else if (result.status === 'fail') {
        counts.failures++
        const failed = result.assertions.filter((a) => a.status === 'fail')
        body.push(
          `<failure${attributes({
            message: failed.map(summarize).join('; '),
            type: 'assertion'
          })}>${escape(failed.map(describe).join('\n\n'))}</failure>`
        )
      } else if (result.status === 'skipped') {
        counts.skipped++
        body.push(
          result.skipped
            ? `<skipped${attributes({ message: result.skipped.reason })}/>`
            : '<skipped/>'
        )
      }
      if (result.logs?.length) {
        const logged = result.logs.map((log) => `[${log.phase} ${log.level}] ${log.message}`)
        body.push(`<system-out>${escape(logged.join('\n'))}</system-out>`)
      }
      cases.push(
        testcase(id, iterationName(caseName(result), outcome.steps[i]), result.durationMs, body)
      )
    }
    const unrun = unattempted(outcome.summary)
    if (unrun > 0) {
      counts.tests++
      counts.skipped++
      const message = `${unrun} step${unrun === 1 ? '' : 's'} not run: the collection stopped at its first failure (bail)`
      cases.push(testcase(id, '(not run)', 0, [`<skipped${attributes({ message })}/>`]))
    }
  }

  return {
    counts,
    lines: [
      `  <testsuite${attributes({
        name: id,
        ...counts,
        time: seconds(collection.durationMs),
        timestamp: timestamp(collection.startedAt),
        hostname: os.hostname()
      })}>`,
      '    <properties>',
      `      <property${attributes({ name: 'environment', value: environment ?? '' })}/>`,
      ...Object.entries(flags).map(
        ([name, value]) =>
          `      <property${attributes({ name: `flag.${name}`, value: String(value) })}/>`
      ),
      '    </properties>',
      ...cases.flat(),
      '  </testsuite>'
    ]
  }
}

function testcase(classname: string, name: string, durationMs: number, body: string[]): string[] {
  const open = `    <testcase${attributes({ name, classname, time: seconds(durationMs) })}`
  if (body.length === 0) return [`${open}/>`]
  return [`${open}>`, ...body.map((line) => `      ${line}`), '    </testcase>']
}

/** A step's name, and for a request a use step ran, which one of its set it was. */
const caseName = (result: RunResult): string =>
  result.use
    ? `${resultName(result)} [${result.use.set} ${result.use.child + 1}/${result.use.of}]`
    : result.item.name

const summarize = (a: AssertionResult): string => (a.message ? `${a.name}: ${a.message}` : a.name)

function describe(a: AssertionResult): string {
  const lines = [summarize(a)]
  if (a.expected !== undefined) lines.push(`  expected: ${a.expected}`)
  if (a.actual !== undefined) lines.push(`  actual:   ${a.actual}`)
  if (a.unasserted?.length) lines.push(`  not asserted: ${a.unasserted.join(', ')}`)
  return lines.join('\n')
}

/**
 * A script error's stack without gta's own frames: what is left is the user's
 * line, the caret under it, and the frames in their code.
 */
const userFrames = (stack: string | undefined): string | undefined =>
  stack
    ?.split('\n')
    .filter((line) => !/^\s+at .*(\bnode:|file:\/\/)/.test(line))
    .join('\n')

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

/** ISO 8601 without a zone or fraction, as the JUnit schema has it. */
const timestamp = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 19)

function attributes(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join('')
}

/** In an attribute a newline would read back as a space, so it is written as a reference. */
const escapeAttribute = (value: string): string =>
  escape(value)
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;')

/**
 * Escape for XML, dropping what XML 1.0 cannot hold at all: a response body or
 * a log line can carry control characters, and one of them makes the whole
 * file unreadable to CI.
 */
function escape(value: string): string {
  let kept = ''
  for (const char of value) if (allowedInXml(char.codePointAt(0)!)) kept += char
  return kept.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** XML 1.0's Char production; a lone surrogate half is left out too. */
const allowedInXml = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  code >= 0x10000
