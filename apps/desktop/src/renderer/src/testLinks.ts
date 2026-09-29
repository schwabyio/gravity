import {
  bodyAsObject,
  parsePath,
  pathMatches,
  sortArraysBy,
  toJsonLines,
  type AssertionResult,
  type HeaderEntry,
  type PathSegment,
  type ReceivedResponse
} from '@schwabyio/gravity-core/model'

/**
 * How assertions and the response they were checked against find each other.
 *
 * The response tabs and the Test Results pane are separate components; this is the
 * shared, pure part: which body lines and which headers each assertion is about,
 * and how each of those lines is marked.
 */

export type Mark = 'pass' | 'fail' | 'unasserted'

export interface Check {
  index: number
  assertion: AssertionResult
  /** Body paths this check is about, as patterns over the body's lines. */
  patterns: PathSegment[][]
}

export function buildChecks(assertions: AssertionResult[]): Check[] {
  return assertions.map((assertion, index) => ({
    index,
    assertion,
    patterns:
      assertion.target === 'body' && assertion.path !== undefined
        ? [parsePath(assertion.path)]
        : assertion.target === 'strict'
          ? (assertion.unasserted ?? []).map(parsePath)
          : []
  }))
}

export interface BodyLine {
  text: string
  path: PathSegment[]
}

export type CheckedBody = { ok: true; lines: BodyLine[] } | { ok: false; message: string }

/**
 * The body as the engine checked it, one line per entry.
 *
 * Structured bodies are the parsed object pretty-printed, after XML conversion
 * and `gta.sortResponseBodyArrays`, so an asserted path is always a real line. Text is shown
 * as written, every line belonging to the single `plaintext` property.
 */
export function checkedBody(
  response: Pick<ReceivedResponse, 'body' | 'bodyKind'>,
  sortedBy: string[] | undefined
): CheckedBody {
  if (response.bodyKind === 'text' || response.bodyKind === 'html') {
    const path: PathSegment[] = [{ kind: 'key', key: 'plaintext' }]
    return { ok: true, lines: response.body.split('\n').map((text) => ({ text, path })) }
  }
  if (response.bodyKind === 'empty') return { ok: false, message: 'No response body.' }
  const parsed = bodyAsObject(response)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const value = sortedBy ? sortArraysBy(parsed.body, sortedBy) : parsed.body
  return { ok: true, lines: toJsonLines(value) }
}

/**
 * Whether "as checked" differs from what the server sent, so the Body tab
 * should offer both. Only conversion and sorting change what is shown.
 */
export const checkedDiffersFromRaw = (
  response: Pick<ReceivedResponse, 'bodyKind'>,
  sortedBy: string[] | undefined
): boolean => response.bodyKind === 'xml' || (sortedBy !== undefined && sortedBy.length > 0)

export interface Marked {
  /** Indexes of the checks about this line or row. */
  about: number[]
  mark: Mark | null
}

function markOf(about: Check[]): Mark | null {
  let mark: Mark | null = null
  for (const check of about) {
    if (check.assertion.target === 'strict') mark ??= 'unasserted'
    else if (check.assertion.status === 'fail') mark = 'fail'
    else if (mark !== 'fail') mark = 'pass'
  }
  return mark
}

/** An assertion on `roles` claims every line beneath it, not just its own. */
export function markLines(lines: BodyLine[], checks: Check[]): Marked[] {
  const relevant = checks.filter((check) => check.patterns.length > 0)
  return lines.map((line) => {
    const about = relevant.filter((check) =>
      check.patterns.some((pattern) => pathMatches(pattern, line.path, { prefix: true }))
    )
    return { about: about.map((c) => c.index), mark: markOf(about) }
  })
}

/** Header names match case-insensitively, as the engine matched them. */
export function markHeaders(headers: HeaderEntry[], checks: Check[]): Marked[] {
  const relevant = checks.filter((c) => c.assertion.target === 'header')
  return headers.map((header) => {
    const about = relevant.filter(
      (c) => c.assertion.path?.toLowerCase() === header.name.toLowerCase()
    )
    return { about: about.map((c) => c.index), mark: markOf(about) }
  })
}

export function markStatus(checks: Check[]): Marked {
  const about = checks.filter((c) => c.assertion.target === 'status')
  return { about: about.map((c) => c.index), mark: markOf(about) }
}

export const MARK_GLYPH: Record<Mark, string> = { pass: '✓', fail: '✗', unasserted: '!' }

/** Which response tab shows what an assertion is about. */
export function tabFor(assertion: AssertionResult): 'body' | 'headers' | null {
  if (assertion.target === 'body' || assertion.target === 'strict') return 'body'
  if (assertion.target === 'header') return 'headers'
  return null
}
