import { HTTP_METHODS, type HttpMethod } from './documents.js'

/**
 * What a renderer of docs colours (markdown.ts parses them): `{{variables}}`,
 * as the app's URL bar marks them; an HTTP method or a status code in inline
 * code, in its method or status colour; and fenced JSON and XML, token by
 * token. The desktop app and `gta`'s HTML report both colour docs from these,
 * so the two mark the same text the same way.
 *
 * Marking never changes the text: the pieces, joined, are what was written.
 */

/** A run of docs text, and what it is marked as. */
export type TextMark =
  | { text: string; mark: null }
  | { text: string; mark: 'variable' }
  | { text: string; mark: 'method'; method: HttpMethod }
  | { text: string; mark: 'status'; status: StatusClass }

/** A status code's class: `2xx` for 201, and for `2xx` written so. */
export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx'

const VARIABLE = /\{\{\s*[^{}\s]+\s*\}\}/g

/** Text with each `{{variable}}` in it marked. */
export function markText(text: string): TextMark[] {
  const marks: TextMark[] = []
  let at = 0
  for (const match of text.matchAll(VARIABLE)) {
    if (match.index > at) marks.push({ text: text.slice(at, match.index), mark: null })
    marks.push({ text: match[0], mark: 'variable' })
    at = match.index + match[0].length
  }
  if (at < text.length || marks.length === 0) marks.push({ text: text.slice(at), mark: null })
  return marks
}

/**
 * Inline code: a method it starts with, `GET /orders`, in that method's colour;
 * code that is a status code, `201` or `404 Not Found` or `5xx`, in its class's
 * colour; and its variables marked.
 */
export function markInlineCode(text: string): TextMark[] {
  const status = /^([1-5])(?:\d\d|xx)(?:\s+[A-Za-z][\w -]*)?$/.exec(text)
  if (status) return [{ text, mark: 'status', status: `${status[1]}xx` as StatusClass }]
  const method = HTTP_METHODS.find(
    (name) =>
      text.startsWith(name) && (text.length === name.length || /\s/.test(text[name.length]!))
  )
  if (!method) return markText(text)
  const rest = text.slice(method.length)
  return [{ text: method, mark: 'method', method }, ...(rest ? markText(rest) : [])]
}

/* ------------------------------------------------------------------ code -- */

/** What a token of code is, for its colour. */
export type CodeTokenKind =
  | 'name'
  | 'string'
  | 'number'
  | 'literal'
  | 'keyword'
  | 'function'
  | 'comment'
  | 'punctuation'
  | 'tag'
  | 'attribute'
  | 'meta'

/** A token of code; `null` for text that is not coloured. */
export interface CodeToken {
  text: string
  kind: CodeTokenKind | null
}

/** A token of code, or the part of one, that is or is not a `{{variable}}`. */
export interface CodeMark extends CodeToken {
  variable: boolean
}

/**
 * Fenced code read token by token, for a language core reads: JSON (`json`) and
 * XML (`xml`). Null for any other: a renderer that reads more, as the app reads
 * JavaScript, colours it itself, and otherwise shows it plain.
 */
export function codeTokens(text: string, language: string | null): CodeToken[] | null {
  const name = language?.toLowerCase()
  if (name === 'json') return jsonTokens(text)
  if (name === 'xml') return xmlTokens(text)
  return null
}

/** Tokens with each `{{variable}}` inside them marked, keeping each token's kind. */
export function markCode(tokens: CodeToken[]): CodeMark[] {
  return tokens.flatMap((token) =>
    markText(token.text).map((piece) => ({
      text: piece.text,
      kind: token.kind,
      variable: piece.mark === 'variable'
    }))
  )
}

/**
 * The JSON token at `at`, which is not whitespace: where it ends, and what it
 * is. A `{{variable}}` is one token of no kind, so a body before its variables
 * resolve, `"qty": {{qty}}`, reads as it will after; a string followed by a
 * colon is a name. The request body's editor reads JSON with this too.
 */
export function jsonToken(source: string, at: number): { end: number; kind: CodeTokenKind | null } {
  const char = source[at]!
  if (source.startsWith('{{', at)) {
    const close = source.indexOf('}}', at + 2)
    if (close >= 0 && !/[{}]/.test(source.slice(at + 2, close)))
      return { end: close + 2, kind: null }
  }
  if (char === '"') {
    let end = at + 1
    for (let escaped = false; end < source.length && source[end] !== '\n'; end++) {
      if (escaped) escaped = false
      else if (source[end] === '\\') escaped = true
      else if (source[end] === '"') {
        end++
        break
      }
    }
    return { end, kind: /^\s*:/.test(source.slice(end)) ? 'name' : 'string' }
  }
  const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at))?.[0]
  if (number) return { end: at + number.length, kind: 'number' }
  const word = /^[a-z]+/.exec(source.slice(at))?.[0]
  if (word) {
    const literal = word === 'true' || word === 'false' || word === 'null'
    return { end: at + word.length, kind: literal ? 'literal' : null }
  }
  return { end: at + 1, kind: '{}[],:'.includes(char) ? 'punctuation' : null }
}

function jsonTokens(text: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let at = 0
  while (at < text.length) {
    const space = /^\s+/.exec(text.slice(at))?.[0]
    if (space) {
      tokens.push({ text: space, kind: null })
      at += space.length
      continue
    }
    const { end, kind } = jsonToken(text, at)
    tokens.push({ text: text.slice(at, end), kind })
    at = end
  }
  return tokens
}

/** XML: tags and their attributes, values, comments, declarations; text plain. */
function xmlTokens(text: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const push = (piece: string, kind: CodeTokenKind | null) => {
    if (piece) tokens.push({ text: piece, kind })
  }
  /** From `at` through `end`, or to the end of the text when it never comes. */
  const through = (at: number, end: string) => {
    const found = text.indexOf(end, at)
    return found < 0 ? text.length : found + end.length
  }
  let at = 0
  while (at < text.length) {
    if (text[at] !== '<') {
      const next = text.indexOf('<', at)
      const end = next < 0 ? text.length : next
      push(text.slice(at, end), null)
      at = end
      continue
    }
    const special = text.startsWith('<!--', at)
      ? { end: '-->', kind: 'comment' as const }
      : text.startsWith('<![CDATA[', at)
        ? { end: ']]>', kind: 'string' as const }
        : text.startsWith('<?', at) || text.startsWith('<!', at)
          ? { end: '>', kind: 'meta' as const }
          : null
    if (special) {
      const end = through(at, special.end)
      push(text.slice(at, end), special.kind)
      at = end
      continue
    }
    // A tag: its bracket, name, attributes and values, and its close.
    const open = text.startsWith('</', at) ? '</' : '<'
    push(open, 'punctuation')
    at += open.length
    const name = /^[^\s/>]*/.exec(text.slice(at))![0]
    push(name, 'tag')
    at += name.length
    while (at < text.length) {
      const rest = text.slice(at)
      const piece =
        /^\s+/.exec(rest)?.[0] ??
        (rest.startsWith('/>') ? '/>' : rest[0] === '>' || rest[0] === '=' ? rest[0] : null)
      if (piece) {
        push(piece, piece.trim() === '' ? null : 'punctuation')
        at += piece.length
        if (piece.endsWith('>')) break
        continue
      }
      if (rest[0] === '"' || rest[0] === "'") {
        const close = text.indexOf(rest[0], at + 1)
        const end = close < 0 ? text.length : close + 1
        push(text.slice(at, end), 'string')
        at = end
        continue
      }
      const attribute = /^[^\s=/>"']+/.exec(rest)?.[0] ?? rest[0]!
      push(attribute, 'attribute')
      at += attribute.length
    }
  }
  return tokens
}
