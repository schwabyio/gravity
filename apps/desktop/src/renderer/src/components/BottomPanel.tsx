import { useEffect, useMemo, useState } from 'react'
import { problemCounts } from '../consoleLog.js'
import { useConsoleLog } from '../hooks/useConsoleLog.js'
import { usePaneWidth } from '../hooks/usePaneWidth.js'
import { useStoredFlag } from '../hooks/useStoredFlag.js'
import ConsoleIcon from './ConsoleIcon.js'
import ConsolePanel from './ConsolePanel.js'
import Tooltip from './Tooltip.js'

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/** What the console leaves of the window's height, at the least: the app bar and some steps. */
const ROOM_ABOVE = 220

/**
 * The status bar along the bottom of the window, and the panel its Console
 * button opens above it, across the whole window.
 *
 * The console listens from the moment the window opens, so whatever ran while
 * the panel was closed is there when it opens. Its own state, not the app's:
 * a result landing re-renders this, not the editor.
 */
export default function BottomPanel(props: {
  /** Something the person asked for went wrong, said here until dismissed. */
  message?: string | null
  onDismissMessage?: () => void
}) {
  const log = useConsoleLog()
  const [open, setOpen] = useStoredFlag('console.open')
  // Never so tall that nothing is left above it, however small the window gets.
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const pane = usePaneWidth('pane.console', 260, 120, Math.max(160, windowHeight - ROOM_ABOVE))
  const { errors, warnings } = useMemo(() => problemCounts(log.entries), [log.entries])

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

  return (
    <>
      {open && <ConsolePanel log={log} pane={pane} onClose={() => setOpen(false)} />}
      <footer className="status-bar">
        <Tooltip text="Console: every request, what scripts write, and errors (⌘J)">
          <button
            type="button"
            className={`status-button${open ? ' on' : ''}`}
            aria-expanded={open}
            aria-label={[
              'Console',
              errors > 0 ? plural(errors, 'error') : null,
              warnings > 0 ? plural(warnings, 'warning') : null
            ]
              .filter(Boolean)
              .join(', ')}
            onClick={() => setOpen(!open)}
          >
            <ConsoleIcon />
            {errors > 0 && <span className="status-count error">{errors}</span>}
            {warnings > 0 && <span className="status-count warn">{warnings}</span>}
          </button>
        </Tooltip>
        {props.message && (
          <span className="status-message" role="alert">
            {props.message}
            <button type="button" onClick={props.onDismissMessage} aria-label="Dismiss">
              ×
            </button>
          </span>
        )}
      </footer>
    </>
  )
}
