/**
 * The docs editor's formatting tools, as edits to markdown text: pure, so what
 * Bold or a list does to a selection is tested apart from the editor.
 *
 * Each writes the markdown core's `parseMarkdown` reads (`**bold**`, `_italic_`,
 * `` `code` ``, `[label](https://…)`, `## `, `- `, `1. `, `> `, fences), and
 * a tool used again on what it made takes it off.
 */

/** `insert` in place of `from`–`to`, positions in the text as it was. In order, never overlapping. */
export interface Edit {
  from: number
  to: number
  insert: string
}

/** What a tool does: its edits, and what is selected after them, in the text as it becomes. */
export interface Formatted {
  edits: Edit[]
  anchor: number
  head: number
}

export type MarkdownFormat =
  'bold' | 'italic' | 'heading' | 'bullets' | 'numbers' | 'code' | 'quote' | 'link'

export function formatMarkdown(
  text: string,
  from: number,
  to: number,
  format: MarkdownFormat
): Formatted {
  switch (format) {
    case 'bold':
      return wrap(text, from, to, '**')
    case 'italic':
      return wrap(text, from, to, '_')
    case 'code':
      return text.slice(from, to).includes('\n') ? fence(text, from, to) : wrap(text, from, to, '`')
    case 'link':
      return link(text, from, to)
    case 'heading':
      return prefixLines(text, from, to, HEADING)
    case 'bullets':
      return prefixLines(text, from, to, BULLETS)
    case 'numbers':
      return prefixLines(text, from, to, NUMBERS)
    case 'quote':
      return prefixLines(text, from, to, QUOTE)
  }
}

/* ---------------------------------------------------------------- inline -- */

const WORD = /[\p{L}\p{N}_'-]/u

/**
 * Marks either side of the selection, or off it when it is marked already. With
 * nothing selected, the word the cursor is in, or a pair to type between.
 */
function wrap(text: string, from: number, to: number, mark: string): Formatted {
  ;[from, to] = trimmed(text, from, to)
  if (from === to) {
    while (from > 0 && WORD.test(text[from - 1]!)) from--
    while (to < text.length && WORD.test(text[to]!)) to++
  }
  const m = mark.length

  // Marked just outside the selection, or a pair with the cursor between: off.
  if (from >= m && text.slice(from - m, from) === mark && text.slice(to, to + m) === mark) {
    return {
      edits: [
        { from: from - m, to: from, insert: '' },
        { from: to, to: to + m, insert: '' }
      ],
      anchor: from - m,
      head: to - m
    }
  }
  // The selection is the marked text, marks and all: off.
  const selected = text.slice(from, to)
  if (selected.length >= 2 * m + 1 && selected.startsWith(mark) && selected.endsWith(mark)) {
    return {
      edits: [
        { from, to: from + m, insert: '' },
        { from: to - m, to, insert: '' }
      ],
      anchor: from,
      head: to - 2 * m
    }
  }

  if (from === to) {
    return { edits: [{ from, to, insert: mark + mark }], anchor: from + m, head: from + m }
  }
  return {
    edits: [
      { from, to: from, insert: mark },
      { from: to, to, insert: mark }
    ],
    anchor: from + m,
    head: to + m
  }
}

/** Spaces a double-click took with a word stay outside the marks: `**word **` is not bold. */
function trimmed(text: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(text[from]!)) from++
  while (to > from && /\s/.test(text[to - 1]!)) to--
  return [from, to]
}

/** The selection as a link's label, the address selected to type over; a selected address as the href. */
function link(text: string, from: number, to: number): Formatted {
  ;[from, to] = trimmed(text, from, to)
  const selected = text.slice(from, to)
  if (/^https?:\/\/\S+$/.test(selected)) {
    return { edits: [{ from, to, insert: `[](${selected})` }], anchor: from + 1, head: from + 1 }
  }
  if (from === to) {
    return { edits: [{ from, to, insert: '[](https://)' }], anchor: from + 1, head: from + 1 }
  }
  const address = to + 3 // after `[`, the label and `](`
  return {
    edits: [
      { from, to: from, insert: '[' },
      { from: to, to, insert: '](https://)' }
    ],
    anchor: address,
    head: address + 'https://'.length
  }
}

/* ----------------------------------------------------------------- lines -- */

interface Line {
  from: number
  text: string
}

/** The lines the selection touches; one ending at the start of a line leaves that line out. */
function linesOf(text: string, from: number, to: number): Line[] {
  const end = to > from && text[to - 1] === '\n' ? to - 1 : to
  const lines: Line[] = []
  let start = text.lastIndexOf('\n', from - 1) + 1
  for (;;) {
    const next = text.indexOf('\n', start)
    const stop = next === -1 ? text.length : next
    lines.push({ from: start, text: text.slice(start, stop) })
    if (next === -1 || stop >= end) return lines
    start = next + 1
  }
}

/** Fenced lines, or the fence round them taken off. */
function fence(text: string, from: number, to: number): Formatted {
  const lines = linesOf(text, from, to)
  const first = lines[0]!
  const last = lines[lines.length - 1]!
  const start = first.from
  const end = last.from + last.text.length

  const before = linesOf(text, Math.max(start - 1, 0), Math.max(start - 1, 0))[0]
  const after = end < text.length ? linesOf(text, end + 1, end + 1)[0] : undefined
  if (start > 0 && after && /^\s*```/.test(before!.text) && /^\s*```\s*$/.test(after.text)) {
    const opening = before!.text.length + 1
    return {
      edits: [
        { from: before!.from, to: start, insert: '' },
        { from: end, to: after.from + after.text.length, insert: '' }
      ],
      anchor: start - opening,
      head: end - opening
    }
  }
  return {
    edits: [
      { from: start, to: start, insert: '```\n' },
      { from: end, to: end, insert: '\n```' }
    ],
    anchor: start + 4,
    head: end + 4
  }
}

interface LinePrefix {
  /** The prefix a line has of this kind, after any indent. */
  has: RegExp
  /** One it takes the place of, a list's other kind. */
  replaces?: RegExp
  /** The prefix for the nth line given it, from 1. */
  add: (n: number) => string
}

const HEADING: LinePrefix = { has: /^#{1,6}[ \t]+/, add: () => '## ' }
const BULLETS: LinePrefix = { has: /^[-*+][ \t]+/, replaces: /^\d+[.)][ \t]+/, add: () => '- ' }
const NUMBERS: LinePrefix = {
  has: /^\d+[.)][ \t]+/,
  replaces: /^[-*+][ \t]+/,
  add: (n) => `${n}. `
}
const QUOTE: LinePrefix = { has: /^>[ \t]?/, add: () => '> ' }

/**
 * A prefix on each line the selection touches, blank lines left alone unless
 * they are all there is; off every line when every one has it already.
 */
function prefixLines(text: string, from: number, to: number, prefix: LinePrefix): Formatted {
  const lines = linesOf(text, from, to)
  const written = lines.filter((line) => line.text.trim() !== '')
  const targets = written.length > 0 ? written : lines
  const indent = (line: Line) => /^[ \t]*/.exec(line.text)![0].length
  const match = (line: Line, pattern: RegExp) => pattern.exec(line.text.slice(indent(line)))
  const off = targets.every((line) => match(line, prefix.has))

  const edits = targets.flatMap((line, i): Edit[] => {
    const at = line.from + indent(line)
    const own = match(line, prefix.has)
    if (off) return [{ from: at, to: at + own![0].length, insert: '' }]
    // A line with it already keeps it; a numbered one is numbered again, to count on in order.
    if (own && prefix !== NUMBERS) return []
    const other = own ?? (prefix.replaces ? match(line, prefix.replaces) : null)
    return [{ from: at, to: at + (other?.[0].length ?? 0), insert: prefix.add(i + 1) }]
  })
  return { edits, anchor: mapped(from, edits), head: mapped(to, edits) }
}

/** Where a position ends up after the edits: after what is inserted at it, at the end of what replaced it. */
function mapped(position: number, edits: Edit[]): number {
  let shift = 0
  for (const edit of edits) {
    if (edit.from > position) break
    if (edit.to <= position) shift += edit.insert.length - (edit.to - edit.from)
    else return edit.from + shift + edit.insert.length
  }
  return position + shift
}
