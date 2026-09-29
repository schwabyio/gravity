import YAML from 'yaml'

/**
 * Set a value in a YAML document, changing as little of the tree as it can.
 *
 * `document.setIn` replaces the node at `path` with a fresh one, which drops
 * every comment inside it and re-quotes every string. Here, when the node there
 * is a map and the value a plain object, it is patched key by key instead:
 * removed keys go, changed scalars get their new value in their old node, new
 * keys are added at the end, and an untouched key is not touched at all.
 * Anything else — a list, a change of kind — is replaced as `setIn` would.
 */
export function patchIn(
  document: YAML.Document,
  path: ReadonlyArray<string | number>,
  value: unknown
): void {
  const node = path.length === 0 ? document.contents : document.getIn(path, true)
  if (YAML.isMap(node) && isPlainObject(value)) patchMap(document, node, value)
  else if (YAML.isScalar(node) && isScalarValue(value) && typeof node.value === typeof value) {
    node.value = value
  } else document.setIn(path, value)
}

function patchMap(document: YAML.Document, map: YAML.YAMLMap, value: Record<string, unknown>) {
  const keyOf = (pair: YAML.Pair) => (YAML.isScalar(pair.key) ? String(pair.key.value) : '')
  map.items = map.items.filter((pair) => keyOf(pair) in value)
  for (const [key, next] of Object.entries(value)) {
    if (next === undefined) {
      map.delete(key)
      continue
    }
    const pair = map.items.find((item) => keyOf(item) === key)
    if (!pair) {
      map.set(key, nodeFor(document, next))
      continue
    }
    const current = pair.value
    if (YAML.isMap(current) && isPlainObject(next)) patchMap(document, current, next)
    else if (
      YAML.isScalar(current) &&
      isScalarValue(next) &&
      typeof current.value === typeof next
    ) {
      if (current.value !== next) current.value = next
    } else if (!same(YAML.isNode(current) ? current.toJS(document) : current, next)) {
      pair.value = nodeFor(document, next)
    }
  }
}

/**
 * A new node for an entry of a map. A small map of plain values — a header's
 * or a variable's long form — goes on one line, `{ secret: true }`, the way
 * SPEC.md writes it.
 */
function nodeFor(document: YAML.Document, value: unknown) {
  const node = document.createNode(value)
  if (YAML.isMap(node) && node.items.every((pair) => YAML.isScalar(pair.value))) node.flow = true
  return node
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isScalarValue = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)
