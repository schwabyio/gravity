import assert from 'node:assert/strict'
import type { CheckMatcher } from '../assert/evaluate.js'
import { isRegExp, show } from '../assert/evaluate.js'
import type { CheckSession } from '../assert/session.js'
import { bodyAsObject } from '../model/bodyObject.js'
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

/** One entry of an object `validationList`, as xtest documented it. */
interface ValidationEntry {
  pathToProperty: string
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
    const path = entry.pathToProperty
    if (valueKey === 'compareValue') {
      item[path] = entry.compareValue
      continue
    }
    // xtest lists often name a property twice — once to check it, once to
    // capture it — so the matchers for one path are merged, not replaced.
    const matcher = xtestMatcher(valueKey in entry, entry[valueKey], entry.specialHandling)
    item[path] = { ...(item[path] as object | undefined), ...matcher }
  }
  return item
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
}

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
export function testsGta({ session, scope, pending, warn = () => {} }: TestsApi) {
  const shared = sharedGta(scope)
  return {
    ...shared,

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
        ...args: [jsonPathToProperty: string, expectedValue?: unknown, specialHandling?: string]
      ) => {
        const [path, value, specialHandling] = args
        session.body(path, xtestMatcher(args.length > 1, value, specialHandling))
      }
    ),

    expectResponseBodyToHaveUnorderedArray: guarded(
      session,
      'expectResponseBodyToHaveUnorderedArray',
      (jsonPathToArray: string, validationList: unknown) => {
        const list = toList(validationList)
        const unordered = list.every(isValidationEntry)
          ? [itemFrom(list as ValidationEntry[], 'expectedValue')]
          : list
        session.body(jsonPathToArray, { unordered })
      }
    ),

    expectResponseBodyToHaveUnorderedArrayNotThisItem: guarded(
      session,
      'expectResponseBodyToHaveUnorderedArrayNotThisItem',
      (jsonPathToArray: string, validationList: unknown) => {
        const list = toList(validationList)
        const unorderedNot = list.every(isValidationEntry)
          ? [itemFrom(list as ValidationEntry[], 'compareValue')]
          : list
        session.body(jsonPathToArray, { unorderedNot })
      }
    ),

    ignoreResponseBodyProperty(jsonPathToProperty: string) {
      session.ignore(jsonPathToProperty)
    },

    ignoreResponseBodyArrayObjectProperty(
      jsonPathToArray: string,
      jsonPathOfObjectProperty: string
    ) {
      session.ignore(`${jsonPathToArray}[].${jsonPathOfObjectProperty}`)
    },

    sortResponseBodyArrays(propertyName: string) {
      // As in xtest: a missing name sorts nothing and is only worth a warning.
      if (typeof propertyName !== 'string' || propertyName === '') {
        warn('gta.sortResponseBodyArrays() needs a property name to sort by; nothing was sorted')
        return
      }
      session.sortBy([propertyName])
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
export function preRequestGta(scope: VariableScope) {
  const notHere = (name: string) => () => {
    throw new Error(`gta.${name}() checks a response, so it belongs in tests, not before.script`)
  }
  return {
    ...sharedGta(scope),
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
    /** Set a variable for the rest of this run, like a capture. */
    set(name: string, value: unknown): void {
      scope.set(String(name), toVarValue(value), 'script')
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
