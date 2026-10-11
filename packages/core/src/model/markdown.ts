/**
 * The Markdown that collection and step `docs:` are written in, parsed to a
 * small tree that the desktop app renders as React and `gta` renders as HTML —
 * one reading of the text, so a doc never says one thing in the app and
 * another in a report.
 *
 * The supported subset is what documentation in this format actually uses:
 * headings, paragraphs, bullet and ordered lists, fenced code, tables, block
 * quotes and GitHub's callouts (`> [!NOTE]`), rules, and inline code, emphasis
 * and links. Anything else is the literal text it was written as, which is the
 * honest failure mode. What a renderer colours in the text — variables, methods,
 * status codes, code — is `markdownMarks.ts`.
 *
 * Text stays text: nothing here is HTML, so a renderer escapes every string
 * and there is no injection surface — docs come from files in someone's
 * repository, which is not the same as trusting them.
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  /** Only http(s): any other link is left as the text it was written as. */
  | { type: 'link'; label: string; href: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }

export interface MdListItem {
  content: MdInline[]
  /** A nested list, or null. */
  children: MdBlock | null
}

export type MdBlock =
  | { type: 'code'; language: string | null; text: string }
  /** 1 to 6, as written: a renderer chooses the tag. */
  | { type: 'heading'; level: number; content: MdInline[] }
  | { type: 'rule' }
  | { type: 'table'; header: MdInline[][]; rows: MdInline[][][] }
  | { type: 'quote'; blocks: MdBlock[] }
  /** A block quote whose first line is `[!NOTE]`, `[!TIP]` and so on, as GitHub has them. */
  | { type: 'callout'; kind: CalloutKind; blocks: MdBlock[] }
  | { type: 'list'; ordered: boolean; items: MdListItem[] }
  | { type: 'paragraph'; content: MdInline[] }

/** GitHub's callouts, in its order. */
export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

/**
 * Each callout's title, and its icon as SVG path data — 16 by 16, stroked,
 * with round caps — so the app and a report draw the same one.
 */
export const CALLOUTS: Record<CalloutKind, { label: string; icon: string }> = {
  note: {
    label: 'Note',
    icon: 'M14.25 8a6.25 6.25 0 1 1-12.5 0 6.25 6.25 0 0 1 12.5 0zM8 7.25v4M8 4.75v.01'
  },
  tip: {
    label: 'Tip',
    icon: 'M6 13.75h4M6.5 11.5h3M8 2.25a4 4 0 0 0-2.4 7.2c.5.4.9.9.9 1.55h3c0-.65.4-1.15.9-1.55A4 4 0 0 0 8 2.25z'
  },
  important: {
    label: 'Important',
    icon: 'M2.75 3.25h10.5v7.5H8.5l-3 2.5v-2.5H2.75zM8 5.25v2.5M8 9.5v.01'
  },
  warning: { label: 'Warning', icon: 'M8 2.25l6.25 11H1.75zM8 6.5v3M8 11.5v.01' },
  caution: {
    label: 'Caution',
    icon: 'M5.5 2.25h5l3.25 3.25v5l-3.25 3.25h-5L2.25 10.5v-5zM8 5.25v3.25M8 10.75v.01'
  }
}

export function parseMarkdown(source: string): MdBlock[] {
  return parseBlocks(source.split(/\r?\n/))
}

/* ------------------------------------------------------------- blocks -- */

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index++
      continue
    }

    const fence = /^\s*```\s*(\S*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      index++
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index++
      }
      index++ // closing fence
      blocks.push({
        type: 'code',
        language: fence[1] || null,
        text: trimBlankEdges(body).join('\n')
      })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]?.length ?? 1,
        content: parseInline(heading[2] ?? '')
      })
      index++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\W]*$/.test(line) && line.trim().length >= 3) {
      blocks.push({ type: 'rule' })
      index++
      continue
    }

    // A table needs a delimiter row directly under its header.
    if (line.includes('|') && isTableDelimiter(lines[index + 1])) {
      const rows: string[] = []
      const header = line
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(lines[index] ?? '')
        index++
      }
      blocks.push({
        type: 'table',
        header: splitRow(header).map(parseInline),
        rows: rows.map((row) => splitRow(row).map(parseInline))
      })
      continue
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index++
      }
      // `[!WARNING]` alone on the first line makes a callout, as on GitHub.
      const callout = /^\s*\[!([A-Za-z]+)\]\s*$/.exec(quoted[0] ?? '')
      const kind = callout?.[1]?.toLowerCase() as CalloutKind | undefined
      blocks.push(
        kind && CALLOUT_KINDS.includes(kind)
          ? { type: 'callout', kind, blocks: parseBlocks(quoted.slice(1)) }
          : { type: 'quote', blocks: parseBlocks(quoted) }
      )
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const raw: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        // A list continues through its items and through indented wrapped text,
        // and ends at a blank line or anything starting a different block.
        if (BULLET.test(current) || ORDERED.test(current)) raw.push(current)
        else if (
          /^\s+\S/.test(current) &&
          raw.length > 0 &&
          !startsBlock(current, lines[index + 1])
        )
          raw.push(current)
        else break
        index++
      }
      const list = listOf(parseItems(raw))
      if (list) blocks.push(list)
      continue
    }

    // Everything else is a paragraph, running until a blank line or a block start.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || startsBlock(current, lines[index + 1])) break
      paragraph.push(current.trim())
      index++
    }
    blocks.push({ type: 'paragraph', content: parseInline(paragraph.join(' ')) })
  }

  return blocks
}

const BULLET = /^(\s*)[-*+]\s+/
const ORDERED = /^(\s*)\d+[.)]\s+/

interface RawItem {
  indent: number
  ordered: boolean
  text: string
  children: RawItem[]
}

/**
 * Turn list lines into a tree, using indentation for depth.
 *
 * A stack of open items rather than recursion over the text, so a line's depth
 * is decided by comparing it with what is already open — which is what makes a
 * jump from two spaces to six behave like one level, not four.
 */
function parseItems(lines: string[]): RawItem[] {
  const root: RawItem[] = []
  const stack: RawItem[] = []

  for (const line of lines) {
    const match = BULLET.exec(line) ?? ORDERED.exec(line)
    if (!match) {
      // A wrapped continuation line belongs to the item above it.
      const open = stack[stack.length - 1]
      if (open) open.text += ` ${line.trim()}`
      continue
    }

    const item: RawItem = {
      indent: (match[1] ?? '').length,
      ordered: ORDERED.test(line),
      text: line.slice(match[0].length),
      children: []
    }

    while (stack.length > 0 && (stack[stack.length - 1] as RawItem).indent >= item.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(item)
    else root.push(item)
    stack.push(item)
  }

  return root
}

function listOf(items: RawItem[]): MdBlock | null {
  if (items.length === 0) return null
  return {
    type: 'list',
    ordered: items[0]?.ordered ?? false,
    items: items.map((item) => ({
      content: parseInline(item.text),
      children: listOf(item.children)
    }))
  }
}

const startsBlock = (line: string, next: string | undefined): boolean =>
  /^\s*```/.test(line) ||
  /^#{1,6}\s/.test(line) ||
  /^\s*[-*+]\s+/.test(line) ||
  /^\s*\d+[.)]\s+/.test(line) ||
  /^\s*>/.test(line) ||
  (line.includes('|') && isTableDelimiter(next))

const isTableDelimiter = (line: string | undefined): boolean =>
  line !== undefined && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')

const splitRow = (row: string): string[] =>
  row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())

/** Drop leading and trailing blank lines from a fenced block. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}

/* ------------------------------------------------------------- inline -- */

/**
 * Inline spans, code first.
 *
 * Code wins over every other marker so that `**not bold**` inside backticks
 * stays literal, which is exactly how these docs describe function signatures.
 */
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)/

export function parseInline(text: string, depth = 0): MdInline[] {
  if (text === '') return []
  if (depth > 6) return [{ type: 'text', text }]

  const match = INLINE.exec(text)
  if (!match) return [{ type: 'text', text }]

  const before = text.slice(0, match.index)
  const after = text.slice(match.index + match[0].length)
  const token = match[0]
  let node: MdInline = { type: 'text', text: token }

  if (match[1]) {
    node = { type: 'code', text: token.slice(1, -1) }
  } else if (match[2]) {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
    if (link) node = linkOf(link[1] ?? '', link[2] ?? '')
  } else if (match[3]) {
    node = { type: 'strong', children: parseInline(token.slice(2, -2), depth + 1) }
  } else if (match[4]) {
    node = { type: 'em', children: parseInline(token.slice(1, -1), depth + 1) }
  }

  return [
    ...(before ? parseInline(before, depth + 1) : []),
    node,
    ...(after ? parseInline(after, depth + 1) : [])
  ]
}

/**
 * Only http(s) links become links. `javascript:` and `file:` hrefs in a
 * document someone checked into a repo have no legitimate use here, so they
 * read as the text they were written as.
 */
function linkOf(label: string, href: string): MdInline {
  return /^https?:\/\//i.test(href)
    ? { type: 'link', label, href }
    : { type: 'text', text: `${label} (${href})` }
}
