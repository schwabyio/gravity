import { Buffer } from 'node:buffer'
import { environmentLayer, type ScopeContext } from './resolve.js'

/**
 * The values of the environment's secrets, by name, longest first.
 *
 * SPEC.md §6: a secret is never written to a report. Its resolved value is in
 * what was sent — an `Authorization` header — and can come back in what was
 * received, a log line or an assertion's actual value, so every report `gta`
 * writes, the console included, is made from a redacted result, and the app
 * shows a request as sent with its secrets hidden.
 */
export async function secretValues(
  context: Pick<ScopeContext, 'collectionPath' | 'environmentName' | 'env' | 'environments'>
): Promise<Array<[string, string]>> {
  if (!context.environmentName) return []
  try {
    const layer = await environmentLayer(context, context.environmentName)
    return (layer.secrets ?? [])
      .flatMap((name): Array<[string, string]> => {
        const value = layer.vars[name]
        return value === undefined || value === null || String(value) === ''
          ? []
          : [[name, String(value)]]
      })
      .sort((a, b) => b[1].length - a[1].length)
  } catch {
    // A secret with no value fails the run itself, which says so.
    return []
  }
}

/**
 * Every string in the result with each secret's value replaced by `[secret: NAME]`.
 *
 * A body kept as base64 would hide a secret from that, so one whose bytes hold a
 * secret is read as text instead, and redacted as text is.
 */
export function redact<T>(value: T, secrets: ReadonlyArray<[string, string]>): T {
  if (secrets.length === 0) return value
  const walk = (node: unknown): unknown => {
    if (isBase64Body(node)) {
      const bytes = Buffer.from(node.body, 'base64')
      if (secrets.some(([, secret]) => bytes.includes(Buffer.from(secret)))) {
        const { bodyEncoding: _base64, ...asText } = node
        return walk({ ...asText, body: bytes.toString('utf8') })
      }
      // Its base64 holds no secret's text: the rest of the response still may.
      return Object.fromEntries(
        Object.entries(node).map(([key, inner]) => [key, key === 'body' ? inner : walk(inner)])
      )
    }
    if (typeof node === 'string') {
      return secrets.reduce(
        (text, [name, secret]) => text.split(secret).join(`[secret: ${name}]`),
        node
      )
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)]))
    }
    return node
  }
  return walk(value) as T
}

const isBase64Body = (node: unknown): node is { body: string; bodyEncoding: 'base64' } =>
  node !== null &&
  typeof node === 'object' &&
  (node as { bodyEncoding?: unknown }).bodyEncoding === 'base64' &&
  typeof (node as { body?: unknown }).body === 'string'
