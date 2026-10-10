import { useCallback, useEffect, useReducer } from 'react'
import type { ConsoleEvent, LoadEvent } from '@shared/ipc.js'
import { consoleReducer, EMPTY_CONSOLE, type ConsoleState } from '../consoleLog.js'

/**
 * The console's entries for this session: every run main tells of, from the
 * moment the window opens — whether or not the panel is — until Clear, and the
 * load log from the moment the app started.
 */
export function useConsoleLog(): ConsoleState & { clear: () => void } {
  const [state, dispatch] = useReducer(consoleReducer, EMPTY_CONSOLE)

  useEffect(() => {
    // Held until the history is in, so a line told both ways shows once, in its place.
    let held: ConsoleEvent[] | null = []
    const off = window.desktop.onConsole((event) => {
      if (held) held.push(event)
      else dispatch({ type: 'event', event })
    })
    const release = (history: LoadEvent[]) => {
      const told = new Set(history.map((event) => event.seq))
      for (const event of history) dispatch({ type: 'event', event })
      for (const event of held ?? []) {
        if (event.kind !== 'load' || !told.has(event.seq)) dispatch({ type: 'event', event })
      }
      held = null
    }
    window.desktop.consoleHistory().then(release, () => release([]))
    return off
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  return { ...state, clear }
}
