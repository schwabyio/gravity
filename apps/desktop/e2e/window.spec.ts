import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { sizeWindow } from './window'
import { addProject } from './addProject'

/**
 * The window and its page: the whole window on its screen, and the page no
 * bigger than the window, so nothing — a drawer included — runs off an edge.
 */

const MAIN = path.resolve(process.cwd(), 'out/main/index.js')

let tmp: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gta-window-')))
  const shop = path.join(tmp, 'shop')
  fs.mkdirSync(path.join(shop, 'collections'), { recursive: true })
  fs.writeFileSync(
    path.join(shop, 'collections', 'wide.yml'),
    'id: wide\nsteps:\n  - GET: http://127.0.0.1:9/x\n'
  )
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: shop, stdio: 'pipe' })
  app = await electron.launch({ args: [MAIN, `--user-data-dir=${path.join(tmp, 'ud')}`] })
  page = await app.firstWindow()
  await page.waitForSelector('.sidebar')
  await addProject(app, page, shop)
  await page.locator('.collection-row', { hasText: 'Wide' }).click()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Where the window is, the screen area it may use, and the page it shows. */
async function layout() {
  const window = await app.evaluate(({ BrowserWindow, screen }) => {
    const shown = BrowserWindow.getAllWindows()[0]!
    return {
      bounds: shown.getBounds(),
      content: shown.getContentBounds(),
      workArea: screen.getDisplayMatching(shown.getBounds()).workArea
    }
  })
  const viewport = await page.evaluate(() => {
    const shown = globalThis as unknown as { innerWidth: number; innerHeight: number }
    return { width: shown.innerWidth, height: shown.innerHeight }
  })
  return { ...window, viewport }
}

const onScreen = ({ bounds, workArea }: Awaited<ReturnType<typeof layout>>) =>
  bounds.x >= workArea.x &&
  bounds.y >= workArea.y &&
  bounds.x + bounds.width <= workArea.x + workArea.width &&
  bounds.y + bounds.height <= workArea.y + workArea.height

test('the window opens on its screen, its page exactly filling it', async () => {
  const shown = await layout()
  expect(onScreen(shown)).toBe(true)
  expect(shown.viewport).toEqual({ width: shown.content.width, height: shown.content.height })
})

test('a spec’s size is the window’s, on its screen, and a drawer stays inside it', async () => {
  const given = await sizeWindow(app, page, { width: 1500, height: 900 })
  const shown = await layout()
  // A screen too small to show even SMALLEST_WINDOW lays the page out regardless.
  test.skip(!given, `the screen's work area is ${shown.workArea.width}×${shown.workArea.height}`)
  expect(onScreen(shown)).toBe(true)
  // As asked, or as much of it as the screen has room for.
  const room = { width: shown.workArea.width - (shown.bounds.width - shown.content.width) }
  expect(given!.width).toBe(Math.min(1500, room.width))
  expect(given!.height).toBeLessThanOrEqual(900)
  expect(shown.viewport).toEqual(given)
  expect(shown.content).toMatchObject(given!)

  await page.getByRole('button', { name: 'Collection settings' }).click()
  const drawer = page.getByRole('dialog', { name: 'Collection settings' })
  await expect(drawer).toBeVisible()
  const box = (await drawer.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(shown.viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(shown.viewport.height)
  await drawer.getByRole('button', { name: 'Close' }).click()
})

test('a size bigger than the screen gets all the room it has, still on it', async () => {
  const given = await sizeWindow(app, page, { width: 10_000, height: 10_000 })
  const shown = await layout()
  test.skip(!given, `the screen's work area is ${shown.workArea.width}×${shown.workArea.height}`)
  expect(onScreen(shown)).toBe(true)
  // All of it — but for a pixel each way where the work area is the whole
  // screen, on X11, which keeps the window from being taken for full screen.
  expect(shown.workArea.width - shown.bounds.width).toBeLessThanOrEqual(1)
  expect(shown.workArea.height - shown.bounds.height).toBeLessThanOrEqual(1)
  expect(shown.viewport).toEqual(given)
})
