import { xml } from '@codemirror/lang-xml'
import { foldService, matchBrackets, StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { jsonToken, type CodeTokenKind } from '@schwabyio/gravity-core/model'

/**
 * How a request body's editor reads its text, by the body's type.
 *
 * JSON is read token by token rather than by CodeMirror's JSON grammar: a body
 * holds `{{variables}}` bare, `"qty": {{qty}}`, which that grammar takes for an
 * error, colouring everything after it wrong. Here a variable is one more token,
 * and a string followed by `:` is a name — core's `jsonToken`, which docs'
 * fenced JSON is coloured by too. XML keeps its grammar: its variables
 * sit in text and attribute values, where XML allows them.
 */
export const bodyLanguage = (mode: string): Extension =>
  mode === 'json' ? [jsonLanguage, foldBrackets] : mode === 'xml' ? xml() : []

/** The editor's name for each kind of JSON token, which its highlighting colours. */
const STYLE: Record<CodeTokenKind, string | null> = {
  name: 'propertyName',
  string: 'string',
  number: 'number',
  literal: 'bool',
  punctuation: 'separator',
  keyword: null,
  function: null,
  comment: null,
  tag: null,
  attribute: null,
  meta: null
}

/** JSON, read as docs read it in the app and in a report: core's `jsonToken`. */
export const jsonLanguage = StreamLanguage.define<{ depth: number }>({
  name: 'json',
  startState: () => ({ depth: 0 }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    const { end, kind } = jsonToken(stream.string, stream.pos)
    const text = stream.string.slice(stream.pos, end)
    stream.pos = end
    if (text === '{' || text === '[') state.depth++
    else if (text === '}' || text === ']') state.depth = Math.max(0, state.depth - 1)
    if (text === '{' || text === '}') return 'brace'
    if (text === '[' || text === ']') return 'squareBracket'
    if (text === 'null') return 'null'
    // A variable is marked over this, as the URL marks one.
    return kind ? STYLE[kind] : null
  },
  // A level in from each bracket still open; a line starting with its close, back out.
  indent: (state, textAfter, context) =>
    (state.depth - (/^\s*[}\]]/.test(textAfter) ? 1 : 0)) * context.unit,
  languageData: { closeBrackets: { brackets: ['[', '{', '"'] } }
})

/** Fold an object or list from the line it opens on to its close. */
const foldBrackets = foldService.of((state, from, to) => {
  const line = state.doc.sliceString(from, to)
  for (let at = line.length - 1; at >= 0; at--) {
    if (line[at] !== '{' && line[at] !== '[') continue
    const match = matchBrackets(state, from + at, 1)
    if (match?.matched && match.end && match.end.from > to) {
      return { from: from + at + 1, to: match.end.from }
    }
  }
  return null
})
