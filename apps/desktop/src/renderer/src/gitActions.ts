import type { GitStatusView } from '@shared/ipc.js'

/**
 * Whether Pull and Push can be used, and what each would do — the same answer
 * for the project's git strip and the Changes drawer.
 */
export interface ActionState {
  enabled: boolean
  /** What the action would do, or why it cannot. */
  tooltip: string
  /** A short count for the button: `↓3`. */
  count: number
}

const commits = (count: number) => `${count} commit${count === 1 ? '' : 's'}`

/** Why nothing can be pulled or pushed from where the repository is, or null. */
function blocked(git: GitStatusView): string | null {
  if (git.operation) return `A ${git.operation} is in progress: finish it in your git tool first`
  if (git.conflicted > 0) return 'Resolve the conflicts in your git tool first'
  if (git.detached) return 'HEAD is detached: create a branch first'
  if (git.unborn) return 'Make a first commit first'
  return null
}

export function pullState(git: GitStatusView, busy: boolean): ActionState {
  const ahead = git.ahead ?? 0
  const behind = git.behind ?? 0
  const no = (tooltip: string): ActionState => ({ enabled: false, tooltip, count: behind })
  const why = blocked(git)
  if (why) return no(`Cannot pull. ${why}`)
  if (!git.upstream) return no('Cannot pull: this branch has no upstream yet. Push to publish it')
  if (git.upstreamGone) return no(`Cannot pull: ${git.upstream} is gone from the remote`)
  if (ahead > 0 && behind > 0 && git.changed > 0) {
    return no('Cannot pull: both sides have new commits. Commit or discard your changes first')
  }
  const tooltip =
    ahead > 0 && behind > 0
      ? `Pull ${commits(behind)} from ${git.upstream}, replaying your ${commits(ahead)} on top (rebase)`
      : behind > 0
        ? `Pull ${commits(behind)} from ${git.upstream} (fast-forward)`
        : `Pull from ${git.upstream}`
  return { enabled: !busy, tooltip, count: behind }
}

export function pushState(git: GitStatusView, busy: boolean, remote: string | null): ActionState {
  const ahead = git.ahead ?? 0
  const behind = git.behind ?? 0
  const no = (tooltip: string): ActionState => ({ enabled: false, tooltip, count: ahead })
  const why = blocked(git)
  if (why) return no(`Cannot push. ${why}`)
  if (git.remotes.length === 0) return no('Cannot push: this repository has no remote')
  const branch = git.branch ?? 'this branch'
  if (!git.upstream || git.upstreamGone) {
    const target = remote ?? (git.remotes.includes('origin') ? 'origin' : git.remotes[0]!)
    return { enabled: !busy, tooltip: `Publish ${branch} to ${target}`, count: 0 }
  }
  if (behind > 0) return no(`Pull first: ${git.upstream} has ${commits(behind)} you do not`)
  if (ahead === 0) return no(`Nothing to push: ${git.upstream} is up to date`)
  return { enabled: !busy, tooltip: `Push ${commits(ahead)} to ${git.upstream}`, count: ahead }
}

/** True when a pull would rebase: both sides have commits the other lacks. */
export const diverged = (git: GitStatusView) => (git.ahead ?? 0) > 0 && (git.behind ?? 0) > 0

/** The question asked before a pull that rebases. */
export const rebaseQuestion = (git: GitStatusView) =>
  `Your branch and ${git.upstream} have both moved on. Pull replays your ${commits(git.ahead ?? 0)} on top of their ${commits(git.behind ?? 0)} (a rebase). If they conflict, nothing is changed.\n\nPull now?`
