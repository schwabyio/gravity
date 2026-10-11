import { describe, expect, it } from 'vitest'
import { ensureSyntaxTree, foldable, getIndentation } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { bodyLanguage } from './bodyLanguage.js'

const stateOf = (doc: string, mode = 'json') =>
  EditorState.create({ doc, extensions: [bodyLanguage(mode)] })

const highlighter = tagHighlighter([
  { tag: tags.propertyName, class: 'name' },
  { tag: tags.string, class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: tags.bool, class: 'bool' },
  { tag: tags.null, class: 'null' },
  { tag: tags.tagName, class: 'tag' },
  { tag: tags.attributeName, class: 'attribute' },
  { tag: tags.attributeValue, class: 'value' }
])

/** Each token the body's text is read as, and what it is read as, in order. */
function tokens(doc: string, mode = 'json'): Array<[string, string]> {
  const tree = ensureSyntaxTree(stateOf(doc, mode), doc.length, 5_000)!
  const found: Array<[string, string]> = []
  highlightTree(tree, highlighter, (from, to, kind) => found.push([doc.slice(from, to), kind]))
  return found
}

/** The indentation the line at `line` (from 1) gets. */
const indentOf = (doc: string, line: number) => {
  const state = stateOf(doc)
  ensureSyntaxTree(state, doc.length, 5_000)
  return getIndentation(state, state.doc.line(line).from)
}

/** What folds from the line at `line` (from 1), as the text folded away. */
const foldOf = (doc: string, line: number) => {
  const state = stateOf(doc)
  const { from, to } = state.doc.line(line)
  const range = foldable(state, from, to)
  return range && doc.slice(range.from, range.to)
}

describe('bodyLanguage: JSON', () => {
  it('reads names, strings, numbers and literals', () => {
    expect(tokens('{"a": "s", "b": [-1.5e3, true, false, null]}')).toEqual([
      ['"a"', 'name'],
      ['"s"', 'string'],
      ['"b"', 'name'],
      ['-1.5e3', 'number'],
      ['true', 'bool'],
      ['false', 'bool'],
      ['null', 'null']
    ])
  })

  it('reads a bare variable as one token, and what follows it as before', () => {
    // CodeMirror's JSON grammar took `{{qty}}` for an error, and "price" for a string.
    expect(tokens('{"qty": {{qty}}, "price": 1.0, "sku": "{{sku}}"}')).toEqual([
      ['"qty"', 'name'],
      ['"price"', 'name'],
      ['1.0', 'number'],
      ['"sku"', 'name'],
      ['"{{sku}}"', 'string']
    ])
  })

  it('takes a string for a name only when a colon follows it', () => {
    expect(tokens('{"a:b" : "c:d", "e": "\\"f\\":"}')).toEqual([
      ['"a:b"', 'name'],
      ['"c:d"', 'string'],
      ['"e"', 'name'],
      ['"\\"f\\":"', 'string']
    ])
  })

  it('indents a level for each bracket still open, and back out for a close', () => {
    const doc = '{\n"a": [\n1,\n{\n"b": 2\n}\n]\n}'
    expect([2, 3, 4, 5, 6, 7, 8].map((line) => indentOf(doc, line))).toEqual([2, 4, 4, 6, 4, 2, 0])
  })

  it('folds an object or list from the line it opens on to its close', () => {
    const doc = '{\n  "a": [1, 2],\n  "b": {\n    "c": 1\n  },\n  "note": "a { b"\n}'
    expect(foldOf(doc, 1)).toBe(doc.slice(1, -1))
    // Closed on its own line: nothing to fold.
    expect(foldOf(doc, 2)).toBeNull()
    expect(foldOf(doc, 3)).toBe('\n    "c": 1\n  ')
    // A brace in a string is text.
    expect(foldOf(doc, 6)).toBeNull()
  })
})

describe('bodyLanguage: other types', () => {
  it('reads XML with its own grammar: tags, attributes and their values', () => {
    expect(tokens('<a id="{{id}}">x</a>', 'xml')).toEqual([
      ['a', 'tag'],
      ['id', 'attribute'],
      ['"{{id}}"', 'value'],
      ['a', 'tag']
    ])
  })

  it('reads text and form bodies as plain text, with no grammar at all', () => {
    for (const mode of ['text', 'form']) {
      expect(ensureSyntaxTree(stateOf('{"a": 1}', mode), 8, 5_000)).toBeNull()
    }
  })
})
