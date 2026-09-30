import assert from 'node:assert/strict'
import type { CheckMatcher } from '../assert/evaluate.js'
import { isRegExp, show } from '../assert/evaluate.js'
import type { CheckSession } from '../assert/session.js'
import { bodyAsObject } from '../model/bodyObject.js'
import { formatPath, parsePath, type PathSegment } from '../model/path.js'
import { UnknownFlagError } from '../flags/flags.js'
import type { VarValue } from '../model/documents.js'
import type { ReceivedResponse, SentRequest } from '../model/run.js'
import { randomUUID, getRandomValues } from 'node:crypto'
import { strftime } from '../vars/generators.js'
import type { VariableScope } from '../vars/scope.js'
import type { Adopt } from './sandbox.js'

/**
 * `gta`: xtest, built in.
 *
 * The same functions xtest has always had, with the boilerplate gone: nothing
 * to load, no `startXTest(pm, …)` / `endXTest()` bracket, no `pm` to pass. Every
 * call feeds the step's `CheckSession`, so the collection's and the step's checks
 * count together under strict validation, and each links to the lines of the
 * response it is about.
 */

/** xtest's `specialHandling` strings, and what each became in the engine. */
export const SPECIAL_HANDLING = [
  'notThisExpectedKey',
  'notThisExpectedValue',
  'setAsCollectionVariable',
  'setAsEnvironmentVariable',
  'dateAsEpoch',
  'dateWithin<X>Sec',
  'integerWithin<X>',
  'isArray',
  'isArrayAndEmpty',
  'isArrayAndNotEmpty',
  'isArrayAndHasLength'
] as const

export class GtaUsageError extends Error {}

/**
 * Translate one xtest call's arguments into a matcher.
 *
 * `hasValue` is whether the caller passed an expected value at all, which is
 * different from passing `undefined`: `expectResponseBodyToHaveProperty(path)`
 * asks only that the property exists.
 */
export function xtestMatcher(
  hasValue: boolean,
  value: unknown,
  specialHandling?: string
): CheckMatcher {
  if (specialHandling === undefined || specialHandling === null) {
    if (!hasValue) return { present: true }
    return isRegExp(value) ? { matches: value } : { equals: value as never }
  }
  const within = /^dateWithin(\d+)Sec$/.exec(specialHandling)
  if (within) return { equals: value as never, dateWithinSeconds: Number(within[1]) }
  const integer = /^integerWithin(\d+)$/.exec(specialHandling)
  if (integer) return { equals: value as never, within: Number(integer[1]) }

  switch (specialHandling) {
    case 'notThisExpectedKey':
      return { absent: true }
    case 'notThisExpectedValue':
      return isRegExp(value) ? { notMatches: value } : { not: value as never }
    case 'setAsCollectionVariable':
      return { into: variableName(value) }
    case 'setAsEnvironmentVariable':
      return { intoEnv: variableName(value) }
    case 'dateAsEpoch':
      return { equals: value as never, dateAsEpoch: true }
    case 'isArray':
      return { isArray: true }
    case 'isArrayAndEmpty':
      return { isArray: 'empty' }
    case 'isArrayAndNotEmpty':
      return { isArray: 'notEmpty' }
    case 'isArrayAndHasLength':
      if (typeof value !== 'number') {
        throw new GtaUsageError(
          `isArrayAndHasLength needs the length as a number, got ${show(value)}`
        )
      }
      return { isArray: true, length: value }
    default:
      throw new GtaUsageError(
        `Unknown specialHandling ${show(specialHandling)}. Supported: ${SPECIAL_HANDLING.join(', ')}`
      )
  }
}

function variableName(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new GtaUsageError(
      `The variable name to set must be a non-empty string, got ${show(value)}`
    )
  }
  return value
}

/**
 * A path, as xtest took one: a string, `'user.name'`, or a list of keys,
 * `['decodedJwt', 'payload', 'https://x.io/id']`, for a key a string cannot
 * spell. The engine reads the string `formatPath` makes of a list.
 */
type PathArg = string | Array<string | number>

/**
 * A path argument as the engine reads it (SPEC.md §3). In a list each key is
 * taken as it is, and a number as its digits, as xtest's lodash `get` did, so
 * `[0, 'city']` reads index 0 of an array and key `"0"` of an object alike.
 */
function pathOf(path: unknown, what: string): string {
  if (typeof path === 'string') return path
  if (!Array.isArray(path)) {
    throw new GtaUsageError(
      `${what} is a string, such as "user.name", or a list of keys, such as ["user", "name"]; got ${show(path)}`
    )
  }
  if (path.length === 0) throw new GtaUsageError(`${what} is an empty list; it needs a key`)
  return formatPath(
    path.map((key): PathSegment => {
      if (typeof key === 'string') return { kind: 'key', key }
      if (typeof key === 'number') return { kind: 'key', key: String(key) }
      throw new GtaUsageError(`${what}'s keys are strings or numbers; got ${show(key)}`)
    })
  )
}

/** One entry of an object `validationList`, as xtest documented it. */
interface ValidationEntry {
  pathToProperty: PathArg
  expectedValue?: unknown
  compareValue?: unknown
  specialHandling?: string
}

const isValidationEntry = (value: unknown): value is ValidationEntry =>
  value !== null && typeof value === 'object' && 'pathToProperty' in value

/**
 * An object `validationList` describes one array item, property by property.
 * It becomes one `unordered` item keyed by path, whose values are matchers.
 */
function itemFrom(list: ValidationEntry[], valueKey: 'expectedValue' | 'compareValue') {
  const item: Record<string, unknown> = {}
  for (const entry of list) {
    const path = pathOf(entry.pathToProperty, 'pathToProperty')
    if (valueKey === 'compareValue') {
      const value = entry.compareValue
      item[path] = isRegExp(value) ? { matches: value } : value
      continue
    }
    // xtest lists often name a property twice — once to check it, once to
    // capture it — so the matchers for one path are merged, not replaced.
    const matcher = xtestMatcher(valueKey in entry, entry[valueKey], entry.specialHandling)
    item[path] = { ...(item[path] as object | undefined), ...matcher }
  }
  return item
}

/**
 * A list that is one `notThisExpectedValue` entry and nothing else. Without
 * strict validation xtest read it as "no item has this value", so an empty
 * array passes; with it, as one item whose value is something else, as gta
 * reads any list (SPEC.md §3). This is the first reading, as a matcher.
 */
function loneNotThisValue(list: unknown[]): CheckMatcher | null {
  const [entry] = list
  if (list.length !== 1 || !isValidationEntry(entry)) return null
  if (entry.specialHandling !== 'notThisExpectedValue' || !('expectedValue' in entry)) return null
  const value = entry.expectedValue
  const path = pathOf(entry.pathToProperty, 'pathToProperty')
  return { unorderedNot: [{ [path]: isRegExp(value) ? { matches: value } : value }] }
}

function toList(validationList: unknown): unknown[] {
  if (!Array.isArray(validationList)) {
    throw new GtaUsageError(`validationList must be an array, got ${show(validationList)}`)
  }
  return validationList
}

export interface TestsApi {
  session: CheckSession
  scope: VariableScope
  /** Promises from `gta.test` bodies, awaited before the step finishes. */
  pending: Promise<unknown>[]
  /** A warning for the step's console, for a call that did nothing. */
  warn?: (message: string) => void
  /** Where `gta.skipRest` records its reason. */
  control?: StepControl
}

/**
 * What a step's scripts decided about running, beyond its checks (SPEC.md §5):
 * `gta.skip` not to send this request, `gta.skipRest` not to run the steps
 * after it. Each holds the reason, and the first reason given stands.
 */
export interface StepControl {
  skip: string | null
  rest: string | null
}

export const newStepControl = (): StepControl => ({ skip: null, rest: null })

/** A reason as given, or what to say when none was. */
const reasonOf = (reason: unknown, fallback: string): string =>
  reason === undefined || reason === null || String(reason).trim() === ''
    ? fallback
    : String(reason)

/**
 * Wrap a function so a mistake in how it was called becomes a failed
 * assertion with the reason, rather than an exception that stops every check
 * after it. That is how xtest reported its "Oops" errors too.
 */
function guarded<A extends unknown[]>(
  session: CheckSession,
  label: string,
  fn: (...args: A) => void
): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args)
    } catch (cause) {
      if (!(cause instanceof GtaUsageError)) throw cause
      session.record({ name: label, status: 'fail', message: cause.message })
    }
  }
}

/** The `gta` object for a step's `tests`. */
export function testsGta({
  session,
  scope,
  pending,
  warn = () => {},
  control = newStepControl()
}: TestsApi) {
  const shared = sharedGta(scope)
  return {
    ...shared,

    skip(): never {
      throw new Error(
        'gta.skip() stops a request before it is sent, so it belongs in before.script; gta.skipRest() skips the steps after this one'
      )
    },

    /** Run none of the steps after this one in this row; the next row, and teardown, still run. */
    skipRest(reason?: string): void {
      control.rest ??= reasonOf(reason, 'gta.skipRest() in an earlier step')
    },

    expectResponseStatusCodeToBe: guarded(
      session,
      'expectResponseStatusCodeToBe',
      (...args: [expectedValue: unknown, specialHandling?: string]) => {
        session.status(xtestMatcher(args.length > 0, args[0], args[1]))
      }
    ),

    expectResponseToHaveHeader: guarded(
      session,
      'expectResponseToHaveHeader',
      (
        ...args: [
          expectedHeaderKey: string,
          expectedHeaderValue?: unknown,
          specialHandling?: string
        ]
      ) => {
        const [key, value, specialHandling] = args
        const hasValue =
          args.length > 1 && !(value === null && specialHandling === 'notThisExpectedKey')
        session.header(key, xtestMatcher(hasValue, value, specialHandling))
      }
    ),

    expectResponseBodyToHaveProperty: guarded(
      session,
      'expectResponseBodyToHaveProperty',
      (
        ...args: [jsonPathToProperty: PathArg, expectedValue?: unknown, specialHandling?: string]
      ) => {
        const [path, value, specialHandling] = args
        session.body(
          pathOf(path, 'jsonPathToProperty'),
          xtestMatcher(args.length > 1, value, specialHandling)
        )
      }
    ),

    expectResponseBodyToHaveUnorderedArray: guarded(
      session,
      'expectResponseBodyToHaveUnorderedArray',
      (jsonPathToArray: PathArg, validationList: unknown) => {
        const path = pathOf(jsonPathToArray, 'jsonPathToArray')
        const list = toList(validationList)
        const unordered = list.every(isValidationEntry)
          ? [itemFrom(list as ValidationEntry[], 'expectedValue')]
          : list
        const lone = loneNotThisValue(list)
        if (lone) session.bodyByStrictness(path, { strict: { unordered }, lenient: lone })
        else session.body(path, { unordered })
      }
    ),

    expectResponseBodyToHaveUnorderedArrayNotThisItem: guarded(
      session,
      'expectResponseBodyToHaveUnorderedArrayNotThisItem',
      (jsonPathToArray: PathArg, validationList: unknown) => {
        const path = pathOf(jsonPathToArray, 'jsonPathToArray')
        const list = toList(validationList)
        const unorderedNot = list.every(isValidationEntry)
          ? [itemFrom(list as ValidationEntry[], 'compareValue')]
          : list
        session.body(path, { unorderedNot })
      }
    ),

    ignoreResponseBodyProperty: guarded(
      session,
      'ignoreResponseBodyProperty',
      (jsonPathToProperty: PathArg) => {
        session.ignore(pathOf(jsonPathToProperty, 'jsonPathToProperty'))
      }
    ),

    ignoreResponseBodyArrayObjectProperty: guarded(
      session,
      'ignoreResponseBodyArrayObjectProperty',
      (jsonPathToArray: PathArg, jsonPathOfObjectProperty: PathArg) => {
        const array = parsePath(pathOf(jsonPathToArray, 'jsonPathToArray'))
        const property = parsePath(pathOf(jsonPathOfObjectProperty, 'jsonPathOfObjectProperty'))
        session.ignore(formatPath([...array, { kind: 'each' }, ...property]))
      }
    ),

    sortResponseBodyArrays(propertyName: PathArg) {
      // As in xtest: a missing name sorts nothing and is only worth a warning.
      const named =
        (typeof propertyName === 'string' && propertyName !== '') ||
        (Array.isArray(propertyName) && propertyName.length > 0)
      if (!named) {
        warn('gta.sortResponseBodyArrays() needs a property name to sort by; nothing was sorted')
        return
      }
      try {
        session.sortBy([pathOf(propertyName, 'propertyName')])
      } catch (cause) {
        if (!(cause instanceof GtaUsageError)) throw cause
        warn(`gta.sortResponseBodyArrays(): ${cause.message}; nothing was sorted`)
      }
    },

    /** Strict validation for this step. Replaces `startXTest`'s second argument. */
    useStrictValidation(enabled = true) {
      session.setStrict(enabled === true || String(enabled) === 'true')
    },

    /**
     * A named check of your own: passes unless `fn` throws or rejects. `fn` may
     * be async; the step waits for it whether or not the script does.
     */
    test(name: string, fn: () => unknown): Promise<void> {
      const failure = (cause: unknown) => {
        const shaped = cause as { message?: unknown }
        return typeof shaped?.message === 'string' ? shaped.message : String(cause)
      }
      const entry = session.record({ name: String(name), target: 'custom', status: 'pass' })
      let outcome: unknown
      try {
        outcome = fn()
      } catch (cause) {
        Object.assign(entry, { status: 'fail', message: failure(cause) })
        return Promise.resolve()
      }
      if (!isThenable(outcome)) return Promise.resolve()

      // Recorded in call order, settled later: until then it counts as unfinished.
      Object.assign(entry, { status: 'fail', message: 'Did not finish' })
      const done = Promise.resolve(outcome).then(
        () => {
          entry.status = 'pass'
          delete entry.message
        },
        (cause: unknown) => {
          entry.message = failure(cause)
        }
      )
      pending.push(done)
      return done
    }
  }
}

/** The `gta` object for `before.script`: variables and helpers, no assertions. */
export function preRequestGta(scope: VariableScope, control: StepControl = newStepControl()) {
  const notHere = (name: string) => () => {
    throw new Error(`gta.${name}() checks a response, so it belongs in tests, not before.script`)
  }
  return {
    ...sharedGta(scope),
    /**
     * Send nothing for this step, and report it skipped with the reason. The
     * script runs to its end; no later `before.script` does.
     */
    skip(reason?: string): void {
      control.skip ??= reasonOf(reason, 'gta.skip() in before.script')
    },
    /** `skip`, and run none of the steps after this one in this row either. */
    skipRest(reason?: string): void {
      const given = reasonOf(reason, 'gta.skipRest() in before.script')
      control.skip ??= given
      control.rest ??= given
    },
    expectResponseStatusCodeToBe: notHere('expectResponseStatusCodeToBe'),
    expectResponseToHaveHeader: notHere('expectResponseToHaveHeader'),
    expectResponseBodyToHaveProperty: notHere('expectResponseBodyToHaveProperty'),
    test: notHere('test')
  }
}

function sharedGta(scope: VariableScope) {
  return {
    /** A variable's current value, from any layer: environment, `set`, captures. */
    get(name: string): unknown {
      return scope.get(name)
    },
    /**
     * Set a variable for the rest of this run, like a capture. With
     * `{ scope: 'run' }` it lasts past this data row too, into every row after
     * it and teardown (SPEC.md §2.10).
     */
    set(name: string, value: unknown, options?: { scope?: string }): void {
      const lasting = options?.scope
      if (lasting !== undefined && lasting !== 'run') {
        throw new Error(`gta.set(): scope is 'run' or left out, got ${show(lasting)}`)
      }
      if (lasting === 'run') scope.setForRun(String(name), toVarValue(value), 'script')
      else scope.set(String(name), toVarValue(value), 'script')
    },
    /**
     * A feature flag's value in this run (SPEC.md §2.9) — to check something
     * different when it is on, rather than skip a step. A flag the run does not
     * know is an error, as in a condition.
     */
    flag(name: string): string | number | boolean {
      const flags = scope.flags
      if (!flags || !(String(name) in flags)) throw new UnknownFlagError([String(name)])
      return flags[String(name)]!
    },
    /** A random (version 4) UUID. */
    uuid(): string {
      return randomUUID()
    },
    /**
     * A version 7 UUID: time-ordered, so values sort by when they were made —
     * handy for ids that must be unique and still read in creation order.
     */
    uuidv7,
    /** A whole number from `min` to `max`, both included. */
    randomInt(min: number, max: number): number {
      const low = Math.ceil(Math.min(min, max))
      const high = Math.floor(Math.max(min, max))
      return low + Math.floor(Math.random() * (high - low + 1))
    },
    /** xtest's `date(dateFormat, secondsOffset, timeZone)`. */
    date(dateFormat: string, secondsOffset = 0, timeZone = 'local'): string {
      return strftime(dateFormat, new Date(Date.now() + secondsOffset * 1000), zoneFor(timeZone))
    },
    /** Node's strict `assert`, for checks inside `gta.test`. */
    assert
  }
}

/**
 * RFC 9562 UUID version 7: a 48-bit Unix millisecond timestamp, then random bits,
 * with the version (7) and variant (10) fields set.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = getRandomValues(new Uint8Array(16))
  let time = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = time % 256
    time = Math.floor(time / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

function toVarValue(value: unknown): VarValue {
  // No value is null, not the text "undefined", so it still reads `== null`.
  if (value === undefined) return null
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as VarValue
  }
  return JSON.stringify(value) ?? String(value)
}

/**
 * xtest's `date()` took military zone letters — `U` is -08:00, not UTC — and
 * `IST`. Those map to fixed-offset IANA zones; anything else (`utc`, `local`,
 * `America/New_York`) passes through.
 */
const MILITARY: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  I: 9,
  K: 10,
  L: 11,
  M: 12,
  N: -1,
  O: -2,
  P: -3,
  Q: -4,
  R: -5,
  S: -6,
  T: -7,
  U: -8,
  V: -9,
  W: -10,
  X: -11,
  Y: -12,
  Z: 0
}

export function zoneFor(timeZone: string): string {
  if (timeZone === 'IST') return 'Asia/Kolkata'
  const hours = MILITARY[timeZone]
  if (hours === undefined) return timeZone
  if (hours === 0) return 'UTC'
  // POSIX sign convention: Etc/GMT+8 is eight hours *behind* UTC.
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`
}

/* ------------------------------------------------------------ req / res -- */

/** What a script sees of the request: as sent, or for `before.script`, as written. */
export const requestView = (request: SentRequest, adopt: Adopt) =>
  adopt({
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.map((h) => [h.name, h.value])),
    body: request.body
  })

/**
 * What `tests` sees of the response. `body` is parsed — JSON as itself, XML
 * converted as the assertions see it, text as the string — and `text` is the
 * body exactly as received.
 */
export function responseView(response: ReceivedResponse, adopt: Adopt) {
  const headers: Record<string, string> = {}
  for (const { name, value } of response.headers) {
    const key = name.toLowerCase()
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value
  }
  const parsed = bodyAsObject(response)
  return {
    status: response.status,
    statusText: response.statusText,
    headers: adopt(headers),
    header: (name: string): string | undefined => headers[String(name).toLowerCase()],
    body:
      response.bodyKind === 'text' || response.bodyKind === 'html'
        ? response.body
        : parsed.ok
          ? adopt(parsed.body)
          : undefined,
    text: response.body,
    time: response.timings.totalMs,
    size: response.sizeBytes
  }
}
