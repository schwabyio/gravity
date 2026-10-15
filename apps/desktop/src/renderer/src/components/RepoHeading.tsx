import { useState } from 'react'
import type { RepoView } from '../repos.js'
import ChevronIcon from './ChevronIcon.js'
import MenuIcon, { type MenuIconName } from './MenuIcon.js'
import { GitState, repoChanges, SyncButtons } from './RepoGit.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'

interface Props {
  repo: RepoView
  open: boolean
  onToggle: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  /** Open the repository's Changes drawer, on its Changes or History tab. */
  onChanges: (tab: 'changes' | 'history') => void
  onReveal: () => void
}

/**
 * The heading of a repository that two or more of the workspace's projects are
 * in — a monorepo's services — with those projects under it. Its git is said
 * once, here, as a lone project's heading says it: the branch, a ● when
 * anything in the repository is changed, ↓/↑, and Fetch, Pull and Push. Its ⋯
 * menu has Changes and History. Projects are removed one by one, from their own
 * headings.
 */
export default function RepoHeading(props: Props) {
  const { repo, open } = props
  const { git } = repo
  const [menu, setMenu] = useState(false)
  const menus = useMenuDismiss(menu, () => setMenu(false))

  const item = (icon: MenuIconName, label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenu(false)
        action()
      }}
    >
      <MenuIcon name={icon} />
      {label}
    </button>
  )

  return (
    <div
      className="repo-head repo-group-head"
      onContextMenu={onRightClick(() => {
        if (!menu) menus.opened()
        setMenu(true)
      })}
    >
      <button
        type="button"
        className="repo-toggle"
        onClick={props.onToggle}
        aria-expanded={open}
        title={repo.root}
      >
        <ChevronIcon open={open} />
        <span className="repo-name">{repo.name}</span>
      </button>

      {git ? (
        <GitState
          git={git}
          changedTip={`${repoChanges(git)} changed in the repository: review and commit`}
          onChanges={() => props.onChanges('changes')}
        />
      ) : (
        repo.gitNote && (
          <span className="repo-git muted" title={repo.gitNote}>
            no git
          </span>
        )
      )}

      <span className="repo-actions">
        {git && (
          <SyncButtons
            git={git}
            busy={repo.busy}
            onFetch={props.onFetch}
            onPull={props.onPull}
            onPush={props.onPush}
          />
        )}
        <span className="project-menu-wrap">
          <button
            type="button"
            aria-label={`Repository actions for ${repo.name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={(event) => {
              event.stopPropagation()
              if (!menu) menus.opened()
              setMenu(!menu)
            }}
          >
            ⋯
          </button>
          {menu && (
            <div className="project-menu" role="menu">
              {git && (
                <>
                  {item('commit', 'Changes and commit', () => props.onChanges('changes'))}
                  {item('history', 'History', () => props.onChanges('history'))}
                  <div className="menu-divider" role="separator" />
                </>
              )}
              {item('folder', 'Show in folder', props.onReveal)}
            </div>
          )}
        </span>
      </span>
    </div>
  )
}
