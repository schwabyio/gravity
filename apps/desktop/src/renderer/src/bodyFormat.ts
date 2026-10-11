/**
 * Beautify a request body: JSON or XML indented two spaces a level.
 *
 * Only the whitespace between tokens changes. Every string, number and tag is
 * kept as written — `1.0` stays `1.0`, a long id keeps its digits — so a body
 * beautified sends the same values. A `{{variable}}` is kept too, quoted or
 * not: `"count": {{count}}` is a body before its variables resolve.
 */

export type Beautified = { ok: true; text: string } | { ok: false; message: string }

const INDENT = '  '

/** Line and column, from 1, of an offset into `text`. */
function where(text: string, offset: number): string {
  const before = text.slice(0, offset).split('\n')
  return `line ${before.length}, column ${before[before.length - 1]!.length + 1}`
}

class BodyError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(message)
  }
}

/* ------------------------------------------------------------------ JSON -- */

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const LITERAL = /true|false|null/y
const VARIABLE = /\{\{[^{}]*\}\}/y

export function beautifyJson(source: string): Beautified {
  let at = 0

  const space = () => {
    while (at < source.length && ' \t\n\r'.includes(source[at]!)) at++
  }
  const fail = (what: string): never => {
    throw new BodyError(at >= source.length ? `${what}, but the body ends` : what, at)
  }
  const match = (pattern: RegExp): string | null => {
    pattern.lastIndex = at
    const found = pattern.exec(source)
    if (!found) return null
    at += found[0].length
    return found[0]
  }
  const string = (): string => {
    const start = at++
    while (at < source.length && source[at] !== '"') {
      if (source[at] === '\n') throw new BodyError('A string runs past the end of its line', at)
      at += source[at] === '\\' ? 2 : 1
    }
    if (at >= source.length) throw new BodyError('A string is never closed', start)
    at++
    return source.slice(start, at)
  }
  /** A key: a string, or a variable that names one. */
  const key = (): string =>
    source[at] === '"' ? string() : (match(VARIABLE) ?? fail('Expected a quoted name'))

  const value = (depth: number): string => {
    space()
    // `{{` is a variable, not an object: an object's first name is quoted.
    const variable = match(VARIABLE)
    if (variable) return variable
    const char = source[at]
    if (char === '{' || char === '[') return container(depth, char)
    if (char === '"') return string()
    return match(NUMBER) ?? match(LITERAL) ?? fail('Expected a value')
  }
  const container = (depth: number, open: '{' | '['): string => {
    const close = open === '{' ? '}' : ']'
    at++
    space()
    if (source[at] === close) {
      at++
      return open + close
    }
    const inner = INDENT.repeat(depth + 1)
    const items: string[] = []
    for (;;) {
      if (open === '{') {
        space()
        const name = key()
        space()
        if (source[at] !== ':') fail('Expected : after a name')
        at++
        items.push(`${inner}${name}: ${value(depth + 1)}`)
      } else {
        items.push(inner + value(depth + 1))
      }
      space()
      if (source[at] === ',') {
        at++
        continue
      }
      if (source[at] === close) {
        at++
        return `${open}\n${items.join(',\n')}\n${INDENT.repeat(depth)}${close}`
      }
      fail(`Expected , or ${close}`)
    }
  }

  try {
    const text = value(0)
    space()
    if (at < source.length) fail('Expected the body to end')
    return { ok: true, text }
  } catch (error) {
    if (!(error instanceof BodyError)) throw error
    return {
      ok: false,
      message: `Not valid JSON: ${error.message} (${where(source, error.offset)})`
    }
  }
}

/* ------------------------------------------------------------------- XML -- */

type XmlNode =
  | { kind: 'element'; open: string; name: string; close: string; children: XmlNode[] }
  | { kind: 'empty'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'other'; text: string }

export function beautifyXml(source: string): Beautified {
  let at = 0

  /** From `at` to just past `end`, or an error that `what` is never closed. */
  const through = (end: string, what: string): string => {
    const found = source.indexOf(end, at)
    if (found < 0) throw new BodyError(`${what} is never closed`, at)
    const text = source.slice(at, found + end.length)
    at = found + end.length
    return text
  }
  /** A tag, `<` to `>`, past any `>` inside a quoted attribute value. */
  const tag = (): string => {
    const start = at
    let quote: string | null = null
    for (at++; at < source.length; at++) {
      const char = source[at]!
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') return source.slice(start, ++at)
      else if (char === '<') break
    }
    throw new BodyError('A tag is never closed', start)
  }
  /** `<!DOCTYPE …>`, its internal subset in brackets included. */
  const doctype = (): string => {
    const start = at
    let depth = 0
    for (; at < source.length; at++) {
      const char = source[at]
      if (char === '[') depth++
      else if (char === ']') depth--
      else if (char === '>' && depth === 0) return source.slice(start, ++at)
    }
    throw new BodyError('A DOCTYPE is never closed', start)
  }
  const nameOf = (text: string): string => /^<\/?([^\s/>]+)/.exec(text)?.[1] ?? ''

  const root: XmlNode[] = []
  const open: Array<{ node: Extract<XmlNode, { kind: 'element' }>; offset: number }> = []
  const add = (node: XmlNode) => (open[open.length - 1]?.node.children ?? root).push(node)

  try {
    while (at < source.length) {
      if (source[at] !== '<') {
        const end = source.indexOf('<', at)
        const stop = end < 0 ? source.length : end
        add({ kind: 'text', text: source.slice(at, stop) })
        at = stop
      } else if (source.startsWith('<!--', at)) {
        add({ kind: 'other', text: through('-->', 'A comment') })
      } else if (source.startsWith('<![CDATA[', at)) {
        add({ kind: 'text', text: through(']]>', 'A CDATA section') })
      } else if (source.startsWith('<?', at)) {
        add({ kind: 'other', text: through('?>', 'A declaration') })
      } else if (source.startsWith('<!', at)) {
        add({ kind: 'other', text: doctype() })
      } else if (source.startsWith('</', at)) {
        const offset = at
        const text = tag()
        const current = open.pop()
        if (!current) throw new BodyError(`${text} closes nothing`, offset)
        if (nameOf(text) !== current.node.name) {
          throw new BodyError(`${text} closes <${current.node.name}>`, offset)
        }
        current.node.close = text
      } else {
        const offset = at
        const text = tag()
        if (text.endsWith('/>')) add({ kind: 'empty', text })
        else {
          const node = {
            kind: 'element' as const,
            open: text,
            name: nameOf(text),
            close: '',
            children: []
          }
          add(node)
          open.push({ node, offset })
        }
      }
    }
    const unclosed = open.pop()
    if (unclosed) throw new BodyError(`<${unclosed.node.name}> is never closed`, unclosed.offset)
  } catch (error) {
    if (!(error instanceof BodyError)) throw error
    return {
      ok: false,
      message: `Not valid XML: ${error.message} (${where(source, error.offset)})`
    }
  }

  const lines: string[] = []
  const print = (nodes: XmlNode[], depth: number) => {
    const indent = INDENT.repeat(depth)
    for (const node of nodes) {
      if (node.kind === 'text') {
        // Between tags, only text that is more than layout gets a line.
        if (node.text.trim() !== '') lines.push(indent + node.text.trim())
      } else if (node.kind !== 'element') lines.push(indent + node.text)
      else if (node.children.every((child) => child.kind === 'text')) {
        // Text alone stays inside its tags: it is the value. Laid out over lines, it
        // comes in from the ends; on one line, it stays as written.
        const text = node.children.map((child) => child.text).join('')
        lines.push(indent + node.open + (text.includes('\n') ? text.trim() : text) + node.close)
      } else {
        lines.push(indent + node.open)
        print(node.children, depth + 1)
        lines.push(indent + node.close)
      }
    }
  }
  print(root, 0)
  return { ok: true, text: lines.join('\n') }
}

/** The beautifier for a body type, if it has one. */
export function beautifierFor(mode: string): ((source: string) => Beautified) | null {
  return mode === 'json' ? beautifyJson : mode === 'xml' ? beautifyXml : null
}
