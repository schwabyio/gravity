import type { ElectronApplication, Page } from '@playwright/test'

/** The page size of a spec with no need of its own: the app's window as it opens on a laptop. */
export const DEFAULT_WINDOW = { width: 1440, height: 900 }

/**
 * The smallest page every spec passes at. A screen that cannot show even this
 * much gets the page laid out at the spec's own size instead (see below).
 */
export const SMALLEST_WINDOW = { width: 1280, height: 720 }

type Size = { width: number; height: number }

/**
 * Make the app's window show a page of `width` × `height`, the whole window on
 * its screen, so everything a test clicks is in view for whoever watches it run.
 *
 * `page.setViewportSize` alone lays the page out at that size inside the
 * window as it is: a page wider or taller than the window runs off its right
 * and bottom edges, drawers included. So the window itself is sized, and
 * centred in its screen's work area — smaller than asked, down to
 * `SMALLEST_WINDOW`, when the screen has less room. Only a screen smaller than
 * that, a CI runner's, gets the page laid out at the asked size regardless;
 * nobody watches those.
 *
 * Returns the page size the window was given, or null for that last case.
 * That is not always the size asked for: X11 makes a window the size of its
 * screen a pixel smaller each way, so no window manager takes it for full
 * screen. So this waits for the page to fill the window as it ended up.
 */
export async function sizeWindow(
  app: ElectronApplication,
  page: Page,
  size: Size
): Promise<Size | null> {
  const sized = await app.evaluate(
    ({ BrowserWindow, screen }, { size, smallest }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) return false
      const outer = window.getBounds()
      const inner = window.getContentBounds()
      // The title bar and borders around the page.
      const frame = { width: outer.width - inner.width, height: outer.height - inner.height }
      const { workArea } = screen.getDisplayMatching(outer)
      const width = Math.min(size.width, workArea.width - frame.width)
      const height = Math.min(size.height, workArea.height - frame.height)
      if (width < smallest.width || height < smallest.height) return false
      window.setContentSize(width, height)
      window.setPosition(
        workArea.x + Math.round((workArea.width - width - frame.width) / 2),
        workArea.y + Math.round((workArea.height - height - frame.height) / 2)
      )
      return true
    },
    { size, smallest: SMALLEST_WINDOW }
  )

  if (!sized) {
    await page.setViewportSize(size)
    return null
  }
  const deadline = Date.now() + 10_000
  for (;;) {
    const given = await app.evaluate(({ BrowserWindow }) => {
      const [width, height] = BrowserWindow.getAllWindows()[0]!.getContentSize()
      return { width: width!, height: height! }
    })
    // Run in the page, where `globalThis` is its window.
    const shown = await page.evaluate(() => {
      const window = globalThis as unknown as { innerWidth: number; innerHeight: number }
      return { width: window.innerWidth, height: window.innerHeight }
    })
    if (shown.width === given.width && shown.height === given.height) return given
    if (Date.now() > deadline) {
      throw new Error(
        `Asked for a page of ${size.width}×${size.height}, the window has room for ` +
          `${given.width}×${given.height} but its page is ${shown.width}×${shown.height}.`
      )
    }
    await page.waitForTimeout(50)
  }
}
