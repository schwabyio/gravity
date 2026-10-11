import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import type { Language } from '@codemirror/language'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import {
  codeTokens,
  markCode,
  type CodeMark,
  type CodeToken,
  type CodeTokenKind
} from '@schwabyio/gravity-core/model'

/** The scripting languages a fence may name, which the app colours and a report does not. */
const SCRIPTS: Record<string, Language> = {
  js: javascriptLanguage,
  javascript: javascriptLanguage,
  mjs: javascriptLanguage,
  cjs: javascriptLanguage,
  ts: typescriptLanguage,
  typescript: typescriptLanguage
}

/** CodeMirror's tags as core's kinds, coloured as the scripts' editor colours them. */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: [tags.bool, tags.null], class: 'literal' },
  { tag: tags.comment, class: 'comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'function' },
  { tag: [tags.operator, tags.punctuation], class: 'punctuation' }
])

/**
 * A docs code block, token by token with its variables marked: JSON and XML
 * read by core, as a report reads them; JavaScript and TypeScript by
 * CodeMirror's grammar, as the scripts' editor reads them; anything else plain.
 */
export function docCodeMarks(text: string, language: string | null): CodeMark[] {
  const script = language ? SCRIPTS[language.toLowerCase()] : undefined
  const tokens = script
    ? scriptTokens(text, script)
    : (codeTokens(text, language) ?? [{ text, kind: null }])
  return markCode(tokens)
}

function scriptTokens(text: string, language: Language): CodeToken[] {
  const tokens: CodeToken[] = []
  let at = 0
  highlightTree(language.parser.parse(text), highlighter, (from, to, classes) => {
    if (from > at) tokens.push({ text: text.slice(at, from), kind: null })
    tokens.push({ text: text.slice(from, to), kind: classes.split(' ')[0] as CodeTokenKind })
    at = to
  })
  if (at < text.length) tokens.push({ text: text.slice(at), kind: null })
  return tokens
}
