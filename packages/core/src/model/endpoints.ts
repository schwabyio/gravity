import type { HttpMethod } from './documents.js'

/**
 * Which endpoint base a step's request is for (SPEC.md §2.6).
 *
 * An endpoint is a method and a path pattern — `GET /users/{id}` — where
 * `{name}` stands for one path segment. A step matches on its URL as written:
 * the host (or a leading `{{variable}}` standing for one) and the query string
 * are ignored, and a `{{variable}}` segment matches any `{name}`. So one base
 * serves every environment and every value.
 */

export interface EndpointPattern {
  method: HttpMethod
  /** `/users/{id}`: from the host, with `{name}` for one segment. */
  path: string
}

/** A URL as written, as the path segments an endpoint pattern is matched with. */
export function pathOf(url: string): string[] {
  let rest = url.trim().replace(/[?#].*$/, '')
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(rest)
  if (absolute) rest = rest.slice(absolute[0].length)
  else {
    // `{{baseUrl}}/users`: the leading variable is where the host goes.
    const leading = /^\{\{[^{}]+\}\}/.exec(rest)
    if (leading) rest = rest.slice(leading[0].length)
  }
  return rest.split('/').filter((segment) => segment !== '')
}

const isPlaceholder = (segment: string) => /^\{[A-Za-z_$][\w$]*\}$/.test(segment)
const hasVariable = (segment: string) => segment.includes('{{')

/**
 * How well `pattern` matches a URL's path, or null for not at all: the number
 * of literal segments that matched, so `/users/me` beats `/users/{id}`.
 */
export function matchPath(pattern: string, segments: string[]): number | null {
  const wanted = pathOf(pattern)
  if (wanted.length !== segments.length) return null
  let literal = 0
  for (const [index, want] of wanted.entries()) {
    const have = segments[index]!
    if (isPlaceholder(want)) continue
    if (hasVariable(have) || have !== want) return null
    literal++
  }
  return literal
}

/**
 * The endpoint a request is for: same method, a matching path, the most
 * specific when several match; among equals, the first listed.
 */
export function findEndpoint<T extends EndpointPattern>(
  method: string,
  url: string,
  endpoints: readonly T[]
): T | null {
  const segments = pathOf(url)
  let best: { endpoint: T; score: number } | null = null
  for (const endpoint of endpoints) {
    if (endpoint.method !== method) continue
    const score = matchPath(endpoint.path, segments)
    if (score !== null && (best === null || score > best.score)) best = { endpoint, score }
  }
  return best?.endpoint ?? null
}

/**
 * Which URL segments stand for each `{name}` of a matched pattern: the step's
 * own, as written, for resolving when the request runs.
 */
export function placeholdersOf(pattern: string, url: string): Record<string, string> {
  const wanted = pathOf(pattern)
  const segments = pathOf(url)
  const found: Record<string, string> = {}
  wanted.forEach((want, index) => {
    if (isPlaceholder(want)) found[want.slice(1, -1)] = segments[index] ?? ''
  })
  return found
}
