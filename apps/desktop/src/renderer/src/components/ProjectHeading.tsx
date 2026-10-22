import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectView } from '@shared/ipc.js'
import { findingsLabel } from '../ruleFindings.js'
import ChevronIcon from './ChevronIcon.js'
import CollapseIcon from './CollapseIcon.js'
import MenuIcon, { type MenuIconName } from './MenuIcon.js'
import { GitState, repoChanges, SyncButtons } from './RepoGit.js'
import Tooltip from './Tooltip.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'
import { joinPath, useExternalEditor } from '../externalEditor.js'

interface Props {
  project: ProjectView
  /**
   * Under its repository's heading, with other projects of the same repository:
   * the branch, Fetch, Pull and Push are the repository's, there, and this says
   * only what changed in its own folder.
   */
  inRepo?: boolean
  open: boolean
  onToggle: () => void
  /**
   * Its folders, when it has any: collapse every one, or — all of them collapsed, or the
   * project — open the project and every folder in it. Not while a filter shows them all open.
   */
  folders: { closed: boolean; filtering: boolean; onToggle: () => void } | null
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  /** Open the repository's Changes drawer, on its Changes or History tab. */
  onChanges: (tab: 'changes' | 'history') => void
  onRemove: () => void
  onNewCollection: () => void
  onNewDirectory: () => void
  onNewSet: () => void
  onNewEndpoints: () => void
  onNewBase: () => void
  onSettings: () => void
  /** Open Project settings at its rules, and where the project's files break them. */
  onRules: () => void
  onReveal: () => void
  /** Rename a scratch pad; an ordinary project's name is its folder's, or its project.yml's. */
  onRename: () => void
}

/**
 * One compact line per project, above the collections it holds.
 *
 * The project is a heading rather than the subject: its git branch, dirty state
 * and ahead/behind sit inline — only when it is in a repository — and Fetch,
 * Pull and Push are quiet icon buttons, so the collections below stay the thing
 * the eye lands on. The branch and the dirty dot open the Changes drawer, where
 * commits are made. With folders, one more icon collapses or expands them all.
 * Creating things and the project's settings are in its ⋯ menu.
 * A scratch pad says so beside its name. Under its repository's heading — a
 * monorepo's services in one workspace — only its own changes show.
 */
export default function ProjectHeading(props: Props) {
  const { project, open, folders, inRepo = false } = props
  const { git, gitNote, busy } = project
  const [menu, setMenu] = useState(false)
  const editor = useExternalEditor()

  // A click anywhere else, or another menu opening, closes the menu.
  const menus = useMenuDismiss(menu, () => setMenu(false))

  // The shared project's badge shows only while the project's whole name fits beside it,
  // the badge at its least (styles.css cuts it short down to that): the name always wins.
  // Measured rather than left to a breakpoint, since the room a name needs is its own and
  // its font's: Linux's fonts run wider than macOS's.
  const headRef = useRef<HTMLDivElement>(null)
  const [badgeRoom, setBadgeRoom] = useState(true)
  const fitBadge = useCallback(() => {
    const head = headRef.current
    const name = head?.querySelector<HTMLElement>('.repo-name')
    const actions = head?.querySelector<HTMLElement>('.repo-actions')
    if (!head || !name || !actions) return
    if (head.querySelector('.uses-badge')) {
      setBadgeRoom(name.scrollWidth <= name.clientWidth)
      return
    }
    // Left out: back once the room left before the actions, their auto margin, holds the
    // badge at its least and its gap.
    const style = getComputedStyle(head)
    const gap = parseFloat(style.columnGap) || 0
    const least = parseFloat(style.getPropertyValue('--badge-least')) || 0
    setBadgeRoom(parseFloat(getComputedStyle(actions).marginLeft) >= least + gap)
  }, [])
  // After every render, as the name, the branch or a count may have changed; and as the
  // sidebar is dragged.
  useLayoutEffect(fitBadge)
  useLayoutEffect(() => {
    const head = headRef.current
    if (!head) return
    const observer = new ResizeObserver(fitBadge)
    observer.observe(head)
    return () => observer.disconnect()
  }, [fitBadge])

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
      ref={headRef}
      className="repo-head"
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
        title={project.path}
      >
        <ChevronIcon open={open} />
        <span className="repo-name">{project.name}</span>
      </button>

      {project.scratch && (
        <Tooltip text="A scratch pad: kept in the app’s own data folder, with no git">
          <span className="scratch-tag">scratch pad</span>
        </Tooltip>
      )}

      {project.global && badgeRoom && (
        <Tooltip
          text={`Uses ${project.global.name} (${project.global.uses}) for shared variables and environments`}
        >
          <span className="uses-badge">uses {project.global.name}</span>
        </Tooltip>
      )}
      {project.problems.length > 0 && (
        <span
          className="problem"
          role="img"
          aria-label="Project problems"
          title={project.problems.map((problem) => problem.message).join('\n')}
        >
          !
        </span>
      )}
      {project.findings.length > 0 && (
        <Tooltip text={`${findingsLabel(project.findings.length)}: open the project’s rules`}>
          <button
            type="button"
            className="rule-count"
            onClick={props.onRules}
            aria-label={`${findingsLabel(project.findings.length)}: open the project’s rules`}
          >
            △ {project.findings.length}
          </button>
        </Tooltip>
      )}

      {project.loading ? (
        // Where the branch will show once git answers: on Windows, a while.
        <Tooltip text="Loading: reading its files and asking git">
          <span className="loading-spinner" role="img" aria-label={`Loading ${project.name}`} />
        </Tooltip>
      ) : git && inRepo ? (
        git.projectChanges > 0 && (
          <span className="repo-git">
            <Tooltip text={`${git.projectChanges} changed here: review and commit`}>
              <button
                type="button"
                className="dirty"
                onClick={() => props.onChanges('changes')}
                aria-label={`Review changes in ${project.name}`}
              >
                ●
              </button>
            </Tooltip>
          </span>
        )
      ) : git ? (
        <GitState
          git={git}
          changedTip={`${git.projectChanges} changed here, ${repoChanges(git)} in the repository: review and commit`}
          onChanges={() => props.onChanges('changes')}
        />
      ) : (
        !inRepo &&
        gitNote && (
          <span className="repo-git muted" title={gitNote}>
            no git
          </span>
        )
      )}

      <span className="repo-actions">
        {git && !inRepo && (
          <SyncButtons
            git={git}
            busy={busy}
            onFetch={props.onFetch}
            onPull={props.onPull}
            onPush={props.onPush}
          />
        )}
        {folders && (
          <Tooltip
            text={
              folders.filtering
                ? 'Folders stay open while filtering'
                : folders.closed
                  ? 'Expand all folders'
                  : 'Collapse all folders'
            }
          >
            <button
              type="button"
              className="collapse-folders-button"
              aria-label={`${folders.closed ? 'Expand' : 'Collapse'} all folders in ${project.name}`}
              onClick={folders.onToggle}
              disabled={folders.filtering}
            >
              <CollapseIcon size={13} expand={folders.closed} />
            </button>
          </Tooltip>
        )}
        <span className="project-menu-wrap">
          <button
            type="button"
            aria-label={`Project actions for ${project.name}`}
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
              {/* What to make, then git, then the project itself. */}
              {item('new', 'New collection', props.onNewCollection)}
              {item('new-folder', 'New folder', props.onNewDirectory)}
              {item('new', 'New reusable requests file', props.onNewSet)}
              {item('new', 'New endpoints file', props.onNewEndpoints)}
              {/* Not where the project's rules say it has none (layout.bases). */}
              {!project.rules.rules.layout.bases &&
                item('new', 'New base collection', props.onNewBase)}
              <div className="menu-divider" role="separator" />
              {/* Under its repository's heading, git is in that heading's menu. */}
              {git && !inRepo && (
                <>
                  {item('commit', 'Changes and commit', () => props.onChanges('changes'))}
                  {item('history', 'History', () => props.onChanges('history'))}
                  <div className="menu-divider" role="separator" />
                </>
              )}
              {project.scratch && item('rename', 'Rename', props.onRename)}
              {item('settings', 'Project settings', props.onSettings)}
              {editor &&
                project.projectSource !== null &&
                item('open', `${editor.label}: project.yml`, () =>
                  editor.open({ path: joinPath(project.path, 'project.yml') })
                )}
              {item('folder', 'Show in folder', props.onReveal)}
            </div>
          )}
        </span>
        <Tooltip
          text={
            project.scratch
              ? 'Delete this scratch pad. Its folder goes to the Trash.'
              : 'Remove from the workspace. The files are left alone.'
          }
        >
          <button
            type="button"
            onClick={props.onRemove}
            aria-label={`${project.scratch ? 'Delete' : 'Remove'} ${project.name}`}
          >
            ×
          </button>
        </Tooltip>
      </span>
    </div>
  )
}
