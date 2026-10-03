import { parseEventStream } from './eventStream.js'
import type { ReceivedResponse } from './run.js'

/**
 * A response body as the object `expect.body` paths address (SPEC.md §3).
 *
 * JSON as itself, XML converted the way xtest converted it, an event stream
 * as its list of events, and text as the single property `plaintext`. Pure, so
 * the renderer shows exactly the object the engine asserted against.
 */
export type BodyObject = { ok: true; body: unknown } | { ok: false; message: string }

export function bodyAsObject(response: Pick<ReceivedResponse, 'body' | 'bodyKind'>): BodyObject {
  switch (response.bodyKind) {
    case 'json':
      try {
        return { ok: true, body: JSON.parse(response.body) }
      } catch (cause) {
        return {
          ok: false,
          message: `The body is labelled JSON but does not parse: ${(cause as Error).message}`
        }
      }
    case 'xml':
      try {
        return { ok: true, body: xmlToObject(response.body) }
      } catch (cause) {
        return { ok: false, message: `The XML body does not parse: ${(cause as Error).message}` }
      }
    case 'events':
      return { ok: true, body: parseEventStream(response.body) }
    case 'text':
    case 'html':
      return { ok: true, body: { plaintext: response.body } }
    case 'empty':
      return { ok: true, body: {} }
    case 'binary':
      return { ok: false, message: 'The body is binary, so it has no properties to assert on.' }
  }
}

/* ------------------------------------------------------------------- xml -- */

interface XmlElement {
  name: string
  children: XmlElement[]
  text: string
}

/**
 * Convert XML to an object with xtest's rules, which were xml2js with
 * `explicitArray: false` followed by stripping namespace data:
 *
 * - the root element is the single top-level key
 * - an element holding only text becomes that text; an empty one becomes `""`
 * - a repeated child becomes an array, a single one does not
 * - namespace prefixes are dropped from names, and attributes are discarded
 * - every value is a string
 *
 * A small hand parser rather than a dependency: the format layer has no XML
 * library, and this needs elements, text, CDATA and entities, nothing more.
 */
export function xmlToObject(xml: string): Record<string, unknown> {
  const root = parseXml(xml)
  return { [root.name]: elementValue(root) }
}

function elementValue(element: XmlElement): unknown {
  if (element.children.length === 0) return element.text
  const out: Record<string, unknown> = {}
  for (const child of element.children) {
    // An element's value is never itself an array, so an array here can only
    // be a repeated child that has already been collected.
    const value = elementValue(child)
    const existing = out[child.name]
    if (existing === undefined) out[child.name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[child.name] = [existing, value]
  }
  // Mixed content: xml2js kept meaningful text beside children under `_`.
  if (element.text.trim() !== '') out['_'] = element.text
  return out
}

const stripPrefix = (name: string): string => name.slice(name.indexOf(':') + 1)

function parseXml(xml: string): XmlElement {
  let i = 0
  const stack: XmlElement[] = []
  let root: XmlElement | null = null

  const fail = (message: string): never => {
    throw new Error(`${message} at offset ${i}`)
  }

  while (i < xml.length) {
    if (xml.startsWith('<?', i)) {
      i = indexAfter(xml, '?>', i) ?? fail('Unterminated processing instruction')
    } else if (xml.startsWith('<!--', i)) {
      i = indexAfter(xml, '-->', i) ?? fail('Unterminated comment')
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i)
      if (end < 0) fail('Unterminated CDATA section')
      if (stack.length > 0) stack[stack.length - 1]!.text += xml.slice(i + 9, end)
      i = end + 3
    } else if (xml.startsWith('<!', i)) {
      i = indexAfter(xml, '>', i) ?? fail('Unterminated declaration')
    } else if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i)
      if (end < 0) fail('Unterminated closing tag')
      const name = stripPrefix(xml.slice(i + 2, end).trim())
      const open = stack.pop() ?? fail(`Unexpected closing tag </${name}>`)
      if (open.name !== name) fail(`Expected </${open.name}>, found </${name}>`)
      i = end + 1
    } else if (xml[i] === '<') {
      const end = tagEnd(xml, i) ?? fail('Unterminated tag')
      const inner = xml.slice(i + 1, end)
      const selfClosing = inner.endsWith('/')
      const name = stripPrefix(
        (selfClosing ? inner.slice(0, -1) : inner).trim().split(/\s+/)[0] ?? ''
      )
      if (name === '') fail('Tag without a name')
      const element: XmlElement = { name, children: [], text: '' }
      if (stack.length > 0) stack[stack.length - 1]!.children.push(element)
      else if (root) fail('More than one root element')
      else root = element
      if (!selfClosing) stack.push(element)
      i = end + 1
    } else {
      const next = xml.indexOf('<', i)
      const raw = xml.slice(i, next < 0 ? xml.length : next)
      if (stack.length > 0) stack[stack.length - 1]!.text += decodeEntities(raw)
      else if (raw.trim() !== '') fail('Text outside the root element')
      i = next < 0 ? xml.length : next
    }
  }

  if (stack.length > 0) fail(`Unclosed element <${stack[stack.length - 1]!.name}>`)
  return root ?? fail('No root element')
}

function indexAfter(text: string, token: string, from: number): number | null {
  const at = text.indexOf(token, from)
  return at < 0 ? null : at + token.length
}

/** The `>` closing a tag, skipping any inside quoted attribute values. */
function tagEnd(xml: string, from: number): number | null {
  let quote: string | null = null
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return null
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)))
    return NAMED[entity] ?? whole
  })
}
