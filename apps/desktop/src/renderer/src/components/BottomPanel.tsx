import { useEffect, useMemo, useState } from 'react'
import type { GitSetupView } from '@shared/ipc.js'
import { problemCounts } from '../consoleLog.js'
import { useConsoleLog } from '../hooks/useConsoleLog.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { useStoredFlag } from '../hooks/useStoredFlag.js'
import ConsoleIcon from './ConsoleIcon.js'
import ConsolePanel from './ConsolePanel.js'
import RepoStatus, { type RepoStatusProps } from './RepoStatus.js'
import Tooltip from './Tooltip.js'
import VariablesIcon from './VariablesIcon.js'
import VariablesPanel, { type RuntimeVariablesProps } from './VariablesPanel.js'

declare const __GRAVITY_VERSION__: string | undefined

/** Set from package.json by the build; unit tests, which have no build, see a placeholder. */
const VERSION = typeof __GRAVITY_VERSION__ === 'string' ? __GRAVITY_VERSION__ : '0.0.0-dev'

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/** What the console leaves of the window's height, at the least: the app bar and some steps. */
const ROOM_ABOVE = 220

type Tab = 'console' | 'variables'

/**
 * The status bar along the bottom of the window, and the panel its buttons
 * open above it, across the whole window: the Console, and the Variables the
 * open collection's Sends and runs set, each a tab of it. Beside their buttons,
 * the open collection's repository and branch, a click from its Changes. The app's version
 * sits at its right, so which build is running is never a question — and
 * beside it, when the app is not running its own git, which git it runs
 * instead and why.
 *
 * The console listens from the moment the window opens, so whatever ran while
 * the panel was closed is there when it opens. Its own state, not the app's:
 * a result landing re-renders this, not the editor.
 */
export default function BottomPanel(props: {
  /** Something the person asked for went wrong, said here until dismissed. */
  message?: string | null
  onDismissMessage?: () => void
  variables: RuntimeVariablesProps
  repos: RepoStatusProps
}) {
  const log = useConsoleLog()
  const [open, setOpen] = useStoredFlag('console.open')
  const [onVariables, setOnVariables] = useStoredFlag('panel.variables')
  const tab: Tab = onVariables ? 'variables' : 'console'
  /** A status-bar button: opens its tab, or closes the panel when its tab is shown. */
  const toggle = (which: Tab) => {
    if (open && tab === which) return setOpen(false)
    setOnVariables(which === 'variables')
    setOpen(true)
  }
  const set = props.variables.view?.variables.length ?? 0
  // Never so tall that nothing is left above it, however small the window gets.
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const pane = usePaneWidth('pane.console', 260, 120, Math.max(160, windowHeight - ROOM_ABOVE))
  const { errors, warnings } = useMemo(() => problemCounts(log.entries), [log.entries])
  const [git, setGit] = useState<GitSetupView | null>(null)
  useEffect(() => {
    let live = true
    void window.desktop.git.setup().then((setup) => {
      if (live) setGit(setup)
    })
    return () => {
      live = false
    }
  }, [])

  // Cmd/Ctrl+J opens and closes it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'j') return
      event.preventDefault()
      setOpen(!open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  const tabs = (
    <div className="panel-tabs" role="tablist" aria-label="Bottom panel">
      {(['console', 'variables'] as const).map((which) => (
        <button
          key={which}
          type="button"
          role="tab"
          aria-selected={tab === which}
          className={tab === which ? 'active' : ''}
          onClick={() => setOnVariables(which === 'variables')}
        >
          {which === 'console' ? 'Console' : 'Variables'}
        </button>
      ))}
    </div>
  )

  return (
    <>
      {open &&
        (tab === 'console' ? (
          <ConsolePanel log={log} pane={pane} tabs={tabs} onClose={() => setOpen(false)} />
        ) : (
          <VariablesPanel
            {...props.variables}
            pane={pane}
            tabs={tabs}
            onClose={() => setOpen(false)}
          />
        ))}
      <footer className="status-bar">
        <Tooltip text="Console: every request, what scripts write, and errors (⌘J)">
          <button
            type="button"
            className={`status-button${open && tab === 'console' ? ' on' : ''}`}
            aria-expanded={open && tab === 'console'}
            aria-label={[
              'Console',
              errors > 0 ? plural(errors, 'error') : null,
              warnings > 0 ? plural(warnings, 'warning') : null
            ]
              .filter(Boolean)
              .join(', ')}
            onClick={() => toggle('console')}
          >
            <ConsoleIcon />
            {errors > 0 && <span className="status-count error">{errors}</span>}
            {warnings > 0 && <span className="status-count warn">{warnings}</span>}
          </button>
        </Tooltip>
        <Tooltip text="Variables: what this collection's Sends and runs set">
          <button
            type="button"
            className={`status-button${open && tab === 'variables' ? ' on' : ''}`}
            aria-expanded={open && tab === 'variables'}
            aria-label={set > 0 ? `Variables, ${set} set` : 'Variables'}
            onClick={() => toggle('variables')}
          >
            <VariablesIcon />
            {set > 0 && <span className="status-count set">{set}</span>}
          </button>
        </Tooltip>
        <RepoStatus {...props.repos} />
        {props.message && (
          <span className="status-message" role="alert">
            {props.message}
            <button type="button" onClick={props.onDismissMessage} aria-label="Dismiss">
              ×
            </button>
          </span>
        )}
        <span className="status-end">
          {git?.note && (
            <Tooltip wide text={git.note}>
              <span className={`status-git${git.version ? '' : ' none'}`} tabIndex={0}>
                {git.version ? `system git ${git.version}` : 'no git'}
              </span>
            </Tooltip>
          )}
          <span className="status-version">v{VERSION}</span>
        </span>
      </footer>
    </>
  )
}
