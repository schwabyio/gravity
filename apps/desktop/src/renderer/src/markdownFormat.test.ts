import { describe, expect, it } from 'vitest'
import { formatMarkdown, type MarkdownFormat } from './markdownFormat.js'

/**
 * A tool used on text with its selection written in: `[` and `]` round what is
 * selected, `|` for a cursor. Returns the text after, written the same way.
 */
function use(format: MarkdownFormat, written: string): string {
  const cursor = written.indexOf('|')
  const from = cursor >= 0 ? cursor : written.indexOf('[')
  const to = cursor >= 0 ? cursor : written.indexOf(']') - 1
  const text = written.replace(cursor >= 0 ? '|' : /[[\]]/g, '')
  const { edits, anchor, head } = formatMarkdown(text, from, to, format)
  let after = text
  for (const edit of [...edits].reverse()) {
    after = after.slice(0, edit.from) + edit.insert + after.slice(edit.to)
  }
  return anchor === head
    ? `${after.slice(0, anchor)}|${after.slice(anchor)}`
    : `${after.slice(0, anchor)}[${after.slice(anchor, head)}]${after.slice(head)}`
}

describe('bold, italic and inline code', () => {
  it('marks either side of the selection, which stays on the text', () => {
    expect(use('bold', 'make [this] stand out')).toBe('make **[this]** stand out')
    expect(use('italic', 'make [this] lean')).toBe('make _[this]_ lean')
    expect(use('code', 'call [gta.set] first')).toBe('call `[gta.set]` first')
  })

  it('takes the marks off what it marked', () => {
    expect(use('bold', 'make **[this]** plain')).toBe('make [this] plain')
    expect(use('bold', 'make [**this**] plain')).toBe('make [this] plain')
    expect(use('italic', 'make _[this]_ plain')).toBe('make [this] plain')
  })

  it('leaves the spaces a double-click took outside the marks', () => {
    expect(use('bold', 'make [this ]stand out')).toBe('make **[this]** stand out')
  })

  it('marks the word the cursor is in, or takes them off it', () => {
    expect(use('bold', 'make th|is stand out')).toBe('make **[this]** stand out')
    expect(use('bold', 'make **th|is** plain')).toBe('make [this] plain')
    expect(use('italic', 'a snake_c|ase name')).toBe('a _[snake_case]_ name')
  })

  it('puts a pair to type between where there is no word, and takes an empty pair off', () => {
    expect(use('bold', 'end. |')).toBe('end. **|**')
    expect(use('bold', 'end. **|**')).toBe('end. |')
    expect(use('code', '|')).toBe('`|`')
  })
})

describe('code over lines', () => {
  it('fences the lines the selection touches', () => {
    expect(use('code', 'Run:\n[gta.set(1)\ngta.set(2)]\nThen')).toBe(
      'Run:\n```\n[gta.set(1)\ngta.set(2)]\n```\nThen'
    )
    // From the middle of one line to the middle of the next: both lines, whole.
    expect(use('code', 'one t[wo\nthr]ee')).toBe('```\n[one two\nthree]\n```')
  })

  it('takes the fence off lines it fenced', () => {
    expect(use('code', 'Run:\n```js\n[a()\nb()]\n```\nThen')).toBe('Run:\n[a()\nb()]\nThen')
  })
})

describe('links', () => {
  it('makes the selection a label, with the address selected to type over', () => {
    expect(use('link', 'see [the docs] here')).toBe('see [the docs]([https://]) here')
  })

  it('makes a selected address the link, the cursor where its label goes', () => {
    expect(use('link', 'see [https://example.test/a] here')).toBe(
      'see [|](https://example.test/a) here'
    )
  })

  it('puts an empty link where nothing is selected', () => {
    expect(use('link', 'see | here')).toBe('see [|](https://) here')
  })
})

describe('line prefixes', () => {
  it('makes each line it touches a list item, blank lines left alone', () => {
    expect(use('bullets', '[one\n\ntwo]')).toBe('- [one\n\n- two]')
    expect(use('numbers', '[one\ntwo\nthree]')).toBe('1. [one\n2. two\n3. three]')
  })

  it('takes the items off when every line is one', () => {
    expect(use('bullets', '- [one\n- two]')).toBe('[one\ntwo]')
    expect(use('numbers', '1. [one\n2. two]')).toBe('[one\ntwo]')
  })

  it('turns one kind of list into the other', () => {
    expect(use('bullets', '1. [one\n2. two]')).toBe('- [one\n- two]')
    expect(use('numbers', '- [one\n- two]')).toBe('1. [one\n2. two]')
  })

  it('adds to the lines without it, renumbering a list in order', () => {
    expect(use('bullets', '- [one\ntwo]')).toBe('- [one\n- two]')
    expect(use('numbers', '1. [one\ntwo\n7. three]')).toBe('1. [one\n2. two\n3. three]')
  })

  it('starts an item on an empty line, the cursor after its marker', () => {
    expect(use('bullets', 'Steps:\n|')).toBe('Steps:\n- |')
    expect(use('quote', '|')).toBe('> |')
  })

  it('keeps an indent, so a nested item stays nested', () => {
    expect(use('bullets', '- one\n  tw|o')).toBe('- one\n  - tw|o')
  })

  it('makes a heading, and takes one of any level off', () => {
    expect(use('heading', 'Set|up')).toBe('## Set|up')
    expect(use('heading', '#### Set|up')).toBe('Set|up')
  })

  it('quotes lines and unquotes them', () => {
    expect(use('quote', '[one\ntwo]')).toBe('> [one\n> two]')
    expect(use('quote', '> [one\n> two]')).toBe('[one\ntwo]')
  })

  it('leaves out a line the selection only reaches the start of', () => {
    expect(use('bullets', '[one\n]two')).toBe('- [one\n]two')
  })
})
