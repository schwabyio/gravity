import type { RunResult } from '@schwabyio/gravity-core/model'
import { formatMs } from './format.js'

/**
 * What a step's last run came to, as its row shows it, on one line where it
 * can: its status and time beside an icon — passed, failed, error, skipped,
 * running — with how many checks passed on hover. Only what that line cannot
 * hold, an error's message or a skip's reason, goes on a line under the name.
 * Pure, so the step list and its tests agree.
 */
export type StepMark = 'pass' | 'fail' | 'error' | 'skipped' | 'running'

/** What hovering a step's result says: a heading, then a line for each thing to know. */
export interface StepHover {
  title: string
  lines: string[]
}

export interface StepOutcome {
  /** Null before it has run, with no tests to pass, or while only some of its requests have. */
  mark: StepMark | null
  /** Beside the mark: the status and time, an error's code, or how many passed. */
  summary: string | null
  /** The line under the name, for what the summary cannot hold; null with nothing to say. */
  detail: string | null
  hover: StepHover | null
}

export const MARK_GLYPHS: Record<StepMark, string> = {
  pass: '✓',
  fail: '✕',
  error: '!',
  skipped: '⊘',
  running: ''
}

export const MARK_NAMES: Record<StepMark, string> = {
  pass: 'passed',
  fail: 'failed',
  error: 'error',
  skipped: 'skipped',
  running: 'running'
}

/** How many failed checks a hover names before it says how many more. */
const NAMED = 5

const NONE: StepOutcome = { mark: null, summary: null, detail: null, hover: null }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** One request's result. */
function single(result: RunResult): StepOutcome {
  const summary = result.response
    ? `${result.response.status} · ${formatMs(result.durationMs)}`
    : null
  const checks = result.assertions
  const failed = checks.filter((a) => a.status === 'fail')
  const message = result.error?.message
  switch (result.status) {
    case 'pass':
      // With nothing checked, there is nothing to have passed.
      return checks.length === 0
        ? {
            mark: null,
            summary: summary ?? formatMs(result.durationMs),
            detail: null,
            hover: { title: 'No checks', lines: ['This step has no tests.'] }
          }
        : {
            mark: 'pass',
            summary: summary ?? formatMs(result.durationMs),
            detail: null,
            hover: {
              title: checks.length === 1 ? '1 check passed' : `All ${checks.length} checks passed`,
              lines: []
            }
          }
    case 'fail': {
      const named = failed.slice(0, NAMED).map((a) => `✕ ${a.name}`)
      const more = failed.length - named.length
      return {
        mark: 'fail',
        summary: summary ?? formatMs(result.durationMs),
        detail: null,
        hover: {
          title: `${failed.length} of ${plural(checks.length, 'check')} failed`,
          lines: more > 0 ? [...named, `and ${more} more`] : named
        }
      }
    }
    case 'skipped': {
      const reason = result.skipped?.reason
      return {
        mark: 'skipped',
        summary: null,
        detail: reason ? `skipped: ${reason}` : 'skipped',
        hover: { title: 'Skipped, nothing was sent', lines: reason ? [reason] : [] }
      }
    }
    default: {
      // Under the name, where it has room: in a word for a request never answered.
      const code = result.error?.phase === 'http' ? result.error.code : undefined
      return {
        mark: 'error',
        summary,
        detail: code ?? message ?? 'error',
        hover: {
          title: summary ? 'Error after the response' : 'No response',
          lines: message ? [message] : []
        }
      }
    }
  }
}

/**
 * Several results for one step — a use step's requests, a `forEach` step's
 * items — counted: an error outranks a failure, and only all of them passing
 * is a pass.
 */
function counted(results: RunResult[], expected: number, of: string): StepOutcome {
  const tally = (status: RunResult['status']) => results.filter((r) => r.status === status).length
  const passed = tally('pass')
  const summary = `${passed} of ${expected} passed`
  const lines = [
    ...(tally('fail') > 0 ? [`${tally('fail')} failed`] : []),
    ...(tally('error') > 0 ? [`${tally('error')} with an error`] : []),
    ...(tally('skipped') > 0 ? [`${tally('skipped')} skipped`] : []),
    ...(results.length < expected ? [`${expected - results.length} not run`] : [])
  ]
  const done = results.length === expected
  // As for one request: with nothing checked in any of them, nothing passed.
  const checked = results.some((r) => r.assertions.length > 0)
  const mark: StepMark | null =
    tally('error') > 0
      ? 'error'
      : tally('fail') > 0
        ? 'fail'
        : done && tally('skipped') === expected
          ? 'skipped'
          : done && checked
            ? 'pass'
            : null
  const title = `${passed} of ${plural(expected, of)} passed`
  const hover =
    done && !checked && mark === null
      ? { title, lines: [...lines, 'No checks: none of them has tests.'] }
      : { title, lines }
  return { mark, summary, detail: null, hover }
}

export function stepOutcome(input: {
  running: boolean
  /** The step's own result; for a use step, only a reason it could not run. */
  result?: RunResult
  /** A use step's requests, or a `forEach` step's items, that have reported. */
  parts: RunResult[]
  /** How many there are to report. */
  expected: number
  /** What the parts are, for the hover: `request` or `item`. */
  partsAre?: string
}): StepOutcome {
  if (input.running) return { ...NONE, mark: 'running' }
  if (input.parts.length > 0) {
    return counted(input.parts, input.expected, input.partsAre ?? 'request')
  }
  return input.result ? single(input.result) : NONE
}
