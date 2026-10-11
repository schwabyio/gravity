import { xml } from '@codemirror/lang-xml'
import { foldService, matchBrackets, StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/**
 * How a request body's editor reads its text, by the body's type.
 *
 * JSON is read token by token rather than by CodeMirror's JSON grammar: a body
 * holds `{{variables}}` bare, `"qty": {{qty}}`, which that grammar takes for an
 * error, colouring everything after it wrong. Here a variable is one more token,
 * and a string followed by `:` is a name. XML keeps its grammar: its variables
 * sit in text and attribute values, where XML allows them.
 */
export const bodyLanguage = (mode: string): Extension =>
  mode === 'json' ? [json, foldBrackets] : mode === 'xml' ? xml() : []

const json = StreamLanguage.define<{ depth: number }>({
  name: 'json',
  startState: () => ({ depth: 0 }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    // Marked as a variable over this, as the URL marks one.
    if (stream.match(/^\{\{[^{}]*\}\}/)) return null
    const char = stream.next()!
    if (char === '"') {
      let escaped = false
      for (let next = stream.next(); next !== undefined; next = stream.next()) {
        if (escaped) escaped = false
        else if (next === '\\') escaped = true
        else if (next === '"') break
      }
      return stream.match(/^\s*:/, false) ? 'propertyName' : 'string'
    }
    if (char === '-' || /\d/.test(char)) {
      stream.match(/^\d*(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      return 'number'
    }
    if (/[a-z]/.test(char)) {
      const word = char + (stream.match(/^[a-z]*/) as RegExpMatchArray)[0]
      return word === 'true' || word === 'false' ? 'bool' : word === 'null' ? 'null' : null
    }
    if (char === '{' || char === '[') state.depth++
    else if (char === '}' || char === ']') state.depth = Math.max(0, state.depth - 1)
    if (char === '{' || char === '}') return 'brace'
    if (char === '[' || char === ']') return 'squareBracket'
    return char === ',' || char === ':' ? 'separator' : null
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
