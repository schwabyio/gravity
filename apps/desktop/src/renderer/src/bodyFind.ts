import type { ReceivedResponse } from '@schwabyio/gravity-core/model'

/**
 * Finding text in a response body (⌘F, Ctrl+F off a Mac): pure, so the Body
 * tab and its tests agree on what matches and where.
 *
 * What is typed is found as written, never as a pattern, in any case unless
 * Match case is on. Matches never overlap: `aa` is found twice in `aaaa`, as a
 * browser finds it.
 */

/** What the find bar holds: kept while it is closed, so ⌘F brings the last search back. */
export interface FindState {
  open: boolean
  query: string
  matchCase: boolean
}

export const NO_FIND: FindState = { open: false, query: '', matchCase: false }

/** One match: the line it is on, and where in that line it starts and ends. */
export interface FindMatch {
  line: number
  start: number
  end: number
}

export interface Found {
  matches: FindMatch[]
  /** Stopped at {@link FIND_LIMIT}: there are more than were counted. */
  capped: boolean
}

/** The most matches counted and highlighted: past this, a body of thousands of lines slows to a crawl. */
export const FIND_LIMIT = 10_000

export const NOTHING_FOUND: Found = { matches: [], capped: false }

/** Whether a response has a body to find text in: one at all, and text rather than bytes. */
export const searchable = (
  response: Pick<ReceivedResponse, 'bodyKind' | 'bodyEncoding'>
): boolean => response.bodyKind !== 'empty' && response.bodyEncoding !== 'base64'

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every match of `query` in `lines`, in order, up to {@link FIND_LIMIT}. */
export function findMatches(lines: readonly string[], query: string, matchCase: boolean): Found {
  if (query === '') return NOTHING_FOUND
  // A pattern rather than lower-casing both, so a match's place is its place in the line as
  // written: lower-casing some letters (İ) changes how long the line is.
  const pattern = new RegExp(escape(query), matchCase ? 'gu' : 'giu')
  const matches: FindMatch[] = []
  for (let line = 0; line < lines.length; line++) {
    for (const match of lines[line]!.matchAll(pattern)) {
      if (matches.length === FIND_LIMIT) return { matches, capped: true }
      matches.push({ line, start: match.index, end: match.index + match[0].length })
    }
  }
  return { matches, capped: false }
}

/** A line's matches, each with its place among all of them, by line. */
export function matchesByLine(found: Found): Map<number, Array<FindMatch & { index: number }>> {
  const byLine = new Map<number, Array<FindMatch & { index: number }>>()
  found.matches.forEach((match, index) => {
    const line = byLine.get(match.line)
    if (line) line.push({ ...match, index })
    else byLine.set(match.line, [{ ...match, index }])
  })
  return byLine
}

/** A line cut at its matches: plain text, and each match with its place among all of them. */
export function splitLine(
  text: string,
  matches: ReadonlyArray<FindMatch & { index: number }>
): Array<{ text: string; index: number | null }> {
  const parts: Array<{ text: string; index: number | null }> = []
  let at = 0
  for (const match of matches) {
    if (match.start > at) parts.push({ text: text.slice(at, match.start), index: null })
    parts.push({ text: text.slice(match.start, match.end), index: match.index })
    at = match.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), index: null })
  return parts
}

/** What the find bar says of its matches: `3 of 12`, `No results`, `1 of 10,000+`. */
export function findCount(found: Found, current: number): string {
  if (found.matches.length === 0) return 'No results'
  const total = found.matches.length.toLocaleString('en-US')
  return `${(current + 1).toLocaleString('en-US')} of ${total}${found.capped ? '+' : ''}`
}

/** The next match's place, or the previous one's, going round at either end. */
export const stepMatch = (current: number, count: number, by: 1 | -1): number =>
  count === 0 ? 0 : (current + by + count) % count

type Keys = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

/**
 * What a key does for finding: ⌘F or Ctrl+F opens the find bar; ⌘G or Ctrl+G,
 * and F3, go to the next match, with Shift the previous one — as browsers have
 * them on each platform.
 */
export function findKey(event: Keys): 'open' | 'next' | 'previous' | null {
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (event.altKey) return null
  if (command && key === 'f' && !event.shiftKey) return 'open'
  if ((command && key === 'g') || (!command && event.key === 'F3')) {
    return event.shiftKey ? 'previous' : 'next'
  }
  return null
}
