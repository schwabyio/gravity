/**
 * One file's changes, as the app shows them: hunks of numbered lines.
 *
 * Parsed from git's unified diff, which is a stable text format, rather than
 * computed here: git's diff is the one the person will see in any other tool.
 */

export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'meta'
  text: string
  /** Line number in the last commit's version, or null for an added line. */
  oldLine: number | null
  /** Line number in the version on disk, or null for a deleted line. */
  newLine: number | null
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ context` line. */
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  origPath: string | null
  /** A binary file has no lines to show. */
  binary: boolean
  /** Too large to show; the hunks are left out. */
  tooLarge: boolean
  hunks: DiffHunk[]
}

/** More changed lines than this are not shown. */
export const MAX_DIFF_LINES = 5000
/** A new file bigger than this is not shown. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseUnifiedDiff(text: string): { binary: boolean; hunks: DiffHunk[] } {
  const hunks: DiffHunk[] = []
  let binary = false
  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const lines = text.split('\n')
  // The text ends with a line break, which is not a line of its own.
  if (lines.at(-1) === '') lines.pop()

  for (const line of lines) {
    const start = HUNK.exec(line)
    if (start) {
      hunk = { header: line, lines: [] }
      hunks.push(hunk)
      oldLine = Number(start[1])
      newLine = Number(start[2])
      continue
    }
    if (!hunk) {
      // The header before the first hunk: file names, modes, index lines.
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
        binary = true
      }
      continue
    }
    const marker = line[0]
    const body = line.slice(1)
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine: newLine++ })
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldLine: oldLine++, newLine: null })
    } else if (marker === '\\') {
      // "\ No newline at end of file"
      hunk.lines.push({ kind: 'meta', text: body.trim(), oldLine: null, newLine: null })
    } else {
      hunk.lines.push({ kind: 'context', text: body, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return { binary, hunks }
}

/**
 * A file git has no earlier version of, shown as all added lines.
 *
 * Built here rather than with `git diff --no-index /dev/null <file>`, whose
 * `/dev/null` is not a path on Windows.
 */
export function addedFileDiff(content: Buffer): { binary: boolean; hunks: DiffHunk[] } {
  // git's own test: a NUL byte near the start means binary.
  if (content.subarray(0, 8000).includes(0)) return { binary: true, hunks: [] }
  const text = content.toString('utf8')
  if (text === '') return { binary: false, hunks: [] }
  const endsWithBreak = text.endsWith('\n')
  const lines = (endsWithBreak ? text.slice(0, -1) : text).split('\n')
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@`,
    lines: lines.map((line, index) => ({
      kind: 'add',
      text: line,
      oldLine: null,
      newLine: index + 1
    }))
  }
  if (!endsWithBreak) {
    hunk.lines.push({
      kind: 'meta',
      text: 'No newline at end of file',
      oldLine: null,
      newLine: null
    })
  }
  return { binary: false, hunks: [hunk] }
}

/**
 * `git diff --numstat -z` for one file: whether it is binary, and how many
 * lines changed. A rename is written `added\tdeleted\t\0from\0to\0`.
 */
export function parseNumstat(text: string): { binary: boolean; changedLines: number } {
  const match = /^(-|\d+)\t(-|\d+)\t/.exec(text)
  if (!match) return { binary: false, changedLines: 0 }
  if (match[1] === '-' || match[2] === '-') return { binary: true, changedLines: 0 }
  return { binary: false, changedLines: Number(match[1]) + Number(match[2]) }
}
