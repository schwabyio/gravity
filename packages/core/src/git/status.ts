/**
 * Parser for `git status --porcelain=v2 --branch -z --untracked-files=all`.
 *
 * One call gives branch, upstream, ahead/behind and per-file state. The format is
 * documented and stable, which is why it is preferred over the v1 porcelain or
 * several separate commands. `-z` gives paths exactly as they are — no quoting of
 * spaces or non-ASCII names — because they are handed back to git to commit,
 * diff or discard.
 */

/** What happened to a file, relative to the last commit. */
export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

export interface GitFileChange {
  /** Repo-relative, with `/`. */
  path: string
  /** For a rename or copy, the path it came from. */
  origPath: string | null
  /** git's two status letters: staged (X) and unstaged (Y). `.` is unchanged, `?` untracked. */
  x: string
  y: string
  kind: ChangeKind
  /** True when some of the change is staged. */
  staged: boolean
  submodule: boolean
}

export interface GitStatus {
  /** Branch name, or null when HEAD is detached. */
  branch: string | null
  detached: boolean
  /** Upstream ref such as `origin/main`, or null when the branch has none. */
  upstream: string | null
  /**
   * Commits ahead of / behind upstream.
   *
   * Null rather than 0 when git reports no `# branch.ab` line at all, which
   * happens with no upstream, on a branch with no commits yet, and when the
   * upstream branch is gone from the remote.
   */
  ahead: number | null
  behind: number | null
  /** The commit HEAD points at, or null on a branch with no commits yet. */
  headOid: string | null
  /** True on a branch with no commits yet. */
  unborn: boolean
  /** True when the branch has an upstream that no longer exists (deleted on the remote). */
  upstreamGone: boolean
  /** Tracked files with staged or unstaged modifications. */
  changed: number
  /** Files not tracked and not ignored. */
  untracked: number
  /** Files with merge conflicts. */
  conflicted: number
  /** Everything that is not clean, in git's order. */
  files: GitFileChange[]
}

export const EMPTY_STATUS: GitStatus = {
  branch: null,
  detached: false,
  upstream: null,
  ahead: null,
  behind: null,
  headOid: null,
  unborn: false,
  upstreamGone: false,
  changed: 0,
  untracked: 0,
  conflicted: 0,
  files: []
}

/** True when nothing is changed, untracked or conflicted. */
export const isClean = (status: GitStatus): boolean =>
  status.changed === 0 && status.untracked === 0 && status.conflicted === 0

/** The arguments for the status this module parses. */
export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']

export function parseStatus(stdout: string): GitStatus {
  const status: GitStatus = { ...EMPTY_STATUS, files: [] }
  let sawAb = false
  const records = stdout.split('\0')

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (record === '') continue

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        status.unborn = value === '(initial)'
        status.headOid = status.unborn ? null : value
      } else if (key === 'branch.head') {
        // git writes the literal "(detached)" rather than a name.
        if (value === '(detached)') status.detached = true
        else status.branch = value
      } else if (key === 'branch.upstream') {
        status.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          sawAb = true
          status.ahead = Number(match[1])
          status.behind = Number(match[2])
        }
      }
      continue
    }

    const type = record[0]
    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const [xy, sub] = fields(record, 2)
      status.changed++
      status.files.push(change(fieldsAfter(record, 8), null, xy, sub))
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then <origPath> as the next record
      const [xy, sub] = fields(record, 2)
      const origPath = records[++index] ?? null
      status.changed++
      status.files.push(change(fieldsAfter(record, 9), origPath, xy, sub))
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const [xy, sub] = fields(record, 2)
      status.conflicted++
      status.files.push({ ...change(fieldsAfter(record, 10), null, xy, sub), kind: 'conflicted' })
    } else if (type === '?') {
      status.untracked++
      status.files.push({
        path: record.slice(2),
        origPath: null,
        x: '?',
        y: '?',
        kind: 'untracked',
        staged: false,
        submodule: false
      })
    }
    // '!' (ignored) is never requested, and is skipped if it appears.
  }

  status.upstreamGone = status.upstream !== null && !sawAb && !status.unborn
  return status
}

function change(path: string, origPath: string | null, xy = '..', sub = 'N...'): GitFileChange {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  return {
    path,
    origPath,
    x,
    y,
    kind: kindOf(x, y),
    staged: x !== '.',
    submodule: sub.startsWith('S')
  }
}

/**
 * Relative to the last commit, which is what a commit from the app records: the
 * file as it is on disk.
 */
function kindOf(x: string, y: string): ChangeKind {
  if (x === 'R') return 'renamed'
  if (x === 'C') return 'copied'
  if (x === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/** The first `count` space-separated fields after the record's type. */
function fields(record: string, count: number): string[] {
  return record.split(' ').slice(1, count + 1)
}

/**
 * Return everything after the first `count` space-separated fields.
 *
 * Paths may contain spaces, so the tail cannot be recovered by splitting the
 * whole record.
 */
function fieldsAfter(record: string, count: number): string {
  let index = 0
  for (let field = 0; field < count; field++) {
    const next = record.indexOf(' ', index)
    if (next === -1) return ''
    index = next + 1
  }
  return record.slice(index)
}
