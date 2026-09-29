/** Commits and branches, read from git's formatted output. */

export interface CommitInfo {
  oid: string
  shortOid: string
  author: string
  email: string
  /** ISO 8601, with the author's offset. */
  date: string
  subject: string
  /** False for a commit the remote does not have yet. */
  pushed: boolean
}

/** Unit and record separators: characters no name or subject contains. */
const UNIT = '\x1f'
const RECORD = '\x1e'

export const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'

export function parseLog(stdout: string, unpushed: ReadonlySet<string>): CommitInfo[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [oid = '', shortOid = '', author = '', email = '', date = '', subject = ''] =
        record.split(UNIT)
      return { oid, shortOid, author, email, date, subject, pushed: !unpushed.has(oid) }
    })
}

export interface BranchInfo {
  /** A local branch's name, or a remote-only branch's name without its remote. */
  name: string
  /** For a branch that exists only on a remote: that remote. */
  remote: string | null
  current: boolean
  /** A local branch's upstream, such as `origin/main`, or null. */
  upstream: string | null
  /** git's `ahead 1, behind 2`, `gone`, or ''. */
  track: string
}

export const BRANCH_FORMAT =
  '--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(symref)'

/**
 * Local branches, then the remote branches no local one tracks or shares a
 * name with — those can be checked out as a new local branch.
 */
export function parseBranches(stdout: string, remotes: string[]): BranchInfo[] {
  const local: BranchInfo[] = []
  const remote: Array<{ remote: string; name: string }> = []
  // Longest first, so `origin/team` wins over `origin` for `origin/team/x`.
  const byLength = [...remotes].sort((a, b) => b.length - a.length)

  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [ref = '', upstream = '', track = '', head = '', symref = ''] = line.split('\0')
    if (symref !== '') continue
    if (ref.startsWith('refs/heads/')) {
      local.push({
        name: ref.slice('refs/heads/'.length),
        remote: null,
        current: head === '*',
        upstream: upstream.startsWith('refs/remotes/')
          ? upstream.slice('refs/remotes/'.length)
          : upstream || null,
        track
      })
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length)
      const owner = byLength.find((name) => rest.startsWith(`${name}/`))
      if (!owner) continue
      const name = rest.slice(owner.length + 1)
      if (name === 'HEAD') continue
      remote.push({ remote: owner, name })
    }
  }

  const tracked = new Set(local.map((branch) => branch.upstream))
  const names = new Set(local.map((branch) => branch.name))
  return [
    ...local,
    ...remote
      .filter(
        (branch) => !tracked.has(`${branch.remote}/${branch.name}`) && !names.has(branch.name)
      )
      .map((branch) => ({
        name: branch.name,
        remote: branch.remote,
        current: false,
        upstream: null,
        track: ''
      }))
  ]
}
