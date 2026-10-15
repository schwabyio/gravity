import { useState } from 'react'
import type { RepoView } from '../repos.js'
import BranchIcon from './BranchIcon.js'
import { repoChanges } from './RepoGit.js'
import Tooltip from './Tooltip.js'
import { useMenuDismiss } from '../hooks/useMenuDismiss.js'

export interface RepoStatusProps {
  /** The workspace's repositories, each once, in the sidebar's order. */
  repos: RepoView[]
  /** The one the button names: the open collection's, or the workspace's only one. */
  current: RepoView | null
  /** Open a repository's Changes drawer. */
  onOpen: (repo: RepoView) => void
}

const repositories = (count: number) => `${count} ${count === 1 ? 'repository' : 'repositories'}`

const branchOf = (repo: RepoView) =>
  !repo.git ? 'no git' : repo.git.detached ? 'detached' : (repo.git.branch ?? '—')

/** A repository's state in a line, after its branch: ● when anything changed, then ↓/↑. */
function Marks({ repo }: { repo: RepoView }) {
  const { git } = repo
  if (!git) return null
  const ahead = git.ahead ?? 0
  const behind = git.behind ?? 0
  return (
    <>
      {!git.clean && <span className="dirty">●</span>}
      {behind > 0 && <span>↓{behind}</span>}
      {ahead > 0 && <span>↑{ahead}</span>}
    </>
  )
}

/** The same, in words, for a screen reader. */
const said = (repo: RepoView) => {
  const { git } = repo
  if (!git) return `${repo.name}, no git`
  return [
    `${repo.name}, branch ${branchOf(repo)}`,
    git.clean ? null : `${repoChanges(git)} changed`,
    git.behind ? `${git.behind} behind` : null,
    git.ahead ? `${git.ahead} ahead` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * The status bar's way into git: the open collection's repository — or the
 * workspace's only one — by name and branch, with its changes and ↓/↑. A click
 * opens its Changes; with more than one repository in the workspace, a list
 * of them, each once, to pick from. Nothing with none.
 */
export default function RepoStatus({ repos, current, onOpen }: RepoStatusProps) {
  const [menu, setMenu] = useState(false)
  const menus = useMenuDismiss(menu, () => setMenu(false))
  if (repos.length === 0) return null
  const only = repos.length === 1 ? repos[0]! : null

  return (
    <span className="project-menu-wrap repo-status">
      <Tooltip
        text={
          only
            ? `${only.name}: open Changes and branches`
            : `${repositories(repos.length)} in this workspace: pick one to open its Changes`
        }
      >
        <button
          type="button"
          className={`status-button${menu ? ' on' : ''}`}
          aria-label={`Git: ${current ? said(current) : repositories(repos.length)}`}
          aria-haspopup={only ? undefined : 'menu'}
          aria-expanded={only ? undefined : menu}
          onClick={(event) => {
            if (only) return onOpen(only)
            event.stopPropagation()
            if (!menu) menus.opened()
            setMenu(!menu)
          }}
        >
          <BranchIcon />
          {current ? (
            <span className="repo-status-line">
              <span className="repo-status-name">{current.name}</span>
              <span className="repo-status-sep">·</span>
              <span className="repo-status-branch">{branchOf(current)}</span>
              <Marks repo={current} />
            </span>
          ) : (
            <span className="repo-status-line">{repositories(repos.length)}</span>
          )}
        </button>
      </Tooltip>
      {menu && (
        <div className="project-menu repo-status-menu" role="menu">
          {repos.map((repo) => (
            <button
              key={repo.root}
              type="button"
              role="menuitem"
              className={repo === current ? 'current' : ''}
              aria-label={said(repo)}
              title={repo.root}
              onClick={() => {
                setMenu(false)
                onOpen(repo)
              }}
            >
              <BranchIcon size={14} />
              <span className="repo-status-name">{repo.name}</span>
              <span className="repo-status-branch">{branchOf(repo)}</span>
              <span className="repo-status-marks">
                <Marks repo={repo} />
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
