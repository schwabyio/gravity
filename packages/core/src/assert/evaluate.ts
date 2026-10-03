import {
  formatPath,
  parsePath,
  resolvePath,
  type Located,
  type PathSegment
} from '../model/path.js'
import type { AssertionResult, ReceivedResponse } from '../model/run.js'
import type { VarValue } from '../model/documents.js'
import type { VariableScope } from '../vars/scope.js'

/**
 * The checks every assertion runs through.
 *
 * The semantics follow xtest: `gta`'s xtest functions (runtime/gta.ts) translate
 * each call into a `CheckMatcher`, and `CheckSession` (session.ts) runs it here.
 */
export interface CheckOutcome {
  assertions: AssertionResult[]
  /** The sort applied before comparing, when `sortResponseBodyArrays` asked for one. */
  sortedBy?: string[]
}

export interface CheckContext {
  response: ReceivedResponse
  scope: VariableScope
  /** Injectable clock for `dateAsEpoch` offsets. */
  now?: () => number
  /**
   * The items of the array at a path (`formatPath`) that earlier unordered
   * checks matched: a later one prefers others, as xtest's did (SPEC.md §3).
   */
  claimed?: (arrayPath: string) => Set<number>
}

/** A value a matcher compares against directly. */
export type Scalar = string | number | boolean | null

/**
 * What one check asks of a value. Each qualifier is one of xtest's
 * `specialHandling` modes, or its plain equality or RegExp form.
 */
export interface CheckMatcher {
  equals?: Scalar
  /** A pattern, tested against the value as text. A string is a RegExp source. */
  matches?: string | RegExp
  /** Must not match. xtest's `notThisExpectedValue` with a RegExp. */
  notMatches?: string | RegExp
  /** Must not equal. Present as a key even when the value is `undefined`. */
  not?: unknown
  /** Exists; value unchecked. */
  present?: true
  /** Must not exist. */
  absent?: true
  /** Capture into a collection-scoped variable. */
  into?: string
  /** Capture into an environment-scoped variable. */
  intoEnv?: string
  /** Compare `equals` as an epoch date: a number is a seconds offset from now. */
  dateAsEpoch?: true
  /** Tolerance in seconds around `equals`. */
  dateWithinSeconds?: number
  /** Numeric tolerance around `equals`. */
  within?: number
  /** `true` for any array, or constrain emptiness. */
  isArray?: true | 'empty' | 'notEmpty'
  length?: number
  /** Array contents, order-insensitive. Object items are keyed by path. */
  unordered?: unknown[]
  /** Items that must NOT appear in the array. */
  unorderedNot?: unknown[]
}

/* -------------------------------------------------------------- coverage -- */

/**
 * What an entry accounts for under strict validation: the value at `pattern`
 * and everything beneath it.
 */
export interface Coverage {
  pattern: PathSegment[]
}

/* ---------------------------------------------------------------- checks -- */

/**
 * Where a check finds its value. As xtest read a path, one that runs into a
 * `null` before its end reads as that `null` — for a check that the value is
 * `null` (`nullAlong`), so `phoneNumber.number` is null when `phoneNumber` is.
 */
export function locate(root: unknown, segments: PathSegment[], nullAlong: boolean): Located[] {
  const located = resolvePath(root, segments)
  if (located.length > 0 || !nullAlong || segments.some((s) => s.kind === 'each')) return located
  for (let end = 1; end < segments.length; end++) {
    const [reached] = resolvePath(root, segments.slice(0, end))
    if (!reached) return []
    if (reached.value === null) return [reached]
  }
  return []
}

/** A check that the value is `null`, and nothing else. */
export const isNullCheck = (wanted: CheckMatcher): boolean =>
  wanted.equals === null && Object.keys(wanted).length === 1

/** Status and headers: one value or none, compared as text. */
export function checkScalarTarget(
  target: 'status' | 'header',
  label: string,
  wanted: CheckMatcher,
  found: Array<string | number>,
  context: CheckContext
): AssertionResult {
  const base = { target, expected: describe(wanted) } as const
  const name = `${label} ${describe(wanted, { brief: true })}`
  const value = found[0]
  const actual = value === undefined ? {} : { actual: String(value) }

  if (wanted.absent) {
    return value === undefined
      ? { ...base, name, status: 'pass' }
      : { ...base, ...actual, name, status: 'fail', message: 'Present, but must be absent' }
  }
  if (value === undefined) return { ...base, name, status: 'fail', message: 'Not present' }

  const failure = firstFailure([
    wanted.equals !== undefined && String(value) !== String(wanted.equals)
      ? `Expected ${show(wanted.equals)}, got ${show(value)}`
      : null,
    wanted.matches !== undefined ? regexFailure(wanted.matches, String(value)) : null,
    wanted.notMatches !== undefined ? regexFailure(wanted.notMatches, String(value), true) : null,
    wanted.not !== undefined && String(value) === String(wanted.not)
      ? `Must not be ${show(wanted.not)}`
      : null
  ])

  capture(wanted, value, context.scope)
  return failure
    ? { ...base, ...actual, name, status: 'fail', message: failure }
    : { ...base, ...actual, name, status: 'pass' }
}

export function checkBody(
  path: string,
  segments: PathSegment[],
  wanted: CheckMatcher,
  located: Located[],
  context: CheckContext
): { assertion: AssertionResult; covered: Coverage[] } {
  const base = { target: 'body', path, expected: describe(wanted) } as const
  const name = `${path} ${describe(wanted, { brief: true })}`
  const fanOut = segments.some((s) => s.kind === 'each')
  const actual =
    located.length === 0
      ? {}
      : { actual: fanOut ? show(located.map((l) => l.value)) : show(located[0]!.value) }

  if (wanted.absent) {
    return located.length === 0
      ? { assertion: { ...base, name, status: 'pass' }, covered: [] }
      : {
          assertion: {
            ...base,
            ...actual,
            name,
            status: 'fail',
            message: 'Present, but must be absent'
          },
          covered: [{ pattern: segments }]
        }
  }
  if (located.length === 0) {
    return {
      assertion: { ...base, name, status: 'fail', message: 'Not present in the response body' },
      covered: []
    }
  }

  const covered: Coverage[] = []
  let failure: string | null = null
  for (const { path: at, value } of located) {
    const check = checkBodyValue(wanted, value, context, context.claimed?.(formatPath(at)))
    covered.push(...check.covered.map((c) => ({ ...c, pattern: [...at, ...c.pattern] })))
    if (check.failure && !failure) {
      failure = fanOut ? `At ${formatPath(at)}: ${check.failure}` : check.failure
    }
  }

  capture(wanted, fanOut ? located.map((l) => l.value) : located[0]!.value, context.scope)
  return {
    assertion: failure
      ? { ...base, ...actual, name, status: 'fail', message: failure }
      : { ...base, ...actual, name, status: 'pass' },
    covered
  }
}

/**
 * Check one located value. Coverage patterns come back relative to the value,
 * so `[]` → the value itself.
 */
function checkBodyValue(
  wanted: CheckMatcher,
  value: unknown,
  context: CheckContext,
  /** Items of this array earlier checks matched; the ones this check matches are added. */
  claimed: Set<number> = new Set()
): { failure: string | null; covered: Coverage[] } {
  const failures: Array<string | null> = []
  // A value is accounted for when its content was checked. `isArray` and
  // `length` check shape only, and `present` checks existence only, so on a
  // container none of them vouch for what is inside (SPEC.md §3).
  let whole = !(value !== null && typeof value === 'object')
  const covered: Coverage[] = []

  if (wanted.equals !== undefined) {
    failures.push(equalsFailure(wanted, value, context))
    whole = true
  }
  if (wanted.matches !== undefined) failures.push(regexFailure(wanted.matches, stringOf(value)))
  if (wanted.notMatches !== undefined) {
    failures.push(regexFailure(wanted.notMatches, stringOf(value), true))
  }
  if ('not' in wanted && deepEqual(value, wanted.not)) {
    failures.push(`Must not be ${show(wanted.not)}`)
  }

  if (wanted.isArray !== undefined || wanted.length !== undefined) {
    if (!Array.isArray(value)) failures.push(`Expected an array, got ${typeName(value)}`)
    else {
      if (wanted.isArray === 'empty' && value.length > 0) {
        failures.push(
          `Expected an empty array, got ${value.length} item${value.length === 1 ? '' : 's'}`
        )
      }
      if (wanted.isArray === 'notEmpty' && value.length === 0)
        failures.push('Expected a non-empty array, got an empty one')
      if (wanted.length !== undefined && value.length !== wanted.length) {
        failures.push(
          `Expected ${wanted.length} item${wanted.length === 1 ? '' : 's'}, got ${value.length}`
        )
      }
    }
  }

  if (wanted.unordered !== undefined) {
    if (!Array.isArray(value)) failures.push(`Expected an array, got ${typeName(value)}`)
    else {
      const missing: unknown[] = []
      const used = new Set<number>()
      for (const expected of wanted.unordered) {
        // Prefer an item neither an earlier entry nor an earlier check claimed,
        // but do not require it: xtest let two entries describe the same item.
        const matches = value
          .map((item, index) => ({ index, match: matchItem(item, expected, context) }))
          .filter((candidate) => candidate.match !== null)
        const chosen =
          matches.find((m) => !used.has(m.index) && !claimed.has(m.index)) ??
          matches.find((m) => !used.has(m.index)) ??
          matches[0]
        if (!chosen) {
          missing.push(expected)
          continue
        }
        used.add(chosen.index)
        chosen.match!.capture()
        for (const c of chosen.match!.covered) {
          covered.push({ pattern: [{ kind: 'index', index: chosen.index }, ...c.pattern] })
        }
      }
      for (const index of used) claimed.add(index)
      if (missing.length > 0)
        failures.push(`Missing from the array: ${missing.map(showEntry).join(', ')}`)
    }
  }

  if (wanted.unorderedNot !== undefined) {
    if (!Array.isArray(value)) failures.push(`Expected an array, got ${typeName(value)}`)
    else {
      const found = wanted.unorderedNot.filter((expected) =>
        value.some((item) => matchItem(item, expected, context) !== null)
      )
      if (found.length > 0) failures.push(`Must not contain: ${found.map(showEntry).join(', ')}`)
      else if (value.length === 0) whole = true
    }
  }

  // A capture is a claim on the value, which is why xtest counted it for strict.
  if (wanted.into !== undefined || wanted.intoEnv !== undefined) whole = true
  if (wanted.matches !== undefined || wanted.notMatches !== undefined || 'not' in wanted)
    whole = true

  if (whole) covered.unshift({ pattern: [] })
  return { failure: firstFailure(failures), covered }
}

function equalsFailure(wanted: CheckMatcher, value: unknown, context: CheckContext): string | null {
  const expected = wanted.equals

  if (wanted.dateAsEpoch) {
    const actualDate = dateFromEpoch(value)
    if (!actualDate) return `Expected an epoch timestamp, got ${show(value)}`
    let expectedYmd: string
    if (typeof expected === 'number') {
      // xtest: a number is an offset in seconds from now, compared by calendar day.
      expectedYmd = ymd(new Date((context.now?.() ?? Date.now()) + expected * 1000))
    } else if (typeof expected === 'string') {
      expectedYmd = expected.slice(0, 10)
    } else {
      return `dateAsEpoch needs a date string or a seconds offset, got ${show(expected)}`
    }
    const actualYmd = ymd(actualDate)
    return actualYmd === expectedYmd
      ? null
      : `Expected the date ${expectedYmd}, got ${actualYmd} (${show(value)})`
  }

  if (wanted.dateWithinSeconds !== undefined) {
    const expectedMs = toMillis(expected)
    const actualMs = toMillis(value)
    if (expectedMs === null) return `Expected value ${show(expected)} is not a date`
    if (actualMs === null) return `Expected a date, got ${show(value)}`
    const off = Math.abs(actualMs - expectedMs) / 1000
    return off <= wanted.dateWithinSeconds
      ? null
      : `Expected within ${wanted.dateWithinSeconds}s of ${show(expected)}, got ${show(value)} (${off.toFixed(1)}s off)`
  }

  if (wanted.within !== undefined) {
    if (typeof value !== 'number') return `Expected a number, got ${show(value)}`
    const target = Number(expected)
    return Math.abs(value - target) <= wanted.within
      ? null
      : `Expected ${show(expected)} ± ${wanted.within}, got ${show(value)}`
  }

  if (value === expected) return null
  if (
    value !== null &&
    expected !== null &&
    typeof value !== typeof expected &&
    String(value) === String(expected)
  ) {
    return `Expected ${show(expected)} (${typeName(expected)}), got ${show(value)} (${typeName(value)})`
  }
  return `Expected ${show(expected)}, got ${show(value)}`
}

/* --------------------------------------------------------------- helpers -- */

function capture(
  wanted: { into?: string | undefined; intoEnv?: string | undefined },
  value: unknown,
  scope: VariableScope
) {
  const stored = toVarValue(value)
  if (wanted.into) scope.set(wanted.into, stored, 'captured')
  // Kept in the run's scope like `into`. Writing it back to the environment
  // file is deliberately not done: a test run should not edit the repository.
  if (wanted.intoEnv) scope.set(wanted.intoEnv, stored, 'captured (environment)')
}

function toVarValue(value: unknown): VarValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    return value as VarValue
  return JSON.stringify(value)
}

function regexFailure(
  pattern: string | RegExp,
  text: string | null,
  negate = false
): string | null {
  let regex: RegExp
  try {
    // A fresh copy: a `g` or `y` flag makes `test` stateful across calls.
    regex =
      typeof pattern === 'string' ? new RegExp(pattern) : new RegExp(pattern.source, pattern.flags)
  } catch (cause) {
    return `Invalid regular expression: ${(cause as Error).message}`
  }
  if (text === null) return `Expected text matching ${showRegex(regex)}, got a non-scalar value`
  if (negate) {
    return regex.test(text) ? `Must not match ${showRegex(regex)}, got ${show(text)}` : null
  }
  return regex.test(text) ? null : `Expected to match ${showRegex(regex)}, got ${show(text)}`
}

const showRegex = (regex: RegExp | string): string =>
  typeof regex === 'string' ? `/${regex}/` : `/${regex.source}/${regex.flags}`

const stringOf = (value: unknown): string | null =>
  value === null || typeof value !== 'object' ? String(value) : null

const QUALIFIERS = new Set([
  'equals',
  'matches',
  'not',
  'present',
  'absent',
  'into',
  'intoEnv',
  'dateAsEpoch',
  'dateWithinSeconds',
  'within',
  'isArray',
  'length',
  'unordered',
  'unorderedNot',
  'notMatches'
])

/** An object written as a matcher, rather than a literal value to compare. */
const isMatcherObject = (value: unknown): value is CheckMatcher =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => QUALIFIERS.has(key))

interface ItemMatch {
  /** Relative to the item. */
  covered: Coverage[]
  capture: () => void
}

/**
 * Whether one array item satisfies one `unordered` entry.
 *
 * A scalar entry compares by value, and a RegExp entry is a pattern the item
 * must match as text. An object entry lists properties the item must have,
 * keyed by path (`id.value`), each a literal, a RegExp or a matcher, so
 * `{ id.value: { into: accountId } }` both finds the item and captures from it.
 * An empty object matches only an empty object, never every item.
 */
function matchItem(item: unknown, expected: unknown, context: CheckContext): ItemMatch | null {
  const noop = () => {}
  if (isRegExp(expected)) {
    const check = checkBodyValue({ matches: expected }, item, context)
    return check.failure ? null : { covered: check.covered, capture: noop }
  }
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return deepEqual(item, expected) ? { covered: [{ pattern: [] }], capture: noop } : null
  }
  const entries = Object.entries(expected)
  if (entries.length === 0) {
    return deepEqual(item, {}) ? { covered: [{ pattern: [] }], capture: noop } : null
  }
  if (item === null || typeof item !== 'object') return null

  const covered: Coverage[] = []
  const captures: Array<() => void> = []
  for (const [key, written] of entries) {
    const want = isRegExp(written) ? { matches: written } : written
    const segments = parsePath(key)
    const located = locate(
      item,
      segments,
      isMatcherObject(want) ? isNullCheck(want) : want === null
    )
    if (isMatcherObject(want)) {
      if (want.absent) {
        if (located.length > 0) return null
        continue
      }
      if (located.length === 0) return null
      for (const { path: at, value } of located) {
        const check = checkBodyValue(want, value, context)
        if (check.failure) return null
        covered.push(...check.covered.map((c) => ({ pattern: [...at, ...c.pattern] })))
      }
      captures.push(() => capture(want, located[0]!.value, context.scope))
      continue
    }
    if (located.length === 0 || !located.every((l) => deepEqual(l.value, want))) return null
    covered.push(...located.map((l) => ({ pattern: l.path })))
  }
  return { covered, capture: () => captures.forEach((run) => run()) }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  )
}

function dateFromEpoch(value: unknown): Date | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value)
        ? Number(value)
        : NaN
  if (!Number.isFinite(n)) return null
  return new Date(n)
}

function toMillis(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Local calendar day, as xtest compared it. */
const ymd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const firstFailure = (failures: Array<string | null | false>): string | null =>
  failures.find((f): f is string => typeof f === 'string') ?? null

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * A RegExp from any realm. Code in `tests` runs in its own V8 context, whose
 * `RegExp` is a different constructor from this one, so `instanceof` misses it.
 */
export const isRegExp = (value: unknown): value is RegExp =>
  Object.prototype.toString.call(value) === '[object RegExp]'

export function show(value: unknown): string {
  if (isRegExp(value)) return showRegex(value)
  if (value === undefined) return 'undefined'
  const text =
    typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
  return clip(text)
}

const clip = (text: string): string => (text.length > 200 ? `${text.slice(0, 199)}…` : text)

/** A matcher in words, as the report's name for it. */
export function describe(matcher: object, { brief = false }: { brief?: boolean } = {}): string {
  const parts = describeParts(matcher as CheckMatcher, brief)
  return parts.length > 0 ? parts.join(', ') : 'is present'
}

function describeParts(m: CheckMatcher, brief: boolean): string[] {
  const parts: string[] = []
  if (m.equals !== undefined) {
    if (m.dateAsEpoch)
      parts.push(
        `is the date ${typeof m.equals === 'number' ? `now ${m.equals >= 0 ? '+' : '−'} ${Math.abs(m.equals)}s` : show(m.equals)} (epoch)`
      )
    else if (m.dateWithinSeconds !== undefined)
      parts.push(`is within ${m.dateWithinSeconds}s of ${show(m.equals)}`)
    else if (m.within !== undefined) parts.push(`is ${show(m.equals)} ± ${m.within}`)
    else parts.push(`is ${show(m.equals)}`)
  }
  if (m.matches !== undefined) parts.push(`matches ${showRegex(m.matches)}`)
  if (m.notMatches !== undefined) parts.push(`does not match ${showRegex(m.notMatches)}`)
  if ('not' in m) parts.push(`is not ${show(m.not)}`)
  if (m.present) parts.push('is present')
  if (m.absent) parts.push('is absent')
  if (m.isArray === true) parts.push('is an array')
  if (m.isArray === 'empty') parts.push('is an empty array')
  if (m.isArray === 'notEmpty') parts.push('is a non-empty array')
  if (m.length !== undefined) parts.push(`has ${m.length} item${m.length === 1 ? '' : 's'}`)
  if (m.unordered !== undefined) parts.push(`contains ${listed(m.unordered, brief)}`)
  if (m.unorderedNot !== undefined) parts.push(`does not contain ${listed(m.unorderedNot, brief)}`)
  if (m.into !== undefined) parts.push(`→ {{${m.into}}}`)
  if (m.intoEnv !== undefined) parts.push(`→ env {{${m.intoEnv}}}`)
  return parts
}

/**
 * An `unordered` entry, for a name or a message. A value, or an item of
 * values, is its JSON. An item whose properties hold matchers, as an xtest
 * validation list builds, shows each as written — `{ balance: 19 ± 1,
 * nickname: absent }` — rather than as the matcher objects the engine reads,
 * whose patterns JSON would print as `{}`.
 */
function showEntry(entry: unknown): string {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || isRegExp(entry)) {
    return show(entry)
  }
  // A matcher that only compares is its value, so a plain validation list reads as JSON;
  // a RegExp is the pattern it is matched as.
  const props = Object.entries(entry).map(([key, want]): [string, unknown] => [
    key,
    isRegExp(want)
      ? { matches: want }
      : isMatcherObject(want) && Object.keys(want).join() === 'equals'
        ? want.equals
        : want
  ])
  if (!props.some(([, want]) => isMatcherObject(want))) {
    return show(Object.fromEntries(props))
  }
  const shown = props.map(([key, want]) => {
    if (!isMatcherObject(want)) return `${key}: ${show(want)}`
    const parts = describeParts(want, true).map((part) => part.replace(/^is /, ''))
    return `${key}: ${parts.length > 0 ? parts.join(' ') : 'present'}`
  })
  return clip(`{ ${shown.join(', ')} }`)
}

/**
 * Array items for a description. Brief — for a name — counts object items
 * rather than printing them, since one account record would fill the line.
 */
function listed(items: unknown[], brief: boolean): string {
  const text = items.map(showEntry).join(', ')
  if (!brief || text.length <= 60) return text
  return `${items.length} item${items.length === 1 ? '' : 's'}`
}
