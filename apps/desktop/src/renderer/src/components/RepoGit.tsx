import type { GitStatusView } from '@shared/ipc.js'
import { pullState, pushState } from '../gitActions.js'
import Tooltip from './Tooltip.js'

/**
 * A repository's branch, a ● when anything in it is changed, and ↓/↑ for
 * commits to pull and push, inline in a sidebar heading. The branch and the ●
 * open its Changes drawer.
 */
export function GitState(props: {
  git: GitStatusView
  /** What the ● says on hover: how much changed, and where. */
  changedTip: string
  onChanges: () => void
}) {
  const { git } = props
  const ahead = git.ahead ?? 0
  const behind = git.behind ?? 0
  return (
    <span className="repo-git">
      <Tooltip
        text={`${git.upstream ? `Tracks ${git.upstream}` : 'No upstream'}: open Changes and branches`}
      >
        <button
          type="button"
          className="repo-branch"
          onClick={props.onChanges}
          aria-label={`Branch ${git.detached ? 'detached' : (git.branch ?? 'none')}: open Changes`}
        >
          {git.detached ? 'detached' : (git.branch ?? '—')}
        </button>
      </Tooltip>
      {!git.clean && (
        <Tooltip text={props.changedTip}>
          <button
            type="button"
            className="dirty"
            onClick={props.onChanges}
            aria-label="Review changes"
          >
            ●
          </button>
        </Tooltip>
      )}
      {behind > 0 && <span title={`${behind} behind`}>↓{behind}</span>}
      {ahead > 0 && <span title={`${ahead} ahead`}>↑{ahead}</span>}
      {git.fetchProblem && (
        <Tooltip text={`The background fetch failed: ${git.fetchProblem}`}>
          <span className="fetch-problem" role="img" aria-label="Background fetch failed">
            !
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/** Fetch, Pull and Push for a repository: quiet icon buttons at a heading's right. */
export function SyncButtons(props: {
  git: GitStatusView
  busy: boolean
  onFetch: () => void
  onPull: () => void
  onPush: () => void
}) {
  const { git, busy } = props
  const pull = pullState(git, busy)
  const push = pushState(git, busy, null)
  return (
    <>
      <Tooltip text="Fetch from the remote">
        <button type="button" onClick={props.onFetch} disabled={busy} aria-label="Fetch">
          ↻
        </button>
      </Tooltip>
      <Tooltip text={pull.tooltip}>
        <button type="button" onClick={props.onPull} disabled={!pull.enabled} aria-label="Pull">
          ↓
        </button>
      </Tooltip>
      {git.remotes.length > 0 && !git.detached && !git.unborn && (
        <Tooltip text={push.tooltip}>
          <button type="button" onClick={props.onPush} disabled={!push.enabled} aria-label="Push">
            ↑
          </button>
        </Tooltip>
      )}
    </>
  )
}

/** The repository's changes in a line: the ● on a heading or in the status bar says it on hover. */
export const repoChanges = (git: GitStatusView): number =>
  git.changed + git.untracked + git.conflicted
