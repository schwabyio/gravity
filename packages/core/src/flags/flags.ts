import type { FlagConditions, FlagValue } from '../model/documents.js'

/**
 * Feature flags (SPEC.md §2.9): what a collection or step says it needs —
 * `flags: { newCheckout: true }` — against the values a run has.
 *
 * Values come from the environment file's `flags.values`, then its
 * `flags.command` (fresh from a flag service before a run), then overrides. A
 * condition naming a flag the run does not know is an error, never a guess: a
 * typo or a deleted flag would otherwise quietly run or skip the wrong tests.
 */

export type FlagValues = Record<string, FlagValue>

/** Where a flag's value came from, for reports and the app. */
export type FlagSource = 'environment' | 'command' | 'override'

export interface ResolvedFlags {
  values: FlagValues
  sources: Record<string, FlagSource>
}

export class UnknownFlagError extends Error {
  override name = 'UnknownFlagError'
  constructor(readonly flags: string[]) {
    super(
      `feature flag${flags.length === 1 ? '' : 's'} ${flags.join(', ')} ${flags.length === 1 ? 'is' : 'are'} not known in this environment — check the name, or add ${flags.length === 1 ? 'it' : 'them'} to the environment's flags (SPEC.md §2.9)`
    )
  }
}

/**
 * Whether conditions hold: every flag named must have the value given.
 * Compared as text, so `true` matches `true` or `"true"`, and `2` matches `"2"`
 * — a flag service and a YAML file need not agree on types.
 *
 * Returns why not when they do not hold; throws `UnknownFlagError` for a flag
 * the values do not have.
 */
export function checkFlags(
  conditions: FlagConditions | undefined,
  values: FlagValues | null
): { run: true } | { run: false; reason: string } {
  const entries = Object.entries(conditions ?? {})
  if (entries.length === 0) return { run: true }
  const unknown = entries.map(([name]) => name).filter((name) => !values || !(name in values))
  if (unknown.length > 0) throw new UnknownFlagError(unknown)
  for (const [name, wanted] of entries) {
    const actual = values![name]!
    if (String(actual) !== String(wanted))
      return { run: false, reason: describe(name, wanted, actual) }
  }
  return { run: true }
}

/** `newCheckout is off`, `pricingVersion is v1, not v2`. */
function describe(name: string, wanted: FlagValue, actual: FlagValue): string {
  if (typeof wanted === 'boolean' && String(actual) === String(!wanted)) {
    return `feature flag ${name} is ${actual === true || actual === 'true' ? 'on' : 'off'}`
  }
  return `feature flag ${name} is ${String(actual)}, not ${String(wanted)}`
}

/** Every flag a collection names: its own conditions and its steps'. */
export function flagsNamedIn(collection: {
  flags?: FlagConditions | undefined
  steps: Array<{ flags?: FlagConditions | undefined }>
}): string[] {
  return [
    ...new Set([
      ...Object.keys(collection.flags ?? {}),
      ...collection.steps.flatMap((step) => Object.keys(step.flags ?? {}))
    ])
  ].sort()
}

/**
 * A value typed on a command line or in an environment variable: `true` and
 * `false` are booleans, a number is a number, anything else is text.
 */
export function parseFlagValue(text: string): FlagValue {
  const trimmed = text.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return trimmed
}

/** Plain flag values from untrusted JSON (a command's output), or why not. */
export function flagValuesOf(parsed: unknown): FlagValues | string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'must print a JSON object of flag names to values, such as {"newCheckout": true}'
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      return `flag ${name} is ${value === null ? 'null' : typeof value}; a flag value is a string, number or boolean`
    }
  }
  return parsed as FlagValues
}
