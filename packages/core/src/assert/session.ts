import { bodyAsObject } from '../model/bodyObject.js'
import { formatPath, parsePath, sortArraysBy } from '../model/path.js'
import type { AssertionResult, IgnoredPath, ScriptOwner } from '../model/run.js'
import { scriptLine } from '../runtime/sandbox.js'
import {
  checkBody,
  checkScalarTarget,
  isNullCheck,
  locate,
  type CheckMatcher,
  type Coverage,
  type CheckContext,
  type CheckOutcome
} from './evaluate.js'
import { findUnasserted } from './strict.js'

/**
 * One step's checks: everything its `tests` code asked, collection and step.
 *
 * Both scripts feed the same session, so strict validation sees what either of
 * them checked, a sort applies to both, and the report is one list. `finish()`
 * closes it: that is where strict validation runs, because only then is
 * everything that could account for a property known.
 */
export class CheckSession {
  readonly assertions: AssertionResult[] = []
  /** What the tests ignored for strict validation: reported, never counted as checks. */
  private readonly ignored: IgnoredPath[] = []
  private readonly covered: Coverage[] = []
  private sortKeys: string[] = []
  private strict: boolean | undefined
  private parsed: { ok: true; body: unknown } | { ok: false; message: string } | undefined
  private sorted: unknown
  private bodyFailureReported = false
  /** While true, checks recorded are defaults: an endpoint base's (SPEC.md §2.6). */
  private recordingDefaults = false
  private readonly defaults = new Set<AssertionResult>()
  /** Checks whose meaning waits on strict validation: what each would be with it on. */
  private readonly byStrictness: Array<{
    assertion: AssertionResult
    strict: { assertion: AssertionResult; covered: Coverage[] }
  }> = []
  /** Items of each array unordered checks matched, by the array's path. */
  private readonly claims = new Map<string, Set<number>>()
  /** The script running now, whose lines each check it makes is noted against. */
  private running: { script: ScriptOwner; filename: string } | undefined

  constructor(private readonly context: CheckContext) {}

  /**
   * Note each check `run` makes against the line of `script` that made it,
   * found by its `filename` on the stack, so the app can mark the line.
   */
  async madeBy<T>(script: ScriptOwner, filename: string, run: () => Promise<T>): Promise<T> {
    this.running = { script, filename }
    try {
      return await run()
    } finally {
      this.running = undefined
    }
  }

  /** Where in the running script the check being made now was made, if a script is running. */
  private sourceHere(): AssertionResult['source'] {
    if (!this.running) return undefined
    // Deep enough to reach the script through gta, a check file and a helper of its own.
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 64
    const stack = new Error().stack ?? ''
    Error.stackTraceLimit = limit
    const line = scriptLine(stack, this.running.filename)
    return line === undefined ? undefined : { script: this.running.script, line }
  }

  /** Turn strict validation on or off. The last word wins. */
  setStrict(strict: boolean): void {
    this.strict = strict
  }

  /**
   * Sort every array of objects by these properties before later checks.
   *
   * Repeated calls behave like xtest's repeated `sortResponseBodyArrays`: each
   * sorts the result of the one before, so the newest call is the primary key.
   * Checks made before a sort keep the order they saw.
   */
  sortBy(properties: string[]): void {
    if (properties.length === 0) return
    this.sortKeys = [...properties, ...this.sortKeys]
    this.sorted = undefined
    // An index an earlier check matched names another item now.
    this.claims.clear()
  }

  status(matcher: CheckMatcher) {
    return this.record(
      checkScalarTarget('status', 'Status', matcher, [this.context.response.status], this.context)
    )
  }

  header(name: string, matcher: CheckMatcher) {
    const values = this.context.response.headers
      .filter((header) => header.name.toLowerCase() === name.toLowerCase())
      .map((header) => header.value)
    const found = values.length > 0 ? [values.join(', ')] : []
    return this.record({
      ...checkScalarTarget('header', `Header ${name}`, matcher, found, this.context),
      path: name
    })
  }

  body(path: string, matcher: CheckMatcher) {
    const body = this.body_()
    if (body === BODY_UNAVAILABLE) return null
    const segments = parsePath(path)
    const located = locate(body, segments, isNullCheck(matcher))
    const result = checkBody(path, segments, matcher, located, {
      ...this.context,
      claimed: (arrayPath) => this.claimsOn(arrayPath)
    })
    this.covered.push(...result.covered)
    return this.record(result.assertion)
  }

  /**
   * A body check that means one thing under strict validation and another
   * without, as xtest's lone `notThisExpectedValue` entry did (SPEC.md §3).
   * Both are checked now, against the body as it is now, and `finish()` keeps
   * the one the step's last word on strict validation asks for.
   */
  bodyByStrictness(path: string, matchers: { strict: CheckMatcher; lenient: CheckMatcher }) {
    const body = this.body_()
    if (body === BODY_UNAVAILABLE) return null
    const segments = parsePath(path)
    const located = locate(body, segments, false)
    const strict = checkBody(path, segments, matchers.strict, located, this.context)
    const lenient = checkBody(path, segments, matchers.lenient, located, this.context)
    const assertion = this.record(lenient.assertion)
    this.byStrictness.push({ assertion, strict })
    return assertion
  }

  private claimsOn(arrayPath: string): Set<number> {
    let claimed = this.claims.get(arrayPath)
    if (!claimed) this.claims.set(arrayPath, (claimed = new Set()))
    return claimed
  }

  /** Account for a path under strict validation without asserting anything. */
  ignore(path: string): void {
    const pattern = parsePath(path)
    this.covered.push({ pattern })
    const source = this.sourceHere()
    this.ignored.push({ path: formatPath(pattern), ...(source ? { source } : {}) })
  }

  /** Add a result to the report — every check's, and a named check's from code. */
  record(assertion: AssertionResult): AssertionResult {
    const source = assertion.source ?? this.sourceHere()
    if (source) assertion.source = source
    this.assertions.push(assertion)
    if (this.recordingDefaults) this.defaults.add(assertion)
    return assertion
  }

  /**
   * Record what `run` checks as defaults: a later check of the same thing —
   * the status, a header by name, a body property by path — replaces them.
   * That is how an endpoint base's checks give way to a step's own, so a
   * negative test only has to say what it expects.
   */
  async asDefaults<T>(run: () => Promise<T>): Promise<T> {
    this.recordingDefaults = true
    try {
      return await run()
    } finally {
      this.recordingDefaults = false
    }
  }

  /** Drop the defaults something else checked too. */
  private replaceDefaults(): void {
    if (this.defaults.size === 0) return
    const checked = new Set(
      this.assertions.filter((assertion) => !this.defaults.has(assertion)).map(keyOf)
    )
    for (let index = this.assertions.length - 1; index >= 0; index--) {
      const assertion = this.assertions[index]!
      const key = keyOf(assertion)
      if (this.defaults.has(assertion) && key !== null && checked.has(key)) {
        this.assertions.splice(index, 1)
      }
    }
  }

  finish(): CheckOutcome {
    if (this.strict) {
      for (const { assertion, strict } of this.byStrictness) {
        // Made by the same line either way.
        const { source } = assertion
        for (const key of Object.keys(assertion)) delete (assertion as Record<string, unknown>)[key]
        Object.assign(assertion, strict.assertion, source ? { source } : {})
        this.covered.push(...strict.covered)
      }
    }
    this.replaceDefaults()
    if (this.strict) {
      // A body xtest could not read, binary or HTML, has no properties to leave unasserted.
      const readable = !['binary', 'html'].includes(this.context.response.bodyKind)
      const body = readable ? this.body_() : {}
      if (body !== BODY_UNAVAILABLE) {
        const unasserted = findUnasserted(body, this.covered)
        this.assertions.push({
          name: 'Strict: every body property is asserted',
          status: unasserted.length === 0 ? 'pass' : 'fail',
          target: 'strict',
          ...(unasserted.length > 0
            ? {
                message: `${unasserted.length} propert${unasserted.length === 1 ? 'y was' : 'ies were'} not asserted, ignored or captured`,
                unasserted
              }
            : {})
        })
      }
    }
    return {
      assertions: this.assertions,
      ...(this.ignored.length > 0 ? { ignored: [...this.ignored] } : {}),
      ...(this.sortKeys.length > 0 ? { sortedBy: [...this.sortKeys] } : {})
    }
  }

  /**
   * The body as checks see it: parsed once, sorted as asked. A body that will
   * not parse is reported once, not once per check that wanted it.
   */
  private body_(): unknown {
    this.parsed ??= bodyAsObject(this.context.response)
    if (!this.parsed.ok) {
      if (!this.bodyFailureReported) {
        this.bodyFailureReported = true
        const source = this.sourceHere()
        this.assertions.push({
          name: 'Response body',
          status: 'fail',
          target: 'body',
          message: this.parsed.message,
          ...(source ? { source } : {})
        })
      }
      return BODY_UNAVAILABLE
    }
    this.sorted ??=
      this.sortKeys.length > 0 ? sortArraysBy(this.parsed.body, this.sortKeys) : this.parsed.body
    return this.sorted
  }
}

const BODY_UNAVAILABLE = Symbol('body unavailable')

/**
 * What a check is about, for replacing a default: the status, a header by its
 * name in any case, a body property by its path. A named test, strict
 * validation or anything else is never replaced.
 */
function keyOf(assertion: AssertionResult): string | null {
  if (assertion.target === 'status') return 'status'
  if (assertion.target === 'header' && assertion.path)
    return `header:${assertion.path.toLowerCase()}`
  if (assertion.target === 'body' && assertion.path) return `body:${assertion.path}`
  return null
}
