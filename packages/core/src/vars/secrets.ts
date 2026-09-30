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

/** Every string in the result with each secret's value replaced by `[secret: NAME]`. */
export function redact<T>(value: T, secrets: ReadonlyArray<[string, string]>): T {
  if (secrets.length === 0) return value
  const walk = (node: unknown): unknown => {
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
