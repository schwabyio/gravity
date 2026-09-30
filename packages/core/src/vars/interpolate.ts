import type { VarValue } from '../model/documents.js'
import type { VariableScope } from './scope.js'
import { BUILT_INS, InterpolationError } from './scope.js'

/** `{{ name }}` — whitespace around the name is ignored. */
const REFERENCE = /\{\{\s*([^{}\s]+)\s*\}\}/g

/** A string that is nothing but one reference, so the value keeps its type. */
const SOLE_REFERENCE = /^\{\{\s*([^{}\s]+)\s*\}\}$/

/** How deep a chain of variables referring to variables may go. */
const MAX_DEPTH = 16

/**
 * Resolve `{{name}}` references, preserving type where it is unambiguous.
 *
 * A string that is exactly one reference returns the variable's own value, so a
 * variable authored as `true` arrives as a boolean. Anything else is a string,
 * because `"v{{n}}"` has no meaningful non-string result.
 *
 * An unknown variable is an error rather than being left as literal text. A
 * request sent to `{{baseUrl}}/users` because a variable was missing fails in a
 * way that takes far longer to understand than being told which name is unset.
 */
export function interpolate(
  value: string,
  scope: VariableScope,
  options: TextOptions = {}
): VarValue {
  const sole = SOLE_REFERENCE.exec(value)
  if (sole?.[1]) {
    const resolved = resolveName(sole[1], scope, [])
    return typeof resolved === 'string'
      ? resolveString(resolved, scope, [sole[1]], options)
      : resolved
  }
  return resolveString(value, scope, [], options)
}

export interface TextOptions {
  /**
   * How `null` is written into text: empty, the default, or as `null` in a
   * JSON body, where it is JSON's own null (SPEC.md §4).
   */
  nullAs?: string
}

/** Resolve to a string, for a URL or a header value. */
export function interpolateToString(
  value: string,
  scope: VariableScope,
  options: TextOptions = {}
): string {
  const result = interpolate(value, scope, options)
  return result === null || result === undefined ? (options.nullAs ?? '') : String(result)
}

function resolveString(
  text: string,
  scope: VariableScope,
  seen: string[],
  options: TextOptions
): string {
  if (seen.length > MAX_DEPTH) {
    throw new InterpolationError(
      `Variable nesting is too deep (${seen.join(' -> ')}); this is probably a loop`
    )
  }

  return text.replace(REFERENCE, (_whole, name: string) => {
    if (seen.includes(name)) {
      throw new InterpolationError(
        `Variable "${name}" refers to itself: ${[...seen, name].join(' -> ')}`,
        name
      )
    }
    const resolved = resolveName(name, scope, seen)
    if (resolved === null || resolved === undefined) return options.nullAs ?? ''
    return typeof resolved === 'string'
      ? resolveString(resolved, scope, [...seen, name], options)
      : String(resolved)
  })
}

function resolveName(name: string, scope: VariableScope, seen: string[]): VarValue {
  const builtIn = BUILT_INS[name]
  if (builtIn) return builtIn()

  if (!scope.has(name)) {
    const known = scope.names().filter((candidate) => candidate.startsWith(name.slice(0, 3)))
    const hint = known.length > 0 ? ` Did you mean ${known.slice(0, 3).join(', ')}?` : ''
    throw new InterpolationError(
      `Variable "${name}" is not defined in this environment.${hint}`,
      name
    )
  }

  const value = scope.get(name) as VarValue
  if (typeof value === 'string' && seen.length === 0 && REFERENCE.test(value)) {
    REFERENCE.lastIndex = 0
  }
  return value
}

/** Walk a structure, interpolating every string in it. */
export function interpolateDeep<T>(value: T, scope: VariableScope): T {
  if (typeof value === 'string') return interpolate(value, scope) as T
  // A RegExp (from any realm) has nothing to interpolate and no own entries.
  if (Object.prototype.toString.call(value) === '[object RegExp]') return value
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, scope)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, scope)])
    ) as T
  }
  return value
}
