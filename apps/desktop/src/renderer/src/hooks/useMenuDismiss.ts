import { useCallback, useEffect, useRef } from 'react'

/** Sent on the window as a ⋯ menu opens, naming the component whose it is. */
const OPENED = 'gravity:menu-opened'

/**
 * Closing a component's ⋯ menu: on a click anywhere else, and as soon as any
 * other menu in the window opens. A menu's own button stops its click from
 * reaching the window — or the menu would close as it opened — so the click
 * that opens another menu never reaches this one: hence the announcement.
 * One menu open at a time.
 *
 * Call `opened()` as a menu of this component opens. Its other menus are its
 * own business: one state, one menu.
 */
export function useMenuDismiss(open: boolean, close: () => void): { opened: () => void } {
  const owner = useRef({})
  const latestClose = useRef(close)
  latestClose.current = close

  useEffect(() => {
    if (!open) return
    const dismiss = () => latestClose.current()
    const onOpened = (event: Event) => {
      if ((event as CustomEvent).detail !== owner.current) dismiss()
    }
    window.addEventListener('click', dismiss)
    window.addEventListener(OPENED, onOpened)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener(OPENED, onOpened)
    }
  }, [open])

  const opened = useCallback(
    () => window.dispatchEvent(new CustomEvent(OPENED, { detail: owner.current })),
    []
  )
  return { opened }
}
