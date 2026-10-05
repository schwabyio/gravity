import { useState } from 'react'
import type { ProjectView } from '@shared/ipc.js'
import { pullState, pushState } from '../gitActions.js'
import { findingsLabel } from '../ruleFindings.js'
import Tooltip from './Tooltip.js'
import { onRightClick, useMenuDismiss } from '../hooks/useMenuDismiss.js'
import { joinPath, useExternalEditor } from '../externalEditor.js'

interface Props {
  project: ProjectView
  open: boolean
  onToggle: () => void
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
 * commits are made. Creating things and the project's settings are in its ⋯ menu.
 * A scratch pad says so beside its name.
 */
export default function ProjectHeading(props: Props) {
  const { project, open } = props
  const { git, gitNote, busy } = project
  const ahead = git?.ahead ?? 0
  const behind = git?.behind ?? 0
  const pull = git ? pullState(git, busy) : null
  const push = git ? pushState(git, busy, null) : null
  const [menu, setMenu] = useState(false)
  const editor = useExternalEditor()

  // A click anywhere else, or another menu opening, closes the menu.
  const menus = useMenuDismiss(menu, () => setMenu(false))

  const item = (label: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenu(false)
        action()
      }}
    >
      {label}
    </button>
  )

  return (
    <div
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
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="repo-name">{project.name}</span>
      </button>

      {project.scratch && (
        <Tooltip text="A scratch pad: kept in the app’s own data folder, with no git">
          <span className="scratch-tag">scratch pad</span>
        </Tooltip>
      )}

      {project.global && (
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

      {git ? (
        <span className="repo-git">
          <Tooltip
            text={`${git.upstream ? `Tracks ${git.upstream}` : 'No upstream'}: open Changes and branches`}
          >
            <button
              type="button"
              className="repo-branch"
              onClick={() => props.onChanges('changes')}
              aria-label={`Branch ${git.detached ? 'detached' : (git.branch ?? 'none')}: open Changes`}
            >
              {git.detached ? 'detached' : (git.branch ?? '—')}
            </button>
          </Tooltip>
          {!git.clean && (
            <Tooltip
              text={`${git.projectChanges} changed here, ${git.changed + git.untracked + git.conflicted} in the repository: review and commit`}
            >
              <button
                type="button"
                className="dirty"
                onClick={() => props.onChanges('changes')}
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
      ) : (
        gitNote && (
          <span className="repo-git muted" title={gitNote}>
            no git
          </span>
        )
      )}

      <span className="repo-actions">
        {git && pull && push && (
          <>
            <Tooltip text="Fetch from the remote">
              <button type="button" onClick={props.onFetch} disabled={busy} aria-label="Fetch">
                ↻
              </button>
            </Tooltip>
            <Tooltip text={pull.tooltip}>
              <button
                type="button"
                onClick={props.onPull}
                disabled={!pull.enabled}
                aria-label="Pull"
              >
                ↓
              </button>
            </Tooltip>
            {git.remotes.length > 0 && !git.detached && !git.unborn && (
              <Tooltip text={push.tooltip}>
                <button
                  type="button"
                  onClick={props.onPush}
                  disabled={!push.enabled}
                  aria-label="Push"
                >
                  ↑
                </button>
              </Tooltip>
            )}
          </>
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
              {item('New collection', props.onNewCollection)}
              {item('New folder', props.onNewDirectory)}
              {item('New request set', props.onNewSet)}
              {item('New endpoints file', props.onNewEndpoints)}
              {item('New base collection', props.onNewBase)}
              {git && item('Changes and commit', () => props.onChanges('changes'))}
              {git && item('History', () => props.onChanges('history'))}
              {project.scratch && item('Rename', props.onRename)}
              {item('Project settings', props.onSettings)}
              {editor &&
                project.projectSource !== null &&
                item(`${editor.label}: project.yml`, () =>
                  editor.open({ path: joinPath(project.path, 'project.yml') })
                )}
              {item('Show in folder', props.onReveal)}
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
