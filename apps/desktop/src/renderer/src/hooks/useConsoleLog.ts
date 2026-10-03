import { useCallback, useEffect, useReducer } from 'react'
import { consoleReducer, EMPTY_CONSOLE, type ConsoleState } from '../consoleLog.js'

/**
 * The console's entries for this session: every run main tells of, from the
 * moment the window opens — whether or not the panel is — until Clear.
 */
export function useConsoleLog(): ConsoleState & { clear: () => void } {
  const [state, dispatch] = useReducer(consoleReducer, EMPTY_CONSOLE)

  useEffect(() => window.desktop.onConsole((event) => dispatch({ type: 'event', event })), [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  return { ...state, clear }
}
